import type { RoomConnectionState, RoomPresenceView } from "../../../../../packages/contracts/src/protocol.js";
import { parseRoomPresenceView } from "../../../../../packages/contracts/src/validation.js";
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
const ACTIVE_POLL_INTERVAL_MS = 1_000;
const WAITING_ROOM_POLL_INTERVAL_MS = 2_000;
const IDLE_POLL_INTERVAL_MS = 5_000;
const ACTIVE_WINDOW_MS = 15_000;
const PRESENCE_RENEWAL_INTERVAL_MS = 20_000;
const PRESENCE_LEASE_MS = 45_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const MAX_OUTBOX_ROWS_PER_POLL = 100;

export interface NotificationRouteOptions extends HttpServiceOptions {
  /** Smaller intervals are used by the isolated Worker test suite. */
  pollIntervalMs?: number;
  /** Optional slow interval after the stream has been idle. */
  idlePollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

interface RoomMembershipRow {
  room_id: string;
  room_status: string;
  latest_match_status: string | null;
  player_id: string;
  seat_index: number | string;
  last_presence_at: string | null;
}

interface RoomMembership {
  roomId: string;
  roomStatus: string;
  latestMatchStatus: string | null;
  members: { playerId: string; seatIndex: number; lastPresenceAt: string | null }[];
}

interface MatchMembershipRow { aggregate_id: string; status: string }

interface MembershipAggregates {
  rooms: RoomMembership[];
  matches: { matchId: string; status: string }[];
}

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

/** Room and match memberships share one D1 batch snapshot; room members supply presence leases. */
async function currentMemberships(db: D1DatabaseLike, playerId: string): Promise<MembershipAggregates> {
  const results = await db.batch([
    db.prepare(`
      SELECT r.id AS room_id, r.status AS room_status, latest.status AS latest_match_status,
        member.player_id, member.seat_index, member.last_presence_at
      FROM room_players AS viewer
      JOIN rooms AS r ON r.id = viewer.room_id
      LEFT JOIN matches AS latest ON latest.id = (
        SELECT id FROM matches WHERE room_id = r.id
        ORDER BY room_version DESC, created_at DESC, started_at DESC, id DESC LIMIT 1
      )
      JOIN room_players AS member ON member.room_id = r.id
      WHERE viewer.player_id = ?
      ORDER BY r.id, member.seat_index
    `).bind(playerId),
    db.prepare(`
      SELECT m.id AS aggregate_id, m.status
      FROM room_players AS viewer
      JOIN matches AS m ON m.room_id = viewer.room_id
      WHERE viewer.player_id = ?
        AND m.id = (
          SELECT latest.id FROM matches AS latest WHERE latest.room_id = viewer.room_id
          ORDER BY latest.room_version DESC, latest.created_at DESC, latest.started_at DESC, latest.id DESC LIMIT 1
        )
        AND EXISTS (SELECT 1 FROM match_players AS mp WHERE mp.match_id = m.id AND mp.player_id = ?)
      ORDER BY m.id
    `).bind(playerId, playerId),
  ]);
  const rooms = new Map<string, RoomMembership>();
  for (const row of (results[0]?.results ?? []) as RoomMembershipRow[]) {
    const roomId = row.room_id;
    let room = rooms.get(roomId);
    if (!room) {
      room = { roomId, roomStatus: row.room_status, latestMatchStatus: row.latest_match_status, members: [] };
      rooms.set(roomId, room);
    }
    const seatIndex = Number(row.seat_index);
    if (!Number.isSafeInteger(seatIndex) || seatIndex < 0 || seatIndex > 6) {
      throw new Error("Stored room member seat is invalid.");
    }
    room.members.push({ playerId: row.player_id, seatIndex, lastPresenceAt: row.last_presence_at });
  }
  return {
    rooms: [...rooms.values()],
    matches: (results[1]?.results ?? []).map((value) => {
      const row = value as MatchMembershipRow;
      return { matchId: row.aggregate_id, status: row.status };
    }),
  };
}

function boundedInterval(value: number | undefined, fallback: number, maximum: number): number {
  const interval = value ?? fallback;
  if (!Number.isSafeInteger(interval) || interval < 1 || interval > maximum) {
    throw new RangeError("SSE timing must remain within the protocol bounds.");
  }
  return interval;
}

function currentTime(options: NotificationRouteOptions): number {
  const value = options.now?.() ?? new Date();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("SSE clock must return a valid Date.");
  return value.getTime();
}

function connectionState(lastPresenceAt: string | null, observedAt: number): RoomConnectionState {
  if (lastPresenceAt === null) return "unknown";
  const timestamp = Date.parse(lastPresenceAt);
  if (!Number.isFinite(timestamp)) return "unknown";
  return observedAt - timestamp <= PRESENCE_LEASE_MS ? "connected" : "disconnected";
}

function createOutboxStream(
  request: Request,
  env: SiteApiEnvironment,
  options: NotificationRouteOptions,
  playerId: string,
  initialMemberships: MembershipAggregates,
  initialCursor: number,
): ReadableStream<Uint8Array> {
  const activePollIntervalMs = boundedInterval(options.pollIntervalMs, ACTIVE_POLL_INTERVAL_MS, 15_000);
  const idlePollIntervalMs = boundedInterval(
    options.idlePollIntervalMs,
    options.pollIntervalMs === undefined ? IDLE_POLL_INTERVAL_MS : activePollIntervalMs,
    15_000,
  );
  const heartbeatIntervalMs = boundedInterval(options.heartbeatIntervalMs, DEFAULT_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS);
  const encoder = new TextEncoder();
  const repository = new D1StorageRepository(env.DB);
  let cancelStream = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      let cursor = initialCursor;
      let lastHeartbeatAt = currentTime(options);
      let lastPresenceRenewalAt = Number.NEGATIVE_INFINITY;
      let activeUntil = currentTime(options) + ACTIVE_WINDOW_MS;
      let firstPoll = true;
      let lastMemberships = initialMemberships;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;
      let polling = false;
      const lastPresenceByRoom = new Map<string, string>();

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
        const now = currentTime(options);
        const untilHeartbeat = Math.max(1, heartbeatIntervalMs - (now - lastHeartbeatAt));
        const activelyPlaying = lastMemberships.matches.some(({ status }) => status === "playing");
        const starting = lastMemberships.rooms.some(({ roomStatus }) => roomStatus === "starting");
        const waiting = lastMemberships.rooms.some(({ roomStatus }) => roomStatus === "waiting");
        const interval = activelyPlaying || starting
          ? activePollIntervalMs
          : waiting ? WAITING_ROOM_POLL_INTERVAL_MS
            : now < activeUntil ? activePollIntervalMs : idlePollIntervalMs;
        timer = setTimeout(() => { void poll(); }, Math.min(interval, untilHeartbeat));
      };

