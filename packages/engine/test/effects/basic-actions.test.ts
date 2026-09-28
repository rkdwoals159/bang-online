import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import {
  bangEffect,
  beerEffect,
  missedEffect,
} from "../../src/effects/cards/basic-actions.ts";
import type {
  CardEffectInput,
  CompletedEffectInteraction,
  DeepReadonly,
  EffectTarget,
} from "../../src/effects/api.ts";
import type { GameState } from "../../src/state/types.ts";

function fixedRandom(): RandomSource {
  let cursor = 0;
  return {
    nextFloat() {
      const value = ((cursor * 67 + 11) % 997) / 997;
      cursor += 1;
      return value;
    },
  };
}

function playersFor(count = 4): SetupPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
}

function makeState(): GameState {
  const state = initializeGame({ players: playersFor(), random: fixedRandom() });
  state.turn.phase = "play";
  return state;
}

function moveCardToHand(state: GameState, typeId: string, playerId: string): string {
  const instance = Object.values(state.zones.cardsByInstanceId).find((candidate) => {
    const physical = BASE_PHYSICAL_CARDS.find((card) => card.definitionId === candidate.cardDefinitionId);
    return physical?.typeId === typeId;
  });
  assert.ok(instance, `expected a physical ${typeId} card`);
  const cardInstanceId = instance.cardInstanceId;

  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  const owner = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(owner, `expected seat ${playerId}`);
  owner.private.handCardInstanceIds = [cardInstanceId];
  return cardInstanceId;
}

function moveCardToDiscard(state: GameState, cardInstanceId: string): void {
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.discardPileCardInstanceIds = [
    ...state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId),
    cardInstanceId,
  ];
}

function inputFor(
  state: GameState,
  actorPlayerId: string,
  sourceCardInstanceId: string,
  targets: readonly EffectTarget[] = [],
  completedInteractions: readonly CompletedEffectInteraction[] = [],
  random: RandomSource = fixedRandom(),
): CardEffectInput {
  return {
    state: state as DeepReadonly<GameState>,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-basic-action-1",
    targets,
    random,
    completedInteractions,
  };
}

function interactionFrom(
  result: ReturnType<typeof bangEffect>,
  playerId: string,
  choice: string,
  payload: Record<string, string> = {},
): CompletedEffectInteraction {
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") throw new Error("expected BANG response request");
  return {
    interactionId: "bang-response-1",
    kind: result.request.kind,
    context: result.request.context,
    responses: [{ playerId, choice, payload }],
  };
}

test("BANG opens one target response with only that target's Missed cards", () => {
  const state = makeState();
  const actorId = state.seats[0]!.public.playerId;
  const targetId = state.seats[1]!.public.playerId;
  const bangId = moveCardToHand(state, "bang", actorId);
  const missedId = moveCardToHand(state, "missed", targetId);
  const before = structuredClone(state);

  const result = bangEffect(inputFor(state, actorId, bangId, [{ kind: "player", playerId: targetId }]));

  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") return;
  assert.equal(result.request.kind, "BANG_RESPONSE");
  assert.deepEqual(result.request.responders, [{
    playerId: targetId,
    options: [
      { choice: "USE_MISSED", payload: { cardInstanceId: missedId } },
      { choice: "TAKE_HIT", payload: {} },
    ],
  }]);
  assert.equal(result.events[0]?.type, "BANG_ATTACKED");
  assert.deepEqual(result.steps, []);
  assert.equal(state.turn.bangCardPlaysThisTurn, before.turn.bangCardPlaysThisTurn);
  assert.deepEqual(state, before);
});

