import assert from "node:assert/strict";
import { test } from "node:test";
import type { GameState } from "../../../../packages/engine/src/state/types.js";
import { parseRoomCommand, parseRoomPreviewResponse, parseRoomView } from "../../../../packages/contracts/src/validation.js";
import { sha256Hex } from "../../src/server/auth/crypto.js";
import { handleRoomsRoute } from "../../src/server/routes/rooms.js";
import { handleSessionRoute } from "../../src/server/routes/session.js";
import type { D1DatabaseLike } from "../../src/storage/d1-types.js";
import { D1StorageRepository } from "../../src/storage/repository.js";
import { countRows, createIsolatedD1 } from "../storage/d1-test-db.js";

const ORIGIN = "https://site.test";
const FIXED_TIME = Date.parse("2026-09-27T12:00:00.000Z");

test("R08 owner kick removes one waiting member, replays once, and allows the guest to rejoin", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const options = serviceOptions({ value: FIXED_TIME });
    const guests = await Promise.all(["Owner", "P2", "P3", "P4"].map(name => createGuest(db, name, options)));
    const { roomId, inviteCode } = await fillRoom(db, guests, options);
    const repository = new D1StorageRepository(db);
    const command = roomCommand("KICK_MEMBER", roomId, 3, { targetPlayerId: guests[3]!.playerId });
    const kicked = assertRoomView((await sendRoomCommand(db, guests[0]!, options, command, roomId)).body);
    assert.equal(kicked.members.length, 3);
    assert.equal(kicked.members.some(member => member.playerId === guests[3]!.playerId), false);
    assert.equal((await repository.getRoom(roomId))!.version, 4);
    assertRoomView((await sendRoomCommand(db, guests[0]!, options, command, roomId)).body);
    assert.equal((await repository.getRoom(roomId))!.version, 4);
    const joined = assertRoomView((await sendRoomCommand(db, guests[3]!, options,
      roomCommand("JOIN", roomId, 4, { inviteCode }), roomId)).body);
    assert.equal(joined.members.length, 4);
    const version = await readyAll(db, guests, options, roomId, 5);
    const results = await Promise.all([
      sendRoomCommand(db, guests[0]!, options, roomCommand("START_MATCH", roomId, version, {}), roomId),
      sendRoomCommand(db, guests[0]!, options, roomCommand("KICK_MEMBER", roomId, version, { targetPlayerId: guests[3]!.playerId }), roomId),
    ]);
    assert.equal(results.filter(result => parseRoomView(result.body).ok).length, 1);
    const final = (await repository.getRoom(roomId))!;
    assert.equal(final.version, version + 1);
    assert.equal(final.players.length, final.status === "in_game" ? 4 : 3);
    if (final.status === "in_game") {
      assertRejected((await sendRoomCommand(db, guests[0]!, options,
        roomCommand("KICK_MEMBER", roomId, final.version, { targetPlayerId: guests[3]!.playerId }), roomId)).body, "ROOM_LOCKED");
    }
  } finally { await runtime.dispose(); }
});
let commandSequence = 1;

interface Clock { value: number }
interface Guest {
  playerId: string;
  displayName: string;
  cookie: string;
  credential: string;
}

function nextCommandId(): string {
  const suffix = String(commandSequence++).padStart(12, "0");
  return `00000000-0000-4000-8000-${suffix}`;
}

function request(path: string, init: {
  method?: string;
  body?: unknown;
  cookie?: string;
  origin?: string | null;
  peerAddress?: string;
  forwardedFor?: string;
  contentType?: string | null;
  rawBody?: string;
} = {}): Request {
  const method = init.method ?? "POST";
  const headers = new Headers();
  const contentType = init.contentType === undefined ? "application/json" : init.contentType;
  if (contentType) headers.set("Content-Type", contentType);
  const origin = init.origin === undefined ? ORIGIN : init.origin;
  if (origin) headers.set("Origin", origin);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.peerAddress !== undefined) headers.set("CF-Connecting-IP", init.peerAddress);
  if (init.forwardedFor !== undefined) headers.set("X-Forwarded-For", init.forwardedFor);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(init.rawBody !== undefined ? { body: init.rawBody } : init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

function serviceOptions(clock: Clock, guestSessionTtlMs?: number) {
  return { now: () => new Date(clock.value), ...(guestSessionTtlMs === undefined ? {} : { guestSessionTtlMs }) };
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

async function createGuest(db: D1DatabaseLike, displayName: string, options: ReturnType<typeof serviceOptions>): Promise<Guest> {
  const response = await handleSessionRoute(request("/api/guest-sessions", {
    body: { protocolVersion: 1, displayName },
  }), { DB: db }, options);
  assert.ok(response);
  assert.equal(response.status, 201);
  const body = await json(response) as {
    protocolVersion: number;
    player: { playerId: string; displayName: string };
    sessionExpiresAt: string;
  };
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie);
  const cookiePair = setCookie.split(";", 1)[0]!;
  const separator = cookiePair.indexOf("=");
  return {
    playerId: body.player.playerId,
    displayName: body.player.displayName,
    cookie: cookiePair,
    credential: decodeURIComponent(cookiePair.slice(separator + 1)),
  };
}

async function createRoom(
  db: D1DatabaseLike,
  owner: Guest,
  options: ReturnType<typeof serviceOptions>,
  commandId = nextCommandId(),
): Promise<{ roomId: string; version: number; inviteCode: string; duplicate: boolean }> {
  const command = {
    protocolVersion: 1,
    commandId,
    expectedVersion: 0,
    type: "CREATE_ROOM",
    payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "untrusted display name" },
  } as const;
  assert.equal(parseRoomCommand(command).ok, true);
  const response = await handleRoomsRoute(request("/api/rooms", { body: command, cookie: owner.cookie }), { DB: db }, options);
  assert.ok(response);
  assert.equal(response.status, 200);
  return await json(response) as { roomId: string; version: number; inviteCode: string; duplicate: boolean };
}

