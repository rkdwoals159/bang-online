import type { CommandAck, CommandRejected } from "../../../../../packages/contracts/src/protocol.js";
import { parseCommandAck, parseMatchCommand } from "../../../../../packages/contracts/src/validation.js";
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
import { D1MatchService } from "../matches/service.js";

const MATCH_COMMAND_PATH = /^\/api\/matches\/([^/]+)\/commands$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandIdFrom(value: unknown): string | null {
  return isRecord(value) && typeof value.commandId === "string" && value.commandId.length > 0 && value.commandId.length <= 256
    ? value.commandId
    : null;
}

function commandRejected(commandId: string, code: string, currentVersion?: number): CommandRejected {
  const messageKey = code === "BAD_REQUEST"
    ? "protocol.badRequest"
    : `match.${code.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase())
      .replace(/^([A-Z])/u, (letter) => letter.toLowerCase())}`;
  const response: CommandRejected = {
    protocolVersion: 1,
    commandId,
    status: "rejected",
    error: {
      code,
      messageKey,
      retryable: code === "STALE_VERSION" || code === "SERVER_BUSY",
      ...(currentVersion === undefined ? {} : { currentVersion }),
    },
  };
  if (!parseCommandAck(response).ok) throw new Error("Rejected command acknowledgement failed its shared parser.");
  return response;
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

function parsedAck(ack: CommandAck): Response {
  return parseCommandAck(ack).ok
    ? jsonResponse(ack)
    : jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
}

/** Route handler for authenticated match commands; returns null when unhandled. */
export async function handleMatchesRoute(
  request: Request,
  env: SiteApiEnvironment,
  options: HttpServiceOptions = {},
): Promise<Response | null> {
  const match = new URL(request.url).pathname.match(MATCH_COMMAND_PATH);
  if (!match) return null;
  if (request.method !== "POST") {
    return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "POST" });
  }
  if (!sameOrigin(request)) return jsonResponse({ error: { code: "BAD_ORIGIN" } }, 403);

  let body: unknown;
  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return boundaryError(error);
  }

  const commandId = commandIdFrom(body);
  let pathMatchId: string;
  try {
    pathMatchId = decodeURIComponent(match[1]!);
  } catch {
    return commandId ? parsedAck(commandRejected(commandId, "BAD_REQUEST")) :
      jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
  }

  const parsed = parseMatchCommand(body);
  if (!parsed.ok || parsed.value.matchId !== pathMatchId) {
    return commandId ? parsedAck(commandRejected(commandId, "BAD_REQUEST")) :
      jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
  }

  try {
    const playerId = await authenticatedPlayer(request, env, options);
    if (!playerId) return parsedAck(commandRejected(parsed.value.commandId, "UNAUTHENTICATED"));
    const ack = await new D1MatchService(env.DB, { ...options, includeMatchProjection: true }).execute(playerId, parsed.value);
    if (!ack) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
    return parsedAck(ack);
  } catch {
    return parsedAck(commandRejected(parsed.value.commandId, "INTERNAL_ERROR"));
  }
}
