import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type {
  CardEffectInput,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  EffectInteractionRequest,
} from "../../src/effects/api.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import type { GameState, ResolutionFrame } from "../../src/state/types.ts";
import { duelEffect } from "../../src/effects/cards/duel.ts";
import {
  beginDeathRescue,
  completeDeathRescue,
  submitDeathRescueResponse,
} from "../../src/resolution/index.ts";
import { beginElimination } from "../../src/endgame/index.ts";

const TIMESTAMP = "2026-09-28T12:00:00.000Z";

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("Duel must not consume randomness"); } };
}

function initialState(playerCount = 5): GameState {
  const players: SetupPlayer[] = Array.from({ length: playerCount }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seatAt(state: GameState, seatIndex: number) {
  const seat = state.seats.find((entry) => entry.public.seatIndex === seatIndex);
  assert.ok(seat, `missing seat ${seatIndex}`);
  return seat;
}

function physicalCardId(state: GameState, typeId: string, copy = 0): string {
  const card = BASE_PHYSICAL_CARDS.filter((entry) => entry.typeId === typeId)[copy];
  assert.ok(card, `missing physical card ${typeId} copy ${copy}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (entry) => entry.cardDefinitionId === card.definitionId,
  );
  assert.ok(instance, `missing runtime card ${card.definitionId}`);
  return instance.cardInstanceId;
}

function moveCardToZone(
  state: GameState,
  cardInstanceId: string,
  playerId: string | null,
  zone: "hand" | "discard",
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
  assert.ok(playerId, "hand cards need an owner");
  const owner = state.seats.find((entry) => entry.public.playerId === playerId);
  assert.ok(owner, `missing player ${playerId}`);
  owner.private.handCardInstanceIds.push(cardInstanceId);
}

function clearHand(state: GameState, playerId: string): void {
  const owner = state.seats.find((entry) => entry.public.playerId === playerId);
  assert.ok(owner);
  for (const cardInstanceId of [...owner.private.handCardInstanceIds]) {
    moveCardToZone(state, cardInstanceId, null, "discard");
  }
}

function prepareDuelSource(state: GameState): string {
  const source = physicalCardId(state, "duel");
  moveCardToZone(state, source, null, "discard");
  return source;
}

function makeInput(
  state: GameState,
  sourceCardInstanceId: string,
  targetPlayerId: string,
  completedInteractions: readonly CompletedEffectInteraction[] = [],
  actorPlayerId = seatAt(state, 0).public.playerId,
): CardEffectInput {
  return {
    state,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-duel-test",
    targets: [{ kind: "player", playerId: targetPlayerId }],
    random: unusedRandom(),
    completedInteractions,
  };
}

function requestOf(result: CardEffectResult): EffectInteractionRequest {
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") throw new Error(`expected response_required, received ${result.kind}`);
  return result.request;
}

function completion(
  request: EffectInteractionRequest,
  playerId: string,
  choice: string,
  payload: Record<string, string> = {},
): CompletedEffectInteraction {
  const responder = request.responders[0];
  assert.ok(responder);
  assert.equal(responder.playerId, playerId);
  assert.ok(responder.options.some((option) =>
    option.choice === choice && JSON.stringify(option.payload) === JSON.stringify(payload),
  ), `request does not contain ${choice} ${JSON.stringify(payload)}`);
  return {
    interactionId: `interaction-${playerId}-${choice}`,
    kind: request.kind,
    context: request.context,
    responses: [{ playerId, choice, payload }],
  };
}

function applyDiscardEvents(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const effectEvent of events) {
    if (effectEvent.type !== "CARD_DISCARDED") continue;
    const cardInstanceId = effectEvent.payload.cardInstanceId;
    assert.equal(typeof cardInstanceId, "string");
    if (typeof cardInstanceId !== "string") throw new Error("CARD_DISCARDED event is missing a card ID");
    moveCardToZone(state, cardInstanceId, null, "discard");
  }
}

test("Duel requires one other living player and starts with a distant target", () => {
  const state = initialState(7);
  const sourceCardInstanceId = prepareDuelSource(state);
  const actorId = seatAt(state, 0).public.playerId;
  const distantTargetId = seatAt(state, 3).public.playerId;
  const targetBangId = physicalCardId(state, "bang");
  clearHand(state, distantTargetId);
  moveCardToZone(state, targetBangId, distantTargetId, "hand");
  const before = structuredClone(state);

  const started = duelEffect(makeInput(state, sourceCardInstanceId, distantTargetId));
  const request = requestOf(started);

  assert.deepEqual(state, before, "the effect emits a prompt without mutating the state");
  assert.equal(request.kind, "DUEL_RESPONSE");
  assert.deepEqual(request.responders.map((responder) => responder.playerId), [distantTargetId]);
  assert.ok(request.responders[0]!.options.some((option) =>
    option.choice === "PLAY_BANG" && option.payload.cardInstanceId === targetBangId,
  ));
  assert.deepEqual(
    duelEffect({ ...makeInput(state, sourceCardInstanceId, distantTargetId), targets: [] }),
    { kind: "target_required" },
  );
  assert.deepEqual(
    duelEffect({ ...makeInput(state, sourceCardInstanceId, actorId), targets: [{ kind: "player", playerId: actorId }] }),
    { kind: "invalid_target", code: "TARGET_IS_SELF" },
  );
});

test("players alternate from the target; yielded initiator takes Duel damage without changing BANG quota", () => {
  const state = initialState(7);
  const sourceCardInstanceId = prepareDuelSource(state);
  const initiator = seatAt(state, 0);
  const target = seatAt(state, 3);
  clearHand(state, initiator.public.playerId);
  clearHand(state, target.public.playerId);
  const targetBang1 = physicalCardId(state, "bang", 0);
  const initiatorBang1 = physicalCardId(state, "bang", 1);
  const targetBang2 = physicalCardId(state, "bang", 2);
  const initiatorBang2 = physicalCardId(state, "bang", 3);
  moveCardToZone(state, targetBang1, target.public.playerId, "hand");
  moveCardToZone(state, targetBang2, target.public.playerId, "hand");
  moveCardToZone(state, initiatorBang1, initiator.public.playerId, "hand");
  moveCardToZone(state, initiatorBang2, initiator.public.playerId, "hand");
  state.turn.bangCardPlaysThisTurn = 1;
  const quotaBefore = state.turn.bangCardPlaysThisTurn;
  const completed: CompletedEffectInteraction[] = [];

  let current = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId, completed));
  let request = requestOf(current);
  assert.equal(request.responders[0]!.playerId, target.public.playerId, "the target answers first");
  completed.push(completion(request, target.public.playerId, "PLAY_BANG", { cardInstanceId: targetBang1 }));
  const afterTargetOne = structuredClone(state);
  current = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId, completed));
  assert.deepEqual(state, afterTargetOne, "resuming the effect does not mutate state");
  assert.equal(current.kind, "response_required");
  if (current.kind !== "response_required") return;
  assert.equal(current.request.responders[0]!.playerId, initiator.public.playerId);
  assert.ok(current.events.some((entry) => entry.type === "CARD_DISCARDED" && entry.payload.cardInstanceId === targetBang1));
  applyDiscardEvents(state, current.events);

  completed.push(completion(current.request, initiator.public.playerId, "PLAY_BANG", { cardInstanceId: initiatorBang1 }));
  current = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId, completed));
  assert.equal(current.kind, "response_required");
  if (current.kind !== "response_required") return;
  assert.equal(current.request.responders[0]!.playerId, target.public.playerId);
  applyDiscardEvents(state, current.events);

  completed.push(completion(current.request, target.public.playerId, "PLAY_BANG", { cardInstanceId: targetBang2 }));
  current = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId, completed));
  assert.equal(current.kind, "response_required");
  if (current.kind !== "response_required") return;
  assert.equal(current.request.responders[0]!.playerId, initiator.public.playerId);
  assert.ok(current.request.responders[0]!.options.some((option) => option.choice === "YIELD"));
  applyDiscardEvents(state, current.events);

  completed.push(completion(current.request, initiator.public.playerId, "YIELD"));
  const afterYield = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId, completed));

  assert.equal(afterYield.kind, "applied");
  if (afterYield.kind !== "applied") return;
  assert.equal(afterYield.steps.length, 1);
  assert.deepEqual(afterYield.steps[0], {
    effectId: `frame-duel-test:duel:${sourceCardInstanceId}:damage:${initiator.public.playerId}`,
    kind: "DAMAGE_PLAYER",
    sourcePlayerId: initiator.public.playerId,
    targetPlayerId: initiator.public.playerId,
    sourceCardInstanceId,
    payload: { amount: 1, cause: "DUEL", duelInitiatorPlayerId: initiator.public.playerId },
  });
  assert.ok(afterYield.events.some((entry) => entry.type === "DUEL_YIELDED"));
  assert.ok(initiator.private.handCardInstanceIds.includes(initiatorBang2), "yield remains available when a BANG is held");
  assert.equal(state.turn.bangCardPlaysThisTurn, quotaBefore, "Duel response cards never increase turn BANG usage");
});

test("a responder with no BANG immediately takes one damage and the Duel ends", () => {
  const state = initialState(5);
  const sourceCardInstanceId = prepareDuelSource(state);
  const target = seatAt(state, 1);
  clearHand(state, target.public.playerId);

  const result = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0]!.kind, "DAMAGE_PLAYER");
  assert.equal(result.steps[0]!.sourcePlayerId, seatAt(state, 0).public.playerId);
  assert.equal(result.steps[0]!.targetPlayerId, target.public.playerId);
  assert.deepEqual(result.steps[0]!.payload, {
    amount: 1,
    cause: "DUEL",
    duelInitiatorPlayerId: seatAt(state, 0).public.playerId,
  });
  assert.ok(result.events.some((entry) => entry.type === "DUEL_STARTED"));
  assert.ok(result.events.some((entry) => entry.type === "DUEL_YIELDED"));
});

test("Calamity Janet may answer Duel with Missed as BANG", () => {
  const state = initialState(5);
  const sourceCardInstanceId = prepareDuelSource(state);
  const initiator = seatAt(state, 0);
  const calamity = seatAt(state, 2);
  calamity.public.characterId = "calamity_janet";
  clearHand(state, initiator.public.playerId);
  clearHand(state, calamity.public.playerId);
  const missedId = physicalCardId(state, "missed");
  const initiatorBang = physicalCardId(state, "bang");
  moveCardToZone(state, missedId, calamity.public.playerId, "hand");
  moveCardToZone(state, initiatorBang, initiator.public.playerId, "hand");
  const completed: CompletedEffectInteraction[] = [];

  const first = duelEffect(makeInput(state, sourceCardInstanceId, calamity.public.playerId, completed));
  const firstRequest = requestOf(first);
  assert.ok(firstRequest.responders[0]!.options.some((option) =>
    option.choice === "PLAY_BANG" && option.payload.cardInstanceId === missedId,
  ));
  completed.push(completion(firstRequest, calamity.public.playerId, "PLAY_BANG", { cardInstanceId: missedId }));
  const resumed = duelEffect(makeInput(state, sourceCardInstanceId, calamity.public.playerId, completed));

  assert.equal(resumed.kind, "response_required");
  if (resumed.kind !== "response_required") return;
  assert.equal(resumed.request.responders[0]!.playerId, initiator.public.playerId);
  assert.ok(resumed.events.some((entry) =>
    entry.type === "DUEL_BANG_PLAYED" && entry.payload.cardType === "missed" && entry.payload.asCardType === "bang",
  ));
  assert.ok(resumed.events.some((entry) => entry.type === "CARD_DISCARDED" && entry.payload.cardInstanceId === missedId));
  assert.equal(state.turn.bangCardPlaysThisTurn, 0);
});

test("Duel damage retains the initiator so R28 gives them no reward for their own elimination", () => {
  const state = initialState(5);
  const sourceCardInstanceId = prepareDuelSource(state);
  const initiator = seatAt(state, 0);
  const target = seatAt(state, 1);
  initiator.private.roleId = "outlaw";
  clearHand(state, initiator.public.playerId);
  clearHand(state, target.public.playerId);
  const targetBang = physicalCardId(state, "bang");
  moveCardToZone(state, targetBang, target.public.playerId, "hand");

  const started = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId));
  const completed = [completion(requestOf(started), target.public.playerId, "PLAY_BANG", { cardInstanceId: targetBang })];
  const result = duelEffect(makeInput(state, sourceCardInstanceId, target.public.playerId, completed));
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  const damage = result.steps[0]!;
  assert.equal(damage.sourcePlayerId, initiator.public.playerId);
  assert.equal(damage.targetPlayerId, initiator.public.playerId);
  assert.equal(damage.payload.cause, "DUEL");

  // Exercise the T13 attribution boundary with the source retained by T20.
  initiator.public.hp = 0;
  const frame: ResolutionFrame = {
    frameId: "frame-duel-test",
    kind: "TEST_DUEL_RESOLUTION",
    sourcePlayerId: initiator.public.playerId,
    sourceCardInstanceId,
    payload: {},
  };
  state.resolution.continuations = [frame];
  const rescue = beginDeathRescue(state, {
    victimPlayerId: initiator.public.playerId,
    sourcePlayerId: damage.sourcePlayerId,
    interactionId: "duel-death-rescue",
    options: [{ choice: "ACCEPT_ELIMINATION", payload: {} }],
    context: {},
    resumeFrameId: frame.frameId,
    createdAt: TIMESTAMP,
  });
  assert.equal(rescue.ok, true);
  if (!rescue.ok) return;
  const accepted = submitDeathRescueResponse(rescue.state, {
    interactionId: "duel-death-rescue",
    actorPlayerId: initiator.public.playerId,
    choice: "ACCEPT_ELIMINATION",
    payload: {},
  });
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  const closed = completeDeathRescue(accepted.state, initiator.public.playerId, "accept_elimination");
  assert.equal(closed.ok, true);
  if (!closed.ok) return;
  const elimination = beginElimination(closed.state, {
    victimPlayerId: initiator.public.playerId,
    attribution: { kind: "duel", initiatorPlayerId: initiator.public.playerId },
  });
  assert.equal(elimination.ok, true);
  if (!elimination.ok) return;
  assert.equal(elimination.value.rewardPlayerId, null);
});
