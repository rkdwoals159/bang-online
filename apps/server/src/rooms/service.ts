import { createHash, randomBytes } from "node:crypto";
import { createEffectRegistry } from "../../../../packages/engine/src/effects/registry.js";
import type { InteractionIdentity } from "../../../../packages/engine/src/effects/runtime/index.js";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.js";
import type { RandomSource } from "../../../../packages/engine/src/random/shuffle.js";
import { executeTurnDraw, resolveTurnStart, withTurnStartEffects } from "../../../../packages/engine/src/turn/draw.js";
import type {
  CreateRoomPayload,
  GuestSessionResponse,
  RoomView,
} from "../../../../packages/contracts/src/protocol.js";
import { withClient } from "../storage/database-runtime.js";
import type { PgPoolLike } from "../storage/database.js";
import type {
  RoomLifecycleRepository,
  RoomMutationResult,
  RoomPreviewRecord,
  StartRoomWithMatchResult,
} from "../storage/room-lifecycle.js";
import type { StorageRepository } from "../storage/repository.js";

const NO_SESSION_EXPIRY = new Date("9999-12-31T23:59:59.999Z");
// This server currently accepts the single ruleset exposed by the protocol DTO.
const BASE_DECK_RULESET_VERSION = "base4-ko-online-1.0";
const DISPLAY_NAME_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_DISPLAY_NAME_CODE_POINTS = 20;

interface GuestProfileRow {
  player_id: string;
  display_name: string;
}

export interface RoomServiceOptions {
  /** Omitted means guest credentials do not expire automatically. */
  guestSessionTtlMs?: number;
  /** Omitted means closed room records are retained indefinitely. */
  roomRetentionMs?: number;
  now?: () => Date;
  /** Engine randomness is injected for deterministic tests; production defaults to cryptographic entropy. */
  random?: RandomSource;
}

export interface RoomServiceDependencies {
  storage: StorageRepository;
  lifecycle: RoomLifecycleRepository;
  pool: PgPoolLike;
  options?: RoomServiceOptions;
}

/** The credential is an internal cookie value; only `response` belongs in JSON. */
export interface GuestSessionIssue {
  response: GuestSessionResponse;
  credential: string;
}

export interface AuthenticatedGuest {
  playerId: string;
  displayName: string;
  expiresAt: Date;
}

export interface RoomMutationServiceResult {
  mutation: RoomMutationResult;
  /** Null when the authenticated actor no longer holds a seat in this room. */
  room: RoomView | null;
  /** Eligibility time for a separately configured retention worker; no deletion runs here. */
  cleanupEligibleAt: string | null;
}

export interface StartMatchServiceResult {
  mutation: StartRoomWithMatchResult;
  matchId: string;
  room: RoomView | null;
}

export type CreatePrivateRoomInput = Pick<CreateRoomPayload, "capacity" | "rulesetVersion"> & {
  commandId: string;
};

export interface JoinPrivateRoomInput {
  roomId: string;
  inviteCode: string;
  expectedVersion: number;
  commandId: string;
}

export interface RoomCommandInput {
  roomId: string;
  expectedVersion: number;
  commandId: string;
}

export class RoomServiceError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RoomServiceError";
    this.code = code;
  }
}

export class RoomAuthorizationError extends RoomServiceError {
  constructor() {
    super("ROOM_FORBIDDEN", "The authenticated player cannot perform this room action.");
    this.name = "RoomAuthorizationError";
  }
}

export class UnsupportedRoomRulesetError extends RoomServiceError {
  constructor(rulesetVersion: string) {
    super("UNSUPPORTED_RULESET", `Room ruleset '${rulesetVersion}' is not supported.`);
    this.name = "UnsupportedRoomRulesetError";
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function opaqueSecret(): string {
  return randomBytes(32).toString("base64url");
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomBytes(18).toString("base64url")}`;
}

function cryptographicRandomSource(): RandomSource {
  return {
    nextFloat: () => {
      let value = 0;
      for (const byte of Buffer.from(randomBytes(6).toString("base64url"), "base64url")) {
        value = value * 256 + byte;
      }
      return value / 0x1_0000_0000_0000;
    },
  };
}

function requestHash(operation: string, values: readonly (string | number | boolean)[]): string {
  return sha256(JSON.stringify([operation, ...values]));
}

function ensureText(value: string, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} is required.`);
  }
  return value;
}

function ensureVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Expected room version must be a non-negative safe integer.");
  }
}

function validateOptionalDuration(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new RangeError(`${label} must be a positive safe integer when configured.`);
  }
}

function cloneDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("The configured clock must return a valid Date.");
  }
  return new Date(value.getTime());
}

export class RoomService {
  private readonly storage: StorageRepository;
  private readonly lifecycle: RoomLifecycleRepository;
  private readonly pool: PgPoolLike;
  private readonly options: RoomServiceOptions;
  private readonly random: RandomSource;

  constructor(dependencies: RoomServiceDependencies) {
    this.storage = dependencies.storage;
    this.lifecycle = dependencies.lifecycle;
    this.pool = dependencies.pool;
    this.options = dependencies.options ?? {};
    this.random = this.options.random ?? cryptographicRandomSource();
    validateOptionalDuration(this.options.guestSessionTtlMs, "Guest session TTL");
    validateOptionalDuration(this.options.roomRetentionMs, "Room retention");
  }

  async createGuestSession(displayNameInput: string): Promise<GuestSessionIssue> {
    if (typeof displayNameInput !== "string") throw new TypeError("Display name is required.");
    const displayName = displayNameInput.trim();
    if (displayName.length === 0) {
      throw new RangeError("Display name is required.");
    }
    if (DISPLAY_NAME_CONTROL_CHARACTERS.test(displayName)) {
      throw new RangeError("Display name must not contain control characters.");
    }
    if (Array.from(displayName).length > MAX_DISPLAY_NAME_CODE_POINTS) {
      throw new RangeError("Display name must contain no more than 20 Unicode code points.");
    }

    const credential = opaqueSecret();
    const playerId = opaqueId("p");
    const now = cloneDate(this.now());
    const expiresAt = new Date(
      now.getTime() + (this.options.guestSessionTtlMs ?? NO_SESSION_EXPIRY.getTime() - now.getTime()),
    );
    await this.storage.createGuestSession({
      id: playerId,
      tokenHash: sha256(credential),
      displayName,
      expiresAt,
    });

    return {
      response: {
        protocolVersion: 1,
        player: { playerId, displayName },
        sessionExpiresAt: expiresAt.toISOString(),
      },
      credential,
    };
  }

  /** Resolve the bearer credential to its server-owned player identity. */
  async authenticateGuestCredential(
    credential: string,
    at: Date = this.now(),
  ): Promise<AuthenticatedGuest | null> {
    if (typeof credential !== "string" || credential.length === 0) return null;
    const session = await this.lifecycle.findActiveGuestSessionByTokenHash(sha256(credential), cloneDate(at));
    return session ? { ...session, expiresAt: new Date(session.expiresAt.getTime()) } : null;
  }

  /** Returns a safe preview after hashing the raw invite code. */
  async previewInvite(inviteCode: string): Promise<RoomPreviewRecord | null> {
    if (typeof inviteCode !== "string" || inviteCode.length === 0) return null;
    return this.lifecycle.previewRoomByInviteHash(sha256(inviteCode));
  }

  /**
   * Reconnect by credential identity, then recover only that identity's seats.
   * Display names are read for rendering and are never used as lookup keys.
   */
  async recoverAssignedSeats(credential: string): Promise<RoomView[] | null> {
    const guest = await this.authenticateGuestCredential(credential);
    if (!guest) return null;
    const result = await withClient(this.pool, (client) =>
      client.query<{ room_id: string }>(
        "SELECT room_id FROM room_players WHERE player_id = $1 ORDER BY room_id",
        [guest.playerId],
      ),
    );
    const views: RoomView[] = [];
    for (const { room_id: roomId } of result.rows) {
      const view = await this.roomViewForMember(roomId, guest.playerId);
      if (view) views.push(view);
    }
    return views;
  }

