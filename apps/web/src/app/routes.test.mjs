import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let resolveRoute;
let routeLocationKey;
let subscribeToRouteChanges;
let roomSurface;
let roomScreenForRoute;
let canonicalRoomPath;
let roomConnectionStatusMessage;
let isRoomProjectionInputEnabled;
let shouldRetryConnectionSync;
let syncRoomAndActiveMatch;
let RoomConnectionNotice;
let RoomProjectionFrame;
let hasRoleRevealConfirmation;
let rememberRoleRevealConfirmation;
let roleDescriptions;
let characterDescriptions;
let MatchPage;
let RoleRevealPage;
let returnToLobbyFromResult;
let BrowserGameTransport;
let waitForTransportConnection;

before(async () => {
  vite = await createServer({
    configFile: "apps/web/vite.config.ts",
    root: "apps/web",
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ resolveRoute, routeLocationKey, subscribeToRouteChanges } = await vite.ssrLoadModule("/src/app/router.tsx"));
  ({
    roomSurface,
    roomScreenForRoute,
    canonicalRoomPath,
    roomConnectionStatusMessage,
    isRoomProjectionInputEnabled,
    shouldRetryConnectionSync,
    syncRoomAndActiveMatch,
    RoomConnectionNotice,
    RoomProjectionFrame,
    hasRoleRevealConfirmation,
    rememberRoleRevealConfirmation,
    roleDescriptions,
    characterDescriptions,
    MatchPage,
    RoleRevealPage,
  } = await vite.ssrLoadModule("/src/app/pages.tsx"));
  ({ BrowserGameTransport } = await vite.ssrLoadModule("/src/transport/client.ts"));
  ({ returnToLobbyFromResult } = await vite.ssrLoadModule("/src/features/status/StatusPanel.tsx"));
  ({ waitForTransportConnection } = await vite.ssrLoadModule("/src/app/app-state.tsx"));
});

after(async () => {
  await vite?.close();
});

function room(status, activeMatchId = null) {
  return { status, activeMatchId };
}

function match(status, viewerMode = "active") {
  return {
    version: 12,
    eventSeq: 25,
    snapshot: {
      status,
      viewer: { playerId: "player-a", seatIndex: 0, mode: viewerMode },
      selfPrivate: viewerMode === "active" ? { role: "sheriff", hand: [] } : null,
    },
  };
}

function roomView({
  status = "completed",
  activeMatchId = "match-a",
  ownerPlayerId = "player-a",
  viewerPlayerId = "player-a",
  viewerIsOwner = true,
  ready = true,
} = {}) {
  return {
    roomId: "room-a",
    status,
    activeMatchId,
    ownerPlayerId,
    capacity: 4,
    rulesetVersion: "base4-ko-online-1.0",
    members: [
      { playerId: "player-a", displayName: "초원 별", seatIndex: 0, ready },
      { playerId: "player-b", displayName: "바람", seatIndex: 1, ready },
    ],
    viewer: { playerId: viewerPlayerId, isOwner: viewerIsOwner },
  };
}

function returnedLobbyRoom(previous) {
  return {
    ...previous,
    status: "waiting",
    activeMatchId: null,
    members: previous.members.map((member) => ({ ...member, ready: true })),
  };
}

test("direct room, role, game, result and invite URLs resolve to the expected path state", () => {
  assert.deepEqual(resolveRoute("/rooms/join?code=invite-only-value"), { kind: "room-join" });
  assert.deepEqual(resolveRoute("/rooms/room-a?from=bookmark"), { kind: "lobby", roomId: "room-a" });
  assert.deepEqual(resolveRoute("/rooms/room-a/role"), { kind: "role-reveal", roomId: "room-a" });
  assert.deepEqual(resolveRoute("/rooms/room-a/game"), { kind: "game", roomId: "room-a" });
  assert.deepEqual(resolveRoute("/rooms/room-a/result"), { kind: "result", roomId: "room-a" });
});

