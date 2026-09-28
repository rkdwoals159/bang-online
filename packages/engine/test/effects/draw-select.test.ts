import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type {
  CardEffectInput,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
} from "../../src/effects/api.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import type { GameState, JsonValue, SeatState } from "../../src/state/types.ts";
import {
  generalStoreEffect,
  stagecoachEffect,
  wellsFargoEffect,
} from "../../src/effects/cards/draw-select.ts";

function fixedRandom(values: readonly number[] = [0.25]): RandomSource {
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

function initialState(playerCount = 5): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seatAt(state: GameState, seatIndex: number): SeatState {
  const seat = state.seats.find((entry) => entry.public.seatIndex === seatIndex);
  assert.ok(seat, `missing seat ${seatIndex}`);
  return seat;
}

function physicalCardId(state: GameState, typeId: string, copy = 0): string {
  const card = BASE_PHYSICAL_CARDS.filter((entry) => entry.typeId === typeId)[copy];
  assert.ok(card, `missing physical catalog card ${typeId} copy ${copy}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (entry) => entry.cardDefinitionId === card.definitionId,
  );
  assert.ok(instance, `missing runtime card ${card.definitionId}`);
  return instance.cardInstanceId;
}

/** Keeps all 80 catalog instances in one zone while creating compact pile fixtures. */
function setPiles(state: GameState, drawPile: readonly string[], discardPile: readonly string[]): void {
  const assigned = [...drawPile, ...discardPile];
  assert.equal(new Set(assigned).size, assigned.length, "fixture piles must not duplicate physical cards");
  assert.ok(assigned.every((id) => state.zones.cardsByInstanceId[id]), "fixture pile IDs must be physical instances");

  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = [];
    seat.public.inPlayCardInstanceIds = [];
  }
  state.zones.drawPileCardInstanceIds = [...drawPile];
  state.zones.discardPileCardInstanceIds = [...discardPile];
  state.zones.revealedPoolCardInstanceIds = [];
  const assignedSet = new Set(assigned);
  seatAt(state, 0).private.handCardInstanceIds = Object.keys(state.zones.cardsByInstanceId)
    .filter((cardInstanceId) => !assignedSet.has(cardInstanceId));
}

function makeInput(
  state: GameState,
  sourceCardInstanceId: string | null,
  random: RandomSource = unusedRandom(),
  actorPlayerId = seatAt(state, 0).public.playerId,
): CardEffectInput {
  return {
    state,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-draw-select",
    targets: [],
    random,
    completedInteractions: [],
  };
}

function appliedEvents(result: CardEffectResult): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, received ${result.kind}`);
  return result.events;
}

function eventString(payload: Readonly<Record<string, JsonValue>>, key: string): string {
  const value = payload[key];
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error(`expected ${key} to be a string`);
  return value;
}

function eventStringArray(payload: Readonly<Record<string, JsonValue>>, key: string): string[] {
  const value = payload[key];
  assert.ok(Array.isArray(value));
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`expected ${key} to be a string array`);
  }
  return value as string[];
}

/** Applies only the event draft shapes emitted by this effect module. */
function applyDrafts(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const draft of events) {
    const payload = draft.payload;
    if (draft.type === "DRAW_PILE_RESHUFFLED") {
      state.zones.drawPileCardInstanceIds = eventStringArray(payload, "cardInstanceIds");
      state.zones.discardPileCardInstanceIds = [];
      continue;
    }

    if (draft.type === "CARD_DRAWN") {
      const cardInstanceId = eventString(payload, "cardInstanceId");
      const playerId = eventString(payload, "playerId");
      assert.equal(state.zones.drawPileCardInstanceIds[0], cardInstanceId, "draw draft must name the deck top");
      state.zones.drawPileCardInstanceIds.shift();
      const owner = state.seats.find((seat) => seat.public.playerId === playerId);
      assert.ok(owner);
      owner.private.handCardInstanceIds.push(cardInstanceId);
      continue;
    }

    if (draft.type === "GENERAL_STORE_CARD_REVEALED") {
      const cardInstanceId = eventString(payload, "cardInstanceId");
      assert.equal(state.zones.drawPileCardInstanceIds[0], cardInstanceId, "store reveal must name the deck top");
      state.zones.drawPileCardInstanceIds.shift();
      state.zones.revealedPoolCardInstanceIds.push(cardInstanceId);
      continue;
    }

    if (draft.type === "CARD_TRANSFERRED") {
      const cardInstanceId = eventString(payload, "cardInstanceId");
      const playerId = eventString(payload, "toPlayerId");
      const index = state.zones.revealedPoolCardInstanceIds.indexOf(cardInstanceId);
      assert.notEqual(index, -1, "store transfer must name a revealed pool card");
      state.zones.revealedPoolCardInstanceIds.splice(index, 1);
      const owner = state.seats.find((seat) => seat.public.playerId === playerId);
      assert.ok(owner);
      owner.private.handCardInstanceIds.push(cardInstanceId);
      continue;
    }

    if (draft.type === "CARD_DISCARDED") {
      const cardInstanceId = eventString(payload, "cardInstanceId");
      const index = state.zones.revealedPoolCardInstanceIds.indexOf(cardInstanceId);
      assert.notEqual(index, -1, "store discard must name a revealed pool card");
      state.zones.revealedPoolCardInstanceIds.splice(index, 1);
      state.zones.discardPileCardInstanceIds.push(cardInstanceId);
      continue;
    }

    if (draft.type === "RULE_RESOURCE_EXHAUSTED") {
      assert.equal(payload.pauseReason, "RULE_RESOURCE_EXHAUSTED");
      state.status = "paused";
      state.pauseReason = "RULE_RESOURCE_EXHAUSTED";
      continue;
    }

    assert.fail(`unexpected effect event '${draft.type}'`);
  }
}

