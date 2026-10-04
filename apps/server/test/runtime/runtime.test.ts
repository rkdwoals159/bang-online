import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer as createTcpServer } from "node:net";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { io as createSocketClient, type Socket } from "socket.io-client";
import { parseMatchCommand } from "../../../../packages/contracts/src/validation.ts";
import { createRuntimeServer, startServer } from "../../src/main.ts";
import { readPGliteDevConfig, readServerConfig, ServerConfigurationError } from "../../src/config.ts";
import { withClient } from "../../src/storage/database-runtime.js";
import { StorageRepository } from "../../src/storage/repository.js";
import type { GameState } from "../../../../packages/engine/src/state/types.ts";
import { createDatabase } from "../storage/pglite-pool.ts";

function testConfig(databaseUrl = "postgresql://postgres:postgres@localhost:5432/bang_test") {
  return readServerConfig({
    DATABASE_URL: databaseUrl,
    HOST: "127.0.0.1",
    PORT: "0",
    SESSION_COOKIE_NAME: "bang_session_test",
    WEB_ORIGIN: "http://localhost:5173",
  });
}

function connected(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("connect_error", (error) => reject(error));
  });
}

function acknowledged(socket: Socket, event: string, payload: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${event} acknowledgement.`)), 2_000);
    socket.emit(event, payload, (response: unknown) => {
      clearTimeout(timeout);
      resolve(response);
    });
  });
}

function serverEvent(socket: Socket, event: string, predicate: (payload: unknown) => boolean): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}.`));
    }, 2_000);
    const listener = (payload: unknown) => {
      if (!predicate(payload)) return;
      clearTimeout(timeout);
      socket.off(event, listener);
      resolve(payload);
    };
    socket.on(event, listener);
  });
}

async function availableTcpPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP test port was not assigned.");
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  return address.port;
}

test("startup config reports missing PostgreSQL settings before opening the listener", () => {
  assert.throws(
    () => readServerConfig({}),
    (error: unknown) => error instanceof ServerConfigurationError &&
      error.variable === "DATABASE_URL" && error.message.includes("DATABASE_URL: is required"),
  );
  assert.throws(
    () => readServerConfig({ DATABASE_URL: "https://example.test/db" }),
    (error: unknown) => error instanceof ServerConfigurationError && error.variable === "DATABASE_URL",
  );
  assert.equal(testConfig().port, 0, "port 0 is supported for ephemeral local runtime tests");
  assert.equal(readPGliteDevConfig({}).port, 5433);
  assert.throws(
    () => readPGliteDevConfig({ PGLITE_DATA_DIR: "  " }),
    (error: unknown) => error instanceof ServerConfigurationError && error.variable === "PGLITE_DATA_DIR",
  );
  assert.throws(
    () => readPGliteDevConfig({ PGLITE_PORT: "0" }),
    (error: unknown) => error instanceof ServerConfigurationError && error.variable === "PGLITE_PORT",
  );
});

