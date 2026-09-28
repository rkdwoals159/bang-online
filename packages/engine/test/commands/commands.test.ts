import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import type { RoleId } from "../../../catalog/src/schema.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState, InteractionOption } from "../../src/state/types.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import { applyMatchCommand, type AbilityExecutionInput, type EngineCommand } from "../../src/commands/index.ts";
import {
  beginDeathRescue,
  beginDiscardOrder,
  beginEffectResolution,
  openPendingInteraction,
} from "../../src/resolution/index.ts";

const FIXED_ROLES: readonly RoleId[] = ["sheriff", "deputy", "outlaw", "renegade", "outlaw"];

function fixedRandom(values: readonly number[] = [0.25, 0.75, 0.5]): RandomSource {
  let cursor = 0;
  return {
    nextFloat() {
      const value = values[cursor];
      if (value === undefined) throw new Error("prepared RNG fixture was exhausted");
      cursor += 1;
      return value;
    },
  };
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 5 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const values = Array.from({ length: 1_000 }, (_, index) => ((index * 67 + 11) % 997) / 997);
  let cursor = 0;
  const state = initializeGame({
    players,
    random: {
      nextFloat() {
        assert.ok(cursor < values.length, "fixture setup requested too many random values");
        return values[cursor++]!;
      },
    },
  });
  state.seats = state.seats
    .map((seat, index) => {
      const playerNumber = Number(seat.public.playerId.slice("player-".length));
      const roleId = FIXED_ROLES[playerNumber - 1]!;
      return {
        ...seat,
        private: { ...seat.private, roleId },
        public: { ...seat.public, seatIndex: index, roleRevealed: roleId === "sheriff" },
      };
    })
    .sort((left, right) => left.public.playerId.localeCompare(right.public.playerId))
    .map((seat, seatIndex) => ({ ...seat, public: { ...seat.public, seatIndex } }));
  state.turn.currentPlayerId = "player-1";
  state.turn.phase = "play";
  state.turn.bangCardPlaysThisTurn = 0;
  return state;
}

function seat(state: GameState, playerId: string) {
  const found = state.seats.find((candidate) => candidate.public.playerId === playerId);
  assert.ok(found, `missing ${playerId}`);
  return found;
}

function cardOfType(state: GameState, typeId: string): string {
  const definitions = new Set(BASE_PHYSICAL_CARDS
    .filter((definition) => definition.typeId === typeId)
    .map((definition) => definition.definitionId));
  const found = Object.values(state.zones.cardsByInstanceId)
    .find((instance) => definitions.has(instance.cardDefinitionId));
  assert.ok(found, `expected catalog instance of ${typeId}`);
  return found.cardInstanceId;
}

function ensureInHand(state: GameState, playerId: string, typeId: string): string {
  const owner = seat(state, playerId);
  const definitions = new Set(BASE_PHYSICAL_CARDS
    .filter((definition) => definition.typeId === typeId)
    .map((definition) => definition.definitionId));
  const existing = owner.private.handCardInstanceIds.find((cardId) =>
    definitions.has(state.zones.cardsByInstanceId[cardId]!.cardDefinitionId));
  if (existing) return existing;

  const drawIndex = state.zones.drawPileCardInstanceIds.findIndex((cardId) =>
    definitions.has(state.zones.cardsByInstanceId[cardId]!.cardDefinitionId));
  assert.ok(drawIndex >= 0, `no ${typeId} remains in draw pile for fixture setup`);
  const [cardId] = state.zones.drawPileCardInstanceIds.splice(drawIndex, 1);
  assert.ok(cardId);
  owner.private.handCardInstanceIds.push(cardId);
  return cardId;
}

function copyState(state: unknown): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

const noopContext = { random: fixedRandom() };

