// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type {
  CharacterAbilityInput,
  PedroFirstTurnDrawSlotHookInput,
} from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { pedroRamirezAbility } from "../../../src/effects/characters/pedro-ramirez.ts";

const FRAME_ID = "frame-pedro-ramirez";
const ACTOR_ID = "player-1";
const TOP_CARD_ID = "pedro-visible-discard-top";
const LOWER_CARD_ID = "pedro-lower-discard-card";

type PedroInput = CharacterAbilityInput<"pedro_ramirez">;
type PedroChoiceResult = Extract<ReturnType<typeof pedroRamirezAbility>, { readonly kind: "choice_required" }>;

interface Fixture {
  readonly state: GameState;
  readonly actor: SeatState;
  readonly topCardId: string;
  readonly lowerCardId: string;
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seat(state: GameState, playerId: string): SeatState {
  const matches = state.seats.filter((entry) => entry.public.playerId === playerId);
  assert.equal(matches.length, 1, `expected one seat for ${playerId}`);
  return matches[0]!;
}

function fixture(options: { readonly emptyDrawPile?: boolean; readonly emptyDiscardPile?: boolean } = {}): Fixture {
  assert.ok(!(options.emptyDrawPile && options.emptyDiscardPile), "fixture keeps the tested source edge explicit");
  const state = initialState();
  const actor = seat(state, ACTOR_ID);
  actor.public.characterId = "pedro_ramirez";
  actor.public.maxHp = 4;
  actor.public.hp = 4;
  state.turn.currentPlayerId = ACTOR_ID;
  state.turn.phase = "draw";

  const allCardIds = Object.keys(state.zones.cardsByInstanceId);
  const actorHandId = allCardIds[0]!;
  const topCardId = allCardIds[1]!;
  const lowerCardId = allCardIds[2]!;
  const used = new Set([actorHandId, topCardId, lowerCardId]);
  actor.private.handCardInstanceIds = [actorHandId];
  for (const currentSeat of state.seats) {
    if (currentSeat.public.playerId !== ACTOR_ID) currentSeat.private.handCardInstanceIds = [];
    currentSeat.public.inPlayCardInstanceIds = [];
  }
  state.zones.revealedPoolCardInstanceIds = [];

  if (options.emptyDiscardPile) {
    state.zones.discardPileCardInstanceIds = [];
    state.zones.drawPileCardInstanceIds = allCardIds.filter((cardInstanceId) => cardInstanceId !== actorHandId);
  } else if (options.emptyDrawPile) {
    state.zones.drawPileCardInstanceIds = [];
    state.zones.discardPileCardInstanceIds = [
      ...allCardIds.filter((cardInstanceId) => !used.has(cardInstanceId)),
      lowerCardId,
      topCardId,
    ];
  } else {
    const drawCardId = allCardIds[3]!;
    used.add(drawCardId);
    state.zones.drawPileCardInstanceIds = [drawCardId];
    state.zones.discardPileCardInstanceIds = [
      ...allCardIds.filter((cardInstanceId) => !used.has(cardInstanceId)),
      lowerCardId,
      topCardId,
    ];
  }

  return { state, actor, topCardId, lowerCardId };
}

function hookFor(
  f: Fixture,
  options: { readonly discardTop?: boolean } = {},
): PedroFirstTurnDrawSlotHookInput {
  const hasDiscardTop = options.discardTop ?? true;
  return {
    kind: "draw_slot",
    timing: "before",
    distribution: { kind: "normal_turn", position: "first" },
    sourceOptions: {
      drawPile: { kind: "draw_pile", visibility: "recipient_only" },
      discardTop: hasDiscardTop
        ? { kind: "discard_top", cardInstanceId: f.topCardId, visibility: "public" }
        : null,
    },
  };
}

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("Pedro must not consume randomness"); } };
}

function makeInput(
  f: Fixture,
  hook: PedroFirstTurnDrawSlotHookInput = hookFor(f),
): PedroInput {
  return {
    characterId: "pedro_ramirez",
    playerId: f.actor.public.playerId,
    state: f.state,
    continuationFrameId: FRAME_ID,
    random: unusedRandom(),
    completedInteractions: [],
    hook,
  };
}

function choiceResult(input: PedroInput): PedroChoiceResult {
  const result = pedroRamirezAbility(input);
  assert.equal(result.kind, "choice_required");
  if (result.kind !== "choice_required") throw new Error(`expected choice_required, got ${result.kind}`);
  return result;
}

function resumeWithSource(input: PedroInput, prompt: PedroChoiceResult, source: string): PedroInput {
  return {
    ...input,
    completedInteractions: [{
      interactionId: "interaction-pedro-source",
      kind: prompt.request.kind,
      context: prompt.request.context,
      responses: [{ playerId: input.playerId, choice: "SELECT_SOURCE", payload: { source } }],
    }],
  };
}

