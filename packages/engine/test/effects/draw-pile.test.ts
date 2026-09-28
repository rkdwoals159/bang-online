import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { stagecoachEffect } from "../../src/effects/cards/draw-select.ts";
import { planDrawPileSupply, type DrawPileSupplyInput } from "../../src/effects/draw-pile.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import type { EffectEventDraft } from "../../src/effects/api.ts";
import { initializeGame } from "../../src/setup/initialize.ts";

function fixedRandom(values: readonly number[] = []): RandomSource {
  let cursor = 0;
  return {
    nextFloat() {
      const value = values[cursor];
      if (value === undefined) throw new Error("random fixture exhausted");
      cursor += 1;
      return value;
    },
  };
}

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("this path must not consume randomness"); } };
}

function supply(overrides: Partial<DrawPileSupplyInput> = {}) {
  return planDrawPileSupply({
    drawPileCardInstanceIds: ["draw-1", "draw-2", "draw-3"],
    discardPileCardInstanceIds: [],
    requestedCount: 2,
    actorPlayerId: "player-1",
    sourceCardInstanceId: "source-card",
    destination: "hand",
    random: unusedRandom(),
    ...overrides,
  });
}

function stringField(event: EffectEventDraft, key: string): string {
  const value = event.payload[key];
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error(`expected ${key} to be a string`);
  return value;
}

function stringArrayField(event: EffectEventDraft, key: string): string[] {
  const value = event.payload[key];
  assert.ok(Array.isArray(value));
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`expected ${key} to be a string array`);
  }
  return value as string[];
}

test("draw-pile supply uses deck top first and returns hand movement drafts without mutation", () => {
  const drawPileCardInstanceIds = ["top", "next"];
  const discardPileCardInstanceIds = ["discard-a"];
  const before = structuredClone({ drawPileCardInstanceIds, discardPileCardInstanceIds });

  const result = supply({ drawPileCardInstanceIds, discardPileCardInstanceIds });

  assert.deepEqual(result.cardInstanceIds, ["top", "next"]);
  assert.equal(result.fulfilledCount, 2);
  assert.equal(result.exhausted, false);
  assert.deepEqual(result.events.map((draft) => draft.type), ["CARD_DRAWN", "CARD_DRAWN"]);
  assert.deepEqual(result.events.map((draft) => stringField(draft, "cardInstanceId")), ["top", "next"]);
  assert.deepEqual(result.events.map((draft) => stringField(draft, "playerId")), ["player-1", "player-1"]);
  assert.deepEqual({ drawPileCardInstanceIds, discardPileCardInstanceIds }, before);
});

test("R08 reshuffles the whole discard pile only when the deck becomes empty", () => {
  const result = supply({
    drawPileCardInstanceIds: ["initial-top"],
    discardPileCardInstanceIds: ["discard-a", "discard-b", "discard-c"],
    requestedCount: 3,
    random: fixedRandom([0, 0]),
  });

  assert.deepEqual(result.cardInstanceIds, ["initial-top", "discard-b", "discard-c"]);
  assert.deepEqual(result.events.map((draft) => draft.type), [
    "CARD_DRAWN",
    "DRAW_PILE_RESHUFFLED",
    "CARD_DRAWN",
    "CARD_DRAWN",
  ]);
  assert.deepEqual(stringArrayField(result.events[1]!, "cardInstanceIds"), ["discard-b", "discard-c", "discard-a"]);
  assert.deepEqual(result.events.map((draft) => draft.actorPlayerId), Array(4).fill("player-1"));
  assert.equal(result.fulfilledCount, 3);
  assert.equal(result.exhausted, false);
});

test("a played Stagecoach is included in a later reshuffle after runtime consumes it", () => {
  const state = initializeGame({
    players: Array.from({ length: 4 }, (_, index) => ({ playerId: `player-${index + 1}`, displayName: `Player ${index + 1}` })),
    random: { nextFloat: () => 0 },
  });
  const stagecoachDefinitionId = BASE_PHYSICAL_CARDS.find((card) => card.typeId === "stagecoach")?.definitionId;
  assert.ok(stagecoachDefinitionId);
  const sourceCardInstanceId = Object.values(state.zones.cardsByInstanceId)
    .find((card) => card.cardDefinitionId === stagecoachDefinitionId)?.cardInstanceId;
  assert.ok(sourceCardInstanceId);

  const otherCardIds = Object.keys(state.zones.cardsByInstanceId).filter((id) => id !== sourceCardInstanceId);
  const actor = state.seats[0]!;
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = [];
    seat.public.inPlayCardInstanceIds = [];
  }
  state.zones.drawPileCardInstanceIds = [otherCardIds[0]!];
  state.zones.discardPileCardInstanceIds = [];
  state.zones.revealedPoolCardInstanceIds = [];
  actor.private.handCardInstanceIds = [...otherCardIds.slice(1), sourceCardInstanceId];

  const result = stagecoachEffect({
    state,
    actorPlayerId: actor.public.playerId,
    sourceCardInstanceId,
    continuationFrameId: "stagecoach-source-reshuffle",
    targets: [],
    random: unusedRandom(),
    completedInteractions: [],
  });

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events.map((draft) => draft.type), [
    "CARD_DRAWN",
    "DRAW_PILE_RESHUFFLED",
    "CARD_DRAWN",
  ]);
  assert.deepEqual(stringArrayField(result.events[1]!, "cardInstanceIds"), [sourceCardInstanceId]);
  assert.equal(stringField(result.events[2]!, "cardInstanceId"), sourceCardInstanceId);
  assert.deepEqual(state.zones.drawPileCardInstanceIds, [otherCardIds[0]]);
  assert.ok(actor.private.handCardInstanceIds.includes(sourceCardInstanceId));
});

