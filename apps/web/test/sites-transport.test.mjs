import assert from "node:assert/strict";
import { test } from "node:test";
import { selectGameTransportAdapter } from "../src/transport/adapter-selection.ts";
import { BrowserTransportError } from "../src/transport/errors.ts";
import { SitesGameTransport } from "../src/transport/sites-client.ts";

function roomView(roomId, { version = 1, activeMatchId = null } = {}) {
  return {
    roomId,
    status: activeMatchId ? "in_game" : "waiting",
    activeMatchId,
    ownerPlayerId: "player-1",
    capacity: 4,
    rulesetVersion: "base4-ko-online-1.0",
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

const guest = {
  protocolVersion: 1,
  player: { playerId: "player-1", displayName: "Player One" },
  sessionExpiresAt: "2026-10-01T00:00:00Z",
};

test("history reads merge older records without changing the live snapshot or sync cursor", async () => {
  const transport = new SitesGameTransport({ fetcher: async (url, init) => {
    if (url === "/api/guest-sessions") return Response.json(guest);
    const request = JSON.parse(init.body);
    if (url.endsWith("/history")) return Response.json({ ...request, events: [{ eventSeq: 1, type: "BEER_USED",
      occurredAt: "2026-10-06T00:00:00Z", payload: { actorPlayerId: "player-1" } }], nextBeforeEventSeq: null });
    return Response.json(matchSync(request, { version: 300, eventSeq: 300 }));
  } });
  await transport.restoreGuestSession(); await transport.syncMatch("match-1");
  const previous = transport.getSnapshot().matches["match-1"];
  const history = await transport.getMatchHistory("match-1", 301);
  const current = transport.getSnapshot().matches["match-1"];
  assert.equal(history.nextBeforeEventSeq, null); assert.equal(current.eventSeq, 300); assert.equal(current.version, 300);
  assert.equal(current.snapshot, previous.snapshot); assert.equal(current.visibleEvents, previous.visibleEvents);
  assert.deepEqual(current.historyEvents.map(event => event.eventSeq), [1]);
  assert.equal(current.historyNextBeforeEventSeq, null);
});

test("history 500 failure leaves gameplay connection and its live cursor intact", async () => {
  const transport = new SitesGameTransport({ fetcher: async (url, init) => {
    if (url === "/api/guest-sessions") return Response.json(guest);
    if (url.endsWith("/history")) return new Response("failed", { status: 500 });
    return Response.json(matchSync(JSON.parse(init.body)));
  } });
  await transport.restoreGuestSession(); await transport.syncMatch("match-1");
  await assert.rejects(transport.getMatchHistory("match-1"), { code: "HTTP_SERVER_ERROR" });
  assert.equal(transport.getSnapshot().lastError, null);
  assert.equal(transport.getSnapshot().matches["match-1"].eventSeq, 1);
});

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

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  invalidation(cursor, payload) {
    const event = { lastEventId: String(cursor), data: JSON.stringify(payload) };
    for (const listener of this.listeners.get("invalidation") ?? []) listener(event);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }
}

class FakeVisibility {
  visibilityState = "visible";
  listeners = new Set();

  addEventListener(_type, listener) { this.listeners.add(listener); }
  removeEventListener(_type, listener) { this.listeners.delete(listener); }

  setVisibility(visibilityState) {
    this.visibilityState = visibilityState;
    for (const listener of this.listeners) listener();
  }
}

async function waitUntil(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(message);
}

test("production builds select Sites HTTP/SSE and local Vite selects Socket.IO", () => {
  assert.equal(selectGameTransportAdapter("production"), "sites-http-sse");
  assert.equal(selectGameTransportAdapter("development"), "socket-io");
  assert.equal(selectGameTransportAdapter("test"), "socket-io");
});

for (const failure of ["500", "lost-ack"]) {
  test(`transient ${failure} quietly replays the identical command and applies it only once`, async () => {
    const envelopes = []; let mutations = 0;
    const transport = new SitesGameTransport({ commandRetryIntervalMs: 1, fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      const request = JSON.parse(init.body);
      if (!url.endsWith("/commands")) return Response.json(matchSync(request));
      envelopes.push(init.body);
      if (envelopes.length === 1) {
        if (failure === "lost-ack") { mutations++; throw new Error("response lost after commit"); }
        return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
      }
      if (failure === "500") mutations++;
      return Response.json({ protocolVersion: 1, commandId: request.commandId, status: "accepted",
        duplicate: failure === "lost-ack", aggregateVersion: 2, eventSeq: 2,
        matchProjection: { baseEventSeq: 1, snapshot: matchSync(request).snapshot, visibleEvents: [] } });
    }, eventSourceFactory: () => new FakeEventSource() });
    try {
      await transport.restoreGuestSession(); transport.connect(); await transport.syncMatch("match-1");
      const command = { protocolVersion: 1, commandId: crypto.randomUUID(), matchId: "match-1", expectedVersion: 1,
        type: "END_TURN", payload: {} };
      const ack = await transport.sendMatchCommand(command);
      assert.equal(ack.status, "accepted"); assert.equal(envelopes.length, 2);
      assert.equal(envelopes[0], envelopes[1]); assert.equal(mutations, 1);
      assert.deepEqual(transport.getSnapshot().pendingCommandIds, []);
      assert.equal(transport.getSnapshot().lastError, null);
      assert.deepEqual(transport.getCommandAcknowledgement(command.commandId), ack);
      const copy = transport.getCommandAcknowledgement(command.commandId); copy.aggregateVersion = 99;
      assert.equal(transport.getCommandAcknowledgement(command.commandId).aggregateVersion, 2);
    } finally { transport.disconnect(); }
  });
}

