// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CharacterAbilityInput } from "../../../src/effects/character-api.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { calculateBaseDistance, calculateDistance, getEquippedCardTypeIds } from "../../../src/rules/distance.ts";
import { roseDoolanAbility } from "../../../src/effects/characters/rose-doolan.ts";

type RoseInput = CharacterAbilityInput<"rose_doolan">;

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
): RoseInput {
  const rose = state.seats.find((seat) => seat.public.characterId === "rose_doolan");
  assert.ok(rose, "fixture needs Rose Doolan");
  return {
    characterId: "rose_doolan",
    playerId: rose.public.playerId,
    state,
    continuationFrameId: "frame-rose-doolan",
    random: { nextFloat: () => { throw new Error("Rose Doolan must not consume randomness"); } },
    completedInteractions: [],
    hook: { kind: "distance_query", fromPlayerId, toPlayerId, baseDistance },
  };
}

function expectedR10Distance(
  state: GameState,
  fromPlayerId: string,
  toPlayerId: string,
  roseAdjustment: number,
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
    baseDistance! + Number(targetCards.includes("mustang")) +
      Number(target.public.characterId === "paul_regret") +
      Number(sourceCards.includes("scope")) * -1 + roseAdjustment,
  );
}

test("Rose reduces only her own directed query and stacks with Scope, Paul, and Mustang per R10", () => {
  const state = initialState(7);
  const rose = seatAt(state, 0);
  const paul = seatAt(state, 3);
  rose.public.characterId = "rose_doolan";
  paul.public.characterId = "paul_regret";
  moveCardToInPlay(state, rose.public.playerId, "scope");
  moveCardToInPlay(state, paul.public.playerId, "mustang");
  const before = structuredClone(state);

  const towardOpponent = roseDoolanAbility(makeInput(state, rose.public.playerId, paul.public.playerId));
  assert.deepEqual(towardOpponent, { kind: "distance_query", adjustment: -1 });
  const outward = calculateDistance(state, rose.public.playerId, paul.public.playerId);
  assert.ok(outward);
  assert.equal(outward.baseDistance, 3);
  assert.equal(outward.targetMustangBonus, 1);
  assert.equal(outward.targetPaulRegretBonus, 1);
  assert.equal(outward.sourceScopeReduction, 1);
  assert.equal(outward.sourceRoseDoolanReduction, 1);
  assert.equal(outward.distance, expectedR10Distance(
    state,
    rose.public.playerId,
    paul.public.playerId,
    towardOpponent.adjustment,
  ));

  const towardRose = roseDoolanAbility(makeInput(state, paul.public.playerId, rose.public.playerId));
  assert.deepEqual(towardRose, { kind: "distance_query", adjustment: 0 });
  const inward = calculateDistance(state, paul.public.playerId, rose.public.playerId);
  assert.ok(inward);
  assert.equal(inward.sourceRoseDoolanReduction, 0);
  assert.equal(inward.distance, expectedR10Distance(
    state,
    paul.public.playerId,
    rose.public.playerId,
    towardRose.adjustment,
  ));
  assert.deepEqual(state, before, "distance queries must not mutate the snapshot");
});

test("R10 uses the surviving circle and keeps Rose plus Scope at a minimum distance of one", () => {
  const state = initialState(6);
  const rose = seatAt(state, 0);
  const paul = seatAt(state, 4);
  rose.public.characterId = "rose_doolan";
  paul.public.characterId = "paul_regret";
  seatAt(state, 1).public.eliminated = true;
  seatAt(state, 2).public.eliminated = true;
  moveCardToInPlay(state, rose.public.playerId, "scope");
  moveCardToInPlay(state, paul.public.playerId, "mustang");

  const query = roseDoolanAbility(makeInput(state, rose.public.playerId, paul.public.playerId));
  assert.deepEqual(query, { kind: "distance_query", adjustment: -1 });
  const distance = calculateDistance(state, rose.public.playerId, paul.public.playerId);
  assert.ok(distance);
  assert.equal(distance.baseDistance, 2, "the two eliminated seats do not count in the circle");
  assert.equal(distance.targetMustangBonus, 1);
  assert.equal(distance.targetPaulRegretBonus, 1);
  assert.equal(distance.sourceScopeReduction, 1);
  assert.equal(distance.sourceRoseDoolanReduction, 1);
  assert.equal(distance.distance, expectedR10Distance(
    state,
    rose.public.playerId,
    paul.public.playerId,
    query.adjustment,
  ));

  const adjacent = initialState(6);
  const adjacentRose = seatAt(adjacent, 0);
  const adjacentPaul = seatAt(adjacent, 5);
  adjacentRose.public.characterId = "rose_doolan";
  adjacentPaul.public.characterId = "paul_regret";
  seatAt(adjacent, 1).public.eliminated = true;
  seatAt(adjacent, 2).public.eliminated = true;
  seatAt(adjacent, 3).public.eliminated = true;
  moveCardToInPlay(adjacent, adjacentRose.public.playerId, "scope");
  moveCardToInPlay(adjacent, adjacentPaul.public.playerId, "mustang");

  const adjacentQuery = roseDoolanAbility(makeInput(adjacent, adjacentRose.public.playerId, adjacentPaul.public.playerId));
  const floored = calculateDistance(adjacent, adjacentRose.public.playerId, adjacentPaul.public.playerId);
  assert.ok(floored);
  assert.equal(floored.baseDistance, 1);
  assert.equal(adjacentQuery.adjustment, -1);
  assert.equal(floored.distance, 1, "R10 floors stacked reductions at one");
  assert.equal(floored.distance, expectedR10Distance(
    adjacent,
    adjacentRose.public.playerId,
    adjacentPaul.public.playerId,
    adjacentQuery.adjustment,
  ));
});

