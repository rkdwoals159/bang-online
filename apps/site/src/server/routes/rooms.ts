import type { CommandRejected, RoomCommand, RoomPreviewResponse } from "../../../../../packages/contracts/src/protocol.js";
import { parseRoomCommand, parseRoomPreviewRequest } from "../../../../../packages/contracts/src/validation.js";
import { GuestSessionService } from "../auth/guest-sessions.js";
import {
  HttpBoundaryError,
  configuredCookieName,
  configuredGuestTtl,
  jsonResponse,
  readJsonRequest,
  sameOrigin,
  sessionCredential,
  type HttpServiceOptions,
  type SiteApiEnvironment,
} from "../auth/http.js";
import { D1RoomService, SiteRoomRateLimitError, SiteRoomServiceError } from "../rooms/service.js";

const ROOMS_PATH = "/api/rooms";
const PREVIEW_PATH = `${ROOMS_PATH}/preview`;
const BAD_REQUEST_MESSAGE_KEY = "protocol.badRequest";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandRejected(
  commandId: string,
  code: string,
  options: { currentVersion?: number; retryAfterMs?: number } = {},
): CommandRejected {
  return {
    protocolVersion: 1,
    commandId,
    status: "rejected",
    error: {
      code,
      messageKey: code === "BAD_REQUEST" ? BAD_REQUEST_MESSAGE_KEY : `server.${code.toLowerCase()}`,
      retryable: code === "STALE_VERSION" || code === "RATE_LIMITED",
      ...(options.currentVersion === undefined ? {} : { currentVersion: options.currentVersion }),
      ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
    },
  };
}

function previewRejected(requestId: string, code: "BAD_REQUEST" | "INVITE_INVALID" | "RATE_LIMITED", retryAfterMs?: number): RoomPreviewResponse {
  return {
    protocolVersion: 1,
    requestId,
    status: "rejected",
    error: code === "RATE_LIMITED" ? { code, retryAfterMs: retryAfterMs! } : { code },
  };
}

function commandIdFrom(value: unknown): string | null {
  return isRecord(value) && typeof value.commandId === "string" && value.commandId.length > 0
    ? value.commandId
    : null;
}

function requestIdFrom(value: unknown): string | null {
  return isRecord(value) && typeof value.requestId === "string" && value.requestId.length > 0
    ? value.requestId
    : null;
}

function roomError(error: unknown, commandId: string): Response {
  if (error instanceof SiteRoomRateLimitError) {
    return jsonResponse(commandRejected(commandId, error.code, { retryAfterMs: error.retryAfterMs }));
  }
  if (error instanceof SiteRoomServiceError) {
    return jsonResponse(commandRejected(commandId, error.code, { currentVersion: error.currentVersion }));
  }
  return jsonResponse(commandRejected(commandId, "INTERNAL_ERROR"), 500);
}

function boundaryError(error: unknown): Response {
  if (error instanceof HttpBoundaryError) return jsonResponse({ error: { code: error.code } }, error.statusCode);
  return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
}

async function authenticatedPlayer(
  request: Request,
  env: SiteApiEnvironment,
  options: HttpServiceOptions,
): Promise<string | null> {
  const service = new GuestSessionService(env.DB, {
    now: options.now,
    guestSessionTtlMs: configuredGuestTtl(env, options),
    crypto: options.crypto,
  });
  const guest = await service.authenticate(sessionCredential(request, configuredCookieName(env, options)));
  return guest?.playerId ?? null;
}

function trustedPeerAddress(request: Request): string {
  // Cloudflare populates this platform header; X-Forwarded-For is deliberately ignored.
  return request.headers.get("CF-Connecting-IP") ?? "";
}