test("persistent server failure retries at most three times and keeps the original pending ID", async () => {
  let attempts = 0;
  const transport = new SitesGameTransport({ commandRetryIntervalMs: 1, fetcher: async url => {
    if (url === "/api/guest-sessions") return Response.json(guest);
    attempts++; return new Response("server failure", { status: 503 });
  }, eventSourceFactory: () => new FakeEventSource() });
  try {
    await transport.restoreGuestSession(); transport.connect();
    const command = { protocolVersion: 1, commandId: crypto.randomUUID(), matchId: "match-1", expectedVersion: 1,
      type: "END_TURN", payload: {} };
    await assert.rejects(transport.sendMatchCommand(command), { code: "HTTP_SERVER_ERROR" });
    assert.equal(attempts, 3); assert.equal(transport.getSnapshot().lastError, "SERVER_ERROR");
    assert.deepEqual(transport.getSnapshot().pendingCommandIds, [command.commandId]);
    assert.equal(transport.getCommandAcknowledgement(command.commandId), undefined);
  } finally { transport.disconnect(); }
});

for (const stopKind of ["hidden", "disconnect", "identity"]) {
  test(`command retry stops on ${stopKind} before another mutation request`, async () => {
    const visibility = new FakeVisibility(); let attempts = 0, playerId = "player-1";
    const transport = new SitesGameTransport({ commandRetryIntervalMs: 15, visibilityTarget: visibility,
      eventSourceFactory: () => new FakeEventSource(), fetcher: async url => {
        if (url === "/api/guest-sessions") return Response.json({ ...guest, player: { ...guest.player, playerId } });
        attempts++; return new Response("failure", { status: 500 });
      } });
    try {
      await transport.restoreGuestSession(); transport.connect();
      const pending = transport.sendMatchCommand({ protocolVersion: 1, commandId: crypto.randomUUID(), matchId: "match-1",
        expectedVersion: 1, type: "END_TURN", payload: {} });
      const failed = assert.rejects(pending, { code: "HTTP_SERVER_ERROR" });
      await waitUntil(() => attempts === 1, "initial request not received");
      if (stopKind === "hidden") visibility.setVisibility("hidden");
      else if (stopKind === "disconnect") transport.disconnect();
      else { playerId = "player-2"; await transport.restoreGuestSession(); }
      await failed; assert.equal(attempts, 1);
    } finally { transport.disconnect(); }
  });
}

test("invalid command acknowledgement is never automatically retried", async () => {
  let attempts = 0;
  const transport = new SitesGameTransport({ commandRetryIntervalMs: 1, fetcher: async url => {
    if (url === "/api/guest-sessions") return Response.json(guest);
    attempts++; return Response.json({ status: "accepted", commandId: "wrong-id" });
  }, eventSourceFactory: () => new FakeEventSource() });
  try {
    await transport.restoreGuestSession(); transport.connect();
    await assert.rejects(transport.sendMatchCommand({ protocolVersion: 1, commandId: crypto.randomUUID(), matchId: "match-1",
      expectedVersion: 1, type: "END_TURN", payload: {} }), { code: "INVALID_RESPONSE" });
    assert.equal(attempts, 1);
  } finally { transport.disconnect(); }
});

