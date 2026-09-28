import assert from "node:assert/strict";
import { test } from "node:test";
import type { EffectStep, GameState } from "../../src/state/types.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import {
  type CardEffectInput,
  type CardEffectModule,
  type CardEffectResult,
  type DeepReadonly,
  type EffectTarget,
} from "../../src/effects/api.ts";

const EMPTY_STATE = {} as unknown as DeepReadonly<GameState>;

function makeInput(
  targets: readonly EffectTarget[] = [],
  sourceCardInstanceId: string | null = "card-1",
): CardEffectInput {
  return {
    state: EMPTY_STATE,
    actorPlayerId: "actor",
    sourceCardInstanceId,
    continuationFrameId: "frame-1",
    targets,
    random: { nextFloat: () => 0.25 },
    completedInteractions: [],
  };
}

function fixedRandom(values: readonly number[]): RandomSource {
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

const sampleEffect: CardEffectModule = (input) => {
  const target = input.targets[0];
  if (!target) return { kind: "target_required" };
  if (target.kind === "in_play_card" && target.cardInstanceId === "missing") {
    return { kind: "invalid_target", code: "TARGET_CARD_NOT_IN_PLAY" };
  }
  if (target.kind === "hand" && input.completedInteractions.length === 0) {
    return {
      kind: "choice_required",
      request: {
        kind: "CARD_CHOICE",
        responders: [{
          playerId: input.actorPlayerId,
          options: [{ choice: "TAKE", payload: { targetPlayerId: target.playerId } }],
        }],
        context: { targetPlayerId: target.playerId },
        resumeFrameId: input.continuationFrameId,
      },
      events: [],
      steps: [],
    };
  }
  if (target.kind === "player") {
    return {
      kind: "response_required",
      request: {
        kind: "CARD_RESPONSE",
        responders: [{ playerId: target.playerId, options: [{ choice: "ACCEPT", payload: {} }] }],
        context: { sourcePlayerId: input.actorPlayerId },
        resumeFrameId: input.continuationFrameId,
      },
      events: [],
      steps: [],
    };
  }

  return {
    kind: "applied",
    events: [{
      type: "CARD_EFFECT_APPLIED",
      actorPlayerId: input.actorPlayerId,
      payload: { randomSample: input.random.nextFloat(), targetPlayerId: target.playerId },
    }],
    steps: [],
  };
};

test("the outcome union distinguishes missing targets from illegal targets", () => {
  const missing = sampleEffect(makeInput());
  assert.deepEqual(missing, { kind: "target_required" });

  const illegal = sampleEffect(makeInput([{ kind: "in_play_card", playerId: "other", cardInstanceId: "missing" }]));
  assert.deepEqual(illegal, { kind: "invalid_target", code: "TARGET_CARD_NOT_IN_PLAY" });
});

test("choice and response requests carry T12-compatible responders and resume context", () => {
  const choice = sampleEffect(makeInput([{ kind: "hand", playerId: "other" }]));
  assert.equal(choice.kind, "choice_required");
  if (choice.kind !== "choice_required") return;
  assert.equal(choice.request.resumeFrameId, "frame-1");
  assert.deepEqual(choice.request.responders[0]?.options[0], {
    choice: "TAKE",
    payload: { targetPlayerId: "other" },
  });

  const response = sampleEffect(makeInput([{ kind: "player", playerId: "other" }]));
  assert.equal(response.kind, "response_required");
  if (response.kind !== "response_required") return;
  assert.deepEqual(response.request.responders.map(({ playerId }) => playerId), ["other"]);
});

test("applied effects return internal event drafts and resolver steps using injected randomness", () => {
  const input = makeInput([{ kind: "in_play_card", playerId: "other", cardInstanceId: "public-1" }]);
  const result = sampleEffect({ ...input, random: fixedRandom([0.75]) });
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.steps, [] satisfies EffectStep[]);
  assert.deepEqual(result.events, [{
    type: "CARD_EFFECT_APPLIED",
    actorPlayerId: "actor",
    payload: { randomSample: 0.75, targetPlayerId: "other" },
  }]);
});

test("effect input exposes completed responses while the supplied game snapshot remains unchanged", () => {
  const completed = {
    interactionId: "choice-1",
    kind: "CARD_CHOICE",
    context: { targetPlayerId: "other" },
    responses: [{ playerId: "actor", choice: "TAKE", payload: { targetPlayerId: "other" } }],
  };
  const input = { ...makeInput([{ kind: "hand", playerId: "other" }]), completedInteractions: [completed] };
  const result: CardEffectResult = sampleEffect(input);
  assert.equal(result.kind, "applied");
  assert.deepEqual(EMPTY_STATE, {});
});

test("a character ability can run without a physical source card", () => {
  const characterAbility: CardEffectModule = (input) => ({
    kind: "applied",
    events: [{
      type: "CHARACTER_ABILITY_USED",
      actorPlayerId: input.actorPlayerId,
      payload: { sourceCardInstanceId: input.sourceCardInstanceId },
    }],
    steps: [],
  });
  const input = makeInput([], null);
  const result = characterAbility(input);

  assert.equal(input.sourceCardInstanceId, null);
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events[0]?.payload, { sourceCardInstanceId: null });
});

// These compile-time checks keep the target boundary and state view read-only.
const hiddenHandTarget: EffectTarget = { kind: "hand", playerId: "other" };
void hiddenHandTarget;
// @ts-expect-error Hidden hand card IDs must never be supplied as target references.
const invalidHiddenHandTarget: EffectTarget = { kind: "hand", playerId: "other", cardInstanceId: "secret" };
void invalidHiddenHandTarget;

function verifyReadonlyContract(input: CardEffectInput): void {
  // @ts-expect-error Effects receive snapshots as immutable inputs.
  input.state.version = 1;
  // @ts-expect-error Effects cannot mutate player arrays in the supplied snapshot.
  input.state.seats.push({} as never);
}
void verifyReadonlyContract;