test("END_TURN reuses the turn reducer and rejects wrong actor or phase without mutation", () => {
  const command: EngineCommand = { type: "END_TURN", payload: {} };
  const source = initialState();
  const before = copyState(source);

  const wrongPhase = applyMatchCommand({ ...source, turn: { ...source.turn, phase: "draw" } }, "player-1", command, noopContext);
  assert.equal(wrongPhase.ok, false);
  if (!wrongPhase.ok) assert.equal(wrongPhase.error.code, "ILLEGAL_PHASE");
  assert.deepEqual(source, before);

  const wrongActor = applyMatchCommand(source, "player-2", command, noopContext);
  assert.equal(wrongActor.ok, false);
  if (!wrongActor.ok) assert.equal(wrongActor.error.code, "NOT_YOUR_TURN");
  assert.deepEqual(source, before);

  const accepted = applyMatchCommand(source, "player-1", command, noopContext);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.state.turn.currentPlayerId, "player-2");
  assert.equal(accepted.state.turn.phase, "start");
  assert.equal(accepted.state.version, source.version + 1);
  assert.equal(accepted.state.eventSeq, source.eventSeq);
  assert.deepEqual(accepted.events, []);
  assert.deepEqual(source, before, "the engine must not mutate its input state");
});

test("END_TURN opens a saved hand-limit order and RESPOND completes the discard transition", () => {
  const source = initialState();
  const actor = seat(source, "player-1");
  const extraCard = source.zones.drawPileCardInstanceIds.shift();
  assert.ok(extraCard);
  actor.private.handCardInstanceIds.push(extraCard);
  actor.public.hp = 1;
  const originalHand = [...actor.private.handCardInstanceIds];
  const requiredCount = originalHand.length - actor.public.hp;
  assert.ok(requiredCount > 0);
  const before = copyState(source);
  const endTurn: EngineCommand = { type: "END_TURN", payload: {} };

  const missingMetadata = applyMatchCommand(source, "player-1", endTurn, { random: fixedRandom() });
  assert.equal(missingMetadata.ok, false);
  if (!missingMetadata.ok) assert.equal(missingMetadata.error.code, "INTERACTION_METADATA_REQUIRED");
  assert.deepEqual(source, before);

  const open = () => applyMatchCommand(source, "player-1", endTurn, {
    random: fixedRandom([0.2, 0.8]),
    interaction: { interactionId: "turn-discard-1", createdAt: "2026-09-27T12:00:00.000Z" },
  });
  const opened = open();
  const openedAgain = open();
  assert.deepEqual(opened, openedAgain, "the same state, command, metadata, and prepared RNG must be deterministic");
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.state.turn.phase, "discard");
  assert.equal(opened.state.turn.currentPlayerId, "player-1");
  assert.equal(opened.state.resolution.pendingInteraction?.kind, "DISCARDS_ORDER");
  const pending = opened.state.resolution.pendingInteraction!;
  const openedBefore = copyState(opened.state);
  assert.equal(pending.interactionId, "turn-discard-1");
  assert.equal(pending.actorPlayerIds[0], "player-1");
  assert.equal(pending.context.discardOrder?.reason, "turn_hand_limit");
  assert.equal(pending.context.discardOrder?.requiredCount, requiredCount);
  assert.equal(opened.state.version, source.version + 1);
  assert.deepEqual(source, before);

  const orderedCardInstanceIds = originalHand.slice(0, requiredCount);
  const response: EngineCommand = {
    type: "RESPOND",
    payload: { interactionId: "turn-discard-1", choice: "ORDER_CARDS", orderedCardInstanceIds },
  };
  const wrongActor = applyMatchCommand(opened.state, "player-2", response, { random: fixedRandom() });
  assert.equal(wrongActor.ok, false);
  if (!wrongActor.ok) assert.equal(wrongActor.error.code, "WRONG_RESPONDER");
  assert.deepEqual(opened.state, openedBefore);

  const invalidOrder: EngineCommand = {
    type: "RESPOND",
    payload: {
      interactionId: "turn-discard-1",
      choice: "ORDER_CARDS",
      orderedCardInstanceIds: ["not-in-hand", ...originalHand.slice(1, requiredCount)],
    },
  };
  const rejectedOrder = applyMatchCommand(opened.state, "player-1", invalidOrder, { random: fixedRandom() });
  assert.equal(rejectedOrder.ok, false);
  if (!rejectedOrder.ok) assert.equal(rejectedOrder.error.code, "INVALID_DISCARD_ORDER");
  assert.deepEqual(opened.state, openedBefore);

  const completed = applyMatchCommand(opened.state, "player-1", response, { random: fixedRandom() });
  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.state.turn.currentPlayerId, "player-2");
  assert.equal(completed.state.turn.phase, "start");
  assert.equal(completed.state.resolution.pendingInteraction, null);
  assert.deepEqual(completed.state.resolution.effectQueue, []);
  assert.deepEqual(completed.state.resolution.continuations, []);
  assert.deepEqual(seat(completed.state, "player-1").private.handCardInstanceIds,
    originalHand.filter((id) => !orderedCardInstanceIds.includes(id)));
  assert.deepEqual(completed.state.zones.discardPileCardInstanceIds.slice(-requiredCount), orderedCardInstanceIds,
    "the final ordered card becomes the public discard pile top");
  assert.equal(completed.state.version, opened.state.version + 1);
  assert.equal(completed.state.eventSeq, source.eventSeq);
  assert.equal(completed.value.kind, "response");
  if (completed.value.kind === "response") assert.equal(completed.value.effectResumed, true);
  assert.deepEqual(source, before);
});

