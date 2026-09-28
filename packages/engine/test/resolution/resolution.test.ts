import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectStep, GameState, InteractionOption, ResolutionFrame } from "../../src/state/types.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import {
  beginDeathRescue,
  beginDiscardOrder,
  beginEffectResolution,
  buildClockwiseTargetSteps,
  canCheckVictory,
  completeDeathCleanup,
  completeDeathRescue,
  completeDeathWinCheck,
  completeEffectStep,
  finishEffectResolution,
  markDeathCleanupReady,
  openPendingInteraction,
  submitDeathRescueResponse,
  submitDiscardOrder,
  submitInteractionResponse,
} from "../../src/resolution/index.ts";

function fixedRandom(): RandomSource {
  const values = Array.from({ length: 1_000 }, (_, index) => ((index * 67 + 11) % 997) / 997);
  let cursor = 0;
  return {
    nextFloat() {
      assert.ok(cursor < values.length, "fixture setup requested more random values than expected");
      return values[cursor++]!;
    },
  };
}

function playersFor(count = 5): SetupPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
}

function initialState(count = 5): GameState {
  return initializeGame({ players: playersFor(count), random: fixedRandom() });
}

function frame(
  frameId = "frame-card",
  sourcePlayerId = "player-1",
  sourceCardInstanceId = "card-source",
): ResolutionFrame {
  return {
    frameId,
    kind: "CARD_RESOLUTION",
    sourcePlayerId,
    sourceCardInstanceId,
    payload: { phase: "before-target" },
  };
}

function step(targetPlayerId: string, effectId = "effect-card"): EffectStep {
  return {
    effectId,
    kind: "RESOLVE_TARGET",
    sourcePlayerId: "player-1",
    targetPlayerId,
    sourceCardInstanceId: "card-source",
    payload: { result: "pending" },
  };
}

function startEffect(state: GameState, steps: EffectStep[], deferredEffectId?: string): GameState {
  const result = beginEffectResolution(state, {
    steps,
    continuation: frame(
      "frame-card",
      steps[0]?.sourcePlayerId ?? "player-1",
      steps[0]?.sourceCardInstanceId ?? "card-source",
    ),
    ...(deferredEffectId === undefined ? {} : { deferredVictoryCheckEffectId: deferredEffectId }),
  });
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

function player(state: GameState, playerId: string) {
  const match = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(match);
  return match;
}

function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function commonOptions(playerId: string): InteractionOption[] {
  return [
    { choice: "PLAY_BANG", payload: { cardInstanceId: `${playerId}-bang` } },
    { choice: "YIELD", payload: {} },
  ];
}

test("multi-target queue snapshots living seats clockwise and preserves its cursor after restart", () => {
  const source = initialState(6);
  const sourcePlayerId = source.seats[2]!.public.playerId;
  source.seats[4]!.public.eliminated = true;
  source.seats[0]!.public.eliminated = true;
  const before = cloneState(source);

  const built = buildClockwiseTargetSteps(source, {
    effectId: "gatling-1",
    kind: "GATLING_TARGET",
    sourcePlayerId,
    sourceCardInstanceId: "gatling-instance",
    payload: { symbol: "BANG" },
  });

  assert.equal(built.ok, true);
  if (!built.ok) return;
  assert.deepEqual(built.value.map((entry) => entry.targetPlayerId), [
    source.seats[3]!.public.playerId,
    source.seats[5]!.public.playerId,
    source.seats[1]!.public.playerId,
  ]);
  assert.deepEqual(source, before, "building the queue must not mutate the match");

  let state = startEffect(source, built.value, "gatling-1");
  assert.equal(state.resolution.effectQueue[0]!.targetPlayerId, source.seats[3]!.public.playerId);
  assert.equal(state.resolution.victoryCheckDeferredByEffectId, "gatling-1");
  assert.equal(canCheckVictory(state), false);

  // The first queued target is eliminated while the effect runs. Remaining
  // target order is still the immutable start-time queue.
  player(state, source.seats[3]!.public.playerId).public.eliminated = true;
  const currentStep = state.resolution.effectQueue[0]!;
  const advanced = completeEffectStep(state, currentStep);
  assert.equal(advanced.ok, true);
  if (!advanced.ok) return;
  state = cloneState(advanced.state);
  assert.equal(state.resolution.effectQueue[0]!.targetPlayerId, source.seats[5]!.public.playerId);
  assert.equal(state.resolution.victoryCheckDeferredByEffectId, "gatling-1");

  while (state.resolution.effectQueue.length > 0) {
    const next = completeEffectStep(state, state.resolution.effectQueue[0]!);
    assert.equal(next.ok, true);
    if (!next.ok) return;
    state = next.state;
  }
  assert.equal(canCheckVictory(state), false, "deferred victory remains blocked until the owning frame completes");
  const finished = finishEffectResolution(state, "gatling-1", "frame-card");
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.value.canCheckVictory, true);
  assert.equal(finished.state.resolution.victoryCheckDeferredByEffectId, null);
  assert.equal(finished.value.frame.payload.phase, "before-target");
});

