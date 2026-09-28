import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  CardEffectInput,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
} from "../../src/effects/api.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState, SeatState } from "../../src/state/types.ts";
import {
  beginDiscardOrder,
  beginEffectResolution,
  submitDiscardOrder,
} from "../../src/resolution/index.ts";
import { turnHandLimitEffect } from "../../src/effects/cards/hand-limit.ts";

const FRAME_ID = "frame-turn-hand-limit";

function initialState(playerCount = 4): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seatFor(state: GameState, playerId: string): SeatState {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  assert.equal(matches.length, 1, `expected one seat for ${playerId}`);
  return matches[0]!;
}

function seatAt(state: GameState, seatIndex: number): SeatState {
  const matches = state.seats.filter((seat) => seat.public.seatIndex === seatIndex);
  assert.equal(matches.length, 1, `expected one seat at index ${seatIndex}`);
  return matches[0]!;
}

function moveToHand(state: GameState, playerId: string, cardInstanceId: string): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  seatFor(state, playerId).private.handCardInstanceIds.push(cardInstanceId);
}

function moveToInPlay(state: GameState, playerId: string, cardInstanceId: string): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  seatFor(state, playerId).public.inPlayCardInstanceIds.push(cardInstanceId);
}

function giveHand(state: GameState, playerId: string, count: number): string[] {
  const owner = seatFor(state, playerId);
  const priorHand = [...owner.private.handCardInstanceIds];
  owner.private.handCardInstanceIds = [];
  state.zones.discardPileCardInstanceIds.push(...priorHand);

  const selected = Object.keys(state.zones.cardsByInstanceId).slice(0, count);
  for (const cardInstanceId of selected) moveToHand(state, playerId, cardInstanceId);
  return selected;
}

function handLimitState(options: { readonly hp: number; readonly handCount: number }): {
  state: GameState;
  actor: SeatState;
  hand: string[];
} {
  const state = initialState();
  const actor = seatAt(state, 0);
  actor.public.hp = options.hp;
  state.turn.currentPlayerId = actor.public.playerId;
  state.turn.phase = "discard";
  const hand = giveHand(state, actor.public.playerId, options.handCount);
  return { state, actor, hand };
}

function inputFor(
  state: GameState,
  completedInteractions: readonly CompletedEffectInteraction[] = [],
): CardEffectInput {
  return {
    state,
    actorPlayerId: state.turn.currentPlayerId,
    sourceCardInstanceId: null,
    continuationFrameId: FRAME_ID,
    targets: [],
    random: { nextFloat: () => { throw new Error("the hand-limit effect must not use randomness"); } },
    completedInteractions,
  };
}

function eventsOf(result: CardEffectResult): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return result.events;
}

function openDiscardContinuation(state: GameState): GameState {
  const actorId = state.turn.currentPlayerId;
  const started = beginEffectResolution(state, {
    steps: [{
      effectId: "turn-hand-limit",
      kind: "TURN_HAND_LIMIT",
      sourcePlayerId: actorId,
      targetPlayerId: null,
      sourceCardInstanceId: null,
      payload: {},
    }],
    continuation: {
      frameId: FRAME_ID,
      kind: "TURN_HAND_LIMIT",
      sourcePlayerId: actorId,
      sourceCardInstanceId: null,
      payload: {},
    },
  });
  assert.equal(started.ok, true);
  if (!started.ok) throw new Error(started.error.message);
  return started.state;
}

function openAndSubmitOrder(
  state: GameState,
  orderedCardInstanceIds: readonly string[],
): GameState {
  const actorId = state.turn.currentPlayerId;
  const request = turnHandLimitEffect(inputFor(state));
  assert.equal(request.kind, "choice_required");
  if (request.kind !== "choice_required") throw new Error(`expected choice_required, got ${request.kind}`);
  const opened = beginDiscardOrder(state, {
    interactionId: "interaction-turn-hand-limit",
    playerId: actorId,
    cardInstanceIds: [...seatFor(state, actorId).private.handCardInstanceIds],
    requiredCount: request.request.context.requiredCount as number,
    reason: "turn_hand_limit",
    context: request.request.context,
    resumeFrameId: FRAME_ID,
    createdAt: "2026-09-28T00:00:00.000Z",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) throw new Error(opened.error.message);
  const serialized = JSON.parse(JSON.stringify(opened.state)) as GameState;
  const submitted = submitDiscardOrder(serialized, {
    interactionId: "interaction-turn-hand-limit",
    actorPlayerId: actorId,
    choice: "ORDER_CARDS",
    orderedCardInstanceIds,
  });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) throw new Error(submitted.error.message);
  return JSON.parse(JSON.stringify(submitted.state)) as GameState;
}

