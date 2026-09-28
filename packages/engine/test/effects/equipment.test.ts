import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { CardEffectInput, CardEffectResult, EffectEventDraft } from "../../src/effects/api.ts";
import type { GameState, SeatState } from "../../src/state/types.ts";
import { calculateDistance, getEquippedCardTypeIds, getMaxBangRange } from "../../src/rules/distance.ts";
import { checkPlayCardLegality } from "../../src/rules/legality.ts";
import { equipmentEffect } from "../../src/effects/cards/equipment.ts";

function initialState(playerCount = 7): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  state.turn.currentPlayerId = state.seats[0]!.public.playerId;
  state.turn.phase = "play";
  return state;
}

function seatAt(state: GameState, index: number): SeatState {
  const seat = state.seats.find((entry) => entry.public.seatIndex === index);
  assert.ok(seat, `missing seat ${index}`);
  return seat;
}

function seatById(state: GameState, playerId: string): SeatState {
  const seat = state.seats.find((entry) => entry.public.playerId === playerId);
  assert.ok(seat, `missing seat ${playerId}`);
  return seat;
}

function physicalCardId(state: GameState, typeId: string, copy = 0): string {
  const definition = BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId)[copy];
  assert.ok(definition, `missing physical catalog card ${typeId} copy ${copy}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (card) => card.cardDefinitionId === definition.definitionId,
  );
  assert.ok(instance, `missing runtime card ${definition.definitionId}`);
  return instance.cardInstanceId;
}

function moveCardToZone(
  state: GameState,
  cardInstanceId: string,
  zone: "hand" | "in_play" | "discard",
  playerId?: string,
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
  assert.ok(playerId, `${zone} cards need an owner`);
  const seat = seatById(state, playerId);
  if (zone === "hand") seat.private.handCardInstanceIds.push(cardInstanceId);
  else seat.public.inPlayCardInstanceIds.push(cardInstanceId);
}

function makeInput(state: GameState, sourceCardInstanceId: string | null, actorPlayerId = state.turn.currentPlayerId, targets: CardEffectInput["targets"] = []): CardEffectInput {
  return {
    state,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-equipment",
    targets,
    random: { nextFloat: () => { throw new Error("equipment must not consume randomness"); } },
    completedInteractions: [],
  };
}

function appliedEvents(result: CardEffectResult): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, received ${result.kind}`);
  return result.events;
}

/** Applies the event drafts used by equipment tests. */
function applyDrafts(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const draft of events) {
    const cardId = draft.payload.cardInstanceId;
    assert.equal(typeof cardId, "string");
    if (typeof cardId !== "string") throw new Error(`${draft.type} needs a card ID`);

    if (draft.type === "CARD_DISCARDED") {
      assert.equal(draft.payload.fromZone, "in_play");
      const ownerPlayerId = draft.payload.ownerPlayerId;
      assert.equal(typeof ownerPlayerId, "string");
      if (typeof ownerPlayerId !== "string") throw new Error("in-play discard needs an owner");
      const owner = seatById(state, ownerPlayerId);
      const index = owner.public.inPlayCardInstanceIds.indexOf(cardId);
      assert.notEqual(index, -1);
      owner.public.inPlayCardInstanceIds.splice(index, 1);
      state.zones.discardPileCardInstanceIds.push(cardId);
      continue;
    }

    assert.equal(draft.type, "CARD_TRANSFERRED");
    const fromPlayerId = draft.payload.fromPlayerId;
    const toPlayerId = draft.payload.toPlayerId;
    assert.equal(typeof fromPlayerId, "string");
    assert.equal(typeof toPlayerId, "string");
    if (typeof fromPlayerId !== "string" || typeof toPlayerId !== "string") {
      throw new Error("card transfer needs source and target players");
    }
    assert.equal(draft.payload.fromZone, "hand");
    assert.equal(draft.payload.toZone, "in_play");
    const source = seatById(state, fromPlayerId);
    const target = seatById(state, toPlayerId);
    const index = source.private.handCardInstanceIds.indexOf(cardId);
    assert.notEqual(index, -1);
    source.private.handCardInstanceIds.splice(index, 1);
    target.public.inPlayCardInstanceIds.push(cardId);
  }
}

function playEquipment(state: GameState, cardId: string, actorPlayerId: string): readonly EffectEventDraft[] {
  moveCardToZone(state, cardId, "hand", actorPlayerId);
  return appliedEvents(equipmentEffect(makeInput(state, cardId, actorPlayerId)));
}

