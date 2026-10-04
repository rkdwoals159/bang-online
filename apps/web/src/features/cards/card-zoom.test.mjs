import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

let vite;
let ActionsPanel;
let ReactionPrompt;
let getPlayingCardDescription;

test("R03 Kit choice markup names the private candidate cards and Lucky's public faces reach observers", () => {
  const choiceCards = [
    { cardInstanceId: "kit-bang", typeId: "bang", rank: "A", suit: "SPADES" },
    { cardInstanceId: "kit-beer", typeId: "beer", rank: "7", suit: "HEARTS" },
    { cardInstanceId: "kit-missed", typeId: "missed", rank: "8", suit: "CLUBS" },
  ];
  const kit = responderPending([{ interactionId: "interaction-1", choice: "CHOOSE_CARDS",
    selectedCardInstanceIds: ["kit-bang", "kit-beer"] }]);
  kit.kind = "KIT_CARLSON_PICK"; kit.choiceCards = choiceCards;
  const kitMarkup = renderReaction(matchSnapshot({ pendingInteraction: kit, selfPrivate: { role: "sheriff", hand: [] } }));
  assert.match(kitMarkup, /뱅!/); assert.match(kitMarkup, /맥주/); assert.match(kitMarkup, /카드 상세 보기/);
  assert.doesNotMatch(kitMarkup, /kit-bang|kit-beer|kit-missed/);
  const lucky = matchSnapshot({ viewerId: "player-b", selfPrivate: null, pendingInteraction: {
    interactionId: "interaction-1", kind: "LUCKY_DRAW", currentResponderPlayerId: "player-a",
    step: { current: 1, total: 1 }, allowedChoices: [],
  } });
  lucky.publicTable.luckyJudgment = { sourceKind: "jail", cards: choiceCards.slice(0, 2) };
  const luckyMarkup = renderReaction(lucky);
  assert.match(luckyMarkup, /공개 판정 카드/); assert.match(luckyMarkup, /감옥: 하트이면 턴 진행/);
  assert.match(luckyMarkup, /뱅!/); assert.match(luckyMarkup, /맥주/);
  assert.doesNotMatch(luckyMarkup, /선택 제출|선택 1/);
});

before(async () => {
  vite = await createServer({
    configFile: "apps/web/vite.config.ts",
    root: "apps/web",
    appType: "custom",
    logLevel: "silent",
    server: { middlewareMode: true },
  });
  ({ getPlayingCardDescription } = await vite.ssrLoadModule("/src/features/cards/CardFaces.tsx"));
  ({ ActionsPanel } = await vite.ssrLoadModule("/src/features/actions/ActionsPanel.tsx"));
  ({ ReactionPrompt } = await vite.ssrLoadModule("/src/features/reactions/ReactionPrompt.tsx"));
});

after(async () => {
  await vite?.close();
});

const hand = [
  { cardInstanceId: "own-bang", typeId: "bang", rank: "A", suit: "SPADES" },
  { cardInstanceId: "own-beer", typeId: "beer", rank: "7", suit: "HEARTS" },
];

function matchSnapshot({ viewerId = "player-a", pendingInteraction = null, selfPrivate = { role: "sheriff", hand } } = {}) {
  return {
    status: "playing",
    viewer: { playerId: viewerId, seatIndex: 0, mode: "active" },
    publicTable: {
      players: [
        { playerId: "player-a", displayName: "초원 별", seatIndex: 0, characterId: "bart_cassidy", hp: 4, maxHp: 4, eliminated: false, handCount: 2, role: "sheriff", inPlay: [] },
        { playerId: "player-b", displayName: "바람", seatIndex: 1, characterId: "black_jack", hp: 4, maxHp: 4, eliminated: false, handCount: 3, role: null, inPlay: [] },
      ],
      turn: { currentPlayerId: "player-a", phase: "play" },
      deckCount: 40,
      publicDiscard: { topCard: null, count: 0 },
    },
    selfPrivate,
    legalActions: [{ type: "PLAY_CARD", payload: { cardInstanceId: "own-bang", targetPlayerId: "player-b" } }],
    pendingInteraction,
  };
}

const transport = {
  async sendMatchCommand() { throw new Error("detail buttons must not submit commands"); },
  async syncMatch(matchId) {
    return { protocolVersion: 1, requestId: "sync-1", matchId, version: 4, eventSeq: 1, requiresFullSnapshot: true, snapshot: matchSnapshot(), visibleEvents: [] };
  },
};

function renderActions(snapshot = matchSnapshot()) {
  return renderToStaticMarkup(createElement(ActionsPanel, {
    matchId: "match-a",
    version: 4,
    snapshot,
    transport,
    createCommandId: () => "unused",
  }));
}

