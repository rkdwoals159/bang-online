import { BASE_DECK_RULESET_VERSION, BASE_PHYSICAL_CARDS } from "../../../../../packages/catalog/src/cards/index.js";
import type { MatchSyncRequest, RoomSyncRequest, SyncRejectedResponse } from "../../../../../packages/contracts/src/protocol.js";
import {
  parseMatchSyncRequest,
  parseMatchSyncResponse,
  parseRoomSyncRequest,
  parseRoomSyncResponse,
  parseSyncUnchangedResponse,
  parseSyncRejectedResponse,
} from "../../../../../packages/contracts/src/validation.js";
import { projectMatchSnapshot } from "../../../../../packages/engine/src/state/projection.js";
import { syncProjectionInternals } from "../../../../../apps/server/src/projections/sync.js";
import { D1StorageRepository, UnsupportedMatchStateError } from "../../storage/index.js";
import { GuestSessionService } from "../auth/guest-sessions.js";
import {
  HttpBoundaryError,
  configuredCookieName,
  configuredGuestTtl,
  jsonResponse,
  readJsonRequest,
  sessionCredential,
  type HttpServiceOptions,
  type SiteApiEnvironment,
} from "../auth/http.js";
import { D1RoomService } from "../rooms/service.js";

const ROOM_SYNC_PATH = /^\/api\/rooms\/([^/]+)\/sync$/u;
const MATCH_SYNC_PATH = /^\/api\/matches\/([^/]+)\/sync$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdFrom(value: unknown): string | null {
  return isRecord(value) && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 256
    ? value.requestId
    : null;
}