/** Route handler for Sites room preview/create/command endpoints; returns null when unhandled. */
export async function handleRoomsRoute(
  request: Request,
  env: SiteApiEnvironment,
  options: HttpServiceOptions = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const commandPath = path.match(/^\/api\/rooms\/([^/]+)\/commands$/u);
  const invitePath = path.match(/^\/api\/rooms\/([^/]+)\/invite$/u);
  if (path !== ROOMS_PATH && path !== PREVIEW_PATH && !commandPath && !invitePath) return null;

  if (request.method !== "POST") {
    const allow = "POST";
    return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: allow });
  }
  if (path !== PREVIEW_PATH && !sameOrigin(request)) return jsonResponse({ error: { code: "BAD_ORIGIN" } }, 403);

  let body: unknown;
  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return boundaryError(error);
  }

  if (path === PREVIEW_PATH) {
    const parsed = parseRoomPreviewRequest(body);
    if (!parsed.ok) {
      const requestId = requestIdFrom(body);
      return requestId
        ? jsonResponse(previewRejected(requestId, "BAD_REQUEST"))
        : jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
    }
    try {
      const playerId = await authenticatedPlayer(request, env, options);
      if (!playerId) return jsonResponse({ error: { code: "SESSION_EXPIRED" } }, 401);
      const response = await new D1RoomService(env.DB, options).previewInvite(
        playerId,
        parsed.value.requestId,
        parsed.value.inviteCode,
        trustedPeerAddress(request),
      );
      return jsonResponse(response);
    } catch (error) {
      if (error instanceof SiteRoomServiceError) return jsonResponse(previewRejected(parsed.value.requestId, "INVITE_INVALID"));
      return boundaryError(error);
    }
  }

  if (invitePath) {
    if (!isRecord(body) || Object.keys(body).length !== 2 || body.protocolVersion !== 1 ||
        !Number.isSafeInteger(body.expectedVersion) || (body.expectedVersion as number) < 0) {
      return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
    }
    try {
      const playerId = await authenticatedPlayer(request, env, options);
      if (!playerId) return jsonResponse({ error: { code: "SESSION_EXPIRED" } }, 401);
      const roomId = decodeURIComponent(invitePath[1]!);
      const result = await new D1RoomService(env.DB, options).reissueInvite(playerId, roomId, body.expectedVersion as number);
      return jsonResponse({ roomId: result.roomId, version: result.version, inviteCode: result.inviteCode, duplicate: false });
    } catch (error) {
      if (error instanceof SiteRoomServiceError) return jsonResponse({ error: { code: error.code } },
        error.code === "STALE_VERSION" ? 409 : 403);
      if (error instanceof URIError) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
      return boundaryError(error);
    }
  }

  const parsed = parseRoomCommand(body);
  const commandId = commandIdFrom(body);
  if (!parsed.ok) {
    return commandId
      ? jsonResponse(commandRejected(commandId, "BAD_REQUEST"))
      : jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
  }
  try {
    const playerId = await authenticatedPlayer(request, env, options);
    if (!playerId) {
      return commandId
        ? jsonResponse(commandRejected(commandId, "UNAUTHENTICATED"), 401)
        : jsonResponse({ error: { code: "UNAUTHENTICATED" } }, 401);
    }
    const service = new D1RoomService(env.DB, options);

    if (path === ROOMS_PATH) {
      if (parsed.value.type !== "CREATE_ROOM") return jsonResponse(commandRejected(parsed.value.commandId, "BAD_REQUEST"));
      const result = await service.createPrivateRoom(playerId, {
        capacity: parsed.value.payload.capacity,
        rulesetVersion: parsed.value.payload.rulesetVersion,
        commandId: parsed.value.commandId,
      });
      if (!result.room) return jsonResponse(commandRejected(parsed.value.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      return jsonResponse({
        roomId: result.roomId,
        version: result.version,
        inviteCode: result.inviteCode,
        duplicate: result.duplicate,
      });
    }

    if (!commandPath) return null;
    let pathRoomId: string;
    try {
      pathRoomId = decodeURIComponent(commandPath[1]!);
    } catch {
      return jsonResponse(commandRejected(parsed.value.commandId, "BAD_REQUEST"));
    }
    if (parsed.value.type === "CREATE_ROOM" || parsed.value.roomId !== pathRoomId) {
      return jsonResponse(commandRejected(parsed.value.commandId, "BAD_REQUEST"));
    }
    const command = parsed.value as Exclude<RoomCommand, { type: "CREATE_ROOM" }>;

    switch (command.type) {
      case "JOIN": {
        const room = await service.joinPrivateRoom(playerId, {
          roomId: command.roomId,
          expectedVersion: command.expectedVersion,
          commandId: command.commandId,
          inviteCode: command.payload.inviteCode,
        }, trustedPeerAddress(request));
        return room
          ? jsonResponse(room)
          : jsonResponse(commandRejected(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      case "SET_READY": {
        const room = await service.setReady(playerId, {
          roomId: command.roomId,
          expectedVersion: command.expectedVersion,
          commandId: command.commandId,
          ready: command.payload.ready,
        });
        return room
          ? jsonResponse(room)
          : jsonResponse(commandRejected(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      case "START_MATCH": {
        const result = await service.startMatch(playerId, command);
        return result.room
          ? jsonResponse(result.room)
          : jsonResponse(commandRejected(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      case "RETURN_TO_LOBBY": {
        const room = await service.returnToLobby(playerId, command);
        return room
          ? jsonResponse(room)
          : jsonResponse(commandRejected(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      case "CLOSE_ROOM": {
        const room = await service.closeRoom(playerId, command);
        return room
          ? jsonResponse(room)
          : jsonResponse(commandRejected(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      case "KICK_MEMBER": {
        const room = await service.kickMember(playerId, { ...command, targetPlayerId: command.payload.targetPlayerId });
        return room ? jsonResponse(room) : jsonResponse(commandRejected(command.commandId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      case "SET_RULESET": {
        const code = await service.unsupportedRoomCommand(playerId, command.roomId, command.type);
        return jsonResponse(commandRejected(command.commandId, code));
      }
    }
  } catch (error) {
    if (error instanceof SiteRoomRateLimitError && commandId) return roomError(error, commandId);
    const actualCommandId = parsed.ok ? parsed.value.commandId : commandId;
    if (actualCommandId) return roomError(error, actualCommandId);
    return boundaryError(error);
  }
}

