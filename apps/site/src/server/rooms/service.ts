import type { RoomCommand, RoomConnectionState, RoomPreviewResponse, RoomView } from "../../../../../packages/contracts/src/protocol.js";
import { createEffectRegistry } from "../../../../../packages/engine/src/effects/registry.js";
import type { InteractionIdentity } from "../../../../../packages/engine/src/effects/runtime/index.js";
import { initializeGame } from "../../../../../packages/engine/src/setup/initialize.js";
import { executeTurnDraw, resolveTurnStart, withTurnStartEffects } from "../../../../../packages/engine/src/turn/draw.js";
import {
  CommandIdReusedError,
  D1InviteRateLimiter,
  D1StorageInvariantError,
  D1StorageRepository,
  RoomNotFoundError,
  RoomVersionConflictError,
  type D1DatabaseLike,
  type RoomCommandInput as D1RoomCommandInput,
  type RoomMutationOutcome,
  type RoomRecord,
  type RoomStatus,
} from "../../storage/index.js";
import { opaqueId, opaqueSecret, sha256Hex, webCryptoRandomSource } from "../auth/crypto.js";

const BASE_DECK_RULESET_VERSION = "base4-ko-online-1.0";
const ROOM_PRESENCE_LEASE_MS = 45_000;

function connectionState(lastPresenceAt: Date | null, observedAt: Date): RoomConnectionState {
  if (lastPresenceAt === null) return "unknown";
  return observedAt.getTime() - lastPresenceAt.getTime() <= ROOM_PRESENCE_LEASE_MS ? "connected" : "disconnected";
}

export interface D1RoomServiceOptions {
  now?: () => Date;
  crypto?: Crypto;
}

export interface RoomActionInput {
  roomId: string;
  expectedVersion: number;
  commandId: string;
}

export interface CreatePrivateRoomInput {
  capacity: 4 | 5 | 6 | 7;
  rulesetVersion: "base4-ko-online-1.0";
  commandId: string;
}

export interface JoinPrivateRoomInput extends RoomActionInput {
  inviteCode: string;
}

export interface CreatePrivateRoomResult {
  roomId: string;
  version: number;
  inviteCode: string | null;
  duplicate: boolean;
  room: RoomView | null;
}

export class SiteRoomServiceError extends Error {
  constructor(readonly code: string, message = code, readonly currentVersion?: number) {
    super(message);
    this.name = "SiteRoomServiceError";
  }
}

export class SiteRoomRateLimitError extends SiteRoomServiceError {
  constructor(readonly retryAfterMs: number) {
    super("RATE_LIMITED");
    this.name = "SiteRoomRateLimitError";
  }
}

interface RoomReceiptOutcome {
  roomId: string;
  version: number;
  roomStatus: RoomStatus;
  ownerPlayerId: string;
  occupancy: number;
  changed: boolean;
  playerId?: string;
  seatIndex?: number;
  ready?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function receiptOutcome(receipt: Awaited<ReturnType<D1StorageRepository["findCommandReceipt"]>>): RoomReceiptOutcome | null {
  if (!receipt || !isRecord(receipt.outcome) || typeof receipt.outcome.roomId !== "string" ||
      typeof receipt.outcome.version !== "number" || typeof receipt.outcome.roomStatus !== "string" ||
      typeof receipt.outcome.ownerPlayerId !== "string" || typeof receipt.outcome.occupancy !== "number" ||
      typeof receipt.outcome.changed !== "boolean") return null;
  return receipt.outcome as unknown as RoomReceiptOutcome;
}

function startReceiptMatchId(receipt: Awaited<ReturnType<D1StorageRepository["findCommandReceipt"]>>): string | null {
  return receipt && isRecord(receipt.outcome) && typeof receipt.outcome.matchId === "string"
    ? receipt.outcome.matchId
    : null;
}

function normalizeRepositoryError(error: unknown): never {
  if (error instanceof RoomVersionConflictError) {
    throw new SiteRoomServiceError("STALE_VERSION", error.message, error.currentVersion);
  }
  if (error instanceof CommandIdReusedError) {
    throw new SiteRoomServiceError("COMMAND_ID_REUSED", error.message);
  }
  if (error instanceof RoomNotFoundError) {
    throw new SiteRoomServiceError("NOT_FOUND_OR_FORBIDDEN", "Room is unavailable.");
  }
  throw error;
}

/** D1 room operations and protocol projections used by the Sites Worker routes. */
export class D1RoomService {
  private readonly repository: D1StorageRepository;
  private readonly limiter: D1InviteRateLimiter;