for (const kind of ["room", "match"]) {
  test(`A01 ${kind} sync retries HTTP 500 while SSE stays connected and no new event arrives`, async () => {
    let version = 1, failOnce = false, reads = 0;
    const sources = [];
    const transport = new SitesGameTransport({ syncRetryIntervalMs: 10,
      fetcher: async (url, init) => {
        if (url === "/api/guest-sessions") return Response.json(guest);
        reads++;
        if (failOnce) { failOnce = false; return new Response("temporarily unavailable", { status: 500 }); }
        const request = JSON.parse(init.body);
        return Response.json(kind === "room" ? roomSync(request, { version }) : matchSync(request, { version, eventSeq: version }));
      }, eventSourceFactory: () => { const source = new FakeEventSource(); sources.push(source); return source; } });
    try {
      await transport.restoreGuestSession();
      transport.connect();
      const id = `${kind}-1`;
      kind === "room" ? transport.watchRoom(id) : transport.watchMatch(id);
      sources[0].open();
      const projection = () => transport.getSnapshot()[kind === "room" ? "rooms" : "matches"][id];
      await waitUntil(() => projection()?.version === 1, "initial sync missing");
      version = 2; failOnce = true;
      sources[0].invalidation(1, { kind, aggregateId: id, version, ...(kind === "match" ? { eventSeq: 2 } : {}) });
      await waitUntil(() => projection()?.version === 2, "a single failed read must recover without another invalidation");
      assert.equal(transport.getSnapshot().connection, "connected");
      assert.equal(transport.getSnapshot().lastError, null);
      assert.ok(reads >= 3);
    } finally { transport.disconnect(); }
  });
}

test("A01 failed read retries stop when hidden, unwatched or disconnected", async () => {
  for (const stopKind of ["hidden", "unwatch", "disconnect"]) {
    const visibility = new FakeVisibility(); let reads = 0;
    const transport = new SitesGameTransport({ syncRetryIntervalMs: 10, visibilityTarget: visibility,
      fetcher: async url => {
        if (url === "/api/guest-sessions") return Response.json(guest);
        reads++; return Response.json({ error: { code: "INTERNAL_ERROR" } }, { status: 500 });
      }, eventSourceFactory: () => new FakeEventSource() });
    try {
      await transport.restoreGuestSession(); transport.connect();
      const unwatch = transport.watchRoom("room-1");
      await waitUntil(() => transport.getSnapshot().lastError === "SERVER_ERROR", "failure not received");
      if (stopKind === "hidden") visibility.setVisibility("hidden");
      else if (stopKind === "unwatch") unwatch(); else transport.disconnect();
      const stopped = reads;
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(reads, stopped, stopKind);
    } finally { transport.disconnect(); }
  }
});

test("A02 a delta ACK with a missing prefix fetches from the previous cursor, including private gaps", async () => {
  for (const baseEventSeq of [undefined, 5]) {
    const requests = [];
    const visibleEvent = seq => ({ eventSeq: seq, type: "INDIANS_HIT", occurredAt: new Date().toISOString(), payload: { targetPlayerId: "player-1", damage: 1 } });
    const transport = new SitesGameTransport({ fetcher: async (url, init) => {
      if (url === "/api/guest-sessions") return Response.json(guest);
      if (url.endsWith("/commands")) return Response.json({ protocolVersion: 1, commandId: JSON.parse(init.body).commandId,
        status: "accepted", duplicate: false, aggregateVersion: 3, eventSeq: 8,
        matchProjection: { ...(baseEventSeq === undefined ? {} : { baseEventSeq }), snapshot: matchSync({}).snapshot, visibleEvents: [visibleEvent(8)] } });
      const request = JSON.parse(init.body); requests.push(request);
      const response = matchSync(request, { version: requests.length === 1 ? 1 : 3, eventSeq: requests.length === 1 ? 4 : 8 });
      response.requiresFullSnapshot = requests.length === 1;
      response.visibleEvents = requests.length === 1 ? [] : [visibleEvent(5), visibleEvent(8)];
      return Response.json(response);
    } });
    try {
      await transport.restoreGuestSession(); await transport.syncMatch("match-1");
      await transport.sendMatchCommand({ protocolVersion: 1, commandId: crypto.randomUUID(), matchId: "match-1", expectedVersion: 1, type: "END_TURN", payload: {} });
      await transport.syncMatch("match-1");
      assert.equal(requests[1].afterEventSeq, 4);
      assert.deepEqual(transport.getSnapshot().matches["match-1"].visibleEvents.map(event => event.eventSeq), [5, 8]);
    } finally { transport.disconnect(); }
  }
});

