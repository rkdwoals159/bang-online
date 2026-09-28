import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import {
  gatlingEffect,
  indiansEffect,
  saloonEffect,
} from "../../src/effects/cards/tablewide.ts";
import type {
  CardEffectInput,
  CardEffectResult,
  CompletedEffectInteraction,
  DeepReadonly,
  EffectTarget,
} from "../../src/effects/api.ts";
import {
  beginEffectResolution,
  canCheckVictory,
  completeDeathCleanup,
  completeEffectStep,
  finishEffectResolution,
} from "../../src/resolution/index.ts";
import type { GameState, SeatState } from "../../src/state/types.ts";

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("table-wide effects must not consume randomness here"); } };
}

function stateFor(count = 4): GameState {
  const players: SetupPlayer[] = Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  state.turn.phase = "play";
  return state;
}

function seatAt(state: GameState, seatIndex: number): SeatState {
  const seat = state.seats.find((entry) => entry.public.seatIndex === seatIndex);
  assert.ok(seat, `missing seat ${seatIndex}`);
  return seat;
}

function physicalCardId(state: GameState, typeId: string, copy = 0): string {
  const definition = BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId)[copy];
  assert.ok(definition, `missing catalog card ${typeId} copy ${copy}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (card) => card.cardDefinitionId === definition.definitionId,
  );
  assert.ok(instance, `missing runtime card ${definition.definitionId}`);
  return instance.cardInstanceId;
}

function moveCard(
  state: GameState,
  cardInstanceId: string,
  destination: { readonly zone: "hand" | "in_play"; readonly playerId: string } | { readonly zone: "discard" },
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
    return;
  }
  const owner = state.seats.find((seat) => seat.public.playerId === destination.playerId);
  assert.ok(owner, `missing player ${destination.playerId}`);
  if (destination.zone === "hand") owner.private.handCardInstanceIds.push(cardInstanceId);
  else owner.public.inPlayCardInstanceIds.push(cardInstanceId);
}

function sourceCard(state: GameState, typeId: "gatling" | "indians" | "saloon", copy = 0): string {
  const id = physicalCardId(state, typeId, copy);
  moveCard(state, id, { zone: "discard" });
  return id;
}

function inputFor(
  state: GameState,
  sourceCardInstanceId: string,
  targets: readonly EffectTarget[] = [],
  options: {
    readonly actorPlayerId?: string;
    readonly completedInteractions?: readonly CompletedEffectInteraction[];
  } = {},
): CardEffectInput {
  return {
    state: state as DeepReadonly<GameState>,
    actorPlayerId: options.actorPlayerId ?? seatAt(state, 0).public.playerId,
    sourceCardInstanceId,
    continuationFrameId: "frame-tablewide-1",
    targets,
    random: unusedRandom(),
    completedInteractions: options.completedInteractions ?? [],
  };
}

function playerTarget(playerId: string): readonly EffectTarget[] {
  return [{ kind: "player", playerId }];
}

function completedResponse(
  result: CardEffectResult,
  playerId: string,
  choice: string,
  payload: Record<string, string> = {},
): CompletedEffectInteraction {
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") throw new Error("expected a response request");
  return {
    interactionId: `${result.request.kind}-answer`,
    kind: result.request.kind,
    context: result.request.context,
    responses: [{ playerId, choice, payload }],
  };
}

test("Gatling and Indians queue all living opponents clockwise after the user", () => {
  const state = stateFor(5);
  const actor = seatAt(state, 2);
  seatAt(state, 0).public.eliminated = true;
  state.turn.bangCardPlaysThisTurn = 1;
  const expected = [seatAt(state, 3), seatAt(state, 4), seatAt(state, 1)].map((seat) => seat.public.playerId);
  const gatlingId = sourceCard(state, "gatling");
  const indiansId = sourceCard(state, "indians");
  const quotaBefore = state.turn.bangCardPlaysThisTurn;
  const before = structuredClone(state);

  const gatling = gatlingEffect(inputFor(state, gatlingId, [], { actorPlayerId: actor.public.playerId }));
  const indians = indiansEffect(inputFor(state, indiansId, [], { actorPlayerId: actor.public.playerId }));

  for (const result of [gatling, indians]) {
    assert.equal(result.kind, "applied");
    if (result.kind !== "applied") continue;
    assert.deepEqual(result.steps.map((step) => step.targetPlayerId), expected);
    assert.ok(result.steps.every((step) => step.payload.deferVictoryCheckUntilQueueEnds === true));
  }
  assert.deepEqual(gatling.kind === "applied" ? gatling.events[0]?.payload.targetPlayerIds : undefined, expected);
  assert.deepEqual(indians.kind === "applied" ? indians.events[0]?.payload.targetPlayerIds : undefined, expected);
  assert.equal(state.turn.bangCardPlaysThisTurn, quotaBefore, "table-wide cards do not consume BANG quota");
  assert.deepEqual(state, before, "building the queue leaves the full snapshot unchanged");
});

test("Gatling offers one Missed plus available Barrel and Jourdonnais responses", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  target.public.characterId = "jourdonnais";
  target.public.inPlayCardInstanceIds = [];
  const sourceId = sourceCard(state, "gatling");
  const missedId = physicalCardId(state, "missed");
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, missedId, { zone: "hand", playerId: target.public.playerId });
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const before = structuredClone(state);

  const result = gatlingEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
  }));

  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") return;
  assert.equal(result.request.kind, "GATLING_RESPONSE");
  assert.deepEqual(result.request.responders[0]?.options, [
    { choice: "USE_MISSED", payload: { cardInstanceId: missedId } },
    { choice: "USE_BARREL", payload: {} },
    { choice: "USE_JOURDONNAIS", payload: {} },
    { choice: "TAKE_HIT", payload: {} },
  ]);
  assert.equal(result.request.context.targetStepId, `frame-tablewide-1:${sourceId}:gatling:target:${target.public.playerId}`);
  assert.deepEqual(state, before);
});

test("one Missed defeats Gatling even for Slab and the effect emits no damage", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  target.public.characterId = "slab_the_killer";
  target.public.inPlayCardInstanceIds = [];
  const sourceId = sourceCard(state, "gatling");
  const missedId = physicalCardId(state, "missed");
  moveCard(state, missedId, { zone: "hand", playerId: target.public.playerId });
  const initial = gatlingEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
  }));
  const response = completedResponse(initial, target.public.playerId, "USE_MISSED", { cardInstanceId: missedId });
  const before = structuredClone(state);

  const resolved = gatlingEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [response],
  }));

  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") return;
  assert.deepEqual(resolved.events.map((event) => event.type), ["CARD_DISCARDED", "GATLING_MISSED"]);
  assert.deepEqual(resolved.steps, []);
  assert.deepEqual(state, before, "card movement remains a reducer responsibility");
});

test("Gatling delegates Barrel and Jourdonnais checks to a serialized check step", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  target.public.characterId = "jourdonnais";
  target.public.inPlayCardInstanceIds = [];
  const sourceId = sourceCard(state, "gatling");
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  const initial = gatlingEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
  }));
  const response = completedResponse(initial, target.public.playerId, "USE_BARREL");
  const before = structuredClone(state);

  const resolved = gatlingEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [response],
  }));

  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") return;
  assert.deepEqual(resolved.events, [{
    type: "BARREL_CHECK_REQUESTED",
    actorPlayerId: target.public.playerId,
    payload: {
      attackKind: "GATLING",
      defenseSource: "barrel",
      sourceCardInstanceId: sourceId,
      targetPlayerId: target.public.playerId,
    },
  }]);
  assert.equal(resolved.steps.length, 1);
  assert.equal(resolved.steps[0]?.kind, "BARREL_CHECK");
  assert.equal(resolved.steps[0]?.targetPlayerId, target.public.playerId);
  assert.equal(resolved.steps[0]?.payload.attackKind, "GATLING");
  assert.equal(resolved.steps[0]?.payload.defenseSource, "barrel");
  assert.deepEqual(state, before, "the check module owns draw and outcome application");

  const jourdonnaisResponse = completedResponse(initial, target.public.playerId, "USE_JOURDONNAIS");
  const jourdonnaisResolved = gatlingEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [jourdonnaisResponse],
  }));
  assert.equal(jourdonnaisResolved.kind, "applied");
  if (jourdonnaisResolved.kind === "applied") {
    assert.equal(jourdonnaisResolved.steps[0]?.kind, "BARREL_CHECK");
    assert.equal(jourdonnaisResolved.steps[0]?.payload.defenseSource, "jourdonnais");
  }
});

test("Indians permits only a BANG discard or taking one damage", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  target.public.inPlayCardInstanceIds = [];
  const sourceId = sourceCard(state, "indians");
  const bangId = physicalCardId(state, "bang");
  const missedId = physicalCardId(state, "missed");
  const barrelId = physicalCardId(state, "barrel");
  moveCard(state, bangId, { zone: "hand", playerId: target.public.playerId });
  moveCard(state, missedId, { zone: "hand", playerId: target.public.playerId });
  moveCard(state, barrelId, { zone: "in_play", playerId: target.public.playerId });
  state.turn.bangCardPlaysThisTurn = 1;
  const initial = indiansEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
  }));
  assert.equal(initial.kind, "response_required");
  if (initial.kind !== "response_required") return;
  assert.equal(initial.request.kind, "INDIANS_RESPONSE");
  assert.deepEqual(initial.request.responders[0]?.options, [
    { choice: "USE_BANG", payload: { cardInstanceId: bangId } },
    { choice: "TAKE_HIT", payload: {} },
  ], "ordinary Missed and Barrel are not defenses against Indians");

  const bangResponse = completedResponse(initial, target.public.playerId, "USE_BANG", { cardInstanceId: bangId });
  const beforeDiscard = structuredClone(state);
  const defended = indiansEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [bangResponse],
  }));
  assert.equal(defended.kind, "applied");
  if (defended.kind === "applied") {
    assert.deepEqual(defended.events.map((event) => event.type), ["CARD_DISCARDED", "INDIANS_DEFENDED"]);
    assert.equal(defended.steps.length, 0);
  }

  const forgedMissed = completedResponse(initial, target.public.playerId, "USE_BANG", { cardInstanceId: missedId });
  assert.deepEqual(indiansEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [forgedMissed],
  })), { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });

  const hitResponse = completedResponse(initial, target.public.playerId, "TAKE_HIT");
  const hit = indiansEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [hitResponse],
  }));
  assert.equal(hit.kind, "applied");
  if (hit.kind === "applied") {
    assert.deepEqual(hit.events.map((event) => event.type), ["INDIANS_HIT"]);
    assert.equal(hit.steps[0]?.kind, "DAMAGE_PLAYER");
    assert.deepEqual(hit.steps[0]?.payload, { amount: 1, cause: "INDIANS" });
  }
  assert.deepEqual(state, beforeDiscard, "effects return discard/damage drafts without mutating state");
  assert.equal(state.turn.bangCardPlaysThisTurn, 1, "Indians response discards do not spend turn BANG quota");
});

test("Calamity Janet may use Missed as the BANG response to Indians", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  const target = seatAt(state, 1);
  target.public.characterId = "calamity_janet";
  target.public.inPlayCardInstanceIds = [];
  const sourceId = sourceCard(state, "indians");
  const missedId = physicalCardId(state, "missed");
  moveCard(state, missedId, { zone: "hand", playerId: target.public.playerId });
  const initial = indiansEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
  }));
  assert.equal(initial.kind, "response_required");
  if (initial.kind !== "response_required") return;
  assert.deepEqual(initial.request.responders[0]?.options, [
    { choice: "USE_BANG", payload: { cardInstanceId: missedId } },
    { choice: "TAKE_HIT", payload: {} },
  ]);
  const response = completedResponse(initial, target.public.playerId, "USE_BANG", { cardInstanceId: missedId });
  const before = structuredClone(state);

  const resolved = indiansEffect(inputFor(state, sourceId, playerTarget(target.public.playerId), {
    actorPlayerId: actor.public.playerId,
    completedInteractions: [response],
  }));

  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") return;
  assert.equal(resolved.events[1]?.type, "INDIANS_DEFENDED");
  assert.equal(resolved.events[1]?.payload.convertedFromMissed, true);
  assert.deepEqual(resolved.steps, []);
  assert.deepEqual(state, before);
});

test("Saloon heals both living players in a two-player game, caps HP, and never revives", () => {
  const state = stateFor(4);
  const actor = seatAt(state, 0);
  const other = seatAt(state, 1);
  const dead = seatAt(state, 2);
  seatAt(state, 3).public.eliminated = true;
  dead.public.eliminated = true;
  dead.public.hp = 0;
  actor.public.hp = Math.max(1, actor.public.maxHp - 1);
  other.public.hp = Math.max(1, other.public.maxHp - 1);
  const sourceId = sourceCard(state, "saloon");
  const before = structuredClone(state);

  const result = saloonEffect(inputFor(state, sourceId, [], { actorPlayerId: actor.public.playerId }));

  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.steps.map((step) => step.targetPlayerId), [actor.public.playerId, other.public.playerId]);
  assert.ok(result.steps.every((step) => step.kind === "HEAL_PLAYER" && step.payload.amount === 1));
  assert.deepEqual(result.events[0]?.payload.healedPlayerIds, [actor.public.playerId, other.public.playerId]);
  assert.ok(!result.steps.some((step) => step.targetPlayerId === dead.public.playerId));
  assert.deepEqual(state, before);

  actor.public.hp = actor.public.maxHp;
  other.public.hp = other.public.maxHp;
  const fullState = structuredClone(state);
  const full = saloonEffect(inputFor(state, sourceId, [], { actorPlayerId: actor.public.playerId }));
  assert.equal(full.kind, "applied");
  if (full.kind === "applied") {
    assert.deepEqual(full.steps, []);
    assert.deepEqual(full.events[0]?.payload.healedPlayerIds, []);
  }
  assert.deepEqual(state, fullState);
});

test("Saloon cannot be used to rescue a player already in a death flow", () => {
  const state = stateFor();
  const actor = seatAt(state, 0);
  actor.public.hp = 0;
  const sourceId = sourceCard(state, "saloon");
  state.resolution.pendingDeath = {
    victimPlayerId: actor.public.playerId,
    sourcePlayerId: seatAt(state, 1).public.playerId,
    rescueResponderIds: [actor.public.playerId],
    rescueCursor: 0,
    consequenceStage: "rescue",
    resumeFrameId: "frame-tablewide-1",
  };
  const before = structuredClone(state);

  const result = saloonEffect(inputFor(state, sourceId, [], { actorPlayerId: actor.public.playerId }));

  assert.deepEqual(result, { kind: "invalid_target", code: "TARGET_NOT_ALLOWED" });
  assert.deepEqual(state, before);
});

test("target steps remain serialized through cleanup and victory waits until the full queue ends", () => {
  const state = stateFor(4);
  const actor = seatAt(state, 0);
  const sourceId = sourceCard(state, "gatling");
  const effect = gatlingEffect(inputFor(state, sourceId, [], { actorPlayerId: actor.public.playerId }));
  assert.equal(effect.kind, "applied");
  if (effect.kind !== "applied") return;
  const firstStep = effect.steps[0]!;
  const victimId = firstStep.targetPlayerId!;
  const started = beginEffectResolution(state, {
    steps: effect.steps,
    continuation: {
      frameId: "frame-tablewide-1",
      kind: "CARD_EFFECT",
      sourcePlayerId: actor.public.playerId,
      sourceCardInstanceId: sourceId,
      payload: { effectId: firstStep.effectId },
    },
    deferredVictoryCheckEffectId: firstStep.effectId,
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(canCheckVictory(started.state), false);

  const cleanupState: GameState = {
    ...started.state,
    seats: started.state.seats.map((seat) => seat.public.playerId === victimId
      ? { ...seat, public: { ...seat.public, hp: 0, eliminated: true } }
      : seat),
    resolution: {
      ...started.state.resolution,
      pendingDeath: {
        victimPlayerId: victimId,
        sourcePlayerId: actor.public.playerId,
        rescueResponderIds: [victimId],
        rescueCursor: 1,
        consequenceStage: "cleanup",
        resumeFrameId: "frame-tablewide-1",
      },
    },
  };
  const blockedAdvance = completeEffectStep(cleanupState, firstStep);
  assert.equal(blockedAdvance.ok, false, "a target's death cleanup must finish before the next target step");
  const cleanup = completeDeathCleanup(cleanupState, victimId);
  assert.equal(cleanup.ok, true);
  if (!cleanup.ok) return;

  let cursorState = cleanup.state;
  for (const step of effect.steps) {
    const advanced = completeEffectStep(cursorState, step);
    assert.equal(advanced.ok, true);
    if (!advanced.ok) return;
    cursorState = advanced.state;
    assert.equal(canCheckVictory(cursorState), false, "victory remains deferred while the effect frame is active");
  }
  const finished = finishEffectResolution(cursorState, firstStep.effectId, "frame-tablewide-1");
  assert.equal(finished.ok, true);
  if (!finished.ok) return;
  assert.equal(finished.value.canCheckVictory, true);
});
