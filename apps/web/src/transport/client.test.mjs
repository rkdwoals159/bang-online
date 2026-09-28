import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserGameTransport, BrowserTransportError } from "./client.ts";
import { BrowserTransportStore } from "./state.ts";

function roomView(roomId, { version = 1, displayName = "Player One", activeMatchId = null } = {}) {
  return {
    roomId,
    status: activeMatchId ? "in_game" : "waiting",
    activeMatchId,
    ownerPlayerId: "player-1",
    capacity: 4,
    rulesetVersion: "base4-ko-online-1.0",
    members: [{ playerId: "player-1", displayName, seatIndex: 0, ready: false }],
    viewer: { playerId: "player-1", isOwner: true },
  };
}

function roomSync(request, { version = 1, displayName = "Player One", activeMatchId = null } = {}) {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    roomId: request.roomId,
    version,
    requiresFullSnapshot: true,
    room: roomView(request.roomId, { version, displayName, activeMatchId }),
  };
}

function matchSync(request, { version = 1, eventSeq = 1 } = {}) {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    matchId: request.matchId,
    version,
    eventSeq,
    requiresFullSnapshot: true,
    snapshot: {
      status: "playing",
      viewer: { playerId: "player-1", seatIndex: 0, mode: "active" },
      publicTable: {
        players: [{
          playerId: "player-1",
          displayName: "Player One",
          seatIndex: 0,
          characterId: "bart-cassidy",
          hp: 4,
          maxHp: 4,
          eliminated: false,
          handCount: 4,
          role: "sheriff",
          inPlay: [],
        }],
        turn: { currentPlayerId: "player-1", phase: "PLAY" },
        deckCount: 70,
        publicDiscard: { topCard: null, count: 0 },
      },
      selfPrivate: { role: "sheriff", hand: [] },
      legalActions: [],
      pendingInteraction: null,
    },
    visibleEvents: [],
  };
}

class FakeSocket {
  connected = false;
  listeners = new Map();
  emitted = [];
  onEmit = () => {};

  connect() {
    this.connected = true;
    this.fire("connect");
  }

  disconnect() {
    const wasConnected = this.connected;
    this.connected = false;
    if (wasConnected) this.fire("disconnect");
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event, payload, acknowledgement) {
    const item = { event, payload, acknowledgement };
    this.emitted.push(item);
    this.onEmit(item);
  }

  fire(event, payload) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function countEmits(socket, event) {
  return socket.emitted.filter((item) => item.event === event).length;
}

test("outbox notifications trigger sync and duplicate or older hints do not update projections", async () => {
  const socket = new FakeSocket();
  let roomVersion = 2;
  let matchVersion = 4;
  let matchEventSeq = 6;
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "room:sync") acknowledgement(roomSync(payload, { version: roomVersion }));
    if (event === "match:sync") acknowledgement(matchSync(payload, { version: matchVersion, eventSeq: matchEventSeq }));
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  transport.watchRoom("room-1");
  transport.watchMatch("match-1");
  transport.connect();

  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 2 &&
    transport.getSnapshot().matches["match-1"]?.eventSeq === 6, "initial room and match sync did not finish");
  const roomSyncCount = countEmits(socket, "room:sync");
  const matchSyncCount = countEmits(socket, "match:sync");
  const priorRoom = transport.getSnapshot().rooms["room-1"].room;
  const priorMatch = transport.getSnapshot().matches["match-1"].snapshot;

  socket.fire("room:changed", { roomId: "room-1", version: 2 });
  socket.fire("room:changed", { roomId: "room-1", version: 1 });
  socket.fire("room:changed", { roomId: "room-1", version: 99, room: roomView("room-1", { displayName: "forged" }) });
  socket.fire("match:changed", { matchId: "match-1", version: 4, eventSeq: 6 });
  socket.fire("match:changed", { matchId: "match-1", version: 3, eventSeq: 99 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(countEmits(socket, "room:sync"), roomSyncCount);
  assert.equal(countEmits(socket, "match:sync"), matchSyncCount);
  assert.equal(transport.getSnapshot().rooms["room-1"].room, priorRoom);
  assert.equal(transport.getSnapshot().matches["match-1"].snapshot, priorMatch);

  roomVersion = 3;
  socket.fire("room:changed", { roomId: "room-1", version: 3 });
  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 3, "new room hint did not sync");
  matchVersion = 5;
  matchEventSeq = 7;
  socket.fire("match:changed", { matchId: "match-1", version: 5, eventSeq: 7 });
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.version === 5, "new match hint did not sync");
  assert.ok(countEmits(socket, "room:sync") > roomSyncCount);
  assert.ok(countEmits(socket, "match:sync") > matchSyncCount);
});

