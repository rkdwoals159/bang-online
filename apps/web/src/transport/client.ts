import { io } from "socket.io-client";
import type {
  CommandAck,
  GuestSessionRequest,
  GuestSessionResponse,
  MatchCommand,
  MatchSnapshotView,
  MatchSyncRequest,
  MatchSyncResponse,
  MatchHistoryResponse,
  PublicMatchEvent,
  RoomCommand,
  RoomPreviewRequest,
  RoomPreviewResponse,
  RoomPreviewSuccess,
  RoomSyncRequest,
  RoomSyncResponse,
  RoomView,
} from "../../../../packages/contracts/src/protocol.js";
import {
  parseLegalActionProposal,
  parseMatchCommand,
  parseMatchOutcomeForStatus,
  parseMatchSyncRequest,
  parseMatchHistoryRequest,
  parseMatchHistoryResponse,
  parsePendingInteractionView,
  parseRoomCommand,
  parseRoomPreviewResponse,
  parseRoomSyncRequest,
  parseRoomSyncResponse,
  parseRoomView,
  parseSyncRejectedResponse,
} from "../../../../packages/contracts/src/validation.js";
import type { RoomEntryCreateResult, RoomEntryPreview } from "../features/room-entry/model.js";
import { BrowserTransportStore } from "./state.js";
import { BrowserTransportError } from "./errors.js";
import type { BrowserTransportState, GameTransport } from "./types.js";
export { BrowserTransportError } from "./errors.js";
export type { TransportErrorCode } from "./errors.js";

type SocketListener = (...args: unknown[]) => void;

/** Structural subset keeps the sync and retry behavior testable without a browser runtime. */
export interface BrowserSocket {
  connected: boolean;
  connect(): unknown;
  disconnect(): unknown;
  on(event: string, listener: SocketListener): unknown;
  off(event: string, listener: SocketListener): unknown;
  emit(event: string, ...args: unknown[]): unknown;
}

export interface BrowserTransportOptions {
  readonly socketFactory?: () => BrowserSocket;
  readonly fetcher?: typeof fetch;
  readonly createId?: () => string;
  readonly acknowledgementTimeoutMs?: number;
}

interface PendingCommand {
  readonly commandId: string;
  readonly event: "room:create" | "room:command" | "match:command";
  readonly payload: RoomCommand | MatchCommand;
  readonly serializedPayload: string;
  readonly roomId?: string;
  readonly matchId?: string;
  active?: ActiveAttempt;
}

interface ActiveAttempt {
  readonly promise: Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NotificationCursor {
  version: number;
  eventSeq?: number;
}

const MATCH_STATUSES = new Set(["playing", "paused", "completed", "recovery_required"]);
const ROLE_IDS = new Set(["sheriff", "deputy", "outlaw", "renegade"]);
const SUITS = new Set(["SPADES", "HEARTS", "DIAMONDS", "CLUBS"]);

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function exactKeys(input: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(input, key)) && Object.keys(input).every((key) => allowed.has(key));
}

function isText(input: unknown): input is string {
  return typeof input === "string" && input.length > 0 && input.length <= 256;
}

function isVersion(input: unknown): input is number {
  return Number.isSafeInteger(input) && (input as number) >= 0;
}

function isCardFace(input: unknown): boolean {
  return isRecord(input) && exactKeys(input, ["cardInstanceId", "typeId", "rank", "suit"]) &&
    isText(input.cardInstanceId) && isText(input.typeId) && typeof input.rank === "string" &&
    SUITS.has(input.suit as string);
}

function isPublicPlayer(input: unknown): boolean {
  if (!isRecord(input) || !exactKeys(input, [
    "playerId", "displayName", "seatIndex", "characterId", "hp", "maxHp", "eliminated", "handCount", "role", "inPlay",
  ])) return false;
  return isText(input.playerId) && isText(input.displayName) && isVersion(input.seatIndex) &&
    isText(input.characterId) && Number.isSafeInteger(input.hp) && Number.isSafeInteger(input.maxHp) &&
    typeof input.eliminated === "boolean" && isVersion(input.handCount) &&
    (input.role === null || ROLE_IDS.has(input.role as string)) &&
    Array.isArray(input.inPlay) && input.inPlay.every(isCardFace);
}

function isMatchSnapshot(input: unknown): input is MatchSnapshotView {
  if (!isRecord(input) || !exactKeys(input,
    ["status", "viewer", "publicTable", "selfPrivate", "pendingInteraction"], ["legalActions", "outcome"],
  )) return false;
  if (!MATCH_STATUSES.has(input.status as string) || !isRecord(input.viewer) ||
      !exactKeys(input.viewer, ["playerId", "seatIndex", "mode"]) || !isText(input.viewer.playerId) ||
      !isVersion(input.viewer.seatIndex) || !["active", "eliminated_observer"].includes(input.viewer.mode as string)) return false;

  const table = input.publicTable;
  if (!isRecord(table) || !exactKeys(table, ["players", "turn", "deckCount", "publicDiscard"]) ||
      !Array.isArray(table.players) || !table.players.every(isPublicPlayer) || !isRecord(table.turn) ||
      !exactKeys(table.turn, ["currentPlayerId", "phase"]) || !isText(table.turn.currentPlayerId) ||
      !isText(table.turn.phase) || !isVersion(table.deckCount) || !isRecord(table.publicDiscard) ||
      !exactKeys(table.publicDiscard, ["topCard", "count"]) ||
      (table.publicDiscard.topCard !== null && !isCardFace(table.publicDiscard.topCard)) ||
      !isVersion(table.publicDiscard.count)) return false;

  if (input.selfPrivate !== null) {
    if (!isRecord(input.selfPrivate) || !exactKeys(input.selfPrivate, ["role", "hand"]) ||
        !ROLE_IDS.has(input.selfPrivate.role as string) || !Array.isArray(input.selfPrivate.hand) ||
        !input.selfPrivate.hand.every(isCardFace)) return false;
  }
  if (input.legalActions !== undefined && (!Array.isArray(input.legalActions) ||
      !input.legalActions.every((action) => parseLegalActionProposal(action).ok))) return false;
  if (input.pendingInteraction !== null &&
      !parsePendingInteractionView(input.pendingInteraction, input.viewer.playerId).ok) return false;
  return parseMatchOutcomeForStatus(input.status as MatchSnapshotView["status"], input.outcome).ok;
}

