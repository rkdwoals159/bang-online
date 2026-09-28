import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  createActionCommand,
  getCardProposalIndexes,
  getTargetOptions,
  sendAndRefreshAction,
} from "./model.ts";

let vite;
let ActionsPanel;

before(async () => {
  vite = await createServer({
    configFile: "apps/web/vite.config.ts",
    root: "apps/web",
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ ActionsPanel } = await vite.ssrLoadModule("/src/features/actions/ActionsPanel.tsx"));
});

after(async () => {
  await vite?.close();
});

const hand = [
  { cardInstanceId: "own-bang", typeId: "bang", rank: "A", suit: "SPADES" },
  { cardInstanceId: "own-beer", typeId: "beer", rank: "7", suit: "HEARTS" },
];

const proposals = [
  { type: "PLAY_CARD", payload: { cardInstanceId: "own-bang", targetPlayerId: "player-b" } },
  { type: "PLAY_CARD", payload: { cardInstanceId: "own-bang", targetPlayerId: "player-d" } },
  { type: "END_TURN", payload: {} },
];

function snapshot({ status = "playing", legalActions = proposals } = {}) {
  return {
    status,
    viewer: { playerId: "player-a", seatIndex: 0, mode: "active" },
    publicTable: {
      players: [
        { playerId: "player-a", displayName: "초원 별", seatIndex: 0, characterId: "bart_cassidy", hp: 4, maxHp: 4, eliminated: false, handCount: 2, role: "sheriff", inPlay: [] },
        { playerId: "player-b", displayName: "바람", seatIndex: 1, characterId: "black_jack", hp: 4, maxHp: 4, eliminated: false, handCount: 2, role: null, inPlay: [] },
        { playerId: "player-c", displayName: "노을", seatIndex: 2, characterId: "el_gringo", hp: 3, maxHp: 3, eliminated: false, handCount: 1, role: null, inPlay: [] },
        { playerId: "player-d", displayName: "먼지", seatIndex: 3, characterId: "willy_the_kid", hp: 4, maxHp: 4, eliminated: false, handCount: 1, role: null, inPlay: [] },
      ],
      turn: { currentPlayerId: "player-a", phase: "play" },
      deckCount: 50,
      publicDiscard: { topCard: null, count: 0 },
    },
    selfPrivate: { role: "sheriff", hand },
    legalActions,
    pendingInteraction: null,
  };
}

function syncResponse({ version = 8, matchSnapshot = snapshot() } = {}) {
  return {
    protocolVersion: 1,
    requestId: "sync-request",
    matchId: "match-a",
    version,
    eventSeq: 12,
    requiresFullSnapshot: true,
    snapshot: matchSnapshot,
    visibleEvents: [],
  };
}

test("offers only card and target candidates from legalActions", () => {
  assert.deepEqual(getCardProposalIndexes(proposals, "own-bang"), [0, 1]);
  assert.deepEqual(getCardProposalIndexes(proposals, "own-beer"), []);

  const targets = getTargetOptions(snapshot(), proposals, [0, 1]);
  assert.deepEqual(targets, [
    { index: 0, label: "바람" },
    { index: 1, label: "먼지" },
  ]);
  assert.doesNotMatch(JSON.stringify(targets), /노을|player-c|own-beer/);
});

test("keeps server-approved self table targets and never exposes a target hand card ID", () => {
  const targetSnapshot = snapshot();
  targetSnapshot.publicTable.players[0].inPlay.push({
    cardInstanceId: "self-mustang",
    typeId: "mustang",
    rank: "K",
    suit: "CLUBS",
  });
  const candidates = [
    { type: "PLAY_CARD", payload: { cardInstanceId: "own-panic", targetPlayerId: "player-a", targetZone: "IN_PLAY", targetCardInstanceId: "self-mustang" } },
    { type: "PLAY_CARD", payload: { cardInstanceId: "own-panic", targetPlayerId: "player-b", targetZone: "HAND" } },
  ];

  assert.deepEqual(getTargetOptions(targetSnapshot, candidates, [0, 1]), [
    { index: 0, label: "초원 별 · 머스탱" },
    { index: 1, label: "바람 · 손패에서 무작위 카드 1장" },
  ]);
  assert.doesNotMatch(JSON.stringify(getTargetOptions(targetSnapshot, candidates, [1])), /cardInstanceId|self-mustang|own-panic/);
});

test("wraps a selected server proposal with protocol version, current version, match, and idempotency ID", () => {
  const command = createActionCommand("match-a", 17, "command-id-1", proposals[0]);

  assert.deepEqual(command, {
    protocolVersion: 1,
    commandId: "command-id-1",
    matchId: "match-a",
    expectedVersion: 17,
    type: "PLAY_CARD",
    payload: { cardInstanceId: "own-bang", targetPlayerId: "player-b" },
  });
});

test("syncs the latest projection after server rejection so selection can be rebuilt", async () => {
  const callOrder = [];
  const latest = syncResponse({
    version: 19,
    matchSnapshot: snapshot({ legalActions: [{ type: "END_TURN", payload: {} }] }),
  });
  const command = createActionCommand("match-a", 18, "same-command-id", proposals[0]);
  const result = await sendAndRefreshAction({
    async sendMatchCommand(received) {
      callOrder.push("send");
      assert.deepEqual(received, command);
      return {
        protocolVersion: 1,
        commandId: command.commandId,
        status: "rejected",
        error: { code: "STALE_VERSION", messageKey: "match.staleVersion", retryable: true, currentVersion: 19 },
      };
    },
    async syncMatch(matchId) {
      callOrder.push("sync");
      assert.equal(matchId, "match-a");
      return latest;
    },
  }, command);

  assert.deepEqual(callOrder, ["send", "sync"]);
  assert.equal(result.acknowledgement.status, "rejected");
  assert.equal(result.projection.version, 19);
  assert.deepEqual(result.projection.snapshot.legalActions, [{ type: "END_TURN", payload: {} }]);
});

test("keeps a timed-out retry on the same command ID and payload", async () => {
  const command = createActionCommand("match-a", 18, "stable-command-id", proposals[0]);
  const sent = [];
  const transport = {
    async sendMatchCommand(received) {
      sent.push(received);
      return { protocolVersion: 1, commandId: command.commandId, status: "accepted", duplicate: sent.length > 1, aggregateVersion: 19, eventSeq: 12 };
    },
    async syncMatch() {
      return syncResponse({ version: 19 });
    },
  };

  await sendAndRefreshAction(transport, command);
  await sendAndRefreshAction(transport, command);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(sent[1].commandId, "stable-command-id");
  assert.deepEqual(sent[1].payload, proposals[0].payload);
});

test("renders legal cards as selectable, illegal cards as disabled, and hides all inputs outside active play", () => {
  const transport = { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse() };
  const active = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18, snapshot: snapshot(), transport, createCommandId: () => "unused",
  }));
  assert.match(active, /뱅! A 스페이드, 합법 행동 선택 가능/);
  assert.match(active, /맥주 7 하트, 지금 선택할 수 없음/);
  assert.match(active, /aria-label="맥주 7 하트, 지금 선택할 수 없음" disabled=""/);
  assert.doesNotMatch(active, /<button[^>]+노을/);

  const ended = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18, snapshot: snapshot({ status: "completed" }), transport,
  }));
  assert.match(ended, /현재 게임 상태에서는 행동을 입력할 수 없습니다/);
  assert.doesNotMatch(ended, /<button/);
});
