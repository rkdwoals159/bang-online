// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CharacterAbilityInput } from "../../../src/effects/character-api.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { calculateBaseDistance, calculateDistance, getEquippedCardTypeIds } from "../../../src/rules/distance.ts";
import { paulRegretAbility } from "../../../src/effects/characters/paul-regret.ts";

type PaulInput = CharacterAbilityInput<"paul_regret">;

function initialState(playerCount = 6): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seatAt(state: GameState, seatIndex: number): SeatState {
  const matches = state.seats.filter((seat) => seat.public.seatIndex === seatIndex);
  assert.equal(matches.length, 1, `fixture needs one seat at ${seatIndex}`);
  return matches[0]!;
}

function moveCardToInPlay(state: GameState, playerId: string, typeId: string): string {
  const definition = BASE_PHYSICAL_CARDS.find((card) => card.typeId === typeId);
  assert.ok(definition, `fixture needs a ${typeId} card`);
  const instance = Object.values(state.zones.cardsByInstanceId)
    .find((card) => card.cardDefinitionId === definition.definitionId);
  assert.ok(instance, `fixture needs a ${typeId} card instance`);

  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== instance.cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== instance.cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== instance.cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== instance.cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== instance.cardInstanceId);

  const target = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(target, `fixture needs player ${playerId}`);
  target.public.inPlayCardInstanceIds.push(instance.cardInstanceId);
  return instance.cardInstanceId;
}

function makeInput(
  state: GameState,
  fromPlayerId: string,
  toPlayerId: string,
  baseDistance = calculateBaseDistance(state, fromPlayerId, toPlayerId) ?? Number.NaN,
): PaulInput {
  const paul = state.seats.find((seat) => seat.public.characterId === "paul_regret");
  assert.ok(paul, "fixture needs Paul Regret");
  return {
    characterId: "paul_regret",
    playerId: paul.public.playerId,
    state,
    continuationFrameId: "frame-paul-regret",
    random: { nextFloat: () => { throw new Error("Paul Regret must not consume randomness"); } },
    completedInteractions: [],
    hook: { kind: "distance_query", fromPlayerId, toPlayerId, baseDistance },
  };
}

function expectedR10Distance(
  state: GameState,
  fromPlayerId: string,
  toPlayerId: string,
  paulAdjustment: number,
): number {
  const baseDistance = calculateBaseDistance(state, fromPlayerId, toPlayerId);
  const source = state.seats.find((seat) => seat.public.playerId === fromPlayerId);
  const target = state.seats.find((seat) => seat.public.playerId === toPlayerId);
  const sourceCards = getEquippedCardTypeIds(state, fromPlayerId);
  const targetCards = getEquippedCardTypeIds(state, toPlayerId);
  assert.notEqual(baseDistance, undefined);
  assert.ok(source && target && sourceCards && targetCards);
  return Math.max(
    1,
    baseDistance! + Number(targetCards.includes("mustang")) + paulAdjustment -
      Number(sourceCards.includes("scope")) - Number(source.public.characterId === "rose_doolan"),
  );
}

test("only the opponent-to-Paul query gains one and stacks with Rose, Scope, and Mustang per R10", () => {
  const state = initialState(7);
  const source = seatAt(state, 0);
  const paul = seatAt(state, 3);
  source.public.characterId = "rose_doolan";
  paul.public.characterId = "paul_regret";
  moveCardToInPlay(state, source.public.playerId, "scope");
  moveCardToInPlay(state, paul.public.playerId, "mustang");
  const before = structuredClone(state);

  const towardPaul = paulRegretAbility(makeInput(state, source.public.playerId, paul.public.playerId));
  assert.deepEqual(towardPaul, { kind: "distance_query", adjustment: 1 });
  const forward = calculateDistance(state, source.public.playerId, paul.public.playerId);
  assert.ok(forward);
  assert.equal(forward.baseDistance, 3);
  assert.equal(forward.targetMustangBonus, 1);
  assert.equal(forward.targetPaulRegretBonus, towardPaul.adjustment);
  assert.equal(forward.sourceScopeReduction, 1);
  assert.equal(forward.sourceRoseDoolanReduction, 1);
  assert.equal(forward.distance, expectedR10Distance(
    state,
    source.public.playerId,
    paul.public.playerId,
    towardPaul.adjustment,
  ));

  const awayFromPaul = paulRegretAbility(makeInput(state, paul.public.playerId, source.public.playerId));
  assert.deepEqual(awayFromPaul, { kind: "distance_query", adjustment: 0 });
  const reverse = calculateDistance(state, paul.public.playerId, source.public.playerId);
  assert.ok(reverse);
  assert.equal(reverse.targetPaulRegretBonus, awayFromPaul.adjustment);
  assert.equal(reverse.distance, expectedR10Distance(
    state,
    paul.public.playerId,
    source.public.playerId,
    awayFromPaul.adjustment,
  ));
  assert.deepEqual(state, before, "distance queries must not mutate the snapshot");
});

