import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import type { CharacterAbilityInput, SuzyAfterCardEffectHookInput, SuzyAfterResponseHookInput } from "../../../src/effects/character-api.ts";
import { suzyLafayetteAbility } from "../../../src/effects/characters/suzy-lafayette.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { GameState } from "../../../src/state/types.ts";

function fixedRandom(): RandomSource {
  let cursor = 0;
  return { nextFloat: () => ((cursor++ * 67 + 11) % 997) / 997 };
}

function makeState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({ playerId: `player-${index + 1}`, displayName: `Player ${index + 1}` }));
  const state = initializeGame({ players, random: fixedRandom() });
  state.seats[0]!.public.characterId = "suzy_lafayette";
  return state;
}

function typeOf(state: GameState, cardInstanceId: string): string | undefined {
  const card = state.zones.cardsByInstanceId[cardInstanceId];
  return card && BASE_PHYSICAL_CARDS.find((definition) => definition.definitionId === card.cardDefinitionId)?.typeId;
}

function locationCount(state: GameState, cardInstanceId: string): number {
  let count = 0;
  const countIn = (ids: readonly string[]) => { count += ids.filter((id) => id === cardInstanceId).length; };
  for (const seat of state.seats) {
    countIn(seat.private.handCardInstanceIds);
    countIn(seat.public.inPlayCardInstanceIds);
  }
  countIn(state.zones.drawPileCardInstanceIds);
  countIn(state.zones.discardPileCardInstanceIds);
  countIn(state.zones.revealedPoolCardInstanceIds);
  return count;
}

function removeEverywhere(state: GameState, cardInstanceId: string): void {
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
}

function resetSuzyHand(state: GameState): void {
  const actor = state.seats[0]!;
  const oldHand = [...actor.private.handCardInstanceIds];
  actor.private.handCardInstanceIds = [];
  for (const cardInstanceId of oldHand) removeEverywhere(state, cardInstanceId);
  state.zones.drawPileCardInstanceIds = [...oldHand, ...state.zones.drawPileCardInstanceIds];
}

function takeCard(state: GameState, typeId: string, excluded: readonly string[] = []): string {
  const card = Object.values(state.zones.cardsByInstanceId).find((candidate) =>
    typeOf(state, candidate.cardInstanceId) === typeId && !excluded.includes(candidate.cardInstanceId) &&
    locationCount(state, candidate.cardInstanceId) === 1,
  );
  assert.ok(card, `fixture needs a ${typeId} card`);
  return card.cardInstanceId;
}

function moveToDiscard(state: GameState, typeId: string, excluded: readonly string[] = []): string {
  const cardInstanceId = takeCard(state, typeId, excluded);
  removeEverywhere(state, cardInstanceId);
  state.zones.discardPileCardInstanceIds.push(cardInstanceId);
  return cardInstanceId;
}

function moveToHand(state: GameState, typeId: string): string {
  const cardInstanceId = takeCard(state, typeId);
  removeEverywhere(state, cardInstanceId);
  state.seats[0]!.private.handCardInstanceIds.push(cardInstanceId);
  return cardInstanceId;
}

function putOnTop(state: GameState, typeId: string, excluded: readonly string[] = []): string {
  const cardInstanceId = takeCard(state, typeId, excluded);
  removeEverywhere(state, cardInstanceId);
  state.zones.drawPileCardInstanceIds.unshift(cardInstanceId);
  return cardInstanceId;
}

function cardReference(state: GameState, cardInstanceId: string) {
  const typeId = typeOf(state, cardInstanceId);
  assert.ok(typeId);
  return { cardInstanceId, physicalCardTypeId: typeId, effectCardTypeId: typeId } as const;
}

function input(
  state: GameState,
  hook: SuzyAfterCardEffectHookInput | SuzyAfterResponseHookInput,
  random: RandomSource = fixedRandom(),
): CharacterAbilityInput<"suzy_lafayette"> {
  return {
    characterId: "suzy_lafayette",
    playerId: state.seats[0]!.public.playerId,
    state,
    continuationFrameId: "suzy-frame-1",
    random,
    completedInteractions: [],
    hook,
  };
}

function completedCardHook(state: GameState, cardInstanceId: string, handCardCountAfterEffect: number): SuzyAfterCardEffectHookInput {
  return {
    kind: "after_card_effect",
    card: cardReference(state, cardInstanceId),
    boundary: "resolution_complete",
    handCardCountAfterEffect,
    pendingInteractionKind: null,
  };
}

test("Suzy draws immediately after a continuing Slab response leaves her empty-handed", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  resetSuzyHand(state);
  const responseMissed = moveToDiscard(state, "missed");
  const nextMissed = putOnTop(state, "missed", [responseMissed]);
  const before = structuredClone(state);
  const hook: SuzyAfterResponseHookInput = {
    kind: "after_response",
    interactionId: "slab-bang-response-1",
    responderPlayerId: actor.public.playerId,
    response: {
      interactionKind: "BANG_RESPONSE",
      choice: "USE_MISSED",
      card: cardReference(state, responseMissed),
    },
    responseSeries: "continuing",
    handCardCountAfterResponse: 0,
  };

  const result = suzyLafayetteAbility(input(state, hook, { nextFloat: () => { throw new Error("non-empty draw pile must not shuffle"); } }));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events, [{
    type: "CARD_DRAWN",
    actorPlayerId: actor.public.playerId,
    payload: {
      sourceCardInstanceId: responseMissed,
      cardInstanceId: nextMissed,
      playerId: actor.public.playerId,
      fromZone: "draw_pile",
      toZone: "hand",
    },
  }]);
  assert.deepEqual(result.steps, []);
  assert.deepEqual(state, before, "the character module returns the immediate draw as events without mutating state");
});

