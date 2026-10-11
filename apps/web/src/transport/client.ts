import { io } from "socket.io-client";
import type {
  CommandAck,
  GuestSessionRequest,
  GuestSessionResponse,
  MatchCommand,
  MatchSyncRequest,
  MatchSyncResponse,
  MatchHistoryResponse,
  RoomCommand,
  RoomPreviewRequest,
  RoomPreviewResponse,
  RoomPreviewSuccess,
  RoomSyncRequest,
  RoomSyncResponse,
  RoomView,
} from "../../../../packages/contracts/src/protocol.js";
import {
  parseCommandAck,
  parseSyncUnchangedResponse,
  parseMatchCommand,
  parseMatchSyncRequest,
  parseMatchSyncResponse,
  parseMatchHistoryRequest,
  parseMatchHistoryResponse,
  parseRoomCommand,
  parseRoomPreviewResponse,
  parseRoomSyncRequest,
  parseRoomSyncResponse,
  parseRoomView,
  parseRoomPresenceView,
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
  readonly syncRetryIntervalMs?: number;
  readonly commandRetryIntervalMs?: number;
  readonly visibilityTarget?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  readonly onlineTarget?: Pick<Window, "addEventListener" | "removeEventListener">;
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
  private readonly syncRetryIntervalMs: number;
  private readonly commandRetryIntervalMs: number;
  private readonly visibilityTarget?: BrowserTransportOptions["visibilityTarget"];
  private readonly onlineTarget?: BrowserTransportOptions["onlineTarget"];
  private readonly commandAcknowledgements = new Map<string, CommandAck>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelays = new Map<string, number>();
  private readonly unavailableRoomIds = new Set<string>();
  private readonly unavailableMatchIds = new Set<string>();
  private readonly closedRoomIds = new Set<string>();
  private stopped = false;
  private observingVisibility = false;
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
    this.syncRetryIntervalMs = options.syncRetryIntervalMs ?? 750;
    this.commandRetryIntervalMs = options.commandRetryIntervalMs ?? 750;
    this.visibilityTarget = options.visibilityTarget ?? (typeof document === "undefined" ? undefined : document);
    this.onlineTarget = options.onlineTarget ?? (typeof window === "undefined" ? undefined : window);
    this.bindSocketEvents();
  }

  readonly getSnapshot = (): BrowserTransportState => this.store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  connect(): void {
    this.stopped = false;
    if (!this.observingVisibility) {
      this.visibilityTarget?.addEventListener("visibilitychange", this.resumeVisibleResources);
      this.onlineTarget?.addEventListener("online", this.resumeVisibleResources);
      this.observingVisibility = true;
    }
    if (this.socket.connected) return;
    this.sessionExpired = false;
    this.store.setConnection("connecting", null);
    this.socket.connect();
  }

  disconnect(): void {
    this.stopped = true;
    this.clearRetries();
    this.visibilityTarget?.removeEventListener("visibilitychange", this.resumeVisibleResources);
    this.onlineTarget?.removeEventListener("online", this.resumeVisibleResources);
    this.observingVisibility = false;
    this.socket.disconnect();
  }

  getCommandAcknowledgement(commandId: string): CommandAck | undefined {
    const ack = this.commandAcknowledgements.get(commandId);
    return ack ? cloneProtocolValue(ack) : undefined;
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
    if (this.unavailableRoomIds.has(roomId)) throw new BrowserTransportError("REQUEST_REJECTED", "NOT_FOUND_OR_FORBIDDEN");
    this.retainRoomForSync(roomId);
    const existing = this.roomSyncs.get(roomId);
    if (existing) return existing;
    const mutationGeneration = this.roomMutationGenerations.get(roomId) ?? 0;
    const request = this.performRoomSync(roomId);
    this.roomSyncs.set(roomId, request);
    let response: RoomSyncResponse;
    try {
      response = await request;
      this.clearRetry(`room:${roomId}`);
    } catch (error) {
      if (!(error instanceof BrowserTransportError) || error.code !== "REQUEST_REJECTED") this.scheduleSyncRetry("room", roomId);
      throw error;
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
    if (this.unavailableMatchIds.has(matchId)) throw new BrowserTransportError("REQUEST_REJECTED", "NOT_FOUND_OR_FORBIDDEN");
    this.retainMatchForSync(matchId);
    const existing = this.matchSyncs.get(matchId);
    if (existing) return existing;
    const request = this.performMatchSync(matchId);
    this.matchSyncs.set(matchId, request);
    let response: MatchSyncResponse;
    try {
      response = await request;
      this.clearRetry(`match:${matchId}`);
    } catch (error) {
      if (!(error instanceof BrowserTransportError) || error.code !== "REQUEST_REJECTED") this.scheduleSyncRetry("match", matchId);
      throw error;
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
    const rejected = parseSyncRejectedResponse(raw);
    if (rejected.ok) {
      if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
      if (rejected.value.error.code === "NOT_FOUND_OR_FORBIDDEN") this.rejectResource("match", matchId);
      throw requestError("REQUEST_REJECTED", rejected.value);
    }
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
    this.adoptPlayer(body.player.playerId);
    return body;
  }

  async reissueRoomInvite(roomId: string, expectedVersion: number): Promise<RoomEntryCreateResult> {
    this.assertResourceId(roomId);
    const response = await this.fetcher(`/api/rooms/${encodeURIComponent(roomId)}/invite`, {
      method: 'POST', credentials: 'include', cache: 'no-store',
      headers: {'Content-Type':'application/json'}, body: JSON.stringify({protocolVersion:1, expectedVersion}),
    });
    if (response.status === 401) { this.markSessionExpired(); throw new BrowserTransportError('SESSION_EXPIRED'); }
    if (response.status !== 200) { await this.syncRoom(roomId).catch(() => undefined); throw new BrowserTransportError('REQUEST_REJECTED'); }
    const body: unknown = await response.json();
    if (!isRoomCreateResult(body) || body.roomId !== roomId || !body.inviteCode) throw new BrowserTransportError('INVALID_RESPONSE');
    await this.syncRoom(roomId).catch(() => undefined);
    return body;
  }

  async updateGuestName(input: GuestSessionRequest): Promise<GuestSessionResponse> {
    if (!isRecord(input) || !exactKeys(input, ["protocolVersion", "displayName"]) || input.protocolVersion !== 1 || typeof input.displayName !== "string")
      throw new BrowserTransportError("INVALID_RESPONSE");
    const playerId = this.restoredPlayerId;
    const response = await this.fetcher("/api/guest-sessions/profile", { method: "POST", credentials: "include", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    if (response.status === 401) throw new BrowserTransportError("SESSION_EXPIRED");
    if (!response.ok) throw new BrowserTransportError("HTTP_REQUEST_FAILED");
    const body: unknown = await response.json();
    if (!isGuestSessionResponse(body) || body.player.playerId !== playerId || playerId !== this.restoredPlayerId)
      throw new BrowserTransportError("INVALID_RESPONSE");
    void Promise.allSettled([...Object.keys(this.getSnapshot().rooms).map(id => this.syncRoom(id)),
      ...Object.keys(this.getSnapshot().matches).map(id => this.syncMatch(id))]);
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
      this.adoptPlayer(undefined);
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
    this.adoptPlayer(body.player.playerId);
    this.store.setConnection(this.store.getSnapshot().connection, true);
    return body;
  }

  /**
   * Discover this cookie's assigned rooms after refresh. The returned RoomViews
   * are navigation hints. Only the room currently opened by the player is
   * registered for live room:sync and its active match:sync.
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
      if (room.status === "closed") continue;
      this.store.applyRoomCommand(room);
      if (room.activeMatchId && this.roomWatchCounts.has(room.roomId)) {
        this.roomMatchIds.set(room.roomId, room.activeMatchId);
      }
    }
    for (const roomId of new Set([...priorRoomIds, ...rooms.map((room) => room.roomId)])) {
      this.reconcileRoomResource(roomId);
    }
    for (const matchId of new Set([...priorMatchIds, ...rooms.flatMap((room) => room.activeMatchId ? [room.activeMatchId] : [])])) {
      this.reconcileMatchResource(matchId);
    }

    const liveRooms = rooms.filter(room => room.status !== "closed");
    if (this.socket.connected) await Promise.allSettled(liveRooms
      .filter(room => this.roomWatchCounts.has(room.roomId)).map(room => this.syncRoom(room.roomId)));
    return liveRooms.map(room => this.store.getSnapshot().rooms[room.roomId]?.room ?? room);
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
      this.clearRetries();
      this.connectionGeneration += 1;
      if (!this.sessionExpired) this.store.setConnection("disconnected", null);
      this.abortActiveAttempts(new BrowserTransportError("NOT_CONNECTED"));
    });
    this.socket.on("room:changed", (payload) => this.handleRoomChanged(payload));
    this.socket.on("room:presence", (payload) => {
      const parsed = parseRoomPresenceView(payload);
      if (parsed.ok && this.roomIds.has(parsed.value.roomId)) this.store.applyRoomPresence(parsed.value);
    });
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
        const response = await this.performRoomSync(roomId, false, false);
        roomSyncSucceeded.add(roomId);
        if (response.room.activeMatchId) activeMatchIds.add(response.room.activeMatchId);
      } catch {
        this.scheduleSyncRetry("room", roomId);
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
        this.scheduleSyncRetry("match", matchId);
      }
    }));

    if (!this.socket.connected || generation !== this.connectionGeneration) return;

    for (const entry of pendingCommands) {
      if ((entry.roomId && !roomSyncSucceeded.has(entry.roomId)) ||
          (entry.matchId && !matchSyncSucceeded.has(entry.matchId))) { this.scheduleCommandRetry(entry); continue; }
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
    const retained = (this.roomWatchCounts.has(roomId) || this.confirmedRoomIds.has(roomId)) &&
      !this.unavailableRoomIds.has(roomId) && !this.closedRoomIds.has(roomId);
    if (retained) this.roomIds.add(roomId);
    else {
      this.roomIds.delete(roomId);
      this.clearRetry(`room:${roomId}`);
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
    const retained = (this.matchWatchCounts.has(matchId) || this.confirmedMatchIds.has(matchId) || referencedByRoom) &&
      !this.unavailableMatchIds.has(matchId);
    if (retained) this.matchIds.add(matchId);
    else {
      this.matchIds.delete(matchId);
      this.clearRetry(`match:${matchId}`);
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

  private async performRoomSync(roomId: string, syncActiveMatch = true, allowUnchanged = true): Promise<RoomSyncResponse> {
    const current = this.store.getSnapshot().rooms[roomId];
    const request: RoomSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      roomId,
      knownVersion: current?.version ?? 0,
      ...(allowUnchanged && current ? { acceptUnchanged: true as const } : {}),
    };
    if (!parseRoomSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    try {
      const raw = await this.emitAck("room:sync", request);
      const rejected = parseSyncRejectedResponse(raw);
      if (rejected.ok) {
        if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
        if (rejected.value.error.code === "NOT_FOUND_OR_FORBIDDEN") {
          this.rejectResource("room", roomId);
        } else this.store.setError("SYNC_REJECTED");
        if (rejected.value.error.code === "INTERNAL_ERROR") throw new BrowserTransportError("HTTP_SERVER_ERROR");
        throw requestError("REQUEST_REJECTED", rejected.value);
      }
      const unchanged = parseSyncUnchangedResponse(raw);
      if (unchanged.ok) {
        const cached = this.getSnapshot().rooms[roomId];
        if (request.acceptUnchanged && unchanged.value.requestId === request.requestId && "roomId" in unchanged.value &&
            unchanged.value.roomId === roomId && unchanged.value.version === request.knownVersion && cached?.version === request.knownVersion &&
            !this.unavailableRoomIds.has(roomId)) {
          this.store.setError(null);
          this.trackRoomMatch(roomId, cached.room.activeMatchId);
          if (cached.room.activeMatchId && syncActiveMatch && this.socket.connected &&
              !this.getSnapshot().matches[cached.room.activeMatchId]) {
            void this.syncMatch(cached.room.activeMatchId).catch(() => undefined);
          }
          return this.roomResponseFromCache(request.requestId, roomId, cached);
        }
        if (!allowUnchanged) throw new BrowserTransportError("INVALID_RESPONSE");
        return this.performRoomSync(roomId, syncActiveMatch, false);
      }
      const parsed = parseRoomSyncResponse(raw);
      if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.roomId !== roomId ||
          !this.store.isCurrentViewer(parsed.value.room.viewer.playerId)) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      if (this.unavailableRoomIds.has(roomId)) throw new BrowserTransportError("REQUEST_REJECTED");
      this.store.restoreResourceAccess("room", roomId);
      // A reconnect can change presence without changing the room version.
      // Preserve any newer notification that arrived while the ACK was in flight.
      const presenceUnchanged = this.store.getSnapshot().rooms[roomId]?.presenceObservedAt === current?.presenceObservedAt;
      this.store.applyRoomSync(parsed.value, presenceUnchanged);
      if (parsed.value.room.status === "closed") { this.closedRoomIds.add(roomId); this.reconcileRoomResource(roomId); }
      this.trackRoomMatch(roomId, parsed.value.room.activeMatchId);
      if (parsed.value.room.activeMatchId && syncActiveMatch && this.socket.connected) {
        void this.syncMatch(parsed.value.room.activeMatchId).catch(() => undefined);
      }
      const latest = this.getSnapshot().rooms[roomId];
      return latest && latest.version > parsed.value.version
        ? this.roomResponseFromCache(request.requestId, roomId, latest) : parsed.value;
    } catch (error) {
      if (error instanceof BrowserTransportError && error.code === "REQUEST_REJECTED") throw error;
      if (error instanceof BrowserTransportError && error.code === "INVALID_RESPONSE") throw error;
      this.store.setError("CONNECTION");
      throw error;
    }
  }

  private async performMatchSync(matchId: string, allowUnchanged = true): Promise<MatchSyncResponse> {
    const current = this.store.getSnapshot().matches[matchId];
    const request: MatchSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      matchId,
      knownVersion: current?.version ?? 0,
      afterEventSeq: current?.eventSeq ?? 0,
      ...(allowUnchanged && current ? { acceptUnchanged: true as const } : {}),
    };
    if (!parseMatchSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    try {
      const raw = await this.emitAck("match:sync", request);
      const rejected = parseSyncRejectedResponse(raw);
      if (rejected.ok) {
        if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
        if (rejected.value.error.code === "NOT_FOUND_OR_FORBIDDEN") this.rejectResource("match", matchId);
        else this.store.setError("SYNC_REJECTED");
        if (rejected.value.error.code === "INTERNAL_ERROR") throw new BrowserTransportError("HTTP_SERVER_ERROR");
        throw requestError("REQUEST_REJECTED", rejected.value);
      }
      const unchanged = parseSyncUnchangedResponse(raw);
      if (unchanged.ok) {
        const cached = this.getSnapshot().matches[matchId];
        if (request.acceptUnchanged && unchanged.value.requestId === request.requestId && "matchId" in unchanged.value &&
            unchanged.value.matchId === matchId && unchanged.value.version === request.knownVersion &&
            unchanged.value.eventSeq === request.afterEventSeq && cached?.version === request.knownVersion &&
            cached.eventSeq === request.afterEventSeq && !this.unavailableMatchIds.has(matchId)) {
          this.store.setError(null);
          return this.matchResponseFromCache(request.requestId, matchId, cached);
        }
        if (!allowUnchanged) throw new BrowserTransportError("INVALID_RESPONSE");
        return this.performMatchSync(matchId, false);
      }
      const parsed = parseMatchSyncResponse(raw);
      if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.matchId !== matchId ||
          !this.store.isCurrentViewer(parsed.value.snapshot.viewer.playerId)) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      if (this.unavailableMatchIds.has(matchId)) throw new BrowserTransportError("REQUEST_REJECTED");
      this.store.applyMatchSync(parsed.value);
      const latest = this.getSnapshot().matches[matchId];
      return latest && (latest.version > parsed.value.version || latest.eventSeq > parsed.value.eventSeq)
        ? this.matchResponseFromCache(request.requestId, matchId, latest) : parsed.value;
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
        this.scheduleCommandRetry(pending);
      }, this.acknowledgementTimeoutMs),
    };
    pending.active = attempt;
    this.socket.emit(pending.event, pending.payload, (response: unknown) => {
      if (this.pending.get(pending.commandId) !== pending || this.sessionExpired) return;
      if (!this.isValidCommandReply(pending, response)) {
        if (pending.active !== attempt) return;
        clearTimeout(attempt.timer);
        pending.active = undefined;
        this.store.setError("INVALID_RESPONSE");
        attempt.reject(new BrowserTransportError("INVALID_RESPONSE"));
        this.scheduleCommandRetry(pending);
        return;
      }
      clearTimeout(attempt.timer);
      const currentAttempt = pending.active;
      if (currentAttempt) clearTimeout(currentAttempt.timer);
      pending.active = undefined;
      this.clearRetry(`command:${pending.commandId}`);
      this.pending.delete(pending.commandId);
      const ack = isCommandAck(response, pending.commandId) ? response : null;
      if (ack) {
        this.commandAcknowledgements.set(pending.commandId, cloneProtocolValue(ack));
        if (this.commandAcknowledgements.size > 50) this.commandAcknowledgements.delete(this.commandAcknowledgements.keys().next().value!);
      }
      const accepted = ack === null || ack.status === "accepted";
      if (accepted && pending.roomId) {
        const room = parseRoomView(response);
        let roomProjectionApplied = false;
        if (room.ok && room.value.roomId === pending.roomId && room.value.version !== undefined) {
          const previous = this.store.getSnapshot().rooms[pending.roomId];
          this.unavailableRoomIds.delete(pending.roomId);
          this.reconcileRoomResource(pending.roomId);
          this.store.restoreResourceAccess("room", pending.roomId);
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
        let projectionApplied = false;
        if (ack?.status === "accepted") {
          this.recordMatchHint(pending.matchId, { version: ack.aggregateVersion, eventSeq: ack.eventSeq });
          const projection = ack.matchProjection;
          const cached = this.getSnapshot().matches[pending.matchId];
          if (projection && cached && projection.baseEventSeq !== undefined && projection.baseEventSeq <= cached.eventSeq) {
            this.store.applyMatchSync({ protocolVersion: 1, requestId: pending.commandId,
              matchId: pending.matchId, version: ack.aggregateVersion, eventSeq: ack.eventSeq,
              requiresFullSnapshot: false, snapshot: projection.snapshot, visibleEvents: projection.visibleEvents });
            projectionApplied = true;
          }
        }
        if (!projectionApplied) void this.syncMatch(pending.matchId).catch(() => undefined);
      }
      this.updatePendingIds();
      attempt.resolve(response);
      if (currentAttempt !== attempt) currentAttempt?.resolve(response);
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
    return isCommandAck(response, pending.commandId) &&
      (response.status !== "accepted" || !response.matchProjection ||
        this.store.isCurrentViewer(response.matchProjection.snapshot.viewer.playerId));
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

  private readonly resumeVisibleResources = (): void => {
    if (this.stopped || this.sessionExpired) return;
    if (this.visibilityTarget?.visibilityState === "hidden") { this.clearRetries(); return; }
    if (!this.socket.connected) { this.socket.connect(); return; }
    void this.syncAfterConnect(this.connectionGeneration);
  };

  private clearRetry(key: string): void {
    clearTimeout(this.retries.get(key));
    this.retries.delete(key);
    this.retryDelays.delete(key);
  }

  private clearRetries(): void {
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    this.retryDelays.clear();
  }

  private scheduleRetry(key: string, initialDelay: number, action: () => void): void {
    if (this.stopped || this.sessionExpired || !this.socket.connected ||
        this.visibilityTarget?.visibilityState === "hidden" || this.retries.has(key)) return;
    const delay = this.retryDelays.get(key) ?? initialDelay;
    this.retryDelays.set(key, Math.min(10_000, delay * 2));
    const timer = setTimeout(() => {
      this.retries.delete(key);
      if (!this.stopped && !this.sessionExpired && this.socket.connected) action();
    }, delay);
    (timer as unknown as { unref?: () => void }).unref?.();
    this.retries.set(key, timer);
  }

  private scheduleSyncRetry(kind: "room" | "match", id: string): void {
    const resources = kind === "room" ? this.roomIds : this.matchIds;
    if (!resources.has(id)) return;
    this.scheduleRetry(`${kind}:${id}`, this.syncRetryIntervalMs, () => {
      if (resources.has(id)) void (kind === "room" ? this.syncRoom(id) : this.syncMatch(id)).catch(() => undefined);
    });
  }

  private scheduleCommandRetry(pending: PendingCommand): void {
    if (this.pending.get(pending.commandId) !== pending) return;
    this.scheduleRetry(`command:${pending.commandId}`, this.commandRetryIntervalMs, () => {
      if (this.pending.get(pending.commandId) === pending) void this.attemptPending(pending).catch(() => undefined);
    });
  }

  private rejectResource(kind: "room" | "match", id: string): void {
    if (kind === "room") {
      const matchId = this.roomMatchIds.get(id) ?? this.getSnapshot().rooms[id]?.room.activeMatchId;
      this.unavailableRoomIds.add(id);
      this.reconcileRoomResource(id);
      if (matchId) this.rejectResource("match", matchId);
    } else {
      this.unavailableMatchIds.add(id);
      this.reconcileMatchResource(id);
    }
    this.store.setResourceUnavailable(kind, id);
  }

  private roomResponseFromCache(requestId: string, roomId: string, cached: BrowserTransportState["rooms"][string]): RoomSyncResponse {
    return { protocolVersion: 1, requestId, roomId, version: cached.version,
      requiresFullSnapshot: cached.requiresFullSnapshot, room: cached.room };
  }

  private matchResponseFromCache(requestId: string, matchId: string, cached: BrowserTransportState["matches"][string]): MatchSyncResponse {
    return { protocolVersion: 1, requestId, matchId, version: cached.version, eventSeq: cached.eventSeq,
      requiresFullSnapshot: cached.requiresFullSnapshot, snapshot: cached.snapshot, visibleEvents: cached.visibleEvents };
  }

  private markSessionExpired(): void {
    this.sessionExpired = true;
    this.clearRetries();
    this.commandAcknowledgements.clear();
    this.store.setConnection("expired", false);
    this.store.setError("SESSION_EXPIRED");
    this.abortActiveAttempts(new BrowserTransportError("SESSION_EXPIRED"));
    this.pending.clear();
    this.updatePendingIds();
    this.socket.disconnect();
  }

  private adoptPlayer(playerId: string | undefined): void {
    if (this.restoredPlayerId !== undefined && this.restoredPlayerId !== playerId) {
      this.clearRetries();
      this.abortActiveAttempts(new BrowserTransportError("SESSION_EXPIRED"));
      this.pending.clear();
      this.commandAcknowledgements.clear();
      this.roomHints.clear();
      this.matchHints.clear();
      this.confirmedRoomIds.clear();
      this.confirmedMatchIds.clear();
      this.roomMatchIds.clear();
      this.roomIds.clear();
      this.matchIds.clear();
      this.updatePendingIds();
    }
    this.restoredPlayerId = playerId;
    if (playerId !== undefined) this.store.setViewerPlayerId(playerId);
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
  const parsed = parseCommandAck(input);
  return parsed.ok && parsed.value.commandId === commandId;
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