function applyDiscardDrafts(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const event of events) {
    assert.equal(event.type, "CARD_DISCARDED");
    const cardInstanceId = event.payload.cardInstanceId;
    assert.equal(typeof cardInstanceId, "string");
    const ownerPlayerId = event.payload.ownerPlayerId;
    assert.equal(typeof ownerPlayerId, "string");
    assert.equal(event.payload.fromZone, "hand");
    assert.equal(event.payload.toZone, "discard");
    if (typeof cardInstanceId !== "string" || typeof ownerPlayerId !== "string") {
      throw new Error("discard event is missing its card or owner");
    }
    const owner = seatFor(state, ownerPlayerId);
    const index = owner.private.handCardInstanceIds.indexOf(cardInstanceId);
    assert.notEqual(index, -1, "only a card in the owner's hand may be discarded");
    owner.private.handCardInstanceIds.splice(index, 1);
    state.zones.discardPileCardInstanceIds.push(cardInstanceId);
  }
}

test("over-limit hand asks its owner to order exactly the current-HP excess", () => {
  const { state, actor, hand } = handLimitState({ hp: 3, handCount: 5 });
  const before = structuredClone(state);

  const result = turnHandLimitEffect(inputFor(state));

  assert.equal(result.kind, "choice_required");
  if (result.kind !== "choice_required") return;
  assert.equal(result.request.kind, "DISCARDS_ORDER");
  assert.deepEqual(result.request.responders, [{
    playerId: actor.public.playerId,
    options: [{ choice: "ORDER_CARDS", payload: {} }],
  }]);
  assert.deepEqual(result.request.context, {
    continuationFrameId: FRAME_ID,
    actorPlayerId: actor.public.playerId,
    reason: "turn_hand_limit",
    turnNumber: state.turn.turnNumber,
    currentHp: 3,
    requiredCount: 2,
  });
  assert.equal(result.request.resumeFrameId, FRAME_ID);
  assert.equal(hand.length, 5);
  assert.deepEqual(state, before, "requesting a choice does not mutate the snapshot");
});

