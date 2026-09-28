import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState, SeatState } from "../../src/state/types.ts";
import { calculateBaseDistance, calculateDistance, getMaxBangRange } from "../../src/rules/distance.ts";
import { checkPlayCardLegality, type PlayCardLegalityInput } from "../../src/rules/legality.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";

function fixedRandom(): RandomSource {
  let cursor = 0;
  return {
    nextFloat() {
      const value = ((cursor * 97 + 31) % 1_009) / 1_009;
      cursor += 1;
      return value;
    },
  };
}

function initialState(playerCount = 7): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: fixedRandom() });
  state.turn.phase = "play";
  return state;
}

function seatAt(state: GameState, seatIndex: number): SeatState {
  const seat = state.seats.find((entry) => entry.public.seatIndex === seatIndex);
  assert.ok(seat, `missing seat ${seatIndex}`);
  return seat;
}

function detachCard(state: GameState, cardInstanceId: string): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
}

function giveCard(
  state: GameState,
  seatIndex: number,
  typeId: string,
  zone: "hand" | "inPlay",
  copyOffset = 0,
): string {
  const physicalCopies = BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId);
  const physical = physicalCopies[copyOffset];
  assert.ok(physical, `missing physical copy for ${typeId} at ${copyOffset}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (card) => card.cardDefinitionId === physical.definitionId,
  );
  assert.ok(instance, `missing runtime card for ${physical.definitionId}`);
  detachCard(state, instance.cardInstanceId);
  if (zone === "hand") seatAt(state, seatIndex).private.handCardInstanceIds.push(instance.cardInstanceId);
  else seatAt(state, seatIndex).public.inPlayCardInstanceIds.push(instance.cardInstanceId);
  return instance.cardInstanceId;
}

function attempt(
  state: GameState,
  seatIndex: number,
  cardTypeId: string,
  targetSeatIndex?: number,
  targetFields: Pick<PlayCardLegalityInput, "targetZone" | "targetCardInstanceId"> = {},
) {
  const cardInstanceId = giveCard(state, seatIndex, cardTypeId, "hand");
  const actorPlayerId = seatAt(state, seatIndex).public.playerId;
  const input: PlayCardLegalityInput = {
    actorPlayerId,
    cardInstanceId,
    ...(targetSeatIndex === undefined ? {} : { targetPlayerId: seatAt(state, targetSeatIndex).public.playerId }),
    ...targetFields,
  };
  return { cardInstanceId, input, result: checkPlayCardLegality(state, input) };
}

function assertFailure(
  result: ReturnType<typeof checkPlayCardLegality>,
  expectedCode: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, expectedCode);
}

test("base distance uses the living seat ring and ignores eliminated seats", () => {
  const state = initialState(6);
  const from = seatAt(state, 0).public.playerId;
  const acrossDeadSeats = seatAt(state, 3).public.playerId;
  const fartherSeat = seatAt(state, 4).public.playerId;
  state.seats[1]!.public.eliminated = true;
  state.seats[2]!.public.eliminated = true;
  const before = structuredClone(state);

  assert.equal(calculateBaseDistance(state, from, acrossDeadSeats), 1);
  assert.equal(calculateBaseDistance(state, from, fartherSeat), 2);
  assert.equal(calculateBaseDistance(state, from, from), 0);
  assert.deepEqual(state, before, "distance calculations must not mutate the snapshot");
});

test("R10 applies direction-specific Rose, Scope, Paul, and Mustang adjustments with a floor of one", () => {
  const state = initialState(6);
  const source = seatAt(state, 0);
  const target = seatAt(state, 2);
  source.public.characterId = "rose_doolan";
  target.public.characterId = "paul_regret";
  giveCard(state, 0, "scope", "inPlay");
  giveCard(state, 2, "mustang", "inPlay");
  const before = structuredClone(state);

  const forward = calculateDistance(state, source.public.playerId, target.public.playerId);
  const reverse = calculateDistance(state, target.public.playerId, source.public.playerId);

  assert.deepEqual(forward, {
    baseDistance: 2,
    targetMustangBonus: 1,
    targetPaulRegretBonus: 1,
    sourceScopeReduction: 1,
    sourceRoseDoolanReduction: 1,
    distance: 2,
  });
  assert.deepEqual(reverse, {
    baseDistance: 2,
    targetMustangBonus: 0,
    targetPaulRegretBonus: 0,
    sourceScopeReduction: 0,
    sourceRoseDoolanReduction: 0,
    distance: 2,
  });

  const adjacent = initialState(5);
  seatAt(adjacent, 0).public.characterId = "rose_doolan";
  giveCard(adjacent, 0, "scope", "inPlay");
  assert.equal(
    calculateDistance(adjacent, seatAt(adjacent, 0).public.playerId, seatAt(adjacent, 1).public.playerId)?.distance,
    1,
  );
  assert.deepEqual(state, before);
});

test("R11 keeps weapon range separate from directional distance", () => {
  const expectedRanges = [
    ["volcanic", 1],
    ["schofield", 2],
    ["remington", 3],
    ["carabine", 4],
    ["winchester", 5],
  ] as const;

  const noWeapon = initialState(7);
  assert.equal(getMaxBangRange(noWeapon, seatAt(noWeapon, 0).public.playerId), 1, "virtual Colt .45 range");

  for (const [typeId, range] of expectedRanges) {
    const state = initialState(7);
    const actorId = seatAt(state, 0).public.playerId;
    giveCard(state, 0, typeId, "inPlay");
    assert.equal(getMaxBangRange(state, actorId), range, `${typeId} range`);
  }

  const separate = initialState(7);
  const actorId = seatAt(separate, 0).public.playerId;
  const targetId = seatAt(separate, 2).public.playerId;
  giveCard(separate, 0, "scope", "inPlay");
  giveCard(separate, 0, "schofield", "inPlay");
  assert.equal(calculateBaseDistance(separate, actorId, targetId), 2);
  assert.equal(calculateDistance(separate, actorId, targetId)?.distance, 1);
  assert.equal(getMaxBangRange(separate, actorId), 2);
});

test("A10 rejects distant Panic! while a Winchester BANG! reaches distance five", () => {
  const state = initialState(7);
  const actorId = seatAt(state, 0).public.playerId;
  const targetId = seatAt(state, 2).public.playerId;
  giveCard(state, 0, "winchester", "inPlay");
  const panic = attempt(state, 0, "panic", 2, { targetZone: "HAND" });
  const bang = attempt(state, 0, "bang", 2);

  assertFailure(panic.result, "TARGET_OUT_OF_RANGE");
  assert.equal(bang.result.ok, true);
  assert.equal(calculateDistance(state, actorId, targetId)?.distance, 2);
  assert.equal(getMaxBangRange(state, actorId), 5);
});

test("B04 rejects BANG! against self, a dead seat, or a target beyond range", () => {
  const state = initialState(7);
  const actorId = seatAt(state, 0).public.playerId;
  const bangId = giveCard(state, 0, "bang", "hand");
  seatAt(state, 4).public.eliminated = true;
  const before = structuredClone(state);

  const self = checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: bangId,
    targetPlayerId: actorId,
  });
  const far = checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: bangId,
    targetPlayerId: seatAt(state, 3).public.playerId,
  });
  const dead = checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: bangId,
    targetPlayerId: seatAt(state, 4).public.playerId,
  });

  assertFailure(self, "TARGET_IS_SELF");
  assertFailure(far, "TARGET_OUT_OF_RANGE");
  assertFailure(dead, "TARGET_NOT_ALIVE");
  assert.deepEqual(state, before, "legality checks must not mutate card zones or turn state");
});

test("B23 rejects duplicate blue equipment and permits a different weapon replacement", () => {
  const duplicate = initialState(5);
  giveCard(duplicate, 0, "mustang", "inPlay", 0);
  const secondMustangId = giveCard(duplicate, 0, "mustang", "hand", 1);
  assertFailure(checkPlayCardLegality(duplicate, {
    actorPlayerId: seatAt(duplicate, 0).public.playerId,
    cardInstanceId: secondMustangId,
  }), "DUPLICATE_EQUIPMENT");

  const replacement = initialState(5);
  giveCard(replacement, 0, "schofield", "inPlay", 0);
  const remington = attempt(replacement, 0, "remington");
  assert.equal(remington.result.ok, true);
});

test("B30 cannot select a virtual Colt .45 as a public in-play target", () => {
  const state = initialState(5);
  const cat = giveCard(state, 0, "cat_balou", "hand");
  const result = checkPlayCardLegality(state, {
    actorPlayerId: seatAt(state, 0).public.playerId,
    cardInstanceId: cat,
    targetPlayerId: seatAt(state, 1).public.playerId,
    targetZone: "IN_PLAY",
    targetCardInstanceId: "virtual_colt_45",
  });

  assertFailure(result, "TARGET_CARD_NOT_IN_PLAY");
});

test("B21 allows Panic! and Cat Balou on own public equipment, but rejects own hand", () => {
  const state = initialState(5);
  const mustangId = giveCard(state, 0, "mustang", "inPlay");
  const panicId = giveCard(state, 0, "panic", "hand");
  const catId = giveCard(state, 0, "cat_balou", "hand");
  const actorId = seatAt(state, 0).public.playerId;

  assert.equal(checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: panicId,
    targetPlayerId: actorId,
    targetZone: "IN_PLAY",
    targetCardInstanceId: mustangId,
  }).ok, true);
  assert.equal(checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: catId,
    targetPlayerId: actorId,
    targetZone: "IN_PLAY",
    targetCardInstanceId: mustangId,
  }).ok, true);
  assertFailure(checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: panicId,
    targetPlayerId: actorId,
    targetZone: "HAND",
  }), "TARGET_IS_SELF");
  assertFailure(checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: catId,
    targetPlayerId: actorId,
    targetZone: "HAND",
  }), "TARGET_IS_SELF");
  assertFailure(checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: catId,
    targetPlayerId: seatAt(state, 1).public.playerId,
    targetZone: "HAND",
    targetCardInstanceId: seatAt(state, 1).private.handCardInstanceIds[0],
  }), "TARGET_NOT_ALLOWED");
});

test("C23 allows Willy three BANG! cards but continues to enforce range", () => {
  const state = initialState(7);
  const willy = seatAt(state, 0);
  willy.public.characterId = "willy_the_kid";
  const firstBang = giveCard(state, 0, "bang", "hand", 0);
  const secondBang = giveCard(state, 0, "bang", "hand", 1);
  const thirdBang = giveCard(state, 0, "bang", "hand", 2);
  const actorId = willy.public.playerId;

  const first = checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: firstBang,
    targetPlayerId: seatAt(state, 1).public.playerId,
  });
  assert.equal(first.ok, true);
  state.turn.bangCardPlaysThisTurn = 1;

  const second = checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: secondBang,
    targetPlayerId: seatAt(state, 6).public.playerId,
  });
  assert.equal(second.ok, true);
  state.turn.bangCardPlaysThisTurn = 2;

  const third = checkPlayCardLegality(state, {
    actorPlayerId: actorId,
    cardInstanceId: thirdBang,
    targetPlayerId: seatAt(state, 2).public.playerId,
  });
  assertFailure(third, "TARGET_OUT_OF_RANGE");
});

test("R12 limits ordinary BANG! to one unless Volcanic or Willy is present", () => {
  const ordinary = initialState(5);
  const ordinaryBang = giveCard(ordinary, 0, "bang", "hand");
  ordinary.turn.bangCardPlaysThisTurn = 1;
  assertFailure(checkPlayCardLegality(ordinary, {
    actorPlayerId: seatAt(ordinary, 0).public.playerId,
    cardInstanceId: ordinaryBang,
    targetPlayerId: seatAt(ordinary, 1).public.playerId,
  }), "BANG_LIMIT_REACHED");

  const volcanic = initialState(5);
  giveCard(volcanic, 0, "volcanic", "inPlay");
  const volcanicBang = giveCard(volcanic, 0, "bang", "hand");
  volcanic.turn.bangCardPlaysThisTurn = 2;
  assert.equal(checkPlayCardLegality(volcanic, {
    actorPlayerId: seatAt(volcanic, 0).public.playerId,
    cardInstanceId: volcanicBang,
    targetPlayerId: seatAt(volcanic, 1).public.playerId,
  }).ok, true);
});

test("Jail excludes the Sheriff while Duel and Jail may target a distant living player", () => {
  const state = initialState(7);
  seatAt(state, 0).private.roleId = "outlaw";
  seatAt(state, 3).private.roleId = "sheriff";
  seatAt(state, 4).private.roleId = "deputy";
  const jail = giveCard(state, 0, "jail", "hand");
  const duel = giveCard(state, 0, "duel", "hand");
  assertFailure(checkPlayCardLegality(state, {
    actorPlayerId: seatAt(state, 0).public.playerId,
    cardInstanceId: jail,
    targetPlayerId: seatAt(state, 3).public.playerId,
  }), "SHERIFF_CANNOT_BE_JAILED");
  assert.equal(checkPlayCardLegality(state, {
    actorPlayerId: seatAt(state, 0).public.playerId,
    cardInstanceId: jail,
    targetPlayerId: seatAt(state, 4).public.playerId,
  }).ok, true);
  assert.equal(checkPlayCardLegality(state, {
    actorPlayerId: seatAt(state, 0).public.playerId,
    cardInstanceId: duel,
    targetPlayerId: seatAt(state, 3).public.playerId,
  }).ok, true);
});

test("R06 blocks starting a normal card while a resolution or interaction is pending", () => {
  const state = initialState(5);
  const card = giveCard(state, 0, "bang", "hand");
  state.resolution.pendingInteraction = {
    interactionId: "interaction-1",
    kind: "test",
    actorPlayerIds: [seatAt(state, 1).public.playerId],
    options: [],
    context: {},
    resumeFrameId: null,
    createdAt: "2026-09-27T00:00:00.000Z",
  };
  const before = structuredClone(state);

  const result = checkPlayCardLegality(state, {
    actorPlayerId: seatAt(state, 0).public.playerId,
    cardInstanceId: card,
    targetPlayerId: seatAt(state, 1).public.playerId,
  });

  assertFailure(result, "RESOLUTION_PENDING");
  assert.deepEqual(state, before, "legality checks must not mutate state");
});