  constructor(private readonly db: D1DatabaseLike, private readonly options: D1RoomServiceOptions = {}) {
    this.repository = new D1StorageRepository(db);
    this.limiter = new D1InviteRateLimiter(db);
  }

  async recoverAssignedSeats(playerId: string): Promise<RoomView[]> {
    const rooms = await this.repository.listRoomsForPlayer(playerId);
    const views: RoomView[] = [];
    for (const room of rooms) {
      const view = await this.projectRoom(room, playerId);
      if (view) views.push(view);
    }
    return views;
  }

  async roomViewForMember(roomId: string, playerId: string, loadedRoom?: RoomRecord): Promise<RoomView | null> {
    const room = loadedRoom ?? await this.repository.getRoom(roomId);
    if (!room || room.id !== roomId || !room.players.some((member) => member.playerId === playerId)) return null;
    return this.projectRoom(room, playerId);
  }

  async previewInvite(
    playerId: string,
    requestId: string,
    inviteCode: string,
    peerAddress: string,
  ): Promise<RoomPreviewResponse> {
    const reservation = await this.reserveInviteLookup(playerId, peerAddress);
    if (!reservation.allowed) {
      return {
        protocolVersion: 1,
        requestId,
        status: "rejected",
        error: { code: "RATE_LIMITED", retryAfterMs: reservation.retryAfterMs },
      };
    }
    let outcome: "invalid" | "neutral" = "neutral";
    try {
      const preview = await this.repository.getRoomPreviewByInviteHash(await sha256Hex(inviteCode, this.options.crypto));
      if (!preview) {
        outcome = "invalid";
        return { protocolVersion: 1, requestId, status: "rejected", error: { code: "INVITE_INVALID" } };
      }
      return {
        protocolVersion: 1,
        requestId,
        roomId: preview.roomId,
        version: preview.version,
        occupancy: preview.occupancy,
        status: preview.status,
      };
    } finally {
      await reservation.complete(outcome, this.now().getTime());
    }
  }

  async createPrivateRoom(playerId: string, input: CreatePrivateRoomInput): Promise<CreatePrivateRoomResult> {
    const requestHash = await this.requestHash("CREATE_ROOM", [playerId, input.capacity, input.rulesetVersion]);
    const prior = await this.repository.findCommandReceipt(playerId, input.commandId);
    if (prior) {
      if (prior.requestHash !== requestHash || prior.matchId !== null || prior.roomId === null) {
        throw new SiteRoomServiceError("COMMAND_ID_REUSED");
      }
      const outcome = receiptOutcome(prior);
      if (!outcome || outcome.roomId !== prior.roomId) throw new D1StorageInvariantError("Stored room-create receipt is malformed.");
      return {
        roomId: outcome.roomId,
        version: outcome.version,
        inviteCode: null,
        duplicate: true,
        room: await this.roomViewForMember(outcome.roomId, playerId),
      };
    }

    const inviteCode = opaqueSecret(this.options.crypto);
    const roomId = opaqueId("r", this.options.crypto);
    try {
      const result = await this.repository.createRoomCommand({
        id: roomId,
        ownerPlayerId: playerId,
        inviteCodeHash: await sha256Hex(inviteCode, this.options.crypto),
        capacity: input.capacity,
        actorPlayerId: playerId,
        commandId: input.commandId,
        requestHash,
        outboxEventId: opaqueId("evt", this.options.crypto),
      });
      const room = await this.roomViewForMember(result.outcome.roomId, playerId);
      return {
        roomId: result.outcome.roomId,
        version: result.outcome.version,
        inviteCode: result.status === "applied" ? inviteCode : null,
        duplicate: result.status === "duplicate",
        room,
      };
    } catch (error) {
      if (error instanceof CommandIdReusedError) {
        const raced = await this.repository.findCommandReceipt(playerId, input.commandId);
        if (raced?.requestHash === requestHash && raced.matchId === null && raced.roomId !== null) {
          const outcome = receiptOutcome(raced);
          if (outcome) return {
            roomId: outcome.roomId,
            version: outcome.version,
            inviteCode: null,
            duplicate: true,
            room: await this.roomViewForMember(outcome.roomId, playerId),
          };
        }
      }
      normalizeRepositoryError(error);
    }
  }