test("popstate refreshes the route key for back/forward and invite query changes", () => {
  const originalWindow = globalThis.window;
  const listeners = new Set();
  const fakeWindow = {
    location: { pathname: "/rooms/room-a/game", search: "" },
    addEventListener: (event, listener) => { if (event === "popstate") listeners.add(listener); },
    removeEventListener: (event, listener) => { if (event === "popstate") listeners.delete(listener); },
  };
  const visited = [];

  try {
    globalThis.window = fakeWindow;
    const unsubscribe = subscribeToRouteChanges(() => {
      visited.push(routeLocationKey(fakeWindow.location.pathname, fakeWindow.location.search));
    });
    fakeWindow.location.pathname = "/rooms/room-a";
    for (const listener of listeners) listener();
    fakeWindow.location.pathname = "/rooms/join";
    fakeWindow.location.search = "?code=invite-only-value";
    for (const listener of listeners) listener();
    unsubscribe();
    fakeWindow.location.pathname = "/";
    for (const listener of listeners) listener();

    assert.deepEqual(visited, ["/rooms/room-a", "/rooms/join?code=invite-only-value"]);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("RoomView activeMatchId drives lobby, sync, game and result projections", () => {
  assert.deepEqual(roomSurface(room("waiting"), undefined), { kind: "lobby" });
  assert.deepEqual(roomSurface(room("in_game", "match-a"), undefined), {
    kind: "syncing-match",
    matchId: "match-a",
  });
  assert.deepEqual(roomSurface(room("in_game", "match-a"), match("playing")), {
    kind: "game",
    matchId: "match-a",
  });
  assert.deepEqual(roomSurface(room("completed", "match-a"), match("playing")), {
    kind: "syncing-match",
    matchId: "match-a",
  });
  assert.deepEqual(roomSurface(room("completed", "match-a"), match("completed")), {
    kind: "result",
    matchId: "match-a",
  });
});

test("room connection notice is accessible and stays until authoritative route sync succeeds", () => {
  const disconnectedMessage = "연결이 끊겼어요. 다시 연결하면 게임을 이어갈 수 있어요.";
  assert.equal(roomConnectionStatusMessage("disconnected", null, true, false), disconnectedMessage);
  assert.equal(roomConnectionStatusMessage("connected", "CONNECTION", true, false), disconnectedMessage);
  assert.equal(roomConnectionStatusMessage("connected", null, true, true), disconnectedMessage);
  assert.equal(roomConnectionStatusMessage("connecting", null, true, false), "게임에 연결하고 있어요.");
  assert.equal(roomConnectionStatusMessage("connecting", null, true, true), disconnectedMessage);
  assert.equal(roomConnectionStatusMessage("connected", null, true, false), "연결 중…");
  assert.equal(roomConnectionStatusMessage("connected", null, false, false), null);
  assert.equal(isRoomProjectionInputEnabled("disconnected", null, false), false);
  assert.equal(isRoomProjectionInputEnabled("disconnected", null, false, true), true);
  assert.equal(isRoomProjectionInputEnabled("disconnected", "CONNECTION", false, true), false);
  assert.equal(isRoomProjectionInputEnabled("disconnected", null, true, true), false);
  assert.equal(isRoomProjectionInputEnabled("connected", "CONNECTION", false), false);
  assert.equal(isRoomProjectionInputEnabled("connected", null, true), false);
  assert.equal(isRoomProjectionInputEnabled("connected", null, false), true);

  const markup = renderToStaticMarkup(createElement(RoomConnectionNotice, { message: disconnectedMessage }));
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /aria-atomic="true"/);
  assert.match(markup, /연결이 끊겼어요\. 다시 연결하면 게임을 이어갈 수 있어요\./);
  assert.equal(renderToStaticMarkup(createElement(RoomConnectionNotice, { message: null })), "");
});

test("connected CONNECTION errors trigger one route resync attempt without an effect loop", () => {
  assert.equal(shouldRetryConnectionSync("connected", "CONNECTION", false), true);
  // The route sets this guard before syncing, so a repeated CONNECTION error
  // from that failed sync does not automatically start another retry.
  assert.equal(shouldRetryConnectionSync("connected", "CONNECTION", true), false);
  assert.equal(shouldRetryConnectionSync("disconnected", "CONNECTION", false), false);
  assert.equal(shouldRetryConnectionSync("disconnected", "CONNECTION", false, true), true);
  assert.equal(shouldRetryConnectionSync("connected", null, false), false);
});

test("reconnect sync waits for the current RoomView and then its active match projection", async () => {
  const calls = [];
  await syncRoomAndActiveMatch({
    async syncRoom(roomId) {
      calls.push(["room", roomId]);
      return { room: roomView({ status: "in_game", activeMatchId: "server-match" }) };
    },
    async syncMatch(matchId) {
      calls.push(["match", matchId]);
    },
  }, "room-a");
  assert.deepEqual(calls, [["room", "room-a"], ["match", "server-match"]]);

  let matchSyncCalled = false;
  await assert.rejects(syncRoomAndActiveMatch({
    async syncRoom() { throw new Error("room sync rejected"); },
    async syncMatch() { matchSyncCalled = true; },
  }, "room-a"));
  assert.equal(matchSyncCalled, false);
});

test("unconfirmed active viewers see the private role reveal before actions, including on direct game paths", () => {
  const surface = { kind: "game", matchId: "match-a" };
  const snapshot = match("playing").snapshot;

  assert.equal(roomScreenForRoute(surface, "game", snapshot, false), "role-reveal");
  assert.equal(roomScreenForRoute(surface, "role-reveal", snapshot, true), "role-reveal");
  assert.equal(roomScreenForRoute(surface, "game", snapshot, true), "game");
  assert.equal(roomScreenForRoute(surface, "game", match("playing", "eliminated_observer").snapshot, false), "game");
});

test("post-start role reveal redirects to the registered canonical role route", () => {
  const snapshot = match("playing").snapshot;
  const visibleSurface = roomScreenForRoute({ kind: "game", matchId: "match-a" }, "lobby", snapshot, false);
  const path = canonicalRoomPath("room-a", visibleSurface);

  assert.equal(visibleSurface, "role-reveal");
  assert.equal(path, "/rooms/room-a/role");
  assert.doesNotMatch(path, /role-reveal/);
  assert.deepEqual(resolveRoute(path), { kind: "role-reveal", roomId: "room-a" });
  assert.equal(canonicalRoomPath("room-a", "game"), "/rooms/room-a/game");
});

test("role confirmation stays in one tab session and a fresh tab must confirm separately", () => {
  const originalWindow = globalThis.window;
  const storage = () => {
    const values = new Map();
    return {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
    };
  };

  try {
    globalThis.window = { sessionStorage: storage() };
    assert.equal(hasRoleRevealConfirmation("match-a"), false);
    rememberRoleRevealConfirmation("match-a");
    assert.equal(hasRoleRevealConfirmation("match-a"), true);

    globalThis.window = { sessionStorage: storage() };
    assert.equal(hasRoleRevealConfirmation("match-a"), false);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});

test("role and character face copy is supplied for every canonical base-game entry", () => {
  assert.deepEqual(Object.keys(roleDescriptions).sort(), ["deputy", "outlaw", "renegade", "sheriff"]);
  assert.equal(Object.keys(characterDescriptions).length, 16);
  assert.equal(Object.values(roleDescriptions).every((copy) => copy.trim().length > 0), true);
  assert.equal(Object.values(characterDescriptions).every((copy) => copy.trim().length > 0), true);
  assert.match(characterDescriptions.jourdonnais, /뱅! 또는 개틀링 공격을 받을 때/);
});

test("role reveal renders only the viewer's role and character with canonical rule copy", () => {
  const snapshot = match("playing").snapshot;
  snapshot.publicTable = {
    players: [{
      playerId: "player-a",
      displayName: "초원 별",
      seatIndex: 0,
      characterId: "bart_cassidy",
      hp: 4,
      maxHp: 4,
      eliminated: false,
      handCount: 0,
      role: null,
      inPlay: [],
    }],
    turn: { currentPlayerId: "player-a", phase: "start" },
    deckCount: 72,
    publicDiscard: { topCard: null, count: 0 },
  };
  const markup = renderToStaticMarkup(createElement(RoleRevealPage, { snapshot, onContinue() {} }));

  assert.match(markup, /보안관/);
  assert.match(markup, /바트 캐시디/);
  assert.match(markup, /승리 목표: 무법자와 배신자를 모두 제거하세요/);
  assert.match(markup, /잃은 생명력 1당 카드 1장을 뽑아요/);
  assert.match(markup, /확인하고 게임판으로/);
  assert.doesNotMatch(markup, /바람|player-b|비공개 상대 역할/);
});

test("match route composition passes private hand, legalActions, pending and result projection to features", () => {
  const snapshot = match("playing").snapshot;
  snapshot.publicTable = {
    players: [
      { playerId: "player-a", displayName: "초원 별", seatIndex: 0, characterId: "bart_cassidy", hp: 4, maxHp: 4, eliminated: false, handCount: 1, role: null, inPlay: [] },
      { playerId: "player-b", displayName: "바람", seatIndex: 1, characterId: "black_jack", hp: 4, maxHp: 4, eliminated: false, handCount: 2, role: null, inPlay: [] },
    ],
    turn: { currentPlayerId: "player-a", phase: "play" },
    deckCount: 70,
    publicDiscard: { topCard: null, count: 0 },
  };
  snapshot.selfPrivate = {
    role: "sheriff",
    hand: [{ cardInstanceId: "private-card-id", typeId: "missed", rank: "8", suit: "HEARTS" }],
  };
  snapshot.legalActions = [{ type: "PLAY_CARD", payload: { cardInstanceId: "private-card-id", targetPlayerId: "player-b" } }];
  snapshot.pendingInteraction = {
    interactionId: "private-interaction-id",
    kind: "BANG_RESPONSE",
    allowedChoices: ["USE_MISSED"],
    currentResponderPlayerId: "player-a",
    step: { current: 1, total: 1 },
    responseOptions: [{ interactionId: "private-interaction-id", choice: "USE_MISSED", cardInstanceId: "private-card-id" }],
  };
  const transport = { sendMatchCommand: async () => { throw new Error("unexpected command"); }, syncMatch: async () => { throw new Error("unexpected sync"); } };
  const playingMarkup = renderToStaticMarkup(createElement(MatchPage, {
    matchId: "match-a",
    version: 12,
    snapshot,
    visibleEvents: [],
    room: roomView({ status: "in_game" }),
    roomVersion: 15,
    transport,
    showActions: true,
  }));

  assert.match(playingMarkup, /현재 차례/);
  assert.match(playingMarkup, /초원 별 님이 선택해 주세요/);
  assert.match(playingMarkup, /빗나감!, 8 하트/);
  assert.match(playingMarkup, /뱅! 응답/);
  assert.match(playingMarkup, /scene-hand-dock/);
  assert.equal((playingMarkup.match(/내 손패에서 카드 선택/g) ?? []).length, 1);
  assert.ok(playingMarkup.indexOf("scene-hud") < playingMarkup.indexOf("scene-board"));
  assert.ok(playingMarkup.indexOf("scene-board") < playingMarkup.indexOf("game-actions"));
  assert.doesNotMatch(playingMarkup, /private-card-id|private-interaction-id/);

  const reconnectMarkup = renderToStaticMarkup(createElement(RoomProjectionFrame, {
    message: "연결 끊김 · 재접속 시 현재 판을 복구합니다",
    inputEnabled: false,
  }, createElement(MatchPage, {
    matchId: "match-a",
    version: 12,
    snapshot,
    visibleEvents: [],
    room: roomView({ status: "in_game" }),
    roomVersion: 15,
    transport,
    showActions: true,
  })));
  assert.match(reconnectMarkup, /연결 끊김 · 재접속 시 현재 판을 복구합니다/);
  assert.match(reconnectMarkup, /<fieldset[^>]*disabled=""[^>]*aria-disabled="true"/);
  assert.match(reconnectMarkup, /뱅! 응답/);
  assert.doesNotMatch(reconnectMarkup, /private-card-id|private-interaction-id/);

  const syncedMarkup = renderToStaticMarkup(createElement(RoomProjectionFrame, {
    message: null,
    inputEnabled: true,
  }, createElement(MatchPage, {
    matchId: "match-a",
    version: 12,
    snapshot,
    visibleEvents: [],
    room: roomView({ status: "in_game" }),
    roomVersion: 15,
    transport,
    showActions: true,
  })));
  assert.doesNotMatch(syncedMarkup, /연결 끊김 · 재접속 시 현재 판을 복구합니다/);
  assert.match(syncedMarkup, /aria-disabled="false"/);

  const resultSnapshot = {
    ...snapshot,
    status: "completed",
    publicTable: {
      ...snapshot.publicTable,
      players: snapshot.publicTable.players.map((player) => ({
        ...player,
        role: player.playerId === "player-a" ? "sheriff" : "outlaw",
      })),
    },
    outcome: { winningFaction: "sheriff_and_deputies", winningPlayerIds: ["player-a"] },
    pendingInteraction: null,
  };
  const resultMarkup = renderToStaticMarkup(createElement(MatchPage, {
    matchId: "match-a",
    version: 16,
    snapshot: resultSnapshot,
    visibleEvents: [],
    room: roomView({ status: "in_game" }),
    roomVersion: 16,
    transport,
    showActions: false,
  }));

  assert.match(resultMarkup, /게임 결과/);
  assert.match(resultMarkup, /scene-result/);
  assert.match(resultMarkup, /시계 방향 게임 테이블/);
  assert.match(resultMarkup, /결과 보기/);
  assert.match(resultMarkup, /승리 플레이어/);
  assert.match(resultMarkup, /무법자/);
  assert.match(resultMarkup, /대기실로 돌아가기/);
  assert.doesNotMatch(resultMarkup, /서버가 허용한 행동|행동 입력/);
  assert.doesNotMatch(resultMarkup, /private-card-id|private-interaction-id/);

  const ownTurnSnapshot = {
    ...snapshot,
    pendingInteraction: null,
  };
  const ownTurnMarkup = renderToStaticMarkup(createElement(MatchPage, {
    matchId: "match-a", version: 12, snapshot: ownTurnSnapshot, visibleEvents: [],
    room: roomView({ status: "in_game" }), roomVersion: 15, transport, showActions: true,
  }));
  assert.equal((ownTurnMarkup.match(/내 손패에서 카드 선택/g) ?? []).length, 1);
  assert.ok(ownTurnMarkup.indexOf("scene-board") < ownTurnMarkup.indexOf("game-actions"));
});

test("result return uses one exact empty command then waits for a newer lobby sync projection", async () => {
  const completedRoom = roomView({ status: "in_game" });
  const calls = [];
  const transport = {
    async sendRoomCommand(command) {
      calls.push(["command", command]);
      return returnedLobbyRoom(completedRoom);
    },
    async syncRoom(roomId) {
      calls.push(["sync", roomId]);
      return {
        protocolVersion: 1,
        requestId: "room-sync-request",
        roomId,
        version: 19,
        requiresFullSnapshot: false,
        room: returnedLobbyRoom(completedRoom),
      };
    },
  };

  await returnToLobbyFromResult({
    room: completedRoom,
    roomVersion: 18,
    matchId: "match-a",
    matchStatus: "completed",
    matchViewerPlayerId: "player-a",
    transport,
    commandId: "fresh-command-id",
  });

  assert.deepEqual(calls, [
    ["command", {
      protocolVersion: 1,
      commandId: "fresh-command-id",
      expectedVersion: 18,
      type: "RETURN_TO_LOBBY",
      roomId: "room-a",
      payload: {},
    }],
    ["sync", "room-a"],
  ]);
  const nextRoom = returnedLobbyRoom(completedRoom);
  assert.deepEqual(roomSurface(nextRoom, undefined), { kind: "lobby" });
  assert.equal(canonicalRoomPath(nextRoom.roomId, "lobby"), "/rooms/room-a");
});

test("rejected or thrown return transport keeps the result operation retryable", async () => {
  const completedRoom = roomView({ status: "in_game" });
  let syncCalls = 0;
  const rejectedTransport = {
    async sendRoomCommand(command) {
      return {
        protocolVersion: 1,
        commandId: command.commandId,
        status: "rejected",
        error: { code: "STALE_VERSION", messageKey: "stale", retryable: true },
      };
    },
    async syncRoom() {
      syncCalls += 1;
      throw new Error("should not sync a rejected command");
    },
  };
  await assert.rejects(returnToLobbyFromResult({
    room: completedRoom,
    roomVersion: 18,
    matchId: "match-a",
    matchStatus: "completed",
    matchViewerPlayerId: "player-a",
    transport: rejectedTransport,
    commandId: "rejected-command-id",
  }));
  assert.equal(syncCalls, 0);

  const thrownTransport = {
    async sendRoomCommand() { throw new Error("socket disconnected"); },
    async syncRoom() { throw new Error("unexpected sync"); },
  };
  await assert.rejects(returnToLobbyFromResult({
    room: completedRoom,
    roomVersion: 18,
    matchId: "match-a",
    matchStatus: "completed",
    matchViewerPlayerId: "player-a",
    transport: thrownTransport,
    commandId: "retry-command-id",
  }));
});

test("room operations can wait for the new cookie-authenticated socket connection", async () => {
  const originalWindow = globalThis.window;
  const socketListeners = new Map();
  const socket = {
    connected: false,
    on(event, listener) {
      const listeners = socketListeners.get(event) ?? [];
      listeners.push(listener);
      socketListeners.set(event, listeners);
    },
    off(event, listener) {
      socketListeners.set(event, (socketListeners.get(event) ?? []).filter((item) => item !== listener));
    },
    connect() {
      this.connected = true;
      for (const listener of socketListeners.get("connect") ?? []) listener();
    },
    disconnect() {
      this.connected = false;
      for (const listener of socketListeners.get("disconnect") ?? []) listener();
    },
    emit() {},
  };

  try {
    globalThis.window = { setTimeout, clearTimeout };
    const transport = new BrowserGameTransport({ socketFactory: () => socket });
    await waitForTransportConnection(transport, 500);
    assert.equal(socket.connected, true);
    assert.equal(transport.getSnapshot().connection, "connected");
    assert.equal(transport.getSnapshot().authenticated, true);
    transport.disconnect();
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});


test("role introduction assigns the interactive portrait and text to explicit grid columns", () => {
  const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
  assert.match(css, /\.role-reveal-page__cards > \.roster-card > \.roster-card__detail\s*\{[^}]*grid-column: 1;[^}]*grid-row: 1 \/ 3;/);
  assert.match(css, /\.role-reveal-page__cards > \.roster-card > p\s*\{[^}]*grid-column: 2;[^}]*grid-row: 2;[^}]*word-break: keep-all;/);
  assert.match(css, /\.role-reveal-page__cards > \.roster-card > p\s*\{ grid-column: 1 \/ -1; \}/);
  assert.doesNotMatch(css, /\.role-reveal-page__cards \.roster-card p/);
});
