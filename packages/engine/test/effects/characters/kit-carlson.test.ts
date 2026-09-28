// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CharacterAbilityInput, DrawPhaseHookInput } from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { projectMatchSnapshot } from "../../../src/state/projection.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { kitCarlsonAbility } from "../../../src/effects/characters/kit-carlson.ts";

const FRAME_ID = "frame-kit-carlson";
const ACTOR_ID = "player-1";

type KitInput = CharacterAbilityInput<"kit_carlson">;
type KitChoiceResult = Extract<ReturnType<typeof kitCarlsonAbility>, { readonly kind: "choice_required" }>;
type Storage = "draw_pile" | "revealed_pool";

interface Fixture {
  readonly state: GameState;
  readonly actor: SeatState;
  readonly candidates: readonly [string, string, string];
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function fixture(storage: Storage = "draw_pile"): Fixture {
  const state = initialState();
  const actor = state.seats.find((seat) => seat.public.playerId === ACTOR_ID);
  if (!actor) throw new Error(`missing actor seat ${ACTOR_ID}`);
  actor.public.characterId = "kit_carlson";
  actor.public.hp = 4;
  actor.public.maxHp = 4;
  state.turn.currentPlayerId = ACTOR_ID;
  state.turn.phase = "draw";

  const allCardIds = Object.keys(state.zones.cardsByInstanceId);
  const candidates = allCardIds.slice(0, 3) as [string, string, string];
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = [];
    seat.public.inPlayCardInstanceIds = [];
  }
  state.zones.discardPileCardInstanceIds = [];
  state.zones.revealedPoolCardInstanceIds = storage === "revealed_pool" ? [...candidates] : [];
  state.zones.drawPileCardInstanceIds = storage === "draw_pile"
    ? [...candidates, ...allCardIds.slice(3)]
    : allCardIds.slice(3);

  return { state, actor, candidates };
}

function hookFor(f: Fixture): DrawPhaseHookInput {
  const [first, second, third] = f.candidates.map((cardInstanceId) => f.state.zones.cardsByInstanceId[cardInstanceId]!);
  return {
    kind: "draw_phase",
    timing: "before",
    distribution: "normal_turn",
    requestedCardCount: 2,
    candidates: [first, second, third],
    source: { kind: "draw_pile" },
    visibility: "recipient_only",
  };
}

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("Kit's selection must not consume randomness"); } };
}

function makeInput(f: Fixture, completedInteractions: KitInput["completedInteractions"] = []): KitInput {
  return {
    characterId: "kit_carlson",
    playerId: f.actor.public.playerId,
    state: f.state,
    continuationFrameId: FRAME_ID,
    random: unusedRandom(),
    completedInteractions,
    hook: hookFor(f),
  };
}

function choiceResult(input: KitInput): KitChoiceResult {
  const result = kitCarlsonAbility(input);
  assert.equal(result.kind, "choice_required");
  if (result.kind !== "choice_required") throw new Error(`expected choice_required, got ${result.kind}`);
  return result;
}

function resumeWithChoice(
  input: KitInput,
  prompt: KitChoiceResult,
  selectedCardInstanceIds: readonly [string, string],
): KitInput {
  return {
    ...input,
    completedInteractions: [{
      interactionId: "interaction-kit-pick",
      kind: prompt.request.kind,
      context: prompt.request.context,
      responses: [{
        playerId: input.playerId,
        choice: "CHOOSE_CARDS",
        payload: { selectedCardInstanceIds: [...selectedCardInstanceIds] },
      }],
    }],
  };
}

function appliedEvents(result: ReturnType<typeof kitCarlsonAbility>): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return result.events;
}

function eventString(payload: Readonly<Record<string, unknown>>, key: string): string {
  const value = payload[key];
  assert.equal(typeof value, "string");
  if (typeof value !== "string") throw new Error(`expected ${key} to be a string`);
  return value;
}

