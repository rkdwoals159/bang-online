import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { CardEffectInput, CardEffectResult, EffectEventDraft, EffectTarget } from "../../src/effects/api.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import type { GameState, SeatState } from "../../src/state/types.ts";
import { catBalouEffect, panicEffect } from "../../src/effects/cards/steal-discard.ts";

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

function moveCardToZone(
  state: GameState,
  cardInstanceId: string,
  playerId: string | null,
  zone: "hand" | "in_play" | "discard",
): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);

  if (zone === "discard") {
    state.zones.discardPileCardInstanceIds.push(cardInstanceId);
    return;
  }

  assert.ok(playerId, "hand and in-play cards need an owner");
  const owner = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(owner, `missing player ${playerId}`);
  if (zone === "hand") owner.private.handCardInstanceIds.push(cardInstanceId);
  else owner.public.inPlayCardInstanceIds.push(cardInstanceId);
}

function clearHand(state: GameState, playerId: string): void {
  const owner = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(owner, `missing player ${playerId}`);
  for (const cardInstanceId of [...owner.private.handCardInstanceIds]) {
    moveCardToZone(state, cardInstanceId, null, "discard");
  }
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

function prepareSource(state: GameState, typeId: "panic" | "cat_balou", copy = 0): string {
  const cardInstanceId = physicalCardId(state, typeId, copy);
  moveCardToZone(state, cardInstanceId, null, "discard");
  return cardInstanceId;
}

function makeInput(
  state: GameState,
  targets: readonly EffectTarget[],
  sourceCardInstanceId: string | null,
  random: RandomSource = fixedRandom(),
  actorPlayerId = seatAt(state, 0).public.playerId,
): CardEffectInput {
  return {
    state,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-steal-discard",
    targets,
    random,
    completedInteractions: [],
  };
}

function firstEvent(result: CardEffectResult): EffectEventDraft {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, received ${result.kind}`);
  assert.equal(result.events.length, 1);
  return result.events[0]!;
}

function applyMovementDraft(state: GameState, event: EffectEventDraft): void {
  const payload = event.payload;
  const cardInstanceId = payload.cardInstanceId;
  assert.equal(typeof cardInstanceId, "string");
  if (typeof cardInstanceId !== "string") throw new Error("movement draft is missing cardInstanceId");

  if (event.type === "CARD_TRANSFERRED") {
    const fromPlayerId = payload.fromPlayerId;
    const fromZone = payload.fromZone;
    const toPlayerId = payload.toPlayerId;
    assert.equal(typeof fromPlayerId, "string");
    assert.equal(typeof toPlayerId, "string");
    assert.ok(fromZone === "hand" || fromZone === "in_play");
    const source = state.seats.find((seat) => seat.public.playerId === fromPlayerId);
    const destination = state.seats.find((seat) => seat.public.playerId === toPlayerId);
    assert.ok(source);
    assert.ok(destination);
    const from = fromZone === "hand" ? source.private.handCardInstanceIds : source.public.inPlayCardInstanceIds;
    const index = from.indexOf(cardInstanceId);
    assert.notEqual(index, -1, "the draft must name a card owned in its declared source zone");
    from.splice(index, 1);
    destination.private.handCardInstanceIds.push(cardInstanceId);
    return;
  }

  assert.equal(event.type, "CARD_DISCARDED");
  const ownerPlayerId = payload.ownerPlayerId;
  const fromZone = payload.fromZone;
  assert.equal(typeof ownerPlayerId, "string");
  assert.ok(fromZone === "hand" || fromZone === "in_play");
  const owner = state.seats.find((seat) => seat.public.playerId === ownerPlayerId);
  assert.ok(owner);
  const from = fromZone === "hand" ? owner.private.handCardInstanceIds : owner.public.inPlayCardInstanceIds;
  const index = from.indexOf(cardInstanceId);
  assert.notEqual(index, -1, "the draft must name a card owned in its declared source zone");
  from.splice(index, 1);
  state.zones.discardPileCardInstanceIds.push(cardInstanceId);
}

test("missing, ambiguous, or incomplete target zones are distinguished", () => {
  const state = initialState();
  const panicId = prepareSource(state, "panic");
  const missing = panicEffect(makeInput(state, [], panicId));
  const incomplete = panicEffect(makeInput(state, [{ kind: "player", playerId: seatAt(state, 1).public.playerId }], panicId));
  const ambiguous = catBalouEffect(makeInput(state, [
    { kind: "hand", playerId: seatAt(state, 1).public.playerId },
    { kind: "hand", playerId: seatAt(state, 2).public.playerId },
  ], prepareSource(state, "cat_balou")));

  assert.deepEqual(missing, { kind: "target_required" });
  assert.deepEqual(incomplete, { kind: "invalid_target", code: "TARGET_ZONE_REQUIRED" });
  assert.deepEqual(ambiguous, { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });
});

test("Panic! randomly drafts one adjacent opponent hand card transfer without mutating state", () => {
  const state = initialState(5);
  const actorId = seatAt(state, 0).public.playerId;
  const targetId = seatAt(state, 1).public.playerId;
  const sourceCardInstanceId = prepareSource(state, "panic");
  const firstId = physicalCardId(state, "bang");
  const secondId = physicalCardId(state, "missed");
  clearHand(state, targetId);
  moveCardToZone(state, firstId, targetId, "hand");
  moveCardToZone(state, secondId, targetId, "hand");
  const before = structuredClone(state);
  let calls = 0;
  const random: RandomSource = { nextFloat: () => { calls += 1; return 0.99; } };

  const result = panicEffect(makeInput(state, [{ kind: "hand", playerId: targetId }], sourceCardInstanceId, random, actorId));
  const event = firstEvent(result);

  assert.equal(calls, 1);
  assert.deepEqual(event, {
    type: "CARD_TRANSFERRED",
    actorPlayerId: actorId,
    payload: {
      sourceCardInstanceId,
      cardInstanceId: secondId,
      fromPlayerId: targetId,
      fromZone: "hand",
      toPlayerId: actorId,
      toZone: "hand",
    },
  });
  assert.deepEqual(state, before, "the card module returns a move draft and leaves the snapshot unchanged");

  const afterApplyingDraft = structuredClone(state);
  applyMovementDraft(afterApplyingDraft, event);
  assert.ok(seatAt(afterApplyingDraft, 0).private.handCardInstanceIds.includes(secondId));
  assert.ok(!seatAt(afterApplyingDraft, 1).private.handCardInstanceIds.includes(secondId));
});

test("Cat Balou discards a random hand card at any distance", () => {
  const state = initialState(7);
  const actorId = seatAt(state, 0).public.playerId;
  const targetId = seatAt(state, 3).public.playerId;
  const sourceCardInstanceId = prepareSource(state, "cat_balou");
  const firstId = physicalCardId(state, "bang", 1);
  const chosenId = physicalCardId(state, "beer");
  clearHand(state, targetId);
  moveCardToZone(state, firstId, targetId, "hand");
  moveCardToZone(state, chosenId, targetId, "hand");
  const before = structuredClone(state);

  const result = catBalouEffect(makeInput(
    state,
    [{ kind: "hand", playerId: targetId }],
    sourceCardInstanceId,
    fixedRandom([0.75]),
    actorId,
  ));
  const event = firstEvent(result);

  assert.equal(event.type, "CARD_DISCARDED");
  assert.deepEqual(event.payload, {
    sourceCardInstanceId,
    cardInstanceId: chosenId,
    ownerPlayerId: targetId,
    fromZone: "hand",
    toZone: "discard",
  });
  assert.deepEqual(state, before);
  const afterApplyingDraft = structuredClone(state);
  applyMovementDraft(afterApplyingDraft, event);
  assert.ok(afterApplyingDraft.zones.discardPileCardInstanceIds.includes(chosenId));
  assert.ok(!seatAt(afterApplyingDraft, 3).private.handCardInstanceIds.includes(chosenId));
});

test("a selected public physical card is the only card moved, without consuming randomness", () => {
  const state = initialState(7);
  const actorId = seatAt(state, 0).public.playerId;
  const targetId = seatAt(state, 3).public.playerId;
  const sourceCardInstanceId = prepareSource(state, "cat_balou");
  const mustangId = physicalCardId(state, "mustang");
  const barrelId = physicalCardId(state, "barrel");
  moveCardToZone(state, mustangId, targetId, "in_play");
  moveCardToZone(state, barrelId, targetId, "in_play");
  const before = structuredClone(state);

  const result = catBalouEffect(makeInput(
    state,
    [{ kind: "in_play_card", playerId: targetId, cardInstanceId: mustangId }],
    sourceCardInstanceId,
    unusedRandom(),
    actorId,
  ));
  const event = firstEvent(result);

  assert.equal(event.type, "CARD_DISCARDED");
  assert.deepEqual(event.payload, {
    sourceCardInstanceId,
    cardInstanceId: mustangId,
    ownerPlayerId: targetId,
    fromZone: "in_play",
    toZone: "discard",
  });
  assert.deepEqual(state, before);
  const afterApplyingDraft = structuredClone(state);
  applyMovementDraft(afterApplyingDraft, event);
  assert.ok(!seatAt(afterApplyingDraft, 3).public.inPlayCardInstanceIds.includes(mustangId));
  assert.ok(seatAt(afterApplyingDraft, 3).public.inPlayCardInstanceIds.includes(barrelId));
  assert.ok(afterApplyingDraft.zones.discardPileCardInstanceIds.includes(mustangId));
});

test("Panic! moves a selected public card into hand and enforces its adjacency rule", () => {
  const adjacent = initialState(5);
  const actorId = seatAt(adjacent, 0).public.playerId;
  const targetId = seatAt(adjacent, 1).public.playerId;
  const sourceCardInstanceId = prepareSource(adjacent, "panic");
  const selectedId = physicalCardId(adjacent, "barrel");
  moveCardToZone(adjacent, selectedId, targetId, "in_play");

  const result = panicEffect(makeInput(
    adjacent,
    [{ kind: "in_play_card", playerId: targetId, cardInstanceId: selectedId }],
    sourceCardInstanceId,
    unusedRandom(),
    actorId,
  ));
  const event = firstEvent(result);
  assert.equal(event.type, "CARD_TRANSFERRED");
  assert.deepEqual(event.payload, {
    sourceCardInstanceId,
    cardInstanceId: selectedId,
    fromPlayerId: targetId,
    fromZone: "in_play",
    toPlayerId: actorId,
    toZone: "hand",
  });

  const distant = initialState(7);
  const distantSource = prepareSource(distant, "panic");
  const distantTargetId = seatAt(distant, 2).public.playerId;
  const distantCardId = physicalCardId(distant, "mustang");
  moveCardToZone(distant, distantCardId, distantTargetId, "in_play");
  assert.deepEqual(
    panicEffect(makeInput(distant, [{ kind: "in_play_card", playerId: distantTargetId, cardInstanceId: distantCardId }], distantSource)),
    { kind: "invalid_target", code: "TARGET_OUT_OF_RANGE" },
  );
});

test("D03 permits either effect on own public equipment and rejects own hand", () => {
  const state = initialState(5);
  const actorId = seatAt(state, 0).public.playerId;
  const equipmentId = physicalCardId(state, "mustang");
  const handId = physicalCardId(state, "beer");
  moveCardToZone(state, equipmentId, actorId, "in_play");
  moveCardToZone(state, handId, actorId, "hand");
  const panicId = prepareSource(state, "panic");
  const catId = prepareSource(state, "cat_balou");

  const panicOwnEquipment = panicEffect(makeInput(
    state,
    [{ kind: "in_play_card", playerId: actorId, cardInstanceId: equipmentId }],
    panicId,
    unusedRandom(),
    actorId,
  ));
  const catOwnEquipment = catBalouEffect(makeInput(
    state,
    [{ kind: "in_play_card", playerId: actorId, cardInstanceId: equipmentId }],
    catId,
    unusedRandom(),
    actorId,
  ));

  assert.equal(firstEvent(panicOwnEquipment).type, "CARD_TRANSFERRED");
  assert.equal(firstEvent(catOwnEquipment).type, "CARD_DISCARDED");
  assert.deepEqual(
    panicEffect(makeInput(state, [{ kind: "hand", playerId: actorId }], panicId, unusedRandom(), actorId)),
    { kind: "invalid_target", code: "TARGET_IS_SELF" },
  );
  assert.deepEqual(
    catBalouEffect(makeInput(state, [{ kind: "hand", playerId: actorId }], catId, unusedRandom(), actorId)),
    { kind: "invalid_target", code: "TARGET_IS_SELF" },
  );
  assert.ok(seatAt(state, 0).private.handCardInstanceIds.includes(handId));
});

test("dead, missing, empty, and nonphysical targets are rejected", () => {
  const state = initialState(5);
  const actorId = seatAt(state, 0).public.playerId;
  const sourceCardInstanceId = prepareSource(state, "cat_balou");
  const deadId = seatAt(state, 1).public.playerId;
  seatAt(state, 1).public.eliminated = true;
  assert.deepEqual(
    catBalouEffect(makeInput(state, [{ kind: "hand", playerId: deadId }], sourceCardInstanceId)),
    { kind: "invalid_target", code: "TARGET_NOT_ALIVE" },
  );
  assert.deepEqual(
    catBalouEffect(makeInput(state, [{ kind: "hand", playerId: "missing-player" }], sourceCardInstanceId)),
    { kind: "invalid_target", code: "TARGET_NOT_FOUND" },
  );
  const emptyTargetId = seatAt(state, 2).public.playerId;
  clearHand(state, emptyTargetId);
  assert.deepEqual(
    catBalouEffect(makeInput(state, [{ kind: "hand", playerId: emptyTargetId }], sourceCardInstanceId)),
    { kind: "invalid_target", code: "TARGET_HAS_NO_CARDS" },
  );

  const actorSeat = seatAt(state, 0);
  const opponentId = seatAt(state, 2).public.playerId;
  actorSeat.public.inPlayCardInstanceIds.push("virtual_colt_45");
  const virtualColt = catBalouEffect(makeInput(
    state,
    [{ kind: "in_play_card", playerId: actorId, cardInstanceId: "virtual_colt_45" }],
    sourceCardInstanceId,
  ));
  assert.deepEqual(virtualColt, { kind: "invalid_target", code: "TARGET_CARD_NOT_IN_PLAY" });

  const hiddenHandId = physicalCardId(state, "missed");
  moveCardToZone(state, hiddenHandId, opponentId, "hand");
  const hiddenAsPublic = catBalouEffect(makeInput(
    state,
    [{ kind: "in_play_card", playerId: opponentId, cardInstanceId: hiddenHandId }],
    sourceCardInstanceId,
  ));
  assert.deepEqual(hiddenAsPublic, { kind: "invalid_target", code: "TARGET_CARD_NOT_IN_PLAY" });
});

test("wrong physical source is rejected and random selection is deterministic", () => {
  const state = initialState(5);
  const actorId = seatAt(state, 0).public.playerId;
  const targetId = seatAt(state, 1).public.playerId;
  const catId = prepareSource(state, "cat_balou");
  const wrongSource = panicEffect(makeInput(state, [{ kind: "hand", playerId: targetId }], catId));
  assert.deepEqual(wrongSource, { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });

  const panicId = prepareSource(state, "panic");
  const firstId = physicalCardId(state, "bang");
  const secondId = physicalCardId(state, "missed");
  clearHand(state, targetId);
  moveCardToZone(state, firstId, targetId, "hand");
  moveCardToZone(state, secondId, targetId, "hand");
  const input = [{ kind: "hand", playerId: targetId }] as const;
  const first = panicEffect(makeInput(state, input, panicId, fixedRandom([0.6]), actorId));
  const second = panicEffect(makeInput(state, input, panicId, fixedRandom([0.6]), actorId));
  assert.deepEqual(second, first, "the same snapshot and injected RNG sample must replay the same choice");
  assert.equal(firstEvent(first).payload.cardInstanceId, secondId);
});
