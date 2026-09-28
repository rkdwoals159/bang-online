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
  parseRoomSyncRequest,
  parseRoomSyncResponse,
  parseRoomView,
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
  readonly store = new BrowserTransportStore();
  private readonly fetcher: Fetcher;
  private readonly eventSourceFactory: (url: string, init: EventSourceInit) => SitesEventSource;
  private readonly createId: () => string;
  private readonly acknowledgementTimeoutMs: number;
  private readonly visibilityTarget?: SitesGameTransportOptions["visibilityTarget"];
  private readonly roomIds = new Set<string>();
  private readonly matchIds = new Set<string>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly roomSyncs = new Map<string, Promise<RoomSyncResponse>>();
  private readonly matchSyncs = new Map<string, Promise<MatchSyncResponse>>();
  private readonly roomHints = new Map<string, HintCursor>();
  private readonly matchHints = new Map<string, HintCursor>();
  private readonly roomDirty = new Set<string>();
  private readonly matchDirty = new Set<string>();
  private source: SitesEventSource | null = null;
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
    this.visibilityTarget = options.visibilityTarget ?? (typeof document === "undefined" ? undefined : document);
  }

  readonly getSnapshot = (): BrowserTransportState => this.store.getSnapshot();
  readonly subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);

  connect(): void {
    this.started = true;
    if (this.sessionExpired) return;
    this.installVisibilityListener();
    const authenticated = this.store.getSnapshot().authenticated;
    this.store.setConnection(authenticated ? "connected" : "connecting", authenticated);
    if (this.isVisible()) this.openEventStream();
  }

  disconnect(): void {
    this.started = false;
    this.connectionGeneration += 1;
    this.removeVisibilityListener();
    this.clearReconnectTimer();
    this.closeEventStream();
    const authenticated = this.store.getSnapshot().authenticated;
    this.store.setConnection("disconnected", authenticated);
  }

  watchRoom(roomId: string): () => void {
    this.assertResourceId(roomId);
    this.roomIds.add(roomId);
    if (this.started && this.source === null && this.isVisible()) this.openEventStream();
    if (this.getSnapshot().connection === "connected") void this.syncRoom(roomId).catch(() => undefined);
    return () => this.roomIds.delete(roomId);
  }

  watchMatch(matchId: string): () => void {
    this.assertResourceId(matchId);
    this.matchIds.add(matchId);
    if (this.started && this.source === null && this.isVisible()) this.openEventStream();
    if (this.getSnapshot().connection === "connected") void this.syncMatch(matchId).catch(() => undefined);
    return () => this.matchIds.delete(matchId);
  }

  async syncRoom(roomId: string): Promise<RoomSyncResponse> {
    this.assertResourceId(roomId);
    this.roomIds.add(roomId);
    const current = this.roomSyncs.get(roomId);
    if (current) {
      this.roomDirty.add(roomId);
      return current;
    }
    const request = this.performRoomSync(roomId);
    this.roomSyncs.set(roomId, request);
    let response: RoomSyncResponse;
    try {
      response = await request;
    } finally {
      this.roomSyncs.delete(roomId);
    }
    const hint = this.roomHints.get(roomId);
    if (hint && hint.version > (this.getSnapshot().rooms[roomId]?.version ?? -1)) this.roomDirty.add(roomId);
    if (this.roomDirty.delete(roomId)) void this.syncRoom(roomId).catch(() => undefined);
    return response;
  }

  async syncMatch(matchId: string): Promise<MatchSyncResponse> {
    this.assertResourceId(matchId);
    this.matchIds.add(matchId);
    const current = this.matchSyncs.get(matchId);
    if (current) {
      this.matchDirty.add(matchId);
      return current;
    }
    const request = this.performMatchSync(matchId);
    this.matchSyncs.set(matchId, request);
    let response: MatchSyncResponse;
    try {
      response = await request;
    } finally {
      this.matchSyncs.delete(matchId);
    }
    const hint = this.matchHints.get(matchId);
    const projection = this.getSnapshot().matches[matchId];
    if (hint && (hint.version > (projection?.version ?? -1) ||
        (hint.version === projection?.version && (hint.eventSeq ?? 0) > (projection?.eventSeq ?? -1)))) {
      this.matchDirty.add(matchId);
    }
    if (this.matchDirty.delete(matchId)) void this.syncMatch(matchId).catch(() => undefined);
    return response;
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
    this.restoredPlayerId = reply.body.player.playerId;
    this.store.setConnection(this.getSnapshot().connection, true);
    return reply.body;
  }

  async restoreGuestSession(): Promise<GuestSessionResponse | null> {
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
    this.restoredPlayerId = reply.body.player.playerId;
    this.store.setConnection(this.getSnapshot().connection, true);
    return reply.body;
  }

  async recoverAssignedSeats(): Promise<readonly RoomView[]> {
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
      this.roomIds.add(parsed.value.roomId);
      if (parsed.value.activeMatchId) this.matchIds.add(parsed.value.activeMatchId);
    }

    if (this.getSnapshot().connection === "connected") {
      await Promise.all(rooms.map((room) => this.syncRoom(room.roomId)));
      const activeMatchIds = new Set(rooms.flatMap((room) => {
        const id = this.getSnapshot().rooms[room.roomId]?.room.activeMatchId ?? room.activeMatchId;
        return id ? [id] : [];
      }));
      await Promise.all([...activeMatchIds].map((matchId) => this.syncMatch(matchId)));
      return rooms.map((room) => this.getSnapshot().rooms[room.roomId]?.room ?? room);
    }
    return rooms;
  }

  async createRoom(command: Extract<RoomCommand, { type: "CREATE_ROOM" }>): Promise<RoomEntryCreateResult> {
    const response = await this.sendRoomCommand(command);
    if (this.isRejectedCommand(response, command.commandId)) throw this.commandError(response);
    if (!isRoomCreateResult(response)) throw new BrowserTransportError("INVALID_RESPONSE");
    this.roomIds.add(response.roomId);
    if (this.started && this.source === null && this.isVisible()) this.openEventStream();
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

  async joinRoom(command: Extract<RoomCommand, { type: "JOIN" }>): Promise<RoomView> {
    const response = await this.sendRoomCommand(command);
    if (this.isRejectedCommand(response, command.commandId)) throw this.commandError(response);
    const parsed = parseRoomView(response);
    if (!parsed.ok || parsed.value.roomId !== command.roomId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.roomIds.add(command.roomId);
    if (this.started && this.source === null && this.isVisible()) this.openEventStream();
    void this.syncRoom(command.roomId).catch(() => undefined);
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
      if (scope.roomId) this.roomIds.add(scope.roomId);
      if (scope.matchId) this.matchIds.add(scope.matchId);
      this.pending.set(commandId, pending);
      this.updatePendingIds();
    }
    return this.attemptPending(pending);
  }

  private attemptPending(pending: PendingCommand): Promise<unknown> {
    if (pending.active) return pending.active;
    if (this.getSnapshot().connection !== "connected") {
      return Promise.reject(new BrowserTransportError("NOT_CONNECTED"));
    }
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
    this.pending.delete(pending.commandId);
    this.updatePendingIds();
    const accepted = !ack.ok || ack.value.status === "accepted";
    if (accepted && pending.roomId) void this.syncRoom(pending.roomId).catch(() => undefined);
    if (accepted && pending.matchId) void this.syncMatch(pending.matchId).catch(() => undefined);
    return response;
  }

  private async performRoomSync(roomId: string, syncActiveMatch = true): Promise<RoomSyncResponse> {
    const current = this.getSnapshot().rooms[roomId];
    const request: RoomSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      roomId,
      knownVersion: current?.version ?? 0,
    };
    if (!parseRoomSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    const reply = await this.requestJson(`/api/rooms/${encodeURIComponent(roomId)}/sync`, "POST", request);
    const rejected = parseSyncRejectedResponse(reply.body);
    if (rejected.ok) {
      if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
      this.store.setError("SYNC_REJECTED");
      throw new BrowserTransportError("REQUEST_REJECTED", rejected.value.error.code);
    }
    const parsed = parseRoomSyncResponse(reply.body);
    if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.roomId !== roomId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.store.applyRoomSync(parsed.value);
    if (parsed.value.room.activeMatchId) {
      this.matchIds.add(parsed.value.room.activeMatchId);
      if (syncActiveMatch) void this.syncMatch(parsed.value.room.activeMatchId).catch(() => undefined);
    }
    return parsed.value;
  }

  private async performMatchSync(matchId: string): Promise<MatchSyncResponse> {
    const current = this.getSnapshot().matches[matchId];
    const request: MatchSyncRequest = {
      protocolVersion: 1,
      requestId: this.createId(),
      matchId,
      knownVersion: current?.version ?? 0,
      afterEventSeq: current?.eventSeq ?? 0,
    };
    if (!parseMatchSyncRequest(request).ok) throw new BrowserTransportError("INVALID_RESPONSE");
    const reply = await this.requestJson(`/api/matches/${encodeURIComponent(matchId)}/sync`, "POST", request);
    const rejected = parseSyncRejectedResponse(reply.body);
    if (rejected.ok) {
      if (rejected.value.requestId !== request.requestId) throw new BrowserTransportError("INVALID_RESPONSE");
      this.store.setError("SYNC_REJECTED");
      throw new BrowserTransportError("REQUEST_REJECTED", rejected.value.error.code);
    }
    const parsed = parseMatchSyncResponse(reply.body);
    if (!parsed.ok || parsed.value.requestId !== request.requestId || parsed.value.matchId !== matchId) {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    this.store.applyMatchSync(parsed.value);
    return parsed.value;
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
        const response = await this.performRoomSync(roomId, false);
        roomSyncSucceeded.add(roomId);
        if (response.room.activeMatchId) activeMatchIds.add(response.room.activeMatchId);
      } catch { /* Keep pending commands until an authoritative sync succeeds. */ }
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
      } catch { /* A later reconnect or invalidation will request another sync. */ }
    }));
    if (!this.started || generation !== this.connectionGeneration || this.getSnapshot().connection !== "connected") return;
    for (const entry of pendingCommands) {
      if (entry.roomId && !roomSyncSucceeded.has(entry.roomId)) continue;
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
      if (this.roomSyncs.has(payload.aggregateId)) this.roomDirty.add(payload.aggregateId);
      else void this.syncRoom(payload.aggregateId).catch(() => undefined);
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
      this.matchHints.set(payload.aggregateId, { version: payload.version, eventSeq: payload.eventSeq });
      if (this.matchSyncs.has(payload.aggregateId)) this.matchDirty.add(payload.aggregateId);
      else void this.syncMatch(payload.aggregateId).catch(() => undefined);
    }
  }

  private openEventStream(): void {
    if (!this.started || this.sessionExpired || !this.isVisible() || this.source !== null) return;
    this.clearReconnectTimer();
    const source = this.eventSourceFactory(`/api/notifications/events?after=${this.lastCursor}`, { withCredentials: true });
    this.source = source;
    source.addEventListener("invalidation", (event) => this.handleInvalidation(source, event));
    source.onopen = () => {
      if (source !== this.source || !this.started) return;
      this.reconnectDelayMs = 250;
      const generation = ++this.connectionGeneration;
      this.store.setConnection("connected", true);
      void this.syncAfterConnect(generation);
    };
    source.onerror = () => {
      if (source !== this.source) return;
      if (source.readyState === EVENT_SOURCE_CONNECTING) {
        this.store.setConnection("disconnected", this.getSnapshot().authenticated);
        return;
      }
      if (source.readyState === EVENT_SOURCE_CLOSED) {
        this.closeEventStream();
        this.store.setConnection("disconnected", this.getSnapshot().authenticated);
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (!this.started || !this.isVisible() || this.sessionExpired || this.reconnectTimer !== null) return;
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
    source?.close();
  }

  private installVisibilityListener(): void {
    if (!this.visibilityTarget || this.visibilityListener) return;
    const listener = () => {
      if (!this.started) return;
      if (this.isVisible()) {
        this.store.setConnection("connecting", this.getSnapshot().authenticated);
        this.openEventStream();
      } else {
        this.clearReconnectTimer();
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
    const init: RequestInit = {
      method,
      credentials: "include",
      cache: "no-store",
      ...(method === "POST" ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      } : {}),
      ...(signal ? { signal } : {}),
    };
    let response: Response;
    try {
      response = await this.fetcher(path, init);
    } catch {
      this.store.setError("CONNECTION");
      throw new BrowserTransportError("HTTP_REQUEST_FAILED");
    }
    if (response.status === 204) return { status: response.status, body: null };
    let responseBody: unknown;
    try {
      responseBody = await response.json() as unknown;
    } catch {
      this.store.setError("INVALID_RESPONSE");
      throw new BrowserTransportError("INVALID_RESPONSE");
    }
    return { status: response.status, body: responseBody };
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
