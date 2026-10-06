import type {
  CommandAck,
  MatchCommand,
  MatchSyncRequest,
  MatchHistoryRequest,
  RoomPreviewResponse,
  RoomCommand,
  RoomSyncRequest,
  SyncRejectedResponse,
} from "../../../../packages/contracts/src/protocol.js";
import {
  parseMatchCommand,
  parseMatchSyncRequest,
  parseMatchHistoryRequest,
  parseRoomCommand,
  parseRoomPreviewRequest,
  parseRoomSyncRequest,
} from "../../../../packages/contracts/src/validation.js";
import type { RoomService } from "../rooms/service.js";
import { InviteRateLimiter, type InviteLookupOutcome } from "./invite-rate-limiter.js";

export interface SocketHeaderHandshake {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** Raw peer address supplied by Socket.IO; forwarded headers are not trusted. */
  readonly address?: string;
}

/** The subset of a Socket.IO socket used by the gateway. */
export interface GatewaySocket {
  readonly handshake: SocketHeaderHandshake;
  readonly data: Record<string, unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  onAny(listener: (eventName: string, ...args: unknown[]) => void): unknown;
  join(channel: string): void | Promise<void>;
  disconnect(close?: boolean): void;
}

/** The subset of a Socket.IO server used by the gateway. */
export interface GatewayIo {
  use(middleware: (socket: GatewaySocket, next: (error?: Error) => void) => void): unknown;
  on(event: "connection", listener: (socket: GatewaySocket) => void): unknown;
}

export type GatewayAck = (response: unknown) => void;
export type RoomServiceForGateway = Pick<RoomService, "authenticateGuestCredential" | "roomViewForMember" | "previewInvite">;
export type MatchMembershipAuthorizer = (playerId: string, matchId: string) => Promise<boolean>;

export interface AuthenticatedSocketContext {
  readonly socket: GatewaySocket;
  readonly playerId: string;
  /** Recheck membership at the current request boundary. */
  roomMembership(roomId: string): ReturnType<RoomServiceForGateway["roomViewForMember"]>;
  matchMembership(matchId: string): Promise<boolean>;
  /** Join only after a fresh server-side membership lookup succeeds. */
  joinLobbyChannel(roomId: string): Promise<boolean>;
  joinMatchChannel(matchId: string): Promise<boolean>;
}

export interface GatewayHandlers {
  roomCreate(
    context: AuthenticatedSocketContext,
    command: Extract<RoomCommand, { type: "CREATE_ROOM" }>,
    ack: GatewayAck,
  ): void | Promise<void>;
  roomCommand(
    context: AuthenticatedSocketContext,
    command: Exclude<RoomCommand, { type: "CREATE_ROOM" }>,
    ack: GatewayAck,
  ): void | Promise<void>;
  matchCommand(context: AuthenticatedSocketContext, command: MatchCommand, ack: GatewayAck): void | Promise<void>;
  roomSync(context: AuthenticatedSocketContext, request: RoomSyncRequest, ack: GatewayAck): void | Promise<void>;
  matchSync(context: AuthenticatedSocketContext, request: MatchSyncRequest, ack: GatewayAck): void | Promise<void>;
  matchHistory?(context: AuthenticatedSocketContext, request: MatchHistoryRequest, ack: GatewayAck): void | Promise<void>;
  /** Disconnect is connection presence only; this hook must not remove a seat or mutate match state. */
  disconnected?(playerId: string, reason: string): void | Promise<void>;
}

export interface SocketGatewayOptions {
  roomService: RoomServiceForGateway;
  authorizeMatchMember: MatchMembershipAuthorizer;
  handlers: GatewayHandlers;
  /** Optional deterministic/test limiter. A gateway-scoped limiter is used by default. */
  inviteRateLimiter?: InviteRateLimiter;
  /** Cookie name is deployment configuration; the protocol does not prescribe one. */
  sessionCookieName: string;
}

