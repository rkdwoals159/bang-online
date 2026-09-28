import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { CardEffectInput, CardEffectResult, CompletedEffectInteraction, EffectEventDraft, EffectTarget } from "../../src/effects/api.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import type { GameState, SeatState } from "../../src/state/types.ts";
import { jailEffect, resolveJailAtTurnStart } from "../../src/effects/cards/jail.ts";

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

function initialState(playerCount = 4): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seatById(state: GameState, playerId: string): SeatState {
  const seat = state.seats.find((entry) => entry.public.playerId === playerId);
  assert.ok(seat, `missing seat ${playerId}`);
  return seat;
}

function seatAt(state: GameState, index: number): SeatState {
  const seat = state.seats.find((entry) => entry.public.seatIndex === index);
  assert.ok(seat, `missing seat ${index}`);
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
  zone: "hand" | "in_play" | "discard" | "draw_pile" | "revealed_pool",
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
  } else if (zone === "draw_pile") {
    state.zones.drawPileCardInstanceIds.unshift(cardInstanceId);
  } else if (zone === "revealed_pool") {
    state.zones.revealedPoolCardInstanceIds.push(cardInstanceId);
  } else {
    assert.ok(playerId, `${zone} cards need an owner`);
    const seat = seatById(state, playerId);
    if (zone === "hand") seat.private.handCardInstanceIds.push(cardInstanceId);
    else seat.public.inPlayCardInstanceIds.push(cardInstanceId);
  }
}

function nonSheriff(state: GameState, exceptPlayerId?: string): SeatState {
  const seat = state.seats.find((entry) =>
    entry.private.roleId !== "sheriff" && entry.public.playerId !== exceptPlayerId,
  );
  assert.ok(seat, "fixture needs a non-Sheriff seat");
  return seat;
}

function makeInput(
  state: GameState,
  sourceCardInstanceId: string | null,
  targets: readonly EffectTarget[] = [],
  actorPlayerId = state.turn.currentPlayerId,
  random: RandomSource = unusedRandom(),
  completedInteractions: readonly CompletedEffectInteraction[] = [],
): CardEffectInput {
  return {
    state,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-jail",
    targets,
    random,
    completedInteractions,
  };
}

