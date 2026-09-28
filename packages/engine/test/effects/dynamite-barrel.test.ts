import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import { dynamiteInstallEffect, dynamiteStartEffect, resolveBarrelCheckStep } from "../../src/effects/cards/dynamite-barrel.ts";
import { gatlingEffect } from "../../src/effects/cards/tablewide.ts";
import type {
  CardEffectInput,
  CardEffectResult,
  CompletedEffectInteraction,
  DeepReadonly,
  EffectTarget,
} from "../../src/effects/api.ts";
import type { EffectStep, GameState, SeatState } from "../../src/state/types.ts";

function noRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("this judgment path should not need randomness"); } };
}

function sequenceRandom(values: readonly number[]): { readonly random: RandomSource; readonly calls: () => number } {
  let cursor = 0;
  return {
    random: {
      nextFloat() {
        const value = values[cursor];
        if (value === undefined) throw new Error("fixed random sequence exhausted");
        cursor += 1;
        return value;
      },
    },
    calls: () => cursor,
  };
}

function playersFor(count = 4): SetupPlayer[] {
  return Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
}

function stateFor(count = 4): GameState {
  return initializeGame({ players: playersFor(count), random: { nextFloat: () => 0 } });
}

function seatAt(state: GameState, seatIndex: number): SeatState {
  const seat = state.seats.find((entry) => entry.public.seatIndex === seatIndex);
  assert.ok(seat, `missing seat ${seatIndex}`);
  return seat;
}

function physicalCardId(state: GameState, typeId: string, copy = 0): string {
  const definition = BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId)[copy];
  assert.ok(definition, `missing ${typeId} card copy ${copy}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (card) => card.cardDefinitionId === definition.definitionId,
  );
  assert.ok(instance, `missing runtime card for ${definition.definitionId}`);
  return instance.cardInstanceId;
}

function cardForFace(state: GameState, suit: string, rank: number | string): string {
  const definition = BASE_PHYSICAL_CARDS.find((card) => card.suit === suit && card.rank === rank);
  assert.ok(definition, `missing physical card ${suit} ${rank}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (card) => card.cardDefinitionId === definition.definitionId,
  );
  assert.ok(instance, `missing runtime card for ${definition.definitionId}`);
  return instance.cardInstanceId;
}

function moveCard(
  state: GameState,
  cardInstanceId: string,
  destination:
    | { readonly zone: "hand" | "in_play"; readonly playerId: string }
    | { readonly zone: "discard" }
    | { readonly zone: "draw_top" },
): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);

  if (destination.zone === "discard") {
    state.zones.discardPileCardInstanceIds.push(cardInstanceId);
  } else if (destination.zone === "draw_top") {
    state.zones.drawPileCardInstanceIds.unshift(cardInstanceId);
  } else {
    const owner = state.seats.find((seat) => seat.public.playerId === destination.playerId);
    assert.ok(owner, `missing player ${destination.playerId}`);
    if (destination.zone === "hand") owner.private.handCardInstanceIds.push(cardInstanceId);
    else owner.public.inPlayCardInstanceIds.push(cardInstanceId);
  }
}

function inputFor(
  state: GameState,
  actorPlayerId: string,
  sourceCardInstanceId: string | null,
  options: {
    readonly targets?: readonly EffectTarget[];
    readonly completedInteractions?: readonly CompletedEffectInteraction[];
    readonly random?: RandomSource;
    readonly continuationFrameId?: string;
  } = {},
): CardEffectInput {
  return {
    state: state as DeepReadonly<GameState>,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: options.continuationFrameId ?? "frame-dynamite-barrel-1",
    targets: options.targets ?? [],
    random: options.random ?? noRandom(),
    completedInteractions: options.completedInteractions ?? [],
  };
}

function playerTarget(playerId: string): readonly EffectTarget[] {
  return [{ kind: "player", playerId }];
}

let nextInteractionId = 1;

