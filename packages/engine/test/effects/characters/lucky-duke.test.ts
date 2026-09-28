// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CharacterAbilityInput, LuckyDrawJudgmentHookInput } from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { luckyDukeAbility } from "../../../src/effects/characters/lucky-duke.ts";

const ACTOR_ID = "player-1";
const FRAME_ID = "frame-lucky-duke";

type LuckyInput = CharacterAbilityInput<"lucky_duke">;
type LuckyChoiceResult = Extract<ReturnType<typeof luckyDukeAbility>, { readonly kind: "choice_required" }>;

interface Fixture {
  readonly state: GameState;
  readonly actor: SeatState;
  readonly candidateIds: readonly [string, string];
  readonly sourceCardInstanceId: string;
  readonly source: LuckyDrawJudgmentHookInput["judgment"]["source"];
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seatAt(state: GameState, playerId: string): SeatState {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  assert.equal(matches.length, 1, `fixture needs one seat for ${playerId}`);
  return matches[0]!;
}

function moveCardToInPlay(state: GameState, cardInstanceId: string, playerId: string): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  seatAt(state, playerId).public.inPlayCardInstanceIds.push(cardInstanceId);
}

function fixture(storage: "draw_pile" | "revealed_pool"): Fixture {
  const state = initialState();
  const actor = seatAt(state, ACTOR_ID);
  actor.public.characterId = "lucky_duke";
  actor.public.hp = 4;
  actor.public.maxHp = 4;
  state.status = "playing";

  const candidateIds = state.zones.drawPileCardInstanceIds.slice(0, 2) as [string, string];
  assert.equal(new Set(candidateIds).size, 2);
  if (storage === "revealed_pool") {
    state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.slice(2);
    state.zones.revealedPoolCardInstanceIds = [...candidateIds];
  }

  const jailDefinition = BASE_PHYSICAL_CARDS.find((card) => card.typeId === "jail");
  assert.ok(jailDefinition, "fixture needs the Jail definition");
  const sourceCard = Object.values(state.zones.cardsByInstanceId)
    .find((card) => card.cardDefinitionId === jailDefinition.definitionId && !candidateIds.includes(card.cardInstanceId));
  assert.ok(sourceCard, "fixture needs a separate Jail source card");
  moveCardToInPlay(state, sourceCard.cardInstanceId, "player-2");

  return {
    state,
    actor,
    candidateIds,
    sourceCardInstanceId: sourceCard.cardInstanceId,
    source: { kind: "jail", cardInstanceId: sourceCard.cardInstanceId },
  };
}

function hookFor(
  f: Fixture,
  selection: LuckyDrawJudgmentHookInput["judgment"]["selection"] = { kind: "awaiting_choice" },
): LuckyDrawJudgmentHookInput {
  const [first, second] = f.candidateIds.map((cardInstanceId) => f.state.zones.cardsByInstanceId[cardInstanceId]!);
  return {
    kind: "judgment",
    judgment: {
      kind: "lucky_draw",
      playerId: ACTOR_ID,
      source: f.source,
      candidates: [first, second],
      selection,
    },
  };
}

function unusedRandom() {
  return { nextFloat: () => { throw new Error("Lucky's choice must not consume randomness"); } };
}

function makeInput(
  f: Fixture,
  completedInteractions: LuckyInput["completedInteractions"] = [],
  selection: LuckyDrawJudgmentHookInput["judgment"]["selection"] = { kind: "awaiting_choice" },
): LuckyInput {
  return {
    characterId: "lucky_duke",
    playerId: ACTOR_ID,
    state: f.state,
    continuationFrameId: FRAME_ID,
    random: unusedRandom(),
    completedInteractions,
    hook: hookFor(f, selection),
  };
}

function choiceResult(input: LuckyInput): LuckyChoiceResult {
  const result = luckyDukeAbility(input);
  assert.equal(result.kind, "choice_required");
  if (result.kind !== "choice_required") throw new Error(`expected choice_required, got ${result.kind}`);
  return result;
}