test("projection store rejects duplicate and out-of-order sync responses", () => {
  const store = new BrowserTransportStore();
  const firstRoom = roomSync({ requestId: "room-1", roomId: "room-1" }, { version: 7 });
  assert.equal(store.applyRoomSync(firstRoom), true);
  const duplicateRoom = roomSync({ requestId: "room-2", roomId: "room-1" }, { version: 7, displayName: "stale" });
  assert.equal(store.applyRoomSync(duplicateRoom), false);
  const unchangedRoom = roomSync({ requestId: "room-2b", roomId: "room-1" }, { version: 7 });
  unchangedRoom.requiresFullSnapshot = false;
  assert.equal(store.applyRoomSync(unchangedRoom), true);
  assert.equal(store.getSnapshot().rooms["room-1"].requiresFullSnapshot, false);
  const olderRoom = roomSync({ requestId: "room-3", roomId: "room-1" }, { version: 6, displayName: "older" });
  assert.equal(store.applyRoomSync(olderRoom), false);
  assert.equal(store.getSnapshot().rooms["room-1"].room.members[0].displayName, "Player One");

  assert.equal(store.applyMatchSync(matchSync({ requestId: "match-1", matchId: "match-1" }, { version: 7, eventSeq: 9 })), true);
  const unchangedMatch = matchSync({ requestId: "match-1b", matchId: "match-1" }, { version: 7, eventSeq: 9 });
  unchangedMatch.requiresFullSnapshot = false;
  assert.equal(store.applyMatchSync(unchangedMatch), true);
  assert.equal(store.getSnapshot().matches["match-1"].requiresFullSnapshot, false);
  assert.equal(store.applyMatchSync(matchSync({ requestId: "match-2", matchId: "match-1" }, { version: 6, eventSeq: 10 })), false);
  assert.equal(store.applyMatchSync(matchSync({ requestId: "match-3", matchId: "match-1" }, { version: 8, eventSeq: 8 })), false);
  assert.equal(store.getSnapshot().matches["match-1"].version, 7);
  assert.equal(store.getSnapshot().matches["match-1"].eventSeq, 9);
});

test("cookie restore uses the T81 endpoints and schedules authoritative sync", async () => {
  const socket = new FakeSocket();
  const calls = [];
  const guest = {
    protocolVersion: 1,
    player: { playerId: "player-1", displayName: "Player One" },
    sessionExpiresAt: "2026-10-01T00:00:00Z",
  };
  const assignedRoom = roomView("room-1", { activeMatchId: "match-1" });
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (url === "/api/guest-sessions") return Response.json(guest, { status: 200 });
    return Response.json([assignedRoom], { status: 200 });
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket, fetcher });

  assert.deepEqual(await transport.restoreGuestSession(), guest);
  assert.equal(transport.getSnapshot().authenticated, true);
  assert.deepEqual(await transport.recoverAssignedSeats(), [assignedRoom]);
  assert.deepEqual(calls.map(({ url }) => url), ["/api/guest-sessions", "/api/guest-sessions/rooms"]);
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.credentials, "include");
    assert.equal(options.cache, "no-store");
  }

  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "room:sync") acknowledgement(roomSync(payload, { version: 2, activeMatchId: "match-1" }));
    if (event === "match:sync") acknowledgement(matchSync(payload, { version: 2, eventSeq: 2 }));
  };
  transport.connect();
  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 2 &&
    transport.getSnapshot().matches["match-1"]?.version === 2, "recovered room and active match did not sync");
});