test("legal PLAY_CARD dispatch is deterministic for the same state, command, and prepared RNG", () => {
  const source = initialState();
  const cardInstanceId = ensureInHand(source, "player-1", "bang");
  const command: EngineCommand = {
    type: "PLAY_CARD",
    payload: { cardInstanceId, targetPlayerId: "player-2" },
  };
  const before = copyState(source);
  const run = () => applyMatchCommand(source, "player-1", command, {
    random: fixedRandom([0.75]),
    handlers: {
      playCard(input) {
        const sample = input.random.nextFloat();
        return {
          ok: true,
          output: {
            state: copyState(input.state),
            events: [{
              type: "TEST_CARD_RESOLUTION_REQUESTED",
              actorPlayerId: input.actorPlayerId,
              payload: {
                cardInstanceId: input.command.payload.cardInstanceId,
                cardTypeId: input.cardTypeId,
                targetPlayerId: input.command.payload.targetPlayerId ?? null,
                sample,
              },
            }],
            value: { sample },
          },
        };
      },
    },
  });

  const first = run();
  const second = run();
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(first, second);
  if (first.ok) {
    assert.equal(first.value.kind, "play_card");
    if (first.value.kind === "play_card") assert.equal(first.value.cardTypeId, "bang");
    assert.equal(first.state.version, source.version + 1);
    assert.equal(first.events[0]?.payload.sample, 0.75);
  }
  assert.deepEqual(source, before);
});