test("hand at or below current HP needs no discard, even when max HP is higher", () => {
  const { state, actor } = handLimitState({ hp: 2, handCount: 2 });
  actor.public.maxHp = 4;
  const before = structuredClone(state);

  const result = turnHandLimitEffect(inputFor(state));

  assert.deepEqual(eventsOf(result), []);
  assert.deepEqual(state, before);

  const forgedExcessOrder: CompletedEffectInteraction = {
    interactionId: "forged-at-limit-order",
    kind: "DISCARDS_ORDER",
    context: {
      continuationFrameId: FRAME_ID,
      actorPlayerId: actor.public.playerId,
      reason: "turn_hand_limit",
      turnNumber: state.turn.turnNumber,
      currentHp: actor.public.hp,
      requiredCount: 1,
      discardOrder: {
        reason: "turn_hand_limit",
        allowedCardInstanceIds: [...actor.private.handCardInstanceIds],
        requiredCount: 1,
      },
    },
    responses: [{
      playerId: actor.public.playerId,
      choice: "ORDER_CARDS",
      payload: { orderedCardInstanceIds: [actor.private.handCardInstanceIds[0]!] },
    }],
  };
  assert.deepEqual(
    turnHandLimitEffect(inputFor(state, [forgedExcessOrder])),
    { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" },
    "a completed arbitrary discard cannot bypass the no-excess rule",
  );
  assert.deepEqual(state, before);
});

test("saved T12 discard order survives JSON round-trip and becomes ordered discard events", () => {
  const { state, actor, hand } = handLimitState({ hp: 3, handCount: 5 });
  const startedState = openDiscardContinuation(state);
  const ordered = [hand[3]!, hand[1]!];
  const resumedState = openAndSubmitOrder(startedState, ordered);
  const frame = resumedState.resolution.continuations.find((entry) => entry.frameId === FRAME_ID);
  assert.ok(frame);
  const persisted = frame.payload.__resolutionResults;
  assert.ok(Array.isArray(persisted));
  const beforeEffect = structuredClone(resumedState);

  const result = turnHandLimitEffect(inputFor(
    resumedState,
    persisted as unknown as CompletedEffectInteraction[],
  ));
  const events = eventsOf(result);

  assert.deepEqual(events.map((event) => event.payload.cardInstanceId), ordered);
  assert.deepEqual(seatFor(resumedState, actor.public.playerId).private.handCardInstanceIds, hand);
  assert.deepEqual(resumedState, beforeEffect, "returning discard drafts does not mutate the snapshot");
  const applied = structuredClone(resumedState);
  applyDiscardDrafts(applied, events);
  assert.deepEqual(
    seatFor(applied, actor.public.playerId).private.handCardInstanceIds,
    hand.filter((cardInstanceId) => !ordered.includes(cardInstanceId)),
  );
  assert.equal(applied.zones.discardPileCardInstanceIds.at(-1), ordered.at(-1));
});

test("a completed order is rejected if HP changes before the selection is applied", () => {
  const { state, actor, hand } = handLimitState({ hp: 2, handCount: 4 });
  const startedState = openDiscardContinuation(state);
  const resumedState = openAndSubmitOrder(startedState, [hand[0]!, hand[1]!]);
  const changedHpState = structuredClone(resumedState);
  seatFor(changedHpState, actor.public.playerId).public.hp = 3;
  const before = structuredClone(changedHpState);
  const frame = changedHpState.resolution.continuations.find((entry) => entry.frameId === FRAME_ID);
  assert.ok(frame);

  const result = turnHandLimitEffect(inputFor(
    changedHpState,
    frame.payload.__resolutionResults as unknown as CompletedEffectInteraction[],
  ));

  assert.deepEqual(result, { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });
  assert.deepEqual(changedHpState, before);
});

test("turn hand limit rejects equipment IDs and does not reuse elimination cleanup choices", () => {
  const { state, actor, hand } = handLimitState({ hp: 2, handCount: 3 });
  const equipmentId = Object.keys(state.zones.cardsByInstanceId).find((id) => !hand.includes(id))!;
  moveToInPlay(state, actor.public.playerId, equipmentId);
  const forgedEquipmentOrder: CompletedEffectInteraction = {
    interactionId: "forged-equipment-order",
    kind: "DISCARDS_ORDER",
    context: {
      continuationFrameId: FRAME_ID,
      actorPlayerId: actor.public.playerId,
      reason: "turn_hand_limit",
      turnNumber: state.turn.turnNumber,
      currentHp: actor.public.hp,
      requiredCount: 1,
      discardOrder: {
        reason: "turn_hand_limit",
        allowedCardInstanceIds: [...hand, equipmentId],
        requiredCount: 1,
      },
    },
    responses: [{
      playerId: actor.public.playerId,
      choice: "ORDER_CARDS",
      payload: { orderedCardInstanceIds: [equipmentId] },
    }],
  };
  const rejectedEquipment = turnHandLimitEffect(inputFor(state, [forgedEquipmentOrder]));
  assert.deepEqual(rejectedEquipment, { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });

  const cleanupChoice: CompletedEffectInteraction = {
    ...forgedEquipmentOrder,
    interactionId: "elimination-cleanup-order",
    context: {
      continuationFrameId: FRAME_ID,
      actorPlayerId: actor.public.playerId,
      reason: "elimination_cleanup",
      turnNumber: state.turn.turnNumber,
      currentHp: actor.public.hp,
      requiredCount: 1,
      discardOrder: {
        reason: "elimination_cleanup",
        allowedCardInstanceIds: hand,
        requiredCount: 1,
      },
    },
    responses: [{
      playerId: actor.public.playerId,
      choice: "ORDER_CARDS",
      payload: { orderedCardInstanceIds: [hand[0]!] },
    }],
  };
  const before = structuredClone(state);
  const notReused = turnHandLimitEffect(inputFor(state, [cleanupChoice]));
  assert.equal(notReused.kind, "choice_required");
  assert.deepEqual(state, before);
});

test("a limit request is based on the current HP after an HP reduction", () => {
  const { state, actor } = handLimitState({ hp: 2, handCount: 4 });
  actor.public.maxHp = 4;

  const result = turnHandLimitEffect(inputFor(state));

  assert.equal(result.kind, "choice_required");
  if (result.kind === "choice_required") {
    assert.equal(result.request.context.currentHp, 2);
    assert.equal(result.request.context.requiredCount, 2);
  }
});
