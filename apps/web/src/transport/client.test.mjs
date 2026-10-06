import assert from "node:assert/strict";
import { test } from "node:test";
import { BrowserGameTransport, BrowserTransportError } from "./client.ts";
import { BrowserTransportStore } from "./state.ts";
import { sendAndRefreshAction } from "../features/actions/model.ts";

test("same guest restoration preserves cached projections", () => {
  const store = new BrowserTransportStore();
  store.setViewerPlayerId("player-1");
  store.applyRoomSync(roomSync({ requestId: "r", roomId: "room-1" }));
  store.applyMatchSync(matchSync({ requestId: "m", matchId: "match-1" }));
  const before = store.getSnapshot();
  store.setViewerPlayerId("player-1");
  assert.equal(store.getSnapshot(), before);
});

test("expired session clears private projections and ignores late guest responses", () => {
  const store = new BrowserTransportStore();
  store.setViewerPlayerId("player-1");
  const room = roomSync({ requestId: "r", roomId: "room-1" });
  const match = matchSync({ requestId: "m", matchId: "match-1" });
  store.applyRoomSync(room);
  store.applyMatchSync(match);
  store.setPendingCommandIds(["old-command"]);
  store.setConnection("expired", false);
  assert.deepEqual(store.getSnapshot().rooms, {});
  assert.deepEqual(store.getSnapshot().matches, {});
  assert.deepEqual(store.getSnapshot().pendingCommandIds, []);
  assert.equal(store.applyRoomSync(room), false);
  assert.equal(store.applyRoomCommand(room.room), false);
  assert.equal(store.applyMatchSync(match), false);
});

test("changed guest identity cannot reuse previous viewer snapshots", () => {
  const store = new BrowserTransportStore();
  store.setViewerPlayerId("player-1");
  const match = matchSync({ requestId: "m", matchId: "match-1" });
  store.applyMatchSync(match);
  store.setViewerPlayerId("player-2");
  assert.deepEqual(store.getSnapshot().matches, {});
  assert.equal(store.applyMatchSync(match), false);
  const next = structuredClone(match);
  next.snapshot.viewer.playerId = "player-2";
  assert.equal(store.applyMatchSync(next), true);
});

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

test("socket history retains older records without changing the live cursor and rejects mismatched replies", async () => {
  const socket = new FakeSocket();
  let mismatch = false;
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "match:sync") acknowledgement(matchSync(payload, { version: 4, eventSeq: 200 }));
    if (event === "match:history") acknowledgement({ ...payload, requestId: mismatch ? "wrong-request" : payload.requestId,
      events: [{ eventSeq: 1, type: "BEER_USED", occurredAt: "2026-10-01T00:00:00Z", payload: {} }], nextBeforeEventSeq: null });
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  transport.watchMatch("match-1"); transport.connect();
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.eventSeq === 200, "initial match sync missing");
  const before = transport.getSnapshot().matches["match-1"];
  await transport.getMatchHistory("match-1", 100);
  const after = transport.getSnapshot().matches["match-1"];
  assert.equal(after.eventSeq, 200); assert.equal(after.version, 4);
  assert.equal(after.snapshot, before.snapshot); assert.equal(after.visibleEvents, before.visibleEvents);
  assert.equal(after.historyEvents[0].eventSeq, 1);
  mismatch = true;
  await assert.rejects(transport.getMatchHistory("match-1", 100), error => error.code === "INVALID_RESPONSE");
  assert.equal(transport.getSnapshot().matches["match-1"], after);
  transport.disconnect();
});

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

test("match projections retain only the newest 100 public events without moving the cursor backward", () => {
  const store = new BrowserTransportStore();
  const events = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => {
    const eventSeq = from + index;
    return { eventSeq, type: "TURN_ENDED", occurredAt: "2026-10-04T00:00:00.000Z", payload: {} };
  });
  const full = matchSync({ requestId: "full", matchId: "match-1" }, { version: 150, eventSeq: 150 });
  full.visibleEvents = events(1, 150);
  store.applyMatchSync(full);
  let projection = store.getSnapshot().matches["match-1"];
  assert.equal(projection.visibleEvents.length, 100);
  assert.equal(projection.visibleEvents[0].eventSeq, 51);
  assert.equal(projection.visibleEvents.at(-1).eventSeq, 150);
  assert.equal(projection.eventSeq, 150);

  const delta = matchSync({ requestId: "delta", matchId: "match-1" }, { version: 155, eventSeq: 155 });
  delta.requiresFullSnapshot = false;
  delta.visibleEvents = events(151, 155);
  store.applyMatchSync(delta);
  projection = store.getSnapshot().matches["match-1"];
  assert.equal(projection.visibleEvents.length, 100);
  assert.equal(projection.visibleEvents[0].eventSeq, 56);
  assert.equal(projection.visibleEvents.at(-1).eventSeq, 155);
  assert.equal(projection.eventSeq, 155);
  assert.equal(projection.historyEvents.length, 155);
  assert.equal(projection.historyEvents[0].eventSeq, 1);
  const refreshed = { ...delta, version: 156, eventSeq: 156, requiresFullSnapshot: true, visibleEvents: events(57, 156) };
  store.applyMatchSync(refreshed);
  assert.equal(store.getSnapshot().matches["match-1"].historyEvents.length, 156);
});

