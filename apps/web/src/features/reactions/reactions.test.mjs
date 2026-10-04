import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import {
  createRespondCommand,
  isCompleteDiscardOrder,
  responderPromptFor,
  sendAndRefreshResponse,
  projectionFromSync,
} from "./model.ts";

let vite;
let ReactionPrompt;

before(async () => {
  vite = await createServer({
    configFile: "apps/web/vite.config.ts",
    root: "apps/web",
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ ReactionPrompt } = await vite.ssrLoadModule("/src/features/reactions/ReactionPrompt.tsx"));
});

after(async () => {
  await vite?.close();
});

function snapshot({ viewerId = "player-a", pendingInteraction = null, selfPrivate = { role: "sheriff", hand: [
  { cardInstanceId: "own-missed", typeId: "missed", rank: "8", suit: "HEARTS" },
  { cardInstanceId: "own-beer", typeId: "beer", rank: "7", suit: "HEARTS" },
] } } = {}) {
  return {
    status: "playing",
    viewer: { playerId: viewerId, seatIndex: viewerId === "player-a" ? 0 : 1, mode: "active" },
    publicTable: {
      players: [
        { playerId: "player-a", displayName: "초원 별", seatIndex: 0, characterId: "bart_cassidy", hp: 2, maxHp: 4, eliminated: false, handCount: 2, role: "sheriff", inPlay: [] },
        { playerId: "player-b", displayName: "바람", seatIndex: 1, characterId: "sid_ketchum", hp: 1, maxHp: 4, eliminated: false, handCount: 2, role: null, inPlay: [] },
      ],
      turn: { currentPlayerId: "player-a", phase: "play" },
      deckCount: 40,
      publicDiscard: { topCard: null, count: 0 },
    },
    selfPrivate,
    legalActions: [],
    pendingInteraction,
  };
}

function responderPending({ interactionId = "interaction-1", kind = "BANG_RESPONSE", responder = "player-a", options, step = { current: 2, total: 3 }, discardOrder } = {}) {
  return {
    interactionId,
    kind,
    allowedChoices: [...new Set(options.map((option) => option.choice))],
    currentResponderPlayerId: responder,
    step,
    responseOptions: options,
    ...(discardOrder ? { discardOrder } : {}),
  };
}

const responseOptions = [
  { interactionId: "interaction-1", choice: "USE_MISSED", cardInstanceId: "own-missed" },
  { interactionId: "interaction-1", choice: "TAKE_HIT" },
];

function syncResponse(matchSnapshot, version = 21) {
  return {
    protocolVersion: 1,
    requestId: "request-1",
    matchId: "match-a",
    version,
    eventSeq: 45,
    requiresFullSnapshot: true,
    snapshot: matchSnapshot,
    visibleEvents: [],
  };
}

test("only the current responder's pending options are offered, with the server step", () => {
  const ownSnapshot = snapshot({ pendingInteraction: responderPending({ options: responseOptions }) });
  assert.equal(responderPromptFor(ownSnapshot).currentResponderPlayerId, "player-a");

  const markup = renderToStaticMarkup(createElement(ReactionPrompt, {
    matchId: "match-a", version: 18, snapshot: ownSnapshot,
    transport: { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse(ownSnapshot) },
    createCommandId: () => "unused",
  }));

  assert.match(markup, /뱅! 응답/);
  assert.match(markup, /2\/3/);
  assert.match(markup, /빗나감! 사용/);
  assert.match(markup, /피해 받기/);
  assert.match(markup, /빗나감! 8 하트/);
  assert.doesNotMatch(markup, /own-missed|interaction-1|cardInstanceId/);
});

test("a non-responder sees progress only and no response options or card IDs", () => {
  const progress = {
    interactionId: "interaction-1",
    kind: "GATLING_RESPONSE",
    allowedChoices: [],
    currentResponderPlayerId: "player-a",
    step: { current: 2, total: 4 },
  };
  const otherSnapshot = snapshot({ viewerId: "player-b", pendingInteraction: progress, selfPrivate: null });
  assert.equal(responderPromptFor(otherSnapshot), null);
  const markup = renderToStaticMarkup(createElement(ReactionPrompt, {
    matchId: "match-a", version: 18, snapshot: otherSnapshot,
    transport: { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse(otherSnapshot) },
  }));

  assert.match(markup, /2\/4/);
  assert.match(markup, /초원 별 님이 응답 중이에요/);
  assert.doesNotMatch(markup, /빗나감! 사용|피해 받기|own-missed|interaction-1|<button/);
});

