import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  buildMatchStatusViewModel,
  formatLogTime,
  isMatchActionInputEnabled,
  PUBLIC_LOG_PAGE_SIZE,
  mergeMatchStatusProjection,
  mergePublicEvents,
} from "./model.ts";

let vite;
test("log time shows local clock and elapsed seconds, including invalid/future timestamps", () => {
  const date = new Date(2026, 9, 5, 12, 34, 56);
  assert.equal(formatLogTime(date.toISOString(), date.getTime() + 5200), "12:34:56(5초 전)");
  assert.equal(formatLogTime(date.toISOString(), date.getTime() - 1000), "12:34:56(0초 전)");
  assert.equal(formatLogTime("invalid", date.getTime()), "시간 정보 없음");
  assert.equal(formatLogTime(date.toISOString(), date.getTime() + 59_999), "12:34:56(59초 전)");
  assert.equal(formatLogTime(date.toISOString(), date.getTime() + 60_000), "12:34:56(1분 전)");
  assert.equal(formatLogTime(date.toISOString(), date.getTime() + 119_999), "12:34:56(1분 전)");
  assert.equal(formatLogTime(date.toISOString(), date.getTime() + 120_000), "12:34:56(2분 전)");
});
let StatusPanel;
let MatchInputGate;
let attemptReturnToLobby;
let canReturnToLobbyFromResult;
let returnToLobbyFromResult;
let createSingleFlightRunner;

before(async () => {
  vite = await createServer({
    configFile: "apps/web/vite.config.ts",
    root: "apps/web",
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ StatusPanel, MatchInputGate, attemptReturnToLobby, canReturnToLobbyFromResult, returnToLobbyFromResult, createSingleFlightRunner } =
    await vite.ssrLoadModule("/src/features/status/StatusPanel.tsx"));
});

after(async () => {
  await vite?.close();
});

function sync({
  version = 8,
  status = "playing",
  phase = "play",
  currentPlayerId = "player-a",
  visibleEvents = [],
  roles = ["sheriff", null],
  outcome,
} = {}) {
  return {
    version,
    snapshot: {
      status,
      viewer: { playerId: "player-a", seatIndex: 0, mode: "active" },
      publicTable: {
        players: [
          { playerId: "player-a", displayName: "초원 별", seatIndex: 0, characterId: "bart_cassidy", hp: 4, maxHp: 4, eliminated: false, handCount: 3, role: roles[0], inPlay: [] },
          { playerId: "player-b", displayName: "바람", seatIndex: 1, characterId: "black_jack", hp: 4, maxHp: 4, eliminated: false, handCount: 2, role: roles[1], inPlay: [] },
        ],
        turn: { currentPlayerId, phase },
        deckCount: 50,
        publicDiscard: { topCard: null, count: 0 },
      },
      selfPrivate: { role: "sheriff", hand: [] },
      pendingInteraction: null,
      ...(outcome ? { outcome } : {}),
    },
    visibleEvents,
  };
}

function event(eventSeq, type, payload = {}) {
  return {
    eventSeq,
    type,
    occurredAt: "2026-09-28T00:00:00.000Z",
    payload,
  };
}