function responseFrom(
  result: CardEffectResult,
  playerId: string,
  choice: string,
  payload: Record<string, string> = {},
): CompletedEffectInteraction {
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") throw new Error("expected response_required");
  return {
    interactionId: `${result.request.kind}-answer-${nextInteractionId++}`,
    kind: result.request.kind,
    context: result.request.context,
    responses: [{ playerId, choice, payload }],
  };
}

function barrelStep(
  sourcePlayerId: string,
  targetPlayerId: string,
  sourceCardInstanceId: string,
  attackKind: "BANG" | "GATLING",
  defenseSource: "barrel" | "jourdonnais",
): EffectStep {
  return {
    effectId: `frame-dynamite-barrel-1:barrel-check:${targetPlayerId}:${defenseSource}`,
    kind: "BARREL_CHECK",
    sourcePlayerId,
    targetPlayerId,
    sourceCardInstanceId,
    payload: {
      attackKind,
      defenseSource,
      targetStepId: `frame-dynamite-barrel-1:${sourceCardInstanceId}:${attackKind.toLowerCase()}:${targetPlayerId}`,
    },
  };
}

function interactionForBarrelStep(
  step: EffectStep,
  continuationFrameId: string,
  playerId: string,
  choice: string,
  payload: Record<string, string> = {},
  barrelProgress?: { readonly successfulMisses: number; readonly attemptedDefenseSources: readonly string[] },
  requiredMisses: 1 | 2 = 1,
): CompletedEffectInteraction {
  return {
    interactionId: `${choice}-${step.effectId}`,
    kind: step.payload.attackKind === "GATLING" ? "GATLING_RESPONSE" : "BANG_RESPONSE",
    context: {
      continuationFrameId,
      sourcePlayerId: step.sourcePlayerId,
      targetPlayerId: step.targetPlayerId,
      sourceCardInstanceId: step.sourceCardInstanceId,
      targetStepId: step.payload.targetStepId,
      requiredMisses,
      ...(barrelProgress ? { barrelProgress: {
        successfulMisses: barrelProgress.successfulMisses,
        attemptedDefenseSources: [...barrelProgress.attemptedDefenseSources],
      } } : {}),
    },
    responses: [{ playerId, choice, payload }],
  };
}

function resolveBarrel(
  state: GameState,
  step: EffectStep,
  interactions: readonly CompletedEffectInteraction[],
  random: RandomSource = noRandom(),
): CardEffectResult {
  return resolveBarrelCheckStep({
    state,
    step,
    continuationFrameId: "frame-dynamite-barrel-1",
    completedInteractions: interactions,
    random,
  });
}

function dynamiteOnPlayer(state: GameState, playerId: string): string {
  const id = physicalCardId(state, "dynamite");
  moveCard(state, id, { zone: "in_play", playerId });
  return id;
}

test("Dynamite installs from its owner's hand without judging or consuming RNG", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const dynamiteId = physicalCardId(state, "dynamite");
  moveCard(state, dynamiteId, { zone: "hand", playerId: actor.public.playerId });
  const before = structuredClone(state);
  const rng = sequenceRandom([]);

  const result = dynamiteInstallEffect(inputFor(state, actor.public.playerId, dynamiteId, { random: rng.random }));

  assert.deepEqual(result, {
    kind: "applied",
    events: [{
      type: "CARD_TRANSFERRED",
      actorPlayerId: actor.public.playerId,
      payload: {
        sourceCardInstanceId: dynamiteId,
        cardInstanceId: dynamiteId,
        fromPlayerId: actor.public.playerId,
        fromZone: "hand",
        toPlayerId: actor.public.playerId,
        toZone: "in_play",
      },
    }],
    steps: [],
  });
  assert.equal(rng.calls(), 0);
  assert.deepEqual(state, before, "the install returns an event draft and leaves turn-start judgment for later");
});