function resumedInput(
  input: LuckyInput,
  prompt: LuckyChoiceResult,
  selectedCardInstanceId: string,
  orderedCardInstanceIds: readonly [string, string],
): LuckyInput {
  return {
    ...input,
    hook: {
      ...input.hook,
      judgment: {
        ...input.hook.judgment,
        selection: { kind: "selected", cardInstanceId: selectedCardInstanceId },
      },
    },
    completedInteractions: [{
      interactionId: "interaction-lucky-draw",
      kind: prompt.request.kind,
      context: prompt.request.context,
      responses: [{
        playerId: input.playerId,
        choice: "SELECT_JUDGMENT",
        payload: { selectedCardInstanceId, orderedCardInstanceIds: [...orderedCardInstanceIds] },
      }],
    }],
  };
}

function applyEvents(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const draft of events) {
    const cardInstanceId = draft.payload.cardInstanceId;
    const fromZone = draft.payload.fromZone;
    const toZone = draft.payload.toZone;
    assert.equal(typeof cardInstanceId, "string");
    assert.equal(typeof fromZone, "string");
    assert.equal(typeof toZone, "string");
    if (typeof cardInstanceId !== "string" || typeof fromZone !== "string" || typeof toZone !== "string") {
      throw new Error("card movement events need cardInstanceId and zones");
    }

    const removeFrom = (ids: string[]) => {
      const index = ids.indexOf(cardInstanceId);
      assert.notEqual(index, -1, `${cardInstanceId} must be in ${fromZone}`);
      ids.splice(index, 1);
    };
    const addTo = (ids: string[]) => ids.push(cardInstanceId);

    if (fromZone === "draw_pile") removeFrom(state.zones.drawPileCardInstanceIds);
    else if (fromZone === "revealed_pool") removeFrom(state.zones.revealedPoolCardInstanceIds);
    else assert.fail(`unexpected source zone ${fromZone}`);

    if (toZone === "revealed_pool") addTo(state.zones.revealedPoolCardInstanceIds);
    else if (toZone === "discard") addTo(state.zones.discardPileCardInstanceIds);
    else assert.fail(`unexpected destination zone ${toZone}`);
  }
}

test("Lucky prompts only itself to select one of two public candidates and choose their discard order", () => {
  const f = fixture("draw_pile");
  const input = makeInput(f);
  const before = structuredClone(f.state);
  const prompt = choiceResult(input);

  assert.equal(prompt.request.kind, "LUCKY_DRAW");
  assert.deepEqual(prompt.request.responders.map(({ playerId }) => playerId), [ACTOR_ID]);
  assert.equal(prompt.request.resumeFrameId, FRAME_ID);
  const options = prompt.request.responders[0]!.options;
  assert.equal(options.length, 4, "each selected candidate accepts both D04 discard orders");
  for (const selectedCardInstanceId of f.candidateIds) {
    for (const orderedCardInstanceIds of [f.candidateIds, [...f.candidateIds].reverse()] as const) {
      assert.ok(options.some((option) => option.choice === "SELECT_JUDGMENT" &&
        option.payload.selectedCardInstanceId === selectedCardInstanceId &&
        JSON.stringify(option.payload.orderedCardInstanceIds) === JSON.stringify(orderedCardInstanceIds)));
    }
  }
  assert.deepEqual(prompt.events.map(({ type }) => type), ["CARD_TRANSFERRED", "CARD_TRANSFERRED"]);
  assert.deepEqual(prompt.events.map(({ payload }) => [payload.fromZone, payload.toZone]), [
    ["draw_pile", "revealed_pool"],
    ["draw_pile", "revealed_pool"],
  ]);
  assert.deepEqual(f.state, before, "the choice only returns drafts and leaves its snapshot untouched");

  applyEvents(f.state, prompt.events);
  assert.deepEqual(f.state.zones.revealedPoolCardInstanceIds, f.candidateIds);
  const selectedCardInstanceId = f.candidateIds[1];
  const chosenOrder = [f.candidateIds[1], f.candidateIds[0]] as const;
  const beforeResolve = structuredClone(f.state);
  const resolved = luckyDukeAbility(resumedInput(input, prompt, selectedCardInstanceId, chosenOrder));
  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") throw new Error(`expected applied, got ${resolved.kind}`);
  assert.deepEqual(resolved.events.map(({ type }) => type), ["CARD_DISCARDED", "CARD_DISCARDED"]);
  assert.deepEqual(resolved.events.map(({ payload }) => payload.cardInstanceId), chosenOrder);
  assert.ok(resolved.events.every(({ payload }) => payload.fromZone === "revealed_pool" && payload.toZone === "discard"));
  assert.ok(resolved.events.every(({ payload }) => payload.sourceCardInstanceId === f.sourceCardInstanceId));
  assert.deepEqual(f.state, beforeResolve, "the selected result also returns event drafts without mutation");

  applyEvents(f.state, resolved.events);
  assert.deepEqual(f.state.zones.revealedPoolCardInstanceIds, []);
  assert.deepEqual(f.state.zones.discardPileCardInstanceIds.slice(-2), chosenOrder);
  assert.ok(seatAt(f.state, "player-2").public.inPlayCardInstanceIds.includes(f.sourceCardInstanceId),
    "the caller leaves Jail resolution to happen after both Lucky cards");
});

