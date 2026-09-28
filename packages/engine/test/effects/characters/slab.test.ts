// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CharacterAbilityInput } from "../../../src/effects/character-api.ts";
import { slabAbility } from "../../../src/effects/characters/slab.ts";
import type { GameState } from "../../../src/state/types.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";

const SLAB_ID = "player-1";
const DEFENDER_ID = "player-2";

type SlabInput = CharacterAbilityInput<"slab_the_killer">;
type SlabQuery = Extract<SlabInput["hook"], { readonly kind: "attack_response_query" }>;
type Attack = SlabQuery["attack"];

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function makeState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  const slab = state.seats.find((seat) => seat.public.playerId === SLAB_ID)!;
  slab.public.characterId = "slab_the_killer";
  state.turn.currentPlayerId = SLAB_ID;
  state.turn.phase = "play";
  return state;
}

function cardOfType(state: GameState, typeId: string) {
  const card = Object.values(state.zones.cardsByInstanceId).find((candidate) =>
    TYPE_BY_DEFINITION_ID.get(candidate.cardDefinitionId) === typeId);
  if (!card) throw new Error(`fixture needs a ${typeId} card`);
  return card;
}

function bangAttack(state: GameState, overrides: Partial<Attack> = {}): Attack {
  const card = cardOfType(state, "bang");
  return {
    kind: "bang",
    attackerPlayerId: SLAB_ID,
    defenderPlayerId: DEFENDER_ID,
    card: {
      cardInstanceId: card.cardInstanceId,
      physicalCardTypeId: "bang",
      effectCardTypeId: "bang",
    },
    ...overrides,
  };
}

function queryHook(
  state: GameState,
  overrides: Partial<Omit<SlabQuery, "kind" | "perspective" | "attack">> = {},
  attack: Attack = bangAttack(state),
): SlabQuery {
  return {
    kind: "attack_response_query",
    perspective: "attacker",
    attack,
    missedCardsAlreadySubmitted: 0,
    judgmentSourcesAlreadyAttempted: [],
    ...overrides,
  };
}

function makeInput(
  state: GameState,
  hook: SlabInput["hook"],
  random: RandomSource = { nextFloat: () => { throw new Error("Slab query must not consume RNG"); } },
): SlabInput {
  return {
    characterId: "slab_the_killer",
    playerId: SLAB_ID,
    state,
    continuationFrameId: "frame-slab",
    random,
    completedInteractions: [],
    hook,
  };
}

function expected(additionalMissedCardsRequired: 0 | 1) {
  return {
    kind: "attack_response_query" as const,
    additionalMissedCardsRequired,
    availableJudgmentSources: [],
  };
}

test("Slab's own physical BANG adds one Missed while a resumed query retains that requirement", () => {
  const state = makeState();
  const before = structuredClone(state);

  const initial = slabAbility(makeInput(state, queryHook(state)));
  const resumed = slabAbility(makeInput(state, queryHook(state, {
    missedCardsAlreadySubmitted: 1,
    judgmentSourcesAlreadyAttempted: ["barrel", "jourdonnais"],
  })));

  assert.deepEqual(initial, expected(1));
  assert.deepEqual(resumed, expected(1), "one previously successful defense does not erase the second requirement");
  assert.deepEqual(state, before, "the query returns a result without changing its snapshot");
});

test("Gatling, another attacker's BANG, and Calamity's physical Missed conversion receive no Slab addition", () => {
  const state = makeState();
  const hook = queryHook(state);

  const gatling = {
    ...hook,
    attack: {
      kind: "gatling",
      attackerPlayerId: SLAB_ID,
      defenderPlayerId: DEFENDER_ID,
      card: {
        cardInstanceId: cardOfType(state, "gatling").cardInstanceId,
        physicalCardTypeId: "gatling",
        effectCardTypeId: "gatling",
      },
    },
  } as unknown as SlabQuery;
  assert.deepEqual(slabAbility(makeInput(state, gatling)), expected(0));

  const otherAttacker = queryHook(state, {}, bangAttack(state, { attackerPlayerId: DEFENDER_ID, defenderPlayerId: "player-3" }));
  assert.deepEqual(slabAbility(makeInput(state, otherAttacker)), expected(0));

  const convertedMissed = {
    ...hook,
    attack: {
      ...hook.attack,
      card: {
        cardInstanceId: cardOfType(state, "missed").cardInstanceId,
        physicalCardTypeId: "missed",
        effectCardTypeId: "bang",
      },
    },
  } as unknown as SlabQuery;
  assert.deepEqual(slabAbility(makeInput(state, convertedMissed)), expected(0));
});