  async joinPrivateRoom(
    playerId: string,
    input: JoinPrivateRoomInput,
    peerAddress: string,
  ): Promise<RoomView | null> {
    const reservation = await this.reserveInviteLookup(playerId, peerAddress);
    if (!reservation.allowed) throw new SiteRoomRateLimitError(reservation.retryAfterMs);
    let outcome: "invalid" | "neutral" | "join-success" = "neutral";
    try {
      const requestHash = await this.requestHash("JOIN", [
        playerId,
        input.roomId,
        input.expectedVersion,
        await sha256Hex(input.inviteCode, this.options.crypto),
      ]);
      const prior = await this.getPriorRoomReceipt(playerId, input.commandId, input.roomId, requestHash);
      if (prior) {
        outcome = "join-success";
        return await this.roomViewForMember(input.roomId, playerId);
      }

      const room = await this.repository.getRoom(input.roomId);
      if (!room) {
        outcome = "invalid";
        throw new SiteRoomServiceError("INVITE_INVALID");
      }
      this.assertVersion(room, input.expectedVersion);
      const inviteCodeHash = await sha256Hex(input.inviteCode, this.options.crypto);
      if (room.inviteCodeHash !== inviteCodeHash) {
        outcome = "invalid";
        throw new SiteRoomServiceError("INVITE_INVALID");
      }
      if (room.status === "closed") throw new SiteRoomServiceError("ROOM_CLOSED");
      if (room.status !== "waiting") throw new SiteRoomServiceError("ROOM_LOCKED");
      if (room.players.some((member) => member.playerId === playerId)) throw new SiteRoomServiceError("ALREADY_JOINED");
      if (room.players.length >= room.capacity) throw new SiteRoomServiceError("ROOM_FULL");
      const occupied = new Set(room.players.map((member) => member.seatIndex));
      let seatIndex = 0;
      while (seatIndex < room.capacity && occupied.has(seatIndex)) seatIndex += 1;
      if (seatIndex >= room.capacity) throw new SiteRoomServiceError("ROOM_FULL");

      const result = await this.commitRoomMutation({
        room,
        playerId,
        input,
        requestHash,
        changed: true,
        status: room.status,
        ownerPlayerId: room.ownerPlayerId,
        occupancy: room.players.length + 1,
        playerWrites: [{ operation: "insert", playerId, seatIndex, ready: false }],
        extraOutcome: { playerId, seatIndex, ready: false },
      });
      outcome = "join-success";
      return result;
    } catch (error) {
      normalizeRepositoryError(error);
    } finally {
      await reservation.complete(outcome, this.now().getTime());
    }
  }

  async setReady(playerId: string, input: RoomActionInput & { ready: boolean }): Promise<RoomView | null> {
    const requestHash = await this.requestHash("SET_READY", [playerId, input.roomId, input.expectedVersion, input.ready]);
    const prior = await this.getPriorRoomReceipt(playerId, input.commandId, input.roomId, requestHash);
    if (prior) return this.roomViewForMember(input.roomId, playerId);
    const room = await this.requireMembership(input.roomId, playerId);
    this.assertVersion(room, input.expectedVersion);
    this.assertWaiting(room.status);
    const member = room.players.find((item) => item.playerId === playerId)!;
    return this.commitRoomMutation({
      room,
      playerId,
      input,
      requestHash,
      changed: member.ready !== input.ready,
      status: room.status,
      ownerPlayerId: room.ownerPlayerId,
      occupancy: room.players.length,
      playerWrites: member.ready === input.ready ? [] : [{ operation: "set-ready", playerId, ready: input.ready }],
      extraOutcome: { playerId, seatIndex: member.seatIndex, ready: input.ready },
    });
  }

  async kickMember(playerId: string, input: RoomActionInput & { targetPlayerId: string }): Promise<RoomView | null> {
    const requestHash = await this.requestHash("KICK_MEMBER", [playerId, input.roomId, input.expectedVersion, input.targetPlayerId]);
    if (await this.getPriorRoomReceipt(playerId, input.commandId, input.roomId, requestHash)) {
      return this.roomViewForMember(input.roomId, playerId);
    }
    const room = await this.requireMembership(input.roomId, playerId);
    this.assertVersion(room, input.expectedVersion);
    this.assertWaiting(room.status);
    if (room.ownerPlayerId !== playerId) throw new SiteRoomServiceError("ROOM_FORBIDDEN");
    if (input.targetPlayerId === playerId) throw new SiteRoomServiceError("CANNOT_KICK_SELF");
    if (!room.players.some(member => member.playerId === input.targetPlayerId)) {
      throw new SiteRoomServiceError("MEMBER_NOT_FOUND");
    }
    return this.commitRoomMutation({ room, playerId, input, requestHash, changed: true,
      status: room.status, ownerPlayerId: room.ownerPlayerId, occupancy: room.players.length - 1,
      playerWrites: [{ operation: "delete", playerId: input.targetPlayerId }] });
  }