function rejected(requestId: string, code: SyncRejectedResponse["error"]["code"]): SyncRejectedResponse {
  const response: SyncRejectedResponse = {
    protocolVersion: 1,
    requestId,
    status: "rejected",
    error: { code },
  };
  if (!parseSyncRejectedResponse(response).ok) throw new Error("Sync rejection failed its shared parser.");
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

/** Room and match sync routes return only the authenticated viewer's canonical projection. */
export async function handleSyncRoute(
  request: Request,
  env: SiteApiEnvironment,
  options: HttpServiceOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  const roomPath = url.pathname.match(ROOM_SYNC_PATH);
  const matchPath = url.pathname.match(MATCH_SYNC_PATH);
  if (!roomPath && !matchPath) return null;
  if (request.method !== "POST") {
    return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "POST" });
  }

  let body: unknown;
  try {
    body = await readJsonRequest(request);
  } catch (error) {
    return boundaryError(error);
  }
  const requestId = requestIdFrom(body);

  if (roomPath) {
    const parsed = parseRoomSyncRequest(body);
    if (!parsed.ok || !requestId) {
      return requestId ? jsonResponse(rejected(requestId, "BAD_REQUEST")) : boundaryError(new HttpBoundaryError(400, "BAD_REQUEST"));
    }
    let pathRoomId: string;
    try {
      pathRoomId = decodeURIComponent(roomPath[1]!);
    } catch {
      return jsonResponse(rejected(requestId, "BAD_REQUEST"));
    }
    if (parsed.value.roomId !== pathRoomId) return jsonResponse(rejected(requestId, "BAD_REQUEST"));
    try {
      const playerId = await authenticatedPlayer(request, env, options);
      if (!playerId) return jsonResponse(rejected(requestId, "NOT_FOUND_OR_FORBIDDEN"));

      const repository = new D1StorageRepository(env.DB);
      const record = await repository.getRoom(parsed.value.roomId);
      const room = record
        ? await new D1RoomService(env.DB, options).roomViewForMember(parsed.value.roomId, playerId, record)
        : null;
      if (!record || !room || room.viewer.playerId !== playerId || !room.members.some((member) => member.playerId === playerId)) {
        return jsonResponse(rejected(requestId, "NOT_FOUND_OR_FORBIDDEN"));
      }
      if (room.version !== record.version || room.rulesetVersion !== BASE_DECK_RULESET_VERSION) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
      }

      if (parsed.value.acceptUnchanged === true && parsed.value.knownVersion === room.version) {
        const unchanged = {
          protocolVersion: 1 as const,
          requestId: parsed.value.requestId,
          status: "unchanged" as const,
          roomId: room.roomId,
          version: room.version,
        };
        if (!parseSyncUnchangedResponse(unchanged).ok) return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
        return jsonResponse(unchanged);
      }

      const response = {
        protocolVersion: 1 as const,
        requestId: parsed.value.requestId,
        roomId: parsed.value.roomId,
        version: room.version,
        requiresFullSnapshot: parsed.value.knownVersion !== room.version,
        room,
      };
      if (!parseRoomSyncResponse(response).ok) return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
      return jsonResponse(response);
    } catch (error) {
      return boundaryError(error);
    }
  }

  const parsed = parseMatchSyncRequest(body);
  if (!parsed.ok || !requestId) {
    return requestId ? jsonResponse(rejected(requestId, "BAD_REQUEST")) : boundaryError(new HttpBoundaryError(400, "BAD_REQUEST"));
  }
  let pathMatchId: string;
  try {
    pathMatchId = decodeURIComponent(matchPath![1]!);
  } catch {
    return jsonResponse(rejected(requestId, "BAD_REQUEST"));
  }
  if (parsed.value.matchId !== pathMatchId) return jsonResponse(rejected(requestId, "BAD_REQUEST"));

  try {
    const playerId = await authenticatedPlayer(request, env, options);
    if (!playerId) return jsonResponse(rejected(requestId, "NOT_FOUND_OR_FORBIDDEN"));

    const repository = new D1StorageRepository(env.DB);
    let match;
    try {
      match = await repository.getMatchForPlayer(parsed.value.matchId, playerId, { supportedSchemaVersion: 1 });
    } catch (error) {
      if (error instanceof UnsupportedMatchStateError) {
        return jsonResponse(rejected(requestId, "RECOVERY_REQUIRED"));
      }
      throw error;
    }
    if (!match || !match.players.some((member) => member.playerId === playerId)) {
      return jsonResponse(rejected(requestId, "NOT_FOUND_OR_FORBIDDEN"));
    }
    if (match.rulesetVersion !== BASE_DECK_RULESET_VERSION) {
      return jsonResponse(rejected(requestId, "RECOVERY_REQUIRED"));
    }

    const afterEventSeq = parsed.value.afterEventSeq;
    if (parsed.value.acceptUnchanged === true && parsed.value.knownVersion === match.version && afterEventSeq === match.eventSeq) {
      const unchanged = {
        protocolVersion: 1 as const,
        requestId: parsed.value.requestId,
        status: "unchanged" as const,
        matchId: match.id,
        version: match.version,
        eventSeq: match.eventSeq,
      };
      if (!parseSyncUnchangedResponse(unchanged).ok) return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
      return jsonResponse(unchanged);
    }

    const events = afterEventSeq <= match.eventSeq
      ? await repository.listMatchEvents(match.id, afterEventSeq)
      : [];
    const replayable = syncProjectionInternals.cursorIsReplayable(afterEventSeq, match.eventSeq, events);
    const visibleEvents = events.flatMap((event) => {
      const projected = syncProjectionInternals.projectEvent(event, match.state);
      return projected ? [projected] : [];
    });
    const response = {
      protocolVersion: 1 as const,
      requestId: parsed.value.requestId,
      matchId: match.id,
      version: match.version,
      eventSeq: match.eventSeq,
      requiresFullSnapshot: parsed.value.knownVersion !== match.version || !replayable,
      snapshot: projectMatchSnapshot(match.state, playerId, BASE_PHYSICAL_CARDS),
      visibleEvents,
    };
    if (!parseMatchSyncResponse(response).ok) return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
    return jsonResponse(response);
  } catch (error) {
    return boundaryError(error);
  }
}