test("death rescue presents only saved Beer and elimination choices", () => {
  const options = [
    { interactionId: "interaction-1", choice: "USE_BEER", cardInstanceId: "own-beer" },
    { interactionId: "interaction-1", choice: "ACCEPT_ELIMINATION" },
  ];
  const deathSnapshot = snapshot({ pendingInteraction: responderPending({ kind: "DEATH_RESCUE", step: { current: 1, total: 1 }, options }) });
  const markup = renderToStaticMarkup(createElement(ReactionPrompt, {
    matchId: "match-a", version: 23, snapshot: deathSnapshot,
    transport: { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse(deathSnapshot) },
  }));

  assert.match(markup, /생명력 구제/);
  assert.match(markup, /맥주로 구제/);
  assert.match(markup, /탈락 수락/);
  assert.doesNotMatch(markup, /빗나감! 사용|피해 받기/);
});

test("Vulture Sam cleanup discard prompt uses only server-projected candidates and count", () => {
  const discardOrder = {
    requiredCount: 2,
    allowedCards: [
      { cardInstanceId: "cleanup-a", typeId: "beer", rank: "7", suit: "HEARTS" },
      { cardInstanceId: "cleanup-b", typeId: "stagecoach", rank: "9", suit: "SPADES" },
      { cardInstanceId: "cleanup-c", typeId: "bang", rank: "A", suit: "CLUBS" },
    ],
  };
  const options = [{ interactionId: "interaction-1", choice: "ORDER_CARDS" }];
  const sheriffSnapshot = snapshot({
    pendingInteraction: responderPending({ kind: "DISCARDS_ORDER", options, step: { current: 1, total: 1 }, discardOrder }),
    selfPrivate: null,
  });
  const sheriffMarkup = renderToStaticMarkup(createElement(ReactionPrompt, {
    matchId: "match-a", version: 25, snapshot: sheriffSnapshot,
    transport: { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse(sheriffSnapshot) },
  }));

  assert.match(sheriffMarkup, /카드 정리/);
  assert.match(sheriffMarkup, /0\/2장/);
  assert.match(sheriffMarkup, /역마차 9 스페이드/);
  assert.match(sheriffMarkup, /선택한 순서 제출/);
  assert.doesNotMatch(sheriffMarkup, /cleanup-a|cleanup-b|cleanup-c/);

  const progress = {
    interactionId: "interaction-1",
    kind: "DISCARDS_ORDER",
    allowedChoices: [],
    currentResponderPlayerId: "player-a",
    step: { current: 1, total: 1 },
  };
  const observerSnapshot = snapshot({ viewerId: "player-b", pendingInteraction: progress, selfPrivate: null });
  const observerMarkup = renderToStaticMarkup(createElement(ReactionPrompt, {
    matchId: "match-a", version: 25, snapshot: observerSnapshot,
    transport: { sendMatchCommand: async () => { throw new Error("not submitted"); }, syncMatch: async () => syncResponse(observerSnapshot) },
  }));
  assert.match(observerMarkup, /초원 별 님이 응답 중이에요/);
  assert.doesNotMatch(observerMarkup, /역마차|빗나감|cleanup-[abc]|<button/);
});

test("creates a canonical RESPOND envelope from the exact saved option fields", () => {
  const option = { interactionId: "interaction-1", choice: "TAKE_FROM_HAND", sourcePlayerId: "player-b" };
  assert.deepEqual(createRespondCommand("match-a", 31, "response-command-id", option), {
    protocolVersion: 1,
    commandId: "response-command-id",
    matchId: "match-a",
    expectedVersion: 31,
    type: "RESPOND",
    payload: option,
  });
});

test("does not turn an ORDER_CARDS option template into a command without user-entered order", () => {
  const orderTemplate = { interactionId: "interaction-1", choice: "ORDER_CARDS" };
  assert.equal(createRespondCommand("match-a", 31, "response-command-id", orderTemplate), null);
  assert.deepEqual(createRespondCommand("match-a", 31, "response-command-id", orderTemplate, ["card-b", "card-a"])?.payload, {
    interactionId: "interaction-1",
    choice: "ORDER_CARDS",
    orderedCardInstanceIds: ["card-b", "card-a"],
  });
});