  async closeRoom(playerId: string, input: RoomActionInput): Promise<RoomView | null> {
    const requestHash = await this.requestHash("CLOSE_ROOM", [playerId, input.roomId, input.expectedVersion]);
    const prior = await this.getPriorRoomReceipt(playerId, input.commandId, input.roomId, requestHash);
    if (prior) return this.roomViewForMember(input.roomId, playerId);
    const room = await this.repository.getRoom(input.roomId);
    if (!room) return null;
    if (!room.players.some((member) => member.playerId === playerId)) return null;
    if (room.ownerPlayerId !== playerId) throw new SiteRoomServiceError("ROOM_FORBIDDEN");
    if (room.status !== "waiting" && room.status !== "closed") throw new SiteRoomServiceError("ROOM_LOCKED");
    this.assertVersion(room, input.expectedVersion);
    return this.commitRoomMutation({
      room,
      playerId,
      input,
      requestHash,
      changed: room.status !== "closed",
      status: "closed",
      ownerPlayerId: room.ownerPlayerId,
      occupancy: room.players.length,
    });
  }

  async returnToLobby(playerId: string, input: RoomActionInput): Promise<RoomView | null> {
    const requestHash = await this.requestHash("RETURN_TO_LOBBY", [playerId, input.roomId, input.expectedVersion]);
    const prior = await this.getPriorRoomReceipt(playerId, input.commandId, input.roomId, requestHash);
    if (prior) return this.roomViewForMember(input.roomId, playerId);
    const room = await this.requireMembership(input.roomId, playerId);
    this.assertVersion(room, input.expectedVersion);
    if (room.status === "closed") throw new SiteRoomServiceError("ROOM_CLOSED");
    if (room.status !== "in_game") throw new SiteRoomServiceError("ROOM_LOCKED");
    const latestMatchId = await this.repository.getLatestMatchIdForRoom(room.id);
    const latestMatch = latestMatchId ? await this.repository.getMatch(latestMatchId) : null;
    if (!latestMatch || latestMatch.status !== "completed") throw new SiteRoomServiceError("ROOM_LOCKED");
    if (room.ownerPlayerId !== playerId) throw new SiteRoomServiceError("NOT_ROOM_OWNER");
    const inputForCommit = input;
    return this.commitRoomMutation({
      room,
      playerId,
      input: inputForCommit,
      requestHash,
      changed: true,
      status: "waiting",
      ownerPlayerId: room.ownerPlayerId,
      occupancy: room.players.length,
      playerWrites: room.players.filter((member) => member.ready).map((member) => ({
        operation: "set-ready" as const,
        playerId: member.playerId,
        ready: false,
      })),
    });
  }

