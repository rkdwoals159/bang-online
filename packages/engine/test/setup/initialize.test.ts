import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BASE_DECK_RULESET_VERSION,
  BASE_PHYSICAL_CARDS,
} from "../../../catalog/src/cards/index.ts";
import { characters } from "../../../catalog/src/characters/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";

function fixedRandom(): RandomSource {
  const values = Array.from({ length: 1_000 }, (_, index) => ((index * 67 + 11) % 997) / 997);
  let cursor = 0;
  return {
    nextFloat() {
      assert.ok(cursor < values.length, "setup requested more random values than expected");
      return values[cursor++]!;
    },
  };
}

function playersFor(count: number): SetupPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
}

const characterById = new Map(characters.map((character) => [character.id, character]));
const expectedRoleCounts = {
  4: { sheriff: 1, deputy: 0, outlaw: 2, renegade: 1 },
  5: { sheriff: 1, deputy: 1, outlaw: 2, renegade: 1 },
  6: { sheriff: 1, deputy: 1, outlaw: 3, renegade: 1 },
  7: { sheriff: 1, deputy: 2, outlaw: 3, renegade: 1 },
} as const;

function assertInitialState(playerCount: 4 | 5 | 6 | 7): void {
  const players = playersFor(playerCount);
  const state = initializeGame({ players, random: fixedRandom() });
  const actualRoleCounts = {
    sheriff: 0,
    deputy: 0,
    outlaw: 0,
    renegade: 0,
  };

  for (const seat of state.seats) {
    actualRoleCounts[seat.private.roleId] += 1;
    const character = characterById.get(seat.public.characterId);
    assert.ok(character, `unknown character ${seat.public.characterId}`);
    const expectedHp = character.baseHealth + Number(seat.private.roleId === "sheriff");
    assert.equal(seat.public.maxHp, expectedHp);
    assert.equal(seat.public.hp, expectedHp, "initial HP must equal maximum HP");
    assert.equal(seat.private.handCardInstanceIds.length, expectedHp);
    assert.equal(seat.public.roleRevealed, seat.private.roleId === "sheriff");
    assert.deepEqual(seat.public.inPlayCardInstanceIds, []);
  }

  assert.deepEqual(actualRoleCounts, expectedRoleCounts[playerCount]);
  assert.equal(state.seats[0]!.private.roleId, "sheriff");
  assert.equal(state.seats[0]!.public.roleRevealed, true);
  assert.equal(state.turn.currentPlayerId, state.seats[0]!.public.playerId);
  assert.equal(state.turn.phase, "start");
  assert.equal(state.turn.turnNumber, 1);
  assert.equal(state.turn.bangCardPlaysThisTurn, 0);
  assert.deepEqual(
    state.seats.map((seat) => seat.public.seatIndex),
    Array.from({ length: playerCount }, (_, index) => index),
  );

  const sheriffInputIndex = players.findIndex((player) => player.playerId === state.seats[0]!.public.playerId);
  const sheriffFirstClockwiseOrder = [
    ...players.slice(sheriffInputIndex),
    ...players.slice(0, sheriffInputIndex),
  ].map((player) => player.playerId);
  assert.deepEqual(
    state.seats.map((seat) => seat.public.playerId),
    sheriffFirstClockwiseOrder,
    "rotation should preserve the input clockwise order after placing the Sheriff first",
  );

  const assignedCharacters = state.seats.map((seat) => seat.public.characterId);
  assert.equal(new Set(assignedCharacters).size, playerCount);

  const allZoneIds = [
    ...state.seats.flatMap((seat) => seat.private.handCardInstanceIds),
    ...state.seats.flatMap((seat) => seat.public.inPlayCardInstanceIds),
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
  ];
  assert.equal(allZoneIds.length, 80);
  assert.equal(new Set(allZoneIds).size, 80, "each physical card must occupy one zone");
  assert.equal(Object.keys(state.zones.cardsByInstanceId).length, 80);
  assert.deepEqual(new Set(allZoneIds), new Set(Object.keys(state.zones.cardsByInstanceId)));
  assert.equal(
    state.zones.drawPileCardInstanceIds.length,
    80 - state.seats.reduce((total, seat) => total + seat.public.hp, 0),
  );
  assert.deepEqual(state.zones.discardPileCardInstanceIds, []);
  assert.deepEqual(state.zones.revealedPoolCardInstanceIds, []);
  assert.equal(state.rulesetVersion, BASE_DECK_RULESET_VERSION);
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state, "initial state must be JSON-serializable");

  const sourcePhysicalCardsById = new Map(BASE_PHYSICAL_CARDS.map((card) => [card.definitionId, card]));
  const instances = Object.values(state.zones.cardsByInstanceId);
  assert.equal(new Set(instances.map((card) => card.cardInstanceId)).size, 80);
  for (const instance of instances) {
    assert.match(instance.cardInstanceId, /^ci_[0-9a-f]{32}_[0-9a-z]+$/);
    assert.equal(instance.cardInstanceId, state.zones.cardsByInstanceId[instance.cardInstanceId]!.cardInstanceId);
    const sourceCard = sourcePhysicalCardsById.get(instance.cardDefinitionId);
    assert.ok(sourceCard, `unknown physical card definition ${instance.cardDefinitionId}`);
    assert.equal(instance.rank, sourceCard.rank);
    assert.equal(instance.suit, sourceCard.suit);
  }
}

test("initializes correct role counts and sheriff-first clockwise seats for 4–7 players", () => {
  for (const playerCount of [4, 5, 6, 7] as const) {
    assertInitialState(playerCount);
  }
});

test("starts the Sheriff at character health plus one and deals each player that many cards", () => {
  for (const playerCount of [4, 5, 6, 7] as const) {
    const state = initializeGame({ players: playersFor(playerCount), random: fixedRandom() });
    const sheriff = state.seats[0]!;
    const character = characterById.get(sheriff.public.characterId)!;

    assert.equal(sheriff.private.roleId, "sheriff");
    assert.equal(sheriff.public.maxHp, character.baseHealth + 1);
    assert.equal(sheriff.public.hp, character.baseHealth + 1);
    assert.equal(sheriff.private.handCardInstanceIds.length, character.baseHealth + 1);
    for (const seat of state.seats.slice(1)) {
      const assignedCharacter = characterById.get(seat.public.characterId)!;
      assert.equal(seat.public.hp, assignedCharacter.baseHealth);
      assert.equal(seat.public.maxHp, assignedCharacter.baseHealth);
      assert.equal(seat.private.handCardInstanceIds.length, assignedCharacter.baseHealth);
    }
  }
});

test("repeats the same complete setup with the same fixed RNG sequence", () => {
  const players = playersFor(7);
  const first = initializeGame({ players, random: fixedRandom() });
  const second = initializeGame({ players, random: fixedRandom() });

  assert.deepEqual(second, first);
});

test("rejects unsupported player counts and duplicate player IDs", () => {
  assert.throws(() => initializeGame({ players: playersFor(3), random: fixedRandom() }), RangeError);
  assert.throws(() => initializeGame({ players: playersFor(8), random: fixedRandom() }), RangeError);

  const duplicatePlayers = playersFor(4);
  duplicatePlayers[1]!.playerId = duplicatePlayers[0]!.playerId;
  assert.throws(
    () => initializeGame({ players: duplicatePlayers, random: fixedRandom() }),
    TypeError,
  );
});