function appliedEvents(result: CardEffectResult): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, received ${result.kind}`);
  return result.events;
}

/** Applies the event shapes used by Jail tests to verify card-zone order. */
function applyDrafts(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const draft of events) {
    const payload = draft.payload;
    if (draft.type === "DRAW_PILE_RESHUFFLED") {
      const cardIds = payload.cardInstanceIds;
      assert.ok(Array.isArray(cardIds) && cardIds.every((id) => typeof id === "string"));
      state.zones.drawPileCardInstanceIds = [...cardIds] as string[];
      state.zones.discardPileCardInstanceIds = [];
      continue;
    }
    if (draft.type === "JAIL_JUDGMENT_REVEALED") {
      const cardId = payload.judgmentCardInstanceId;
      assert.equal(typeof cardId, "string");
      if (typeof cardId !== "string") throw new Error("judgment reveal needs a card ID");
      assert.equal(state.zones.drawPileCardInstanceIds[0], cardId);
      state.zones.drawPileCardInstanceIds.shift();
      state.zones.revealedPoolCardInstanceIds.push(cardId);
      continue;
    }
    if (draft.type === "CARD_TRANSFERRED") {
      const cardId = payload.cardInstanceId;
      const fromZone = payload.fromZone;
      const toZone = payload.toZone;
      const fromPlayerId = payload.fromPlayerId;
      const toPlayerId = payload.toPlayerId;
      assert.equal(typeof cardId, "string");
      assert.ok(typeof fromZone === "string");
      assert.ok(typeof toZone === "string");
      if (typeof cardId !== "string" || typeof fromZone !== "string" || typeof toZone !== "string") {
        throw new Error("card transfer needs a card ID and zones");
      }
      if (fromZone === "hand") {
        assert.equal(typeof fromPlayerId, "string");
        const source = seatById(state, fromPlayerId as string);
        const index = source.private.handCardInstanceIds.indexOf(cardId);
        assert.notEqual(index, -1);
        source.private.handCardInstanceIds.splice(index, 1);
      } else if (fromZone === "in_play") {
        assert.equal(typeof fromPlayerId, "string");
        const source = seatById(state, fromPlayerId as string);
        const index = source.public.inPlayCardInstanceIds.indexOf(cardId);
        assert.notEqual(index, -1);
        source.public.inPlayCardInstanceIds.splice(index, 1);
      } else {
        const from = fromZone === "draw_pile" ? state.zones.drawPileCardInstanceIds
          : fromZone === "discard" ? state.zones.discardPileCardInstanceIds
            : fromZone === "revealed_pool" ? state.zones.revealedPoolCardInstanceIds : undefined;
        assert.ok(from, `unsupported transfer source '${fromZone}'`);
        const index = from.indexOf(cardId);
        assert.notEqual(index, -1);
        from.splice(index, 1);
      }

      if (toZone === "hand") {
        assert.equal(typeof toPlayerId, "string");
        seatById(state, toPlayerId as string).private.handCardInstanceIds.push(cardId);
      } else if (toZone === "in_play") {
        assert.equal(typeof toPlayerId, "string");
        seatById(state, toPlayerId as string).public.inPlayCardInstanceIds.push(cardId);
      } else {
        const to = toZone === "draw_pile" ? state.zones.drawPileCardInstanceIds
          : toZone === "discard" ? state.zones.discardPileCardInstanceIds
            : toZone === "revealed_pool" ? state.zones.revealedPoolCardInstanceIds : undefined;
        assert.ok(to, `unsupported transfer destination '${toZone}'`);
        if (toZone === "draw_pile") to.unshift(cardId);
        else to.push(cardId);
      }
      continue;
    }
    if (draft.type === "CARD_DISCARDED") {
      const cardId = payload.cardInstanceId;
      assert.equal(typeof cardId, "string");
      if (typeof cardId !== "string") throw new Error("discard needs a card ID");
      if (payload.fromZone === "revealed_pool") {
        const index = state.zones.revealedPoolCardInstanceIds.indexOf(cardId);
        assert.notEqual(index, -1);
        state.zones.revealedPoolCardInstanceIds.splice(index, 1);
      } else {
        assert.equal(payload.fromZone, "in_play");
        const ownerPlayerId = payload.ownerPlayerId;
        assert.equal(typeof ownerPlayerId, "string");
        if (typeof ownerPlayerId !== "string") throw new Error("in-play discard needs an owner");
        const owner = seatById(state, ownerPlayerId);
        const index = owner.public.inPlayCardInstanceIds.indexOf(cardId);
        assert.notEqual(index, -1);
        owner.public.inPlayCardInstanceIds.splice(index, 1);
      }
      state.zones.discardPileCardInstanceIds.push(cardId);
      continue;
    }
    if (draft.type === "RULE_RESOURCE_EXHAUSTED") {
      state.status = "paused";
      state.pauseReason = "RULE_RESOURCE_EXHAUSTED";
      continue;
    }
    assert.ok(draft.type === "JAIL_JUDGMENT_RESOLVED", `unexpected event '${draft.type}'`);
  }
}

function assertZoneInvariant(state: GameState): void {
  const ids = [
    ...state.seats.flatMap((seat) => [...seat.private.handCardInstanceIds, ...seat.public.inPlayCardInstanceIds]),
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
  ];
  assert.equal(ids.length, 80);
  assert.equal(new Set(ids).size, 80);
  assert.deepEqual(new Set(ids), new Set(Object.keys(state.zones.cardsByInstanceId)));
}

function installJailOnCurrentTurnPlayer(state: GameState): string {
  const owner = nonSheriff(state);
  state.turn.currentPlayerId = owner.public.playerId;
  state.turn.phase = "start";
  const jailId = physicalCardId(state, "jail");
  moveCardToZone(state, jailId, "in_play", owner.public.playerId);
  return jailId;
}

test("Jail may be installed on a distant living non-Sheriff and drafts the correct zone transfer", () => {
  const state = initialState(7);
  const sheriff = state.seats.find((seat) => seat.private.roleId === "sheriff");
  assert.ok(sheriff);
  const actor = seatAt(state, 0);
  const target = [...state.seats]
    .filter((seat) => seat.private.roleId !== "sheriff" && seat.public.playerId !== actor.public.playerId)
    .sort((left, right) => {
      const ringSize = state.seats.length;
      const leftDelta = Math.abs(left.public.seatIndex - actor.public.seatIndex);
      const rightDelta = Math.abs(right.public.seatIndex - actor.public.seatIndex);
      return Math.min(rightDelta, ringSize - rightDelta) - Math.min(leftDelta, ringSize - leftDelta);
    })[0];
  assert.ok(target);
  const seatDelta = Math.abs(target.public.seatIndex - actor.public.seatIndex);
  assert.ok(Math.min(seatDelta, state.seats.length - seatDelta) > 1, "the target is outside adjacent seats");
  const jailId = physicalCardId(state, "jail");
  moveCardToZone(state, jailId, "hand", actor.public.playerId);
  const before = structuredClone(state);

  const result = jailEffect(makeInput(state, jailId, [{ kind: "player", playerId: target.public.playerId }], actor.public.playerId));
  const events = appliedEvents(result);
  assert.deepEqual(events, [{
    type: "CARD_TRANSFERRED",
    actorPlayerId: actor.public.playerId,
    payload: {
      sourceCardInstanceId: jailId,
      cardInstanceId: jailId,
      fromPlayerId: actor.public.playerId,
      fromZone: "hand",
      toPlayerId: target.public.playerId,
      toZone: "in_play",
    },
  }]);
  assert.deepEqual(state, before, "the module emits a draft without mutating state");

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.ok(!seatById(after, actor.public.playerId).private.handCardInstanceIds.includes(jailId));
  assert.ok(seatById(after, target.public.playerId).public.inPlayCardInstanceIds.includes(jailId));
});

test("Jail installation rejects missing, self, Sheriff, and eliminated targets", () => {
  const state = initialState(5);
  const actor = state.seats.find((seat) => seat.private.roleId !== "sheriff")!;
  const sheriff = state.seats.find((seat) => seat.private.roleId === "sheriff")!;
  const other = state.seats.find((seat) => seat.public.playerId !== actor.public.playerId && seat.public.playerId !== sheriff.public.playerId)!;
  const jailId = physicalCardId(state, "jail");
  moveCardToZone(state, jailId, "hand", actor.public.playerId);

  assert.deepEqual(jailEffect(makeInput(state, jailId, [], actor.public.playerId)), { kind: "target_required" });
  assert.deepEqual(jailEffect(makeInput(state, jailId, [{ kind: "player", playerId: actor.public.playerId }], actor.public.playerId)), {
    kind: "invalid_target", code: "TARGET_IS_SELF",
  });
  assert.deepEqual(jailEffect(makeInput(state, jailId, [{ kind: "player", playerId: sheriff.public.playerId }], actor.public.playerId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  const existingJailId = physicalCardId(state, "jail", 1);
  moveCardToZone(state, existingJailId, "in_play", other.public.playerId);
  assert.deepEqual(jailEffect(makeInput(state, jailId, [{ kind: "player", playerId: other.public.playerId }], actor.public.playerId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  other.public.eliminated = true;
  assert.deepEqual(jailEffect(makeInput(state, jailId, [{ kind: "player", playerId: other.public.playerId }], actor.public.playerId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALIVE",
  });
});

for (const judgment of [
  { label: "Heart", typeId: "beer", copy: 0, expectedSkip: false },
  { label: "non-Heart", typeId: "missed", copy: 5, expectedSkip: true },
] as const) {
  test(`Jail ${judgment.label} judgment always discards Jail after the judgment card`, () => {
    const state = initialState();
    const jailId = installJailOnCurrentTurnPlayer(state);
    const ownerId = state.turn.currentPlayerId;
    const judgmentId = physicalCardId(state, judgment.typeId, judgment.copy);
    moveCardToZone(state, judgmentId, "draw_pile");
    const before = structuredClone(state);

    const result = resolveJailAtTurnStart(makeInput(state, jailId, [], ownerId));
    const events = appliedEvents(result);
    assert.deepEqual(events.map((draft) => draft.type), [
      "JAIL_JUDGMENT_REVEALED",
      "CARD_DISCARDED",
      "CARD_DISCARDED",
      "JAIL_JUDGMENT_RESOLVED",
    ]);
    assert.equal(events[0]?.payload.judgmentCardInstanceId, judgmentId);
    assert.equal(events[1]?.payload.cardInstanceId, judgmentId);
    assert.equal(events[2]?.payload.cardInstanceId, jailId);
    assert.equal(events[3]?.payload.turnSkipped, judgment.expectedSkip);
    assert.deepEqual(state, before, "judgment must not mutate the input state");

    const after = structuredClone(state);
    applyDrafts(after, events);
    assert.deepEqual(after.zones.discardPileCardInstanceIds.slice(-2), [judgmentId, jailId]);
    assert.equal(seatById(after, ownerId).public.inPlayCardInstanceIds.includes(jailId), false);
    assert.deepEqual(after.zones.revealedPoolCardInstanceIds, []);
  });
}

test("Jail uses R08 discard recycling before a judgment and keeps Jail on top", () => {
  const state = initialState();
  const jailId = installJailOnCurrentTurnPlayer(state);
  const ownerId = state.turn.currentPlayerId;
  state.zones.drawPileCardInstanceIds = [];
  const heartId = physicalCardId(state, "beer", 0);
  const otherId = physicalCardId(state, "missed", 0);
  moveCardToZone(state, heartId, "discard");
  moveCardToZone(state, otherId, "discard");
  const before = structuredClone(state);

  const result = resolveJailAtTurnStart(makeInput(state, jailId, [], ownerId, fixedRandom([0])));
  const events = appliedEvents(result);
  assert.equal(events[0]?.type, "DRAW_PILE_RESHUFFLED");
  assert.equal(events[1]?.type, "JAIL_JUDGMENT_REVEALED");
  assert.deepEqual(state, before);
  const shuffledIds = events[0]?.payload.cardInstanceIds;
  assert.ok(Array.isArray(shuffledIds));
  assert.equal(events[1]?.payload.judgmentCardInstanceId, shuffledIds[0]);

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.deepEqual(after.zones.discardPileCardInstanceIds.slice(-2), [shuffledIds[0], jailId]);
});

test("Lucky Jail exposes only two candidates, saves their chosen order, and discards Jail last", () => {
  const state = initialState();
  const jailId = installJailOnCurrentTurnPlayer(state);
  const owner = seatById(state, state.turn.currentPlayerId);
  owner.public.characterId = "lucky_duke";
  for (const seat of state.seats) if (seat.public.playerId !== owner.public.playerId && seat.public.characterId === "lucky_duke") {
    seat.public.characterId = "bart_cassidy";
  }
  const candidateIds = state.zones.drawPileCardInstanceIds.slice(0, 2);
  const before = structuredClone(state);

  const opened = resolveJailAtTurnStart(makeInput(state, jailId, [], owner.public.playerId));
  assert.equal(opened.kind, "choice_required");
  if (opened.kind !== "choice_required") return;
  assert.equal(opened.request.kind, "LUCKY_DRAW");
  assert.equal(opened.request.responders[0]?.playerId, owner.public.playerId);
  assert.equal(opened.request.responders[0]?.options.length, 4);
  assert.deepEqual(state, before, "the pending request does not mutate its input");

  const selectedCardInstanceId = candidateIds[1]!;
  const orderedCardInstanceIds = [candidateIds[1]!, candidateIds[0]!];
  const option = opened.request.responders[0]!.options.find((candidate) =>
    candidate.payload.selectedCardInstanceId === selectedCardInstanceId &&
    JSON.stringify(candidate.payload.orderedCardInstanceIds) === JSON.stringify(orderedCardInstanceIds),
  );
  assert.ok(option, "Lucky can choose the result card and the separate discard order");

  const revealed = structuredClone(state);
  applyDrafts(revealed, opened.events);
  assert.deepEqual(revealed.zones.revealedPoolCardInstanceIds, candidateIds);
  assertZoneInvariant(revealed);
  const interaction: CompletedEffectInteraction = {
    interactionId: "lucky-jail-choice",
    kind: opened.request.kind,
    context: opened.request.context,
    responses: [{ playerId: owner.public.playerId, choice: option.choice, payload: option.payload }],
  };
  const resumedBefore = structuredClone(revealed);
  const resumed = resolveJailAtTurnStart(makeInput(revealed, jailId, [], owner.public.playerId, unusedRandom(), [interaction]));
  const events = appliedEvents(resumed);
  assert.deepEqual(revealed, resumedBefore, "resuming the saved choice does not mutate its input");
  assert.equal(events.find((draft) => draft.type === "JAIL_JUDGMENT_RESOLVED")?.payload.judgmentCardInstanceId, selectedCardInstanceId);
  assert.deepEqual(events.filter((draft) => draft.type === "CARD_DISCARDED").map((draft) => draft.payload.cardInstanceId), [
    ...orderedCardInstanceIds,
    jailId,
  ]);

  const completed = structuredClone(revealed);
  applyDrafts(completed, events);
  assert.equal(completed.zones.discardPileCardInstanceIds.at(-1), jailId);
  assert.deepEqual(completed.zones.revealedPoolCardInstanceIds, []);
  assertZoneInvariant(completed);
});

test("Lucky Jail pauses on partial D05 supply without exposing or moving one remaining card", () => {
  const state = initialState();
  const jailId = installJailOnCurrentTurnPlayer(state);
  const owner = seatById(state, state.turn.currentPlayerId);
  owner.public.characterId = "lucky_duke";
  for (const seat of state.seats) if (seat.public.playerId !== owner.public.playerId && seat.public.characterId === "lucky_duke") {
    seat.public.characterId = "bart_cassidy";
  }
  const candidateId = state.zones.drawPileCardInstanceIds[0]!;
  const remaining = state.zones.drawPileCardInstanceIds.slice(1);
  state.zones.drawPileCardInstanceIds = [candidateId];
  owner.private.handCardInstanceIds.push(...remaining);
  const before = structuredClone(state);

  const result = resolveJailAtTurnStart(makeInput(state, jailId, [], owner.public.playerId));
  const events = appliedEvents(result);
  assert.deepEqual(events.map((draft) => draft.type), ["RULE_RESOURCE_EXHAUSTED"]);
  assert.equal(events[0]?.payload.requestedCount, 2);
  assert.equal(events[0]?.payload.fulfilledCount, 1);
  assert.deepEqual(state, before);
  assertZoneInvariant(state);
});

test("Lucky Jail gets the deterministic R08 discard reshuffle before its two candidate choice", () => {
  const state = initialState();
  const jailId = installJailOnCurrentTurnPlayer(state);
  const owner = seatById(state, state.turn.currentPlayerId);
  owner.public.characterId = "lucky_duke";
  for (const seat of state.seats) if (seat.public.playerId !== owner.public.playerId && seat.public.characterId === "lucky_duke") {
    seat.public.characterId = "bart_cassidy";
  }
  const [firstDiscard, secondDiscard, ...otherDrawCards] = state.zones.drawPileCardInstanceIds;
  assert.ok(firstDiscard && secondDiscard);
  state.zones.drawPileCardInstanceIds = [];
  state.zones.discardPileCardInstanceIds = [firstDiscard, secondDiscard];
  owner.private.handCardInstanceIds.push(...otherDrawCards);
  const before = structuredClone(state);
  const first = resolveJailAtTurnStart(makeInput(state, jailId, [], owner.public.playerId, fixedRandom([0.25])));
  const replay = resolveJailAtTurnStart(makeInput(structuredClone(state), jailId, [], owner.public.playerId, fixedRandom([0.25])));

  assert.equal(first.kind, "choice_required");
  assert.deepEqual(replay, first, "the same discard pile and RNG reproduce the candidate order and options");
  if (first.kind !== "choice_required") return;
  const shuffledIds = first.events.find((draft) => draft.type === "DRAW_PILE_RESHUFFLED")?.payload.cardInstanceIds;
  assert.deepEqual(first.request.context.candidateCardInstanceIds, Array.isArray(shuffledIds) ? shuffledIds : []);
  assert.equal(first.request.context.candidateCardInstanceIds?.length, 2);
  assert.deepEqual(state, before, "planning the reshuffle and candidate choice does not mutate state");
  assertZoneInvariant(state);
});

test("Jail pauses without consuming the installed card when both piles are empty", () => {
  const state = initialState();
  const jailId = installJailOnCurrentTurnPlayer(state);
  const ownerId = state.turn.currentPlayerId;
  state.zones.drawPileCardInstanceIds = [];
  state.zones.discardPileCardInstanceIds = [];
  const before = structuredClone(state);

  const result = resolveJailAtTurnStart(makeInput(state, jailId, [], ownerId));
  const events = appliedEvents(result);
  assert.deepEqual(events.map((draft) => draft.type), ["RULE_RESOURCE_EXHAUSTED"]);
  assert.equal(events[0]?.payload.fulfilledCount, 0);
  assert.deepEqual(state, before);

  const after = structuredClone(state);
  applyDrafts(after, events);
  assert.equal(after.status, "paused");
  assert.equal(after.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.ok(seatById(after, ownerId).public.inPlayCardInstanceIds.includes(jailId));
  assert.deepEqual(after.zones.discardPileCardInstanceIds, []);
});

test("Jail start resolution requires its owner's start phase after Dynamite", () => {
  const state = initialState();
  const jailId = installJailOnCurrentTurnPlayer(state);
  const ownerId = state.turn.currentPlayerId;
  const dynamiteId = physicalCardId(state, "dynamite");
  moveCardToZone(state, dynamiteId, "in_play", ownerId);
  const before = structuredClone(state);

  assert.deepEqual(resolveJailAtTurnStart(makeInput(state, jailId, [], ownerId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(state, before);

  moveCardToZone(state, dynamiteId, "discard");
  state.resolution.effectQueue.push({
    effectId: "dynamite:pending",
    kind: "DAMAGE_PLAYER",
    sourcePlayerId: null,
    targetPlayerId: ownerId,
    sourceCardInstanceId: dynamiteId,
    payload: {},
  });
  const pendingBefore = structuredClone(state);
  assert.deepEqual(resolveJailAtTurnStart(makeInput(state, jailId, [], ownerId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(state, pendingBefore, "Jail must not run ahead of queued Dynamite resolution");

  state.resolution.effectQueue = [];
  state.turn.phase = "play";
  assert.deepEqual(resolveJailAtTurnStart(makeInput(state, jailId, [], ownerId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
});
