// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type {
  AttackResponseQueryHookInput,
  CharacterAbilityInput,
  JourdonnaisJudgmentHookInput,
} from "../../../src/effects/character-api.ts";
import type { GameState } from "../../../src/state/types.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { jourdonnaisAbility } from "../../../src/effects/characters/jourdonnais.ts";

const FRAME_ID = "frame-jourdonnais";
const PLAYER_ID = "player-1";
const ATTACKER_ID = "player-2";

type JourdonnaisInput = CharacterAbilityInput<"jourdonnais">;
type JourdonnaisAttackQuery = Extract<JourdonnaisInput["hook"], { readonly kind: "attack_response_query" }>;

function makeState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  const target = state.seats.find((seat) => seat.public.playerId === PLAYER_ID)!;
  target.public.characterId = "jourdonnais";
  return state;
}

function bangAttack(overrides: Partial<AttackResponseQueryHookInput["attack"]> = {}): AttackResponseQueryHookInput["attack"] {
  return {
    kind: "bang",
    attackerPlayerId: ATTACKER_ID,
    defenderPlayerId: PLAYER_ID,
    card: { cardInstanceId: "card-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
    ...overrides,
  };
}

function queryHook(
  overrides: Partial<Omit<JourdonnaisAttackQuery, "kind" | "perspective" | "attack">> = {},
  attack: AttackResponseQueryHookInput["attack"] = bangAttack(),
): JourdonnaisAttackQuery {
  return {
    kind: "attack_response_query",
    perspective: "defender",
    attack,
    missedCardsAlreadySubmitted: 0,
    judgmentSourcesAlreadyAttempted: [],
    ...overrides,
  };
}

function makeInput(
  state: GameState,
  hook: JourdonnaisInput["hook"],
  random: RandomSource = { nextFloat: () => { throw new Error("Jourdonnais must not consume RNG"); } },
): JourdonnaisInput {
  return {
    characterId: "jourdonnais",
    playerId: PLAYER_ID,
    state,
    continuationFrameId: FRAME_ID,
    random,
    completedInteractions: [],
    hook,
  };
}

function judgmentHook(state: GameState, suit: "HEARTS" | "SPADES"): JourdonnaisJudgmentHookInput {
  const candidate = Object.values(state.zones.cardsByInstanceId).find((card) => card.suit === suit);
  if (!candidate) throw new Error(`fixture needs a ${suit} candidate`);
  return {
    kind: "judgment",
    judgment: {
      kind: "jourdonnais",
      playerId: PLAYER_ID,
      attack: bangAttack(),
      candidate,
    },
  };
}

test("offers one virtual Barrel source for BANG and Gatling attacks", () => {
  const state = makeState();
  const bang = jourdonnaisAbility(makeInput(state, queryHook({ missedCardsAlreadySubmitted: 1 })));
  assert.deepEqual(bang, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: ["jourdonnais"],
  });

  const gatlingAttack = bangAttack({
    kind: "gatling",
    card: { cardInstanceId: "card-gatling", physicalCardTypeId: "gatling", effectCardTypeId: "gatling" },
  });
  const gatling = jourdonnaisAbility(makeInput(state, queryHook({}, gatlingAttack)));
  assert.deepEqual(gatling, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: ["jourdonnais"],
  });
});

test("does not offer the virtual source after it was attempted or for another defender", () => {
  const state = makeState();
  const barrelAlreadyAttempted = jourdonnaisAbility(makeInput(state, queryHook({ judgmentSourcesAlreadyAttempted: ["barrel"] })));
  assert.deepEqual(barrelAlreadyAttempted, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: ["jourdonnais"],
  }, "attempting an equipped Barrel does not consume the separate Jourdonnais check");

  const attempted = jourdonnaisAbility(makeInput(state, queryHook({ judgmentSourcesAlreadyAttempted: ["jourdonnais"] })));
  assert.deepEqual(attempted, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: [],
  });

  const wrongTargetAttack = bangAttack({ defenderPlayerId: "player-3" });
  const wrongTarget = jourdonnaisAbility(makeInput(state, queryHook({}, wrongTargetAttack)));
  assert.deepEqual(wrongTarget, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: [],
  });
});

test("only a living Jourdonnais can offer the ability, and only for matching BANG-symbol cards", () => {
  const state = makeState();
  const target = state.seats.find((seat) => seat.public.playerId === PLAYER_ID)!;
  target.public.eliminated = true;
  const eliminated = jourdonnaisAbility(makeInput(state, queryHook()));
  assert.deepEqual(eliminated, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: [],
  });

  target.public.eliminated = false;
  target.public.characterId = "bart_cassidy";
  const otherCharacter = jourdonnaisAbility(makeInput(state, queryHook()));
  assert.deepEqual(otherCharacter, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: [],
  });

  target.public.characterId = "jourdonnais";
  const nonBangAttack = bangAttack({
    kind: "gatling",
    card: { cardInstanceId: "wrong-card", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
  });
  const mismatch = jourdonnaisAbility(makeInput(state, queryHook({}, nonBangAttack)));
  assert.deepEqual(mismatch, {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: [],
  });
});

test("a Heart judgment contributes one Missed and a non-Heart contributes none", () => {
  const state = makeState();
  const before = structuredClone(state);
  const heart = jourdonnaisAbility(makeInput(state, judgmentHook(state, "HEARTS")));
  const spade = jourdonnaisAbility(makeInput(state, judgmentHook(state, "SPADES")));

  assert.equal(heart.kind, "applied");
  if (heart.kind !== "applied") return;
  assert.equal(spade.kind, "applied");
  if (spade.kind !== "applied") return;

  assert.equal(heart.events[0]?.type, "BARREL_CHECK_RESOLVED");
  assert.deepEqual(heart.events[0]?.payload, {
    attackKind: "BANG",
    defenseSource: "jourdonnais",
    sourceCardInstanceId: "card-bang",
    targetPlayerId: PLAYER_ID,
    judgmentCardInstanceId: heart.events[0]?.payload.judgmentCardInstanceId,
    succeeded: true,
    missesGranted: 1,
  });
  assert.equal(spade.events[0]?.type, "BARREL_CHECK_RESOLVED");
  assert.equal(spade.events[0]?.payload.succeeded, false);
  assert.equal(spade.events[0]?.payload.missesGranted, 0);
  assert.deepEqual(state, before, "judgment returns events without mutating the snapshot");
});

test("ignores a judgment for another defender, dead character, or unregistered candidate", () => {
  const state = makeState();
  const valid = judgmentHook(state, "HEARTS");
  const wrongTarget = {
    ...valid,
    judgment: { ...valid.judgment, playerId: "player-3" },
  } satisfies JourdonnaisJudgmentHookInput;
  assert.deepEqual(jourdonnaisAbility(makeInput(state, wrongTarget)), { kind: "applied", events: [], steps: [] });

  const target = state.seats.find((seat) => seat.public.playerId === PLAYER_ID)!;
  target.public.hp = 0;
  assert.deepEqual(jourdonnaisAbility(makeInput(state, valid)), { kind: "applied", events: [], steps: [] });
  target.public.hp = 4;

  const unknownCandidate = {
    ...valid,
    judgment: {
      ...valid.judgment,
      candidate: { ...valid.judgment.candidate, cardInstanceId: "unknown-card" },
    },
  } satisfies JourdonnaisJudgmentHookInput;
  assert.deepEqual(jourdonnaisAbility(makeInput(state, unknownCandidate)), { kind: "applied", events: [], steps: [] });
});