async function sendRoomCommand(
  db: D1DatabaseLike,
  guest: Guest,
  options: ReturnType<typeof serviceOptions>,
  command: unknown,
  pathRoomId: string,
  peerAddress = "192.0.2.10",
  forwardedFor = "198.51.100.255",
): Promise<{ response: Response; body: unknown }> {
  const response = await handleRoomsRoute(request(`/api/rooms/${encodeURIComponent(pathRoomId)}/commands`, {
    body: command,
    cookie: guest.cookie,
    peerAddress,
    forwardedFor,
  }), { DB: db }, options);
  assert.ok(response);
  return { response, body: await json(response) };
}

function roomCommand(
  type: string,
  roomId: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId = nextCommandId(),
) {
  return { protocolVersion: 1, commandId, roomId, expectedVersion, type, payload };
}

function assertRejected(value: unknown, code: string): asserts value is {
  protocolVersion: 1;
  commandId: string;
  status: "rejected";
  error: { code: string; messageKey: string; retryable: boolean; currentVersion?: number; retryAfterMs?: number };
} {
  assert.equal(typeof value, "object");
  assert.ok(value);
  const response = value as Record<string, unknown>;
  assert.deepEqual(Object.keys(response).sort(), ["commandId", "error", "protocolVersion", "status"]);
  assert.equal(response.protocolVersion, 1);
  assert.equal(response.status, "rejected");
  assert.equal(typeof response.commandId, "string");
  assert.equal(typeof response.error, "object");
  assert.ok(response.error);
  assert.equal((response.error as Record<string, unknown>).code, code);
}

function assertRoomView(value: unknown) {
  const parsed = parseRoomView(value);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("Room response failed the canonical RoomView parser.");
  return parsed.value;
}

async function readyAll(
  db: D1DatabaseLike,
  guests: readonly Guest[],
  options: ReturnType<typeof serviceOptions>,
  roomId: string,
  startVersion: number,
): Promise<number> {
  let version = startVersion;
  for (const guest of guests) {
    const { body } = await sendRoomCommand(db, guest, options,
      roomCommand("SET_READY", roomId, version, { ready: true }), roomId);
    assertRoomView(body);
    const stored = await new D1StorageRepository(db).getRoom(roomId);
    assert.ok(stored);
    version = stored.version;
  }
  return version;
}

async function fillRoom(
  db: D1DatabaseLike,
  guests: readonly Guest[],
  options: ReturnType<typeof serviceOptions>,
): Promise<{ roomId: string; inviteCode: string; version: number }> {
  const owner = guests[0]!;
  const room = await createRoom(db, owner, options);
  const repository = new D1StorageRepository(db);
  for (const guest of guests.slice(1)) {
    const stored = await repository.getRoom(room.roomId);
    assert.ok(stored);
    const joined = await sendRoomCommand(db, guest, options,
      roomCommand("JOIN", room.roomId, stored.version, { inviteCode: room.inviteCode }), room.roomId);
    assert.equal(assertRoomView(joined.body).members.length, stored.players.length + 1);
  }
  const full = await repository.getRoom(room.roomId);
  assert.ok(full);
  return { roomId: room.roomId, inviteCode: room.inviteCode, version: full.version };
}

async function completeMatch(db: D1DatabaseLike, repository: D1StorageRepository, matchId: string): Promise<void> {
  const match = await repository.getMatch(matchId);
  assert.ok(match);
  const state: GameState = structuredClone(match.state);
  state.status = "completed";
  state.version = match.version + 1;
  state.eventSeq = match.eventSeq + 1;
  state.outcome = { winningFaction: "sheriff_and_deputies", winningPlayerIds: [state.seats[0]!.public.playerId] };
  const at = "2026-09-27T12:05:00.000Z";
  await db.batch([
    db.prepare(`UPDATE matches SET status = 'completed', version = ?, event_seq = ?, state_json = ?, updated_at = ?, ended_at = ?
      WHERE id = ?`).bind(state.version, state.eventSeq, JSON.stringify(state), at, at, matchId),
    db.prepare(`INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json)
      VALUES (?, ?, ?, ?, 'MATCH_FINISHED', ?, ?)`)
      .bind(matchId, state.eventSeq, `${matchId}-finished`, state.version, state.seats[0]!.public.playerId, JSON.stringify({ kept: true })),
  ]);
}