test("D05 records a partial fulfillment and pauses after the last available card", () => {
  const result = supply({
    drawPileCardInstanceIds: [],
    discardPileCardInstanceIds: ["only-card"],
    requestedCount: 2,
    random: unusedRandom(),
    cardTypeId: "stagecoach",
  });

  assert.deepEqual(result.cardInstanceIds, ["only-card"]);
  assert.equal(result.fulfilledCount, 1);
  assert.equal(result.exhausted, true);
  assert.deepEqual(result.events.map((draft) => draft.type), [
    "DRAW_PILE_RESHUFFLED",
    "CARD_DRAWN",
    "RULE_RESOURCE_EXHAUSTED",
  ]);
  const exhausted = result.events[2]!;
  assert.equal(exhausted.payload.requestedCount, 2);
  assert.equal(exhausted.payload.fulfilledCount, 1);
  assert.equal(exhausted.payload.cardTypeId, "stagecoach");
  assert.equal(exhausted.payload.status, "paused");
  assert.equal(exhausted.payload.pauseReason, "RULE_RESOURCE_EXHAUSTED");
});

test("D05 with both piles empty pauses without creating a card", () => {
  const result = supply({
    drawPileCardInstanceIds: [],
    discardPileCardInstanceIds: [],
    requestedCount: 1,
  });

  assert.deepEqual(result.cardInstanceIds, []);
  assert.equal(result.fulfilledCount, 0);
  assert.equal(result.exhausted, true);
  assert.deepEqual(result.events.map((draft) => draft.type), ["RULE_RESOURCE_EXHAUSTED"]);
  assert.equal(result.events[0]?.payload.fulfilledCount, 0);
});

test("revealed-pool destination preserves General Store reveal event semantics", () => {
  const result = supply({
    drawPileCardInstanceIds: ["public-candidate-a", "public-candidate-b"],
    requestedCount: 2,
    destination: "revealed_pool",
  });

  assert.deepEqual(result.cardInstanceIds, ["public-candidate-a", "public-candidate-b"]);
  assert.deepEqual(result.events.map((draft) => draft.type), [
    "GENERAL_STORE_CARD_REVEALED",
    "GENERAL_STORE_CARD_REVEALED",
  ]);
  assert.deepEqual(result.events.map((draft) => stringField(draft, "cardInstanceId")), result.cardInstanceIds);
  assert.ok(result.events.every((draft) => draft.payload.toZone === "revealed_pool"));
});

test("peek returns private candidates without emitting card-movement events", () => {
  const result = supply({
    drawPileCardInstanceIds: ["private-top-a", "private-top-b"],
    requestedCount: 2,
    destination: "peek",
  });

  assert.deepEqual(result.cardInstanceIds, ["private-top-a", "private-top-b"]);
  assert.equal(result.fulfilledCount, 2);
  assert.deepEqual(result.events, []);
  assert.ok(result.events.every((draft) =>
    draft.type !== "CARD_DRAWN" && draft.type !== "GENERAL_STORE_CARD_REVEALED" && draft.type !== "CARD_TRANSFERRED",
  ));
});

test("peek returns only shuffle/exhaustion events when the deck needs replenishment", () => {
  const result = supply({
    drawPileCardInstanceIds: [],
    discardPileCardInstanceIds: ["private-a", "private-b"],
    requestedCount: 3,
    destination: "peek",
    random: fixedRandom([0]),
  });

  assert.deepEqual(result.cardInstanceIds, ["private-b", "private-a"]);
  assert.deepEqual(result.events.map((draft) => draft.type), ["DRAW_PILE_RESHUFFLED", "RULE_RESOURCE_EXHAUSTED"]);
  assert.equal(result.events.some((draft) =>
    draft.type === "CARD_DRAWN" || draft.type === "GENERAL_STORE_CARD_REVEALED" || draft.type === "CARD_TRANSFERRED",
  ), false);
});

test("the same piles and injected RNG produce the same plan", () => {
  const input = {
    drawPileCardInstanceIds: ["draw-top"],
    discardPileCardInstanceIds: ["discard-a", "discard-b", "discard-c"],
    requestedCount: 3,
    random: () => fixedRandom([0.25, 0.75]),
  };
  const first = supply({ ...input, random: input.random() });
  const second = supply({ ...input, random: input.random() });

  assert.deepEqual(second, first);
});

test("rejects negative or fractional requested counts", () => {
  assert.throws(() => supply({ requestedCount: -1 }), RangeError);
  assert.throws(() => supply({ requestedCount: 1.5 }), RangeError);
});
