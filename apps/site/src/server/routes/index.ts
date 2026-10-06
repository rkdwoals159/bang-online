import type { SiteApiEnvironment } from "../auth/http.js";
import { handleMatchesRoute } from "./matches.js";
import { handleNotificationsRoute } from "./notifications.js";
import { handleRoomsRoute } from "./rooms.js";
import { handleSessionRoute } from "./session.js";
import { handleSyncRoute } from "./sync.js";
import { handleMatchHistoryRoute } from "./history.js";

function notFound(request: Request): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  if (request.method === "HEAD") return new Response(null, { status: 404, headers });
  return new Response(JSON.stringify({ error: { code: "NOT_FOUND" } }), { status: 404, headers });
}

/** Dispatch the Sites Worker API to its D1-backed, authenticated route handlers. */
export async function routeApiRequest(request: Request, env: SiteApiEnvironment): Promise<Response> {
  const handlers = [
    handleSessionRoute,
    handleRoomsRoute,
    handleMatchesRoute,
    handleSyncRoute,
    handleMatchHistoryRoute,
    handleNotificationsRoute,
  ] as const;
  for (const handler of handlers) {
    const response = await handler(request, env);
    if (response) return response;
  }
  return notFound(request);
}
