import assert from "node:assert/strict";
import { test } from "node:test";
import { sendAndRefreshAction } from "../src/features/actions/model.ts";
import { sendAndRefreshResponse } from "../src/features/reactions/model.ts";
import { SitesGameTransport } from "../src/transport/sites-client.ts";

function roomView(roomId, { version = 1, activeMatchId = null, omitVersion = false } = {}) {
  return {
    roomId,
    status: activeMatchId ? "in_game" : "waiting",
    activeMatchId,
    ownerPlayerId: "player-1",
    capacity: 4,
    rulesetVersion: "base4-ko-online-1.0",
    ...(omitVersion ? {} : { version }),
    members: [{ playerId: "player-1", displayName: "Player One", seatIndex: 0, ready: false }],
    viewer: { playerId: "player-1", isOwner: true },
  };
}

function roomSync(request, { version = 1, activeMatchId = null } = {}) {
  return {
    protocolVersion: 1,
    requestId: request.requestId,
    roomId: request.roomId,
    version,
    requiresFullSnapshot: true,
    room: roomView(request.roomId, { version, activeMatchId }),
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
        players: [{ playerId: "player-1", displayName: "Player One", seatIndex: 0, characterId: "bart-cassidy",
          hp: 4, maxHp: 4, eliminated: false, handCount: 4, role: "sheriff", inPlay: [] }],
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

const guest = {
  protocolVersion: 1,
  player: { playerId: "player-1", displayName: "Player One" },
  sessionExpiresAt: "2026-10-01T00:00:00Z",
};

class FakeEventSource {
  readyState = 0;
  onopen = null;
  onerror = null;
  listeners = new Map();
  closed = false;

  addEventListener(type, listener) {
    const entries = this.listeners.get(type) ?? new Set();
    entries.add(listener);
    this.listeners.set(type, entries);
  }

  emit(type, cursor, payload) {
    const event = { lastEventId: cursor === null ? "" : String(cursor), data: JSON.stringify(payload) };
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

function acceptedMatchCommand(commandId = "command-1") {
  return {
    protocolVersion: 1,
    commandId: commandId === "command-1" ? "00000000-0000-4000-8000-000000000101" : commandId,
    matchId: "match-1",
    expectedVersion: 1,
    type: "END_TURN",
    payload: {},
  };
}

test("accepted ACK and concurrent passive sync callers share one match request", async () => {
  const syncRequests = [];
  let resolveSync;
  const transport = new SitesGameTransport({
    fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url.endsWith("/commands")) {
        const command = JSON.parse(init.body);
        return Response.json({ protocolVersion: 1, commandId: command.commandId, status: "accepted", duplicate: false,
          aggregateVersion: 2, eventSeq: 2 });
      }
      if (url.endsWith("/sync")) {
        const request = JSON.parse(init.body);
        syncRequests.push(request);
        return new Promise((resolve) => { resolveSync = () => resolve(Response.json(matchSync(request, { version: 2, eventSeq: 2 }))); });
      }
      return new Response(null, { status: 404 });
    },
    eventSourceFactory: () => new FakeEventSource(),
  });

  await transport.restoreGuestSession();
  transport.connect();
  const command = acceptedMatchCommand();
  const actionRefresh = sendAndRefreshAction(transport, command);
  await waitUntil(() => syncRequests.length === 1, "accepted ACK did not begin its authoritative sync");
  const first = transport.syncMatch(command.matchId);
  const second = transport.syncMatch(command.matchId);
  assert.equal(syncRequests.length, 1, "concurrent callers should join the in-flight request without making it dirty");
  resolveSync();
  await Promise.all([first, second]);
  const actionResult = await actionRefresh;
  assert.equal(actionResult.acknowledgement.status, "accepted");
  assert.equal(actionResult.projection?.version, 2);
  assert.equal(syncRequests.length, 1, "normal post-ACK refresh should use exactly one HTTP sync");

  const responseRefresh = sendAndRefreshResponse(transport, acceptedMatchCommand("00000000-0000-4000-8000-000000000104"));
  await waitUntil(() => syncRequests.length === 2, "accepted response ACK did not begin its sync");
  const responseResultPromise = responseRefresh;
  resolveSync();
  const responseResult = await responseResultPromise;
  assert.equal(responseResult.acknowledgement.status, "accepted");
  assert.equal(responseResult.projection?.version, 2);
  assert.equal(syncRequests.length, 2, "normal post-ACK response refresh should also use one HTTP sync");
  transport.disconnect();
});

test("a newer SSE match hint during sync triggers exactly one fresh follow-up", async () => {
  const eventSources = [];
  const syncRequests = [];
  let version = 1;
  let delayNext = false;
  let resolveDelayed;
  const transport = new SitesGameTransport({
    createId: (() => { let id = 0; return () => `sync-${++id}`; })(),
    fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url.endsWith("/sync")) {
        const request = JSON.parse(init.body);
        syncRequests.push(request);
        if (delayNext) {
          delayNext = false;
          return new Promise((resolve) => {
            resolveDelayed = () => resolve(Response.json(matchSync(request, { version: 2, eventSeq: 2 })));
          });
        }
        return Response.json(matchSync(request, { version, eventSeq: version }));
      }
      return new Response(null, { status: 404 });
    },
    eventSourceFactory: () => {
      const source = new FakeEventSource();
      eventSources.push(source);
      return source;
    },
  });

  await transport.restoreGuestSession();
  transport.watchMatch("match-1");
  transport.connect();
  eventSources[0].open();
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.version === 1, "initial match sync did not finish");

  version = 2;
  delayNext = true;
  eventSources[0].emit("invalidation", 1, { kind: "match", aggregateId: "match-1", version: 2, eventSeq: 2 });
  await waitUntil(() => resolveDelayed !== undefined, "first invalidation did not start a sync");
  version = 3;
  eventSources[0].emit("invalidation", 2, { kind: "match", aggregateId: "match-1", version: 3, eventSeq: 3 });
  resolveDelayed();
  await waitUntil(() => syncRequests.length === 3, "newer hint was not covered by one follow-up sync");
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.version === 3, "follow-up projection was not applied");
  assert.equal(syncRequests.length, 3, "two hints coalesce to one follow-up after the in-flight request");
  transport.disconnect();
});