test("Duel responders advance one cursor at a time and restore the same actor and resume frame", () => {
  const source = initialState();
  const firstActor = source.seats[1]!.public.playerId;
  const secondActor = source.seats[2]!.public.playerId;
  let state = startEffect(source, [step(secondActor)]);
  const opened = openPendingInteraction(state, {
    interactionId: "duel-window-1",
    kind: "DUEL_RESPONSE",
    responders: [
      { playerId: firstActor, options: commonOptions(firstActor) },
      { playerId: secondActor, options: commonOptions(secondActor) },
    ],
    context: { sourcePlayerId: source.seats[0]!.public.playerId },
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  state = opened.state;
  assert.deepEqual(state.resolution.pendingInteraction?.actorPlayerIds, [firstActor]);

  const wrongActorBefore = cloneState(state);
  const wrongActor = submitInteractionResponse(state, {
    interactionId: "duel-window-1",
    actorPlayerId: secondActor,
    choice: "YIELD",
    payload: {},
  });
  assert.equal(wrongActor.ok, false);
  if (!wrongActor.ok) assert.equal(wrongActor.error.code, "WRONG_RESPONDER");
  assert.deepEqual(state, wrongActorBefore);

  const wrongInteraction = submitInteractionResponse(state, {
    interactionId: "stale-duel-window",
    actorPlayerId: firstActor,
    choice: "YIELD",
    payload: {},
  });
  assert.equal(wrongInteraction.ok, false);
  if (!wrongInteraction.ok) assert.equal(wrongInteraction.error.code, "WRONG_INTERACTION");
  assert.deepEqual(state, wrongActorBefore);

  const firstResponse = submitInteractionResponse(state, {
    interactionId: "duel-window-1",
    actorPlayerId: firstActor,
    choice: "PLAY_BANG",
    payload: { cardInstanceId: `${firstActor}-bang` },
  });
  assert.equal(firstResponse.ok, true);
  if (!firstResponse.ok) return;
  assert.equal(firstResponse.value.completed, false);
  assert.equal(firstResponse.value.cursor, 1);
  state = cloneState(firstResponse.state);
  assert.deepEqual(state.resolution.pendingInteraction?.actorPlayerIds, [secondActor]);
  assert.deepEqual(state.resolution.continuations.at(-1)?.frameId, "frame-card");
  assert.equal(
    (state.resolution.pendingInteraction?.context.__resolutionCursor as { cursor: number }).cursor,
    1,
  );

  const duplicateFirstResponse = submitInteractionResponse(state, {
    interactionId: "duel-window-1",
    actorPlayerId: firstActor,
    choice: "PLAY_BANG",
    payload: { cardInstanceId: `${firstActor}-bang` },
  });
  assert.equal(duplicateFirstResponse.ok, false);
  if (!duplicateFirstResponse.ok) assert.equal(duplicateFirstResponse.error.code, "WRONG_RESPONDER");
  assert.deepEqual(state.resolution.pendingInteraction?.actorPlayerIds, [secondActor]);

  const secondResponse = submitInteractionResponse(state, {
    interactionId: "duel-window-1",
    actorPlayerId: secondActor,
    choice: "YIELD",
    payload: {},
  });
  assert.equal(secondResponse.ok, true);
  if (!secondResponse.ok) return;
  assert.equal(secondResponse.value.completed, true);
  assert.equal(secondResponse.value.nextActorPlayerId, null);
  assert.equal(secondResponse.state.resolution.pendingInteraction, null);
  const savedFrame = secondResponse.state.resolution.continuations.at(-1)!;
  const savedResults = savedFrame.payload.__resolutionResults as Array<{
    interactionId: string;
    kind: string;
    responses: Array<{ playerId: string; choice: string }>;
  }>;
  assert.equal(savedResults[0]!.interactionId, "duel-window-1");
  assert.equal(savedResults[0]!.kind, "DUEL_RESPONSE");
  assert.deepEqual(savedResults[0]!.responses.map((response) => [response.playerId, response.choice]), [
    [firstActor, "PLAY_BANG"],
    [secondActor, "YIELD"],
  ]);

  const noPending = submitInteractionResponse(secondResponse.state, {
    interactionId: "duel-window-1",
    actorPlayerId: secondActor,
    choice: "YIELD",
    payload: {},
  });
  assert.equal(noPending.ok, false);
  if (!noPending.ok) assert.equal(noPending.error.code, "NO_PENDING_INTERACTION");
});

test("death rescue is victim-only, survives reload, and proceeds through cleanup order", () => {
  const source = initialState();
  const victimPlayerId = source.seats[2]!.public.playerId;
  const victim = player(source, victimPlayerId);
  victim.public.hp = 0;
  let state = startEffect(source, [step(victimPlayerId)]);
  const rescueOptions: InteractionOption[] = [
    { choice: "USE_BEER", payload: { cardInstanceId: victim.private.handCardInstanceIds[0]! } },
    { choice: "ACCEPT_ELIMINATION", payload: {} },
  ];

  const rescue = beginDeathRescue(state, {
    victimPlayerId,
    sourcePlayerId: source.seats[0]!.public.playerId,
    interactionId: "death-window-1",
    options: rescueOptions,
    context: { damage: 1 },
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:01:00.000Z",
  });
  assert.equal(rescue.ok, true);
  if (!rescue.ok) return;
  state = cloneState(rescue.state);
  assert.deepEqual(state.resolution.pendingInteraction?.actorPlayerIds, [victimPlayerId]);
  assert.deepEqual(state.resolution.pendingDeath?.rescueResponderIds, [victimPlayerId]);
  assert.equal(state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(state.resolution.pendingDeath?.resumeFrameId, "frame-card");

  const wrongRescuerBefore = cloneState(state);
  const wrongRescuer = submitDeathRescueResponse(state, {
    interactionId: "death-window-1",
    actorPlayerId: source.seats[0]!.public.playerId,
    choice: "USE_BEER",
    payload: { cardInstanceId: victim.private.handCardInstanceIds[0]! },
  });
  assert.equal(wrongRescuer.ok, false);
  if (!wrongRescuer.ok) assert.equal(wrongRescuer.error.code, "WRONG_RESPONDER");
  assert.deepEqual(state, wrongRescuerBefore);

  const beerResponse = submitDeathRescueResponse(state, {
    interactionId: "death-window-1",
    actorPlayerId: victimPlayerId,
    choice: "USE_BEER",
    payload: { cardInstanceId: victim.private.handCardInstanceIds[0]! },
  });
  assert.equal(beerResponse.ok, true);
  if (!beerResponse.ok) return;
  state = cloneState(beerResponse.state);
  assert.equal(state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(state.resolution.pendingDeath?.rescueCursor, 1, "the victim response advances the saved rescue cursor once");
  const incompleteHealing = completeDeathRescue(state, victimPlayerId, "survived");
  assert.equal(incompleteHealing.ok, false);
  if (!incompleteHealing.ok) assert.equal(incompleteHealing.error.code, "INVALID_DEATH_STAGE");

  // The caller applies the chosen Beer and persists the new HP before closing rescue.
  player(state, victimPlayerId).public.hp = 1;
  const healed = completeDeathRescue(state, victimPlayerId, "survived");
  assert.equal(healed.ok, true);
  if (!healed.ok) return;
  state = healed.state;
  assert.equal(state.resolution.pendingDeath, null);
  assert.equal(state.resolution.effectQueue.length, 1, "the parent effect remains queued for resume");

  // A second branch verifies the explicit accept-elimination and discard-order path.
  const eliminationState = cloneState(source);
  player(eliminationState, victimPlayerId).public.hp = 0;
  let dying = startEffect(eliminationState, [step(victimPlayerId)]);
  const acceptOpened = beginDeathRescue(dying, {
    victimPlayerId,
    sourcePlayerId: eliminationState.seats[0]!.public.playerId,
    interactionId: "death-window-accept",
    options: [
      { choice: "USE_BEER", payload: { cardInstanceId: player(eliminationState, victimPlayerId).private.handCardInstanceIds[0]! } },
      { choice: "ACCEPT_ELIMINATION", payload: {} },
    ],
    context: { damage: 3 },
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:02:00.000Z",
  });
  assert.equal(acceptOpened.ok, true);
  if (!acceptOpened.ok) return;
  dying = acceptOpened.state;
  const partialRescue = submitDeathRescueResponse(dying, {
    interactionId: "death-window-accept",
    actorPlayerId: victimPlayerId,
    choice: "USE_BEER",
    payload: { cardInstanceId: player(eliminationState, victimPlayerId).private.handCardInstanceIds[0]! },
  });
  assert.equal(partialRescue.ok, true);
  if (!partialRescue.ok) return;
  assert.equal(partialRescue.state.resolution.pendingDeath?.rescueCursor, 1);
  const secondRescueWindow = beginDeathRescue(partialRescue.state, {
    victimPlayerId,
    sourcePlayerId: eliminationState.seats[0]!.public.playerId,
    interactionId: "death-window-accept-after-beer",
    options: [{ choice: "ACCEPT_ELIMINATION", payload: {} }],
    context: { damage: 3 },
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:02:30.000Z",
  });
  assert.equal(secondRescueWindow.ok, true, "a spent rescue response can open another victim-only window while HP is still zero");
  if (!secondRescueWindow.ok) return;
  assert.equal(secondRescueWindow.state.resolution.pendingDeath?.rescueCursor, 0);
  const accepted = submitDeathRescueResponse(secondRescueWindow.state, {
    interactionId: "death-window-accept-after-beer",
    actorPlayerId: victimPlayerId,
    choice: "ACCEPT_ELIMINATION",
    payload: {},
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.state.resolution.pendingDeath?.rescueCursor, 1);
  const reopenedRescue = beginDeathRescue(accepted.state, {
    victimPlayerId,
    sourcePlayerId: eliminationState.seats[0]!.public.playerId,
    interactionId: "death-window-accept-again",
    options: [{ choice: "ACCEPT_ELIMINATION", payload: {} }],
    context: { damage: 3 },
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:02:45.000Z",
  });
  assert.equal(reopenedRescue.ok, false, "a completed rescue cursor cannot reopen a second response window");
  if (!reopenedRescue.ok) assert.equal(reopenedRescue.error.code, "INVALID_DEATH_STAGE");
  const mismatchedOutcome = completeDeathRescue(accepted.state, victimPlayerId, "survived");
  assert.equal(mismatchedOutcome.ok, false, "accepting elimination cannot be completed as a rescue");
  const acceptedDeath = completeDeathRescue(accepted.state, victimPlayerId, "accept_elimination");
  assert.equal(acceptedDeath.ok, true);
  if (!acceptedDeath.ok) return;
  assert.equal(acceptedDeath.state.resolution.pendingDeath?.consequenceStage, "elimination");

  const deadState = cloneState(acceptedDeath.state);
  player(deadState, victimPlayerId).public.eliminated = true;
  const cleanup = markDeathCleanupReady(deadState, victimPlayerId);
  assert.equal(cleanup.ok, true);
  if (!cleanup.ok) return;
  dying = cleanup.state;
  const ownedCards = [
    ...player(dying, victimPlayerId).private.handCardInstanceIds,
    ...player(dying, victimPlayerId).public.inPlayCardInstanceIds,
  ];
  const discardOpened = beginDiscardOrder(dying, {
    interactionId: "elimination-order-1",
    playerId: victimPlayerId,
    cardInstanceIds: ownedCards,
    requiredCount: ownedCards.length,
    reason: "elimination_cleanup",
    context: { afterVultureTransfer: true },
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:03:00.000Z",
  });
  assert.equal(discardOpened.ok, true);
  if (!discardOpened.ok) return;
  dying = cloneState(discardOpened.state);
  assert.deepEqual(dying.resolution.pendingInteraction?.actorPlayerIds, [victimPlayerId]);

  const reversedOrder = [...ownedCards].reverse();
  const orderResponse = submitDiscardOrder(dying, {
    interactionId: "elimination-order-1",
    actorPlayerId: victimPlayerId,
    choice: "ORDER_CARDS",
    orderedCardInstanceIds: reversedOrder,
  });
  assert.equal(orderResponse.ok, true);
  if (!orderResponse.ok) return;
  assert.deepEqual(orderResponse.value.orderedCardInstanceIds, reversedOrder);
  assert.equal(orderResponse.state.resolution.pendingInteraction, null);
  const cleanupDone = completeDeathCleanup(orderResponse.state, victimPlayerId);
  assert.equal(cleanupDone.ok, true);
  if (!cleanupDone.ok) return;
  assert.equal(cleanupDone.value.consequenceStage, null, "remaining effect work resumes before victory checking");
  const finishedStep = completeEffectStep(cleanupDone.state, cleanupDone.state.resolution.effectQueue[0]!);
  assert.equal(finishedStep.ok, true);
  if (!finishedStep.ok) return;
  const finished = finishEffectResolution(finishedStep.state, "effect-card", "frame-card");
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.value.canCheckVictory, true);
  const savedFrame = finished.value.frame;
  const results = savedFrame.payload.__resolutionResults as Array<{
    kind: string;
    responses: Array<{ choice: string; payload: Record<string, unknown> }>;
  }>;
  assert.deepEqual(results.map((result) => result.kind), ["DEATH_RESCUE", "DEATH_RESCUE", "DISCARDS_ORDER"]);
  assert.equal(results[1]!.responses[0]!.choice, "ACCEPT_ELIMINATION");
  assert.deepEqual(results[2]!.responses[0]!.payload.orderedCardInstanceIds, reversedOrder);

  const noDeath = completeDeathWinCheck(cleanupDone.state, victimPlayerId);
  assert.equal(noDeath.ok, false, "deferred multi-step death cleanup cannot win-check before the effect resumes");
});

test("turn-end discard order must contain exactly the hand excess and rejects invalid IDs/order without mutation", () => {
  const source = initialState();
  const actorPlayerId = source.seats[1]!.public.playerId;
  const actor = player(source, actorPlayerId);
  actor.public.hp = actor.private.handCardInstanceIds.length - 1;
  source.turn.currentPlayerId = actorPlayerId;
  source.turn.phase = "discard";
  const state = startEffect(source, [step(actorPlayerId)]);
  const handIds = [...player(state, actorPlayerId).private.handCardInstanceIds];
  const opened = beginDiscardOrder(state, {
    interactionId: "turn-discard-1",
    playerId: actorPlayerId,
    cardInstanceIds: handIds,
    requiredCount: 1,
    reason: "turn_hand_limit",
    context: {},
    resumeFrameId: "frame-card",
    createdAt: "2026-09-27T12:04:00.000Z",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const wrongCountBefore = cloneState(opened.state);
  const wrongCount = submitDiscardOrder(opened.state, {
    interactionId: "turn-discard-1",
    actorPlayerId,
    choice: "ORDER_CARDS",
    orderedCardInstanceIds: [handIds[0]!, handIds[1]!],
  });
  assert.equal(wrongCount.ok, false);
  if (!wrongCount.ok) assert.equal(wrongCount.error.code, "INVALID_DISCARD_ORDER");
  assert.deepEqual(opened.state, wrongCountBefore);

  const wrongResponder = submitDiscardOrder(opened.state, {
    interactionId: "turn-discard-1",
    actorPlayerId: source.seats[0]!.public.playerId,
    choice: "ORDER_CARDS",
    orderedCardInstanceIds: [handIds[0]!],
  });
  assert.equal(wrongResponder.ok, false);
  if (!wrongResponder.ok) assert.equal(wrongResponder.error.code, "WRONG_RESPONDER");
  assert.deepEqual(opened.state, wrongCountBefore);

  const wrongChoice = submitDiscardOrder(opened.state, {
    interactionId: "turn-discard-1",
    actorPlayerId,
    choice: "TAKE_HIT",
    orderedCardInstanceIds: [handIds[0]!],
  });
  assert.equal(wrongChoice.ok, false);
  if (!wrongChoice.ok) assert.equal(wrongChoice.error.code, "INVALID_CHOICE");
  assert.deepEqual(opened.state, wrongCountBefore);

  const validOrder = [handIds.at(-1)!];
  const submitted = submitDiscardOrder(opened.state, {
    interactionId: "turn-discard-1",
    actorPlayerId,
    choice: "ORDER_CARDS",
    orderedCardInstanceIds: validOrder,
  });
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const savedFrame = submitted.state.resolution.continuations.at(-1)!;
  const results = savedFrame.payload.__resolutionResults as Array<{
    responses: Array<{ payload: Record<string, unknown> }>;
  }>;
  assert.deepEqual(results[0]!.responses[0]!.payload.orderedCardInstanceIds, validOrder);
});

test("a missing resume frame cannot open an interaction and rejected input preserves the saved state", () => {
  const state = initialState();
  const sourcePlayerId = state.seats[0]!.public.playerId;
  const targetPlayerId = state.seats[1]!.public.playerId;
  const begun = beginEffectResolution(state, {
    steps: [step(targetPlayerId)],
    continuation: frame(),
  });
  assert.equal(begun.ok, true);
  if (!begun.ok) return;
  const before = cloneState(begun.state);
  const opened = openPendingInteraction(begun.state, {
    interactionId: "barrel-reaction",
    kind: "BANG_RESPONSE",
    responders: [{
      playerId: targetPlayerId,
      options: [{ choice: "TAKE_HIT", payload: {} }],
    }],
    context: { sourcePlayerId },
    resumeFrameId: "missing-frame",
    createdAt: "2026-09-27T12:05:00.000Z",
  });
  assert.equal(opened.ok, false);
  if (!opened.ok) assert.equal(opened.error.code, "FRAME_NOT_FOUND");
  assert.deepEqual(begun.state, before);
});