const AUTHENTICATED_PLAYER_DATA_KEY = "playerId";
const PLAYER_CHANNEL_PREFIX = "player:";
const LOBBY_CHANNEL_PREFIX = "lobby:";
const MATCH_CHANNEL_PREFIX = "match:";
const BAD_REQUEST_MESSAGE_KEY = "protocol.badRequest";
export const CLIENT_PROTOCOL_EVENT_NAMES = Object.freeze([
  "room:create",
  "room:command",
  "match:command",
  "room:sync",
  "match:sync",
  "match:history",
  "room:preview",
] as const);
const CLIENT_EVENT_NAMES = new Set<string>(CLIENT_PROTOCOL_EVENT_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function cookieHeader(headers: SocketHeaderHandshake["headers"]): string | undefined {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "cookie")
    .flatMap(([, value]) => typeof value === "string" ? [value] : value ? [...value] : []);
  if (values.length === 0) return undefined;
  return values.join(";");
}

function cookieCredential(header: string | undefined, cookieName: string): string | undefined {
  if (header === undefined) return undefined;
  const matches: string[] = [];
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== cookieName) continue;
    const raw = part.slice(separator + 1).trim();
    try {
      matches.push(decodeURIComponent(raw));
    } catch {
      return undefined;
    }
  }
  if (matches.length !== 1 || matches[0]!.length === 0) return undefined;
  return matches[0];
}

function playerIdFor(socket: GatewaySocket): string | undefined {
  const playerId = socket.data[AUTHENTICATED_PLAYER_DATA_KEY];
  return isText(playerId) ? playerId : undefined;
}

function commandAck(
  ack: GatewayAck,
  commandId: string,
  code: string,
  messageKey: string,
  retryable = false,
  retryAfterMs?: number,
): void {
  const response: CommandAck = {
    protocolVersion: 1,
    commandId,
    status: "rejected",
    error: { code, messageKey, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) },
  };
  ack(response);
}

function roomPreviewRejectedAck(
  ack: GatewayAck,
  requestId: string,
  code: "BAD_REQUEST" | "INVITE_INVALID" | "RATE_LIMITED",
  retryAfterMs?: number,
): void {
  const response: RoomPreviewResponse = {
    protocolVersion: 1,
    requestId,
    status: "rejected",
    error: code === "RATE_LIMITED"
      ? { code, retryAfterMs: retryAfterMs! }
      : { code },
  };
  ack(response);
}

function syncRejectedAck(
  ack: GatewayAck,
  requestId: string,
  code: SyncRejectedResponse["error"]["code"],
): void {
  const response: SyncRejectedResponse = {
    protocolVersion: 1,
    requestId,
    status: "rejected",
    error: { code },
  };
  ack(response);
}

function ackFrom(args: readonly unknown[]): GatewayAck | undefined {
  const candidate = args.at(-1);
  return typeof candidate === "function" ? candidate as GatewayAck : undefined;
}

function payloadFrom(args: readonly unknown[]): unknown | undefined {
  return args.length === 2 && typeof args[1] === "function" ? args[0] : undefined;
}

function commandIdFrom(input: unknown): string | undefined {
  return isRecord(input) && isText(input.commandId) ? input.commandId : undefined;
}

function requestIdFrom(input: unknown): string | null {
  return isRecord(input) && isText(input.requestId) ? input.requestId : null;
}

function rejectedMalformedCommand(socket: GatewaySocket, args: readonly unknown[]): void {
  const ack = ackFrom(args);
  const commandId = commandIdFrom(args[0]);
  if (!ack || !commandId || args.length !== 2) {
    socket.disconnect(true);
    return;
  }
  commandAck(ack, commandId, "BAD_REQUEST", BAD_REQUEST_MESSAGE_KEY);
}

function validCookieName(name: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name);
}

function createContext(
  socket: GatewaySocket,
  playerId: string,
  options: SocketGatewayOptions,
): AuthenticatedSocketContext {
  const roomMembership: AuthenticatedSocketContext["roomMembership"] = (roomId) =>
    options.roomService.roomViewForMember(roomId, playerId);
  const matchMembership: AuthenticatedSocketContext["matchMembership"] = (matchId) =>
    options.authorizeMatchMember(playerId, matchId);
  const joinLobbyChannel: AuthenticatedSocketContext["joinLobbyChannel"] = async (roomId) => {
    const room = await roomMembership(roomId);
    if (!room || (room.status !== "waiting" && room.status !== "starting")) return false;
    await socket.join(`${LOBBY_CHANNEL_PREFIX}${room.roomId}`);
    return true;
  };
  const joinMatchChannel: AuthenticatedSocketContext["joinMatchChannel"] = async (matchId) => {
    if (!(await matchMembership(matchId))) return false;
    await socket.join(`${MATCH_CHANNEL_PREFIX}${matchId}`);
    return true;
  };
  return { socket, playerId, roomMembership, matchMembership, joinLobbyChannel, joinMatchChannel };
}