test("mismatched unchanged replies fall back to a strict full sync without opt-in", async () => {
  const requests = [];
  const transport = new SitesGameTransport({
    createId: (() => { let id = 0; return () => `sync-${++id}`; })(),
    fetcher: async (url, init) => {
      if (url.endsWith("/sync")) {
        const request = JSON.parse(init.body);
        requests.push(request);
        if (requests.length === 2) return Response.json({ protocolVersion: 1, requestId: request.requestId,
          status: "unchanged", matchId: "wrong-match", version: 2, eventSeq: 2 });
        return Response.json(matchSync(request, { version: requests.length === 1 ? 2 : 3, eventSeq: requests.length === 1 ? 2 : 3 }));
      }
      return new Response(null, { status: 404 });
    },
  });

  await transport.syncMatch("match-1");
  const latest = await transport.syncMatch("match-1");
  assert.deepEqual(requests.map((request) => request.acceptUnchanged), [undefined, true, undefined]);
  assert.equal(requests[1].knownVersion, 2);
  assert.equal(requests[2].knownVersion, 2);
  assert.equal(latest.version, 3);
});

test("a second unchanged response cannot recurse, and successful syncs clear stale errors", async () => {
  const matchRequests = [];
  const matchTransport = new SitesGameTransport({
    createId: (() => { let id = 0; return () => `match-${++id}`; })(),
    fetcher: async (url, init) => {
      if (!url.endsWith("/sync")) return new Response(null, { status: 404 });
      const request = JSON.parse(init.body);
      matchRequests.push(request);
      if (matchRequests.length === 1) return Response.json(matchSync(request, { version: 2, eventSeq: 2 }));
      const matchId = request.acceptUnchanged ? "wrong-match" : request.matchId;
      return Response.json({ protocolVersion: 1, requestId: request.requestId, status: "unchanged", matchId,
        version: 2, eventSeq: 2 });
    },
  });
  await matchTransport.syncMatch("match-1");
  matchTransport.store.setError("CONNECTION");
  await assert.rejects(matchTransport.syncMatch("match-1"), (error) => error?.code === "INVALID_RESPONSE");
  assert.equal(matchRequests.length, 3, "one full fallback is allowed; repeated unchanged must fail rather than recurse");
  assert.deepEqual(matchRequests.map((request) => request.acceptUnchanged), [undefined, true, undefined]);

  const roomRequests = [];
  const roomTransport = new SitesGameTransport({
    createId: (() => { let id = 0; return () => `room-${++id}`; })(),
    fetcher: async (url, init) => {
      if (!url.endsWith("/sync")) return new Response(null, { status: 404 });
      const request = JSON.parse(init.body);
      roomRequests.push(request);
      return Response.json(roomSync(request, { version: 1 }));
    },
  });
  await roomTransport.syncRoom("room-1");
  roomTransport.store.setError("CONNECTION");
  await roomTransport.syncRoom("room-1");
  assert.equal(roomTransport.getSnapshot().lastError, null, "a full same-version success clears the prior connection error");
  assert.deepEqual(roomRequests.map((request) => request.acceptUnchanged), [undefined, true]);

  matchTransport.store.setError("SYNC_REJECTED");
  const unchangedTransport = new SitesGameTransport({
    createId: (() => { let id = 0; return () => `unchanged-${++id}`; })(),
    fetcher: async (url, init) => {
      const request = JSON.parse(init.body);
      if (request.acceptUnchanged) return Response.json({ protocolVersion: 1, requestId: request.requestId,
        status: "unchanged", matchId: request.matchId, version: 1, eventSeq: 1 });
      return Response.json(matchSync(request, { version: 1, eventSeq: 1 }));
    },
  });
  await unchangedTransport.syncMatch("match-1");
  unchangedTransport.store.setError("SYNC_REJECTED");
  await unchangedTransport.syncMatch("match-1");
  assert.equal(unchangedTransport.getSnapshot().lastError, null, "a correlated unchanged success clears stale sync errors");
});