test("history pagination fills a reconnect gap without rewinding the live cursor or clearing cached old records", () => {
  const store = new BrowserTransportStore();
  const record = eventSeq => ({ eventSeq, type: "BEER_USED", occurredAt: "2026-10-06T00:00:00Z", payload: {} });
  store.applyMatchSync({ ...matchSync({ requestId: "m", matchId: "match-1" }, { version: 10, eventSeq: 10 }), visibleEvents: [record(1), record(10)] });
  store.applyMatchSync({ ...matchSync({ requestId: "r", matchId: "match-1" }, { version: 300, eventSeq: 300 }), visibleEvents: [record(201), record(300)] });
  assert.equal(store.getSnapshot().matches["match-1"].historyNextBeforeEventSeq, 201);
  const live = store.getSnapshot().matches["match-1"].visibleEvents;
  store.appendMatchHistory("match-1", [record(101), record(200)], { beforeEventSeq: 201, nextBeforeEventSeq: 101 });
  const match = store.getSnapshot().matches["match-1"];
  assert.equal(match.version, 300); assert.equal(match.eventSeq, 300); assert.equal(match.visibleEvents, live);
  assert.deepEqual(match.historyEvents.map(event => event.eventSeq), [1, 10, 101, 200, 201, 300]);
  assert.equal(match.historyNextBeforeEventSeq, 101);
  store.appendMatchHistory("match-1", [], { beforeEventSeq: 201, nextBeforeEventSeq: null });
  assert.equal(store.getSnapshot().matches["match-1"].historyNextBeforeEventSeq, 101, "late page cannot replace the current history cursor");
  store.setViewerPlayerId("someone-else"); assert.deepEqual(store.getSnapshot().matches, {});
});

test("ACK auto-sync and the action helper share one request; covered in-flight hints do not refetch", async () => {
  const socket = new FakeSocket();
  const syncRequests = [];
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "match:command") acknowledgement({
      protocolVersion: 1, commandId: payload.commandId, status: "accepted", duplicate: false,
      aggregateVersion: 2, eventSeq: 2,
    });
    if (event === "match:sync") syncRequests.push({ payload, acknowledgement });
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  transport.connect();
  const command = {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000151",
    matchId: "match-1",
    expectedVersion: 1,
    type: "END_TURN",
    payload: {},
  };
  const refresh = sendAndRefreshAction(transport, command);
  await waitUntil(() => syncRequests.length === 1, "accepted command did not start its authoritative sync");
  assert.equal(countEmits(socket, "match:sync"), 1);
  syncRequests[0].acknowledgement(matchSync(syncRequests[0].payload, { version: 2, eventSeq: 2 }));
  const result = await refresh;
  assert.equal(result.projection?.version, 2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(countEmits(socket, "match:sync"), 1, "joining the ACK sync must not mark a second request dirty");

  let resolveCoveredHint;
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "match:sync") {
      syncRequests.push({ payload, acknowledgement });
      if (syncRequests.length === 2) resolveCoveredHint = acknowledgement;
    }
  };
  const secondSync = transport.syncMatch("match-1");
  await waitUntil(() => syncRequests.length === 2, "second match sync did not start");
  socket.fire("match:changed", { matchId: "match-1", version: 3, eventSeq: 3 });
  resolveCoveredHint(matchSync(syncRequests[1].payload, { version: 3, eventSeq: 3 }));
  await secondSync;
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(countEmits(socket, "match:sync"), 2, "the sync response already covering an in-flight hint needs no follow-up");

  let resolveFirst;
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event !== "match:sync") return;
    syncRequests.push({ payload, acknowledgement });
    if (syncRequests.length === 3) resolveFirst = acknowledgement;
    else acknowledgement(matchSync(payload, { version: 5, eventSeq: 5 }));
  };
  const olderSync = transport.syncMatch("match-1");
  await waitUntil(() => resolveFirst !== undefined, "third match sync did not start");
  socket.fire("match:changed", { matchId: "match-1", version: 5, eventSeq: 5 });
  resolveFirst(matchSync(syncRequests[2].payload, { version: 4, eventSeq: 4 }));
  await olderSync;
  await waitUntil(() => countEmits(socket, "match:sync") === 4, "a newer uncovered hint did not trigger one follow-up");
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.eventSeq === 5,
    "follow-up projection did not finish");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(countEmits(socket, "match:sync"), 4, "one newer hint should create only one follow-up");
});