function inviteRateLimitKey(socket: GatewaySocket, playerId: string): { peerAddress: string; playerId: string } {
  return {
    // Socket.IO's handshake address is the direct peer. Never consult X-Forwarded-For.
    peerAddress: typeof socket.handshake.address === "string" ? socket.handshake.address : "",
    playerId,
  };
}

function isRoomViewSuccess(response: Record<string, unknown>): boolean {
  const roomStatuses = new Set(["waiting", "starting", "in_game", "paused", "completed", "closed"]);
  if (
    !isText(response.roomId)
    || typeof response.status !== "string"
    || !roomStatuses.has(response.status)
    || !(response.activeMatchId === null || isText(response.activeMatchId))
    || !isText(response.ownerPlayerId)
    || ![4, 5, 6, 7].includes(response.capacity as number)
    || !isText(response.rulesetVersion)
    || !Array.isArray(response.members)
    || !isRecord(response.viewer)
    || !isText(response.viewer.playerId)
    || typeof response.viewer.isOwner !== "boolean"
  ) {
    return false;
  }
  return response.members.every((member) =>
    isRecord(member)
    && isText(member.playerId)
    && typeof member.displayName === "string"
    && Number.isSafeInteger(member.seatIndex)
    && (member.seatIndex as number) >= 0
    && typeof member.ready === "boolean"
  );
}

function isAcceptedCommandAck(response: Record<string, unknown>, commandId: string): boolean {
  const expectedKeys = ["aggregateVersion", "commandId", "duplicate", "eventSeq", "protocolVersion", "status"];
  return Object.keys(response).sort().join("\0") === expectedKeys.join("\0")
    && response.protocolVersion === 1
    && response.commandId === commandId
    && response.status === "accepted"
    && typeof response.duplicate === "boolean"
    && Number.isSafeInteger(response.aggregateVersion)
    && (response.aggregateVersion as number) >= 0
    && Number.isSafeInteger(response.eventSeq)
    && (response.eventSeq as number) >= 0;
}

function joinInviteOutcome(response: unknown, commandId: string): InviteLookupOutcome {
  if (!isRecord(response)) return "neutral";
  if (response.status === "rejected" && isRecord(response.error)) {
    return response.error.code === "INVALID_INVITE" || response.error.code === "INVITE_INVALID"
      ? "invalid"
      : "neutral";
  }
  return isRoomViewSuccess(response) || isAcceptedCommandAck(response, commandId)
    ? "join-success"
    : "neutral";
}

function normalizeInvalidJoinAck(response: unknown): unknown {
  if (!isRecord(response) || response.status !== "rejected" || !isRecord(response.error)) return response;
  if (response.error.code !== "INVALID_INVITE") return response;
  return { ...response, error: { ...response.error, code: "INVITE_INVALID" } };
}

function contextFor(socket: GatewaySocket, options: SocketGatewayOptions): AuthenticatedSocketContext | undefined {
  const playerId = playerIdFor(socket);
  return playerId ? createContext(socket, playerId, options) : undefined;
}

function invoke(socket: GatewaySocket, operation: () => void | Promise<void>): void {
  try {
    void Promise.resolve(operation()).catch(() => socket.disconnect(true));
  } catch {
    socket.disconnect(true);
  }
}