test("presence is timestamped separately, filters foreign members, and survives room sync", async () => {
  const eventSources = [];
  let roomVersion = 1;
  const transport = new SitesGameTransport({
    fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url.endsWith("/sync")) return Response.json(roomSync(JSON.parse(init.body), { version: roomVersion }));
      return new Response(null, { status: 404 });
    },
    eventSourceFactory: () => {
      const source = new FakeEventSource();
      eventSources.push(source);
      return source;
    },
  });

  await transport.restoreGuestSession();
  transport.watchRoom("room-1");
  transport.connect();
  eventSources[0].open();
  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 1, "initial room sync did not finish");

  eventSources[0].emit("presence", null, {
    protocolVersion: 1,
    roomId: "room-1",
    observedAt: "2026-10-04T00:00:02.000Z",
    members: [
      { playerId: "player-1", connectionState: "disconnected" },
      { playerId: "unknown-player", connectionState: "connected" },
    ],
  });
  assert.equal(transport.getSnapshot().rooms["room-1"].room.members[0].connectionState, "disconnected");
  assert.equal(transport.getSnapshot().rooms["room-1"].version, 1, "presence must not advance the room version");

  eventSources[0].emit("presence", null, {
    protocolVersion: 1, roomId: "room-1", observedAt: "2026-10-04T00:00:01.000Z",
    members: [{ playerId: "player-1", connectionState: "connected" }],
  });
  eventSources[0].emit("presence", null, {
    protocolVersion: 1, roomId: "other-room", observedAt: "2026-10-04T00:00:03.000Z",
    members: [{ playerId: "player-1", connectionState: "connected" }],
  });
  eventSources[0].emit("presence", null, {
    protocolVersion: 1, roomId: "room-1", observedAt: "2026-10-04T00:00:04.000Z",
    members: [{ playerId: "player-1", connectionState: "connected" }], extra: true,
  });
  assert.equal(transport.getSnapshot().rooms["room-1"].room.members[0].connectionState, "disconnected");

  roomVersion = 2;
  await transport.syncRoom("room-1");
  assert.equal(transport.getSnapshot().rooms["room-1"].version, 2);
  assert.equal(transport.getSnapshot().rooms["room-1"].room.members[0].connectionState, "disconnected",
    "an authoritative refresh must retain the latest accepted presence overlay");
  transport.disconnect();
});

