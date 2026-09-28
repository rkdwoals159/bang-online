import assert from "node:assert/strict";
import { test } from "node:test";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState } from "../../src/state/types.ts";
import {
  completeDiscard,
  completeDraw,
  completeStartEffects,
  endTurn,
  skipTurnAfterStartResolution,
} from "../../src/turn/reducer.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";

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

function setCurrentTurn(
  source: GameState,
  seatIndex: number,
  phase: "start" | "draw" | "play" | "discard",
): GameState {
  const state = structuredClone(source);
  const seat = state.seats.find((entry) => entry.public.seatIndex === seatIndex);
  assert.ok(seat, `missing seat ${seatIndex}`);
  state.turn.currentPlayerId = seat.public.playerId;
  state.turn.phase = phase;
  return state;
}

function assertRejectedWithoutMutation(
  source: GameState,
  result: ReturnType<typeof endTurn>,
  before: GameState,
  code: string,
): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
  assert.deepEqual(source, before, "a rejected transition must leave its input state unchanged");
}

test("advances start effects to draw and draw completion to play as separate pure transitions", () => {
  const initial = initialState();
  const before = structuredClone(initial);
  const sheriffId = initial.turn.currentPlayerId;

  const drawResult = completeStartEffects(initial, sheriffId);
  assert.equal(drawResult.ok, true);
  if (!drawResult.ok) return;
  assert.equal(drawResult.state.turn.phase, "draw");
  assert.equal(drawResult.state.turn.currentPlayerId, sheriffId);
  assert.equal(drawResult.state.version, initial.version + 1);
  assert.equal(drawResult.state.eventSeq, initial.eventSeq);
  assert.deepEqual(initial, before, "reducer must not mutate the source state");

  const playResult = completeDraw(drawResult.state, sheriffId);
  assert.equal(playResult.ok, true);
  if (!playResult.ok) return;
  assert.equal(playResult.state.turn.phase, "play");
  assert.equal(playResult.state.turn.currentPlayerId, sheriffId);
  assert.equal(playResult.state.version, drawResult.state.version + 1);
  assert.deepEqual(initial, before);
});

test("END_TURN advances from the last seat to the first living seat and increments once", () => {
  const state = setCurrentTurn(initialState(5), 4, "play");
  state.turn.turnNumber = 3;
  state.turn.bangCardPlaysThisTurn = 2;
  const before = structuredClone(state);
  const currentPlayerId = state.turn.currentPlayerId;

  const result = endTurn(state, currentPlayerId);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.turn.currentPlayerId, state.seats[0]!.public.playerId);
  assert.equal(result.state.turn.phase, "start");
  assert.equal(result.state.turn.turnNumber, 4);
  assert.equal(result.state.turn.bangCardPlaysThisTurn, 0);
  assert.equal(result.state.version, state.version + 1);
  assert.equal(result.state.eventSeq, state.eventSeq);
  assert.deepEqual(state, before, "END_TURN must not mutate its input");
});

test("END_TURN skips eliminated seats when choosing the next player", () => {
  const state = setCurrentTurn(initialState(5), 0, "play");
  state.seats[1]!.public.eliminated = true;
  state.seats[2]!.public.eliminated = true;
  const before = structuredClone(state);
  const actorId = state.turn.currentPlayerId;

  const result = endTurn(state, actorId);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.turn.currentPlayerId, state.seats[3]!.public.playerId);
  assert.deepEqual(state, before);
});

test("END_TURN enters discard when the hand exceeds HP, then finishes after hand is reduced", () => {
  const state = setCurrentTurn(initialState(5), 0, "play");
  const current = state.seats.find((seat) => seat.public.playerId === state.turn.currentPlayerId)!;
  const extraCardIds = state.zones.drawPileCardInstanceIds.splice(0, 2);
  current.private.handCardInstanceIds.push(...extraCardIds);
  state.turn.bangCardPlaysThisTurn = 1;
  const before = structuredClone(state);
  const actorId = state.turn.currentPlayerId;

  const endResult = endTurn(state, actorId);

  assert.equal(endResult.ok, true);
  if (!endResult.ok) return;
  assert.equal(endResult.state.turn.phase, "discard");
  assert.equal(endResult.state.turn.currentPlayerId, actorId);
  assert.equal(endResult.state.turn.turnNumber, state.turn.turnNumber);
  assert.equal(endResult.state.turn.bangCardPlaysThisTurn, 1);
  assert.equal(endResult.state.version, state.version + 1);
  assert.deepEqual(state, before, "END_TURN must not mutate the source while opening discard");

  const discardBefore = structuredClone(endResult.state);
  const stillOverLimit = completeDiscard(endResult.state, actorId);
  assertRejectedWithoutMutation(endResult.state, stillOverLimit, discardBefore, "HAND_OVER_LIMIT");
  assert.deepEqual(endResult.state, discardBefore);

  const hand = endResult.state.seats.find((seat) => seat.public.playerId === actorId)!.private.handCardInstanceIds;
  const discarded = hand.splice(current.public.hp);
  endResult.state.zones.discardPileCardInstanceIds.push(...discarded);
  const completed = completeDiscard(endResult.state, actorId);

  assert.equal(completed.ok, true);
  if (!completed.ok) return;
  assert.equal(completed.state.turn.currentPlayerId, state.seats[1]!.public.playerId);
  assert.equal(completed.state.turn.phase, "start");
  assert.equal(completed.state.turn.turnNumber, state.turn.turnNumber + 1);
  assert.equal(completed.state.turn.bangCardPlaysThisTurn, 0);
  assert.equal(completed.state.version, endResult.state.version + 1);
  assert.equal(completed.state.seats[0]!.private.handCardInstanceIds.length, current.public.hp);
});