test("completed Missed response is connected to BANG cancellation without damage", () => {
  const state = makeState();
  const actorId = state.seats[0]!.public.playerId;
  const targetId = state.seats[1]!.public.playerId;
  const bangId = moveCardToHand(state, "bang", actorId);
  const missedId = moveCardToHand(state, "missed", targetId);
  moveCardToDiscard(state, bangId);
  const attack = bangEffect(inputFor(state, actorId, bangId, [{ kind: "player", playerId: targetId }]));
  const response = interactionFrom(attack, targetId, "USE_MISSED", { cardInstanceId: missedId });
  moveCardToDiscard(state, missedId);
  const beforeResume = structuredClone(state);

  const missed = missedEffect(inputFor(state, targetId, missedId, [], [response]));
  const resumedBang = bangEffect(inputFor(state, actorId, bangId, [{ kind: "player", playerId: targetId }], [response]));

  assert.equal(missed.kind, "applied");
  if (missed.kind !== "applied") return;
  assert.deepEqual(missed.events, [{
    type: "MISSED_USED",
    actorPlayerId: targetId,
    payload: { cardInstanceId: missedId, interactionId: "bang-response-1" },
  }]);
  assert.deepEqual(missed.steps, []);
  assert.equal(resumedBang.kind, "applied");
  if (resumedBang.kind !== "applied") return;
  assert.equal(resumedBang.events[0]?.type, "BANG_MISSED");
  assert.equal(resumedBang.events[0]?.actorPlayerId, targetId);
  assert.deepEqual(resumedBang.steps, []);
  assert.deepEqual(state.zones.discardPileCardInstanceIds, [bangId, missedId]);
  assert.deepEqual(state, beforeResume);
});

test("a multi-card BANG response saves its remaining quota and excludes a submitted Missed", () => {
  const state = makeState();
  const actorId = state.seats[0]!.public.playerId;
  const targetId = state.seats[1]!.public.playerId;
  const bangId = moveCardToHand(state, "bang", actorId);
  const firstMissedId = moveCardToHand(state, "missed", targetId);
  const target = state.seats.find((seat) => seat.public.playerId === targetId)!;
  const secondMissed = state.zones.drawPileCardInstanceIds
    .map((id) => state.zones.cardsByInstanceId[id]!)
    .find((instance) => BASE_PHYSICAL_CARDS.some((card) => card.definitionId === instance.cardDefinitionId && card.typeId === "missed"));
  assert.ok(secondMissed);
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== secondMissed.cardInstanceId);
  target.private.handCardInstanceIds.push(secondMissed.cardInstanceId);

  const targetRef = [{ kind: "player", playerId: targetId }] as const;
  const initial = bangEffect(inputFor(state, actorId, bangId, targetRef));
  assert.equal(initial.kind, "response_required");
  if (initial.kind !== "response_required") return;
  const firstResponse: CompletedEffectInteraction = {
    interactionId: "slab-response-1",
    kind: "BANG_RESPONSE",
    context: { ...initial.request.context, requiredMisses: 2 },
    responses: [{ playerId: targetId, choice: "USE_MISSED", payload: { cardInstanceId: firstMissedId } }],
  };
  moveCardToDiscard(state, firstMissedId);

  const followup = bangEffect(inputFor(state, actorId, bangId, targetRef, [firstResponse]));
  assert.equal(followup.kind, "response_required");
  if (followup.kind !== "response_required") return;
  assert.equal(followup.request.context.requiredMisses, 2);
  assert.deepEqual(followup.request.context.barrelProgress, {
    successfulMisses: 1,
    attemptedDefenseSources: [],
  });
  assert.deepEqual(followup.request.responders[0]?.options, [
    { choice: "USE_MISSED", payload: { cardInstanceId: secondMissed.cardInstanceId } },
    { choice: "TAKE_HIT", payload: {} },
  ]);

  const secondResponse: CompletedEffectInteraction = {
    interactionId: "slab-response-2",
    kind: "BANG_RESPONSE",
    context: followup.request.context,
    responses: [{ playerId: targetId, choice: "USE_MISSED", payload: { cardInstanceId: secondMissed.cardInstanceId } }],
  };
  const defended = bangEffect(inputFor(state, actorId, bangId, targetRef, [firstResponse, secondResponse]));
  assert.equal(defended.kind, "applied");
  if (defended.kind === "applied") {
    assert.equal(defended.events[0]?.type, "BANG_MISSED");
    assert.equal(defended.events[0]?.payload.missedCardInstanceId, secondMissed.cardInstanceId);
    assert.deepEqual(defended.steps, []);
  }
});