function applyDrafts(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const draft of events) {
    const cardInstanceId = eventString(draft.payload, "cardInstanceId");
    const fromZone = eventString(draft.payload, "fromZone");
    const toZone = eventString(draft.payload, "toZone");

    if (fromZone === "draw_pile") {
      const index = state.zones.drawPileCardInstanceIds.indexOf(cardInstanceId);
      assert.notEqual(index, -1);
      state.zones.drawPileCardInstanceIds.splice(index, 1);
    } else if (fromZone === "revealed_pool") {
      const index = state.zones.revealedPoolCardInstanceIds.indexOf(cardInstanceId);
      assert.notEqual(index, -1);
      state.zones.revealedPoolCardInstanceIds.splice(index, 1);
    } else {
      assert.fail(`unexpected source zone ${fromZone}`);
    }

    if (toZone === "hand") {
      const playerIdValue = draft.payload.toPlayerId ?? draft.payload.playerId;
      assert.equal(typeof playerIdValue, "string");
      if (typeof playerIdValue !== "string") throw new Error("expected hand recipient ID");
      const playerId = playerIdValue;
      const recipient = state.seats.find((seat) => seat.public.playerId === playerId);
      if (!recipient) throw new Error(`missing recipient seat ${playerId}`);
      recipient.private.handCardInstanceIds.push(cardInstanceId);
    } else if (toZone === "draw_pile") {
      state.zones.drawPileCardInstanceIds.unshift(cardInstanceId);
    } else {
      assert.fail(`unexpected destination zone ${toZone}`);
    }
  }
}

function definitionId(f: Fixture, cardInstanceId: string): string {
  const card = f.state.zones.cardsByInstanceId[cardInstanceId];
  assert.ok(card);
  return card.cardDefinitionId;
}

test("Kit offers all 2-of-3 choices only to its owner and leaves the snapshot unchanged", () => {
  const f = fixture("draw_pile");
  const before = structuredClone(f.state);
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const ids = f.candidates;
  const options = prompt.request.responders[0]?.options ?? [];

  assert.deepEqual(prompt.request.responders.map(({ playerId }) => playerId), [ACTOR_ID]);
  assert.equal(prompt.request.kind, "KIT_CARLSON_PICK");
  assert.equal(prompt.request.resumeFrameId, FRAME_ID);
  assert.equal(options.length, 6, "each pair accepts either selected ID order");
  for (const pair of [[ids[0], ids[1]], [ids[0], ids[2]], [ids[1], ids[2]]] as const) {
    assert.ok(options.some((option) => option.choice === "CHOOSE_CARDS" &&
      JSON.stringify(option.payload.selectedCardInstanceIds) === JSON.stringify(pair)));
    assert.ok(options.some((option) => option.choice === "CHOOSE_CARDS" &&
      JSON.stringify(option.payload.selectedCardInstanceIds) === JSON.stringify([...pair].reverse())));
  }
  assert.ok(!JSON.stringify(prompt.request.context).includes(ids[0]));
  assert.deepEqual(f.state, before, "the choice prompt does not move or reveal cards in the input snapshot");
});

test("choosing two of the top three draws them and leaves the unselected candidate on top", () => {
  const f = fixture("draw_pile");
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const selected = [f.candidates[2], f.candidates[0]] as const;
  const before = structuredClone(f.state);
  const resumed = resumeWithChoice(input, prompt, selected);
  const result = kitCarlsonAbility(resumed);
  const repeated = kitCarlsonAbility(resumeWithChoice(input, prompt, selected));
  const events = appliedEvents(result);

  assert.deepEqual(result, repeated, "a saved pick replays to the same event drafts");
  assert.deepEqual(events.map((event) => event.type), ["CARD_DRAWN", "CARD_DRAWN"]);
  assert.deepEqual(events.map((event) => event.payload.cardInstanceId), [f.candidates[0], f.candidates[2]]);
  assert.ok(events.every((event) => event.payload.fromZone === "draw_pile" && event.payload.toZone === "hand"));
  assert.deepEqual(f.state, before, "the selection returns event drafts without mutating state");

  const after = structuredClone(f.state);
  applyDrafts(after, events);
  assert.deepEqual(after.seats.find((seat) => seat.public.playerId === ACTOR_ID)?.private.handCardInstanceIds, [
    f.candidates[0], f.candidates[2],
  ]);
  assert.equal(after.zones.drawPileCardInstanceIds[0], f.candidates[1]);
});

