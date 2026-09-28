import vinextWorker from "vinext/server/fetch-handler";
import type { SiteApiEnvironment } from "./auth/http.js";
import { routeApiRequest } from "./routes/index";
import { ensureSiteDatabase } from "../storage/site-database.js";

type SiteEnv = SiteApiEnvironment & { [key: string]: unknown };

const worker = {
  async fetch(request: Request, env: SiteEnv, context: ExecutionContext): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      try {
        await ensureSiteDatabase(env.DB);
      } catch {
        return new Response(JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE" } }), {
          status: 503,
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
          },
        });
      }
      return routeApiRequest(request, env);
    }

    return vinextWorker.fetch(request, env, context);
  },
};

export default worker;
