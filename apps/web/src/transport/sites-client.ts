import type {
  CommandAck,
  GuestSessionRequest,
  GuestSessionResponse,
  MatchCommand,
  MatchSyncRequest,
  MatchSyncResponse,
  RoomCommand,
  RoomPreviewRequest,
  RoomSyncRequest,
  RoomSyncResponse,
  RoomView,
} from "../../../../packages/contracts/src/protocol.js";
import {
  parseCommandAck,
  parseMatchCommand,
  parseMatchSyncRequest,
  parseMatchSyncResponse,
  parseRoomCommand,
  parseRoomPreviewRequest,
  parseRoomPreviewResponse,
  parseRoomPresenceView,
  parseRoomSyncRequest,
  parseRoomSyncResponse,
  parseRoomView,
  parseSyncUnchangedResponse,
  parseSyncRejectedResponse,
} from "../../../../packages/contracts/src/validation.js";
import type { RoomEntryCreateResult, RoomEntryPreview } from "../features/room-entry/model.js";
import { BrowserTransportError } from "./errors.js";
import { BrowserTransportStore } from "./state.js";
import type { BrowserTransportState, GameTransport } from "./types.js";

type Fetcher = typeof fetch;

interface EventSourceMessage extends Event {
  readonly data: string;
  readonly lastEventId: string;
}

export interface SitesEventSource {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  close(): void;
}

export interface SitesGameTransportOptions {
  fetcher?: Fetcher;
  eventSourceFactory?: (url: string, init: EventSourceInit) => SitesEventSource;
  createId?: () => string;
  acknowledgementTimeoutMs?: number;
  readTimeoutMs?: number;
  fallbackPollIntervalMs?: number;
  syncRetryIntervalMs?: number;
  visibilityTarget?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
}

interface PendingCommand {
  readonly command: RoomCommand | MatchCommand;
  readonly event: "room:create" | "room:command" | "match:command";
  readonly commandId: string;
  readonly serializedPayload: string;
  readonly roomId?: string;
  readonly matchId?: string;
  active?: Promise<unknown>;
}

interface HttpReply {
  readonly status: number;
  readonly body: unknown;
}

interface HintCursor {
  readonly version: number;
  readonly eventSeq?: number;
}

const EVENT_SOURCE_CONNECTING = 0;
const EVENT_SOURCE_CLOSED = 2;
const MAX_RECONNECT_DELAY_MS = 15_000;

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

function isGuestSessionResponse(input: unknown): input is GuestSessionResponse {
  return isRecord(input) && exactKeys(input, ["protocolVersion", "player", "sessionExpiresAt"]) &&
    input.protocolVersion === 1 && isRecord(input.player) &&
    exactKeys(input.player, ["playerId", "displayName"]) && isText(input.player.playerId) &&
    typeof input.player.displayName === "string" && typeof input.sessionExpiresAt === "string" &&
    Number.isFinite(Date.parse(input.sessionExpiresAt));
}

function isRoomCreateResult(input: unknown): input is RoomEntryCreateResult {
  return isRecord(input) && exactKeys(input, ["roomId", "version", "inviteCode", "duplicate"]) &&
    isText(input.roomId) && isVersion(input.version) &&
    (input.inviteCode === null || isText(input.inviteCode)) && typeof input.duplicate === "boolean";
}

function isRoomPreviewRequest(input: unknown): input is RoomPreviewRequest {
  return parseRoomPreviewRequest(input).ok;
}

function cloneProtocolValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function defaultId(): string {
  return globalThis.crypto.randomUUID();
}

function defaultEventSourceFactory(url: string, init: EventSourceInit): SitesEventSource {
  return new EventSource(url, init);
}

/**
 * Sites transport for same-origin Worker JSON APIs and membership-scoped SSE.
 * SSE messages only invalidate a projection; every displayed state comes from
 * the canonical room/match sync response.
 */
export class SitesGameTransport implements GameTransport {
  readonly writesAvailableWhileDisconnected = true;
  readonly store = new BrowserTransportStore();
  private readonly fetcher: Fetcher;
  private readonly eventSourceFactory: (url: string, init: EventSourceInit) => SitesEventSource;
  private readonly createId: () => string;
  private readonly acknowledgementTimeoutMs: number;
  private readonly readTimeoutMs: number;
  private readonly fallbackPollIntervalMs: number;
  private readonly syncRetryIntervalMs: number;
  private readonly syncRetries = new Map<string, { timer: ReturnType<typeof setTimeout>; delay: number }>();
  private readonly syncRetryDelays = new Map<string, number>();
  private readonly unavailableRoomIds = new Set<string>();
  private readonly unavailableMatchIds = new Set<string>();
  private readonly closedRoomIds = new Set<string>();
  private fallbackTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly visibilityTarget?: SitesGameTransportOptions["visibilityTarget"];
  private readonly roomIds = new Set<string>();
  private readonly matchIds = new Set<string>();
  private readonly roomWatchCounts = new Map<string, number>();
  private readonly matchWatchCounts = new Map<string, number>();
  private readonly recoveredRoomIds = new Set<string>();
  private readonly recoveredMatchIds = new Set<string>();
  private readonly roomMatchIds = new Map<string, string>();
  private readonly confirmedRoomIds = new Set<string>();
  private readonly confirmedMatchIds = new Set<string>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly roomSyncs = new Map<string, Promise<RoomSyncResponse>>();
  private readonly matchSyncs = new Map<string, Promise<MatchSyncResponse>>();
  private readonly roomHints = new Map<string, HintCursor>();
  private readonly matchHints = new Map<string, HintCursor>();
  private readonly roomMutationGenerations = new Map<string, number>();
  private restoreSessionRequest?: Promise<GuestSessionResponse | null>;
  private assignedSeatsRequest?: Promise<readonly RoomView[]>;
  private source: SitesEventSource | null = null;
  private sourceResources = "";
  private visibilityListener?: () => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = 250;
  private lastCursor = 0;
  private started = false;
  private sessionExpired = false;
  private restoredPlayerId?: string;
  private connectionGeneration = 0;