test("a versioned room command projection is applied and only a newly active match is fetched", async () => {
  const socket = new FakeSocket();
  const roomSyncs = [];
  const matchSyncs = [];
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "room:command") {
      acknowledgement({ ...roomView("room-1", { version: 9, activeMatchId: "match-1" }), version: 9 });
    }
    if (event === "room:sync") roomSyncs.push(payload);
    if (event === "match:sync") {
      matchSyncs.push(payload);
      acknowledgement(matchSync(payload, { version: 1, eventSeq: 1 }));
    }
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  transport.connect();
  const response = await transport.sendRoomCommand({
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000152",
    roomId: "room-1",
    expectedVersion: 8,
    type: "START_MATCH",
    payload: {},
  });
  assert.equal(response.version, 9);
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.version === 1,
    "the new active match was not synchronized from its versioned room ACK");
  assert.equal(transport.getSnapshot().rooms["room-1"].version, 9);
  assert.equal(roomSyncs.length, 0, "versioned room ACK should avoid a redundant room request");
  assert.equal(matchSyncs.length, 1);
});

test("parallel guest restore and assigned-seat recovery calls share their HTTP reads", async () => {
  const socket = new FakeSocket();
  const calls = [];
  const transport = new BrowserGameTransport({
    socketFactory: () => socket,
    fetcher: async (url) => {
      calls.push(url);
      if (url === "/api/guest-sessions") return Response.json({
        protocolVersion: 1, player: { playerId: "player-1", displayName: "Player One" },
        sessionExpiresAt: "2026-10-01T00:00:00Z",
      });
      if (url === "/api/guest-sessions/rooms") return Response.json([roomView("room-1")]);
      return new Response(null, { status: 404 });
    },
  });
  const restores = [transport.restoreGuestSession(), transport.restoreGuestSession()];
  assert.deepEqual(await Promise.all(restores), [await restores[0], await restores[0]]);
  const recoveries = [transport.recoverAssignedSeats(), transport.recoverAssignedSeats()];
  assert.deepEqual(await Promise.all(recoveries), [[roomView("room-1")], [roomView("room-1")]]);
  assert.deepEqual(calls, ["/api/guest-sessions", "/api/guest-sessions/rooms"]);
});

test("a legacy room ACK during an older sync forces one fresh projection", async () => {
  const socket = new FakeSocket();
  const syncs = [];
  let resolveFirst;
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "room:command") acknowledgement(roomView("room-1"));
    if (event === "room:sync") {
      syncs.push({ payload, acknowledgement });
      if (syncs.length === 1) resolveFirst = acknowledgement;
      else acknowledgement(roomSync(payload, { version: 2 }));
    }
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  transport.connect();
  const older = transport.syncRoom("room-1");
  await waitUntil(() => resolveFirst !== undefined, "initial room sync did not start");
  await transport.sendRoomCommand({
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000153",
    roomId: "room-1",
    expectedVersion: 1,
    type: "SET_READY",
    payload: { ready: true },
  });
  resolveFirst(roomSync(syncs[0].payload, { version: 1 }));
  await older;
  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 2,
    "the post-command projection did not supersede the older in-flight response");
  assert.equal(syncs.length, 2, "legacy ACK mutation should cause one post-mutation sync");
});

test("room-derived match watches release together and old resources are not synced after reconnect", async () => {
  const socket = new FakeSocket();
  const syncCounts = { room: 0, match: 0 };
  socket.onEmit = ({ event, payload, acknowledgement }) => {
    if (event === "room:sync") {
      syncCounts.room += 1;
      acknowledgement(roomSync(payload, { version: 1, activeMatchId: "match-1" }));
    }
    if (event === "match:sync") {
      syncCounts.match += 1;
      acknowledgement(matchSync(payload, { version: 1, eventSeq: 1 }));
    }
  };
  const transport = new BrowserGameTransport({ socketFactory: () => socket });
  const stopWatching = transport.watchRoom("room-1");
  transport.connect();
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.eventSeq === 1,
    "active match was not tracked through its room projection");
  const beforeRelease = { ...syncCounts };
  stopWatching();
  socket.disconnect();
  socket.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(syncCounts, beforeRelease, "a route that released its only watch must leave no reconnect targets");
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