      const emitPresence = (memberships: MembershipAggregates, now: number) => {
        const activeRoomIds = new Set<string>();
        for (const room of memberships.rooms) {
          activeRoomIds.add(room.roomId);
          const members = room.members.map((member) => ({
            playerId: member.playerId,
            connectionState: member.playerId === playerId
              ? "connected" as const
              : connectionState(member.lastPresenceAt, now),
          }));
          const signature = JSON.stringify(members);
          if (lastPresenceByRoom.get(room.roomId) === signature) continue;
          const view: RoomPresenceView = {
            protocolVersion: 1,
            roomId: room.roomId,
            observedAt: new Date(now).toISOString(),
            members,
          };
          if (!parseRoomPresenceView(view).ok) throw new Error("Room presence failed its shared parser.");
          controller.enqueue(encoder.encode(`event: presence\ndata: ${JSON.stringify(view)}\n\n`));
          lastPresenceByRoom.set(room.roomId, signature);
          activeUntil = now + ACTIVE_WINDOW_MS;
          lastHeartbeatAt = now;
        }
        for (const roomId of lastPresenceByRoom.keys()) {
          if (!activeRoomIds.has(roomId)) lastPresenceByRoom.delete(roomId);
        }
      };

      const poll = async () => {
        if (closed || polling) return;
        polling = true;
        try {
          let memberships: MembershipAggregates;
          if (firstPoll) {
            // The route just authenticated and checked this initial membership snapshot.
            memberships = initialMemberships;
            firstPoll = false;
          } else {
            const currentPlayerId = await authenticatedPlayer(request, env, options);
            if (!currentPlayerId || currentPlayerId !== playerId) {
              close();
              return;
            }
            memberships = await currentMemberships(env.DB, currentPlayerId);
          }
          lastMemberships = memberships;

          if (memberships.rooms.length === 0 && memberships.matches.length === 0) {
            close();
            return;
          }

          const now = currentTime(options);
          if (now - lastPresenceRenewalAt >= PRESENCE_RENEWAL_INTERVAL_MS) {
            // This only updates the viewer's own lease rows; it never changes seats or game state.
            await repository.touchRoomPresence(playerId, new Date(now));
            lastPresenceRenewalAt = now;
          }
          emitPresence(memberships, now);

          // Every later cursor query is preceded by refreshed authentication and membership.
          const roomIds = new Set(memberships.rooms.map(({ roomId }) => roomId));
          const matchIds = new Set(memberships.matches.map(({ matchId }) => matchId));
          const aggregateIds = [...new Set([...roomIds, ...matchIds])];
          const rows = await repository.listOutboxInvalidationsAfter(cursor, aggregateIds, MAX_OUTBOX_ROWS_PER_POLL);
          for (const row of rows) {
            if (row.cursor <= cursor) continue;
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
              const deliveredAt = currentTime(options);
              lastHeartbeatAt = deliveredAt;
              activeUntil = deliveredAt + ACTIVE_WINDOW_MS;
            }
          }

          const heartbeatNow = currentTime(options);
          if (heartbeatNow - lastHeartbeatAt >= heartbeatIntervalMs) {
            controller.enqueue(encoder.encode(": heartbeat\n\n"));
            lastHeartbeatAt = heartbeatNow;
          }
        } catch {
          // A reconnect performs fresh authorization and resumes from the last delivered cursor.
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

/** Authenticated D1 outbox feed. Its only data is allowlisted invalidation and room-presence metadata. */
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
    if (memberships.rooms.length === 0 && memberships.matches.length === 0) {
      return jsonResponse({ error: { code: "NOT_FOUND_OR_FORBIDDEN" } }, 404);
    }

    const stream = createOutboxStream(request, env, options, playerId, memberships, cursor);
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
