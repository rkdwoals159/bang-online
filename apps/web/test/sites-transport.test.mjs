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

test("Sites requests use strict DTO parsing, cookie credentials and same-payload command retry", async () => {
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
    createId: () => "00000000-0000-4000-8000-000000000002",
    eventSourceFactory: (url, init) => {
      const source = new FakeEventSource();
      eventSources.push({ url, init, source });
      return source;
    },
  });

  assert.deepEqual(await transport.restoreGuestSession(), guest);
  transport.connect();
  eventSources[0].source.open();
  const command = {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000001",
    matchId: "match-1",
    expectedVersion: 1,
    type: "END_TURN",
    payload: {},
  };
  await assert.rejects(transport.sendMatchCommand(command), (error) =>
    error instanceof BrowserTransportError && error.code === "HTTP_REQUEST_FAILED");
  assert.deepEqual(transport.getSnapshot().pendingCommandIds, [command.commandId]);
  const firstCommandCall = calls.find(({ url }) => url.endsWith("/commands"));
  assert.equal(firstCommandCall.url, "/api/matches/match-1/commands");
  const ack = await transport.retryPendingCommand(command.commandId);
  assert.equal(ack.commandId, command.commandId);
  assert.equal(ack.status, "accepted");
  const commandCalls = calls.filter(({ url }) => url.endsWith("/commands"));
  assert.equal(commandCalls.length, 2);
  assert.equal(commandCalls[0].init.body, commandCalls[1].init.body);
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
  assert.equal(eventSources[1].url, "/api/notifications/events?after=10");
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