test("the virtual Colt and each weapon expose their R11 maximum range", () => {
  const cases = [
    { typeId: "volcanic", range: 1 },
    { typeId: "schofield", range: 2 },
    { typeId: "remington", range: 3 },
    { typeId: "carabine", range: 4 },
    { typeId: "winchester", range: 5 },
  ] as const;

  for (const entry of cases) {
    const state = initialState();
    const actorId = seatAt(state, 0).public.playerId;
    assert.equal(getMaxBangRange(state, actorId), 1, "no physical weapon means virtual Colt range 1");
    const weaponId = physicalCardId(state, entry.typeId);
    moveCardToZone(state, weaponId, "hand", actorId);
    const before = structuredClone(state);
    const events = appliedEvents(equipmentEffect(makeInput(state, weaponId, actorId)));
    assert.deepEqual(events.map((draft) => draft.type), ["CARD_TRANSFERRED"]);
    assert.deepEqual(state, before, "equipment module only returns zone event drafts");

    const after = structuredClone(state);
    applyDrafts(after, events);
    assert.equal(getMaxBangRange(after, actorId), entry.range, `${entry.typeId} range`);
    assert.equal(seatById(after, actorId).public.inPlayCardInstanceIds.length, 1);
  }
});

test("playing a different weapon discards the old one before equipping the new one", () => {
  const state = initialState();
  const actorId = seatAt(state, 0).public.playerId;
  const oldWeaponId = physicalCardId(state, "volcanic");
  const newWeaponId = physicalCardId(state, "winchester");
  moveCardToZone(state, oldWeaponId, "in_play", actorId);
  moveCardToZone(state, newWeaponId, "hand", actorId);
  const before = structuredClone(state);

  const events = appliedEvents(equipmentEffect(makeInput(state, newWeaponId, actorId)));
  assert.deepEqual(events.map((draft) => draft.type), ["CARD_DISCARDED", "CARD_TRANSFERRED"]);
  assert.deepEqual(events.map((draft) => draft.payload.cardInstanceId), [oldWeaponId, newWeaponId]);
  assert.deepEqual(state, before);

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.deepEqual(seatById(after, actorId).public.inPlayCardInstanceIds, [newWeaponId]);
  assert.deepEqual(after.zones.discardPileCardInstanceIds.slice(-1), [oldWeaponId]);
  assert.equal(getMaxBangRange(after, actorId), 5);
});