test("Dynamite installation rejects wrong source, owner, target, and nonliving or ambiguous actors", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const other = seatAt(state, 1);
  const dynamiteId = physicalCardId(state, "dynamite");
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, dynamiteId, { zone: "hand", playerId: other.public.playerId });
  moveCard(state, barrelId, { zone: "hand", playerId: actor.public.playerId });
  const before = structuredClone(state);

  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, null)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, barrelId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, dynamiteId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  }, "a Dynamite card in another player's hand cannot be installed by this actor");
  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, barrelId, {
    targets: playerTarget(other.public.playerId),
  })), {
    kind: "invalid_target", code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(state, before);

  moveCard(state, dynamiteId, { zone: "hand", playerId: actor.public.playerId });
  actor.public.eliminated = true;
  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, dynamiteId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALIVE",
  });

  actor.public.eliminated = false;
  actor.public.hp = 0;
  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, dynamiteId)), {
    kind: "invalid_target", code: "TARGET_NOT_ALIVE",
  });

  actor.public.hp = 4;
  state.seats.push(structuredClone(actor));
  assert.deepEqual(dynamiteInstallEffect(inputFor(state, actor.public.playerId, dynamiteId)), {
    kind: "invalid_target", code: "TARGET_NOT_FOUND",
  });
});

test("Dynamite explodes on Spade 2 and 9, discards before damage, and has no responsible attacker", () => {
  for (const rank of [2, 9]) {
    const state = stateFor();
    const actor = seatAt(state, 0);
    const dynamiteId = dynamiteOnPlayer(state, actor.public.playerId);
    const judgmentId = cardForFace(state, "SPADES", rank);
    moveCard(state, judgmentId, { zone: "draw_top" });
    const before = structuredClone(state);

    const result = dynamiteStartEffect(inputFor(state, actor.public.playerId, dynamiteId));

    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") continue;
    assert.deepEqual(result.events.map((item) => item.type), [
      "DYNAMITE_JUDGMENT_REVEALED",
      "CARD_DISCARDED",
      "CARD_DISCARDED",
      "DYNAMITE_EXPLODED",
    ]);
    assert.equal(result.events[2]?.payload.cardInstanceId, dynamiteId);
    assert.equal(result.events[3]?.actorPlayerId, null);
    assert.equal(result.events[3]?.payload.responsiblePlayerId, null);
    assert.deepEqual(result.steps, [{
      effectId: `frame-dynamite-barrel-1:dynamite-damage:${dynamiteId}`,
      kind: "DAMAGE_PLAYER",
      sourcePlayerId: null,
      targetPlayerId: actor.public.playerId,
      sourceCardInstanceId: dynamiteId,
      payload: { amount: 3, cause: "DYNAMITE" },
    }]);
    assert.deepEqual(state, before, "judgment, Dynamite discard and damage remain drafts");
  }
});

test("Spade 10 and Ace pass Dynamite to the next living seat without damage", () => {
  for (const rank of [10, "A"] as const) {
    const state = stateFor(5);
    const actor = seatAt(state, 0);
    const next = seatAt(state, 2);
    seatAt(state, 1).public.eliminated = true;
    const dynamiteId = dynamiteOnPlayer(state, actor.public.playerId);
    const judgmentId = cardForFace(state, "SPADES", rank);
    moveCard(state, judgmentId, { zone: "draw_top" });
    const before = structuredClone(state);

    const result = dynamiteStartEffect(inputFor(state, actor.public.playerId, dynamiteId));

    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") continue;
    assert.deepEqual(result.events.map((item) => item.type), [
      "DYNAMITE_JUDGMENT_REVEALED",
      "CARD_DISCARDED",
      "CARD_TRANSFERRED",
      "DYNAMITE_PASSED",
    ]);
    assert.equal(result.events[2]?.payload.toPlayerId, next.public.playerId);
    assert.equal(result.events[2]?.payload.fromZone, "in_play");
    assert.equal(result.steps.length, 0);
    assert.deepEqual(state, before);
  }
});