function isPublicMatchEvent(input: unknown): input is PublicMatchEvent {
  return isRecord(input) && exactKeys(input, ["eventSeq", "type", "occurredAt", "payload"]) &&
    isVersion(input.eventSeq) && input.eventSeq > 0 && isText(input.type) &&
    typeof input.occurredAt === "string" && Number.isFinite(Date.parse(input.occurredAt)) && isRecord(input.payload);
}

function isMatchSyncResponse(input: unknown): input is MatchSyncResponse {
  if (!isRecord(input) || !exactKeys(input, [
    "protocolVersion", "requestId", "matchId", "version", "eventSeq", "requiresFullSnapshot", "snapshot", "visibleEvents",
  ])) return false;
  if (input.protocolVersion !== 1 || !isText(input.requestId) || !isText(input.matchId) ||
      !isVersion(input.version) || !isVersion(input.eventSeq) || typeof input.requiresFullSnapshot !== "boolean" ||
      !isMatchSnapshot(input.snapshot) || !Array.isArray(input.visibleEvents) ||
      !input.visibleEvents.every(isPublicMatchEvent)) return false;
  const events = input.visibleEvents as PublicMatchEvent[];
  return events.every((event, index) => event.eventSeq <= (input.eventSeq as number) &&
    (index === 0 || event.eventSeq > events[index - 1]!.eventSeq));
}

function isCommandRejected(input: unknown, commandId: string): input is Extract<CommandAck, { status: "rejected" }> {
  if (!isRecord(input) || !exactKeys(input, ["protocolVersion", "commandId", "status", "error"]) ||
      input.protocolVersion !== 1 || input.commandId !== commandId || input.status !== "rejected" ||
      !isRecord(input.error) || !exactKeys(input.error,
        ["code", "messageKey", "retryable"], ["currentVersion", "retryAfterMs"],
      ) || !isText(input.error.code) || !isText(input.error.messageKey) ||
      typeof input.error.retryable !== "boolean") return false;
  return (input.error.currentVersion === undefined || isVersion(input.error.currentVersion)) &&
    (input.error.retryAfterMs === undefined || isVersion(input.error.retryAfterMs));
}

function isRoomCreateResult(input: unknown): input is RoomEntryCreateResult {
  return isRecord(input) && exactKeys(input, ["roomId", "version", "inviteCode", "duplicate"]) &&
    isText(input.roomId) && isVersion(input.version) &&
    (input.inviteCode === null || isText(input.inviteCode)) && typeof input.duplicate === "boolean";
}