test("a BANG response that takes the hit emits exactly one damage step", () => {
  const state = makeState();
  const actorId = state.seats[0]!.public.playerId;
  const targetId = state.seats[1]!.public.playerId;
  const bangId = moveCardToHand(state, "bang", actorId);
  const target = state.seats.find((seat) => seat.public.playerId === targetId)!;
  target.private.handCardInstanceIds = [];
  const targetRef = [{ kind: "player", playerId: targetId }] as const;
  const attack = bangEffect(inputFor(state, actorId, bangId, targetRef));

  assert.equal(attack.kind, "response_required");
  if (attack.kind !== "response_required") return;
  assert.deepEqual(attack.request.responders[0]?.options, [{ choice: "TAKE_HIT", payload: {} }]);
  const response = interactionFrom(attack, targetId, "TAKE_HIT");
  const resolved = bangEffect(inputFor(state, actorId, bangId, targetRef, [response]));

  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") return;
  assert.deepEqual(resolved.events.map((item) => item.type), ["BANG_HIT"]);
  assert.deepEqual(resolved.steps, [{
    effectId: `frame-basic-action-1:damage_player:${bangId}`,
    kind: "DAMAGE_PLAYER",
    sourcePlayerId: actorId,
    targetPlayerId: targetId,
    sourceCardInstanceId: bangId,
    payload: { amount: 1, cause: "BANG" },
  }]);
});

test("BANG leaves quota, distance, and card movement to the command/rules boundaries", () => {
  const state = makeState();
  const actorId = state.seats[0]!.public.playerId;
  const targetId = state.seats[2]!.public.playerId;
  const bangId = moveCardToHand(state, "bang", actorId);
  const target = state.seats.find((seat) => seat.public.playerId === targetId)!;
  target.private.handCardInstanceIds = [];
  state.turn.bangCardPlaysThisTurn = 1;
  const before = structuredClone(state);

  const targetRef = [{ kind: "player", playerId: targetId }] as const;
  const initial = bangEffect(inputFor(state, actorId, bangId, targetRef));

  assert.equal(initial.kind, "response_required");
  if (initial.kind !== "response_required") return;
  const response = interactionFrom(initial, targetId, "TAKE_HIT");
  const result = bangEffect(inputFor(state, actorId, bangId, targetRef, [response]));
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(state, before);
  assert.equal(state.turn.bangCardPlaysThisTurn, 1);
  assert.ok(state.seats.find((seat) => seat.public.playerId === actorId)!.private.handCardInstanceIds.includes(bangId));
  assert.equal(result.steps[0]?.targetPlayerId, targetId);
});