test("Dynamite judgment reshuffles the discard deterministically without mutating input", () => {
  const base = stateFor();
  const actor = seatAt(base, 0);
  const dynamiteId = dynamiteOnPlayer(base, actor.public.playerId);
  const discardIds = base.zones.drawPileCardInstanceIds.slice(0, 5);
  for (const id of discardIds) moveCard(base, id, { zone: "discard" });
  base.zones.drawPileCardInstanceIds = [];
  const snapshot = structuredClone(base);
  const randomValues = [0.17, 0.66, 0.13, 0.91];
  const leftRng = sequenceRandom(randomValues);
  const rightRng = sequenceRandom(randomValues);

  const first = dynamiteStartEffect(inputFor(base, actor.public.playerId, dynamiteId, { random: leftRng.random }));
  const second = dynamiteStartEffect(inputFor(snapshot, actor.public.playerId, dynamiteId, { random: rightRng.random }));

  assert.deepEqual(first, second);
  assert.equal(leftRng.calls(), 4);
  assert.equal(rightRng.calls(), 4);
  assert.equal(first.kind, "applied");
  if (first.kind === "applied") assert.equal(first.events[0]?.type, "DRAW_PILE_RESHUFFLED");
  assert.deepEqual(base, snapshot);
});

test("empty draw and discard piles pause under D05 without consuming Dynamite", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const dynamiteId = dynamiteOnPlayer(state, actor.public.playerId);
  for (const id of [...state.zones.drawPileCardInstanceIds, ...state.zones.discardPileCardInstanceIds]) {
    moveCard(state, id, { zone: "hand", playerId: actor.public.playerId });
  }
  state.zones.drawPileCardInstanceIds = [];
  state.zones.discardPileCardInstanceIds = [];
  const before = structuredClone(state);

  const result = dynamiteStartEffect(inputFor(state, actor.public.playerId, dynamiteId));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events, [{
    type: "RULE_RESOURCE_EXHAUSTED",
    actorPlayerId: actor.public.playerId,
    payload: {
      sourceCardInstanceId: dynamiteId,
      cardTypeId: "dynamite",
      requestedCount: 1,
      fulfilledCount: 0,
      status: "paused",
      pauseReason: "RULE_RESOURCE_EXHAUSTED",
    },
  }]);
  assert.deepEqual(result.steps, []);
  assert.deepEqual(state, before);
});

test("Dynamite only resolves in the current player's start phase", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const dynamiteId = dynamiteOnPlayer(state, actor.public.playerId);
  state.turn.phase = "draw";
  const before = structuredClone(state);

  assert.deepEqual(dynamiteStartEffect(inputFor(state, actor.public.playerId, dynamiteId)), {
    kind: "invalid_target",
    code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(state, before);
});

test("Barrel Heart cancels the serialized T18 Gatling step without Slab strengthening", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  actor.public.characterId = "slab_the_killer";
  target.public.inPlayCardInstanceIds = [];
  const gatlingId = physicalCardId(state, "gatling");
  moveCard(state, gatlingId, { zone: "discard" });
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const heartId = cardForFace(state, "HEARTS", 2);
  moveCard(state, heartId, { zone: "draw_top" });
  const initial = gatlingEffect(inputFor(state, actor.public.playerId, gatlingId, {
    targets: playerTarget(target.public.playerId),
  }));
  const firstAnswer = responseFrom(initial, target.public.playerId, "USE_BARREL");
  const selected = gatlingEffect(inputFor(state, actor.public.playerId, gatlingId, {
    targets: playerTarget(target.public.playerId),
    completedInteractions: [firstAnswer],
  }));
  assert.equal(selected.kind, "applied");
  if (selected.kind !== "applied") return;
  const step = selected.steps[0]!;
  const before = structuredClone(state);

  const resolved = resolveBarrel(state, step, [firstAnswer]);

  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") return;
  assert.deepEqual(resolved.events.map((item) => item.type), [
    "BARREL_JUDGMENT_REVEALED",
    "CARD_DISCARDED",
    "BARREL_CHECK_RESOLVED",
    "GATLING_MISSED",
  ]);
  assert.equal(resolved.events[2]?.payload.succeeded, true);
  assert.deepEqual(resolved.steps, [], "Gatling stays at one Missed even when its user is Slab");
  assert.deepEqual(state, before);
});