test("default fetch keeps the global receiver for all guest session HTTP operations", async () => {
  const originalFetch = globalThis.fetch;
  const guest = {
    protocolVersion: 1,
    player: { playerId: "player-1", displayName: "Player One" },
    sessionExpiresAt: "2026-10-01T00:00:00Z",
  };
  const calls = [];
  globalThis.fetch = function (url, options) {
    calls.push({ receiver: this, url, options });
    if (url === "/api/guest-sessions" && options.method === "POST") {
      return Promise.resolve(Response.json(guest, { status: 201 }));
    }
    if (url === "/api/guest-sessions" && options.method === "GET") {
      return Promise.resolve(Response.json(guest, { status: 200 }));
    }
    if (url === "/api/guest-sessions/rooms" && options.method === "GET") {
      return Promise.resolve(Response.json([], { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };

  try {
    const transport = new BrowserGameTransport({ socketFactory: () => new FakeSocket() });
    assert.deepEqual(await transport.createGuestSession({ protocolVersion: 1, displayName: "Player One" }), guest);
    assert.deepEqual(await transport.restoreGuestSession(), guest);
    assert.deepEqual(await transport.recoverAssignedSeats(), []);
    assert.ok(calls.every(({ receiver }) => receiver === globalThis));
    assert.deepEqual(calls.map(({ url, options }) => ({
      url,
      method: options.method,
      credentials: options.credentials,
      cache: options.cache,
    })), [
      { url: "/api/guest-sessions", method: "POST", credentials: "include", cache: "no-store" },
      { url: "/api/guest-sessions", method: "GET", credentials: "include", cache: "no-store" },
      { url: "/api/guest-sessions/rooms", method: "GET", credentials: "include", cache: "no-store" },
    ]);
    assert.deepEqual(calls[0].options.headers, { "Content-Type": "application/json" });
    assert.equal(calls[0].options.body, JSON.stringify({ protocolVersion: 1, displayName: "Player One" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("204 is an empty guest restore; 401 room recovery follows SESSION_EXPIRED", async () => {
  const socket = new FakeSocket();
  let call = 0;
  const transport = new BrowserGameTransport({
    socketFactory: () => socket,
    fetcher: async () => {
      call += 1;
      return call === 1
        ? new Response(null, { status: 204 })
        : Response.json({ error: { code: "SESSION_EXPIRED" } }, { status: 401 });
    },
  });

  assert.equal(await transport.restoreGuestSession(), null);
  assert.equal(transport.getSnapshot().authenticated, false);
  await assert.rejects(transport.recoverAssignedSeats(), (error) =>
    error instanceof BrowserTransportError && error.code === "SESSION_EXPIRED");
  assert.equal(transport.getSnapshot().connection, "expired");
});

test("reconnect performs a fresh match sync before retrying the same pending command", async () => {
  const socket = new FakeSocket();
  const syncRequests = [];
  const commandAttempts = [];
  socket.onEmit = (item) => {
    if (item.event === "match:sync") syncRequests.push(item);
    if (item.event === "match:command") commandAttempts.push(item);
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  transport.watchMatch("match-1");
  transport.connect();
  await waitUntil(() => syncRequests.length === 1, "initial sync was not requested");

  const command = {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000001",
    matchId: "match-1",
    expectedVersion: 1,
    type: "END_TURN",
    payload: {},
  };
  const firstAttempt = transport.sendMatchCommand(command).catch((error) => error);
  await waitUntil(() => commandAttempts.length === 1, "first command attempt was not emitted");
  const firstPayload = JSON.stringify(commandAttempts[0].payload);

  socket.disconnect();
  const disconnectedResult = await firstAttempt;
  assert.equal(disconnectedResult.code, "NOT_CONNECTED");
  socket.connect();
  await waitUntil(() => syncRequests.length === 2, "reconnect did not issue a fresh sync request");
  assert.equal(commandAttempts.length, 1, "pending command retried before sync ACK");

  syncRequests[1].acknowledgement(matchSync(syncRequests[1].payload, { version: 2, eventSeq: 2 }));
  await waitUntil(() => commandAttempts.length === 2, "pending command was not retried after sync");
  assert.equal(JSON.stringify(commandAttempts[1].payload), firstPayload);
  assert.equal(commandAttempts[1].payload.commandId, command.commandId);
  commandAttempts[1].acknowledgement({
    protocolVersion: 1,
    commandId: command.commandId,
    status: "accepted",
    duplicate: true,
    aggregateVersion: 2,
    eventSeq: 2,
  });
  await waitUntil(() => transport.getSnapshot().pendingCommandIds.length === 0, "pending command was not cleared after its receipt");
  await waitUntil(() => syncRequests.length === 3, "accepted command did not schedule its normal follow-up sync");
  syncRequests[2].acknowledgement(matchSync(syncRequests[2].payload, { version: 2, eventSeq: 2 }));

  syncRequests[0].acknowledgement(matchSync(syncRequests[0].payload, { version: 1, eventSeq: 1 }));
  assert.equal(transport.getSnapshot().matches["match-1"].version, 2);
  assert.equal(transport.getSnapshot().matches["match-1"].eventSeq, 2);
});