function isRoomPreviewSuccess(input: RoomPreviewResponse): input is RoomPreviewSuccess {
  return !("status" in input && input.status === "rejected");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function cloneProtocolValue<T>(value: T): T {
  return deepFreeze(JSON.parse(JSON.stringify(value)) as T);
}

function requestError(code: "REQUEST_REJECTED" | "SESSION_EXPIRED", response: unknown): BrowserTransportError {
  if (isRecord(response) && isRecord(response.error) && typeof response.error.code === "string") {
    return new BrowserTransportError(code, response.error.code);
  }
  return new BrowserTransportError(code);
}

function defaultSocketFactory(): BrowserSocket {
  // Same-origin cookie auth is browser managed. Credentials never enter a URL or JS state.
  return io({ path: "/socket.io", withCredentials: true, autoConnect: false }) as unknown as BrowserSocket;
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Cookie-authenticated browser transport. Each Socket.IO `connect` (including
 * reconnect) is a new server authentication handshake and always starts sync.
 */
export class BrowserGameTransport implements GameTransport {
  readonly store = new BrowserTransportStore();
  readonly socket: BrowserSocket;
  private readonly fetcher: typeof fetch;
  private readonly createId: () => string;
  private readonly acknowledgementTimeoutMs: number;
  private readonly roomIds = new Set<string>();
  private readonly matchIds = new Set<string>();
  private readonly roomWatchCounts = new Map<string, number>();
  private readonly matchWatchCounts = new Map<string, number>();
  private readonly recoveredRoomIds = new Set<string>();
  private readonly recoveredMatchIds = new Set<string>();
  private readonly confirmedRoomIds = new Set<string>();
  private readonly confirmedMatchIds = new Set<string>();
  private readonly roomMatchIds = new Map<string, string>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly roomSyncs = new Map<string, Promise<RoomSyncResponse>>();
  private readonly matchSyncs = new Map<string, Promise<MatchSyncResponse>>();
  private readonly roomHints = new Map<string, NotificationCursor>();
  private readonly matchHints = new Map<string, NotificationCursor>();
  private readonly roomFollowupHints = new Map<string, NotificationCursor>();
  private readonly matchFollowupHints = new Map<string, NotificationCursor>();
  private readonly roomMutationGenerations = new Map<string, number>();
  private restoreSessionRequest?: Promise<GuestSessionResponse | null>;
  private assignedSeatsRequest?: Promise<readonly RoomView[]>;
  private sessionExpired = false;
  private restoredPlayerId?: string;
  private connectionGeneration = 0;

  constructor(options: BrowserTransportOptions = {}) {
    this.socket = options.socketFactory?.() ?? defaultSocketFactory();
    // Keep the browser global as the receiver when calling its native fetch.
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.createId = options.createId ?? defaultId;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 5_000;
    this.bindSocketEvents();
  }

  readonly getSnapshot = (): BrowserTransportState => this.store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  connect(): void {
    if (this.socket.connected) return;
    this.sessionExpired = false;
    this.store.setConnection("connecting", null);
    this.socket.connect();
  }

  disconnect(): void {
    this.socket.disconnect();
  }

  watchRoom(roomId: string): () => void {
    this.assertResourceId(roomId);
    this.roomWatchCounts.set(roomId, (this.roomWatchCounts.get(roomId) ?? 0) + 1);
    this.confirmedRoomIds.delete(roomId);
    this.reconcileRoomResource(roomId);
    if (this.socket.connected) void this.syncRoom(roomId).catch(() => undefined);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = (this.roomWatchCounts.get(roomId) ?? 1) - 1;
      if (count > 0) this.roomWatchCounts.set(roomId, count);
      else this.roomWatchCounts.delete(roomId);
      this.reconcileRoomResource(roomId);
    };
  }

  watchMatch(matchId: string): () => void {
    this.assertResourceId(matchId);
    this.matchWatchCounts.set(matchId, (this.matchWatchCounts.get(matchId) ?? 0) + 1);
    this.confirmedMatchIds.delete(matchId);
    this.reconcileMatchResource(matchId);
    if (this.socket.connected) void this.syncMatch(matchId).catch(() => undefined);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const count = (this.matchWatchCounts.get(matchId) ?? 1) - 1;
      if (count > 0) this.matchWatchCounts.set(matchId, count);
      else this.matchWatchCounts.delete(matchId);
      this.reconcileMatchResource(matchId);
    };
  }

  async syncRoom(roomId: string): Promise<RoomSyncResponse> {
    this.assertResourceId(roomId);
    this.retainRoomForSync(roomId);
    const existing = this.roomSyncs.get(roomId);
    if (existing) return existing;
    const mutationGeneration = this.roomMutationGenerations.get(roomId) ?? 0;
    const request = this.performRoomSync(roomId);
    this.roomSyncs.set(roomId, request);
    let response: RoomSyncResponse;
    try {
      response = await request;
    } finally {
      this.roomSyncs.delete(roomId);
    }
    const hint = this.roomHints.get(roomId);
    const currentVersion = this.store.getSnapshot().rooms[roomId]?.version ?? -1;
    const previousFollowup = this.roomFollowupHints.get(roomId);
    const needsHintFollowup = hint !== undefined && hint.version > currentVersion &&
      (previousFollowup === undefined || hint.version > previousFollowup.version);
    if ((this.roomMutationGenerations.get(roomId) ?? 0) > mutationGeneration || needsHintFollowup) {
      if (needsHintFollowup) this.roomFollowupHints.set(roomId, hint);
      void this.syncRoom(roomId).catch(() => undefined);
    }
    return response;
  }

  async syncMatch(matchId: string): Promise<MatchSyncResponse> {
    this.assertResourceId(matchId);
    this.retainMatchForSync(matchId);
    const existing = this.matchSyncs.get(matchId);
    if (existing) return existing;
    const request = this.performMatchSync(matchId);
    this.matchSyncs.set(matchId, request);
    let response: MatchSyncResponse;
    try {
      response = await request;
    } finally {
      this.matchSyncs.delete(matchId);
    }
    const hint = this.matchHints.get(matchId);
    const current = this.store.getSnapshot().matches[matchId];
    const previousFollowup = this.matchFollowupHints.get(matchId);
    const hintIsNewerThanCursor = (candidate: NotificationCursor, reference?: NotificationCursor) =>
      reference === undefined || candidate.version > reference.version ||
      (candidate.version === reference.version && (candidate.eventSeq ?? -1) > (reference.eventSeq ?? -1));
    if (hint && (hint.version > (current?.version ?? -1) ||
        (hint.version === current?.version && (hint.eventSeq ?? 0) > (current?.eventSeq ?? -1))) &&
        hintIsNewerThanCursor(hint, previousFollowup)) {
      this.matchFollowupHints.set(matchId, hint);
      void this.syncMatch(matchId).catch(() => undefined);
    }
    return response;
  }

  async getMatchHistory(matchId: string, beforeEventSeq = (this.getSnapshot().matches[matchId]?.eventSeq ?? 0) + 1): Promise<MatchHistoryResponse> {
    const request = { protocolVersion: 1, requestId: this.createId(), matchId, beforeEventSeq };
    if (!parseMatchHistoryRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    const playerId = this.restoredPlayerId;
    const raw = await this.emitAck("match:history", request);
    if (parseSyncRejectedResponse(raw).ok) throw new BrowserTransportError("REQUEST_REJECTED");
    const parsed = parseMatchHistoryResponse(raw);
    if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.matchId !== matchId ||
        parsed.value.beforeEventSeq !== beforeEventSeq || playerId !== this.restoredPlayerId) throw new BrowserTransportError("INVALID_RESPONSE");
    this.store.appendMatchHistory(matchId, parsed.value.events, parsed.value);
    return parsed.value;
  }

  async createGuestSession(input: GuestSessionRequest): Promise<GuestSessionResponse> {
    if (!isRecord(input) || !exactKeys(input, ["protocolVersion", "displayName"]) ||
        input.protocolVersion !== 1 || typeof input.displayName !== "string") {
      throw new BrowserTransportError("INVALID_RESPONSE", "Invalid guest session request.");
    }
    let response: Response;
    try {
      response = await this.fetcher("/api/guest-sessions", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
    } catch {
      throw new BrowserTransportError("HTTP_REQUEST_FAILED");
    }
    if (!response.ok) throw new BrowserTransportError("HTTP_REQUEST_FAILED");
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (!isGuestSessionResponse(body)) throw new BrowserTransportError("INVALID_RESPONSE");
    this.store.setViewerPlayerId(body.player.playerId);
    this.restoredPlayerId = body.player.playerId;
    return body;
  }

  /** Restore the guest identity using the HttpOnly cookie; credentials never enter JS state. */
  restoreGuestSession(): Promise<GuestSessionResponse | null> {
    if (this.restoreSessionRequest) return this.restoreSessionRequest;
    let request: Promise<GuestSessionResponse | null>;
    request = this.performRestoreGuestSession().finally(() => {
      if (this.restoreSessionRequest === request) this.restoreSessionRequest = undefined;
    });
    this.restoreSessionRequest = request;
    return request;
  }

  private async performRestoreGuestSession(): Promise<GuestSessionResponse | null> {
    let response: Response;
    try {
      response = await this.fetcher("/api/guest-sessions", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
    } catch {
      throw new BrowserTransportError("HTTP_REQUEST_FAILED");
    }

    if (response.status === 204) {
      this.restoredPlayerId = undefined;
      this.store.setConnection(this.store.getSnapshot().connection, false);
      return null;
    }
    if (response.status !== 200) throw new BrowserTransportError("HTTP_REQUEST_FAILED");

    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (!isGuestSessionResponse(body)) throw new BrowserTransportError("INVALID_RESPONSE");
    this.store.setViewerPlayerId(body.player.playerId);
    this.restoredPlayerId = body.player.playerId;
    this.store.setConnection(this.store.getSnapshot().connection, true);
    return body;
  }

  /**
   * Discover this cookie's assigned rooms after refresh. The returned RoomViews
   * are a navigation hint only; each room is registered for authoritative
   * room:sync (and then match:sync) on the current or next socket connection.
   */
  recoverAssignedSeats(): Promise<readonly RoomView[]> {
    if (this.assignedSeatsRequest) return this.assignedSeatsRequest;
    let request: Promise<readonly RoomView[]>;
    request = this.performRecoverAssignedSeats().finally(() => {
      if (this.assignedSeatsRequest === request) this.assignedSeatsRequest = undefined;
    });
    this.assignedSeatsRequest = request;
    return request;
  }

  private async performRecoverAssignedSeats(): Promise<readonly RoomView[]> {
    let response: Response;
    try {
      response = await this.fetcher("/api/guest-sessions/rooms", {
        method: "GET",
        credentials: "include",
        cache: "no-store",
      });
    } catch {
      throw new BrowserTransportError("HTTP_REQUEST_FAILED");
    }

    if (response.status === 401) {
      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      if (!isRecord(body) || !exactKeys(body, ["error"]) || !isRecord(body.error) ||
          !exactKeys(body.error, ["code"]) || body.error.code !== "SESSION_EXPIRED") {
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      this.markSessionExpired();
      throw new BrowserTransportError("SESSION_EXPIRED");
    }
    if (response.status !== 200) throw new BrowserTransportError("HTTP_REQUEST_FAILED");

    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (!Array.isArray(body)) throw new BrowserTransportError("INVALID_RESPONSE");
    const rooms: RoomView[] = [];
    for (const value of body) {
      const parsed = parseRoomView(value);
      if (!parsed.ok || (this.restoredPlayerId !== undefined && parsed.value.viewer.playerId !== this.restoredPlayerId)) {
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      rooms.push(parsed.value);
    }

    const priorRoomIds = [...this.roomIds];
    const priorMatchIds = [...this.matchIds];
    this.recoveredRoomIds.clear();
    this.recoveredMatchIds.clear();
    this.confirmedRoomIds.clear();
    this.confirmedMatchIds.clear();
    this.roomMatchIds.clear();
    for (const room of rooms) {
      this.recoveredRoomIds.add(room.roomId);
      if (room.activeMatchId) {
        this.recoveredMatchIds.add(room.activeMatchId);
        this.roomMatchIds.set(room.roomId, room.activeMatchId);
      }
    }
    for (const roomId of new Set([...priorRoomIds, ...rooms.map((room) => room.roomId)])) {
      this.reconcileRoomResource(roomId);
    }
    for (const matchId of new Set([...priorMatchIds, ...rooms.flatMap((room) => room.activeMatchId ? [room.activeMatchId] : [])])) {
      this.reconcileMatchResource(matchId);
    }

    if (this.socket.connected && rooms.length > 0) {
      await Promise.all(rooms.map((room) => this.syncRoom(room.roomId)));
      const activeMatchIds = rooms
        .map((room) => this.store.getSnapshot().rooms[room.roomId]?.room.activeMatchId ?? null)
        .filter((matchId): matchId is string => matchId !== null);
      await Promise.all([...new Set(activeMatchIds)].map((matchId) => this.syncMatch(matchId)));
      return rooms.map((room) => this.store.getSnapshot().rooms[room.roomId]?.room ?? room);
    }
    return rooms;
  }

  async createRoom(command: Extract<RoomCommand, { type: "CREATE_ROOM" }>): Promise<RoomEntryCreateResult> {
    const response = await this.sendRoomCommand(command);
    if (isCommandRejected(response, command.commandId)) throw requestError("REQUEST_REJECTED", response);
    if (!isRoomCreateResult(response)) throw new BrowserTransportError("INVALID_RESPONSE");
    this.confirmedRoomIds.add(response.roomId);
    this.reconcileRoomResource(response.roomId);
    void this.syncRoom(response.roomId).catch(() => undefined);
    return response;
  }

  async previewInvite(inviteCode: string): Promise<RoomEntryPreview | null> {
    if (!isText(inviteCode)) return null;
    const request: RoomPreviewRequest = { protocolVersion: 1, requestId: this.createId(), inviteCode };
    if (!parseRoomPreviewRequestLocally(request)) throw new BrowserTransportError("INVALID_RESPONSE");
    const response = await this.emitAck("room:preview", request);
    const parsed = parseRoomPreviewResponse(response);
    if (!parsed.ok || parsed.value.requestId !== request.requestId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (!isRoomPreviewSuccess(parsed.value)) return null;
    return {
      roomId: parsed.value.roomId,
      version: parsed.value.version,
      occupancy: parsed.value.occupancy,
      status: parsed.value.status,
    };
  }

  async joinRoom(command: Extract<RoomCommand, { type: "JOIN" }>): Promise<RoomView> {
    const response = await this.sendRoomCommand(command);
    if (isCommandRejected(response, command.commandId)) throw requestError("REQUEST_REJECTED", response);
    const parsed = parseRoomView(response);
    if (!parsed.ok || parsed.value.roomId !== command.roomId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.roomIds.add(command.roomId);
    void this.syncRoom(command.roomId).catch(() => undefined);
    return parsed.value;
  }

  async sendRoomCommand(command: Exclude<RoomCommand, { type: "CREATE_ROOM" }> | Extract<RoomCommand, { type: "CREATE_ROOM" }>): Promise<unknown> {
    const event = command.type === "CREATE_ROOM" ? "room:create" : "room:command";
    const parsed = parseRoomCommand(command);
    if (!parsed.ok) throw new BrowserTransportError("INVALID_RESPONSE", "Invalid room command.");
    const resourceId = command.type === "CREATE_ROOM" ? undefined : command.roomId;
    return this.sendCommand(event, parsed.value, { roomId: resourceId });
  }

  async sendMatchCommand(command: MatchCommand): Promise<CommandAck> {
    const parsed = parseMatchCommand(command);
    if (!parsed.ok) throw new BrowserTransportError("INVALID_RESPONSE", "Invalid match command.");
    const response = await this.sendCommand("match:command", parsed.value, { matchId: parsed.value.matchId });
    if (!isCommandAck(response, parsed.value.commandId)) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    return response;
  }

  retryPendingCommand(commandId: string): Promise<unknown> {
    const pending = this.pending.get(commandId);
    if (!pending) throw new BrowserTransportError("INVALID_RESPONSE", "Unknown pending command.");
    return this.attemptPending(pending);
  }

  private bindSocketEvents(): void {
    this.socket.on("connect", () => {
      this.sessionExpired = false;
      this.store.setConnection("connected", true);
      const generation = ++this.connectionGeneration;
      void this.syncAfterConnect(generation);
    });
    this.socket.on("connect_error", (error) => {
      const unauthenticated = isRecord(error) && error.message === "UNAUTHENTICATED";
      this.sessionExpired = unauthenticated;
      this.connectionGeneration += 1;
      this.store.setConnection(unauthenticated ? "expired" : "disconnected", unauthenticated ? false : null);
      this.store.setError(unauthenticated ? "SESSION_EXPIRED" : "CONNECTION");
      this.abortActiveAttempts(new BrowserTransportError(unauthenticated ? "SESSION_EXPIRED" : "NOT_CONNECTED"));
    });
    this.socket.on("disconnect", () => {
      this.connectionGeneration += 1;
      if (!this.sessionExpired) this.store.setConnection("disconnected", null);
      this.abortActiveAttempts(new BrowserTransportError("NOT_CONNECTED"));
    });
    this.socket.on("room:changed", (payload) => this.handleRoomChanged(payload));
    this.socket.on("match:changed", (payload) => this.handleMatchChanged(payload));
    this.socket.on("session:expired", (payload) => {
      if (!isRecord(payload) || payload.protocolVersion !== 1) return;
      this.markSessionExpired();
    });
  }

  private async syncAfterConnect(generation: number): Promise<void> {
    // An in-flight request may belong to the connection that just dropped.
    // Issue fresh ACK requests directly so reconnect always has a post-connect
    // sync boundary before any uncertain command is retried.
    const pendingCommands = [...this.pending.values()];
    const roomTargets = new Set(this.roomIds);
    const matchTargets = new Set(this.matchIds);
    for (const entry of pendingCommands) {
      if (entry.roomId) roomTargets.add(entry.roomId);
      if (entry.matchId) matchTargets.add(entry.matchId);
    }

    const roomSyncSucceeded = new Set<string>();
    const activeMatchIds = new Set<string>();
    await Promise.all([...roomTargets].map(async (roomId) => {
      try {
        const response = await this.performRoomSync(roomId, false);
        roomSyncSucceeded.add(roomId);
        if (response.room.activeMatchId) activeMatchIds.add(response.room.activeMatchId);
      } catch {
        // Leave the resource unsynchronized so its pending commands stay queued.
      }
    }));

    for (const matchId of activeMatchIds) {
      this.matchIds.add(matchId);
      matchTargets.add(matchId);
    }
    const matchSyncSucceeded = new Set<string>();
    await Promise.all([...matchTargets].map(async (matchId) => {
      try {
        await this.performMatchSync(matchId);
        matchSyncSucceeded.add(matchId);
      } catch {
        // Leave the resource unsynchronized so its pending commands stay queued.
      }
    }));

    if (!this.socket.connected || generation !== this.connectionGeneration) return;

    for (const entry of pendingCommands) {
      if (entry.roomId && !roomSyncSucceeded.has(entry.roomId)) continue;
      if (entry.matchId && !matchSyncSucceeded.has(entry.matchId)) continue;
      void this.attemptPending(entry).catch(() => undefined);
    }
  }

  private handleRoomChanged(payload: unknown): void {
    if (!isRecord(payload) || !exactKeys(payload, ["roomId", "version"]) ||
        !isText(payload.roomId) || !isVersion(payload.version) || !this.roomIds.has(payload.roomId)) return;
    const roomId = payload.roomId;
    const currentVersion = this.store.getSnapshot().rooms[roomId]?.version ?? -1;
    const latestHint = this.roomHints.get(roomId);
    if (payload.version <= currentVersion || (latestHint && payload.version <= latestHint.version)) return;
    this.roomHints.set(roomId, { version: payload.version });
    if (!this.roomSyncs.has(roomId)) void this.syncRoom(roomId).catch(() => undefined);
  }

  private handleMatchChanged(payload: unknown): void {
    if (!isRecord(payload) || !exactKeys(payload, ["matchId", "version", "eventSeq"]) ||
        !isText(payload.matchId) || !isVersion(payload.version) || !isVersion(payload.eventSeq) ||
        !this.matchIds.has(payload.matchId)) return;
    const matchId = payload.matchId;
    const current = this.store.getSnapshot().matches[matchId];
    const currentVersion = current?.version ?? -1;
    const currentEventSeq = current?.eventSeq ?? -1;
    const hint = this.matchHints.get(matchId);
    const isNotNewer = payload.version < currentVersion ||
      (payload.version === currentVersion && payload.eventSeq <= currentEventSeq) ||
      (hint !== undefined && (payload.version < hint.version ||
        (payload.version === hint.version && payload.eventSeq <= (hint.eventSeq ?? -1))));
    if (isNotNewer) return;
    this.matchHints.set(matchId, { version: payload.version, eventSeq: payload.eventSeq });
    if (!this.matchSyncs.has(matchId)) void this.syncMatch(matchId).catch(() => undefined);
  }

  private recordMatchHint(matchId: string, hint: NotificationCursor): void {
    const previous = this.matchHints.get(matchId);
    if (!previous || hint.version > previous.version ||
        (hint.version === previous.version && (hint.eventSeq ?? -1) > (previous.eventSeq ?? -1))) {
      this.matchHints.set(matchId, hint);
    }
  }

  private retainRoomForSync(roomId: string): void {
    if (!this.roomWatchCounts.has(roomId) && !this.recoveredRoomIds.has(roomId)) {
      this.confirmedRoomIds.add(roomId);
    }
    this.reconcileRoomResource(roomId);
  }

  private retainMatchForSync(matchId: string): void {
    if (!this.matchWatchCounts.has(matchId) && !this.recoveredMatchIds.has(matchId) &&
        ![...this.roomMatchIds].some(([roomId, id]) => id === matchId && this.roomIds.has(roomId))) {
      this.confirmedMatchIds.add(matchId);
    }
    this.reconcileMatchResource(matchId);
  }

  private reconcileRoomResource(roomId: string): void {
    const retained = this.roomWatchCounts.has(roomId) || this.recoveredRoomIds.has(roomId) ||
      this.confirmedRoomIds.has(roomId);
    if (retained) this.roomIds.add(roomId);
    else {
      this.roomIds.delete(roomId);
      this.roomHints.delete(roomId);
      this.roomFollowupHints.delete(roomId);
      this.roomMutationGenerations.delete(roomId);
      const matchId = this.roomMatchIds.get(roomId);
      this.roomMatchIds.delete(roomId);
      if (matchId) this.reconcileMatchResource(matchId);
    }
  }

  private reconcileMatchResource(matchId: string): void {
    const referencedByRoom = [...this.roomMatchIds].some(([roomId, roomMatchId]) =>
      roomMatchId === matchId && this.roomIds.has(roomId));
    const retained = this.matchWatchCounts.has(matchId) || this.recoveredMatchIds.has(matchId) ||
      this.confirmedMatchIds.has(matchId) || referencedByRoom;
    if (retained) this.matchIds.add(matchId);
    else {
      this.matchIds.delete(matchId);
      this.matchHints.delete(matchId);
      this.matchFollowupHints.delete(matchId);
    }
  }

  private trackRoomMatch(roomId: string, matchId: string | null): void {
    const previous = this.roomMatchIds.get(roomId);
    if (!this.roomIds.has(roomId)) {
      if (previous) {
        this.roomMatchIds.delete(roomId);
        this.reconcileMatchResource(previous);
      }
      return;
    }
    if (previous === (matchId ?? undefined)) return;
    if (previous) this.roomMatchIds.delete(roomId);
    if (matchId) this.roomMatchIds.set(roomId, matchId);
    if (previous) this.reconcileMatchResource(previous);
    if (matchId) this.reconcileMatchResource(matchId);
  }

  private async performRoomSync(roomId: string, syncActiveMatch = true): Promise<RoomSyncResponse> {
    const current = this.store.getSnapshot().rooms[roomId];
    const request: RoomSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      roomId,
      knownVersion: current?.version ?? 0,
    };
    if (!parseRoomSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    try {
      const raw = await this.emitAck("room:sync", request);
      const rejected = parseSyncRejectedResponse(raw);
      if (rejected.ok) {
        if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
        this.store.setError("SYNC_REJECTED");
        throw requestError("REQUEST_REJECTED", rejected.value);
      }
      const parsed = parseRoomSyncResponse(raw);
      if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.roomId !== roomId ||
          !this.store.isCurrentViewer(parsed.value.room.viewer.playerId)) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      this.store.applyRoomSync(parsed.value);
      this.trackRoomMatch(roomId, parsed.value.room.activeMatchId);
      if (parsed.value.room.activeMatchId && syncActiveMatch && this.socket.connected) {
        void this.syncMatch(parsed.value.room.activeMatchId).catch(() => undefined);
      }
      return parsed.value;
    } catch (error) {
      if (error instanceof BrowserTransportError && error.code === "REQUEST_REJECTED") throw error;
      if (error instanceof BrowserTransportError && error.code === "INVALID_RESPONSE") throw error;
      this.store.setError("CONNECTION");
      throw error;
    }
  }

  private async performMatchSync(matchId: string): Promise<MatchSyncResponse> {
    const current = this.store.getSnapshot().matches[matchId];
    const request: MatchSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      matchId,
      knownVersion: current?.version ?? 0,
      afterEventSeq: current?.eventSeq ?? 0,
    };
    if (!parseMatchSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    try {
      const raw = await this.emitAck("match:sync", request);
      const rejected = parseSyncRejectedResponse(raw);
      if (rejected.ok) {
        if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
        this.store.setError("SYNC_REJECTED");
        throw requestError("REQUEST_REJECTED", rejected.value);
      }
      if (!isMatchSyncResponse(raw) || raw.requestId !== request.requestId || raw.matchId !== matchId ||
          !this.store.isCurrentViewer(raw.snapshot.viewer.playerId)) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      this.store.applyMatchSync(raw);
      return raw;
    } catch (error) {
      if (error instanceof BrowserTransportError &&
          (error.code === "REQUEST_REJECTED" || error.code === "INVALID_RESPONSE")) throw error;
      this.store.setError("CONNECTION");
      throw error;
    }
  }

  private sendCommand(
    event: PendingCommand["event"],
    rawCommand: RoomCommand | MatchCommand,
    scope: { roomId?: string; matchId?: string },
  ): Promise<unknown> {
    const command = cloneProtocolValue(rawCommand);
    const commandId = command.commandId;
    const serializedPayload = JSON.stringify(command);
    const existing = this.pending.get(commandId);
    if (existing && (existing.event !== event || existing.serializedPayload !== serializedPayload)) {
      return Promise.reject(new BrowserTransportError("COMMAND_ID_REUSED"));
    }
    const pending = existing ?? {
      commandId,
      event,
      payload: command,
      serializedPayload,
      ...scope,
    };
    if (!existing) {
      if (scope.roomId) this.retainRoomForSync(scope.roomId);
      if (scope.matchId) this.retainMatchForSync(scope.matchId);
      this.pending.set(commandId, pending);
      this.updatePendingIds();
    }
    return this.attemptPending(pending);
  }

  private attemptPending(pending: PendingCommand): Promise<unknown> {
    if (pending.active) return pending.active.promise;
    if (!this.socket.connected) return Promise.reject(new BrowserTransportError("NOT_CONNECTED"));

    let resolveAttempt!: (value: unknown) => void;
    let rejectAttempt!: (reason: unknown) => void;
    const promise = new Promise<unknown>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    const attempt: ActiveAttempt = {
      promise,
      resolve: resolveAttempt,
      reject: rejectAttempt,
      timer: setTimeout(() => {
        if (pending.active !== attempt) return;
        pending.active = undefined;
        attempt.reject(new BrowserTransportError("ACK_TIMEOUT"));
      }, this.acknowledgementTimeoutMs),
    };
    pending.active = attempt;
    this.socket.emit(pending.event, pending.payload, (response: unknown) => {
      if (pending.active !== attempt) return;
      if (!this.isValidCommandReply(pending, response)) {
        clearTimeout(attempt.timer);
        pending.active = undefined;
        this.store.setError("INVALID_RESPONSE");
        attempt.reject(new BrowserTransportError("INVALID_RESPONSE"));
        return;
      }
      clearTimeout(attempt.timer);
      pending.active = undefined;
      this.pending.delete(pending.commandId);
      this.updatePendingIds();
      const ack = isCommandAck(response, pending.commandId) ? response : null;
      const accepted = ack === null || ack.status === "accepted";
      if (accepted && pending.roomId) {
        const room = parseRoomView(response);
        let roomProjectionApplied = false;
        if (room.ok && room.value.roomId === pending.roomId && room.value.version !== undefined) {
          const previous = this.store.getSnapshot().rooms[pending.roomId];
          this.store.applyRoomCommand(room.value);
          const latestRoom = this.store.getSnapshot().rooms[pending.roomId]?.room ?? room.value;
          this.trackRoomMatch(pending.roomId, latestRoom.activeMatchId);
          if (latestRoom.activeMatchId) {
            if (latestRoom.activeMatchId !== previous?.room.activeMatchId ||
                !this.store.getSnapshot().matches[latestRoom.activeMatchId]) {
              void this.syncMatch(latestRoom.activeMatchId).catch(() => undefined);
            }
          }
          roomProjectionApplied = true;
        } else {
          this.roomMutationGenerations.set(pending.roomId, (this.roomMutationGenerations.get(pending.roomId) ?? 0) + 1);
        }
        if (!roomProjectionApplied) void this.syncRoom(pending.roomId).catch(() => undefined);
      }
      if (accepted && pending.matchId) {
        if (ack?.status === "accepted") {
          this.recordMatchHint(pending.matchId, { version: ack.aggregateVersion, eventSeq: ack.eventSeq });
        }
        void this.syncMatch(pending.matchId).catch(() => undefined);
      }
      attempt.resolve(response);
    });
    return promise;
  }

  private isValidCommandReply(pending: PendingCommand, response: unknown): boolean {
    if (pending.event === "room:create") {
      return isRoomCreateResult(response) || isCommandRejected(response, pending.commandId);
    }
    if (pending.event === "room:command") {
      return parseRoomView(response).ok || isCommandRejected(response, pending.commandId);
    }
    return isCommandAck(response, pending.commandId);
  }

  private abortActiveAttempts(error: BrowserTransportError): void {
    for (const pending of this.pending.values()) {
      const active = pending.active;
      if (!active) continue;
      clearTimeout(active.timer);
      pending.active = undefined;
      active.reject(error);
    }
  }

  private async emitAck(event: string, payload: unknown): Promise<unknown> {
    if (!this.socket.connected) throw new BrowserTransportError("NOT_CONNECTED");
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new BrowserTransportError("ACK_TIMEOUT"));
      }, this.acknowledgementTimeoutMs);
      this.socket.emit(event, payload, (response: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      });
    });
  }

  private assertResourceId(value: string): void {
    if (!isText(value)) throw new BrowserTransportError("INVALID_RESPONSE", "Invalid resource ID.");
  }

  private updatePendingIds(): void {
    this.store.setPendingCommandIds([...this.pending.keys()]);
  }

  private markSessionExpired(): void {
    this.sessionExpired = true;
    this.store.setConnection("expired", false);
    this.store.setError("SESSION_EXPIRED");
    this.abortActiveAttempts(new BrowserTransportError("SESSION_EXPIRED"));
    this.socket.disconnect();
  }
}

