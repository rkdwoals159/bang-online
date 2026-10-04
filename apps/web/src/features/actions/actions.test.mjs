import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  createActionCommand,
  findSidAbilityProposalIndex,
  resolveSidAbilityProposal,
  getCardProposalIndexes,
  getTargetOptions,
  noHealBeerReasons,
  sendAndRefreshAction,
} from "./model.ts";

let vite;
let ActionsPanel;

test("P03 compact Sid costs authorize any distinct allowed pair and reject fabricated costs", () => {
  const proposal = { type: "USE_ABILITY", payload: { abilityId: "sid-ketchum", cardInstanceIds: ["a", "b"] },
    costSelection: { requiredCount: 2, allowedCardInstanceIds: ["a", "b", "c", "d"] } };
  assert.equal(findSidAbilityProposalIndex([proposal], "c", "d"), 0);
  assert.deepEqual(resolveSidAbilityProposal(proposal, "c", "d").payload.cardInstanceIds, ["c", "d"]);
  assert.equal(resolveSidAbilityProposal(proposal, "a", "a"), null);
  assert.equal(resolveSidAbilityProposal(proposal, "a", "unknown"), null);
});

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

function snapshot({ status = "playing", legalActions = proposals, currentPlayerId = "player-a", pendingInteraction = null, selfPrivate = { role: "sheriff", hand } } = {}) {
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
      turn: { currentPlayerId, phase: "play" },
      deckCount: 50,
      publicDiscard: { topCard: null, count: 0 },
    },
    selfPrivate,
    legalActions,
    pendingInteraction,
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

test("explains only the two public no-recovery Beer conditions", () => {
  const atMaximum = snapshot();
  assert.deepEqual(noHealBeerReasons(atMaximum, "own-beer"), ["현재 생명력이 최대라 회복량은 0이에요."]);

  const twoPlayersLeft = snapshot();
  twoPlayersLeft.publicTable.players[0].hp = 3;
  twoPlayersLeft.publicTable.players[2].eliminated = true;
  twoPlayersLeft.publicTable.players[3].eliminated = true;
  assert.deepEqual(noHealBeerReasons(twoPlayersLeft, "own-beer"), ["생존자가 2명일 때는 맥주 회복량이 0이에요."]);

  const both = snapshot();
  both.publicTable.players[2].eliminated = true;
  both.publicTable.players[3].eliminated = true;
  assert.deepEqual(noHealBeerReasons(both, "own-beer"), [
    "현재 생명력이 최대라 회복량은 0이에요.",
    "생존자가 2명일 때는 맥주 회복량이 0이에요.",
  ]);
  assert.deepEqual(noHealBeerReasons(atMaximum, "own-bang"), []);
});

test("maps a distinct Sid cost pair only to its exact projected ability proposal", () => {
  const abilityActions = [
    { type: "USE_ABILITY", payload: { cardInstanceIds: ["card-a", "card-b"] } },
    { type: "USE_ABILITY", payload: { cardInstanceIds: ["card-a", "card-c"] } },
  ];
  const index = findSidAbilityProposalIndex(abilityActions, "card-b", "card-a");
  assert.equal(index, 0);
  assert.equal(findSidAbilityProposalIndex(abilityActions, "card-b", "card-d"), null);
  assert.equal(findSidAbilityProposalIndex(abilityActions, "card-a", "card-a"), null);
  assert.deepEqual(createActionCommand("match-a", 5, "exact", abilityActions[index]), {
    protocolVersion: 1,
    commandId: "exact",
    matchId: "match-a",
    expectedVersion: 5,
    type: "USE_ABILITY",
    payload: { cardInstanceIds: ["card-a", "card-b"] },
  });
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

test("shows the acknowledgement phase before awaiting the authoritative projection", async () => {
  const order = [];
  let finishSync;
  let markSyncStarted;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const pendingSync = new Promise((resolve) => { finishSync = resolve; });
  const command = createActionCommand("match-a", 18, "command-id", proposals[0]);
  const operation = sendAndRefreshAction({
    async sendMatchCommand() {
      order.push("send");
      return { protocolVersion: 1, commandId: "command-id", status: "accepted", duplicate: false, aggregateVersion: 19, eventSeq: 13 };
    },
    syncMatch() {
      order.push("sync");
      markSyncStarted();
      return pendingSync;
    },
  }, command, (acknowledgement) => order.push(`ack:${acknowledgement.status}`));

  await syncStarted;
  assert.deepEqual(order, ["send", "ack:accepted", "sync"]);
  finishSync(syncResponse({ version: 19 }));
  const result = await operation;
  assert.equal(result.projection.version, 19);
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

test("renders available cards as selectable, explains unavailable cards, and hides inputs outside active play", () => {
  const transport = { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse() };
  const active = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18, snapshot: snapshot(), transport, createCommandId: () => "unused",
  }));
  assert.match(active, /뱅! A 스페이드, 사용 가능/);
  assert.match(active, /맥주 7 하트, 지금 가능한 사용 방법이 없어요/);
  assert.match(active, /aria-label="맥주 7 하트, 지금 가능한 사용 방법이 없어요" disabled=""/);
  assert.equal((active.match(/내 손패에서 카드 선택/g) ?? []).length, 1);
  assert.doesNotMatch(active, /<button[^>]+노을/);

  const ended = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18, snapshot: snapshot({ status: "completed" }), transport,
  }));
  assert.match(ended, /지금은 행동을 고를 수 없어요/);
  assert.doesNotMatch(ended, /<button/);
});