function responderPending(options, discardOrder) {
  return {
    interactionId: "interaction-1",
    kind: discardOrder ? "DISCARDS_ORDER" : "BANG_RESPONSE",
    allowedChoices: [...new Set(options.map((option) => option.choice))],
    currentResponderPlayerId: "player-a",
    step: { current: 1, total: 1 },
    responseOptions: options,
    ...(discardOrder ? { discardOrder } : {}),
  };
}

function renderReaction(snapshot) {
  return renderToStaticMarkup(createElement(ReactionPrompt, {
    matchId: "match-a",
    version: 4,
    snapshot,
    transport,
    createCommandId: () => "unused",
  }));
}

test("every base playing card has Korean detail text from the ruleset summaries", () => {
  const typeIds = [
    "bang", "missed", "beer", "saloon", "stagecoach", "wells_fargo", "general_store", "panic", "cat_balou", "gatling", "indians", "duel",
    "barrel", "jail", "dynamite", "mustang", "scope", "volcanic", "schofield", "remington", "carabine", "winchester",
  ];

  for (const typeId of typeIds) {
    const description = getPlayingCardDescription(typeId);
    assert.ok(description.length > 5, `${typeId} needs visible card text`);
    assert.notEqual(description, "카드 설명을 확인할 수 없습니다.");
  }
});

test("hand zoom keeps named triggers and mounts detail content only when opened", () => {
  const markup = renderActions();

  assert.match(markup, /카드 상세 보기: 뱅!, A 스페이드/);
  assert.match(markup, /loading="lazy" decoding="async"/);
  assert.match(markup, /카드 상세 보기: 맥주, 7 하트/);
  assert.doesNotMatch(markup, /<dialog|card-zoom__content|card-zoom__visual/);
  assert.doesNotMatch(markup, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<button\b/);
  assert.doesNotMatch(markup, /own-bang|own-beer|cardInstanceId/);
});

test("response zoom is limited to card faces named by the current responder options", () => {
  const pendingInteraction = responderPending([
    { interactionId: "interaction-1", choice: "USE_MISSED", cardInstanceId: "own-missed" },
    { interactionId: "interaction-1", choice: "TAKE_HIT" },
  ]);
  const snapshot = matchSnapshot({
    pendingInteraction,
    selfPrivate: { role: "sheriff", hand: [
      { cardInstanceId: "own-missed", typeId: "missed", rank: "8", suit: "HEARTS" },
      { cardInstanceId: "own-beer", typeId: "beer", rank: "7", suit: "HEARTS" },
    ] },
  });
  const markup = renderReaction(snapshot);

  assert.match(markup, /카드 상세 보기: 빗나감!, 8 하트/);
  assert.match(markup, /뱅! 응답/);
  assert.doesNotMatch(markup, /카드 상세 보기: 맥주, 7 하트/);
  assert.doesNotMatch(markup, /own-missed|own-beer|interaction-1|cardInstanceId/);

  const progressOnly = matchSnapshot({
    viewerId: "player-b",
    pendingInteraction: {
      interactionId: "interaction-1",
      kind: "BANG_RESPONSE",
      allowedChoices: [],
      currentResponderPlayerId: "player-a",
      step: { current: 1, total: 1 },
    },
    selfPrivate: null,
  });
  const observerMarkup = renderReaction(progressOnly);
  assert.doesNotMatch(observerMarkup, /<button|빗나감|맥주 카드 상세/);
});

test("discard-order zoom uses only the responder's projected allowedCards", () => {
  const pendingInteraction = responderPending([{ interactionId: "interaction-1", choice: "ORDER_CARDS" }], {
    requiredCount: 1,
    allowedCards: [
      { cardInstanceId: "candidate-beer", typeId: "beer", rank: "7", suit: "HEARTS" },
      { cardInstanceId: "candidate-bang", typeId: "bang", rank: "A", suit: "CLUBS" },
    ],
  });
  const snapshot = matchSnapshot({ pendingInteraction, selfPrivate: null });
  const markup = renderReaction(snapshot);

  assert.match(markup, /카드 상세 보기: 맥주, 7 하트/);
  assert.match(markup, /카드 상세 보기: 뱅!, A 클럽/);
  assert.match(markup, /버릴 카드 후보/);
  assert.doesNotMatch(markup, /candidate-beer|candidate-bang|interaction-1|cardInstanceId/);
  assert.doesNotMatch(markup, /<button\b[^>]*>(?:(?!<\/button>)[\s\S])*?<button\b/);
});