test("BANG rejects a missing, self, dead, or malformed target without mutation", () => {
  const state = makeState();
  const actorId = state.seats[0]!.public.playerId;
  const targetId = state.seats[1]!.public.playerId;
  const bangId = moveCardToHand(state, "bang", actorId);
  state.seats[2]!.public.eliminated = true;
  const before = structuredClone(state);

  assert.equal(bangEffect(inputFor(state, actorId, bangId)).kind, "target_required");
  assert.deepEqual(
    bangEffect(inputFor(state, actorId, bangId, [{ kind: "player", playerId: actorId }])),
    { kind: "invalid_target", code: "TARGET_IS_SELF" },
  );
  assert.deepEqual(
    bangEffect(inputFor(state, actorId, bangId, [{ kind: "player", playerId: state.seats[2]!.public.playerId }])),
    { kind: "invalid_target", code: "TARGET_NOT_ALIVE" },
  );
  assert.deepEqual(
    bangEffect(inputFor(state, actorId, bangId, [
      { kind: "player", playerId: targetId },
      { kind: "player", playerId: state.seats[3]!.public.playerId },
    ])),
    { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" },
  );
  assert.deepEqual(state, before);
});

test("Beer heals its user by at most one and never targets another player", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const beerId = moveCardToHand(state, "beer", actor.public.playerId);
  actor.public.hp = 2;
  const before = structuredClone(state);

  const healed = beerEffect(inputFor(state, actor.public.playerId, beerId));
  assert.equal(healed.kind, "applied");
  if (healed.kind !== "applied") return;
  assert.deepEqual(healed.events[0]?.payload, { cardInstanceId: beerId, mode: "normal", healed: 1 });
  assert.deepEqual(healed.steps, [{
    effectId: `frame-basic-action-1:heal_player:${beerId}`,
    kind: "HEAL_PLAYER",
    sourcePlayerId: actor.public.playerId,
    targetPlayerId: actor.public.playerId,
    sourceCardInstanceId: beerId,
    payload: { amount: 1, cause: "BEER", rescue: false },
  }]);
  assert.deepEqual(state, before);

  assert.deepEqual(
    beerEffect(inputFor(state, actor.public.playerId, beerId, [{ kind: "player", playerId: state.seats[1]!.public.playerId }])),
    { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" },
  );
});

test("Beer at maximum HP or with two living players is used but does not heal", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const beerId = moveCardToHand(state, "beer", actor.public.playerId);

  const atMaximum = beerEffect(inputFor(state, actor.public.playerId, beerId));
  assert.equal(atMaximum.kind, "applied");
  if (atMaximum.kind !== "applied") return;
  assert.deepEqual(atMaximum.events[0]?.payload, { cardInstanceId: beerId, mode: "normal", healed: 0 });
  assert.deepEqual(atMaximum.steps, []);

  state.seats[2]!.public.eliminated = true;
  state.seats[3]!.public.eliminated = true;
  actor.public.hp = actor.public.maxHp - 1;
  const twoPlayers = beerEffect(inputFor(state, actor.public.playerId, beerId));
  assert.equal(twoPlayers.kind, "applied");
  if (twoPlayers.kind !== "applied") return;
  assert.deepEqual(twoPlayers.events[0]?.payload, { cardInstanceId: beerId, mode: "normal", healed: 0 });
  assert.deepEqual(twoPlayers.steps, []);
});

function rescueResponse(playerId: string, cardInstanceId: string): CompletedEffectInteraction {
  return {
    interactionId: "rescue-1",
    kind: "DEATH_RESCUE",
    context: { damage: 1 },
    responses: [{ playerId, choice: "USE_BEER", payload: { cardInstanceId } }],
  };
}

test("Beer in a multi-player death rescue restores one HP through the saved response", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const beerId = moveCardToHand(state, "beer", actor.public.playerId);
  actor.public.hp = 0;
  state.resolution.pendingDeath = {
    victimPlayerId: actor.public.playerId,
    sourcePlayerId: state.seats[1]!.public.playerId,
    rescueResponderIds: [actor.public.playerId],
    rescueCursor: 1,
    consequenceStage: "rescue",
    resumeFrameId: "frame-basic-action-1",
  };
  const response = rescueResponse(actor.public.playerId, beerId);

  const result = beerEffect(inputFor(state, actor.public.playerId, beerId, [], [response]));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events[0]?.payload, { cardInstanceId: beerId, mode: "death_rescue", healed: 1 });
  assert.equal(result.steps[0]?.kind, "HEAL_PLAYER");
  assert.equal(result.steps[0]?.targetPlayerId, actor.public.playerId);
  assert.deepEqual(result.steps[0]?.payload, { amount: 1, cause: "BEER", rescue: true });
});