test("shows turn ownership and pending response without making card actions available", () => {
  const transport = { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse() };
  const otherTurn = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18, snapshot: snapshot({ currentPlayerId: "player-b" }), transport,
  }));
  assert.match(otherTurn, /바람 님 차례예요/);
  assert.match(otherTurn, /disabled=""/);
  assert.doesNotMatch(otherTurn, /<button class="game-actions__button game-actions__button--secondary"[^>]*>턴 종료/);

  const pending = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18,
    snapshot: snapshot({ pendingInteraction: {
      interactionId: "private-interaction-id", kind: "BANG_RESPONSE", allowedChoices: ["USE_MISSED"],
      currentResponderPlayerId: "player-a", step: { current: 1, total: 1 },
      responseOptions: [{ interactionId: "private-interaction-id", choice: "USE_MISSED", cardInstanceId: "own-beer" }],
    } }),
    transport,
  }));
  assert.match(pending, /내 응답 차례예요/);
  assert.equal((pending.match(/내 손패에서 카드 선택/g) ?? []).length, 1);
  assert.match(pending, /응답이 끝나면 선택할 수 있어요/);
  assert.doesNotMatch(pending, /private-interaction-id|own-beer/);
});

test("renders two linear Sid cost selectors instead of one button per card pair", () => {
  const largeHand = Array.from({ length: 80 }, (_, index) => ({
    cardInstanceId: `private-hand-${index}`,
    typeId: index % 2 === 0 ? "beer" : "bang",
    rank: String(index % 13 + 1),
    suit: ["SPADES", "HEARTS", "DIAMONDS", "CLUBS"][index % 4],
  }));
  const abilityActions = [];
  for (let first = 0; first < largeHand.length; first += 1) {
    for (let second = first + 1; second < largeHand.length; second += 1) {
      abilityActions.push({
        type: "USE_ABILITY",
        payload: { cardInstanceIds: [largeHand[first].cardInstanceId, largeHand[second].cardInstanceId] },
      });
    }
  }
  const largeSnapshot = snapshot({ legalActions: abilityActions, selfPrivate: { role: "sheriff", hand: largeHand } });
  largeSnapshot.publicTable.players[0].characterId = "sid_ketchum";
  const markup = renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a", version: 18, snapshot: largeSnapshot,
    transport: { sendMatchCommand: async () => { throw new Error("unselected costs must not submit"); }, syncMatch: async () => syncResponse({ matchSnapshot: largeSnapshot }) },
  }));

  assert.equal(abilityActions.length, 3160);
  assert.equal((markup.match(/<select\b/g) ?? []).length, 2);
  assert.equal((markup.match(/<option\b/g) ?? []).length, 162);
  assert.doesNotMatch(markup, /<button[^>]*class="game-actions__ability/);
  assert.match(markup, /aria-label="첫 번째 능력 비용 카드"/);
  assert.match(markup, /aria-label="두 번째 능력 비용 카드"/);
  assert.match(markup, /<button class="game-actions__button game-actions__button--primary" type="button" disabled="">선택한 능력 제출<\/button>/);
  assert.doesNotMatch(markup, /private-hand-0|private-hand-79/);
});