test("rejects invalid character, attacker/defender identity, liveness, phase, and card references", () => {
  const state = makeState();
  const hook = queryHook(state);

  const wrongHookKind = { ...hook, kind: "judgment" } as unknown as SlabQuery;
  assert.deepEqual(slabAbility(makeInput(state, wrongHookKind)), expected(0));
  const wrongPerspective = { ...hook, perspective: "defender" } as unknown as SlabQuery;
  assert.deepEqual(slabAbility(makeInput(state, wrongPerspective)), expected(0));

  assert.deepEqual(
    slabAbility({ ...makeInput(state, hook), characterId: "bart_cassidy" } as unknown as SlabInput),
    expected(0),
  );

  const slab = state.seats.find((seat) => seat.public.playerId === SLAB_ID)!;
  slab.public.characterId = "bart_cassidy";
  assert.deepEqual(slabAbility(makeInput(state, hook)), expected(0));
  slab.public.characterId = "slab_the_killer";

  const attackerMismatch = queryHook(state, {}, bangAttack(state, { attackerPlayerId: "player-3" }));
  assert.deepEqual(slabAbility(makeInput(state, attackerMismatch)), expected(0));

  const selfAttack = queryHook(state, {}, bangAttack(state, { defenderPlayerId: SLAB_ID }));
  assert.deepEqual(slabAbility(makeInput(state, selfAttack)), expected(0));

  const target = state.seats.find((seat) => seat.public.playerId === DEFENDER_ID)!;
  target.public.eliminated = true;
  assert.deepEqual(slabAbility(makeInput(state, hook)), expected(0));
  target.public.eliminated = false;

  state.turn.phase = "draw";
  assert.deepEqual(slabAbility(makeInput(state, hook)), expected(0));
  state.turn.phase = "play";

  const forgedDefinition = queryHook(state, {}, bangAttack(state, {
    card: {
      cardInstanceId: cardOfType(state, "missed").cardInstanceId,
      physicalCardTypeId: "bang",
      effectCardTypeId: "bang",
    },
  }));
  assert.deepEqual(slabAbility(makeInput(state, forgedDefinition)), expected(0));

  const forgedPair = {
    ...hook,
    attack: { ...hook.attack, card: { ...hook.attack.card, effectCardTypeId: "missed" } },
  } as unknown as SlabQuery;
  assert.deepEqual(slabAbility(makeInput(state, forgedPair)), expected(0));
});

test("validates saved Missed and judgment progress before applying the query", () => {
  const state = makeState();
  const malformedHooks = [
    queryHook(state, { missedCardsAlreadySubmitted: -1 }),
    queryHook(state, { missedCardsAlreadySubmitted: 2 }),
    queryHook(state, { missedCardsAlreadySubmitted: Number.NaN }),
    queryHook(state, { judgmentSourcesAlreadyAttempted: ["barrel", "barrel"] }),
    queryHook(state, { judgmentSourcesAlreadyAttempted: ["unknown"] as unknown as SlabQuery["judgmentSourcesAlreadyAttempted"] }),
    queryHook(state, { judgmentSourcesAlreadyAttempted: null as unknown as SlabQuery["judgmentSourcesAlreadyAttempted"] }),
  ];

  for (const hook of malformedHooks) {
    assert.deepEqual(slabAbility(makeInput(state, hook)), expected(0));
  }

  const withBarrelAttempt = queryHook(state, { judgmentSourcesAlreadyAttempted: ["barrel"] });
  assert.deepEqual(slabAbility(makeInput(state, withBarrelAttempt)), expected(1));
});

test("the same valid input always returns the same result and never consumes the injected RNG", () => {
  const state = makeState();
  const input = makeInput(state, queryHook(state), { nextFloat: () => { throw new Error("unexpected random draw"); } });
  const first = slabAbility(input);
  const second = slabAbility(input);
  assert.deepEqual(first, expected(1));
  assert.deepEqual(second, first);
});