test("a caller-provided private reveal pool returns the unselected card to draw-pile top", () => {
  const f = fixture("revealed_pool");
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const events = appliedEvents(kitCarlsonAbility(resumeWithChoice(input, prompt, [f.candidates[0], f.candidates[2]])));

  assert.deepEqual(events.map((event) => event.type), ["CARD_TRANSFERRED", "CARD_TRANSFERRED", "CARD_TRANSFERRED"]);
  assert.deepEqual(events.map((event) => event.payload.cardInstanceId), [
    f.candidates[0], f.candidates[2], f.candidates[1],
  ]);
  assert.deepEqual(events.map((event) => [event.payload.fromZone, event.payload.toZone]), [
    ["revealed_pool", "hand"],
    ["revealed_pool", "hand"],
    ["revealed_pool", "draw_pile"],
  ]);

  const after = structuredClone(f.state);
  applyDrafts(after, events);
  assert.deepEqual(after.seats.find((seat) => seat.public.playerId === ACTOR_ID)?.private.handCardInstanceIds, [
    f.candidates[0], f.candidates[2],
  ]);
  assert.equal(after.zones.drawPileCardInstanceIds[0], f.candidates[1]);
  assert.deepEqual(after.zones.revealedPoolCardInstanceIds, []);
});

test("other viewer projections do not expose any of the private candidate cards", () => {
  const f = fixture("revealed_pool");
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const responder = prompt.request.responders[0]!;
  f.state.resolution.pendingInteraction = {
    interactionId: "interaction-kit-pick",
    kind: prompt.request.kind,
    actorPlayerIds: [ACTOR_ID],
    options: responder.options.map(({ choice, payload }) => ({ choice, payload: { ...payload } })),
    context: { ...prompt.request.context },
    resumeFrameId: FRAME_ID,
    createdAt: "2026-09-28T00:00:00.000Z",
  };
  const otherView = projectMatchSnapshot(f.state, "player-2", BASE_PHYSICAL_CARDS);
  const serializedOther = JSON.stringify(otherView);

  assert.deepEqual(prompt.request.responders.map(({ playerId }) => playerId), [ACTOR_ID]);
  assert.deepEqual(otherView.pendingInteraction, {
    interactionId: "interaction-kit-pick",
    kind: "KIT_CARLSON_PICK",
    allowedChoices: [],
    currentResponderPlayerId: ACTOR_ID,
    step: { current: 1, total: 1 },
  });
  assert.equal(Object.hasOwn(otherView.pendingInteraction ?? {}, "responseOptions"), false);
  assert.equal(Object.hasOwn(otherView.pendingInteraction ?? {}, "discardOrder"), false);
  for (const cardInstanceId of f.candidates) {
    assert.ok(!serializedOther.includes(cardInstanceId));
    assert.ok(!serializedOther.includes(definitionId(f, cardInstanceId)));
  }
});

test("Kit does not draw, reshuffle, or consume RNG when the draw caller has not supplied three current candidates", () => {
  const f = fixture("draw_pile");
  const returnedToDiscard = f.candidates[2];
  f.state.zones.drawPileCardInstanceIds.splice(2, 1);
  f.state.zones.discardPileCardInstanceIds.push(returnedToDiscard);
  const input = makeInput(f);
  const before = structuredClone(f.state);

  const result = kitCarlsonAbility(input);

  assert.deepEqual(result, { kind: "applied", events: [], steps: [] });
  assert.deepEqual(f.state, before);
});