test("new guests use JSON create/join without an initial SSE dependency; versioned room ACK is applied directly", async () => {
  let sourceAttempts = 0;
  const syncRequests = [];
  const transport = new SitesGameTransport({
    fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url === "/api/rooms") return Response.json({ roomId: "created-room", version: 1, inviteCode: "Invite123", duplicate: false });
      if (url === "/api/rooms/created-room/sync") {
        const request = JSON.parse(init.body);
        syncRequests.push(request);
        return Response.json(roomSync(request));
      }
      if (url === "/api/rooms/joined-room/commands") return Response.json(roomView("joined-room", { version: 5 }));
      return new Response(null, { status: 404 });
    },
    eventSourceFactory: () => {
      sourceAttempts += 1;
      throw new Error("EventSource unavailable");
    },
  });

  await transport.restoreGuestSession();
  transport.connect();
  assert.equal(sourceAttempts, 0, "connecting a new guest with no memberships must not open SSE");
  const created = await transport.createRoom({ protocolVersion: 1, commandId: "00000000-0000-4000-8000-000000000102", expectedVersion: 0,
    type: "CREATE_ROOM", payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "Player One" } });
  assert.equal(created.roomId, "created-room");
  await waitUntil(() => syncRequests.length === 1, "created room did not request its required full projection");
  const joined = await transport.joinRoom({ protocolVersion: 1, commandId: "00000000-0000-4000-8000-000000000103", roomId: "joined-room",
    expectedVersion: 4, type: "JOIN", payload: { inviteCode: "Invite123" } });
  assert.equal(joined.version, 5);
  assert.equal(transport.getSnapshot().rooms["joined-room"].version, 5);
  assert.equal(syncRequests.length, 1, "create requires one full projection, while versioned JOIN ACK does not need a follow-up");
  assert.equal(sourceAttempts, 2, "unavailable SSE must not block either JSON write");
  transport.disconnect();
});

test("HTTP room commands remain writable while the membership SSE channel is closed", async () => {
  const eventSources = [];
  let roomVersion = 1;
  const transport = new SitesGameTransport({
    fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url === "/api/rooms/room-1/sync") return Response.json(roomSync(JSON.parse(init.body), { version: roomVersion }));
      if (url === "/api/rooms/room-1/commands") {
        roomVersion = 2;
        return Response.json(roomView("room-1", { version: roomVersion }));
      }
      return new Response(null, { status: 404 });
    },
    eventSourceFactory: () => {
      const source = new FakeEventSource();
      eventSources.push(source);
      return source;
    },
  });

  await transport.restoreGuestSession();
  transport.watchRoom("room-1");
  transport.connect();
  eventSources[0].open();
  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 1, "initial room sync did not finish");
  eventSources[0].readyState = 2;
  eventSources[0].onerror?.(new Event("error"));
  assert.equal(transport.getSnapshot().connection, "disconnected", "SSE status remains visible during reconnect");
  assert.equal(transport.writesAvailableWhileDisconnected, true);

  const result = await transport.sendRoomCommand({ protocolVersion: 1, commandId: "00000000-0000-4000-8000-000000000105",
    roomId: "room-1", expectedVersion: 1, type: "SET_READY", payload: { ready: true } });
  assert.equal(result.version, 2, "the JSON command should succeed while SSE is unavailable");
  assert.equal(transport.getSnapshot().rooms["room-1"].version, 2);
  transport.disconnect();
});

test("legacy unversioned room ACK forces one follow-up after an older sync already in flight", async () => {
  const syncRequests = [];
  let resolveFirstSync;
  const transport = new SitesGameTransport({
    fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url === "/api/rooms/room-1/sync") {
        const request = JSON.parse(init.body);
        syncRequests.push(request);
        if (syncRequests.length === 1) {
          return new Promise((resolve) => { resolveFirstSync = () => resolve(Response.json(roomSync(request, { version: 1 }))); });
        }
        return Response.json(roomSync(request, { version: 2 }));
      }
      if (url === "/api/rooms/room-1/commands") return Response.json(roomView("room-1", { omitVersion: true }));
      return new Response(null, { status: 404 });
    },
    eventSourceFactory: () => new FakeEventSource(),
  });

  await transport.restoreGuestSession();
  transport.connect();
  const olderSync = transport.syncRoom("room-1");
  await waitUntil(() => resolveFirstSync !== undefined, "initial room sync did not begin");
  const command = transport.sendRoomCommand({ protocolVersion: 1, commandId: "00000000-0000-4000-8000-000000000106",
    roomId: "room-1", expectedVersion: 1, type: "SET_READY", payload: { ready: true } });
  await command;
  resolveFirstSync();
  await olderSync;
  await waitUntil(() => syncRequests.length === 2, "legacy room command should refresh after the older in-flight result");
  await waitUntil(() => transport.getSnapshot().rooms["room-1"]?.version === 2, "follow-up room projection did not apply");
  assert.equal(syncRequests.length, 2);
  transport.disconnect();
});