test("runtime applies migrations, serves guest sessions, authenticates Socket.IO cookies, and shuts down", async () => {
  const { database, pool } = await createDatabase();
  const messages: string[] = [];
  const sockets: Socket[] = [];
  let runtime: Awaited<ReturnType<typeof createRuntimeServer>> | undefined;
  let closePoolCalled = false;

  try {
    runtime = await createRuntimeServer(testConfig(), pool, {
      logger: {
        info: (message) => messages.push(message),
        error: (message) => messages.push(message),
      },
      closePool: async () => { closePoolCalled = true; },
    });
    assert.ok(runtime.port > 0);

    const schema = await withClient(pool, async (client) =>
      client.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version"),
    );
    assert.deepEqual(schema.rows.map(({ version }) => version), [1]);

    const baseUrl = `http://${runtime.host}:${runtime.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const created = await fetch(`${baseUrl}/api/guest-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, displayName: "런타임 확인" }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as {
      protocolVersion: number;
      player: { playerId: string; displayName: string };
      sessionExpiresAt: string;
    };
    assert.equal(session.protocolVersion, 1);
    assert.equal(session.player.displayName, "런타임 확인");
    assert.ok(session.player.playerId.startsWith("p_"));

    const setCookie = created.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)SameSite=Lax(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Path=\/(?:;|$)/i);
    const cookiePair = setCookie.split(";", 1)[0]!;
    const rawCredential = cookiePair.slice(cookiePair.indexOf("=") + 1);
    const bodyText = JSON.stringify(session);
    assert.equal(bodyText.includes(rawCredential), false, "session credential must not be returned in JSON");
    assert.equal(messages.some((message) => message.includes(rawCredential)), false, "session credential must not be logged");

    const noSession = await fetch(`${baseUrl}/api/guest-sessions`);
    assert.equal(noSession.status, 204);
    assert.equal(await noSession.text(), "");
    assert.equal(noSession.headers.get("cache-control"), "no-store");
    const invalidSession = await fetch(`${baseUrl}/api/guest-sessions`, {
      headers: { Cookie: "bang_session_test=invalid" },
    });
    assert.equal(invalidSession.status, 204);
    const duplicateSessionCookie = await fetch(`${baseUrl}/api/guest-sessions`, {
      headers: { Cookie: "bang_session_test=invalid; bang_session_test=invalid" },
    });
    assert.equal(duplicateSessionCookie.status, 204, "ambiguous duplicate credentials do not restore a guest");

    const restoredResponse = await fetch(`${baseUrl}/api/guest-sessions`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(restoredResponse.status, 200);
    assert.equal(restoredResponse.headers.get("cache-control"), "no-store");
    const restoredSession = await restoredResponse.json();
    assert.deepEqual(restoredSession, session);
    assert.equal(JSON.stringify(restoredSession).includes(decodeURIComponent(rawCredential)), false);

    const noSessionRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`);
    assert.equal(noSessionRooms.status, 401);
    assert.deepEqual(await noSessionRooms.json(), { error: { code: "SESSION_EXPIRED" } });
    const invalidSessionRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: "bang_session_test=invalid" },
    });
    assert.equal(invalidSessionRooms.status, 401);
    assert.deepEqual(await invalidSessionRooms.json(), { error: { code: "SESSION_EXPIRED" } });
    const emptyAssignedRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(emptyAssignedRooms.status, 200);
    assert.equal(emptyAssignedRooms.headers.get("cache-control"), "no-store");
    assert.deepEqual(await emptyAssignedRooms.json(), []);

    const authenticated = createSocketClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Cookie: cookiePair },
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(authenticated);
    await connected(authenticated);

    const previewReply = await acknowledged(authenticated, "room:preview", {
      protocolVersion: 1,
      requestId: "runtime-preview",
      inviteCode: "not-a-real-invite",
    });
    assert.deepEqual(previewReply, {
      protocolVersion: 1,
      requestId: "runtime-preview",
      status: "rejected",
      error: { code: "INVITE_INVALID" },
    });

    const createdRoom = await acknowledged(authenticated, "room:create", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-123456789abc",
      expectedVersion: 0,
      type: "CREATE_ROOM",
      payload: {
        capacity: 4,
        rulesetVersion: "base4-ko-online-1.0",
        displayName: "런타임 확인",
      },
    }) as { roomId: string; version: number; inviteCode: string | null; duplicate: boolean };
    assert.equal(createdRoom.version, 0, JSON.stringify(createdRoom));
    assert.equal(createdRoom.duplicate, false);
    assert.equal(typeof createdRoom.roomId, "string");
    assert.equal(typeof createdRoom.inviteCode, "string");

    const ownerAssignedRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: cookiePair },
    });
    assert.equal(ownerAssignedRooms.status, 200);
    assert.equal(ownerAssignedRooms.headers.get("cache-control"), "no-store");
    const ownerRoomViews = await ownerAssignedRooms.json() as Array<{
      roomId: string;
      viewer: { playerId: string; isOwner: boolean };
      members: readonly { playerId: string }[];
    }>;
    assert.equal(ownerRoomViews.length, 1);
    assert.equal(ownerRoomViews[0]?.roomId, createdRoom.roomId);
    assert.deepEqual(ownerRoomViews[0]?.viewer, { playerId: session.player.playerId, isOwner: true });
    assert.deepEqual(ownerRoomViews[0]?.members.map(({ playerId }) => playerId), [session.player.playerId]);
    assert.equal(JSON.stringify(ownerRoomViews).includes(createdRoom.inviteCode!), false, "recovery never returns the invite secret");
    assert.equal(JSON.stringify(ownerRoomViews).includes(decodeURIComponent(rawCredential)), false, "recovery never returns the session secret");

    const secondGuestResponse = await fetch(`${baseUrl}/api/guest-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, displayName: "다른 게스트" }),
    });
    assert.equal(secondGuestResponse.status, 201);
    const secondGuestCookie = secondGuestResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(secondGuestCookie);
    const secondGuestRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: secondGuestCookie },
    });
    assert.equal(secondGuestRooms.status, 200);
    assert.deepEqual(await secondGuestRooms.json(), [], "a different authenticated player cannot recover the owner's room");

    const roomSync = await acknowledged(authenticated, "room:sync", {
      protocolVersion: 1,
      requestId: "runtime-room-sync",
      roomId: createdRoom.roomId,
      knownVersion: 0,
    }) as { room?: { viewer: { playerId: string } } };
    assert.equal(roomSync.room?.viewer.playerId, session.player.playerId);

    const roomChanged = serverEvent(authenticated, "room:changed", (payload) =>
      typeof payload === "object" && payload !== null && "version" in payload && payload.version === 1,
    );
    const readyRoom = await acknowledged(authenticated, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-123456789abd",
      expectedVersion: 0,
      roomId: createdRoom.roomId,
      type: "SET_READY",
      payload: { ready: true },
    }) as { members?: readonly { playerId: string; ready: boolean }[] };
    assert.equal(readyRoom.members?.[0]?.ready, true);
    assert.deepEqual(await roomChanged, { roomId: createdRoom.roomId, version: 1 });

    const pendingOutbox = await withClient(pool, async (client) =>
      client.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox WHERE published_at IS NULL"),
    );
    assert.equal(pendingOutbox.rows[0]?.count, "0");

    const anonymous = createSocketClient(baseUrl, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(anonymous);
    await assert.rejects(connected(anonymous), /UNAUTHENTICATED/);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await runtime?.close();
    await database.close();
  }
  assert.ok(messages.some((message) => message.includes("Database schema ready")));
  assert.equal(closePoolCalled, true, "shutdown closes the pool owned by the runtime");
});