test("guest cookie create/restore is Worker-safe, expires correctly, and assigned-room restore is identity-scoped", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const clock = { value: FIXED_TIME };
    const ttlOptions = serviceOptions(clock, 5_000);
    const created = await handleSessionRoute(request("/api/guest-sessions", {
      body: { protocolVersion: 1, displayName: "  Sheriff 🐎  " },
    }), { DB: db }, ttlOptions);
    assert.ok(created);
    const createdBody = await json(created);
    const cookie = created.headers.get("Set-Cookie") ?? "";
    assert.match(cookie, /(?:^|; )Path=\//u);
    assert.match(cookie, /(?:^|; )HttpOnly(?:;|$)/u);
    assert.match(cookie, /(?:^|; )Secure(?:;|$)/u);
    assert.match(cookie, /(?:^|; )SameSite=Lax(?:;|$)/u);
    assert.match(cookie, /Expires=Sun, 27 Sep 2026 12:00:05 GMT/u);
    const cookiePair = cookie.split(";", 1)[0]!;
    const credential = decodeURIComponent(cookiePair.slice(cookiePair.indexOf("=") + 1));
    const bodyPlayerId = (createdBody as { player: { playerId: string } }).player.playerId;
    const owner: Guest = {
      playerId: bodyPlayerId,
      displayName: "Sheriff 🐎",
      cookie: cookiePair,
      credential,
    };
    assert.equal(JSON.stringify(createdBody).includes(owner.credential), false);
    const stored = await db.prepare("SELECT token_hash FROM guest_sessions WHERE id = ?")
      .bind(bodyPlayerId).first<{ token_hash: string }>();
    assert.ok(stored);
    assert.equal(stored.token_hash, await sha256Hex(owner.credential));
    assert.notEqual(stored.token_hash, owner.credential);
    assert.equal(JSON.stringify(stored).includes(owner.credential), false);

    const restored = await handleSessionRoute(request("/api/guest-sessions", { method: "GET", cookie: owner.cookie }), { DB: db }, ttlOptions);
    assert.ok(restored);
    assert.equal(restored.status, 200);
    assert.deepEqual(await json(restored), {
      protocolVersion: 1,
      player: { playerId: owner.playerId, displayName: "Sheriff 🐎" },
      sessionExpiresAt: new Date(FIXED_TIME + 5_000).toISOString(),
    });
    const missing = await handleSessionRoute(request("/api/guest-sessions", { method: "GET" }), { DB: db }, ttlOptions);
    assert.ok(missing);
    assert.equal(missing.status, 204);
    assert.equal(await missing.text(), "");

    const noExpiryGuest = await createGuest(db, "No expiry", serviceOptions(clock));
    const noExpiryResponse = await handleSessionRoute(request("/api/guest-sessions", {
      body: { protocolVersion: 1, displayName: "No expiry" },
    }), { DB: db }, serviceOptions(clock));
    assert.ok(noExpiryResponse);
    assert.equal(noExpiryResponse.headers.get("Set-Cookie")?.includes("Expires="), false);
    assert.ok(noExpiryGuest.cookie);

    const room = await createRoom(db, owner, ttlOptions);
    const joiner = await createGuest(db, "Assigned guest", ttlOptions);
    const joined = await sendRoomCommand(db, joiner, ttlOptions,
      roomCommand("JOIN", room.roomId, 0, { inviteCode: room.inviteCode }), room.roomId);
    assert.equal(assertRoomView(joined.body).roomId, room.roomId);
    const assigned = await handleSessionRoute(request("/api/guest-sessions/rooms", { method: "GET", cookie: joiner.cookie }), { DB: db }, ttlOptions);
    assert.ok(assigned);
    assert.equal(assigned.status, 200);
    const assignedBody = await json(assigned) as Array<Record<string, unknown>>;
    assert.equal(assignedBody.length, 1);
    assertRoomView(assignedBody[0]);
    const outsider = await createGuest(db, "Outsider", ttlOptions);
    const outsiderRooms = await handleSessionRoute(request("/api/guest-sessions/rooms", { method: "GET", cookie: outsider.cookie }), { DB: db }, ttlOptions);
    assert.ok(outsiderRooms);
    assert.deepEqual(await json(outsiderRooms), []);
    assert.equal(JSON.stringify(assignedBody).includes(room.inviteCode), false);
    assert.equal(JSON.stringify(assignedBody).includes(joiner.credential), false);
    assert.equal(JSON.stringify(assignedBody).includes("inviteCodeHash"), false);

    clock.value += 5_000;
    const expired = await handleSessionRoute(request("/api/guest-sessions", { method: "GET", cookie: owner.cookie }), { DB: db }, ttlOptions);
    assert.ok(expired);
    assert.equal(expired.status, 204);
    const expiredRooms = await handleSessionRoute(request("/api/guest-sessions/rooms", { method: "GET", cookie: owner.cookie }), { DB: db }, ttlOptions);
    assert.ok(expiredRooms);
    assert.equal(expiredRooms.status, 401);
    assert.deepEqual(await json(expiredRooms), { error: { code: "SESSION_EXPIRED" } });
  } finally {
    await runtime.dispose();
  }
});