test("Barrel step rejects a forged response from a player other than the target", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  const forgedResponder = seatAt(state, 2);
  const gatlingId = physicalCardId(state, "gatling");
  moveCard(state, gatlingId, { zone: "discard" });
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const step = barrelStep(actor.public.playerId, target.public.playerId, gatlingId, "GATLING", "barrel");
  const forged = interactionForBarrelStep(
    step,
    "frame-dynamite-barrel-1",
    forgedResponder.public.playerId,
    "USE_BARREL",
  );
  const before = structuredClone(state);

  assert.deepEqual(resolveBarrel(state, step, [forged]), {
    kind: "invalid_target",
    code: "TARGET_NOT_ALLOWED",
  });
  assert.deepEqual(state, before, "a forged response cannot consume the judgment card or mutate state");
});

test("failed Gatling Barrel check permits Missed or hit and cannot retry that Barrel", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  target.public.characterId = "jourdonnais";
  target.public.inPlayCardInstanceIds = [];
  const gatlingId = physicalCardId(state, "gatling");
  moveCard(state, gatlingId, { zone: "discard" });
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const missedId = physicalCardId(state, "missed");
  moveCard(state, missedId, { zone: "hand", playerId: target.public.playerId });
  const spadeTen = cardForFace(state, "SPADES", 10);
  moveCard(state, spadeTen, { zone: "draw_top" });
  const step = barrelStep(actor.public.playerId, target.public.playerId, gatlingId, "GATLING", "barrel");
  const selected = interactionForBarrelStep(step, "frame-dynamite-barrel-1", target.public.playerId, "USE_BARREL");
  const before = structuredClone(state);

  const failed = resolveBarrel(state, step, [selected]);

  assert.equal(failed.kind, "response_required");
  if (failed.kind !== "response_required") return;
  assert.deepEqual(failed.request.responders[0]?.options, [
    { choice: "USE_MISSED", payload: { cardInstanceId: missedId } },
    { choice: "USE_JOURDONNAIS", payload: {} },
    { choice: "TAKE_HIT", payload: {} },
  ], "the failed source is excluded while the other source remains available");
  assert.deepEqual(state, before);

  const missedResponse = responseFrom(failed, target.public.playerId, "USE_MISSED", { cardInstanceId: missedId });
  const defended = resolveBarrel(state, step, [selected, missedResponse]);
  assert.equal(defended.kind, "applied");
  if (defended.kind === "applied") {
    assert.deepEqual(defended.events.map((item) => item.type), ["CARD_DISCARDED", "GATLING_MISSED"]);
    assert.deepEqual(defended.steps, []);
  }

  const hitResponse = responseFrom(failed, target.public.playerId, "TAKE_HIT");
  const hit = resolveBarrel(state, step, [selected, hitResponse]);
  assert.equal(hit.kind, "applied");
  if (hit.kind === "applied") {
    assert.equal(hit.steps[0]?.kind, "DAMAGE_PLAYER");
    assert.equal(hit.steps[0]?.sourcePlayerId, actor.public.playerId);
    assert.equal(hit.steps[0]?.targetPlayerId, target.public.playerId);
    assert.deepEqual(hit.steps[0]?.payload, { amount: 1, cause: "GATLING" });
  }

  const retry = interactionForBarrelStep(step, "frame-dynamite-barrel-1", target.public.playerId, "USE_BARREL", {}, {
    successfulMisses: 0,
    attemptedDefenseSources: ["barrel"],
  });
  assert.deepEqual(resolveBarrel(state, step, [selected, retry]), {
    kind: "invalid_target",
    code: "TARGET_NOT_ALLOWED",
  });
});

