// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type {
  CharacterAbilityInput,
  JesseFirstTurnDrawSlotHookInput,
} from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { jesseJonesAbility } from "../../../src/effects/characters/jesse-jones.ts";

const FRAME_ID = "frame-jesse-jones";
const ACTOR_ID = "player-1";
const SOURCE_ID = "player-2";

type JesseInput = CharacterAbilityInput<"jesse_jones">;
type JesseChoiceResult = Extract<ReturnType<typeof jesseJonesAbility>, { readonly kind: "choice_required" }>;

interface Fixture {
  readonly state: GameState;
  readonly actor: SeatState;
  readonly source: SeatState;
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

function cardIdsOfType(state: GameState, typeId: string): string[] {
  const definitions = new Set(
    BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId).map((card) => card.definitionId),
  );
  assert.ok(definitions.size > 0, `missing physical card type ${typeId}`);
  return Object.values(state.zones.cardsByInstanceId)
    .filter((card) => definitions.has(card.cardDefinitionId))
    .map((card) => card.cardInstanceId);
}

function setZones(
  state: GameState,
  hands: Readonly<Record<string, readonly string[]>>,
  drawPile: readonly string[],
): void {
  const explicitlyAssigned = [
    ...Object.values(hands).flatMap((cardInstanceIds) => [...cardInstanceIds]),
    ...drawPile,
  ];
  assert.equal(new Set(explicitlyAssigned).size, explicitlyAssigned.length, "fixture cards must be unique");
  assert.ok(explicitlyAssigned.every((cardInstanceId) => state.zones.cardsByInstanceId[cardInstanceId]));

  for (const currentSeat of state.seats) {
    currentSeat.private.handCardInstanceIds = [...(hands[currentSeat.public.playerId] ?? [])];
    currentSeat.public.inPlayCardInstanceIds = [];
  }
  state.zones.drawPileCardInstanceIds = [...drawPile];
  const assigned = new Set(explicitlyAssigned);
  state.zones.discardPileCardInstanceIds = Object.keys(state.zones.cardsByInstanceId)
    .filter((cardInstanceId) => !assigned.has(cardInstanceId));
  state.zones.revealedPoolCardInstanceIds = [];
}

function fixture(
  sourceHandCount = 3,
  options: { readonly drawPileCount?: number; readonly otherHandCount?: number; readonly deadHandCount?: number } = {},
): Fixture {
  const state = initialState();
  const actor = seat(state, ACTOR_ID);
  const source = seat(state, SOURCE_ID);
  actor.public.characterId = "jesse_jones";
  actor.public.maxHp = 4;
  actor.public.hp = 4;
  state.turn.currentPlayerId = ACTOR_ID;
  state.turn.phase = "draw";

  const bangIds = cardIdsOfType(state, "bang");
  const handIds = bangIds.slice(0, sourceHandCount);
  const otherHandCount = options.otherHandCount ?? 0;
  const otherHandIds = bangIds.slice(sourceHandCount, sourceHandCount + otherHandCount);
  const deadHandCount = options.deadHandCount ?? 0;
  const deadHandIds = bangIds.slice(sourceHandCount + otherHandCount, sourceHandCount + otherHandCount + deadHandCount);
  const drawPileCount = options.drawPileCount ?? 2;
  const drawPileIds = cardIdsOfType(state, "beer").slice(0, drawPileCount);

  const hands: Record<string, readonly string[]> = {
    [SOURCE_ID]: handIds,
    "player-3": otherHandIds,
    "player-4": deadHandIds,
  };
  if (deadHandCount > 0) seat(state, "player-4").public.eliminated = true;
  setZones(state, hands, drawPileIds);
  return { state, actor, source };
}

function hookFor(state: GameState, actorPlayerId = ACTOR_ID): JesseFirstTurnDrawSlotHookInput {
  return {
    kind: "draw_slot",
    timing: "before",
    distribution: { kind: "normal_turn", position: "first" },
    sourceOptions: {
      drawPile: { kind: "draw_pile", visibility: "recipient_only" },
      eligibleOpponentHands: state.seats
        .filter((entry) => entry.public.playerId !== actorPlayerId &&
          !entry.public.eliminated && entry.public.hp > 0 && entry.private.handCardInstanceIds.length > 0)
        .map((entry) => ({
          kind: "opponent_hand" as const,
          playerId: entry.public.playerId,
          handCardCount: entry.private.handCardInstanceIds.length,
          visibility: "recipient_only" as const,
        })),
    },
  };
}

function fixedRandom(values: readonly number[]): { readonly random: RandomSource; readonly calls: () => number } {
  let cursor = 0;
  return {
    random: {
      nextFloat() {
        const value = values[cursor];
        if (value === undefined) throw new Error("random fixture exhausted");
        cursor += 1;
        return value;
      },
    },
    calls: () => cursor,
  };
}

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("this path must not consume randomness"); } };
}

function makeInput(f: Fixture, random: RandomSource = unusedRandom()): JesseInput {
  return {
    characterId: "jesse_jones",
    playerId: f.actor.public.playerId,
    state: f.state,
    continuationFrameId: FRAME_ID,
    random,
    completedInteractions: [],
    hook: hookFor(f.state, f.actor.public.playerId),
  };
}

function choiceResult(input: JesseInput): JesseChoiceResult {
  const result = jesseJonesAbility(input);
  assert.equal(result.kind, "choice_required");
  if (result.kind !== "choice_required") throw new Error(`expected choice_required, got ${result.kind}`);
  return result;
}

function resumeWithChoice(
  input: JesseInput,
  prompt: JesseChoiceResult,
  choice: string,
  payload: Readonly<Record<string, string>>,
): JesseInput {
  return {
    ...input,
    completedInteractions: [{
      interactionId: "interaction-jesse-source",
      kind: prompt.request.kind,
      context: prompt.request.context,
      responses: [{ playerId: input.playerId, choice, payload }],
    }],
  };
}