  async createPrivateRoom(
    authenticatedPlayerId: string,
    input: CreatePrivateRoomInput,
  ): Promise<{ room: RoomView | null; inviteCode: string | null; duplicate: boolean; version: number }> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.commandId, "Command ID");
    if (input.capacity !== 4 && input.capacity !== 5 && input.capacity !== 6 && input.capacity !== 7) {
      throw new RangeError("Private room capacity must be 4, 5, 6, or 7.");
    }
    if (input.rulesetVersion !== BASE_DECK_RULESET_VERSION) {
      throw new UnsupportedRoomRulesetError(input.rulesetVersion);
    }

    const inviteCode = opaqueSecret();
    const result = await this.lifecycle.createRoom({
      id: opaqueId("r"),
      ownerPlayerId: authenticatedPlayerId,
      inviteCodeHash: sha256(inviteCode),
      capacity: input.capacity,
      actorPlayerId: authenticatedPlayerId,
      commandId: input.commandId,
      requestHash: requestHash("CREATE_ROOM", [authenticatedPlayerId, input.capacity, input.rulesetVersion]),
      outboxEventId: opaqueId("evt"),
    });
    const room = await this.roomViewForMember(result.outcome.roomId, authenticatedPlayerId);
    if (!room && result.status === "applied") {
      throw new RoomServiceError("ROOM_MEMBERSHIP_REQUIRED", "Room membership is required.");
    }
    return {
      room,
      inviteCode: result.status === "applied" ? inviteCode : null,
      duplicate: result.status === "duplicate",
      version: result.outcome.version,
    };
  }

  async joinPrivateRoom(
    authenticatedPlayerId: string,
    input: JoinPrivateRoomInput,
  ): Promise<RoomMutationServiceResult> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.roomId, "Room ID");
    ensureText(input.commandId, "Command ID");
    ensureText(input.inviteCode, "Invite code");
    ensureVersion(input.expectedVersion);
    const inviteCodeHash = sha256(input.inviteCode);
    const mutation = await this.lifecycle.joinRoom({
      roomId: input.roomId,
      actorPlayerId: authenticatedPlayerId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      requestHash: requestHash("JOIN", [
        authenticatedPlayerId,
        input.roomId,
        input.expectedVersion,
        inviteCodeHash,
      ]),
      outboxEventId: opaqueId("evt"),
      inviteCodeHash,
    });
    const room = await this.roomViewForMember(input.roomId, authenticatedPlayerId);
    const cleanupEligibleAt = await this.cleanupDeadlineForRoom(input.roomId, mutation.outcome.roomStatus);
    return {
      mutation,
      room,
      cleanupEligibleAt,
    };
  }

  async setReady(
    authenticatedPlayerId: string,
    input: RoomCommandInput & { ready: boolean },
  ): Promise<RoomMutationServiceResult> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.roomId, "Room ID");
    ensureText(input.commandId, "Command ID");
    ensureVersion(input.expectedVersion);
    const mutation = await this.lifecycle.setReady({
      roomId: input.roomId,
      actorPlayerId: authenticatedPlayerId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      requestHash: requestHash("SET_READY", [
        authenticatedPlayerId,
        input.roomId,
        input.expectedVersion,
        input.ready,
      ]),
      outboxEventId: opaqueId("evt"),
      ready: input.ready,
    });
    const room = await this.roomViewForMember(input.roomId, authenticatedPlayerId);
    const cleanupEligibleAt = await this.cleanupDeadlineForRoom(input.roomId, mutation.outcome.roomStatus);
    return {
      mutation,
      room,
      cleanupEligibleAt,
    };
  }

  /**
   * Initializes one match and delegates owner, roster, readiness, version,
   * completed-match, and idempotency checks to the locked lifecycle transaction.
   */
  async startMatch(
    authenticatedPlayerId: string,
    input: RoomCommandInput,
  ): Promise<StartMatchServiceResult> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.roomId, "Room ID");
    ensureText(input.commandId, "Command ID");
    ensureVersion(input.expectedVersion);

    const stored = await this.storage.getRoom(input.roomId);
    if (!stored) throw new RoomServiceError("ROOM_NOT_FOUND", "Room does not exist.");
    if (!stored.players.some(({ playerId }) => playerId === authenticatedPlayerId) ||
        stored.ownerPlayerId !== authenticatedPlayerId) {
      throw new RoomAuthorizationError();
    }
    // T09 only initializes supported 4–7 player matches; T73 rechecks the locked roster.
    if (stored.players.length < 4 || stored.players.length > 7) {
      throw new RoomServiceError("ROOM_NOT_READY", "A match requires four through seven room members.");
    }
    const roomView = await this.roomViewForMember(input.roomId, authenticatedPlayerId);
    if (!roomView) throw new RoomAuthorizationError();

    const matchId = opaqueId("m");
    const initial = initializeGame({
      players: roomView.members.map(({ playerId, displayName }) => ({ playerId, displayName })),
      random: this.random,
    });
    const nextInteractionIdentity = (): InteractionIdentity => ({
      interactionId: opaqueId("i"),
      createdAt: cloneDate(this.now()).toISOString(),
    });
    const runtimeOptions = withTurnStartEffects({
      registry: createEffectRegistry(),
      nextInteractionIdentity,
    });
    const sheriffPlayerId = initial.turn.currentPlayerId;
    const turnStart = resolveTurnStart({
      state: initial,
      actorPlayerId: sheriffPlayerId,
      random: this.random,
      nextInteractionIdentity,
      continuationFrameId: `${matchId}:initial-start`,
      runtimeOptions,
    });
    if (!turnStart.ok || turnStart.output.state.turn.phase !== "draw") {
      throw new RoomServiceError(
        "MATCH_INITIALIZATION_FAILED",
        turnStart.ok ? "The first turn did not enter its draw phase." : turnStart.error.message,
      );
    }
    const initialDraw = executeTurnDraw({
      state: turnStart.output.state,
      actorPlayerId: sheriffPlayerId,
      random: this.random,
      nextInteractionIdentity,
      continuationFrameId: `${matchId}:initial-draw`,
    });
    if (!initialDraw.ok) {
      throw new RoomServiceError("MATCH_INITIALIZATION_FAILED", initialDraw.error.message);
    }

    const mutation = await this.lifecycle.startRoomWithMatch({
      roomId: input.roomId,
      actorPlayerId: authenticatedPlayerId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      requestHash: requestHash("START_MATCH", [authenticatedPlayerId, input.roomId, input.expectedVersion]),
      outboxEventId: opaqueId("evt_room"),
      matchId,
      matchOutboxEventId: opaqueId("evt_match"),
      state: initialDraw.output.state,
      startedAt: cloneDate(this.now()),
    });
    const room = await this.roomViewForMember(input.roomId, authenticatedPlayerId);
    if (!room && mutation.status === "applied") {
      throw new RoomServiceError("ROOM_MEMBERSHIP_REQUIRED", "Room membership is required.");
    }
    return { mutation, matchId: mutation.outcome.matchId, room };
  }

  /** Returns the current completed match's room to the lobby and resets readiness. */
  async returnToLobby(
    authenticatedPlayerId: string,
    input: RoomCommandInput,
  ): Promise<RoomMutationServiceResult> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.roomId, "Room ID");
    ensureText(input.commandId, "Command ID");
    ensureVersion(input.expectedVersion);
    const mutation = await this.lifecycle.returnToLobby({
      roomId: input.roomId,
      actorPlayerId: authenticatedPlayerId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      requestHash: requestHash("RETURN_TO_LOBBY", [authenticatedPlayerId, input.roomId, input.expectedVersion]),
      outboxEventId: opaqueId("evt"),
    });
    const room = await this.roomViewForMember(input.roomId, authenticatedPlayerId);
    const cleanupEligibleAt = await this.cleanupDeadlineForRoom(input.roomId, mutation.outcome.roomStatus);
    return {
      mutation,
      room,
      cleanupEligibleAt,
    };
  }

  async leaveRoom(
    authenticatedPlayerId: string,
    input: RoomCommandInput,
  ): Promise<RoomMutationServiceResult> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.roomId, "Room ID");
    ensureText(input.commandId, "Command ID");
    ensureVersion(input.expectedVersion);
    const mutation = await this.lifecycle.leaveRoom({
      roomId: input.roomId,
      actorPlayerId: authenticatedPlayerId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      requestHash: requestHash("LEAVE", [authenticatedPlayerId, input.roomId, input.expectedVersion]),
      outboxEventId: opaqueId("evt"),
    });
    const room = await this.roomViewForMember(input.roomId, authenticatedPlayerId);
    const cleanupEligibleAt = await this.cleanupDeadlineForRoom(input.roomId, mutation.outcome.roomStatus);
    return {
      mutation,
      room,
      cleanupEligibleAt,
    };
  }

  /** Voluntary lobby close is owner-only; seat removal and transfer remain in T64. */
  async closeRoom(
    authenticatedPlayerId: string,
    input: RoomCommandInput,
  ): Promise<RoomMutationServiceResult> {
    ensureText(authenticatedPlayerId, "Authenticated player ID");
    ensureText(input.roomId, "Room ID");
    ensureText(input.commandId, "Command ID");
    ensureVersion(input.expectedVersion);
    const room = await this.storage.getRoom(input.roomId);
    if (!room) throw new RoomServiceError("ROOM_NOT_FOUND", "Room does not exist.");
    if (room.ownerPlayerId !== authenticatedPlayerId || !room.players.some(({ playerId }) => playerId === authenticatedPlayerId)) {
      throw new RoomAuthorizationError();
    }
    if (room.status !== "waiting" && room.status !== "closed") {
      throw new RoomServiceError("ROOM_LOCKED", "Only a waiting room can be closed.");
    }
    const mutation = await this.lifecycle.setRoomStatus({
      roomId: input.roomId,
      actorPlayerId: authenticatedPlayerId,
      expectedVersion: input.expectedVersion,
      commandId: input.commandId,
      requestHash: requestHash("CLOSE_ROOM", [authenticatedPlayerId, input.roomId, input.expectedVersion]),
      outboxEventId: opaqueId("evt"),
      status: "closed",
    });
    const cleanupEligibleAt = await this.cleanupDeadlineForRoom(input.roomId, mutation.outcome.roomStatus);
    return {
      mutation,
      room: await this.roomViewForMember(input.roomId, authenticatedPlayerId),
      cleanupEligibleAt,
    };
  }

  async roomViewForMember(roomId: string, authenticatedPlayerId: string): Promise<RoomView | null> {
    const stored = await this.storage.getRoom(roomId);
    if (!stored || !stored.players.some(({ playerId }) => playerId === authenticatedPlayerId)) return null;
    const profiles = await withClient(this.pool, (client) =>
      client.query<GuestProfileRow>(
        `SELECT rp.player_id, gs.display_name
         FROM room_players rp
         JOIN guest_sessions gs ON gs.id = rp.player_id
         WHERE rp.room_id = $1
         ORDER BY rp.seat_index`,
        [roomId],
      ),
    );
    const displayNames = new Map(profiles.rows.map(({ player_id, display_name }) => [player_id, display_name]));
    const members = stored.players.map(({ playerId, seatIndex, ready }) => {
      const displayName = displayNames.get(playerId);
      if (displayName === undefined) throw new RoomServiceError("ROOM_PROFILE_MISSING", "Room member profile is missing.");
      return { playerId, displayName, seatIndex, ready };
    });
    const hasStartedMatch = stored.status === "in_game" || stored.status === "paused" || stored.status === "completed";
    const activeMatchId = hasStartedMatch ? await this.storage.getLatestMatchIdForRoom(roomId) : null;
    if (hasStartedMatch && activeMatchId === null) {
      throw new RoomServiceError("ROOM_MATCH_MISSING", "A started room has no stored match route.");
    }
    return {
      roomId: stored.id,
      status: stored.status,
      activeMatchId,
      ownerPlayerId: stored.ownerPlayerId,
      capacity: stored.capacity,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
      members,
      viewer: { playerId: authenticatedPlayerId, isOwner: stored.ownerPlayerId === authenticatedPlayerId },
    };
  }

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private async cleanupDeadlineForRoom(roomId: string, status: string): Promise<string | null> {
    if (status !== "closed" || this.options.roomRetentionMs === undefined) return null;
    const stored = await this.storage.getRoom(roomId);
    if (!stored) return null;
    return new Date(stored.updatedAt.getTime() + this.options.roomRetentionMs).toISOString();
  }
}