test("A05 membership rejection drops only the denied room, clears its match, stops reads and allows JOIN", async () => {
  let deny = false, reads = 0;
  const sources = [];
  const transport = new SitesGameTransport({ syncRetryIntervalMs: 10, fetcher: async (url, init) => {
    if (url === "/api/guest-sessions") return Response.json(guest);
    const request = JSON.parse(init.body);
    if (url.endsWith("/commands")) { deny = false; return Response.json({ ...roomView("room-1"), version: 2 }); }
    reads++;
    if (deny && request.roomId === "room-1") return Response.json({ protocolVersion: 1, requestId: request.requestId,
      status: "rejected", error: { code: "NOT_FOUND_OR_FORBIDDEN" } });
    return Response.json(request.matchId ? matchSync(request) : roomSync(request, { activeMatchId: deny ? null : "match-1" }));
  }, eventSourceFactory: () => { const source = new FakeEventSource(); sources.push(source); return source; } });
  try {
    await transport.restoreGuestSession(); transport.connect(); const unwatch = transport.watchRoom("room-1");
    await transport.syncRoom("room-1"); await transport.syncMatch("match-1");
    transport.store.applyRoomCommand({ ...roomView("other-room"), version: 1 });
    deny = true;
    await assert.rejects(transport.syncRoom("room-1"), { code: "REQUEST_REJECTED" });
    assert.equal(transport.getSnapshot().rooms["room-1"], undefined);
    assert.equal(transport.getSnapshot().matches["match-1"], undefined);
    assert.ok(transport.getSnapshot().rooms["other-room"]);
    assert.deepEqual(transport.getSnapshot().unavailableRooms, ["room-1"]);
    assert.ok(sources.every(source => source.closed));
    const stopped = reads; await new Promise(resolve => setTimeout(resolve, 40)); assert.equal(reads, stopped);
    await transport.joinRoom({ protocolVersion: 1, commandId: crypto.randomUUID(), expectedVersion: 1,
      roomId: "room-1", type: "JOIN", payload: { inviteCode: "new-invite" } });
    assert.deepEqual(transport.getSnapshot().unavailableRooms, []);
    assert.equal(transport.getSnapshot().rooms["room-1"].version, 2);
    unwatch();
  } finally { transport.disconnect(); }
});

test("A06 assigned seats hydrate the home list without watching old or closed rooms", async () => {
  const urls = [], sources = [];
  const transport = new SitesGameTransport({ fetcher: async (url, init) => {
    urls.push(url);
    if (url === "/api/guest-sessions") return Response.json(guest);
    if (url === "/api/guest-sessions/rooms") return Response.json([roomView("old-room"), roomView("room-1"), { ...roomView("closed-room"), status: "closed" }]);
    return Response.json(roomSync(JSON.parse(init.body)));
  }, eventSourceFactory: url => { const source = new FakeEventSource(); sources.push({ source, url }); return source; } });
  try {
    await transport.restoreGuestSession(); transport.connect();
    const rooms = await transport.recoverAssignedSeats(); assert.deepEqual(rooms.map(room => room.roomId), ["old-room", "room-1"]);
    assert.equal(sources.length, 0);
    const unwatch = transport.watchRoom("room-1"); await transport.syncRoom("room-1");
    assert.ok(sources[0].url.includes("resource=room-1"));
    assert.equal(sources[0].url.includes("old-room"), false);
    assert.equal(urls.some(url => url.includes("closed-room")), false);
    unwatch(); assert.ok(sources[0].source.closed);
  } finally { transport.disconnect(); }
});