test("the living seat ring ignores eliminated seats while Paul and Mustang penalties accumulate", () => {
  const state = initialState(6);
  const source = seatAt(state, 0);
  const paul = seatAt(state, 4);
  paul.public.characterId = "paul_regret";
  seatAt(state, 1).public.eliminated = true;
  seatAt(state, 2).public.eliminated = true;
  moveCardToInPlay(state, paul.public.playerId, "mustang");

  const query = paulRegretAbility(makeInput(state, source.public.playerId, paul.public.playerId));
  assert.deepEqual(query, { kind: "distance_query", adjustment: 1 });
  const distance = calculateDistance(state, source.public.playerId, paul.public.playerId);
  assert.ok(distance);
  assert.equal(distance.baseDistance, 2, "the two dead seats do not count in the circle");
  assert.equal(distance.targetMustangBonus, 1);
  assert.equal(distance.targetPaulRegretBonus, 1);
  assert.equal(distance.distance, 4);
  assert.equal(distance.distance, expectedR10Distance(
    state,
    source.public.playerId,
    paul.public.playerId,
    query.adjustment,
  ));

  const adjacent = initialState(6);
  const rose = seatAt(adjacent, 0);
  const adjacentPaul = seatAt(adjacent, 5);
  rose.public.characterId = "rose_doolan";
  adjacentPaul.public.characterId = "paul_regret";
  seatAt(adjacent, 1).public.eliminated = true;
  seatAt(adjacent, 2).public.eliminated = true;
  seatAt(adjacent, 3).public.eliminated = true;
  moveCardToInPlay(adjacent, rose.public.playerId, "scope");
  moveCardToInPlay(adjacent, adjacentPaul.public.playerId, "mustang");

  const adjacentQuery = paulRegretAbility(makeInput(adjacent, rose.public.playerId, adjacentPaul.public.playerId));
  const floored = calculateDistance(adjacent, rose.public.playerId, adjacentPaul.public.playerId);
  assert.ok(floored);
  assert.equal(floored.baseDistance, 1);
  assert.equal(adjacentQuery.adjustment, 1);
  assert.equal(floored.distance, 1, "R10 keeps the combined Rose/Scope reduction at a minimum distance of one");
  assert.equal(floored.distance, expectedR10Distance(
    adjacent,
    rose.public.playerId,
    adjacentPaul.public.playerId,
    adjacentQuery.adjustment,
  ));
});

test("self, dead Paul, non-Paul target, and malformed or duplicate seat data safely contribute zero", () => {
  const state = initialState(5);
  const paul = seatAt(state, 2);
  const opponent = seatAt(state, 0);
  paul.public.characterId = "paul_regret";

  assert.deepEqual(paulRegretAbility(makeInput(state, paul.public.playerId, paul.public.playerId, 0)), {
    kind: "distance_query",
    adjustment: 0,
  });
  assert.deepEqual(paulRegretAbility(makeInput(state, opponent.public.playerId, seatAt(state, 1).public.playerId)), {
    kind: "distance_query",
    adjustment: 0,
  });

  paul.public.eliminated = true;
  assert.deepEqual(paulRegretAbility(makeInput(state, opponent.public.playerId, paul.public.playerId)), {
    kind: "distance_query",
    adjustment: 0,
  });
  paul.public.eliminated = false;

  const duplicatePlayer = structuredClone(state);
  duplicatePlayer.seats[4]!.public.playerId = opponent.public.playerId;
  assert.deepEqual(paulRegretAbility(makeInput(duplicatePlayer, opponent.public.playerId, paul.public.playerId)), {
    kind: "distance_query",
    adjustment: 0,
  });

  const duplicateIndex = structuredClone(state);
  duplicateIndex.seats[4]!.public.seatIndex = duplicateIndex.seats[0]!.public.seatIndex;
  assert.deepEqual(paulRegretAbility(makeInput(duplicateIndex, opponent.public.playerId, paul.public.playerId)), {
    kind: "distance_query",
    adjustment: 0,
  });

  const invalidIndex = structuredClone(state);
  invalidIndex.seats[4]!.public.seatIndex = 1.5;
  assert.deepEqual(paulRegretAbility(makeInput(invalidIndex, opponent.public.playerId, paul.public.playerId)), {
    kind: "distance_query",
    adjustment: 0,
  });

  const malformedSeatList = {
    ...makeInput(state, opponent.public.playerId, paul.public.playerId),
    state: { ...state, seats: null },
  } as unknown as PaulInput;
  assert.deepEqual(paulRegretAbility(malformedSeatList), {
    kind: "distance_query",
    adjustment: 0,
  });

  assert.deepEqual(paulRegretAbility(makeInput(state, opponent.public.playerId, paul.public.playerId, 0)), {
    kind: "distance_query",
    adjustment: 0,
  });
});