  async startMatch(playerId: string, input: RoomActionInput): Promise<{ room: RoomView | null; matchId: string; duplicate: boolean }> {
    const requestHash = await this.requestHash("START_MATCH", [playerId, input.roomId, input.expectedVersion]);
    const prior = await this.repository.findCommandReceipt(playerId, input.commandId);
    if (prior) {
      if (prior.requestHash !== requestHash || prior.matchId !== null || prior.roomId !== input.roomId) {
        throw new SiteRoomServiceError("COMMAND_ID_REUSED");
      }
      const matchId = startReceiptMatchId(prior);
      if (!matchId) throw new D1StorageInvariantError("Stored start receipt has no match ID.");
      return { room: await this.roomViewForMember(input.roomId, playerId), matchId, duplicate: true };
    }
    const room = await this.repository.getRoom(input.roomId);
    if (!room) throw new SiteRoomServiceError("NOT_FOUND_OR_FORBIDDEN");
    if (!room.players.some((member) => member.playerId === playerId) || room.ownerPlayerId !== playerId) {
      throw new SiteRoomServiceError("ROOM_FORBIDDEN");
    }
    if (room.players.length < 4 || room.players.length > 7) throw new SiteRoomServiceError("ROOM_NOT_READY");
    this.assertVersion(room, input.expectedVersion);
    if (room.status === "closed") throw new SiteRoomServiceError("ROOM_CLOSED");
    if (room.status !== "waiting" && room.status !== "in_game") throw new SiteRoomServiceError("ROOM_LOCKED");
    if (room.players.some((member) => !member.ready)) throw new SiteRoomServiceError("ROOM_NOT_READY");
    if (room.status === "in_game") {
      const latestMatchId = await this.repository.getLatestMatchIdForRoom(room.id);
      const latestMatch = latestMatchId ? await this.repository.getMatch(latestMatchId) : null;
      if (!latestMatch || latestMatch.status !== "completed") throw new SiteRoomServiceError("ROOM_LOCKED");
    }
    const currentView = await this.roomViewForMember(room.id, playerId);
    if (!currentView) throw new SiteRoomServiceError("ROOM_FORBIDDEN");

    const matchId = opaqueId("m", this.options.crypto);
    const random = webCryptoRandomSource(this.options.crypto);
    const initial = initializeGame({
      players: currentView.members.map(({ playerId: memberId, displayName }) => ({ playerId: memberId, displayName })),
      random,
    });
    const nextInteractionIdentity = (): InteractionIdentity => ({
      interactionId: opaqueId("i", this.options.crypto),
      createdAt: this.now().toISOString(),
    });
    const runtimeOptions = withTurnStartEffects({ registry: createEffectRegistry(), nextInteractionIdentity });
    const sheriffPlayerId = initial.turn.currentPlayerId;
    const turnStart = resolveTurnStart({
      state: initial,
      actorPlayerId: sheriffPlayerId,
      random,
      nextInteractionIdentity,
      continuationFrameId: `${matchId}:initial-start`,
      runtimeOptions,
    });
    if (!turnStart.ok || turnStart.output.state.turn.phase !== "draw") {
      throw new SiteRoomServiceError("MATCH_INITIALIZATION_FAILED");
    }
    const initialDraw = executeTurnDraw({
      state: turnStart.output.state,
      actorPlayerId: sheriffPlayerId,
      random,
      nextInteractionIdentity,
      continuationFrameId: `${matchId}:initial-draw`,
    });
    if (!initialDraw.ok) throw new SiteRoomServiceError("MATCH_INITIALIZATION_FAILED");

    try {
      const mutation = await this.repository.startRoomWithMatch({
        roomId: input.roomId,
        actorPlayerId: playerId,
        commandId: input.commandId,
        requestHash,
        expectedVersion: input.expectedVersion,
        markerId: opaqueId("cm", this.options.crypto),
        matchId,
        matchOutboxEventId: opaqueId("evt_match", this.options.crypto),
        roomOutboxEventId: opaqueId("evt_room", this.options.crypto),
        state: { ...initialDraw.output.state, eventSeq: initialDraw.output.events.length },
        events: initialDraw.output.events.map((event, index) => ({
          ...event, eventId: opaqueId("evt", this.options.crypto), eventSeq: index + 1,
          version: initialDraw.output.state.version, createdAt: this.now(),
        })),
        startedAt: this.now(),
      });
      return {
        room: await this.roomViewForMember(input.roomId, playerId),
        matchId: mutation.outcome.matchId,
        duplicate: mutation.status === "duplicate",
      };
    } catch (error) {
      normalizeRepositoryError(error);
    }
  }

  async unsupportedRoomCommand(playerId: string, roomId: string, type: "KICK_MEMBER" | "SET_RULESET"): Promise<string> {
    if (type === "SET_RULESET") return "COMMAND_UNAVAILABLE";
    const room = await this.roomViewForMember(roomId, playerId);
    if (!room) return "NOT_FOUND_OR_FORBIDDEN";
    if (!room.viewer.isOwner) return "ROOM_FORBIDDEN";
    if (room.activeMatchId !== null) return "ROOM_LOCKED";
    return "COMMAND_UNAVAILABLE";
  }