test("PLAY_CARD rejects illegal actor, ownership, range, and hidden-card targets without calling effects", () => {
  const state = initialState();
  const bangId = ensureInHand(state, "player-1", "bang");
  const panicId = ensureInHand(state, "player-1", "panic");
  const otherHandCard = seat(state, "player-2").private.handCardInstanceIds[0]!;
  let executions = 0;
  const context = {
    random: fixedRandom(),
    handlers: { playCard() { executions += 1; return { ok: false as const, error: { code: "INVALID_STATE" as const, message: "unexpected" } }; } },
  };
  const before = copyState(state);

  const wrongActor = applyMatchCommand(state, "player-2", {
    type: "PLAY_CARD", payload: { cardInstanceId: bangId, targetPlayerId: "player-2" },
  }, context);
  assert.equal(wrongActor.ok, false);
  if (!wrongActor.ok) assert.equal(wrongActor.error.code, "NOT_YOUR_TURN");

  const wrongOwner = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD", payload: { cardInstanceId: otherHandCard, targetPlayerId: "player-2" },
  }, context);
  assert.equal(wrongOwner.ok, false);
  if (!wrongOwner.ok) assert.equal(wrongOwner.error.code, "CARD_NOT_IN_HAND");

  const outOfRange = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD", payload: { cardInstanceId: bangId, targetPlayerId: "player-3" },
  }, context);
  assert.equal(outOfRange.ok, false);
  if (!outOfRange.ok) assert.equal(outOfRange.error.code, "TARGET_OUT_OF_RANGE");

  const hiddenTargetId = cardOfType(state, "bang");
  const hiddenCardTarget = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD",
    payload: {
      cardInstanceId: panicId,
      targetPlayerId: "player-2",
      targetZone: "HAND",
      targetCardInstanceId: hiddenTargetId,
    },
  }, context);
  assert.equal(hiddenCardTarget.ok, false);
  if (!hiddenCardTarget.ok) assert.equal(hiddenCardTarget.error.code, "TARGET_NOT_ALLOWED");

  assert.equal(executions, 0);
  assert.deepEqual(state, before);
});

test("PLAY_CARD supports only Calamity Janet's documented Missed-to-BANG conversion", () => {
  const state = initialState();
  seat(state, "player-1").public.characterId = "calamity_janet";
  const missedId = ensureInHand(state, "player-1", "missed");
  const actualDefinitionId = state.zones.cardsByInstanceId[missedId]!.cardDefinitionId;
  let observedCardType = "";
  const converted = applyMatchCommand(state, "player-1", {
    type: "PLAY_CARD",
    payload: { cardInstanceId: missedId, targetPlayerId: "player-2", asCardType: "bang" },
  }, {
    random: fixedRandom(),
    handlers: {
      playCard(input) {
        observedCardType = input.cardTypeId;
        return { ok: true, output: { state: copyState(input.state), events: [], value: null } };
      },
    },
  });
  assert.equal(converted.ok, true);
  assert.equal(observedCardType, "bang");
  assert.equal(state.zones.cardsByInstanceId[missedId]!.cardDefinitionId, actualDefinitionId,
    "legality must not rewrite the physical card in the supplied state");

  const ordinaryActor = initialState();
  const ordinaryMissed = ensureInHand(ordinaryActor, "player-1", "missed");
  const rejected = applyMatchCommand(ordinaryActor, "player-1", {
    type: "PLAY_CARD",
    payload: { cardInstanceId: ordinaryMissed, targetPlayerId: "player-2", asCardType: "bang" },
  }, { random: fixedRandom(), handlers: { playCard: () => assert.fail("illegal conversion reached effect handler") } });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "CARD_NOT_PLAYABLE");
});

test("USE_ABILITY validates Sid identity, phase, and two distinct owned cost cards", () => {
  const state = initialState();
  seat(state, "player-1").public.characterId = "sid_ketchum";
  const cards = seat(state, "player-1").private.handCardInstanceIds.slice(0, 2);
  assert.equal(cards.length, 2);
  const command: EngineCommand = {
    type: "USE_ABILITY",
    payload: { abilityId: "sid-ketchum", cardInstanceIds: [cards[0]!, cards[1]!] },
  };
  let executions = 0;
  const context = {
    random: fixedRandom(),
    handlers: {
      useAbility(input: AbilityExecutionInput) {
        executions += 1;
        assert.equal(input.command.payload.abilityId, "sid-ketchum");
        assert.deepEqual(input.command.payload.cardInstanceIds, cards);
        return {
          ok: true as const,
          output: {
            state: copyState(input.state),
            events: [{ type: "TEST_ABILITY_REQUESTED", actorPlayerId: input.actorPlayerId, payload: {} }],
            value: null,
          },
        };
      },
    },
  };

  const accepted = applyMatchCommand(state, "player-1", command, context);
  assert.equal(accepted.ok, true);
  assert.equal(executions, 1);
  const duplicateCost = applyMatchCommand(state, "player-1", {
    type: "USE_ABILITY",
    payload: { abilityId: "sid-ketchum", cardInstanceIds: [cards[0]!, cards[0]!] },
  }, context);
  assert.equal(duplicateCost.ok, false);
  if (!duplicateCost.ok) assert.equal(duplicateCost.error.code, "INVALID_ABILITY_COST");
  assert.equal(executions, 1, "invalid ability costs must not reach the effect handler");

  const wrongPhase = applyMatchCommand({ ...state, turn: { ...state.turn, phase: "draw" } }, "player-1", command, context);
  assert.equal(wrongPhase.ok, false);
  if (!wrongPhase.ok) assert.equal(wrongPhase.error.code, "ILLEGAL_PHASE");
});