test("each Beer in a rescue advances HP by one until the victim is positive", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const firstBeerId = moveCardToHand(state, "beer", actor.public.playerId);
  const firstBeerDefinition = state.zones.cardsByInstanceId[firstBeerId]!.cardDefinitionId;
  const secondBeer = Object.values(state.zones.cardsByInstanceId).find((instance) => {
    const physical = BASE_PHYSICAL_CARDS.find((card) => card.definitionId === instance.cardDefinitionId);
    return physical?.typeId === "beer" && instance.cardDefinitionId !== firstBeerDefinition;
  });
  assert.ok(secondBeer);
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter(
    (cardInstanceId) => cardInstanceId !== secondBeer.cardInstanceId,
  );
  actor.private.handCardInstanceIds.push(secondBeer.cardInstanceId);
  actor.public.hp = -1;
  state.resolution.pendingDeath = {
    victimPlayerId: actor.public.playerId,
    sourcePlayerId: state.seats[1]!.public.playerId,
    rescueResponderIds: [actor.public.playerId],
    rescueCursor: 1,
    consequenceStage: "rescue",
    resumeFrameId: "frame-basic-action-1",
  };

  const first = beerEffect(inputFor(
    state,
    actor.public.playerId,
    firstBeerId,
    [],
    [rescueResponse(actor.public.playerId, firstBeerId)],
  ));
  assert.equal(first.kind, "applied");
  if (first.kind !== "applied") return;
  assert.equal(first.steps[0]?.payload.amount, 1);
  actor.public.hp += Number(first.steps[0]?.payload.amount);
  assert.equal(actor.public.hp, 0);

  const second = beerEffect(inputFor(
    state,
    actor.public.playerId,
    secondBeer.cardInstanceId,
    [],
    [rescueResponse(actor.public.playerId, secondBeer.cardInstanceId)],
  ));
  assert.equal(second.kind, "applied");
  if (second.kind !== "applied") return;
  assert.equal(second.steps[0]?.payload.amount, 1);
  actor.public.hp += Number(second.steps[0]?.payload.amount);
  assert.equal(actor.public.hp, 1);
});

test("Beer can be spent during a two-player rescue but does not heal or rescue", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const beerId = moveCardToHand(state, "beer", actor.public.playerId);
  actor.public.hp = 0;
  state.seats[2]!.public.eliminated = true;
  state.seats[3]!.public.eliminated = true;
  state.resolution.pendingDeath = {
    victimPlayerId: actor.public.playerId,
    sourcePlayerId: state.seats[1]!.public.playerId,
    rescueResponderIds: [actor.public.playerId],
    rescueCursor: 1,
    consequenceStage: "rescue",
    resumeFrameId: "frame-basic-action-1",
  };
  const response = rescueResponse(actor.public.playerId, beerId);
  const before = structuredClone(state);

  const result = beerEffect(inputFor(state, actor.public.playerId, beerId, [], [response]));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events, [{
    type: "BEER_USED",
    actorPlayerId: actor.public.playerId,
    payload: { cardInstanceId: beerId, mode: "death_rescue", healed: 0 },
  }]);
  assert.deepEqual(result.steps, []);
  assert.equal(state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(actor.public.hp, 0);
  assert.deepEqual(state, before);
});

test("basic action outcomes are deterministic and do not consume RNG or mutate input", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const target = state.seats[1]!;
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  target.private.handCardInstanceIds = [];
  actor.public.hp -= 1;
  const beerId = moveCardToHand(state, "beer", actor.public.playerId);
  const before = structuredClone(state);
  let randomCalls = 0;
  const random: RandomSource = { nextFloat: () => { randomCalls += 1; return 0.5; } };
  const bangInput = inputFor(state, actor.public.playerId, bangId, [{ kind: "player", playerId: target.public.playerId }], [], random);
  const beerInput = inputFor(state, actor.public.playerId, beerId, [], [], random);

  assert.deepEqual(bangEffect(bangInput), bangEffect(bangInput));
  assert.deepEqual(beerEffect(beerInput), beerEffect(beerInput));
  assert.equal(randomCalls, 0);
  assert.deepEqual(state, before);
});