test("Suzy waits for a last Duel to finish, then draws once if the hand is still empty", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  resetSuzyHand(state);
  const duel = moveToDiscard(state, "duel");
  const nextCard = state.zones.drawPileCardInstanceIds[0];
  assert.ok(nextCard);

  const result = suzyLafayetteAbility(input(state, completedCardHook(state, duel, 0)));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events, [{
    type: "CARD_DRAWN",
    actorPlayerId: actor.public.playerId,
    payload: {
      sourceCardInstanceId: duel,
      cardInstanceId: nextCard,
      playerId: actor.public.playerId,
      fromZone: "draw_pile",
      toZone: "hand",
    },
  }]);
});

test("Suzy's surviving El Gringo boundary draws before the reward only when her hand is empty", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const victim = state.seats[1]!;
  resetSuzyHand(state);
  victim.public.characterId = "el_gringo";
  const source = moveToDiscard(state, "bang");
  const nextCard = state.zones.drawPileCardInstanceIds[0];
  assert.ok(nextCard);
  const hook: SuzyAfterCardEffectHookInput = {
    kind: "after_card_effect",
    card: cardReference(state, source),
    boundary: "before_el_gringo_reward",
    trigger: { kind: "EL_GRINGO_DAMAGE", victimPlayerId: victim.public.playerId },
    handCardCountAfterEffect: 0,
    pendingInteractionKind: null,
  };

  const result = suzyLafayetteAbility(input(state, hook));

  assert.deepEqual(result.events, [{
    type: "CARD_DRAWN",
    actorPlayerId: actor.public.playerId,
    payload: {
      sourceCardInstanceId: source,
      cardInstanceId: nextCard,
      playerId: actor.public.playerId,
      fromZone: "draw_pile",
      toZone: "hand",
    },
  }]);
  assert.deepEqual(actor.private.handCardInstanceIds, []);

  moveToHand(state, "beer");
  assert.deepEqual(suzyLafayetteAbility(input(state, { ...hook, handCardCountAfterEffect: 1 })), {
    kind: "applied",
    events: [],
    steps: [],
  });
});

test("completed General Store, Stagecoach, and Wells Fargo do not trigger an extra Suzy draw", () => {
  const cases = [
    { typeId: "general_store", received: ["bang"] },
    { typeId: "stagecoach", received: ["bang", "panic"] },
    { typeId: "wells_fargo", received: ["bang", "panic", "missed"] },
  ] as const;

  for (const cardCase of cases) {
    const state = makeState();
    const actor = state.seats[0]!;
    resetSuzyHand(state);
    const source = moveToDiscard(state, cardCase.typeId);
    for (const typeId of cardCase.received) moveToHand(state, typeId);
    const before = structuredClone(state);

    const result = suzyLafayetteAbility(input(state, completedCardHook(state, source, actor.private.handCardInstanceIds.length), {
      nextFloat: () => { throw new Error(`${cardCase.typeId} already gave Suzy cards`); },
    }));

    assert.deepEqual(result, { kind: "applied", events: [], steps: [] }, cardCase.typeId);
    assert.deepEqual(state, before, cardCase.typeId);
  }
});

test("Suzy ignores non-empty, stale-count, unsupported-actor, and wrong-boundary hooks", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  resetSuzyHand(state);
  const missed = moveToDiscard(state, "missed");
  const drawId = state.zones.drawPileCardInstanceIds[0];
  assert.ok(drawId);
  const hook: SuzyAfterResponseHookInput = {
    kind: "after_response",
    interactionId: "response-1",
    responderPlayerId: actor.public.playerId,
    response: { interactionKind: "GATLING_RESPONSE", choice: "USE_MISSED", card: cardReference(state, missed) },
    responseSeries: "effect_complete",
    handCardCountAfterResponse: 0,
  };
  const base = input(state, hook);

  assert.deepEqual(suzyLafayetteAbility({ ...base, hook: { ...hook, handCardCountAfterResponse: 1 } }), { kind: "applied", events: [], steps: [] });
  assert.deepEqual(suzyLafayetteAbility({ ...base, playerId: "not-suzy" }), { kind: "applied", events: [], steps: [] });
  const prematureCardHook = {
    ...completedCardHook(state, missed, 0),
    boundary: "card_result_committed",
    pendingInteractionKind: "GENERAL_STORE_PICK",
  } as unknown as SuzyAfterCardEffectHookInput;
  assert.deepEqual(suzyLafayetteAbility({ ...base, hook: prematureCardHook }), { kind: "applied", events: [], steps: [] });

  actor.private.handCardInstanceIds.push(drawId);
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== drawId);
  assert.deepEqual(suzyLafayetteAbility(base), { kind: "applied", events: [], steps: [] }, "the saved count must match the current hand");
});