test("Rose at zero HP still reduces distance while the death-rescue decision is pending", () => {
  const state = initialState(5);
  const rose = seatAt(state, 0);
  const opponent = seatAt(state, 1);
  rose.public.characterId = "rose_doolan";
  rose.public.hp = 0;
  rose.public.eliminated = false;

  const query = roseDoolanAbility(makeInput(state, rose.public.playerId, opponent.public.playerId));
  assert.deepEqual(query, { kind: "distance_query", adjustment: -1 });
  assert.equal(calculateBaseDistance(state, rose.public.playerId, opponent.public.playerId), 1);
  const distance = calculateDistance(state, rose.public.playerId, opponent.public.playerId);
  assert.ok(distance);
  assert.equal(distance.sourceRoseDoolanReduction, 1);
  assert.equal(distance.distance, 1, "the HP-0 Rose remains in the seat ring through death rescue");
});

test("self queries, dead or mismatched Rose, and malformed or duplicate seat data contribute zero", () => {
  const state = initialState(5);
  const rose = seatAt(state, 2);
  const opponent = seatAt(state, 0);
  rose.public.characterId = "rose_doolan";

  const zero = { kind: "distance_query", adjustment: 0 } as const;
  assert.deepEqual(roseDoolanAbility(makeInput(state, rose.public.playerId, rose.public.playerId, 0)), zero);
  assert.deepEqual(roseDoolanAbility(makeInput(state, opponent.public.playerId, seatAt(state, 1).public.playerId)), zero);

  rose.public.eliminated = true;
  assert.deepEqual(roseDoolanAbility(makeInput(state, rose.public.playerId, opponent.public.playerId)), zero);
  rose.public.eliminated = false;

  const mismatchedIdentity = {
    ...makeInput(state, rose.public.playerId, opponent.public.playerId),
    characterId: "paul_regret",
  } as unknown as RoseInput;
  assert.deepEqual(roseDoolanAbility(mismatchedIdentity), zero);

  const duplicatePlayer = structuredClone(state);
  duplicatePlayer.seats[4]!.public.playerId = opponent.public.playerId;
  assert.deepEqual(roseDoolanAbility(makeInput(duplicatePlayer, rose.public.playerId, opponent.public.playerId)), zero);

  const duplicateIndex = structuredClone(state);
  duplicateIndex.seats[4]!.public.seatIndex = duplicateIndex.seats[0]!.public.seatIndex;
  assert.deepEqual(roseDoolanAbility(makeInput(duplicateIndex, rose.public.playerId, opponent.public.playerId)), zero);

  const invalidIndex = structuredClone(state);
  invalidIndex.seats[4]!.public.seatIndex = 1.5;
  assert.deepEqual(roseDoolanAbility(makeInput(invalidIndex, rose.public.playerId, opponent.public.playerId)), zero);

  const malformedSeatList = {
    ...makeInput(state, rose.public.playerId, opponent.public.playerId),
    state: { ...state, seats: null },
  } as unknown as RoseInput;
  assert.deepEqual(roseDoolanAbility(malformedSeatList), zero);

  assert.deepEqual(roseDoolanAbility(makeInput(state, rose.public.playerId, opponent.public.playerId, 0)), zero);
});