function transferEvents(result: ReturnType<typeof jesseJonesAbility>): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied, got ${result.kind}`);
  return result.events;
}

test("the first slot offers only living nonempty hands and keeps the source options Jesse-only", () => {
  const f = fixture(2, { otherHandCount: 1, deadHandCount: 1 });
  const before = structuredClone(f.state);
  const input = makeInput(f);
  const prompt = choiceResult(input);

  assert.deepEqual(prompt.request.responders.map(({ playerId }) => playerId), [ACTOR_ID]);
  assert.deepEqual(prompt.request.responders[0]?.options, [
    { choice: "DRAW_FROM_PILE", payload: {} },
    { choice: "TAKE_FROM_HAND", payload: { sourcePlayerId: SOURCE_ID } },
    { choice: "TAKE_FROM_HAND", payload: { sourcePlayerId: "player-3" } },
  ]);
  assert.ok(!prompt.request.responders[0]?.options.some((option) =>
    Object.keys(option.payload).some((key) => key.toLowerCase().includes("cardinstance"))));
  assert.ok(!JSON.stringify(prompt.request).includes(f.source.private.handCardInstanceIds[0]!));
  assert.equal(prompt.request.resumeFrameId, FRAME_ID);
  assert.deepEqual(f.state, before, "asking Jesse to choose must not mutate the snapshot");
});

test("taking from a selected hand uses injected RNG once and transfers one current physical card", () => {
  const f = fixture(3);
  const originalInput = makeInput(f);
  const prompt = choiceResult(originalInput);
  const expectedCardId = f.source.private.handCardInstanceIds[2]!;
  const rng = fixedRandom([0.8]);
  const resumed = resumeWithChoice(originalInput, prompt, "TAKE_FROM_HAND", { sourcePlayerId: SOURCE_ID });
  const before = structuredClone(f.state);

  const firstResult = jesseJonesAbility({ ...resumed, random: rng.random });
  const repeat = jesseJonesAbility({ ...resumed, random: fixedRandom([0.8]).random });

  assert.deepEqual(firstResult, repeat, "the same state, completed choice, and RNG sequence replay identically");
  const events = transferEvents(firstResult);
  assert.equal(rng.calls(), 1);
  assert.deepEqual(events, [{
    type: "CARD_TRANSFERRED",
    actorPlayerId: ACTOR_ID,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId: expectedCardId,
      fromPlayerId: SOURCE_ID,
      fromZone: "hand",
      toPlayerId: ACTOR_ID,
      toZone: "hand",
    },
  }]);
  assert.deepEqual(f.state, before, "the transfer is an event draft, not a direct snapshot mutation");
});

test("the selected source is rechecked against the current hand before random selection", () => {
  const f = fixture(2);
  const initialInput = makeInput(f);
  const prompt = choiceResult(initialInput);
  const remainingCardId = f.source.private.handCardInstanceIds[1]!;
  const removedCardId = f.source.private.handCardInstanceIds[0]!;
  f.source.private.handCardInstanceIds = [remainingCardId];
  f.state.zones.discardPileCardInstanceIds.push(removedCardId);

  const currentInput: JesseInput = {
    ...initialInput,
    hook: hookFor(f.state),
    completedInteractions: [{
      interactionId: "interaction-jesse-source",
      kind: prompt.request.kind,
      context: prompt.request.context,
      responses: [{ playerId: ACTOR_ID, choice: "TAKE_FROM_HAND", payload: { sourcePlayerId: SOURCE_ID } }],
    }],
  };
  const result = jesseJonesAbility({ ...currentInput, random: fixedRandom([0.99]).random });

  assert.deepEqual(transferEvents(result).map((event) => event.payload.cardInstanceId), [remainingCardId]);
});

test("empty opponent hands are not offered, and the ordinary deck draw remains the fallback", () => {
  const f = fixture(0, { drawPileCount: 2 });
  const input = makeInput(f);
  const before = structuredClone(f.state);

  const result = jesseJonesAbility(input);

  assert.deepEqual(result, { kind: "applied", events: [], steps: [] });
  assert.deepEqual(f.state, before);
});

test("choosing the draw pile leaves R08 and resource exhaustion to the draw caller", () => {
  const f = fixture(1, { drawPileCount: 0 });
  const input = makeInput(f);
  const prompt = choiceResult(input);
  const resumed = resumeWithChoice(input, prompt, "DRAW_FROM_PILE", {});
  const before = structuredClone(f.state);

  const result = jesseJonesAbility(resumed);

  assert.deepEqual(result, { kind: "applied", events: [], steps: [] });
  assert.deepEqual(f.state, before, "the draw caller handles R08 reshuffle or the documented exhausted-resource pause");
});

test("a second draw slot cannot activate Jesse's first-slot substitution", () => {
  const f = fixture(1);
  const input = makeInput(f);
  const malformedSecondSlot = {
    ...input,
    hook: {
      ...input.hook,
      distribution: { kind: "normal_turn" as const, position: "second" as const },
    },
  } as unknown as JesseInput;

  const result = jesseJonesAbility(malformedSecondSlot);

  assert.deepEqual(result, { kind: "applied", events: [], steps: [] });
});

function compileTimeFirstSlotOnly(input: JesseInput): void {
  const secondSlotHook: JesseFirstTurnDrawSlotHookInput = {
    ...input.hook,
    // @ts-expect-error Jesse's public hook only accepts the first normal-turn slot.
    distribution: { kind: "normal_turn", position: "second" },
  };
  void secondSlotHook;
}
void compileTimeFirstSlotOnly;
