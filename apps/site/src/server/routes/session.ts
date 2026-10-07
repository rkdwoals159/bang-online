import type { GuestSessionRequest } from "../../../../../packages/contracts/src/protocol.js";
import { D1RoomService } from "../rooms/service.js";
import { GuestSessionService } from "../auth/guest-sessions.js";
import {
  HttpBoundaryError,
  configuredCookieName,
  configuredGuestTtl,
  emptyResponse,
  jsonResponse,
  readJsonRequest,
  sameOrigin,
  serializeSessionCookie,
  sessionCredential,
  type HttpServiceOptions,
  type SiteApiEnvironment,
} from "../auth/http.js";

const SESSION_PATH = "/api/guest-sessions";
const ASSIGNED_ROOMS_PATH = `${SESSION_PATH}/rooms`;
const PROFILE_PATH = `${SESSION_PATH}/profile`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function guestSessionInput(value: unknown): GuestSessionRequest | null {
  if (!isRecord(value) || Object.keys(value).length !== 2 ||
      !Object.hasOwn(value, "protocolVersion") || !Object.hasOwn(value, "displayName") ||
      value.protocolVersion !== 1 || typeof value.displayName !== "string") return null;
  return { protocolVersion: 1, displayName: value.displayName };
}

function inputErrorResponse(error: unknown): Response {
  if (error instanceof HttpBoundaryError) return jsonResponse({ error: { code: error.code } }, error.statusCode);
  if (error instanceof RangeError || error instanceof TypeError) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
  return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
}

/** Route handler for `/api/guest-sessions` and `/api/guest-sessions/rooms`; returns null when unhandled. */
export async function handleSessionRoute(
  request: Request,
  env: SiteApiEnvironment,
  options: HttpServiceOptions = {},
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== SESSION_PATH && path !== ASSIGNED_ROOMS_PATH && path !== PROFILE_PATH) return null;

  if (path === PROFILE_PATH && request.method === "POST") {
    if (!sameOrigin(request)) return jsonResponse({ error: { code: "BAD_ORIGIN" } }, 403);
    try {
      const input = guestSessionInput(await readJsonRequest(request));
      if (!input) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
      const service = new GuestSessionService(env.DB, { now: options.now, crypto: options.crypto,
        guestSessionTtlMs: configuredGuestTtl(env, options) });
      const response = await service.rename(sessionCredential(request, configuredCookieName(env, options)), input.displayName);
      return response ? jsonResponse(response) : jsonResponse({ error: { code: "SESSION_EXPIRED" } }, 401);
    } catch (error) { return inputErrorResponse(error); }
  }

  if (path === SESSION_PATH && request.method === "GET") {
    try {
      const cookieName = configuredCookieName(env, options);
      const service = new GuestSessionService(env.DB, {
        now: options.now,
        guestSessionTtlMs: configuredGuestTtl(env, options),
        crypto: options.crypto,
      });
      const guest = await service.authenticate(sessionCredential(request, cookieName));
      if (!guest) return emptyResponse(204);
      return jsonResponse({
        protocolVersion: 1,
        player: { playerId: guest.playerId, displayName: guest.displayName },
        sessionExpiresAt: guest.expiresAt.toISOString(),
      });
    } catch {
      return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
  }

  if (path === ASSIGNED_ROOMS_PATH && request.method === "GET") {
    try {
      const cookieName = configuredCookieName(env, options);
      const guestService = new GuestSessionService(env.DB, {
        now: options.now,
        guestSessionTtlMs: configuredGuestTtl(env, options),
        crypto: options.crypto,
      });
      const guest = await guestService.authenticate(sessionCredential(request, cookieName));
      if (!guest) return jsonResponse({ error: { code: "SESSION_EXPIRED" } }, 401);
      const rooms = await new D1RoomService(env.DB, options).recoverAssignedSeats(guest.playerId);
      return jsonResponse(rooms);
    } catch {
      return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
    }
  }

  if (path === SESSION_PATH && request.method === "POST") {
    if (!sameOrigin(request)) return jsonResponse({ error: { code: "BAD_ORIGIN" } }, 403);
    try {
      const input = guestSessionInput(await readJsonRequest(request));
      if (!input) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
      const ttl = configuredGuestTtl(env, options);
      const service = new GuestSessionService(env.DB, {
        now: options.now,
        guestSessionTtlMs: ttl,
        crypto: options.crypto,
      });
      const issue = await service.create(input.displayName);
      const headers = new Headers({
        "Set-Cookie": serializeSessionCookie(
          configuredCookieName(env, options),
          issue.credential,
          issue.response.sessionExpiresAt,
          ttl !== undefined,
        ),
      });
      return jsonResponse(issue.response, 201, headers);
    } catch (error) {
      return inputErrorResponse(error);
    }
  }

  const allow = path === SESSION_PATH ? "GET, POST" : path === PROFILE_PATH ? "POST" : "GET";
  return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: allow });
}