test("Stagecoach draws exactly two and Wells Fargo exactly three to the user hand", () => {
  const cases = [
    { typeId: "stagecoach", draw: stagecoachEffect, expectedCount: 2 },
    { typeId: "wells_fargo", draw: wellsFargoEffect, expectedCount: 3 },
  ] as const;

  for (const { typeId, draw, expectedCount } of cases) {
    const state = initialState();
    const actorId = seatAt(state, 0).public.playerId;
    const sourceCardInstanceId = physicalCardId(state, typeId);
    const topCardIds = Array.from({ length: expectedCount }, (_, index) => physicalCardId(state, "bang", index));
    setPiles(state, topCardIds, [sourceCardInstanceId]);
    const before = structuredClone(state);
    const handBefore = [...seatAt(state, 0).private.handCardInstanceIds];

    const result = draw(makeInput(state, sourceCardInstanceId, unusedRandom(), actorId));
    const events = appliedEvents(result);
    assert.deepEqual(events.map((draft) => draft.payload.cardInstanceId), topCardIds);
    assert.ok(events.every((draft) => draft.type === "CARD_DRAWN"));
    assert.deepEqual(state, before, "draw effects must return drafts without mutating their input snapshot");

    const after = structuredClone(state);
    applyDrafts(after, events);
    assert.deepEqual(
      seatAt(after, 0).private.handCardInstanceIds.filter((id) => !handBefore.includes(id)),
      topCardIds,
    );
    assert.deepEqual(after.zones.drawPileCardInstanceIds, []);
    assert.deepEqual(after.zones.discardPileCardInstanceIds, [sourceCardInstanceId]);
  }
});

test("R08 reshuffles the entire discard pile, including the played Stagecoach, when the deck runs out", () => {
  const state = initialState();
  const actorId = seatAt(state, 0).public.playerId;
  const sourceCardInstanceId = physicalCardId(state, "stagecoach");
  const firstDrawId = physicalCardId(state, "bang");
  const reshuffleIds = [sourceCardInstanceId, physicalCardId(state, "missed"), physicalCardId(state, "beer")];
  setPiles(state, [firstDrawId], reshuffleIds);
  const before = structuredClone(state);
  const handBefore = [...seatAt(state, 0).private.handCardInstanceIds];

  const result = stagecoachEffect(makeInput(state, sourceCardInstanceId, fixedRandom([0.99, 0.99]), actorId));
  const events = appliedEvents(result);
  assert.deepEqual(events.map((draft) => draft.type), ["CARD_DRAWN", "DRAW_PILE_RESHUFFLED", "CARD_DRAWN"]);
  assert.deepEqual(events[1]?.payload.cardInstanceIds, reshuffleIds);
  assert.equal(events[2]?.payload.cardInstanceId, sourceCardInstanceId);
  assert.deepEqual(state, before);

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.deepEqual(
    seatAt(after, 0).private.handCardInstanceIds.filter((id) => !handBefore.includes(id)),
    [firstDrawId, sourceCardInstanceId],
  );
  assert.deepEqual(after.zones.discardPileCardInstanceIds, []);
  assert.deepEqual(after.zones.drawPileCardInstanceIds, reshuffleIds.slice(1));
});