test("invite preview is strict and redacted; persistent limiter honors peer IP, backoff, and successful JOIN reset", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const clock = { value: FIXED_TIME };
    const options = serviceOptions(clock);
    const owner = await createGuest(db, "Owner", options);
    const visitor = await createGuest(db, "Visitor", options);
    const room = await createRoom(db, owner, options);
    const ip = "203.0.113.7";

    const preview = await handleRoomsRoute(request("/api/rooms/preview", {
      body: { protocolVersion: 1, requestId: "preview-good", inviteCode: room.inviteCode },
      cookie: visitor.cookie,
      peerAddress: ip,
      forwardedFor: "10.0.0.1",
    }), { DB: db }, options);
    assert.ok(preview);
    const previewBody = await json(preview);
    assert.equal(parseRoomPreviewResponse(previewBody).ok, true);
    assert.deepEqual(previewBody, {
      protocolVersion: 1,
      requestId: "preview-good",
      roomId: room.roomId,
      version: 0,
      occupancy: 1,
      status: "waiting",
    });
    assert.equal(JSON.stringify(previewBody).includes(room.inviteCode), false);
    assert.equal(JSON.stringify(previewBody).includes(visitor.credential), false);
    const persistedLimiter = await db.prepare("SELECT bucket_hash FROM invite_attempts").all<{ bucket_hash: string }>();
    assert.equal(persistedLimiter.results?.length, 1);
    assert.equal(persistedLimiter.results?.[0]?.bucket_hash, await sha256Hex(JSON.stringify([ip, visitor.playerId])));
    assert.equal(persistedLimiter.results?.[0]?.bucket_hash.includes(ip), false);
    assert.equal(persistedLimiter.results?.[0]?.bucket_hash.includes(visitor.playerId), false);

    for (let index = 0; index < 4; index += 1) {
      const response = await handleRoomsRoute(request("/api/rooms/preview", {
        body: { protocolVersion: 1, requestId: `invalid-${index}`, inviteCode: `bad-invite-${index}` },
        cookie: visitor.cookie,
        peerAddress: ip,
        forwardedFor: `192.0.2.${index}`,
      }), { DB: db }, options);
      assert.ok(response);
      const body = await json(response);
      assert.equal(parseRoomPreviewResponse(body).ok, true);
      assert.deepEqual(body, {
        protocolVersion: 1,
        requestId: `invalid-${index}`,
        status: "rejected",
        error: { code: "INVITE_INVALID" },
      });
      assert.equal(JSON.stringify(body).includes(`bad-invite-${index}`), false);
    }

    const successfulJoin = await sendRoomCommand(db, visitor, options,
      roomCommand("JOIN", room.roomId, 0, { inviteCode: room.inviteCode }), room.roomId, ip, "203.0.113.99");
    assert.equal(assertRoomView(successfulJoin.body).members.length, 2);

    for (let index = 0; index < 5; index += 1) {
      const response = await handleRoomsRoute(request("/api/rooms/preview", {
        body: { protocolVersion: 1, requestId: `after-join-${index}`, inviteCode: `wrong-${index}` },
        cookie: visitor.cookie,
        peerAddress: ip,
        forwardedFor: "198.51.100.45",
      }), { DB: db }, options);
      assert.ok(response);
      const body = await json(response);
      assert.equal(parseRoomPreviewResponse(body).ok, true);
      if (index < 5) assert.equal((body as { error?: { code?: string } }).error?.code, "INVITE_INVALID");
    }
    const limited = await handleRoomsRoute(request("/api/rooms/preview", {
      body: { protocolVersion: 1, requestId: "sixth-after-reset", inviteCode: room.inviteCode },
      cookie: visitor.cookie,
      peerAddress: ip,
      forwardedFor: "127.0.0.1",
    }), { DB: db }, options);
    assert.ok(limited);
    const limitedBody = await json(limited);
    const parsedLimited = parseRoomPreviewResponse(limitedBody);
    assert.equal(parsedLimited.ok, true);
    assert.deepEqual(limitedBody, {
      protocolVersion: 1,
      requestId: "sixth-after-reset",
      status: "rejected",
      error: { code: "RATE_LIMITED", retryAfterMs: 1_000 },
    });
    assert.equal(JSON.stringify(limitedBody).includes(room.inviteCode), false);

    clock.value += 500;
    const retried = await handleRoomsRoute(request("/api/rooms/preview", {
      body: { protocolVersion: 1, requestId: "retry-after-delay", inviteCode: room.inviteCode },
      cookie: visitor.cookie,
      peerAddress: ip,
    }), { DB: db }, options);
    assert.ok(retried);
    const retriedBody = await json(retried);
    assert.equal(parseRoomPreviewResponse(retriedBody).ok, true);
    assert.deepEqual(retriedBody, {
      protocolVersion: 1,
      requestId: "retry-after-delay",
      status: "rejected",
      error: { code: "RATE_LIMITED", retryAfterMs: 2_000 },
    });
    clock.value += 59_500;
    const expiredWindow = await handleRoomsRoute(request("/api/rooms/preview", {
      body: { protocolVersion: 1, requestId: "after-window", inviteCode: room.inviteCode },
      cookie: visitor.cookie,
      peerAddress: ip,
    }), { DB: db }, options);
    assert.ok(expiredWindow);
    assert.equal((await json(expiredWindow) as { status: string }).status, "waiting");
    assert.equal(await countRows(db, "invite_attempts"), 1);
  } finally {
    await runtime.dispose();
  }
});