function eventsOf(result: ReturnType<typeof pedroRamirezAbility>): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return result.events;
}

test("first ordinary draw prompts Pedro alone to choose the public discard top or normal draw pile", () => {
  const f = fixture();
  const input = makeInput(f);
  const before = structuredClone(f.state);
  const prompt = choiceResult(input);

  assert.equal(prompt.request.kind, "PEDRO_DISCARD_TOP");
  assert.deepEqual(prompt.request.responders.map(({ playerId }) => playerId), [ACTOR_ID]);
  assert.deepEqual(prompt.request.responders[0]?.options, [
    { choice: "SELECT_SOURCE", payload: { source: "DISCARD_TOP" } },
    { choice: "SELECT_SOURCE", payload: { source: "DRAW_PILE_TOP" } },
  ]);
  assert.deepEqual(prompt.request.context, {
    continuationFrameId: FRAME_ID,
    actorPlayerId: ACTOR_ID,
    discardTopCardInstanceId: f.topCardId,
  });
  assert.deepEqual(prompt.events, []);
  assert.deepEqual(prompt.steps, []);
  assert.deepEqual(f.state, before, "opening the source prompt does not mutate the state snapshot");
});

test("choosing discard top transfers only the current last discard card without mutating state", () => {
  const f = fixture();
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const resumed = resumeWithSource(input, prompt, "DISCARD_TOP");
  const before = structuredClone(f.state);

  const result = pedroRamirezAbility(resumed);
  const repeated = pedroRamirezAbility(resumed);
  const events = eventsOf(result);

  assert.deepEqual(result, repeated, "the same completed interaction yields deterministic event drafts");
  assert.deepEqual(events, [{
    type: "CARD_TRANSFERRED",
    actorPlayerId: ACTOR_ID,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId: f.topCardId,
      fromZone: "discard",
      toPlayerId: ACTOR_ID,
      toZone: "hand",
    },
  }]);
  assert.notEqual(events[0]?.payload.cardInstanceId, f.lowerCardId, "the earlier discard card is not selectable");
  assert.deepEqual(f.state, before, "the transfer is represented as a draft only");
});

test("choosing the draw pile leaves normal draw and R08 handling to the caller", () => {
  const f = fixture();
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const resumed = resumeWithSource(input, prompt, "DRAW_PILE_TOP");
  const before = structuredClone(f.state);

  const result = pedroRamirezAbility(resumed);
  assert.deepEqual(eventsOf(result), []);
  assert.deepEqual(f.state, before);
});

test("an empty draw pile still offers the current discard top before R08 is needed", () => {
  const f = fixture({ emptyDrawPile: true });
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const before = structuredClone(f.state);

  const result = pedroRamirezAbility(resumeWithSource(input, prompt, "DISCARD_TOP"));
  assert.equal(eventsOf(result)[0]?.payload.cardInstanceId, f.topCardId);
  assert.deepEqual(f.state, before);
});

test("an empty discard pile has no replacement choice and the draw caller owns the fallback", () => {
  const f = fixture({ emptyDiscardPile: true });
  const before = structuredClone(f.state);
  const input = makeInput(f, hookFor(f, { discardTop: false }));
  const result = pedroRamirezAbility(input);

  assert.deepEqual(result, { kind: "applied", events: [], steps: [] });
  assert.deepEqual(f.state, before);
});

test("only the first ordinary draw slot can open Pedro's replacement choice", () => {
  const f = fixture();
  const input = makeInput(f);
  const secondSlot = {
    ...input,
    hook: {
      ...hookFor(f),
      distribution: { kind: "normal_turn", position: "second" },
    },
  } as unknown as PedroInput;

  assert.deepEqual(pedroRamirezAbility(secondSlot), { kind: "applied", events: [], steps: [] });
});

test("a stale or forged top source and mismatched resumed top do not move a card", () => {
  const f = fixture();
  const input = makeInput(f);
  const staleInput = makeInput(f, {
    ...hookFor(f),
    sourceOptions: {
      ...hookFor(f).sourceOptions,
      discardTop: { kind: "discard_top", cardInstanceId: f.lowerCardId, visibility: "public" },
    },
  });
  assert.deepEqual(pedroRamirezAbility(staleInput), { kind: "applied", events: [], steps: [] });

  const prompt = choiceResult(input);
  const movedTopIndex = f.state.zones.discardPileCardInstanceIds.indexOf(f.topCardId);
  assert.notEqual(movedTopIndex, -1);
  f.state.zones.discardPileCardInstanceIds.splice(movedTopIndex, 1);
  f.actor.private.handCardInstanceIds.push(f.topCardId);
  const before = structuredClone(f.state);
  const result = pedroRamirezAbility(resumeWithSource(input, prompt, "DISCARD_TOP"));
  assert.deepEqual(eventsOf(result), []);
  assert.deepEqual(f.state, before, "a stale completed selection also returns no mutation");
});