test("already supplied candidates are resolved without repeating reveal or consuming RNG", () => {
  const f = fixture("revealed_pool");
  const input = makeInput(f);
  const prompt = choiceResult(input);
  assert.deepEqual(prompt.events, []);

  const order = [f.candidateIds[0], f.candidateIds[1]] as const;
  const resolved = luckyDukeAbility(resumedInput(input, prompt, order[0], order));
  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") throw new Error(`expected applied, got ${resolved.kind}`);
  assert.deepEqual(resolved.events.map(({ payload }) => payload.cardInstanceId), order);
  assert.ok(resolved.events.every(({ payload }) => payload.fromZone === "revealed_pool"));
});

test("stale candidates, forged choices, dead actors, and non-Lucky draw hooks are ignored", () => {
  const f = fixture("revealed_pool");
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const zero = { kind: "applied", events: [], steps: [] } as const;

  const mismatchedSelection = resumedInput(input, prompt, "not-a-candidate", f.candidateIds);
  assert.deepEqual(luckyDukeAbility(mismatchedSelection), zero);

  const invalidOrder = resumedInput(input, prompt, f.candidateIds[0], [f.candidateIds[0], f.candidateIds[0]]);
  assert.deepEqual(luckyDukeAbility(invalidOrder), zero);

  const wrongResponder = resumedInput(input, prompt, f.candidateIds[0], f.candidateIds);
  const forgedResponder: LuckyInput = {
    ...wrongResponder,
    completedInteractions: wrongResponder.completedInteractions.map((interaction) => ({
      ...interaction,
      responses: interaction.responses.map((response) => ({ ...response, playerId: "player-2" })),
    })),
  };
  assert.deepEqual(luckyDukeAbility(forgedResponder), zero);

  const duplicateCandidates: LuckyInput = {
    ...input,
    hook: {
      ...input.hook,
      judgment: { ...input.hook.judgment, candidates: [input.hook.judgment.candidates[0], input.hook.judgment.candidates[0]] },
    },
  };
  assert.deepEqual(luckyDukeAbility(duplicateCandidates), zero);

  f.actor.public.eliminated = true;
  assert.deepEqual(luckyDukeAbility(input), zero);
  f.actor.public.eliminated = false;

  const nonLuckyHook = {
    ...input,
    hook: {
      kind: "draw_slot",
      timing: "after",
      distribution: { kind: "normal_turn", position: "second" },
      source: { kind: "draw_pile" },
      visibility: "public",
      card: { cardInstanceId: f.candidateIds[0] },
    },
  } as unknown as LuckyInput;
  assert.deepEqual(luckyDukeAbility(nonLuckyHook), zero);
});