test("validates discard order against the server candidate IDs and required count", () => {
  const order = {
    requiredCount: 2,
    allowedCards: [
      { cardInstanceId: "card-a", typeId: "beer", rank: "7", suit: "HEARTS" },
      { cardInstanceId: "card-b", typeId: "bang", rank: "A", suit: "CLUBS" },
      { cardInstanceId: "card-c", typeId: "missed", rank: "8", suit: "HEARTS" },
    ],
  };
  assert.equal(isCompleteDiscardOrder(order, ["card-c", "card-a"]), true);
  assert.equal(isCompleteDiscardOrder(order, ["card-a"]), false);
  assert.equal(isCompleteDiscardOrder(order, ["card-a", "card-a"]), false);
  assert.equal(isCompleteDiscardOrder(order, ["card-a", "forged-card"]), false);
});

test("sync projection restores the same pending prompt and response choices", async () => {
  const reconnectSnapshot = snapshot({ pendingInteraction: responderPending({ options: responseOptions, step: { current: 3, total: 5 } }) });
  const sync = syncResponse(reconnectSnapshot, 32);
  assert.deepEqual(projectionFromSync(sync).snapshot.pendingInteraction, reconnectSnapshot.pendingInteraction);

  const submitted = [];
  const command = createRespondCommand("match-a", 31, "response-command-id", responseOptions[0]);
  const result = await sendAndRefreshResponse({
    async sendMatchCommand(received) {
      submitted.push(received);
      return { protocolVersion: 1, commandId: received.commandId, status: "accepted", duplicate: false, aggregateVersion: 32, eventSeq: 45 };
    },
    async syncMatch() { return sync; },
  }, command);

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0], command);
  assert.equal(result.projection.snapshot.pendingInteraction.step.current, 3);
  assert.deepEqual(result.projection.snapshot.pendingInteraction.responseOptions, responseOptions);
});

test("reports a response acknowledgement before waiting for the authoritative projection", async () => {
  const order = [];
  let finishSync;
  let markSyncStarted;
  const syncStarted = new Promise((resolve) => { markSyncStarted = resolve; });
  const pendingSync = new Promise((resolve) => { finishSync = resolve; });
  const command = createRespondCommand("match-a", 31, "response-command-id", responseOptions[0]);
  const operation = sendAndRefreshResponse({
    async sendMatchCommand() {
      order.push("send");
      return { protocolVersion: 1, commandId: "response-command-id", status: "accepted", duplicate: false, aggregateVersion: 32, eventSeq: 46 };
    },
    syncMatch() {
      order.push("sync");
      markSyncStarted();
      return pendingSync;
    },
  }, command, (acknowledgement) => order.push(`ack:${acknowledgement.status}`));

  await syncStarted;
  assert.deepEqual(order, ["send", "ack:accepted", "sync"]);
  finishSync(syncResponse(snapshot(), 32));
  const result = await operation;
  assert.equal(result.projection.version, 32);
});

test("a multi-target response sync opens only the next responder's new prompt", async () => {
  const firstOption = { interactionId: "first-window", choice: "TAKE_HIT" };
  const firstSnapshot = snapshot({
    pendingInteraction: responderPending({
      interactionId: "first-window",
      kind: "GATLING_RESPONSE",
      options: [firstOption],
      step: { current: 1, total: 2 },
    }),
  });

  const nextOption = { interactionId: "second-window", choice: "USE_BANG", cardInstanceId: "player-b-bang" };
  const nextSnapshot = snapshot({
    viewerId: "player-b",
    pendingInteraction: {
      interactionId: "second-window",
      kind: "GATLING_RESPONSE",
      allowedChoices: ["USE_BANG"],
      currentResponderPlayerId: "player-b",
      step: { current: 2, total: 2 },
      responseOptions: [nextOption],
    },
  });
  const command = createRespondCommand("match-a", 40, "first-response-id", firstOption);
  const result = await sendAndRefreshResponse({
    async sendMatchCommand(received) {
      assert.equal(received, command);
      return { protocolVersion: 1, commandId: received.commandId, status: "accepted", duplicate: false, aggregateVersion: 41, eventSeq: 46 };
    },
    async syncMatch() { return syncResponse(nextSnapshot, 41); },
  }, command);

  assert.equal(result.projection.snapshot.viewer.playerId, "player-b");
  assert.equal(result.projection.snapshot.pendingInteraction.currentResponderPlayerId, "player-b");
  assert.deepEqual(result.projection.snapshot.pendingInteraction.responseOptions, [nextOption]);
  assert.doesNotMatch(JSON.stringify(result.projection.snapshot.pendingInteraction.responseOptions), /own-missed|first-window/);
});