function roomView({
  status = "completed",
  activeMatchId = "match-a",
  viewerPlayerId = "player-a",
  viewerIsOwner = true,
  ownerPlayerId = "player-a",
  ready = true,
  version = 18,
} = {}) {
  return {
    roomId: "room-a",
    version,
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

test("merges public event batches in eventSeq order and deduplicates without filling hidden gaps", () => {
  const initial = [event(7, "BANG_ATTACKED"), event(3, "BANG_HIT"), event(7, "BANG_MISSED")];
  const events = mergePublicEvents(initial, [event(10, "DUEL_STARTED"), event(8, "BEER_USED"), event(8, "SALOON_USED")]);

  assert.deepEqual(events.map(({ eventSeq }) => eventSeq), [3, 7, 8, 10]);
  assert.deepEqual(events.map(({ type }) => type), ["BANG_HIT", "BANG_ATTACKED", "BEER_USED", "DUEL_STARTED"]);
});

test("retains older public events beyond the rendered page size", () => {
  const events = mergePublicEvents([], Array.from({ length: PUBLIC_LOG_PAGE_SIZE + 40 }, (_, index) =>
    event(index + 1, "BANG_HIT"),
  ));

  assert.equal(events.length, PUBLIC_LOG_PAGE_SIZE + 40);
  assert.equal(events[0]?.eventSeq, 1);
  assert.equal(events.at(-1)?.eventSeq, PUBLIC_LOG_PAGE_SIZE + 40);
});

test("ignores stale sync versions and preserves the newer turn, status, and event feed", () => {
  const current = mergeMatchStatusProjection(null, sync({ version: 12, currentPlayerId: "player-b", phase: "discard" }));
  const merged = mergeMatchStatusProjection(current, sync({
    version: 11,
    status: "completed",
    visibleEvents: [event(20, "BANG_HIT")],
  }));

  assert.equal(merged, current);
  assert.equal(merged.version, 12);
  assert.equal(merged.status, "playing");
  assert.deepEqual(merged.turn, { currentPlayerId: "player-b", phase: "discard" });
  assert.deepEqual(merged.visibleEvents, []);
  assert.equal(merged.outcome, null);
});

test("builds current turn text from the projection and closes input for every non-playing status", () => {
  const projection = mergeMatchStatusProjection(null, sync({ currentPlayerId: "player-b", phase: "draw" }));
  const view = buildMatchStatusViewModel(projection);

  assert.equal(view.currentPlayerName, "바람");
  assert.equal(view.phaseLabel, "카드 뽑기");
  assert.equal(view.inputEnabled, true);
  assert.equal(isMatchActionInputEnabled("playing"), true);
  for (const status of ["paused", "completed", "recovery_required"]) {
    assert.equal(isMatchActionInputEnabled(status), false, status);
  }
});

test("keeps public log closed by default and formats only allowlisted events without payloads", () => {
  const secret = "private-resolution-sentinel";
  const syncProjection = sync({ visibleEvents: [
    event(9, "PRIVATE_HAND_DRAWN", { cardInstanceId: secret }),
    event(6, "BANG_HIT", { actorPlayerId: "player-a", targetPlayerId: "player-b", secret }),
    event(4, "BANG_ATTACKED", { actorPlayerId: "player-a", targetPlayerId: "player-b" }),
    event(6, "BANG_MISSED", { targetPlayerId: "player-b" }),
  ] });
  const view = buildMatchStatusViewModel(mergeMatchStatusProjection(null, syncProjection));
  const html = renderToStaticMarkup(createElement(StatusPanel, { sync: syncProjection }));

  assert.deepEqual(view.publicLog.map(({ eventSeq }) => eventSeq), [6, 4]);
  assert.match(view.publicLog[1].message, /초원 별 님이 바람 님을 뱅!으로 공격해요\./);
  assert.equal(view.publicLog[0].message, "초원 별 님의 뱅!이 바람 님에게 적중했어요.");
  assert.match(html, /게임 기록/);
  assert.doesNotMatch(html, /data-event-seq=|뱅!으로 공격해요\.|private-resolution-sentinel/);
  assert.match(html, /현재 차례/);
  assert.match(html, /초원 별/);
  assert.match(html, /카드 사용/);
  assert.match(html, /<details class="match-status__log">/);
  assert.doesNotMatch(html, /<details class="match-status__log" open=/);
  assert.doesNotMatch(html, /PRIVATE_HAND_DRAWN|private-resolution-sentinel|player-a|cardInstanceId|secret/);
});

test("completed status renders a read-only result state and no action control", () => {
  const html = renderToStaticMarkup(createElement(StatusPanel, {
    sync: sync({
      status: "completed",
      roles: ["sheriff", "outlaw"],
      outcome: { winningFaction: "outlaws", winningPlayerIds: ["player-b"] },
      visibleEvents: [
        event(12, "DUEL_YIELDED"),
        event(13, "MATCH_COMPLETED", { endReason: "private-terminal-reason" }),
      ],
    }),
  }));

  assert.match(html, /data-input-enabled="false"/);
  assert.match(html, /게임 결과/);
  assert.match(html, /게임이 끝났어요\./);
  assert.match(html, /무법자 진영/);
  assert.match(html, /승리 플레이어/);
  assert.match(html, /바람/);
  assert.match(html, /공개된 역할/);
  assert.match(html, /초원 별/);
  assert.match(html, /보안관/);
  assert.match(html, /무법자/);
  assert.doesNotMatch(html, /<button|winningFaction|winningPlayerIds|player-b|MATCH_COMPLETED|private-terminal-reason/);
});

test("non-owner result view explains that the host returns everyone to the lobby", () => {
  const html = renderToStaticMarkup(createElement(StatusPanel, {
    sync: sync({
      status: "completed",
      outcome: { winningFaction: "outlaws", winningPlayerIds: ["player-b"] },
    }),
    room: roomView({ status: "in_game", viewerIsOwner: false }),
    roomVersion: 18,
    matchId: "match-a",
    transport: { async sendRoomCommand() {}, async syncRoom() {} },
  }));

  assert.match(html, /대기실로 돌아가는 일은 방장이 진행해요/);
  assert.doesNotMatch(html, /대기실로 돌아가기/);
});

test("result return action is visible only for the matching completed match in its in-game owner room", () => {
  const completed = sync({ status: "completed", outcome: { winningFaction: "outlaws", winningPlayerIds: ["player-b"] } });
  const transport = { async sendRoomCommand() {}, async syncRoom() {} };
  const ownerProps = {
    sync: completed,
    room: roomView({ status: "in_game" }),
    roomVersion: 18,
    matchId: "match-a",
    transport,
    createCommandId: () => "fresh-command-id",
  };

  const ownerMarkup = renderToStaticMarkup(createElement(StatusPanel, ownerProps));
  assert.match(ownerMarkup, /대기실로 돌아가기/);
  assert.match(ownerMarkup, /aria-busy="false"/);
  assert.equal(canReturnToLobbyFromResult("match-a", "completed", "player-a", roomView({ status: "in_game" })), true);

  const blockedCases = [
    { ...ownerProps, sync: sync({ status: "playing" }) },
    ...["waiting", "starting", "paused", "completed", "closed"].map((status) => ({
      ...ownerProps,
      room: roomView({ status }),
    })),
    { ...ownerProps, room: roomView({ activeMatchId: "older-match" }) },
    { ...ownerProps, room: roomView({ viewerPlayerId: "player-b", viewerIsOwner: false }) },
    { ...ownerProps, room: roomView({ viewerIsOwner: false }) },
    { ...ownerProps, room: roomView({ viewerPlayerId: "player-b", viewerIsOwner: true }) },
    { ...ownerProps, room: roomView({ ownerPlayerId: "player-b" }) },
    {
      ...ownerProps,
      sync: {
        ...completed,
        snapshot: {
          ...completed.snapshot,
          viewer: { ...completed.snapshot.viewer, playerId: "player-b" },
        },
      },
    },
    { ...ownerProps, room: undefined },
  ];
  for (const props of blockedCases) {
    const markup = renderToStaticMarkup(createElement(StatusPanel, props));
    assert.doesNotMatch(markup, /대기실로 돌아가기/);
  }
  assert.equal(canReturnToLobbyFromResult("match-a", "completed", "player-a", roomView({ status: "in_game", viewerIsOwner: false })), false);
  assert.equal(canReturnToLobbyFromResult("match-a", "completed", "player-b", roomView({ status: "in_game" })), false);
  assert.equal(canReturnToLobbyFromResult("match-a", "completed", "player-a", roomView({ status: "in_game", ownerPlayerId: "player-b" })), false);
});

test("return action single-flight guard ignores a second click while busy and accepts a later retry", async () => {
  const run = createSingleFlightRunner();
  let releaseFirst;
  const waitForFirst = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  let starts = 0;
  let finishes = 0;
  const first = run(async () => {
    calls.push("first");
    await waitForFirst;
  }, () => { starts += 1; }, () => { finishes += 1; });
  const duplicate = await run(async () => { calls.push("duplicate"); }, () => { starts += 1; }, () => { finishes += 1; });

  assert.equal(duplicate, false);
  assert.deepEqual(calls, ["first"]);
  releaseFirst();
  assert.equal(await first, true);
  assert.equal(starts, 1);
  assert.equal(finishes, 1);
  assert.equal(await run(async () => { calls.push("retry"); }, () => { starts += 1; }, () => { finishes += 1; }), true);
  assert.deepEqual(calls, ["first", "retry"]);
});

test("rejected commands and thrown transport errors produce retryable Korean guidance", async () => {
  const rejected = await attemptReturnToLobby(async () => {
    throw new Error("command rejected");
  });
  const transportError = await attemptReturnToLobby(async () => {
    throw new Error("socket disconnected");
  });

  assert.deepEqual(rejected, transportError);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /대기실로 돌아가지 못했어요/);
  assert.match(rejected.message, /다시 시도해 주세요/);
});

test("uses a newer confirmed room command response and syncs only for older acknowledgements", async () => {
  const previousRoom = roomView({ status: "in_game", version: 18 });
  const returnedRoom = {
    ...previousRoom,
    status: "waiting",
    activeMatchId: null,
    version: 19,
    members: previousRoom.members.map((member) => ({ ...member, ready: true })),
  };
  let syncCalls = 0;
  await returnToLobbyFromResult({
    room: previousRoom,
    roomVersion: 18,
    matchId: "match-a",
    matchStatus: "completed",
    matchViewerPlayerId: "player-a",
    commandId: "return-command",
    transport: {
      async sendRoomCommand() { return returnedRoom; },
      async syncRoom() { syncCalls += 1; throw new Error("unexpected sync"); },
    },
  });
  assert.equal(syncCalls, 0);

  await returnToLobbyFromResult({
    room: previousRoom,
    roomVersion: 18,
    matchId: "match-a",
    matchStatus: "completed",
    matchViewerPlayerId: "player-a",
    commandId: "fallback-command",
    transport: {
      async sendRoomCommand() { const { version: _version, ...legacyRoom } = returnedRoom; return legacyRoom; },
      async syncRoom() {
        syncCalls += 1;
        return {
          protocolVersion: 1,
          requestId: "sync-request",
          roomId: "room-a",
          version: 19,
          requiresFullSnapshot: false,
          room: returnedRoom,
        };
      },
    },
  });
  assert.equal(syncCalls, 1);
});

test("does not infer an outcome before completion or expose winner IDs when a name is missing", () => {
  const active = buildMatchStatusViewModel(mergeMatchStatusProjection(null, sync({
    outcome: { winningFaction: "outlaws", winningPlayerIds: ["player-b"] },
  })));
  assert.equal(active.winningFactionLabel, null);
  assert.deepEqual(active.winningPlayerNames, []);
  assert.deepEqual(active.revealedRoles, []);

  const completed = buildMatchStatusViewModel(mergeMatchStatusProjection(null, sync({
    status: "completed",
    outcome: { winningFaction: "outlaws", winningPlayerIds: ["missing-player"] },
  })));
  assert.equal(completed.winningFactionLabel, "무법자 진영");
  assert.deepEqual(completed.winningPlayerNames, []);
});

test("server status gate removes action controls after play has ended", () => {
  const closed = renderToStaticMarkup(createElement(MatchInputGate, {
    status: "completed",
    children: createElement("button", { type: "button" }, "Play card"),
  }));
  const open = renderToStaticMarkup(createElement(MatchInputGate, {
    status: "playing",
    children: createElement("button", { type: "button" }, "Play card"),
  }));

  assert.match(closed, /data-input-enabled="false"/);
  assert.match(closed, /지금은 행동을 고를 수 없어요\./);
  assert.doesNotMatch(closed, /<button/);
  assert.match(open, /data-input-enabled="true"/);
  assert.match(open, /<button[^>]*>Play card<\/button>/);
});