test("Barrel installs without replacing a weapon and rejects a duplicate Barrel", () => {
  const state = initialState();
  const actorId = seatAt(state, 0).public.playerId;
  const weaponId = physicalCardId(state, "volcanic");
  const barrelId = physicalCardId(state, "barrel", 0);
  moveCardToZone(state, weaponId, "in_play", actorId);
  moveCardToZone(state, barrelId, "hand", actorId);
  const before = structuredClone(state);

  const events = appliedEvents(equipmentEffect(makeInput(state, barrelId, actorId)));

  assert.deepEqual(events, [{
    type: "CARD_TRANSFERRED",
    actorPlayerId: actorId,
    payload: {
      sourceCardInstanceId: barrelId,
      cardInstanceId: barrelId,
      fromPlayerId: actorId,
      fromZone: "hand",
      toPlayerId: actorId,
      toZone: "in_play",
    },
  }]);
  assert.deepEqual(state, before, "installing Barrel returns a draft without mutating the input");

  const afterInstall = structuredClone(state);
  applyDrafts(afterInstall, events);
  assert.deepEqual(seatById(afterInstall, actorId).public.inPlayCardInstanceIds, [weaponId, barrelId]);
  assert.deepEqual(getEquippedCardTypeIds(afterInstall, actorId), ["volcanic", "barrel"]);

  const secondBarrelId = physicalCardId(afterInstall, "barrel", 1);
  moveCardToZone(afterInstall, secondBarrelId, "hand", actorId);
  const beforeDuplicate = structuredClone(afterInstall);
  assert.deepEqual(equipmentEffect(makeInput(afterInstall, secondBarrelId, actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(afterInstall, beforeDuplicate, "a duplicate Barrel is rejected without mutation");
});

test("losing Volcanic preserves the turn BANG count and removes its unlimited-use exception", () => {
  const state = initialState(5);
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  actor.public.characterId = "bart_cassidy";
  state.turn.currentPlayerId = actor.public.playerId;
  state.turn.bangCardPlaysThisTurn = 1;
  const volcanicId = physicalCardId(state, "volcanic");
  const replacementId = physicalCardId(state, "schofield");
  const bangId = physicalCardId(state, "bang");
  moveCardToZone(state, volcanicId, "in_play", actor.public.playerId);
  moveCardToZone(state, replacementId, "hand", actor.public.playerId);
  moveCardToZone(state, bangId, "hand", actor.public.playerId);

  const beforeReplacement = checkPlayCardLegality(state, {
    actorPlayerId: actor.public.playerId,
    cardInstanceId: bangId,
    targetPlayerId: target.public.playerId,
  });
  assert.deepEqual(beforeReplacement, { ok: true, cardTypeId: "bang" }, "Volcanic waives the one-BANG limit");

  const events = appliedEvents(equipmentEffect(makeInput(state, replacementId, actor.public.playerId)));
  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.equal(after.turn.bangCardPlaysThisTurn, 1, "weapon replacement must not reset turn usage");
  assert.equal(getMaxBangRange(after, actor.public.playerId), 2);

  const afterReplacement = checkPlayCardLegality(after, {
    actorPlayerId: actor.public.playerId,
    cardInstanceId: bangId,
    targetPlayerId: target.public.playerId,
  });
  assert.equal(afterReplacement.ok, false);
  if (!afterReplacement.ok) assert.equal(afterReplacement.error.code, "BANG_LIMIT_REACHED");
});

test("Mustang, Paul, Scope, and Rose apply direction-specific R10 corrections", () => {
  const state = initialState(7);
  const source = seatAt(state, 0);
  const target = seatAt(state, 3);
  source.public.characterId = "bart_cassidy";
  target.public.characterId = "paul_regret";

  const scopeId = physicalCardId(state, "scope");
  const mustangId = physicalCardId(state, "mustang");
  const scopeEvents = playEquipment(state, scopeId, source.public.playerId);
  applyDrafts(state, scopeEvents);
  const mustangEvents = playEquipment(state, mustangId, target.public.playerId);
  applyDrafts(state, mustangEvents);

  const sourceToTarget = calculateDistance(state, source.public.playerId, target.public.playerId);
  const targetToSource = calculateDistance(state, target.public.playerId, source.public.playerId);
  assert.deepEqual(sourceToTarget, {
    baseDistance: 3,
    targetMustangBonus: 1,
    targetPaulRegretBonus: 1,
    sourceScopeReduction: 1,
    sourceRoseDoolanReduction: 0,
    distance: 4,
  });
  assert.deepEqual(targetToSource, {
    baseDistance: 3,
    targetMustangBonus: 0,
    targetPaulRegretBonus: 0,
    sourceScopeReduction: 0,
    sourceRoseDoolanReduction: 0,
    distance: 3,
  });

  source.public.characterId = "rose_doolan";
  const withRose = calculateDistance(state, source.public.playerId, target.public.playerId);
  assert.equal(withRose?.sourceRoseDoolanReduction, 1);
  assert.equal(withRose?.distance, 3, "Rose stacks with Scope and minimum-distance handling remains in T11");
});

test("the module rejects unsupported, duplicate, and targeted equipment plays", () => {
  const state = initialState();
  const actorId = seatAt(state, 0).public.playerId;
  const otherId = seatAt(state, 1).public.playerId;
  const actor = seatById(state, actorId);
  const firstMustang = physicalCardId(state, "mustang", 0);
  const secondMustang = physicalCardId(state, "mustang", 1);
  const jailId = physicalCardId(state, "jail");
  const barrelId = physicalCardId(state, "barrel", 0);
  const otherHandBarrelId = physicalCardId(state, "barrel", 1);
  moveCardToZone(state, firstMustang, "in_play", actorId);
  moveCardToZone(state, secondMustang, "hand", actorId);
  moveCardToZone(state, jailId, "hand", actorId);
  moveCardToZone(state, barrelId, "hand", actorId);
  moveCardToZone(state, otherHandBarrelId, "hand", otherId);

  assert.deepEqual(equipmentEffect(makeInput(state, secondMustang, actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(equipmentEffect(makeInput(state, jailId, actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(equipmentEffect(makeInput(state, secondMustang, actorId, [{ kind: "player", playerId: actorId }])), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(equipmentEffect(makeInput(state, barrelId, actorId, [{ kind: "player", playerId: otherId }])), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(equipmentEffect(makeInput(state, otherHandBarrelId, actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  }, "the source must be in the actor's hand");
  actor.public.eliminated = true;
  assert.deepEqual(equipmentEffect(makeInput(state, physicalCardId(state, "scope"), actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALIVE",
  });
  actor.public.eliminated = false;
  actor.public.hp = 0;
  assert.deepEqual(equipmentEffect(makeInput(state, physicalCardId(state, "scope"), actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALIVE",
  });
  actor.public.hp = 4;
  state.seats.push(structuredClone(actor));
  assert.deepEqual(equipmentEffect(makeInput(state, physicalCardId(state, "scope"), actorId)), {
    kind: "invalid_target", code: "TARGET_NOT_FOUND",
  });
});