test("RESPOND delegates saved discard ordering to T12 and does not move cards itself", () => {
  const source = initialState();
  const ownerId = "player-2";
  const candidates = seat(source, ownerId).private.handCardInstanceIds.slice(0, 2);
  const started = beginEffectResolution(source, {
    steps: [{ effectId: "test-effect", kind: "WAIT_FOR_DISCARD", sourcePlayerId: "player-1", targetPlayerId: ownerId, sourceCardInstanceId: null, payload: {} }],
    continuation: { frameId: "discard-frame", kind: "TEST_EFFECT", sourcePlayerId: "player-1", sourceCardInstanceId: null, payload: {} },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const opened = beginDiscardOrder(started.state, {
    interactionId: "discard-choice",
    playerId: ownerId,
    cardInstanceIds: candidates,
    requiredCount: candidates.length,
    reason: "effect_cleanup",
    context: {},
    resumeFrameId: "discard-frame",
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const before = copyState(opened.state);
  const command: EngineCommand = {
    type: "RESPOND",
    payload: { interactionId: "discard-choice", choice: "ORDER_CARDS", orderedCardInstanceIds: [...candidates].reverse() },
  };

  const wrongActor = applyMatchCommand(opened.state, "player-3", command, noopContext);
  assert.equal(wrongActor.ok, false);
  if (!wrongActor.ok) assert.equal(wrongActor.error.code, "WRONG_RESPONDER");
  assert.deepEqual(opened.state, before);

  const accepted = applyMatchCommand(opened.state, ownerId, command, noopContext);
  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.state.resolution.pendingInteraction, null);
  assert.deepEqual(seat(accepted.state, ownerId).private.handCardInstanceIds, seat(opened.state, ownerId).private.handCardInstanceIds,
    "T12 records the order; the owning resolution layer applies card movement");
  assert.equal(accepted.value.kind, "response");
  if (accepted.value.kind === "response") assert.equal(accepted.value.effectResumed, false);
  const frame = accepted.state.resolution.continuations[0]!;
  const results = frame.payload.__resolutionResults;
  assert.ok(Array.isArray(results));
  assert.deepEqual((results[0] as { responses: Array<{ payload: { orderedCardInstanceIds: string[] } }> }).responses[0]!.payload.orderedCardInstanceIds,
    [...candidates].reverse());
  assert.deepEqual(opened.state, before);
});

test("RESPOND advances generic cursor and victim-only death rescue through T12", () => {
  const source = initialState();
  const started = beginEffectResolution(source, {
    steps: [{ effectId: "duel-effect", kind: "DUEL_STEP", sourcePlayerId: "player-1", targetPlayerId: "player-2", sourceCardInstanceId: null, payload: {} }],
    continuation: { frameId: "duel-frame", kind: "DUEL", sourcePlayerId: "player-1", sourceCardInstanceId: null, payload: {} },
  });
  assert.equal(started.ok, true);
  if (!started.ok) return;
  const options: InteractionOption[] = [{ choice: "YIELD", payload: {} }];
  const opened = openPendingInteraction(started.state, {
    interactionId: "duel-window",
    kind: "DUEL_RESPONSE",
    responders: [
      { playerId: "player-2", options },
      { playerId: "player-1", options },
    ],
    context: {},
    resumeFrameId: "duel-frame",
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(opened.ok, true);
  if (!opened.ok) return;

  const first = applyMatchCommand(opened.state, "player-2", {
    type: "RESPOND", payload: { interactionId: "duel-window", choice: "YIELD" },
  }, noopContext);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.value.kind, "response");
  if (first.value.kind === "response") {
    assert.equal(first.value.completed, false);
    assert.equal(first.value.nextActorPlayerId, "player-1");
  }
  assert.deepEqual(first.state.resolution.pendingInteraction?.actorPlayerIds, ["player-1"]);

  const resumed = applyMatchCommand(first.state, "player-1", {
    type: "RESPOND", payload: { interactionId: "duel-window", choice: "YIELD" },
  }, {
    random: fixedRandom(),
    handlers: {
      resumeInteraction(input) {
        return {
          ok: true,
          output: {
            state: copyState(input.state),
            events: [{ type: "TEST_DUEL_RESPONSE_COMPLETE", actorPlayerId: input.actorPlayerId, payload: { interactionKind: input.interactionKind } }],
            value: { completed: input.progress.completed },
          },
        };
      },
    },
  });
  assert.equal(resumed.ok, true);
  if (!resumed.ok) return;
  assert.equal(resumed.state.resolution.pendingInteraction, null);
  assert.equal(resumed.value.kind, "response");
  if (resumed.value.kind === "response") assert.equal(resumed.value.effectResumed, true);

  const deathState = initialState();
  seat(deathState, "player-2").public.hp = 0;
  const deathStarted = beginEffectResolution(deathState, {
    steps: [{ effectId: "death-effect", kind: "DAMAGE", sourcePlayerId: "player-1", targetPlayerId: "player-2", sourceCardInstanceId: null, payload: {} }],
    continuation: { frameId: "death-frame", kind: "DAMAGE", sourcePlayerId: "player-1", sourceCardInstanceId: null, payload: {} },
  });
  assert.equal(deathStarted.ok, true);
  if (!deathStarted.ok) return;
  const rescue = beginDeathRescue(deathStarted.state, {
    victimPlayerId: "player-2",
    sourcePlayerId: "player-1",
    interactionId: "death-window",
    options: [{ choice: "ACCEPT_ELIMINATION", payload: {} }],
    context: {},
    resumeFrameId: "death-frame",
    createdAt: "2026-09-27T12:00:00.000Z",
  });
  assert.equal(rescue.ok, true);
  if (!rescue.ok) return;
  const acceptedDeath = applyMatchCommand(rescue.state, "player-2", {
    type: "RESPOND", payload: { interactionId: "death-window", choice: "ACCEPT_ELIMINATION" },
  }, noopContext);
  assert.equal(acceptedDeath.ok, true);
  if (acceptedDeath.ok) {
    assert.equal(acceptedDeath.state.resolution.pendingDeath?.rescueCursor, 1);
    assert.equal(acceptedDeath.state.resolution.pendingDeath?.consequenceStage, "rescue");
    assert.equal(acceptedDeath.state.resolution.pendingInteraction, null);
  }
});

test("completed or paused matches reject commands before turn or interaction handlers", () => {
  const state = initialState();
  state.status = "completed";
  const before = copyState(state);
  const result = applyMatchCommand(state, "player-1", { type: "END_TURN", payload: {} }, noopContext);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "MATCH_NOT_PLAYING");
  assert.deepEqual(state, before);
});

// Protocol metadata is owned by T46 and is deliberately not part of EngineCommand.
// @ts-expect-error EngineCommand strips server-managed commandId/expectedVersion and actor fields.
const invalidEngineEnvelope: EngineCommand = { type: "END_TURN", payload: {}, commandId: "x", expectedVersion: 1 };
void invalidEngineEnvelope;