function isGuestSessionResponse(input: unknown): input is GuestSessionResponse {
  return isRecord(input) && exactKeys(input, ["protocolVersion", "player", "sessionExpiresAt"]) &&
    input.protocolVersion === 1 && isRecord(input.player) &&
    exactKeys(input.player, ["playerId", "displayName"]) && isText(input.player.playerId) &&
    typeof input.player.displayName === "string" && typeof input.sessionExpiresAt === "string" &&
    Number.isFinite(Date.parse(input.sessionExpiresAt));
}

function isCommandAck(input: unknown, commandId: string): input is CommandAck {
  if (isCommandRejected(input, commandId)) return true;
  return isRecord(input) && exactKeys(input,
    ["protocolVersion", "commandId", "status", "duplicate", "aggregateVersion", "eventSeq"],
  ) && input.protocolVersion === 1 && input.commandId === commandId && input.status === "accepted" &&
    typeof input.duplicate === "boolean" && isVersion(input.aggregateVersion) && isVersion(input.eventSeq);
}

function parseRoomPreviewRequestLocally(input: unknown): input is {
  protocolVersion: 1; requestId: string; inviteCode: string;
} {
  return isRecord(input) && exactKeys(input, ["protocolVersion", "requestId", "inviteCode"]) &&
    input.protocolVersion === 1 && isText(input.requestId) && isText(input.inviteCode);
}

export function createBrowserGameTransport(options: BrowserTransportOptions = {}): BrowserGameTransport {
  return new BrowserGameTransport(options);
}