function bindSocket(socket: GatewaySocket, options: SocketGatewayOptions, inviteRateLimiter: InviteRateLimiter): void {
  const context = contextFor(socket, options);
  if (!context) {
    socket.disconnect(true);
    return;
  }

  try {
    void Promise.resolve(socket.join(`${PLAYER_CHANNEL_PREFIX}${context.playerId}`)).catch(() => socket.disconnect(true));
  } catch {
    socket.disconnect(true);
    return;
  }

  socket.onAny((eventName) => {
    if (!CLIENT_EVENT_NAMES.has(eventName)) socket.disconnect(true);
  });

  socket.on("room:create", (...args) => {
    const ack = ackFrom(args);
    const payload = payloadFrom(args);
    const parsed = parseRoomCommand(payload);
    if (!ack || !parsed.ok || parsed.value.type !== "CREATE_ROOM") {
      rejectedMalformedCommand(socket, args);
      return;
    }
    const command = parsed.value as Extract<RoomCommand, { type: "CREATE_ROOM" }>;
    invoke(socket, () => options.handlers.roomCreate(context, command, ack));
  });

  socket.on("room:command", (...args) => {
    const ack = ackFrom(args);
    const payload = payloadFrom(args);
    const parsed = parseRoomCommand(payload);
    if (!ack || !parsed.ok || parsed.value.type === "CREATE_ROOM") {
      rejectedMalformedCommand(socket, args);
      return;
    }
    const command = parsed.value as Exclude<RoomCommand, { type: "CREATE_ROOM" }>;
    invoke(socket, async () => {
      // A JOIN is the one room command that must start without membership; T44 verifies invite and version.
      if (command.type !== "JOIN" && !(await context.roomMembership(command.roomId))) {
        commandAck(ack, command.commandId, "NOT_FOUND_OR_FORBIDDEN", "room.notFoundOrForbidden");
        return;
      }
      if (command.type !== "JOIN") {
        await options.handlers.roomCommand(context, command, ack);
        return;
      }

      const reservation = inviteRateLimiter.reserve(inviteRateLimitKey(socket, context.playerId));
      if (!reservation.allowed) {
        commandAck(ack, command.commandId, "RATE_LIMITED", "server.rate_limited", true, reservation.retryAfterMs);
        return;
      }

      let completed = false;
      const joinAck: GatewayAck = (response) => {
        if (completed) return;
        completed = true;
        reservation.complete(joinInviteOutcome(response, command.commandId));
        ack(normalizeInvalidJoinAck(response));
      };
      try {
        await options.handlers.roomCommand(context, command, joinAck);
      } finally {
        if (!completed) reservation.complete("neutral");
      }
    });
  });

  socket.on("match:command", (...args) => {
    const ack = ackFrom(args);
    const payload = payloadFrom(args);
    const parsed = parseMatchCommand(payload);
    if (!ack || !parsed.ok) {
      rejectedMalformedCommand(socket, args);
      return;
    }
    invoke(socket, async () => {
      if (!(await context.matchMembership(parsed.value.matchId))) {
        commandAck(ack, parsed.value.commandId, "NOT_A_PLAYER", "match.notAPlayer");
        return;
      }
      await options.handlers.matchCommand(context, parsed.value, ack);
    });
  });

  socket.on("room:sync", (...args) => {
    const ack = ackFrom(args);
    const payload = args[0];
    const requestId = requestIdFrom(payload);
    const parsed = parseRoomSyncRequest(payload);
    if (!ack || requestId === null) {
      socket.disconnect(true);
      return;
    }
    if (args.length !== 2 || !parsed.ok) {
      syncRejectedAck(ack, requestId, "BAD_REQUEST");
      return;
    }
    invoke(socket, async () => {
      const room = await context.roomMembership(parsed.value.roomId);
      if (!room) {
        syncRejectedAck(ack, parsed.value.requestId, "NOT_FOUND_OR_FORBIDDEN");
        return;
      }
      if ((room.status === "waiting" || room.status === "starting") && !(await context.joinLobbyChannel(room.roomId))) {
        syncRejectedAck(ack, parsed.value.requestId, "NOT_FOUND_OR_FORBIDDEN");
        return;
      }
      await options.handlers.roomSync(context, parsed.value, ack);
    });
  });

  socket.on("match:sync", (...args) => {
    const ack = ackFrom(args);
    const payload = args[0];
    const requestId = requestIdFrom(payload);
    const parsed = parseMatchSyncRequest(payload);
    if (!ack || requestId === null) {
      socket.disconnect(true);
      return;
    }
    if (args.length !== 2 || !parsed.ok) {
      syncRejectedAck(ack, requestId, "BAD_REQUEST");
      return;
    }
    invoke(socket, async () => {
      if (!(await context.joinMatchChannel(parsed.value.matchId))) {
        syncRejectedAck(ack, parsed.value.requestId, "NOT_FOUND_OR_FORBIDDEN");
        return;
      }
      await options.handlers.matchSync(context, parsed.value, ack);
    });
  });

  socket.on("match:history", (...args) => {
    const ack = ackFrom(args), requestId = requestIdFrom(args[0]);
    const parsed = parseMatchHistoryRequest(args[0]);
    if (!ack || requestId === null) { socket.disconnect(true); return; }
    if (args.length !== 2 || !parsed.ok) { syncRejectedAck(ack, requestId, "BAD_REQUEST"); return; }
    invoke(socket, async () => {
      if (!await context.matchMembership(parsed.value.matchId)) { syncRejectedAck(ack, requestId, "NOT_FOUND_OR_FORBIDDEN"); return; }
      if (!options.handlers.matchHistory) { syncRejectedAck(ack, requestId, "RECOVERY_REQUIRED"); return; }
      await options.handlers.matchHistory(context, parsed.value, ack);
    });
  });

  socket.on("room:preview", (...args) => {
    const ack = ackFrom(args);
    const payload = args[0];
    const requestId = requestIdFrom(payload);
    const parsed = parseRoomPreviewRequest(payload);
    if (!ack || requestId === null) {
      socket.disconnect(true);
      return;
    }
    if (args.length !== 2 || !parsed.ok) {
      roomPreviewRejectedAck(ack, requestId, "BAD_REQUEST");
      return;
    }
    invoke(socket, async () => {
      const reservation = inviteRateLimiter.reserve(inviteRateLimitKey(socket, context.playerId));
      if (!reservation.allowed) {
        roomPreviewRejectedAck(ack, parsed.value.requestId, "RATE_LIMITED", reservation.retryAfterMs);
        return;
      }

      let completed = false;
      const complete = (outcome: InviteLookupOutcome) => {
        if (completed) return;
        completed = true;
        reservation.complete(outcome);
      };
      try {
        const preview = await options.roomService.previewInvite(parsed.value.inviteCode);
        if (!preview) {
          complete("invalid");
          roomPreviewRejectedAck(ack, parsed.value.requestId, "INVITE_INVALID");
          return;
        }
        // A successful preview frees a concurrent lookup reservation but preserves failures.
        complete("neutral");
        const response: RoomPreviewResponse = {
          protocolVersion: 1,
          requestId: parsed.value.requestId,
          roomId: preview.roomId,
          version: preview.version,
          occupancy: preview.occupancy,
          status: preview.status,
        };
        ack(response);
      } finally {
        if (!completed) complete("neutral");
      }
    });
  });
  socket.on("disconnect", (...args) => {
    const reason = typeof args[0] === "string" ? args[0] : "unknown";
    if (options.handlers.disconnected) invoke(socket, () => options.handlers.disconnected!(context.playerId, reason));
  });
}

/** Install cookie authentication, strict inbound event validation, and membership gates. */
export function installSocketGateway(io: GatewayIo, options: SocketGatewayOptions): void {
  if (!validCookieName(options.sessionCookieName)) throw new TypeError("Invalid session cookie name.");
  const inviteRateLimiter = options.inviteRateLimiter ?? new InviteRateLimiter();

  io.use((socket, next) => {
    delete socket.data[AUTHENTICATED_PLAYER_DATA_KEY];
    const credential = cookieCredential(cookieHeader(socket.handshake.headers), options.sessionCookieName);
    if (!credential) {
      next(new Error("UNAUTHENTICATED"));
      return;
    }
    void options.roomService.authenticateGuestCredential(credential).then((guest) => {
      if (!guest) {
        next(new Error("UNAUTHENTICATED"));
        return;
      }
      socket.data[AUTHENTICATED_PLAYER_DATA_KEY] = guest.playerId;
      next();
    }).catch(() => next(new Error("UNAUTHENTICATED")));
  });

  io.on("connection", (socket) => bindSocket(socket, options, inviteRateLimiter));
}