test("Slab BANG needs a second Missed after a successful Barrel check", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  actor.public.characterId = "slab_the_killer";
  const target = seatAt(state, 1);
  const bangId = physicalCardId(state, "bang");
  moveCard(state, bangId, { zone: "discard" });
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const missedId = physicalCardId(state, "missed");
  moveCard(state, missedId, { zone: "hand", playerId: target.public.playerId });
  const heartId = cardForFace(state, "HEARTS", 3);
  moveCard(state, heartId, { zone: "draw_top" });
  const step = barrelStep(actor.public.playerId, target.public.playerId, bangId, "BANG", "barrel");
  const selected = interactionForBarrelStep(step, "frame-dynamite-barrel-1", target.public.playerId, "USE_BARREL", {}, undefined, 2);

  const oneDefense = resolveBarrel(state, step, [selected]);

  assert.equal(oneDefense.kind, "response_required");
  if (oneDefense.kind !== "response_required") return;
  assert.deepEqual(oneDefense.request.responders[0]?.options, [
    { choice: "USE_MISSED", payload: { cardInstanceId: missedId } },
    { choice: "TAKE_HIT", payload: {} },
  ]);
  const progress = oneDefense.request.context.barrelProgress as {
    successfulMisses: number;
    attemptedDefenseSources: string[];
  };
  assert.equal(progress.successfulMisses, 1);
  assert.deepEqual(progress.attemptedDefenseSources, ["barrel"]);

  const missedResponse = responseFrom(oneDefense, target.public.playerId, "USE_MISSED", { cardInstanceId: missedId });
  const defended = resolveBarrel(state, step, [selected, missedResponse]);
  assert.equal(defended.kind, "applied");
  if (defended.kind === "applied") {
    assert.deepEqual(defended.events.map((item) => item.type), ["CARD_DISCARDED", "BANG_MISSED"]);
    assert.deepEqual(defended.steps, []);
  }
});

test("Barrel and Jourdonnais may each test once against Slab and together satisfy two defenses", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  actor.public.characterId = "slab_the_killer";
  const target = seatAt(state, 1);
  target.public.characterId = "jourdonnais";
  const bangId = physicalCardId(state, "bang");
  moveCard(state, bangId, { zone: "discard" });
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const firstHeart = cardForFace(state, "HEARTS", 4);
  const secondHeart = cardForFace(state, "HEARTS", 5);
  moveCard(state, firstHeart, { zone: "draw_top" });
  moveCard(state, secondHeart, { zone: "draw_top" });
  const barrelAttempt = barrelStep(actor.public.playerId, target.public.playerId, bangId, "BANG", "barrel");
  const firstResponse = interactionForBarrelStep(barrelAttempt, "frame-dynamite-barrel-1", target.public.playerId, "USE_BARREL", {}, undefined, 2);

  const firstCheck = resolveBarrel(state, barrelAttempt, [firstResponse]);
  assert.equal(firstCheck.kind, "response_required");
  if (firstCheck.kind !== "response_required") return;
  assert.deepEqual(firstCheck.request.responders[0]?.options, [
    { choice: "USE_JOURDONNAIS", payload: {} },
    { choice: "TAKE_HIT", payload: {} },
  ]);

  const jourdonnaisStep = barrelStep(actor.public.playerId, target.public.playerId, bangId, "BANG", "jourdonnais");
  const secondResponse = responseFrom(firstCheck, target.public.playerId, "USE_JOURDONNAIS");
  const secondCheck = resolveBarrel(state, jourdonnaisStep, [firstResponse, secondResponse]);

  assert.equal(secondCheck.kind, "applied");
  if (secondCheck.kind === "applied") {
    assert.equal(secondCheck.events.at(-1)?.type, "BANG_MISSED");
    assert.deepEqual(secondCheck.steps, []);
  }
});

test("Barrel does not prevent Dynamite damage", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const dynamiteId = dynamiteOnPlayer(state, actor.public.playerId);
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: actor.public.playerId });
  const spadeTwo = cardForFace(state, "SPADES", 2);
  moveCard(state, spadeTwo, { zone: "draw_top" });

  const result = dynamiteStartEffect(inputFor(state, actor.public.playerId, dynamiteId));

  assert.equal(result.kind, "applied");
  if (result.kind === "applied") {
    assert.equal(result.steps.length, 1);
    assert.equal(result.steps[0]?.payload.cause, "DYNAMITE");
    assert.equal(result.steps[0]?.payload.amount, 3);
  }
});
