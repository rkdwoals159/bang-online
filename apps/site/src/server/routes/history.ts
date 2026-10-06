import { BASE_DECK_RULESET_VERSION } from "../../../../../packages/catalog/src/cards/index.js";
import { parseMatchHistoryRequest, parseMatchHistoryResponse } from "../../../../../packages/contracts/src/validation.js";
import { projectMatchHistoryPage } from "../../../../../apps/server/src/projections/sync.js";
import { D1StorageRepository, UnsupportedMatchStateError } from "../../storage/index.js";
import { HttpBoundaryError, jsonResponse, readJsonRequest, type HttpServiceOptions, type SiteApiEnvironment } from "../auth/http.js";
import { authenticatedPlayer } from "./sync.js";

/** History is read on demand and cannot modify the live match or its sync cursor. */
export async function handleMatchHistoryRoute(request: Request, env: SiteApiEnvironment, options: HttpServiceOptions = {}): Promise<Response | null> {
  const path = new URL(request.url).pathname.match(/^\/api\/matches\/([^/]+)\/history$/u);
  if (!path) return null;
  if (request.method !== "POST") return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "POST" });
  try {
    const parsed = parseMatchHistoryRequest(await readJsonRequest(request));
    if (!parsed.ok || parsed.value.matchId !== decodeURIComponent(path[1]!)) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
    const reject = (code: "NOT_FOUND_OR_FORBIDDEN" | "RECOVERY_REQUIRED") => jsonResponse({
      protocolVersion: 1, requestId: parsed.value.requestId, status: "rejected", error: { code },
    });
    const playerId = await authenticatedPlayer(request, env, options);
    if (!playerId) return reject("NOT_FOUND_OR_FORBIDDEN");
    const repository = new D1StorageRepository(env.DB);
    const match = await repository.getMatchForPlayer(parsed.value.matchId, playerId, { supportedSchemaVersion: 1 })
      .catch(error => { if (error instanceof UnsupportedMatchStateError) return "unsupported" as const; throw error; });
    if (match === "unsupported") return reject("RECOVERY_REQUIRED");
    if (!match) return reject("NOT_FOUND_OR_FORBIDDEN");
    if (match.rulesetVersion !== BASE_DECK_RULESET_VERSION) return reject("RECOVERY_REQUIRED");
    const events = await repository.listMatchEventsBefore(match.id, Math.min(parsed.value.beforeEventSeq, match.eventSeq + 1), 101);
    const response = projectMatchHistoryPage(parsed.value, match.state, events);
    if (!parseMatchHistoryResponse(response).ok) throw new Error("History validation failure");
    return jsonResponse(response);
  } catch (error) {
    if (error instanceof HttpBoundaryError) return jsonResponse({ error: { code: error.code } }, error.statusCode);
    if (error instanceof URIError) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
    console.error("bang.history.failure", { errorType: error instanceof Error ? "Error" : "Unknown" });
    return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
  }
}