test("Sites requests use strict DTO parsing, cookie credentials and automatic same-payload command retry", async () => {
  const calls = [];
  let failCommandOnce = true;
  const eventSources = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/guest-sessions" && init.method === "GET") return Response.json(guest);
    if (url.includes("/commands")) {
      if (failCommandOnce) {
        failCommandOnce = false;
        throw new TypeError("network dropped");
      }
      return Response.json({
        protocolVersion: 1,
        commandId: JSON.parse(init.body).commandId,
        status: "accepted",
        duplicate: false,
        aggregateVersion: 2,
        eventSeq: 2,
      });
    }
    if (url.endsWith("/sync")) return Response.json(matchSync(JSON.parse(init.body), { version: 2, eventSeq: 2 }));
    return new Response(null, { status: 404 });
  };
  const transport = new SitesGameTransport({
    fetcher,
    commandRetryIntervalMs: 1,
    createId: () => "00000000-0000-4000-8000-000000000002",
    eventSourceFactory: (url, init) => {
      const source = new FakeEventSource();
      eventSources.push({ url, init, source });
      return source;
    },
  });

  assert.deepEqual(await transport.restoreGuestSession(), guest);
  transport.connect();
  assert.equal(eventSources.length, 0, "a new guest with no membership must not open SSE");
  const command = {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000001",
    matchId: "match-1",
    expectedVersion: 1,
    type: "END_TURN",
    payload: {},
  };
  const ack = await transport.sendMatchCommand(command);
  assert.deepEqual(transport.getSnapshot().pendingCommandIds, []);
  const firstCommandCall = calls.find(({ url }) => url.endsWith("/commands"));
  assert.equal(firstCommandCall.url, "/api/matches/match-1/commands");
  assert.equal(ack.commandId, command.commandId);
  assert.equal(ack.status, "accepted");
  const commandCalls = calls.filter(({ url }) => url.endsWith("/commands"));
  assert.equal(commandCalls.length, 2);
  assert.equal(commandCalls[0].init.body, commandCalls[1].init.body);
  assert.equal(eventSources.length, 0, "an unwatched command must not retain a background subscription");
  for (const { init } of calls) {
    assert.equal(init.credentials, "include");
    assert.equal(init.cache, "no-store");
  }
  assert.deepEqual(commandCalls[0].init.headers, { "Content-Type": "application/json" });
  await waitUntil(() => calls.some(({ url }) => url.endsWith("/sync")), "accepted ACK did not schedule authoritative sync");
  transport.disconnect();
});

test("room preview, create and join use the existing HTTP DTO mapping", async () => {
  const calls = [];
  const eventSources = [];
  const requestId = "00000000-0000-4000-8000-000000000010";
  const created = { roomId: "room-1", version: 1, inviteCode: "Invite123", duplicate: false };
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    if (url === "/api/guest-sessions" && init.method === "POST") return Response.json(guest, { status: 201 });
    if (url === "/api/guest-sessions/rooms") return Response.json([roomView("room-1")]);
    if (url === "/api/rooms/preview") {
      const request = JSON.parse(init.body);
      return Response.json({ protocolVersion: 1, requestId: request.requestId, roomId: "room-1", version: 1,
        occupancy: 1, status: "waiting" });
    }
    if (url === "/api/rooms") return Response.json(created);
    if (url === "/api/rooms/room-1/commands") return Response.json(roomView("room-1"));
    if (url === "/api/rooms/room-1/sync") return Response.json(roomSync(JSON.parse(init.body)));
    return new Response(null, { status: 404 });
  };
  const transport = new SitesGameTransport({
    fetcher,
    createId: () => requestId,
    eventSourceFactory: (url, init) => {
      const source = new FakeEventSource();
      eventSources.push({ url, init, source });
      return source;
    },
  });

  assert.deepEqual(await transport.createGuestSession({ protocolVersion: 1, displayName: "Player One" }), guest);
  assert.deepEqual(await transport.recoverAssignedSeats(), [roomView("room-1")]);
  assert.deepEqual(await transport.previewInvite("Invite123"), {
    roomId: "room-1", version: 1, occupancy: 1, status: "waiting",
  });
  transport.connect();
  const unwatch = transport.watchRoom("room-1");
  eventSources[0].source.open();
  const createCommand = {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000011",
    expectedVersion: 0,
    type: "CREATE_ROOM",
    payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "Player One" },
  };
  assert.deepEqual(await transport.createRoom(createCommand), created);
  const joinCommand = {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000012",
    expectedVersion: 1,
    type: "JOIN",
    roomId: "room-1",
    payload: { inviteCode: "Invite123" },
  };
  assert.deepEqual(await transport.joinRoom(joinCommand), roomView("room-1"));
  const previewCall = calls.find(({ url }) => url === "/api/rooms/preview");
  assert.equal(previewCall.init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(previewCall.init.body), {
    protocolVersion: 1, requestId, inviteCode: "Invite123",
  });
  assert.ok(calls.some(({ url }) => url === "/api/rooms"));
  assert.ok(calls.some(({ url }) => url === "/api/rooms/room-1/commands"));
  await waitUntil(() => calls.some(({ url }) => url === "/api/rooms/room-1/sync"), "room command did not sync");
  unwatch();
  transport.disconnect();
});