test("START_MATCH enforces the ready owner roster, persists once, and syncs the exact match route", async () => {
  const { database, pool } = await createDatabase();
  const sockets: Socket[] = [];
  let runtime: Awaited<ReturnType<typeof createRuntimeServer>> | undefined;

  try {
    runtime = await createRuntimeServer(testConfig(), pool, {
      logger: { info: () => undefined, error: () => undefined },
      closePool: async () => undefined,
    });
    const baseUrl = `http://${runtime.host}:${runtime.port}`;

    const guests: Array<{
      playerId: string;
      cookiePair: string;
      socket: Socket;
    }> = [];
    for (const displayName of ["Start Owner", "Start Member 1", "Start Member 2", "Start Member 3", "Not Seated"]) {
      const response = await fetch(`${baseUrl}/api/guest-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, displayName }),
      });
      assert.equal(response.status, 201);
      const session = await response.json() as { player: { playerId: string } };
      const cookiePair = response.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookiePair);
      const socket = createSocketClient(baseUrl, {
        transports: ["websocket"],
        extraHeaders: { Cookie: cookiePair },
        reconnection: false,
        timeout: 2_000,
      });
      sockets.push(socket);
      await connected(socket);
      guests.push({ playerId: session.player.playerId, cookiePair, socket });
    }

    const owner = guests[0]!;
    const created = await acknowledged(owner.socket, "room:create", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-223456789abc",
      expectedVersion: 0,
      type: "CREATE_ROOM",
      payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "Start Owner" },
    }) as { roomId: string; version: number; inviteCode: string };
    assert.equal(created.version, 0);
    assert.ok(created.inviteCode);

    const lobbySync = await acknowledged(owner.socket, "room:sync", {
      protocolVersion: 1,
      requestId: "start-lobby-before-join",
      roomId: created.roomId,
      knownVersion: 0,
    }) as { room?: { activeMatchId: string | null } };
    assert.equal(lobbySync.room?.activeMatchId, null);

    let roomVersion = created.version;
    for (let index = 1; index < 4; index += 1) {
      const joined = await acknowledged(guests[index]!.socket, "room:command", {
        protocolVersion: 1,
        commandId: `018f8e3d-7b11-7c82-8a7b-223456789ab${index}`,
        expectedVersion: roomVersion,
        roomId: created.roomId,
        type: "JOIN",
        payload: { inviteCode: created.inviteCode },
      }) as { members?: readonly { playerId: string }[] };
      assert.equal(joined.members?.length, index + 1);
      roomVersion += 1;
    }

    const rejectedStart = async (socket: Socket, commandId: string, expectedVersion: number) =>
      await acknowledged(socket, "room:command", {
        protocolVersion: 1,
        commandId,
        expectedVersion,
        roomId: created.roomId,
        type: "START_MATCH",
        payload: {},
      }) as { status?: string; error?: { code: string; currentVersion?: number } };

    const notReady = await rejectedStart(owner.socket, "018f8e3d-7b11-7c82-8a7b-323456789abc", roomVersion);
    assert.equal(notReady.status, "rejected");
    assert.equal(notReady.error?.code, "ROOM_NOT_READY");
    const notOwner = await rejectedStart(guests[1]!.socket, "018f8e3d-7b11-7c82-8a7b-423456789abc", roomVersion);
    assert.equal(notOwner.status, "rejected");
    assert.equal(notOwner.error?.code, "ROOM_FORBIDDEN");
    const notMember = await rejectedStart(guests[4]!.socket, "018f8e3d-7b11-7c82-8a7b-523456789abc", roomVersion);
    assert.equal(notMember.status, "rejected");
    assert.equal(notMember.error?.code, "NOT_FOUND_OR_FORBIDDEN");
    const stale = await rejectedStart(owner.socket, "018f8e3d-7b11-7c82-8a7b-623456789abc", roomVersion - 1);
    assert.equal(stale.status, "rejected");
    assert.equal(stale.error?.code, "STALE_VERSION");
    assert.equal(stale.error?.currentVersion, roomVersion);

    const rejectedReceipts = await withClient(pool, (client) =>
      client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM command_receipts WHERE command_id = ANY($1::text[])",
        [[
          "018f8e3d-7b11-7c82-8a7b-323456789abc",
          "018f8e3d-7b11-7c82-8a7b-423456789abc",
          "018f8e3d-7b11-7c82-8a7b-523456789abc",
          "018f8e3d-7b11-7c82-8a7b-623456789abc",
        ]],
      ),
    );
    assert.equal(rejectedReceipts.rows[0]?.count, "0");

    for (let index = 0; index < 4; index += 1) {
      const ready = await acknowledged(guests[index]!.socket, "room:command", {
        protocolVersion: 1,
        commandId: `018f8e3d-7b11-7c82-8a7b-723456789ab${index}`,
        expectedVersion: roomVersion,
        roomId: created.roomId,
        type: "SET_READY",
        payload: { ready: true },
      }) as { members?: readonly { playerId: string; ready: boolean }[] };
      assert.equal(ready.members?.find(({ playerId }) => playerId === guests[index]!.playerId)?.ready, true);
      roomVersion += 1;
    }

    const startCommandId = "018f8e3d-7b11-7c82-8a7b-823456789abc";
    const startPayload = {
      protocolVersion: 1,
      commandId: startCommandId,
      expectedVersion: roomVersion,
      roomId: created.roomId,
      type: "START_MATCH",
      payload: {},
    };
    const started = await acknowledged(owner.socket, "room:command", startPayload) as {
      roomId: string;
      status: string;
      activeMatchId: string | null;
      members: readonly { playerId: string; ready: boolean }[];
    };
    assert.equal(started.roomId, created.roomId);
    assert.equal(started.status, "in_game");
    assert.ok(started.activeMatchId);
    const matchId = started.activeMatchId;
    assert.ok(started.members.every(({ ready }) => ready));
    const startedRoomVersion = roomVersion + 1;

    const duplicate = await acknowledged(owner.socket, "room:command", startPayload) as {
      status: string;
      activeMatchId: string | null;
    };
    assert.equal(duplicate.status, "in_game");
    assert.equal(duplicate.activeMatchId, matchId);

    const locked = await rejectedStart(owner.socket, "018f8e3d-7b11-7c82-8a7b-923456789abc", roomVersion + 1);
    assert.equal(locked.status, "rejected");
    assert.equal(locked.error?.code, "ROOM_LOCKED");
    const lockedReceiptCount = await withClient(pool, async (client) => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [owner.playerId, "018f8e3d-7b11-7c82-8a7b-923456789abc"],
    ));
    assert.equal(lockedReceiptCount.rows[0]?.count, "0");

    const synchronized = await acknowledged(guests[2]!.socket, "room:sync", {
      protocolVersion: 1,
      requestId: "start-room-sync-after-start",
      roomId: created.roomId,
      knownVersion: roomVersion,
    }) as { version: number; room: { activeMatchId: string | null } };
    assert.equal(synchronized.version, roomVersion + 1);
    assert.equal(synchronized.room.activeMatchId, matchId);

    const restoredRooms = await fetch(`${baseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: owner.cookiePair },
    });
    assert.equal(restoredRooms.status, 200);
    const restored = await restoredRooms.json() as Array<{ roomId: string; activeMatchId: string | null }>;
    assert.equal(restored.find(({ roomId }) => roomId === created.roomId)?.activeMatchId, matchId);

    // Kit/Jesse/Pedro can legitimately pause the initial draw. Complete their
    // canonical private prompt before expecting the play phase.
    for (let attempt = 0; attempt < 4; attempt++) {
      const initial = await withClient(pool, client => client.query<{ state_json: GameState }>(
        "SELECT state_json FROM matches WHERE id = $1", [matchId]));
      const state = initial.rows[0]!.state_json;
      if (state.turn.phase === "play") break;
      const responder = guests.find(guest => guest.playerId === state.resolution.pendingInteraction?.actorPlayerIds[0]);
      assert.ok(responder);
      const sync = await acknowledged(responder.socket, "match:sync", {
        protocolVersion: 1, requestId: `initial-draw-${attempt}`, matchId, knownVersion: 0, afterEventSeq: 0,
      }) as { snapshot: { pendingInteraction: { responseOptions: readonly Record<string, unknown>[] } } };
      const option = sync.snapshot.pendingInteraction.responseOptions[0];
      assert.ok(option);
      const ack = await acknowledged(responder.socket, "match:command", {
        protocolVersion: 1, commandId: globalThis.crypto.randomUUID(), matchId, expectedVersion: state.version,
        type: "RESPOND", payload: option,
      }) as { status: string };
      assert.equal(ack.status, "accepted");
    }

    const stored = await withClient(pool, async (client) => client.query<{ id: string; state_json: { turn: { phase: string } } }>(
      "SELECT id, state_json FROM matches WHERE room_id = $1",
      [created.roomId],
    ));
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0]?.id, matchId);
    assert.equal(stored.rows[0]?.state_json.turn.phase, "play");
    const startReceiptCount = await withClient(pool, async (client) => client.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [owner.playerId, startCommandId],
    ));
    assert.equal(startReceiptCount.rows[0]?.count, "1");

    const matchStorage = new StorageRepository(pool);
    const beforeTurn = await matchStorage.getMatch(matchId);
    assert.ok(beforeTurn);
    assert.equal(beforeTurn.state.turn.phase, "play");
    const orderedSeats = [...beforeTurn.state.seats].sort((left, right) => left.public.seatIndex - right.public.seatIndex);
    const actingSeatIndex = orderedSeats.findIndex((seat) => seat.public.playerId === beforeTurn.state.turn.currentPlayerId);
    const nextActor = orderedSeats[(actingSeatIndex + 1) % orderedSeats.length]!;
    const actorSocket = guests.find(({ playerId }) => playerId === beforeTurn.state.turn.currentPlayerId)?.socket;
    assert.ok(actorSocket, "the current turn actor has an authenticated socket");
    const nextActorHandCount = nextActor.private.handCardInstanceIds.length;
    const endTurnId = "018f8e3d-7b11-7c82-8a7b-a00000000001";
    const endTurnAck = await acknowledged(actorSocket, "match:command", {
      protocolVersion: 1,
      commandId: endTurnId,
      matchId,
      expectedVersion: beforeTurn.version,
      type: "END_TURN",
      payload: {},
    }) as { status?: string; aggregateVersion?: number; error?: { code: string } };
    assert.equal(endTurnAck.status, "accepted", JSON.stringify(endTurnAck));
    assert.equal(endTurnAck.aggregateVersion, beforeTurn.version + 1);

    let afterTurn = await matchStorage.getMatch(matchId);
    assert.ok(afterTurn);
    let responseSequence = 0;
    while (afterTurn.state.resolution.pendingInteraction !== null) {
      const pending = afterTurn.state.resolution.pendingInteraction;
      const option = pending.options[0];
      assert.ok(option, `pending ${pending.kind} has a continuation choice`);
      const responderId = pending.actorPlayerIds[0];
      assert.ok(responderId);
      const responderSocket = guests.find(({ playerId }) => playerId === responderId)?.socket;
      assert.ok(responderSocket, "the pending interaction responder has an authenticated socket");
      const responseId = `018f8e3d-7b11-7c82-8a7b-a1000000000${++responseSequence}`;
      let payload: Record<string, unknown> = { interactionId: pending.interactionId, choice: option.choice, ...option.payload };
      if (pending.kind === "DISCARDS_ORDER") {
        const spec = pending.context.discardOrder;
        assert.ok(typeof spec === "object" && spec !== null && !Array.isArray(spec));
        const order = spec as { allowedCardInstanceIds?: unknown; requiredCount?: unknown };
        assert.ok(Array.isArray(order.allowedCardInstanceIds));
        assert.ok(typeof order.requiredCount === "number");
        payload = {
          interactionId: pending.interactionId,
          choice: "ORDER_CARDS",
          orderedCardInstanceIds: order.allowedCardInstanceIds.slice(0, order.requiredCount),
        };
      }
      const responseCommand = {
        protocolVersion: 1,
        commandId: responseId,
        matchId,
        expectedVersion: afterTurn.version,
        type: "RESPOND",
        payload,
      };
      const parsedResponse = parseMatchCommand(responseCommand);
      assert.equal(parsedResponse.ok, true, JSON.stringify({
        pendingKind: pending.kind,
        option,
        responseCommand,
        parseFailure: parsedResponse.ok ? null : parsedResponse.path,
      }));
      const responseAck = await acknowledged(responderSocket, "match:command", responseCommand) as { status?: string; aggregateVersion?: number; error?: { code: string } };
      assert.equal(responseAck.status, "accepted", JSON.stringify({ pendingKind: pending.kind, option, responseCommand, responseAck }));
      assert.equal(responseAck.aggregateVersion, afterTurn.version + 1);
      afterTurn = await matchStorage.getMatch(matchId);
      assert.ok(afterTurn);
      assert.ok(responseSequence < 5, "turn-start and draw prompts resume without an unbounded interaction loop");
    }
    assert.equal(afterTurn.state.status, "playing");
    assert.equal(afterTurn.state.turn.currentPlayerId, nextActor.public.playerId);
    assert.equal(afterTurn.state.turn.phase, "play");
    assert.equal(afterTurn.state.seats.find((seat) => seat.public.playerId === nextActor.public.playerId)?.private.handCardInstanceIds.length, nextActorHandCount + 2);
    assert.equal(afterTurn.version, beforeTurn.version + 1 + responseSequence);

    const readReturnBoundary = async () => withClient(pool, async (client) => {
      const room = await client.query<{ status: string; version: string; owner_player_id: string }>(
        "SELECT status, version::text, owner_player_id FROM rooms WHERE id = $1",
        [created.roomId],
      );
      const roomSeats = await client.query<{ player_id: string; seat_index: number; ready: boolean }>(
        "SELECT player_id, seat_index, ready FROM room_players WHERE room_id = $1 ORDER BY seat_index",
        [created.roomId],
      );
      const match = await client.query<{ id: string; status: string; version: string; state_json: Record<string, unknown> }>(
        "SELECT id, status, version::text, state_json FROM matches WHERE id = $1",
        [matchId],
      );
      const events = await client.query(
        "SELECT event_seq, event_id, version, type, actor_player_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
        [matchId],
      );
      const receipts = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM command_receipts WHERE room_id = $1",
        [created.roomId],
      );
      const outbox = await client.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = $1",
        [created.roomId],
      );
      return {
        room: room.rows[0],
        roomSeats: roomSeats.rows,
        match: match.rows[0],
        events: events.rows,
        receiptCount: receipts.rows[0]?.count,
        roomOutboxCount: outbox.rows[0]?.count,
      };
    });

    const beforeReturn = await readReturnBoundary();
    const rejectReturn = async (socket: Socket, commandId: string, expectedVersion: number) =>
      await acknowledged(socket, "room:command", {
        protocolVersion: 1,
        commandId,
        expectedVersion,
        roomId: created.roomId,
        type: "RETURN_TO_LOBBY",
        payload: {},
      }) as { status?: string; error?: { code: string; currentVersion?: number } };
    const whilePlaying = await rejectReturn(owner.socket, "018f8e3d-7b11-7c82-8a7b-b10000000001", startedRoomVersion);
    assert.equal(whilePlaying.status, "rejected");
    assert.equal(whilePlaying.error?.code, "ROOM_LOCKED");
    const outsiderReturn = await rejectReturn(guests[4]!.socket, "018f8e3d-7b11-7c82-8a7b-b20000000001", startedRoomVersion);
    assert.equal(outsiderReturn.status, "rejected");
    assert.equal(outsiderReturn.error?.code, "NOT_FOUND_OR_FORBIDDEN");
    assert.deepEqual(await readReturnBoundary(), beforeReturn, "playing and non-member denials do not write room or match data");
    const playingKick = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-b70000000001",
      expectedVersion: startedRoomVersion,
      roomId: created.roomId,
      type: "KICK_MEMBER",
      payload: { targetPlayerId: guests[3]!.playerId },
    }) as { status?: string; error?: { code: string } };
    assert.equal(playingKick.status, "rejected");
    assert.equal(playingKick.error?.code, "ROOM_LOCKED");
    assert.deepEqual(await readReturnBoundary(), beforeReturn, "in-game kick remains locked before returning to the lobby");

    await withClient(pool, (client) => client.query(
      `UPDATE matches
       SET status = 'completed', state_json = jsonb_set(state_json, '{status}', '"completed"'::jsonb), ended_at = now()
       WHERE id = $1`,
      [matchId],
    ));
    const completedMatch = await matchStorage.getMatch(matchId);
    assert.ok(completedMatch);
    const beforeCompletedReturn = await readReturnBoundary();
    const nonOwnerReturn = await rejectReturn(guests[1]!.socket, "018f8e3d-7b11-7c82-8a7b-b30000000001", startedRoomVersion);
    assert.equal(nonOwnerReturn.status, "rejected");
    assert.equal(nonOwnerReturn.error?.code, "NOT_ROOM_OWNER");
    const staleReturn = await rejectReturn(owner.socket, "018f8e3d-7b11-7c82-8a7b-b40000000001", startedRoomVersion - 1);
    assert.equal(staleReturn.status, "rejected");
    assert.equal(staleReturn.error?.code, "STALE_VERSION");
    assert.equal(staleReturn.error?.currentVersion, startedRoomVersion);
    assert.deepEqual(await readReturnBoundary(), beforeCompletedReturn, "authorization and stale denials do not write room or match data");

    const returnCommand = {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-b50000000001",
      expectedVersion: startedRoomVersion,
      roomId: created.roomId,
      type: "RETURN_TO_LOBBY",
      payload: {},
    };
    const returned = await acknowledged(owner.socket, "room:command", returnCommand) as {
      roomId: string;
      status: string;
      activeMatchId: string | null;
      ownerPlayerId: string;
      members: readonly { playerId: string; seatIndex: number; ready: boolean }[];
      viewer: { playerId: string; isOwner: boolean };
    };
    assert.equal(returned.roomId, created.roomId);
    assert.equal(returned.status, "waiting");
    assert.equal(returned.activeMatchId, null);
    assert.equal(returned.ownerPlayerId, owner.playerId);
    assert.equal(returned.viewer.isOwner, true);
    assert.deepEqual(returned.members.map(({ playerId, seatIndex, ready }) => ({ playerId, seatIndex, ready })),
      beforeCompletedReturn.roomSeats.map(({ player_id, seat_index }) => ({ playerId: player_id, seatIndex: seat_index, ready: false })));

    const duplicateReturn = await acknowledged(owner.socket, "room:command", returnCommand) as typeof returned;
    assert.deepEqual(duplicateReturn, returned);
    const synchronizedAfterReturn = await acknowledged(owner.socket, "room:sync", {
      protocolVersion: 1,
      requestId: "return-lobby-sync",
      roomId: created.roomId,
      knownVersion: startedRoomVersion + 1,
    }) as { version: number; requiresFullSnapshot: boolean; room: typeof returned };
    assert.equal(synchronizedAfterReturn.version, startedRoomVersion + 1);
    assert.equal(synchronizedAfterReturn.requiresFullSnapshot, false);
    assert.equal(synchronizedAfterReturn.room.status, "waiting");
    assert.equal(synchronizedAfterReturn.room.activeMatchId, null);
    assert.ok(synchronizedAfterReturn.room.members.every(({ ready }) => !ready));
    assert.deepEqual(await matchStorage.getMatch(matchId), completedMatch, "return preserves completed match snapshot");
    const afterReturn = await readReturnBoundary();
    assert.equal(afterReturn.room?.status, "waiting");
    assert.equal(afterReturn.room?.version, String(startedRoomVersion + 1));
    assert.deepEqual(afterReturn.events, beforeCompletedReturn.events, "return preserves completed match events");
    assert.equal(afterReturn.roomOutboxCount, String(Number(beforeCompletedReturn.roomOutboxCount) + 1));
    const returnedOutbox = await withClient(pool, (client) => client.query<{ kind: string; payload_json: Record<string, unknown> }>(
      "SELECT kind, payload_json FROM outbox WHERE aggregate_id = $1 AND aggregate_version = $2",
      [created.roomId, startedRoomVersion + 1],
    ));
    assert.deepEqual(returnedOutbox.rows, [{ kind: "room:changed", payload_json: { roomId: created.roomId, version: startedRoomVersion + 1 } }]);
    const startAfterReturn = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-b60000000001",
      expectedVersion: startedRoomVersion + 1,
      roomId: created.roomId,
      type: "START_MATCH",
      payload: {},
    }) as { status?: string; error?: { code: string } };
    assert.equal(startAfterReturn.status, "rejected");
    assert.equal(startAfterReturn.error?.code, "ROOM_NOT_READY");

    const readKickBoundary = async () => withClient(pool, async (client) => {
      const room = await client.query<{ version: string }>("SELECT version::text AS version FROM rooms WHERE id = $1", [created.roomId]);
      const match = await client.query<{ version: string }>("SELECT version::text AS version FROM matches WHERE id = $1", [matchId]);
      const roomSeats = await client.query<{ player_id: string; seat_index: number }>(
        "SELECT player_id, seat_index FROM room_players WHERE room_id = $1 ORDER BY seat_index", [created.roomId],
      );
      const matchSeats = await client.query<{ player_id: string; seat_index: number }>(
        "SELECT player_id, seat_index FROM match_players WHERE match_id = $1 ORDER BY seat_index", [matchId],
      );
      return { roomVersion: room.rows[0]?.version, matchVersion: match.rows[0]?.version, roomSeats: roomSeats.rows, matchSeats: matchSeats.rows };
    });
    const beforeKick = await readKickBoundary();
    const outsiderKick = await acknowledged(guests[4]!.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-a20000000001",
      expectedVersion: Number(beforeKick.roomVersion),
      roomId: created.roomId,
      type: "KICK_MEMBER",
      payload: { targetPlayerId: guests[3]!.playerId },
    }) as { status?: string; error?: { code: string } };
    assert.equal(outsiderKick.status, "rejected");
    assert.equal(outsiderKick.error?.code, "NOT_FOUND_OR_FORBIDDEN");
    const ownerKick = await acknowledged(owner.socket, "room:command", {
      protocolVersion: 1,
      commandId: "018f8e3d-7b11-7c82-8a7b-a20000000002",
      expectedVersion: Number(beforeKick.roomVersion),
      roomId: created.roomId,
      type: "KICK_MEMBER",
      payload: { targetPlayerId: guests[3]!.playerId },
    }) as { status?: string; error?: { code: string } };
    assert.equal(ownerKick.status, "rejected");
    assert.equal(ownerKick.error?.code, "COMMAND_UNAVAILABLE");
    assert.deepEqual(await readKickBoundary(), beforeKick, "lobby KICK_MEMBER remains unavailable and preserves versions and seats");
  } finally {
    for (const socket of sockets) socket.disconnect();
    await runtime?.close();
    await database.close();
  }
});