test("D05 pauses after partial draws when both draw and discard piles are exhausted", () => {
  const state = initialState(4);
  const actorId = seatAt(state, 0).public.playerId;
  const sourceCardInstanceId = physicalCardId(state, "stagecoach");
  setPiles(state, [], [sourceCardInstanceId]);
  const before = structuredClone(state);

  const result = stagecoachEffect(makeInput(state, sourceCardInstanceId, fixedRandom([0.4]), actorId));
  const events = appliedEvents(result);
  assert.deepEqual(events.map((draft) => draft.type), [
    "DRAW_PILE_RESHUFFLED",
    "CARD_DRAWN",
    "RULE_RESOURCE_EXHAUSTED",
  ]);
  assert.equal(events[2]?.payload.fulfilledCount, 1);
  assert.deepEqual(state, before);

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.equal(after.status, "paused");
  assert.equal(after.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.ok(seatAt(after, 0).private.handCardInstanceIds.includes(sourceCardInstanceId));
  assert.deepEqual(after.zones.drawPileCardInstanceIds, []);
  assert.deepEqual(after.zones.discardPileCardInstanceIds, []);
});

test("General Store pauses on a partial reveal when R08 cannot refill enough cards", () => {
  const state = initialState(4);
  const actorId = seatAt(state, 0).public.playerId;
  const sourceCardInstanceId = physicalCardId(state, "general_store");
  const firstDrawId = physicalCardId(state, "bang");
  // The played Store is the only discard card, so R08 makes it available once.
  setPiles(state, [firstDrawId], [sourceCardInstanceId]);
  const before = structuredClone(state);

  const result = generalStoreEffect(makeInput(state, sourceCardInstanceId, unusedRandom(), actorId));
  const events = appliedEvents(result);
  assert.deepEqual(events.map((draft) => draft.type), [
    "GENERAL_STORE_CARD_REVEALED",
    "DRAW_PILE_RESHUFFLED",
    "GENERAL_STORE_CARD_REVEALED",
    "RULE_RESOURCE_EXHAUSTED",
  ]);
  assert.deepEqual(state, before, "an exhausted reveal must not mutate the input snapshot");
  assert.equal(events[3]?.payload.requestedCount, 4);
  assert.equal(events[3]?.payload.fulfilledCount, 2);

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.equal(after.status, "paused");
  assert.equal(after.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.deepEqual(after.zones.revealedPoolCardInstanceIds, [firstDrawId, sourceCardInstanceId]);
  assert.deepEqual(after.zones.drawPileCardInstanceIds, []);
  assert.deepEqual(after.zones.discardPileCardInstanceIds, []);
});

function interactionResult(
  request: Extract<CardEffectResult, { kind: "response_required" }> ["request"],
  interactionId: string,
  playerId: string,
  cardInstanceId: string,
): CompletedEffectInteraction {
  return {
    interactionId,
    kind: request.kind,
    context: request.context,
    responses: [{
      playerId,
      choice: "CHOOSE_CARD",
      payload: { selectedCardInstanceId: cardInstanceId },
    }],
  };
}

test("General Store reveals one card per living player and prompts them clockwise one at a time", () => {
  const state = initialState(5);
  const actorId = seatAt(state, 2).public.playerId;
  const sourceCardInstanceId = physicalCardId(state, "general_store");
  const revealedIds = [
    physicalCardId(state, "bang"),
    physicalCardId(state, "missed"),
    physicalCardId(state, "beer"),
    physicalCardId(state, "duel"),
  ];
  seatAt(state, 1).public.eliminated = true;
  state.turn.currentPlayerId = actorId;
  setPiles(state, revealedIds, [sourceCardInstanceId]);
  // setPiles preserves the elimination marker and current-player identity.
  const before = structuredClone(state);

  const result = generalStoreEffect(makeInput(state, sourceCardInstanceId, unusedRandom(), actorId));
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") return;
  assert.equal(result.request.kind, "GENERAL_STORE_PICK");
  assert.deepEqual(result.request.responders.map((responder) => responder.playerId), [actorId]);
  assert.deepEqual(
    result.request.responders[0]?.options.map((option) => option.payload.selectedCardInstanceId),
    revealedIds,
  );
  assert.deepEqual(result.events.map((draft) => draft.type), Array(4).fill("GENERAL_STORE_CARD_REVEALED"));
  assert.deepEqual(state, before, "the effect must leave the snapshot unchanged while asking for choices");

  const working = structuredClone(state);
  applyDrafts(working, result.events);
  assert.deepEqual(working.zones.revealedPoolCardInstanceIds, revealedIds);

  const expectedOrder = [
    seatAt(state, 2).public.playerId,
    seatAt(state, 3).public.playerId,
    seatAt(state, 4).public.playerId,
    seatAt(state, 0).public.playerId,
  ];
  const completed: CompletedEffectInteraction[] = [];
  let pending: CardEffectResult = result;
  const picks: string[] = [];

  for (let index = 0; index < expectedOrder.length; index += 1) {
    assert.equal(pending.kind, "response_required");
    if (pending.kind !== "response_required") throw new Error("expected next General Store responder");
    const responder = pending.request.responders[0]!;
    assert.equal(responder.playerId, expectedOrder[index]);
    const candidateIds = responder.options.map((option) => option.payload.selectedCardInstanceId);
    assert.equal(candidateIds.length, expectedOrder.length - index);
    assert.ok(picks.every((picked) => !candidateIds.includes(picked)), "already selected cards must leave later options");
    const choiceId = candidateIds[0];
    assert.equal(typeof choiceId, "string");
    if (typeof choiceId !== "string") throw new Error("General Store responder has no card option");
    picks.push(choiceId);
    completed.push(interactionResult(pending.request, `store-${index}`, responder.playerId, choiceId));

    pending = generalStoreEffect({
      ...makeInput(working, sourceCardInstanceId, unusedRandom(), actorId),
      completedInteractions: completed,
    });
    assert.ok(pending.kind === "response_required" || pending.kind === "applied");
    if (pending.kind === "invalid_target" || pending.kind === "target_required") {
      throw new Error(`unexpected General Store result: ${pending.kind}`);
    }
    applyDrafts(working, pending.events);
  }

  assert.equal(pending.kind, "applied");
  assert.deepEqual(new Set(picks), new Set(revealedIds));
  assert.deepEqual(working.zones.revealedPoolCardInstanceIds, []);
  for (let index = 0; index < expectedOrder.length; index += 1) {
    const owner = working.seats.find((seat) => seat.public.playerId === expectedOrder[index]);
    assert.ok(owner);
    assert.ok(owner.private.handCardInstanceIds.includes(picks[index]!));
  }
  assert.ok(!working.seats.some((seat) => seat.public.playerId === seatAt(state, 1).public.playerId &&
    seat.private.handCardInstanceIds.some((id) => revealedIds.includes(id))));
});

test("General Store reshuffles the used source card before revealing the full living-player count", () => {
  const state = initialState(4);
  const actorId = seatAt(state, 0).public.playerId;
  const sourceCardInstanceId = physicalCardId(state, "general_store");
  const firstDrawId = physicalCardId(state, "bang");
  const rest = [
    physicalCardId(state, "missed"),
    physicalCardId(state, "beer"),
    physicalCardId(state, "duel"),
  ];
  setPiles(state, [firstDrawId], [sourceCardInstanceId, ...rest]);

  const result = generalStoreEffect(makeInput(state, sourceCardInstanceId, fixedRandom([0.99, 0.99, 0.99]), actorId));
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") return;
  assert.deepEqual(result.events.map((draft) => draft.type), [
    "GENERAL_STORE_CARD_REVEALED",
    "DRAW_PILE_RESHUFFLED",
    "GENERAL_STORE_CARD_REVEALED",
    "GENERAL_STORE_CARD_REVEALED",
    "GENERAL_STORE_CARD_REVEALED",
  ]);
  assert.ok(result.events.some((draft) =>
    draft.type === "GENERAL_STORE_CARD_REVEALED" && draft.payload.cardInstanceId === sourceCardInstanceId,
  ), "R08 allows the just-played General Store to re-enter the revealed pool");
  assert.equal(result.request.responders[0]?.options.length, 4);
});

test("effects reject mismatched sources, explicit targets, and invalid General Store choices", () => {
  const state = initialState(4);
  const sourceCardInstanceId = physicalCardId(state, "stagecoach");
  const wrongSource = physicalCardId(state, "beer");
  setPiles(state, [], [sourceCardInstanceId, wrongSource]);
  assert.deepEqual(
    wellsFargoEffect({ ...makeInput(state, wrongSource), sourceCardInstanceId: wrongSource }),
    { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" },
  );
  assert.deepEqual(
    stagecoachEffect({ ...makeInput(state, sourceCardInstanceId), targets: [{ kind: "player", playerId: "player-2" }] }),
    { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" },
  );

  const storeSource = physicalCardId(state, "general_store");
  const cards = [physicalCardId(state, "bang"), physicalCardId(state, "missed"), physicalCardId(state, "beer"), physicalCardId(state, "duel")];
  setPiles(state, cards, [storeSource]);
  const started = generalStoreEffect(makeInput(state, storeSource));
  assert.equal(started.kind, "response_required");
  if (started.kind !== "response_required") return;
  const responderId = started.request.responders[0]!.playerId;
  const invalidCompleted: CompletedEffectInteraction = {
    interactionId: "bad-store-choice",
    kind: started.request.kind,
    context: started.request.context,
    responses: [{ playerId: responderId, choice: "CHOOSE_CARD", payload: { selectedCardInstanceId: "not-revealed" } }],
  };
  const resumed = generalStoreEffect({
    ...makeInput(state, storeSource),
    completedInteractions: [invalidCompleted],
  });
  assert.deepEqual(resumed, { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });
});