  constructor(options: SitesGameTransportOptions = {}) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
    this.eventSourceFactory = options.eventSourceFactory ?? defaultEventSourceFactory;
    this.createId = options.createId ?? defaultId;
    this.acknowledgementTimeoutMs = options.acknowledgementTimeoutMs ?? 5_000;
    this.readTimeoutMs = options.readTimeoutMs ?? 5_000;
    this.fallbackPollIntervalMs = options.fallbackPollIntervalMs ?? 2_000;
    this.syncRetryIntervalMs = options.syncRetryIntervalMs ?? 250;
    if (![this.readTimeoutMs, this.fallbackPollIntervalMs, this.syncRetryIntervalMs].every(value => Number.isSafeInteger(value) && value > 0)) {
      throw new RangeError("Transport timing must be a positive integer.");
    }
    this.visibilityTarget = options.visibilityTarget ?? (typeof document === "undefined" ? undefined : document);
  }

  readonly getSnapshot = (): BrowserTransportState => this.store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  connect(): void {
    this.started = true;
    if (this.sessionExpired) return;
    this.installVisibilityListener();
    const authenticated = this.store.getSnapshot().authenticated;
    // JSON remains usable without an EventSource (new guest, unsupported browser,
    // or a temporarily unavailable SSE endpoint).
    this.store.setConnection("connected", authenticated);
    this.ensureEventStream();
  }

  disconnect(): void {
    this.started = false;
    this.clearFallbackPoll();
    this.clearSyncRetries();
    this.connectionGeneration += 1;
    this.removeVisibilityListener();
    this.clearReconnectTimer();
    this.closeEventStream();
    const authenticated = this.store.getSnapshot().authenticated;
    this.store.setConnection("disconnected", authenticated);
  }

  watchRoom(roomId: string): () => void {
    this.assertResourceId(roomId);
    this.roomWatchCounts.set(roomId, (this.roomWatchCounts.get(roomId) ?? 0) + 1);
    this.confirmedRoomIds.delete(roomId);
    this.reconcileRoomResource(roomId);
    this.ensureEventStream();
    void this.syncRoom(roomId).catch(() => undefined);
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
    this.ensureEventStream();
    void this.syncMatch(matchId).catch(() => undefined);
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
    const current = this.roomSyncs.get(roomId);
    if (current) return current;
    const mutationGeneration = this.roomMutationGenerations.get(roomId) ?? 0;
    let request: Promise<RoomSyncResponse>;
    request = this.performRoomSync(roomId).catch(error => {
      if (!(error instanceof BrowserTransportError) || error.code !== "REQUEST_REJECTED") this.scheduleSyncRetry("room", roomId);
      throw error;
    }).finally(() => {
      if (this.roomSyncs.get(roomId) === request) this.roomSyncs.delete(roomId);
    }).then((response) => {
      this.clearSyncRetry("room", roomId);
      if ((this.roomMutationGenerations.get(roomId) ?? 0) > mutationGeneration) {
        void this.syncRoom(roomId).catch(() => undefined);
        return response;
      }
      const hint = this.roomHints.get(roomId);
      if (hint && hint.version > (this.getSnapshot().rooms[roomId]?.version ?? -1)) {
        this.scheduleSyncRetry("room", roomId);
      }
      return response;
    });
    this.roomSyncs.set(roomId, request);
    return request;
  }

  async syncMatch(matchId: string): Promise<MatchSyncResponse> {
    this.assertResourceId(matchId);
    if (this.unavailableMatchIds.has(matchId)) throw new BrowserTransportError("REQUEST_REJECTED", "NOT_FOUND_OR_FORBIDDEN");
    const current = this.matchSyncs.get(matchId);
    if (current) return current;
    let request: Promise<MatchSyncResponse>;
    request = this.performMatchSync(matchId).catch(error => {
      if (!(error instanceof BrowserTransportError) || error.code !== "REQUEST_REJECTED") this.scheduleSyncRetry("match", matchId);
      throw error;
    }).finally(() => {
      if (this.matchSyncs.get(matchId) === request) this.matchSyncs.delete(matchId);
    }).then((response) => {
      this.clearSyncRetry("match", matchId);
      const hint = this.matchHints.get(matchId);
      const projection = this.getSnapshot().matches[matchId];
      if (hint && projection && (hint.version > projection.version ||
          (hint.version === projection.version && (hint.eventSeq ?? 0) > projection.eventSeq))) {
        this.scheduleSyncRetry("match", matchId);
      }
      return response;
    });
    this.matchSyncs.set(matchId, request);
    return request;
  }

  async createGuestSession(input: GuestSessionRequest): Promise<GuestSessionResponse> {
    if (!isRecord(input) || !exactKeys(input, ["protocolVersion", "displayName"]) ||
        input.protocolVersion !== 1 || typeof input.displayName !== "string") {
      throw new BrowserTransportError("INVALID_RESPONSE", "Invalid guest session request.");
    }
    const reply = await this.requestJson("/api/guest-sessions", "POST", input);
    if (reply.status < 200 || reply.status >= 300 || !isGuestSessionResponse(reply.body)) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.sessionExpired = false;
    this.store.setViewerPlayerId(reply.body.player.playerId);
    this.restoredPlayerId = reply.body.player.playerId;
    this.store.setConnection(this.getSnapshot().connection, true);
    this.ensureEventStream();
    return reply.body;
  }

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
    const reply = await this.requestJson("/api/guest-sessions", "GET");
    if (reply.status === 204) {
      this.restoredPlayerId = undefined;
      this.store.setConnection(this.getSnapshot().connection, false);
      return null;
    }
    if (reply.status !== 200 || !isGuestSessionResponse(reply.body)) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.sessionExpired = false;
    this.store.setViewerPlayerId(reply.body.player.playerId);
    this.restoredPlayerId = reply.body.player.playerId;
    this.store.setConnection(this.getSnapshot().connection, true);
    this.ensureEventStream();
    return reply.body;
  }

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
    const reply = await this.requestJson("/api/guest-sessions/rooms", "GET");
    if (reply.status === 401) {
      if (!isRecord(reply.body) || !exactKeys(reply.body, ["error"]) || !isRecord(reply.body.error) ||
          !exactKeys(reply.body.error, ["code"]) || reply.body.error.code !== "SESSION_EXPIRED") {
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      this.markSessionExpired();
      throw new BrowserTransportError("SESSION_EXPIRED");
    }
    if (reply.status !== 200 || !Array.isArray(reply.body)) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }

    const rooms: RoomView[] = [];
    for (const value of reply.body) {
      const parsed = parseRoomView(value);
      if (!parsed.ok || (this.restoredPlayerId !== undefined && parsed.value.viewer.playerId !== this.restoredPlayerId)) {
        this.store.setError("INVALID_RESPONSE");
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
    for (const roomId of new Set([...priorRoomIds, ...rooms.map((room) => room.roomId)])) this.reconcileRoomResource(roomId);
    for (const matchId of new Set([...priorMatchIds, ...rooms.flatMap((room) => room.activeMatchId ? [room.activeMatchId] : [])])) this.reconcileMatchResource(matchId);
    this.ensureEventStream();

    const liveRooms = rooms.filter(room => room.status !== "closed");
    await Promise.all(liveRooms.filter(room => room.version === undefined || this.roomWatchCounts.has(room.roomId))
      .map((room) => this.syncRoom(room.roomId)));
    const activeMatchIds = new Set(liveRooms.filter(room => this.roomWatchCounts.has(room.roomId)).flatMap((room) => {
      const id = this.getSnapshot().rooms[room.roomId]?.room.activeMatchId ?? room.activeMatchId;
      return id ? [id] : [];
    }));
    await Promise.all([...activeMatchIds].map((matchId) => this.syncMatch(matchId)));
    return liveRooms.map((room) => this.getSnapshot().rooms[room.roomId]?.room ?? room);
  }

  async createRoom(command: Extract<RoomCommand, { type: "CREATE_ROOM" }>): Promise<RoomEntryCreateResult> {
    const response = await this.sendRoomCommand(command);
    if (this.isRejectedCommand(response, command.commandId)) throw this.commandError(response);
    if (!isRoomCreateResult(response)) throw new BrowserTransportError("INVALID_RESPONSE");
    this.confirmedRoomIds.add(response.roomId);
    this.reconcileRoomResource(response.roomId);
    void this.syncRoom(response.roomId).catch(() => undefined);
    return response;
  }

  async previewInvite(inviteCode: string): Promise<RoomEntryPreview | null> {
    if (!isText(inviteCode)) return null;
    const request: RoomPreviewRequest = { protocolVersion: 1, requestId: this.createId(), inviteCode };
    if (!isRoomPreviewRequest(request)) throw new BrowserTransportError("INVALID_RESPONSE");
    const reply = await this.requestJson("/api/rooms/preview", "POST", request);
    const parsed = parseRoomPreviewResponse(reply.body);
    if (!parsed.ok || parsed.value.requestId !== request.requestId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (parsed.value.status === "rejected") return null;
    return {
      roomId: parsed.value.roomId,
      version: parsed.value.version,
      occupancy: parsed.value.occupancy,
      status: parsed.value.status,
    };
  }

  async reissueRoomInvite(roomId: string, expectedVersion: number): Promise<RoomEntryCreateResult> {
    this.assertResourceId(roomId);
    const reply = await this.requestJson(`/api/rooms/${encodeURIComponent(roomId)}/invite`, "POST",
      { protocolVersion: 1, expectedVersion });
    if (reply.status === 401) {
      this.markSessionExpired();
      throw new BrowserTransportError("SESSION_EXPIRED");
    }
    if (reply.status !== 200 || !isRoomCreateResult(reply.body) || reply.body.roomId !== roomId || !reply.body.inviteCode) {
      await this.syncRoom(roomId).catch(() => undefined);
      throw new BrowserTransportError("REQUEST_REJECTED");
    }
    void this.syncRoom(roomId).catch(() => undefined);
    return reply.body;
  }

  async joinRoom(command: Extract<RoomCommand, { type: "JOIN" }>): Promise<RoomView> {
    const response = await this.sendRoomCommand(command);
    if (this.isRejectedCommand(response, command.commandId)) throw this.commandError(response);
    const parsed = parseRoomView(response);
    if (!parsed.ok || parsed.value.roomId !== command.roomId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    return parsed.value;
  }

  async sendRoomCommand(command: RoomCommand): Promise<unknown> {
    const parsed = parseRoomCommand(command);
    if (!parsed.ok) throw new BrowserTransportError("INVALID_RESPONSE", "Invalid room command.");
    const roomId = parsed.value.type === "CREATE_ROOM" ? undefined : parsed.value.roomId;
    return this.sendCommand(parsed.value, parsed.value.type === "CREATE_ROOM" ? "room:create" : "room:command", { roomId });
  }

  async sendMatchCommand(command: MatchCommand): Promise<CommandAck> {
    const parsed = parseMatchCommand(command);
    if (!parsed.ok) throw new BrowserTransportError("INVALID_RESPONSE", "Invalid match command.");
    const response = await this.sendCommand(parsed.value, "match:command", { matchId: parsed.value.matchId });
    const ack = parseCommandAck(response);
    if (!ack.ok || ack.value.commandId !== parsed.value.commandId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    return ack.value;
  }

  retryPendingCommand(commandId: string): Promise<unknown> {
    const pending = this.pending.get(commandId);
    if (!pending) throw new BrowserTransportError("INVALID_RESPONSE", "Unknown pending command.");
    return this.attemptPending(pending);
  }

  private sendCommand(
    command: RoomCommand | MatchCommand,
    event: PendingCommand["event"],
    scope: { roomId?: string; matchId?: string },
  ): Promise<unknown> {
    const frozenCommand = cloneProtocolValue(command);
    const commandId = frozenCommand.commandId;
    const serializedPayload = JSON.stringify(frozenCommand);
    const current = this.pending.get(commandId);
    if (current && (current.event !== event || current.serializedPayload !== serializedPayload)) {
      return Promise.reject(new BrowserTransportError("COMMAND_ID_REUSED"));
    }
    const pending = current ?? { command: frozenCommand, event, commandId, serializedPayload, ...scope };
    if (!current) {
      this.pending.set(commandId, pending);
      this.updatePendingIds();
    }
    return this.attemptPending(pending);
  }

  private attemptPending(pending: PendingCommand): Promise<unknown> {
    if (pending.active) return pending.active;
    const attempt = this.performPending(pending);
    pending.active = attempt;
    return attempt.finally(() => {
      if (pending.active === attempt) pending.active = undefined;
    });
  }

  private async performPending(pending: PendingCommand): Promise<unknown> {
    const endpoint = pending.event === "room:create"
      ? "/api/rooms"
      : pending.event === "match:command"
        ? `/api/matches/${encodeURIComponent(pending.matchId!)}/commands`
        : `/api/rooms/${encodeURIComponent(pending.roomId!)}/commands`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.acknowledgementTimeoutMs);
    let reply: HttpReply;
    try {
      reply = await this.requestJson(endpoint, "POST", pending.command, controller.signal);
    } finally {
      clearTimeout(timeout);
    }

    let response: unknown = reply.body;
    if (pending.event === "room:create") {
      const ack = parseCommandAck(response);
      if (!isRoomCreateResult(response) &&
          (!ack.ok || ack.value.commandId !== pending.commandId || ack.value.status !== "rejected")) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
    } else if (pending.event === "room:command") {
      const room = parseRoomView(response);
      const ack = parseCommandAck(response);
      if ((!room.ok || room.value.roomId !== pending.roomId) && (!ack.ok || ack.value.commandId !== pending.commandId)) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
    } else {
      const ack = parseCommandAck(response);
      if (!ack.ok || ack.value.commandId !== pending.commandId) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
    }

    const ack = parseCommandAck(response);
    if (ack.ok && ack.value.status === "rejected" && ack.value.error.code === "UNAUTHENTICATED") {
      this.markSessionExpired();
    }
    if (pending.matchId && ack.ok && ack.value.status === "accepted" && ack.value.matchProjection &&
        this.restoredPlayerId !== undefined && ack.value.matchProjection.snapshot.viewer.playerId !== this.restoredPlayerId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.pending.delete(pending.commandId);
    this.updatePendingIds();
    const accepted = !ack.ok || ack.value.status === "accepted";
    if (accepted && pending.command.type === "JOIN" && pending.roomId) {
      this.unavailableRoomIds.delete(pending.roomId);
      this.closedRoomIds.delete(pending.roomId);
      this.store.restoreResourceAccess("room", pending.roomId);
    }
    if (ack.ok && ack.value.status === "rejected" &&
        ["NOT_A_PLAYER", "NOT_FOUND_OR_FORBIDDEN"].includes(ack.value.error.code) && pending.command.type !== "JOIN") {
      if (pending.roomId) this.rejectResource("room", pending.roomId);
      if (pending.matchId) this.rejectResource("match", pending.matchId);
    }
    if (accepted && pending.roomId && !this.unavailableRoomIds.has(pending.roomId)) {
      if (!this.roomWatchCounts.has(pending.roomId) && !this.recoveredRoomIds.has(pending.roomId)) {
        this.confirmedRoomIds.add(pending.roomId);
      } else {
        this.confirmedRoomIds.delete(pending.roomId);
      }
      this.reconcileRoomResource(pending.roomId);
      const room = parseRoomView(response);
      if (room.ok && room.value.roomId === pending.roomId && room.value.version !== undefined) {
        const previousMatchId = this.getSnapshot().rooms[pending.roomId]?.room.activeMatchId;
        this.store.applyRoomCommand(room.value);
        const latestRoom = this.getSnapshot().rooms[pending.roomId]?.room ?? room.value;
        this.trackRoomMatch(pending.roomId, latestRoom.activeMatchId);
        if (latestRoom.activeMatchId && (latestRoom.activeMatchId !== previousMatchId ||
            !this.getSnapshot().matches[latestRoom.activeMatchId])) {
          void this.syncMatch(latestRoom.activeMatchId).catch(() => undefined);
        }
      } else {
        this.roomMutationGenerations.set(pending.roomId, (this.roomMutationGenerations.get(pending.roomId) ?? 0) + 1);
        void this.syncRoom(pending.roomId).catch(() => undefined);
      }
    }
    if (accepted && pending.matchId && !this.unavailableMatchIds.has(pending.matchId)) {
      const referencedByRoom = [...this.roomMatchIds].some(([roomId, matchId]) =>
        matchId === pending.matchId && this.roomIds.has(roomId));
      if (!this.matchWatchCounts.has(pending.matchId) && !this.recoveredMatchIds.has(pending.matchId) && !referencedByRoom) {
        this.confirmedMatchIds.add(pending.matchId);
      } else {
        this.confirmedMatchIds.delete(pending.matchId);
      }
      this.reconcileMatchResource(pending.matchId);
      if (ack.ok && ack.value.status === "accepted" && isVersion(ack.value.aggregateVersion) && isVersion(ack.value.eventSeq)) {
        this.recordMatchHint(pending.matchId, { version: ack.value.aggregateVersion, eventSeq: ack.value.eventSeq });
      }
      const cached = this.getSnapshot().matches[pending.matchId];
      const baseEventSeq = ack.ok && ack.value.status === "accepted" ? ack.value.matchProjection?.baseEventSeq : undefined;
      if (ack.ok && ack.value.status === "accepted" && ack.value.matchProjection && cached &&
          baseEventSeq !== undefined && baseEventSeq <= cached.eventSeq) {
        this.store.applyMatchSync({ protocolVersion: 1, requestId: pending.commandId, matchId: pending.matchId,
          version: ack.value.aggregateVersion, eventSeq: ack.value.eventSeq, requiresFullSnapshot: false,
          snapshot: ack.value.matchProjection.snapshot, visibleEvents: ack.value.matchProjection.visibleEvents });
      } else void this.syncMatch(pending.matchId).catch(() => undefined);
    }
    return response;
  }

  private async performRoomSync(roomId: string, syncActiveMatch = true, allowUnchanged = true): Promise<RoomSyncResponse> {
    const current = this.getSnapshot().rooms[roomId];
    const request: RoomSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      roomId,
      knownVersion: current?.version ?? 0,
      ...(allowUnchanged && current ? { acceptUnchanged: true } : {}),
    };
    if (!parseRoomSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    const reply = await this.requestJson(`/api/rooms/${encodeURIComponent(roomId)}/sync`, "POST", request);
    const rejected = parseSyncRejectedResponse(reply.body);
    if (rejected.ok) {
      if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
      if (rejected.value.error.code === "NOT_FOUND_OR_FORBIDDEN") this.rejectResource("room", roomId);
      else this.store.setError("SYNC_REJECTED");
      throw new BrowserTransportError("REQUEST_REJECTED", rejected.value.error.code);
    }
    const unchanged = parseSyncUnchangedResponse(reply.body);
    if (unchanged.ok) {
      const cached = this.getSnapshot().rooms[roomId];
      if (request.acceptUnchanged === true && unchanged.value.requestId === request.requestId &&
          "roomId" in unchanged.value && unchanged.value.roomId === roomId && unchanged.value.version === request.knownVersion &&
          cached?.version === request.knownVersion) {
        this.store.setError(null);
        const response = this.roomResponseFromCache(request.requestId, roomId, cached);
        this.trackRoomMatch(roomId, response.room.activeMatchId);
        if (response.room.activeMatchId && syncActiveMatch) void this.syncMatch(response.room.activeMatchId).catch(() => undefined);
        return response;
      }
      if (!allowUnchanged) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      return this.performRoomSync(roomId, syncActiveMatch, false);
    }
    const parsed = parseRoomSyncResponse(reply.body);
    if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.roomId !== roomId ||
        !this.store.isCurrentViewer(parsed.value.room.viewer.playerId)) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (this.unavailableRoomIds.has(roomId)) throw new BrowserTransportError("REQUEST_REJECTED");
    this.store.applyRoomSync(parsed.value);
    if (parsed.value.room.status === "closed") {
      this.closedRoomIds.add(roomId);
      this.reconcileRoomResource(roomId);
    }
    const latest = this.getSnapshot().rooms[roomId];
    const activeMatchId = latest?.room.activeMatchId ?? parsed.value.room.activeMatchId;
    this.trackRoomMatch(roomId, activeMatchId);
    if (activeMatchId && syncActiveMatch) void this.syncMatch(activeMatchId).catch(() => undefined);
    return latest && latest.version > parsed.value.version
      ? this.roomResponseFromCache(parsed.value.requestId, roomId, latest)
      : parsed.value;
  }

  private async performMatchSync(matchId: string, allowUnchanged = true): Promise<MatchSyncResponse> {
    const current = this.getSnapshot().matches[matchId];
    const request: MatchSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      matchId,
      knownVersion: current?.version ?? 0,
      afterEventSeq: current?.eventSeq ?? 0,
      ...(allowUnchanged && current ? { acceptUnchanged: true } : {}),
    };
    if (!parseMatchSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    const reply = await this.requestJson(`/api/matches/${encodeURIComponent(matchId)}/sync`, "POST", request);
    const rejected = parseSyncRejectedResponse(reply.body);
    if (rejected.ok) {
      if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
      if (rejected.value.error.code === "NOT_FOUND_OR_FORBIDDEN") this.rejectResource("match", matchId);
      else this.store.setError("SYNC_REJECTED");
      throw new BrowserTransportError("REQUEST_REJECTED", rejected.value.error.code);
    }
    const unchanged = parseSyncUnchangedResponse(reply.body);
    if (unchanged.ok) {
      const cached = this.getSnapshot().matches[matchId];
      if (request.acceptUnchanged === true && unchanged.value.requestId === request.requestId &&
          "matchId" in unchanged.value && unchanged.value.matchId === matchId && unchanged.value.version === request.knownVersion &&
          unchanged.value.eventSeq === request.afterEventSeq && cached?.version === request.knownVersion &&
          cached.eventSeq === request.afterEventSeq) {
        this.store.setError(null);
        return this.matchResponseFromCache(request.requestId, matchId, cached);
      }
      if (!allowUnchanged) {
        this.store.setError("INVALID_RESPONSE");
        throw new BrowserTransportError("INVALID_RESPONSE");
      }
      return this.performMatchSync(matchId, false);
    }
    const parsed = parseMatchSyncResponse(reply.body);
    if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.matchId !== matchId ||
        !this.store.isCurrentViewer(parsed.value.snapshot.viewer.playerId)) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    if (this.unavailableMatchIds.has(matchId)) throw new BrowserTransportError("REQUEST_REJECTED");
    this.store.applyMatchSync(parsed.value);
    const latest = this.getSnapshot().matches[matchId];
    return latest && (latest.version > parsed.value.version || latest.eventSeq > parsed.value.eventSeq)
      ? this.matchResponseFromCache(parsed.value.requestId, matchId, latest)
      : parsed.value;
  }

  private async syncAfterConnect(generation: number): Promise<void> {
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
        const response = await this.syncRoom(roomId);
        roomSyncSucceeded.add(roomId);
        if (response.room.status !== "closed" && this.roomIds.has(roomId) && response.room.activeMatchId) activeMatchIds.add(response.room.activeMatchId);
      } catch { /* Keep pending commands until an authoritative sync succeeds. */ }
    }));
    for (const matchId of activeMatchIds) {
      matchTargets.add(matchId);
    }
    const matchSyncSucceeded = new Set<string>();
    await Promise.all([...matchTargets].map(async (matchId) => {
      try {
        await this.syncMatch(matchId);
        matchSyncSucceeded.add(matchId);
      } catch { /* A later reconnect or invalidation will request another sync. */ }
    }));
    if (!this.started || generation !== this.connectionGeneration || this.getSnapshot().connection !== "connected") return;
    for (const entry of pendingCommands) {
      if (entry.roomId && !roomSyncSucceeded.has(entry.roomId) && entry.command.type !== "JOIN") continue;
      if (entry.matchId && !matchSyncSucceeded.has(entry.matchId)) continue;
      void this.attemptPending(entry).catch(() => undefined);
    }
  }

  private handleInvalidation(source: SitesEventSource, event: Event): void {
    if (source !== this.source) return;
    const message = event as EventSourceMessage;
    const cursor = /^(?:0|[1-9]\d*)$/u.test(message.lastEventId) ? Number(message.lastEventId) : NaN;
    if (!Number.isSafeInteger(cursor) || cursor <= this.lastCursor) return;
    let payload: unknown;
    try { payload = JSON.parse(message.data) as unknown; } catch { return; }
    if (!isRecord(payload) || !isText(payload.aggregateId) || !isVersion(payload.version)) return;
    if (payload.kind === "room" && exactKeys(payload, ["kind", "aggregateId", "version"])) {
      this.lastCursor = cursor;
      if (!this.roomIds.has(payload.aggregateId)) return;
      const currentVersion = this.getSnapshot().rooms[payload.aggregateId]?.version ?? -1;
      const latest = this.roomHints.get(payload.aggregateId);
      if (payload.version <= currentVersion || (latest && payload.version <= latest.version)) return;
      this.roomHints.set(payload.aggregateId, { version: payload.version });
      void this.syncRoom(payload.aggregateId).catch(() => undefined);
      return;
    }
    if (payload.kind === "match" && exactKeys(payload, ["kind", "aggregateId", "version", "eventSeq"]) &&
        isVersion(payload.eventSeq)) {
      this.lastCursor = cursor;
      if (!this.matchIds.has(payload.aggregateId)) return;
      const current = this.getSnapshot().matches[payload.aggregateId];
      const latest = this.matchHints.get(payload.aggregateId);
      const currentVersion = current?.version ?? -1;
      const currentEventSeq = current?.eventSeq ?? -1;
      if (payload.version < currentVersion ||
          (payload.version === currentVersion && payload.eventSeq <= currentEventSeq) ||
          (latest !== undefined && (payload.version < latest.version ||
            (payload.version === latest.version && payload.eventSeq <= (latest.eventSeq ?? -1))))) return;
      this.recordMatchHint(payload.aggregateId, { version: payload.version, eventSeq: payload.eventSeq });
      void this.syncMatch(payload.aggregateId).catch(() => undefined);
    }
  }

  private handlePresence(source: SitesEventSource, event: Event): void {
    if (source !== this.source) return;
    const message = event as EventSourceMessage;
    let payload: unknown;
    try { payload = JSON.parse(message.data) as unknown; } catch { return; }
    const parsed = parseRoomPresenceView(payload);
    if (!parsed.ok || !this.roomIds.has(parsed.value.roomId)) return;
    this.store.applyRoomPresence(parsed.value);
  }

  private openEventStream(): void {
    if (!this.started || this.sessionExpired || !this.isVisible() ||
        this.getSnapshot().authenticated !== true || this.roomIds.size + this.matchIds.size === 0) return;
    const resources = [...new Set([...this.roomIds, ...this.matchIds])].sort().slice(0, 32);
    const resourceKey = JSON.stringify(resources);
    if (this.source !== null && this.sourceResources === resourceKey) return;
    if (this.source !== null) { this.closeEventStream(); this.connectionGeneration++; }
    this.clearReconnectTimer();
    let source: SitesEventSource;
    try {
      const query = new URLSearchParams({ after: String(this.lastCursor) });
      resources.forEach(id => query.append("resource", id));
      source = this.eventSourceFactory(`/api/notifications/events?${query}`, { withCredentials: true });
    } catch {
      this.store.setConnection("disconnected", this.getSnapshot().authenticated);
      this.scheduleFallbackPoll();
      this.scheduleReconnect();
      return;
    }
    this.source = source;
    this.sourceResources = resourceKey;
    source.addEventListener("invalidation", (event) => this.handleInvalidation(source, event));
    source.addEventListener("presence", (event) => this.handlePresence(source, event));
    source.onopen = () => {
      if (source !== this.source || !this.started) return;
      this.clearFallbackPoll();
      this.reconnectDelayMs = 250;
      const generation = ++this.connectionGeneration;
      this.store.setConnection("connected", true);
      void this.syncAfterConnect(generation);
    };
    source.onerror = () => {
      if (source !== this.source) return;
      if (source.readyState === EVENT_SOURCE_CONNECTING) {
        this.store.setConnection("disconnected", this.getSnapshot().authenticated);
        this.scheduleFallbackPoll();
        return;
      }
      if (source.readyState === EVENT_SOURCE_CLOSED) {
        this.closeEventStream();
        this.store.setConnection("disconnected", this.getSnapshot().authenticated);
        this.scheduleFallbackPoll();
        this.scheduleReconnect();
      }
    };
  }

  private clearFallbackPoll(): void {
    if (this.fallbackTimer !== null) clearTimeout(this.fallbackTimer);
    this.fallbackTimer = null;
  }

  private scheduleFallbackPoll(): void {
    if (this.fallbackTimer !== null || !this.started || !this.isVisible() || this.sessionExpired ||
        this.getSnapshot().authenticated !== true || this.roomIds.size + this.matchIds.size === 0) return;
    this.fallbackTimer = setTimeout(() => {
      this.fallbackTimer = null;
      if (!this.started || !this.isVisible() || this.sessionExpired) return;
      void Promise.allSettled([
        ...[...this.roomIds].map(id => this.syncRoom(id)),
        ...[...this.matchIds].map(id => this.syncMatch(id)),
      ]).then(() => {
        if (this.getSnapshot().connection !== "connected") this.scheduleFallbackPoll();
      });
    }, this.fallbackPollIntervalMs);
  }

  private scheduleReconnect(): void {
    if (!this.started || !this.isVisible() || this.sessionExpired || this.reconnectTimer !== null ||
        this.getSnapshot().authenticated !== true || this.roomIds.size + this.matchIds.size === 0) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(MAX_RECONNECT_DELAY_MS, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openEventStream();
    }, delay);
  }

  private closeEventStream(): void {
    const source = this.source;
    this.source = null;
    this.sourceResources = "";
    source?.close();
  }

  private ensureEventStream(): void {
    const hasResources = this.roomIds.size + this.matchIds.size > 0;
    if (!this.started || this.sessionExpired || !this.isVisible() ||
        this.getSnapshot().authenticated !== true || !hasResources) {
      this.clearReconnectTimer();
      this.clearFallbackPoll();
      if (!hasResources || this.getSnapshot().authenticated !== true || this.sessionExpired) this.closeEventStream();
      return;
    }
    this.openEventStream();
  }

  private reconcileRoomResource(roomId: string): void {
    const retained = this.roomWatchCounts.has(roomId) && !this.unavailableRoomIds.has(roomId) && !this.closedRoomIds.has(roomId);
    if (retained) this.roomIds.add(roomId);
    else {
      this.roomIds.delete(roomId);
      this.confirmedRoomIds.delete(roomId);
      this.clearSyncRetry("room", roomId);
      this.roomHints.delete(roomId);
      this.roomMutationGenerations.delete(roomId);
      const matchId = this.roomMatchIds.get(roomId);
      this.roomMatchIds.delete(roomId);
      if (matchId) this.reconcileMatchResource(matchId);
    }
    this.ensureEventStream();
  }

  private reconcileMatchResource(matchId: string): void {
    const isReferencedByRoom = [...this.roomMatchIds].some(([roomId, roomMatchId]) =>
      roomMatchId === matchId && this.roomIds.has(roomId));
    const retained = (this.matchWatchCounts.has(matchId) || isReferencedByRoom) && !this.unavailableMatchIds.has(matchId);
    if (retained) this.matchIds.add(matchId);
    else {
      this.matchIds.delete(matchId);
      this.confirmedMatchIds.delete(matchId);
      this.clearSyncRetry("match", matchId);
      this.matchHints.delete(matchId);
    }
    this.ensureEventStream();
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
    if (previous) {
      const referencedElsewhere = [...this.roomMatchIds.values()].includes(previous);
      if (!referencedElsewhere && !this.recoveredMatchIds.has(previous) && !this.matchWatchCounts.has(previous)) {
        this.confirmedMatchIds.delete(previous);
      }
      this.reconcileMatchResource(previous);
    }
    if (matchId) this.reconcileMatchResource(matchId);
  }

  private recordMatchHint(matchId: string, hint: HintCursor): void {
    const previous = this.matchHints.get(matchId);
    if (!previous || hint.version > previous.version ||
        (hint.version === previous.version && (hint.eventSeq ?? -1) > (previous.eventSeq ?? -1))) {
      this.matchHints.set(matchId, hint);
    }
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

  /** Read recovery is independent of the optional SSE connection. */
  private scheduleSyncRetry(kind: "room" | "match", id: string): void {
    const key = `${kind}:${id}`;
    const subscribed = kind === "room" ? this.roomIds.has(id) : this.matchIds.has(id);
    if (!subscribed || !this.started || this.sessionExpired || !this.isVisible() || this.syncRetries.has(key)) return;
    const delay = this.syncRetryDelays.get(key) ?? this.syncRetryIntervalMs;
    this.syncRetryDelays.set(key, Math.min(MAX_RECONNECT_DELAY_MS, delay * 2));
    const timer = setTimeout(() => {
      this.syncRetries.delete(key);
      if (!this.started || this.sessionExpired || !this.isVisible()) return;
      void (kind === "room" ? this.syncRoom(id) : this.syncMatch(id)).catch(() => undefined);
    }, delay);
    this.syncRetries.set(key, { timer, delay });
  }

  private clearSyncRetry(kind: "room" | "match", id: string): void {
    const key = `${kind}:${id}`;
    const retry = this.syncRetries.get(key);
    if (retry) clearTimeout(retry.timer);
    this.syncRetries.delete(key);
    this.syncRetryDelays.delete(key);
  }

  private clearSyncRetries(): void {
    for (const retry of this.syncRetries.values()) clearTimeout(retry.timer);
    this.syncRetries.clear();
    this.syncRetryDelays.clear();
  }

  private roomResponseFromCache(requestId: string, roomId: string, cached: BrowserTransportState["rooms"][string]): RoomSyncResponse {
    return {
      protocolVersion: 1,
      requestId,
      roomId,
      version: cached.version,
      requiresFullSnapshot: cached.requiresFullSnapshot,
      room: cached.room,
    };
  }

  private matchResponseFromCache(requestId: string, matchId: string, cached: BrowserTransportState["matches"][string]): MatchSyncResponse {
    return {
      protocolVersion: 1,
      requestId,
      matchId,
      version: cached.version,
      eventSeq: cached.eventSeq,
      requiresFullSnapshot: cached.requiresFullSnapshot,
      snapshot: cached.snapshot,
      visibleEvents: cached.visibleEvents,
    };
  }

  private installVisibilityListener(): void {
    if (!this.visibilityTarget || this.visibilityListener) return;
    const listener = () => {
      if (!this.started) return;
      if (this.isVisible()) {
        this.store.setConnection("connected", this.getSnapshot().authenticated);
        this.ensureEventStream();
        void this.syncAfterConnect(this.connectionGeneration);
      } else {
        this.clearSyncRetries();
        this.clearReconnectTimer();
        this.clearFallbackPoll();
        this.closeEventStream();
        this.connectionGeneration += 1;
        this.store.setConnection("disconnected", this.getSnapshot().authenticated);
      }
    };
    this.visibilityListener = listener;
    this.visibilityTarget.addEventListener("visibilitychange", listener);
  }

  private removeVisibilityListener(): void {
    if (!this.visibilityTarget || !this.visibilityListener) return;
    this.visibilityTarget.removeEventListener("visibilitychange", this.visibilityListener);
    this.visibilityListener = undefined;
  }

  private isVisible(): boolean {
    return !this.visibilityTarget || this.visibilityTarget.visibilityState !== "hidden";
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private async requestJson(path: string, method: "GET" | "POST", body?: unknown, signal?: AbortSignal): Promise<HttpReply> {
    const controller = new AbortController();
    let rejectAbort: (error: unknown) => void = () => {};
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
    const abort = () => {
      controller.abort();
      rejectAbort(new BrowserTransportError("HTTP_REQUEST_FAILED"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, signal ? this.acknowledgementTimeoutMs : this.readTimeoutMs);
    if (signal?.aborted) abort();
    const init: RequestInit = {
      method, credentials: "include", cache: "no-store", signal: controller.signal,
      ...(method === "POST" ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    };
    try {
      return await Promise.race([aborted, (async (): Promise<HttpReply> => {
        const response = await this.fetcher(path, init);
        if (response.status >= 500) throw new BrowserTransportError("HTTP_REQUEST_FAILED");
        if (response.status === 204) return { status: response.status, body: null };
        let responseBody: unknown;
        try { responseBody = await response.json() as unknown; }
        catch { throw new BrowserTransportError("INVALID_RESPONSE"); }
        return { status: response.status, body: responseBody };
      })()]);
    } catch (error) {
      this.store.setError(error instanceof BrowserTransportError && error.code === "INVALID_RESPONSE" ? "INVALID_RESPONSE" : "CONNECTION");
      throw error instanceof BrowserTransportError ? error : new BrowserTransportError("HTTP_REQUEST_FAILED");
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }


  private isRejectedCommand(input: unknown, commandId: string): input is Extract<CommandAck, { status: "rejected" }> {
    const parsed = parseCommandAck(input);
    return parsed.ok && parsed.value.commandId === commandId && parsed.value.status === "rejected";
  }

  private commandError(input: unknown): BrowserTransportError {
    const parsed = parseCommandAck(input);
    return new BrowserTransportError("REQUEST_REJECTED", parsed.ok && parsed.value.status === "rejected"
      ? parsed.value.error.code
      : "REQUEST_REJECTED");
  }

  private assertResourceId(value: string): void {
    if (!isText(value)) throw new BrowserTransportError("INVALID_RESPONSE", "Invalid resource ID.");
  }

  private updatePendingIds(): void {
    this.store.setPendingCommandIds([...this.pending.keys()]);
  }

  private markSessionExpired(): void {
    this.sessionExpired = true;
    this.clearSyncRetries();
    this.clearFallbackPoll();
    this.clearReconnectTimer();
    this.closeEventStream();
    this.connectionGeneration += 1;
    this.store.setConnection("expired", false);
    this.store.setError("SESSION_EXPIRED");
  }
}

export function createSitesGameTransport(options: SitesGameTransportOptions = {}): SitesGameTransport {
  return new SitesGameTransport(options);
}