test("node-postgres runtime uses PGlite Socket and preserves sessions and migrations across database restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "bang-server-pglite-runtime-"));
  const databasePort = await availableTcpPort();
  const databaseUrl = `postgresql://pglite:pglite@127.0.0.1:${databasePort}/postgres`;
  const config = testConfig(databaseUrl);
  const messages: string[] = [];
  const logger = {
    info: (message: string) => messages.push(message),
    error: (message: string) => messages.push(message),
  };
  const sockets: Socket[] = [];
  let database: PGlite | undefined;
  let databaseSocket: PGLiteSocketServer | undefined;
  let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
  let cookiePair: string | undefined;
  let rawCredential: string | undefined;

  const startDatabaseSocket = async () => {
    database = new PGlite(dataDir);
    await database.waitReady;
    databaseSocket = new PGLiteSocketServer({
      db: database,
      host: "127.0.0.1",
      port: databasePort,
      maxConnections: 1,
    });
    await databaseSocket.start();
  };

  try {
    await startDatabaseSocket();
    runtime = await startServer(config, logger, 1);
    const baseUrl = `http://${runtime.host}:${runtime.port}`;
    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });

    const created = await fetch(`${baseUrl}/api/guest-sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocolVersion: 1, displayName: "소켓 저장 확인" }),
    });
    assert.equal(created.status, 201);
    const session = await created.json() as { player: { playerId: string; displayName: string } };
    assert.equal(session.player.displayName, "소켓 저장 확인");
    assert.ok(session.player.playerId.startsWith("p_"));

    const setCookie = created.headers.get("set-cookie");
    assert.ok(setCookie);
    assert.match(setCookie, /(?:^|;\s*)HttpOnly(?:;|$)/i);
    assert.match(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
    cookiePair = setCookie.split(";", 1)[0]!;
    rawCredential = decodeURIComponent(cookiePair.slice(cookiePair.indexOf("=") + 1));
    assert.equal(JSON.stringify(session).includes(rawCredential), false);
    assert.equal(messages.some((message) => message.includes(rawCredential)), false);

    const authenticated = createSocketClient(baseUrl, {
      transports: ["websocket"],
      extraHeaders: { Cookie: cookiePair },
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(authenticated);
    await connected(authenticated);
    assert.deepEqual(await acknowledged(authenticated, "room:preview", {
      protocolVersion: 1,
      requestId: "pglite-preview-before-restart",
      inviteCode: "not-a-real-invite",
    }), {
      protocolVersion: 1,
      requestId: "pglite-preview-before-restart",
      status: "rejected",
      error: { code: "INVITE_INVALID" },
    });

    const anonymous = createSocketClient(baseUrl, {
      transports: ["websocket"],
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(anonymous);
    await assert.rejects(connected(anonymous), /UNAUTHENTICATED/);

    await runtime.close();
    runtime = undefined;
    await databaseSocket.stop();
    databaseSocket = undefined;
    await database.close();
    database = undefined;

    // Reopen the same on-disk directory as a fresh PGlite instance and fresh PostgreSQL-wire listener.
    await startDatabaseSocket();
    runtime = await startServer(config, logger, 1);
    const restartedBaseUrl = `http://${runtime.host}:${runtime.port}`;
    const restartedHealth = await fetch(`${restartedBaseUrl}/healthz`);
    assert.equal(restartedHealth.status, 200);

    const restoredAfterRestart = await fetch(`${restartedBaseUrl}/api/guest-sessions`, {
      headers: { Cookie: cookiePair! },
    });
    assert.equal(restoredAfterRestart.status, 200);
    assert.equal(restoredAfterRestart.headers.get("cache-control"), "no-store");
    const restoredAfterRestartSession = await restoredAfterRestart.json() as {
      player: { playerId: string; displayName: string };
    };
    assert.deepEqual(restoredAfterRestartSession.player, session.player);
    const restoredAfterRestartRooms = await fetch(`${restartedBaseUrl}/api/guest-sessions/rooms`, {
      headers: { Cookie: cookiePair! },
    });
    assert.equal(restoredAfterRestartRooms.status, 200);
    assert.deepEqual(await restoredAfterRestartRooms.json(), []);

    const restored = createSocketClient(restartedBaseUrl, {
      transports: ["websocket"],
      extraHeaders: { Cookie: cookiePair! },
      reconnection: false,
      timeout: 2_000,
    });
    sockets.push(restored);
    await connected(restored);
    assert.deepEqual(await acknowledged(restored, "room:preview", {
      protocolVersion: 1,
      requestId: "pglite-preview-after-restart",
      inviteCode: "not-a-real-invite",
    }), {
      protocolVersion: 1,
      requestId: "pglite-preview-after-restart",
      status: "rejected",
      error: { code: "INVITE_INVALID" },
    });

    await runtime.close();
    runtime = undefined;
    const migrations = await database!.query<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(migrations.rows.map(({ version }) => version), [1]);
    const guests = await database!.query<{ token_hash: string }>(
      "SELECT token_hash FROM guest_sessions",
    );
    assert.equal(guests.rows.length, 1);
    assert.notEqual(guests.rows[0]?.token_hash, rawCredential);
    assert.equal(messages.some((message) => message.includes(rawCredential!)), false);
  } finally {
    for (const socket of sockets) socket.disconnect();
    await runtime?.close();
    await databaseSocket?.stop().catch(() => undefined);
    await database?.close().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  }
});