  private async projectRoom(room: RoomRecord, viewerPlayerId: string): Promise<RoomView | null> {
    if (!room.players.some((member) => member.playerId === viewerPlayerId)) return null;
    const observedAt = this.now();
    const members = room.players.map(({ playerId, displayName, seatIndex, ready, lastPresenceAt }) => ({
      playerId,
      displayName,
      seatIndex,
      ready,
      connectionState: connectionState(lastPresenceAt, observedAt),
    }));
    const hasStartedMatch = room.status === "in_game" || room.status === "paused" || room.status === "completed";
    const activeMatchId = hasStartedMatch ? room.latestMatchId : null;
    if (hasStartedMatch && activeMatchId === null) throw new D1StorageInvariantError("Started room has no latest match.");
    return {
      roomId: room.id,
      status: room.status,
      activeMatchId,
      ownerPlayerId: room.ownerPlayerId,
      capacity: room.capacity,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
      version: room.version,
      members,
      viewer: { playerId: viewerPlayerId, isOwner: room.ownerPlayerId === viewerPlayerId },
    };
  }

  private async reserveInviteLookup(playerId: string, peerAddress: string) {
    const bucketHash = await sha256Hex(JSON.stringify([peerAddress, playerId]), this.options.crypto);
    return this.limiter.reserve(bucketHash, opaqueId("ir", this.options.crypto), this.now().getTime());
  }

  private async requestHash(operation: string, values: readonly (string | number | boolean)[]): Promise<string> {
    return sha256Hex(JSON.stringify([operation, ...values]), this.options.crypto);
  }

  private async getPriorRoomReceipt(
    playerId: string,
    commandId: string,
    roomId: string,
    requestHash: string,
  ): Promise<RoomReceiptOutcome | null> {
    const receipt = await this.repository.findCommandReceipt(playerId, commandId);
    if (!receipt) return null;
    if (receipt.requestHash !== requestHash || receipt.matchId !== null || receipt.roomId !== roomId) {
      throw new SiteRoomServiceError("COMMAND_ID_REUSED");
    }
    const outcome = receiptOutcome(receipt);
    if (!outcome || outcome.roomId !== roomId) throw new D1StorageInvariantError("Stored room receipt is malformed.");
    return outcome;
  }

  private async requireMembership(roomId: string, playerId: string): Promise<RoomRecord> {
    const room = await this.repository.getRoom(roomId);
    if (!room || !room.players.some((member) => member.playerId === playerId)) {
      throw new SiteRoomServiceError("NOT_FOUND_OR_FORBIDDEN");
    }
    return room;
  }

  private assertVersion(room: RoomRecord, expectedVersion: number): void {
    if (room.version !== expectedVersion) {
      throw new SiteRoomServiceError("STALE_VERSION", "Stale room version.", room.version);
    }
  }

  private assertWaiting(status: RoomStatus): void {
    if (status === "closed") throw new SiteRoomServiceError("ROOM_CLOSED");
    if (status !== "waiting") throw new SiteRoomServiceError("ROOM_LOCKED");
  }

  private async commitRoomMutation(input: {
    room: RoomRecord;
    playerId: string;
    input: RoomActionInput;
    requestHash: string;
    changed: boolean;
    status: RoomStatus;
    ownerPlayerId: string;
    occupancy: number;
    playerWrites?: D1RoomCommandInput["playerWrites"];
    extraOutcome?: Pick<RoomMutationOutcome, "playerId" | "seatIndex" | "ready">;
  }): Promise<RoomView | null> {
    const outcome: RoomMutationOutcome = {
      roomId: input.room.id,
      version: input.input.expectedVersion + (input.changed ? 1 : 0),
      roomStatus: input.status,
      ownerPlayerId: input.ownerPlayerId,
      occupancy: input.occupancy,
      changed: input.changed,
      ...(input.extraOutcome ?? {}),
    };
    try {
      await this.repository.commitRoomCommand({
        roomId: input.room.id,
        actorPlayerId: input.playerId,
        commandId: input.input.commandId,
        requestHash: input.requestHash,
        expectedVersion: input.input.expectedVersion,
        markerId: opaqueId("cm", this.options.crypto),
        status: input.status,
        ownerPlayerId: input.ownerPlayerId,
        changed: input.changed,
        ...(input.playerWrites === undefined ? {} : { playerWrites: input.playerWrites }),
        receiptOutcome: outcome as unknown as import("../../../../../packages/engine/src/state/types.js").JsonValue,
        ...(input.changed ? { outboxEventId: opaqueId("evt_room", this.options.crypto) } : {}),
      });
      return this.roomViewForMember(input.room.id, input.playerId);
    } catch (error) {
      normalizeRepositoryError(error);
    }
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Room service clock must return a valid Date.");
    return new Date(value.getTime());
  }
}
