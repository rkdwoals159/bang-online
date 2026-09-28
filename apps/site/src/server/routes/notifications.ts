import type { D1DatabaseLike } from "../../storage/d1-types.js";
import { D1StorageRepository } from "../../storage/index.js";
import { GuestSessionService } from "../auth/guest-sessions.js";
import {
  configuredCookieName,
  configuredGuestTtl,
  jsonResponse,
  sessionCredential,
  type HttpServiceOptions,
  type SiteApiEnvironment,
} from "../auth/http.js";

const NOTIFICATIONS_PATH = "/api/notifications/events";
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_OUTBOX_ROWS_PER_POLL = 100;

export interface NotificationRouteOptions extends HttpServiceOptions {
  /** Smaller intervals are used by the isolated Worker test suite. Production remains protocol-bounded. */
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

interface MembershipAggregates {
  roomIds: string[];
  matchIds: string[];
}

interface AggregateIdRow { aggregate_id: string }

function parseCursor(raw: string | null): number | null {
  if (raw === null) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(raw)) return null;
  const cursor = Number(raw);
  return Number.isSafeInteger(cursor) ? cursor : null;
}

async function authenticatedPlayer(
  request: Request,
  env: SiteApiEnvironment,
  options: NotificationRouteOptions,
): Promise<string | null> {
  const sessions = new GuestSessionService(env.DB, {
    now: options.now,
    guestSessionTtlMs: configuredGuestTtl(env, options),
    crypto: options.crypto,
  });
  const guest = await sessions.authenticate(sessionCredential(request, configuredCookieName(env, options)));
  return guest?.playerId ?? null;
}

/** Membership is read before each cursor query so a stale cursor never grants aggregate access. */
async function currentMemberships(db: D1DatabaseLike, playerId: string): Promise<MembershipAggregates> {
  const [rooms, matches] = await Promise.all([
    db.prepare(`
      SELECT rp.room_id AS aggregate_id
      FROM room_players rp JOIN rooms r ON r.id = rp.room_id
      WHERE rp.player_id = ? ORDER BY rp.room_id
    `).bind(playerId).all<AggregateIdRow>(),
    db.prepare(`
      SELECT mp.match_id AS aggregate_id
      FROM match_players mp JOIN matches m ON m.id = mp.match_id
      WHERE mp.player_id = ? ORDER BY mp.match_id
    `).bind(playerId).all<AggregateIdRow>(),
  ]);
  return {
    roomIds: (rooms.results ?? []).map(({ aggregate_id }) => aggregate_id),
    matchIds: (matches.results ?? []).map(({ aggregate_id }) => aggregate_id),
  };
}

function boundedInterval(value: number | undefined, fallback: number, maximum: number): number {
  const interval = value ?? fallback;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > maximum) {
    throw new RangeError("SSE timing must remain within the protocol bounds.");
  }
  return interval;
}

function createOutboxStream(
  request: Request,
  env: SiteApiEnvironment,
  options: NotificationRouteOptions,
  playerId: string,
  initialCursor: number,
): ReadableStream<Uint8Array> {
  const pollIntervalMs = boundedInterval(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS);
  const heartbeatIntervalMs = boundedInterval(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS);
  const encoder = new TextEncoder();
  const repository = new D1StorageRepository(env.DB);
  let cancelStream = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = initialCursor;
      let lastHeartbeatAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let polling = false;

      const close = () => {
        if (closed) return;
        closed = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        request.signal.removeEventListener("abort", onAbort);
        try { controller.close(); } catch { /* A cancelled stream is already closed. */ }
      };

      const onAbort = () => close();
      cancelStream = close;
      const schedule = () => {
        if (closed) return;
        const untilHeartbeat = Math.max(1, heartbeatIntervalMs - (Date.now() - lastHeartbeatAt));
        timer = setTimeout(() => { void poll(); }, Math.min(pollIntervalMs, untilHeartbeat));
      };

      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          const currentPlayerId = await authenticatedPlayer(request, env, options);
          if (!currentPlayerId || currentPlayerId !== playerId) {
            close();
            return;
          }

          // The authorized aggregate set is always refreshed before querying after `cursor`.
          const memberships = await currentMemberships(env.DB, currentPlayerId);
          if (memberships.roomIds.length === 0 && memberships.matchIds.length === 0) {
            close();
            return;
          }
          const roomIds = new Set(memberships.roomIds);
          const matchIds = new Set(memberships.matchIds);
          const aggregateIds = [...new Set([...memberships.roomIds, ...memberships.matchIds])];
          const rows = await repository.listOutboxAfter(cursor, aggregateIds, MAX_OUTBOX_ROWS_PER_POLL);
          for (const row of rows) {
            if (row.cursor <= cursor) continue;
            // Rows were fetched only for current memberships. Advance over an invalid kind without emitting it.
            cursor = row.cursor;
            let data: Record<string, string | number> | null = null;
            if (row.kind === "room:changed" && roomIds.has(row.aggregateId)) {
              data = { kind: "room", aggregateId: row.aggregateId, version: row.aggregateVersion };
            } else if (row.kind === "match:changed" && matchIds.has(row.aggregateId)) {
              data = {
                kind: "match",
                aggregateId: row.aggregateId,
                version: row.aggregateVersion,
                eventSeq: row.eventSeq,
              };
            }
            if (data) {
              controller.enqueue(encoder.encode(`id: ${row.cursor}\nevent: invalidation\ndata: ${JSON.stringify(data)}\n\n`));
              lastHeartbeatAt = Date.now();
            }
          }

          if (Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastHeartbeatAt = Date.now();
          }
        } catch {
          // A reconnect performs a fresh membership check and resumes from the last delivered cursor.
          close();
          return;
        } finally {
          polling = false;
          if (!closed) schedule();
        }
      };

      request.signal.addEventListener("abort", onAbort, { once: true });
      if (request.signal.aborted) close();
      else void poll();
    },
    cancel() {
      cancelStream();
    },
  });
}

/** Authenticated D1 outbox feed. Its only data is allowlisted invalidation metadata. */
export async function handleNotificationsRoute(
  request: Request,
  env: SiteApiEnvironment,
  options: NotificationRouteOptions = {},
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== NOTIFICATIONS_PATH) return null;
  if (request.method !== "GET") {
    return jsonResponse({ error: { code: "METHOD_NOT_ALLOWED" } }, 405, { Allow: "GET" });
  }

  const queryCursors = url.searchParams.getAll("after");
  const headerCursor = request.headers.get("Last-Event-ID");
  if (queryCursors.length > 1) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);
  const rawCursor = headerCursor !== null ? headerCursor : queryCursors[0] ?? null;
  const cursor = parseCursor(rawCursor);
  if (cursor === null) return jsonResponse({ error: { code: "BAD_REQUEST" } }, 400);

  try {
    const playerId = await authenticatedPlayer(request, env, options);
    if (!playerId) return jsonResponse({ error: { code: "NOT_FOUND_OR_FORBIDDEN" } }, 404);
    // Check current membership before opening the stream or reading any outbox cursor.
    const memberships = await currentMemberships(env.DB, playerId);
    if (memberships.roomIds.length === 0 && memberships.matchIds.length === 0) {
      return jsonResponse({ error: { code: "NOT_FOUND_OR_FORBIDDEN" } }, 404);
    }

    const stream = createOutboxStream(request, env, options, playerId, cursor);
    return new Response(stream, {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
        "X-Accel-Buffering": "no",
      },
    });
  } catch {
    return jsonResponse({ error: { code: "INTERNAL_ERROR" } }, 500);
  }
}