test("a start-effect resolver can skip a turn without this reducer resolving Dynamite or Jail", () => {
  const state = setCurrentTurn(initialState(5), 0, "start");
  state.seats[1]!.public.eliminated = true;
  const before = structuredClone(state);

  const result = skipTurnAfterStartResolution(state);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.turn.currentPlayerId, state.seats[2]!.public.playerId);
  assert.equal(result.state.turn.phase, "start");
  assert.equal(result.state.turn.turnNumber, state.turn.turnNumber + 1);
  assert.equal(result.state.version, state.version + 1);
  assert.deepEqual(state, before);
});

test("rejects wrong actor and wrong phase without changing state", () => {
  const state = initialState();
  const before = structuredClone(state);

  const wrongPhase = endTurn(state, state.turn.currentPlayerId);
  assertRejectedWithoutMutation(state, wrongPhase, before, "ILLEGAL_PHASE");
  const wrongActor = completeStartEffects(state, "another-player");
  assertRejectedWithoutMutation(state, wrongActor, before, "NOT_YOUR_TURN");
  const drawInStartPhase = completeDraw(state, state.turn.currentPlayerId);
  assertRejectedWithoutMutation(state, drawInStartPhase, before, "ILLEGAL_PHASE");
  assert.deepEqual(state, before);
});

test("blocks every turn progression helper while resolution state remains pending", () => {
  const pendingStates: { name: string; prepare: (state: GameState) => void }[] = [
    {
      name: "pending interaction",
      prepare(state) {
        state.resolution.pendingInteraction = {
          interactionId: "interaction-1",
          kind: "test-choice",
          actorPlayerIds: [state.turn.currentPlayerId],
          options: [{ choice: "continue", payload: {} }],
          context: {},
          resumeFrameId: null,
          createdAt: "2026-09-27T00:00:00.000Z",
        };
      },
    },
    {
      name: "effect queue",
      prepare(state) {
        state.resolution.effectQueue.push({
          effectId: "effect-1",
          kind: "test-effect",
          sourcePlayerId: state.turn.currentPlayerId,
          targetPlayerId: null,
          sourceCardInstanceId: null,
          payload: {},
        });
      },
    },
    {
      name: "continuation frame",
      prepare(state) {
        state.resolution.continuations.push({
          frameId: "frame-1",
          kind: "test-continuation",
          sourcePlayerId: state.turn.currentPlayerId,
          sourceCardInstanceId: null,
          payload: {},
        });
      },
    },
    {
      name: "pending death",
      prepare(state) {
        state.resolution.pendingDeath = {
          victimPlayerId: state.turn.currentPlayerId,
          sourcePlayerId: null,
          rescueResponderIds: [],
          rescueCursor: 0,
          consequenceStage: "rescue",
          resumeFrameId: null,
        };
      },
    },
    {
      name: "deferred victory check",
      prepare(state) {
        state.resolution.victoryCheckDeferredByEffectId = "effect-1";
      },
    },
  ];
  const transitions: {
    name: string;
    phase: "start" | "draw" | "play" | "discard";
    apply: (state: GameState) => ReturnType<typeof endTurn>;
  }[] = [
    {
      name: "completeStartEffects",
      phase: "start",
      apply: (state) => completeStartEffects(state, state.turn.currentPlayerId),
    },
    {
      name: "completeDraw",
      phase: "draw",
      apply: (state) => completeDraw(state, state.turn.currentPlayerId),
    },
    {
      name: "endTurn",
      phase: "play",
      apply: (state) => endTurn(state, state.turn.currentPlayerId),
    },
    {
      name: "completeDiscard",
      phase: "discard",
      apply: (state) => completeDiscard(state, state.turn.currentPlayerId),
    },
    {
      name: "skipTurnAfterStartResolution",
      phase: "start",
      apply: (state) => skipTurnAfterStartResolution(state),
    },
  ];

  for (const pending of pendingStates) {
    for (const transition of transitions) {
      const state = setCurrentTurn(initialState(), 0, transition.phase);
      pending.prepare(state);
      const before = structuredClone(state);

      const result = transition.apply(state);

      assertRejectedWithoutMutation(
        state,
        result,
        before,
        "ILLEGAL_PHASE",
      );
    }
  }
});

test("same state and turn action produce the same next state", () => {
  const state = setCurrentTurn(initialState(6), 2, "play");
  const left = endTurn(state, state.turn.currentPlayerId);
  const right = endTurn(state, state.turn.currentPlayerId);

  assert.deepEqual(right, left);
});