test("concurrent JOIN is single-writer; room receipts replay and command hash mismatch is rejected", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const clock = { value: FIXED_TIME };
    const options = serviceOptions(clock);
    const owner = await createGuest(db, "Owner", options);
    const left = await createGuest(db, "Left", options);
    const right = await createGuest(db, "Right", options);
    const createId = nextCommandId();
    const room = await createRoom(db, owner, options, createId);
    const beforeCreateReplay = {
      rooms: await countRows(db, "rooms"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const duplicateCreate = await handleRoomsRoute(request("/api/rooms", {
      body: {
        protocolVersion: 1,
        commandId: createId,
        expectedVersion: 0,
        type: "CREATE_ROOM",
        payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "different ignored name" },
      },
      cookie: owner.cookie,
    }), { DB: db }, options);
    assert.ok(duplicateCreate);
    const duplicateCreateBody = await json(duplicateCreate) as { roomId: string; version: number; inviteCode: string | null; duplicate: boolean };
    assert.deepEqual(duplicateCreateBody, { roomId: room.roomId, version: 0, inviteCode: null, duplicate: true });
    assert.deepEqual({
      rooms: await countRows(db, "rooms"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeCreateReplay);
    const leftJoin = roomCommand("JOIN", room.roomId, 0, { inviteCode: room.inviteCode });
    const rightJoin = roomCommand("JOIN", room.roomId, 0, { inviteCode: room.inviteCode });
    const [leftResult, rightResult] = await Promise.all([
      sendRoomCommand(db, left, options, leftJoin, room.roomId),
      sendRoomCommand(db, right, options, rightJoin, room.roomId),
    ]);
    const results = [leftResult, rightResult];
    const success = results.filter(({ body }) => parseRoomView(body).ok);
    const failures = results.filter(({ body }) => !parseRoomView(body).ok);
    assert.equal(success.length, 1);
    assert.equal(failures.length, 1);
    assertRejected(failures[0]!.body, "STALE_VERSION");
    const roomAfterJoin = await new D1StorageRepository(db).getRoom(room.roomId);
    assert.ok(roomAfterJoin);
    assert.equal(roomAfterJoin.players.length, 2);
    assert.equal(roomAfterJoin.version, 1);
    const accepted = success[0]!;
    const acceptedCommand = accepted === leftResult ? leftJoin : rightJoin;
    const acceptedGuest = accepted === leftResult ? left : right;
    const beforeReplay = {
      players: await countRows(db, "room_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const replay = await sendRoomCommand(db, acceptedGuest, options, acceptedCommand, room.roomId);
    assertRoomView(replay.body);
    assert.deepEqual({
      players: await countRows(db, "room_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeReplay);
    const changedPayload = {
      ...(acceptedCommand as Record<string, unknown>),
      payload: { inviteCode: "another-code" },
    };
    const reused = await sendRoomCommand(db, acceptedGuest, options, changedPayload, room.roomId);
    assertRejected(reused.body, "COMMAND_ID_REUSED");

  } finally {
    await runtime.dispose();
  }
});

test("room automatic arrival/owner/version guards and concurrent START_MATCH persist the full initialized snapshot once", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const clock = { value: FIXED_TIME };
    const options = serviceOptions(clock);
    const guests = await Promise.all([
      createGuest(db, "Owner", options),
      createGuest(db, "Player 2", options),
      createGuest(db, "Player 3", options),
      createGuest(db, "Player 4", options),
    ]);
    const { roomId } = await fillRoom(db, guests, options);
    const repository = new D1StorageRepository(db);
    assert.ok((await repository.getRoom(roomId))!.players.every(player => player.ready), "room creation and JOIN are automatically ready");
    const nonOwnerStart = await sendRoomCommand(db, guests[1]!, options,
      roomCommand("START_MATCH", roomId, 3, {}), roomId);
    assertRejected(nonOwnerStart.body, "ROOM_FORBIDDEN");
    const setRuleset = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("SET_RULESET", roomId, 3, { rulesetVersion: "unsupported" }), roomId);
    assertRejected(setRuleset.body, "COMMAND_UNAVAILABLE");
    const outsider = await createGuest(db, "Outsider", options);
    const nonmemberSetRuleset = await sendRoomCommand(db, outsider, options,
      roomCommand("SET_RULESET", roomId, 3, { rulesetVersion: "unsupported" }), roomId);
    assertRejected(nonmemberSetRuleset.body, "COMMAND_UNAVAILABLE");
    const nonmemberKick = await sendRoomCommand(db, outsider, options,
      roomCommand("KICK_MEMBER", roomId, 3, { targetPlayerId: guests[3]!.playerId }), roomId);
    assertRejected(nonmemberKick.body, "NOT_FOUND_OR_FORBIDDEN");
    const ownerKick = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("KICK_MEMBER", roomId, 3, { targetPlayerId: guests[0]!.playerId }), roomId);
    assertRejected(ownerKick.body, "CANNOT_KICK_SELF");
    const nonOwnerKick = await sendRoomCommand(db, guests[1]!, options,
      roomCommand("KICK_MEMBER", roomId, 3, { targetPlayerId: guests[2]!.playerId }), roomId);
    assertRejected(nonOwnerKick.body, "ROOM_FORBIDDEN");

    const staleReady = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("SET_READY", roomId, 2, { ready: true }), roomId);
    assertRejected(staleReady.body, "STALE_VERSION");
    assert.equal((staleReady.body as { error: { currentVersion: number } }).error.currentVersion, 3);
    const beforeReadyReplay = await repository.getRoom(roomId);
    assert.ok(beforeReadyReplay);
    const readyCommand = roomCommand("SET_READY", roomId, 3, { ready: true });
    const readyResult = await sendRoomCommand(db, guests[0]!, options, readyCommand, roomId);
    const readyView = assertRoomView(readyResult.body);
    assert.equal(readyView.members.find((member) => member.playerId === guests[0]!.playerId)?.ready, true);
    const versionAfterOwnerReady = (await repository.getRoom(roomId))!.version;
    const readyReplay = await sendRoomCommand(db, guests[0]!, options, readyCommand, roomId);
    assertRoomView(readyReplay.body);
    assert.equal((await repository.getRoom(roomId))!.version, versionAfterOwnerReady);

    const versionAfterReady = await readyAll(db, guests.slice(1), options, roomId, versionAfterOwnerReady);
    const beforeStaleStart = {
      matches: await countRows(db, "matches"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const staleStart = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("START_MATCH", roomId, versionAfterReady - 1, {}), roomId);
    assertRejected(staleStart.body, "STALE_VERSION");
    assert.equal((staleStart.body as { error: { currentVersion: number } }).error.currentVersion, versionAfterReady);
    assert.deepEqual({
      matches: await countRows(db, "matches"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeStaleStart);

    // Simulate a room persisted by the previous release; readiness must not gate START_MATCH.
    await db.prepare("UPDATE room_players SET ready = 0 WHERE room_id = ?").bind(roomId).run();
    const beforeConcurrentStart = {
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };

    const startOne = roomCommand("START_MATCH", roomId, versionAfterReady, {});
    const startTwo = roomCommand("START_MATCH", roomId, versionAfterReady, {});
    const [first, second] = await Promise.all([
      sendRoomCommand(db, guests[0]!, options, startOne, roomId),
      sendRoomCommand(db, guests[0]!, options, startTwo, roomId),
    ]);
    const success = [first, second].filter(({ body }) => parseRoomView(body).ok);
    const rejection = [first, second].filter(({ body }) => !parseRoomView(body).ok);
    assert.equal(success.length, 1);
    assert.equal(rejection.length, 1);
    assertRejected(rejection[0]!.body, "STALE_VERSION");
    const room = await repository.getRoom(roomId);
    assert.ok(room);
    assert.equal(room.status, "in_game");
    assert.equal(room.version, versionAfterReady + 1);
    assert.equal(await countRows(db, "matches"), 1);
    assert.equal(await countRows(db, "match_players"), 4);
    assert.equal(await countRows(db, "command_receipts"), beforeConcurrentStart.receipts + 1);
    assert.equal(await countRows(db, "outbox"), beforeConcurrentStart.outbox + 2);

    const startedView = assertRoomView(success[0]!.body);
    assert.equal(startedView.status, "in_game");
    assert.ok(startedView.activeMatchId);
    const match = await repository.getMatch(startedView.activeMatchId);
    assert.ok(match);
    assert.equal(match.status, "playing");
    assert.ok(match.state.version > 0, "initialization and turn-start/draw processing must be persisted");
    assert.equal(
      match.state.turn.phase,
      match.state.resolution.pendingInteraction ? "draw" : "play",
      "the persisted turn phase must reflect completion or a draw-hook interaction from the full initialization flow",
    );
    assert.equal(match.state.turn.currentPlayerId, match.state.seats.find((seat) => seat.private.roleId === "sheriff")?.public.playerId);
    assert.equal(Object.keys(match.state.zones.cardsByInstanceId).length, 80);
    assert.equal(match.state.seats.length, 4);
    assert.equal(match.state.seats.filter((seat) => seat.private.roleId === "sheriff").length, 1);
    assert.deepEqual(
      match.players.map(({ playerId }) => playerId).sort(),
      guests.map(({ playerId }) => playerId).sort(),
    );
    assert.equal((await repository.getLatestMatchIdForRoom(roomId)), match.id);

    const winningCommand = success[0] === first ? startOne : startTwo;
    const beforeReplay = {
      rooms: await countRows(db, "rooms"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const replay = await sendRoomCommand(db, guests[0]!, options, winningCommand, roomId);
    assert.equal(assertRoomView(replay.body).activeMatchId, match.id);
    assert.deepEqual({
      rooms: await countRows(db, "rooms"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeReplay);
    const changedStart = {
      ...(winningCommand as Record<string, unknown>),
      expectedVersion: versionAfterReady + 1,
    };
    const reusedStart = await sendRoomCommand(db, guests[0]!, options, changedStart, roomId);
    assertRejected(reusedStart.body, "COMMAND_ID_REUSED");

    const beforeLockedCommands = {
      matches: await countRows(db, "matches"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const closeInGame = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("CLOSE_ROOM", roomId, room.version, {}), roomId);
    assertRejected(closeInGame.body, "ROOM_LOCKED");
    const secondStart = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("START_MATCH", roomId, room.version, {}), roomId);
    assertRejected(secondStart.body, "ROOM_LOCKED");
    assert.deepEqual({
      matches: await countRows(db, "matches"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeLockedCommands);
  } finally {
    await runtime.dispose();
  }
});

test("completed direct restart and RETURN_TO_LOBBY preserve history, allocate one fresh match, and allow an immediate rematch", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const clock = { value: FIXED_TIME };
    const options = serviceOptions(clock);
    const guests = await Promise.all([
      createGuest(db, "Owner", options),
      createGuest(db, "Player 2", options),
      createGuest(db, "Player 3", options),
      createGuest(db, "Player 4", options),
    ]);
    const { roomId } = await fillRoom(db, guests, options);
    const repository = new D1StorageRepository(db);
    let version = await readyAll(db, guests, options, roomId, 3);
    const firstStartCommand = roomCommand("START_MATCH", roomId, version, {});
    const firstStart = await sendRoomCommand(db, guests[0]!, options, firstStartCommand, roomId);
    const firstRoomView = assertRoomView(firstStart.body);
    assert.equal(firstRoomView.status, "in_game");
    assert.ok(firstRoomView.activeMatchId);
    const oldMatchId = firstRoomView.activeMatchId;
    const oldMatchBeforeCompletion = await repository.getMatch(oldMatchId);
    assert.ok(oldMatchBeforeCompletion);
    await completeMatch(db, repository, oldMatchId);
    const completedOldMatch = await repository.getMatch(oldMatchId);
    assert.ok(completedOldMatch);
    assert.equal(completedOldMatch.status, "completed");
    const oldEvents = await repository.listMatchEvents(oldMatchId);
    assert.equal(oldEvents.length, oldMatchBeforeCompletion.eventSeq + 1);
    assert.equal(oldEvents.at(-1)?.type, "MATCH_FINISHED");
    assert.equal(await repository.getLatestMatchIdForRoom(roomId), oldMatchId);
    const afterFirstStart = await repository.getRoom(roomId);
    assert.ok(afterFirstStart);
    version = afterFirstStart.version;

    const beforeStaleRestart = {
      matches: await countRows(db, "matches"),
      matchPlayers: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const staleRestart = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("START_MATCH", roomId, version - 1, {}), roomId);
    assertRejected(staleRestart.body, "STALE_VERSION");
    assert.deepEqual({
      matches: await countRows(db, "matches"),
      matchPlayers: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeStaleRestart);
    const nonOwnerRestart = await sendRoomCommand(db, guests[1]!, options,
      roomCommand("START_MATCH", roomId, version, {}), roomId);
    assertRejected(nonOwnerRestart.body, "ROOM_FORBIDDEN");

    const restartCommand = roomCommand("START_MATCH", roomId, version, {});
    const restartResponse = await sendRoomCommand(db, guests[0]!, options, restartCommand, roomId);
    const restartView = assertRoomView(restartResponse.body);
    assert.equal(restartView.status, "in_game");
    const newMatchId = restartView.activeMatchId;
    assert.ok(newMatchId);
    assert.notEqual(newMatchId, oldMatchId);
    const restartedRoom = await repository.getRoom(roomId);
    assert.ok(restartedRoom);
    assert.equal(restartedRoom.version, version + 1);
    assert.equal(await repository.getLatestMatchIdForRoom(roomId), newMatchId);
    const newMatch = await repository.getMatch(newMatchId);
    assert.ok(newMatch);
    assert.equal(newMatch.status, "playing");
    assert.equal(Object.keys(newMatch.state.zones.cardsByInstanceId).length, 80);
    assert.deepEqual(
      newMatch.players.map(({ playerId }) => playerId).sort(),
      completedOldMatch.players.map(({ playerId }) => playerId).sort(),
    );
    assert.notDeepEqual(
      Object.keys(newMatch.state.zones.cardsByInstanceId).sort(),
      Object.keys(completedOldMatch.state.zones.cardsByInstanceId).sort(),
    );
    assert.deepEqual(await repository.getMatch(oldMatchId), completedOldMatch);
    assert.deepEqual(await repository.listMatchEvents(oldMatchId), oldEvents);
    assert.equal(await countRows(db, "matches"), 2);
    assert.equal(await countRows(db, "match_players"), 8);
    assert.equal(await countRows(db, "command_receipts"), beforeStaleRestart.receipts + 1);
    assert.equal(await countRows(db, "outbox"), beforeStaleRestart.outbox + 2);

    const restartRowsBeforeReplay = {
      matches: await countRows(db, "matches"),
      matchPlayers: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const restartReplay = await sendRoomCommand(db, guests[0]!, options, restartCommand, roomId);
    assert.equal(assertRoomView(restartReplay.body).activeMatchId, newMatchId);
    assert.deepEqual({
      matches: await countRows(db, "matches"),
      matchPlayers: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, restartRowsBeforeReplay);

    const playingRestart = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("START_MATCH", roomId, restartedRoom.version, {}), roomId);
    assertRejected(playingRestart.body, "ROOM_LOCKED");
    await completeMatch(db, repository, newMatchId);
    const completedNewMatch = await repository.getMatch(newMatchId);
    assert.ok(completedNewMatch);
    const completedEvents = await repository.listMatchEvents(newMatchId);
    assert.equal(completedEvents.length, newMatch.eventSeq + 1);

    const beforeNonOwnerReturn = await countRows(db, "outbox");
    const nonOwnerReturn = await sendRoomCommand(db, guests[1]!, options,
      roomCommand("RETURN_TO_LOBBY", roomId, restartedRoom.version, {}), roomId);
    assertRejected(nonOwnerReturn.body, "NOT_ROOM_OWNER");
    assert.equal(await countRows(db, "outbox"), beforeNonOwnerReturn);

    const returnCommand = roomCommand("RETURN_TO_LOBBY", roomId, restartedRoom.version, {});
    const returned = await sendRoomCommand(db, guests[0]!, options, returnCommand, roomId);
    const lobbyView = assertRoomView(returned.body);
    assert.equal(lobbyView.status, "waiting");
    assert.equal(lobbyView.activeMatchId, null);
    assert.ok(lobbyView.members.every((member) => member.ready));
    const lobbyRoom = await repository.getRoom(roomId);
    assert.ok(lobbyRoom);
    assert.equal(lobbyRoom.version, restartedRoom.version + 1);
    assert.equal(await repository.getLatestMatchIdForRoom(roomId), newMatchId);
    assert.deepEqual(await repository.getMatch(oldMatchId), completedOldMatch);
    assert.deepEqual(await repository.getMatch(newMatchId), completedNewMatch);
    assert.deepEqual(await repository.listMatchEvents(oldMatchId), oldEvents);
    assert.deepEqual(await repository.listMatchEvents(newMatchId), completedEvents);
    const afterReturnStart = await sendRoomCommand(db, guests[0]!, options,
      roomCommand("START_MATCH", roomId, lobbyRoom.version, {}), roomId);
    assert.equal(assertRoomView(afterReturnStart.body).status, "in_game");
    assert.equal(await countRows(db, "matches"), 3);
  } finally {
    await runtime.dispose();
  }
});

test("HTTP origin/content-type/body limits, strict command parsing, and closed-room lifecycle are enforced", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const clock = { value: FIXED_TIME };
    const options = serviceOptions(clock);
    const noOrigin = await handleSessionRoute(request("/api/guest-sessions", {
      body: { protocolVersion: 1, displayName: "Blocked" },
      origin: null,
    }), { DB: db }, options);
    assert.ok(noOrigin);
    assert.equal(noOrigin.status, 403);
    assert.equal(noOrigin.headers.get("Cache-Control"), "no-store");
    const crossOrigin = await handleSessionRoute(request("/api/guest-sessions", {
      body: { protocolVersion: 1, displayName: "Blocked" },
      origin: "https://attacker.test",
    }), { DB: db }, options);
    assert.ok(crossOrigin);
    assert.equal(crossOrigin.status, 403);
    assert.equal(await countRows(db, "guest_sessions"), 0);

    const badContentType = await handleSessionRoute(request("/api/guest-sessions", {
      body: { protocolVersion: 1, displayName: "Blocked" },
      contentType: "text/plain",
    }), { DB: db }, options);
    assert.ok(badContentType);
    assert.equal(badContentType.status, 415);
    const tooLarge = await handleSessionRoute(request("/api/guest-sessions", {
      rawBody: `{"protocolVersion":1,"displayName":"${"x".repeat(8_200)}"}`,
    }), { DB: db }, options);
    assert.ok(tooLarge);
    assert.equal(tooLarge.status, 413);
    const extraGuestField = await handleSessionRoute(request("/api/guest-sessions", {
      body: { protocolVersion: 1, displayName: "Bad shape", token: "should-not-pass" },
    }), { DB: db }, options);
    assert.ok(extraGuestField);
    assert.equal(extraGuestField.status, 400);
    assert.equal(await countRows(db, "guest_sessions"), 0);

    const owner = await createGuest(db, "Owner", options);
    const member = await createGuest(db, "Member", options);
    const crossOriginCreate = await handleRoomsRoute(request("/api/rooms", {
      origin: "https://attacker.test",
      cookie: owner.cookie,
      body: {
        protocolVersion: 1,
        commandId: nextCommandId(),
        expectedVersion: 0,
        type: "CREATE_ROOM",
        payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "blocked" },
      },
    }), { DB: db }, options);
    assert.ok(crossOriginCreate);
    assert.equal(crossOriginCreate.status, 403);
    assert.equal(await countRows(db, "rooms"), 0);
    const room = await createRoom(db, owner, options);
    const strictCommand = roomCommand("JOIN", room.roomId, 0, { inviteCode: room.inviteCode });
    assert.equal(parseRoomCommand(strictCommand).ok, true);
    assert.equal(parseRoomCommand({ ...strictCommand, extra: true }).ok, false);
    const bodyWithExtra = { ...strictCommand, unexpected: "field" };
    const badCommand = await sendRoomCommand(db, member, options, bodyWithExtra, room.roomId);
    assertRejected(badCommand.body, "BAD_REQUEST");
    const mismatchedPath = await sendRoomCommand(db, member, options, strictCommand, "another-room-id");
    assertRejected(mismatchedPath.body, "BAD_REQUEST");

    const closed = await sendRoomCommand(db, owner, options,
      roomCommand("CLOSE_ROOM", room.roomId, 0, {}), room.roomId);
    const closedView = assertRoomView(closed.body);
    assert.equal(closedView.status, "closed");
    const closeVersion = (await new D1StorageRepository(db).getRoom(room.roomId))!.version;
    const closeReplayCommand = roomCommand("CLOSE_ROOM", room.roomId, closeVersion, {});
    const repeatedClose = await sendRoomCommand(db, owner, options, closeReplayCommand, room.roomId);
    assert.equal(assertRoomView(repeatedClose.body).status, "closed");
    assert.equal((await new D1StorageRepository(db).getRoom(room.roomId))!.version, closeVersion);
    const closedJoin = await sendRoomCommand(db, member, options,
      roomCommand("JOIN", room.roomId, closeVersion, { inviteCode: room.inviteCode }), room.roomId);
    assertRejected(closedJoin.body, "ROOM_CLOSED");
    const closedPreview = await handleRoomsRoute(request("/api/rooms/preview", {
      body: { protocolVersion: 1, requestId: "closed-preview", inviteCode: room.inviteCode },
      cookie: member.cookie,
      peerAddress: "192.0.2.54",
    }), { DB: db }, options);
    assert.ok(closedPreview);
    assert.equal(parseRoomPreviewResponse(await json(closedPreview)).ok, true);
    assert.equal(closedPreview.headers.get("Cache-Control"), "no-store");
  } finally {
    await runtime.dispose();
  }
});