test("SSE messages only invalidate, hidden streams close, and visible reconnect resumes the cursor", async () => {
  const visibility = new FakeVisibility();
  const eventSources = [];
  const syncRequests = [];
  let matchVersion = 2;
  let resolveDelayedSync;
  let delayNextSync = false;
  const fetcher = async (url, init) => {
    if (url === "/api/guest-sessions" && init.method === "GET") return Response.json(guest);
    if (url.endsWith("/sync")) {
      const request = JSON.parse(init.body);
      syncRequests.push(request);
      if (delayNextSync) {
        delayNextSync = false;
        return new Promise((resolve) => { resolveDelayedSync = () => resolve(Response.json(matchSync(request, { version: matchVersion, eventSeq: matchVersion + 1 }))); });
      }
      return Response.json(matchSync(request, { version: matchVersion, eventSeq: matchVersion + 1 }));
    }
    return new Response(null, { status: 404 });
  };
  const transport = new SitesGameTransport({
    fetcher,
    createId: (() => { let next = 0; return () => `sync-${++next}`; })(),
    visibilityTarget: visibility,
    eventSourceFactory: (url, init) => {
      const source = new FakeEventSource();
      eventSources.push({ url, init, source });
      return source;
    },
  });

  await transport.restoreGuestSession();
  transport.watchMatch("match-1");
  transport.connect();
  eventSources[0].source.open();
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.version === 2, "initial match sync did not complete");
  assert.equal(eventSources[0].init.withCredentials, true);

  matchVersion = 3;
  delayNextSync = true;
  eventSources[0].source.invalidation(9, { kind: "match", aggregateId: "match-1", version: 3, eventSeq: 4 });
  await waitUntil(() => resolveDelayedSync !== undefined, "SSE invalidation did not request authoritative sync");
  assert.equal(transport.getSnapshot().matches["match-1"].version, 2, "SSE payload must not update the projection");
  resolveDelayedSync();
  await waitUntil(() => transport.getSnapshot().matches["match-1"]?.version === 3, "authoritative sync did not update projection");

  eventSources[0].source.invalidation(10, {
    kind: "match", aggregateId: "match-1", version: 4, eventSeq: 5, privateHand: ["must-not-parse"],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(syncRequests.length, 2, "unknown SSE fields should be ignored");

  eventSources[0].source.invalidation(10, {
    kind: "match", aggregateId: "unwatched-match", version: 1, eventSeq: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(syncRequests.length, 2, "unwatched membership IDs should not trigger sync");

  visibility.setVisibility("hidden");
  assert.equal(eventSources[0].source.closed, true, "hidden tab should close its stream");
  visibility.setVisibility("visible");
  assert.equal(eventSources.length, 2);
  assert.equal(eventSources[1].url, "/api/notifications/events?after=10&resource=match-1");
  assert.equal(eventSources[1].init.withCredentials, true);
  eventSources[1].source.open();
  await waitUntil(() => syncRequests.length >= 3, "visible reconnect did not perform authoritative sync");
  transport.disconnect();
  assert.equal(visibility.listeners.size, 0);
});

test("malformed API responses do not become transport state", async () => {
  const transport = new SitesGameTransport({
    fetcher: async () => Response.json({ protocolVersion: 1, player: { playerId: "player-1", displayName: "P" },
      sessionExpiresAt: "2026-10-01T00:00:00Z", extra: "rejected" }),
  });
  await assert.rejects(transport.restoreGuestSession(), (error) =>
    error instanceof BrowserTransportError && error.code === "INVALID_RESPONSE");
  assert.equal(transport.getSnapshot().authenticated, null);
});
