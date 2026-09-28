// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import type { DeepReadonly } from "../../src/effects/api.ts";
import type {
  AttackResponseQueryHookInput,
  CardSubstitutionHookInput,
  CharacterAbilityId,
  CharacterAbilityInput,
  CharacterAbilityResult,
  DamageResolvedHookInput,
  DrawSlotHookInput,
  JudgmentHookInput,
  SidAbilityUseHookInput,
  SuzyAfterCardEffectHookInput,
  SuzyAfterResponseHookInput,
} from "../../src/effects/character-api.ts";
import type { CardInstance, GameState } from "../../src/state/types.ts";

const state = {} as DeepReadonly<GameState>;
const common = {
  state,
  continuationFrameId: "frame-character-api",
  random: { nextFloat: () => 0.25 },
  completedInteractions: [] as const,
};

function card(cardInstanceId: string, suit: CardInstance["suit"] = "HEARTS"): DeepReadonly<CardInstance> {
  return { cardInstanceId, cardDefinitionId: `definition-${cardInstanceId}`, rank: 7, suit };
}

const validInputs = {
  bart_cassidy: {
    ...common,
    characterId: "bart_cassidy",
    playerId: "p-bart",
    hook: {
      kind: "damage_resolved",
      victimPlayerId: "p-bart",
      damageAmount: 3,
      hpLost: 3,
      source: {
        playerId: null,
        card: { cardInstanceId: "ci-dynamite", physicalCardTypeId: "dynamite", effectCardTypeId: "dynamite" },
        cause: "DYNAMITE",
      },
      survivedAfterRescue: true,
    },
  },
  black_jack: {
    ...common,
    characterId: "black_jack",
    playerId: "p-black-jack",
    hook: {
      kind: "draw_slot",
      timing: "after",
      distribution: { kind: "normal_turn", position: "second" },
      source: { kind: "draw_pile" },
      visibility: "public",
      card: card("ci-second", "DIAMONDS"),
    },
  },
  calamity_janet: {
    ...common,
    characterId: "calamity_janet",
    playerId: "p-calamity",
    hook: {
      kind: "card_substitution_query",
      card: { cardInstanceId: "ci-missed", physicalCardTypeId: "missed", effectCardTypeId: "bang" },
      context: {
        kind: "indians_response",
        interactionId: "interaction-indians",
        sourcePlayerId: "p-other",
        sourceCard: { cardInstanceId: "ci-indians", physicalCardTypeId: "indians", effectCardTypeId: "indians" },
      },
    },
  },
  el_gringo: {
    ...common,
    characterId: "el_gringo",
    playerId: "p-gringo",
    hook: {
      kind: "damage_resolved",
      victimPlayerId: "p-gringo",
      damageAmount: 1,
      hpLost: 1,
      source: {
        playerId: "p-other",
        card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
        cause: "BANG",
      },
      survivedAfterRescue: true,
    },
  },
  jesse_jones: {
    ...common,
    characterId: "jesse_jones",
    playerId: "p-jesse",
    hook: {
      kind: "draw_slot",
      timing: "before",
      distribution: { kind: "normal_turn", position: "first" },
      sourceOptions: {
        drawPile: { kind: "draw_pile", visibility: "recipient_only" },
        eligibleOpponentHands: [{ kind: "opponent_hand", playerId: "p-other", handCardCount: 2, visibility: "recipient_only" }],
      },
    },
  },
  jourdonnais: {
    ...common,
    characterId: "jourdonnais",
    playerId: "p-jourdonnais",
    hook: {
      kind: "attack_response_query",
      perspective: "defender",
      attack: {
        kind: "bang",
        attackerPlayerId: "p-attacker",
        defenderPlayerId: "p-jourdonnais",
        card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      },
      missedCardsAlreadySubmitted: 0,
      judgmentSourcesAlreadyAttempted: [],
    },
  },
  kit_carlson: {
    ...common,
    characterId: "kit_carlson",
    playerId: "p-kit",
    hook: {
      kind: "draw_phase",
      timing: "before",
      distribution: "normal_turn",
      requestedCardCount: 2,
      candidates: [card("ci-kit-a"), card("ci-kit-b"), card("ci-kit-c")],
      source: { kind: "draw_pile" },
      visibility: "recipient_only",
    },
  },
  lucky_duke: {
    ...common,
    characterId: "lucky_duke",
    playerId: "p-lucky",
    hook: {
      kind: "judgment",
      judgment: {
        kind: "lucky_draw",
        playerId: "p-lucky",
        source: { kind: "jail", cardInstanceId: "ci-jail" },
        candidates: [card("ci-lucky-a"), card("ci-lucky-b", "SPADES")],
        selection: { kind: "awaiting_choice" },
      },
    },
  },
  paul_regret: {
    ...common,
    characterId: "paul_regret",
    playerId: "p-paul",
    hook: { kind: "distance_query", fromPlayerId: "p-other", toPlayerId: "p-paul", baseDistance: 2 },
  },
  pedro_ramirez: {
    ...common,
    characterId: "pedro_ramirez",
    playerId: "p-pedro",
    hook: {
      kind: "draw_slot",
      timing: "before",
      distribution: { kind: "normal_turn", position: "first" },
      sourceOptions: {
        drawPile: { kind: "draw_pile", visibility: "recipient_only" },
        discardTop: { kind: "discard_top", cardInstanceId: "ci-discard-top", visibility: "public" },
      },
    },
  },
  rose_doolan: {
    ...common,
    characterId: "rose_doolan",
    playerId: "p-rose",
    hook: { kind: "distance_query", fromPlayerId: "p-rose", toPlayerId: "p-other", baseDistance: 2 },
  },
  sid_ketchum: {
    ...common,
    characterId: "sid_ketchum",
    playerId: "p-sid",
    hook: {
      kind: "sid_ability_use",
      abilityId: "sid-ketchum",
      window: { kind: "play_phase" },
      costCardInstanceIds: ["ci-cost-1", "ci-cost-2"],
    },
  },
  slab_the_killer: {
    ...common,
    characterId: "slab_the_killer",
    playerId: "p-slab",
    hook: {
      kind: "attack_response_query",
      perspective: "attacker",
      attack: {
        kind: "bang",
        attackerPlayerId: "p-slab",
        defenderPlayerId: "p-defender",
        card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      },
      missedCardsAlreadySubmitted: 0,
      judgmentSourcesAlreadyAttempted: [],
    },
  },
  suzy_lafayette: {
    ...common,
    characterId: "suzy_lafayette",
    playerId: "p-suzy",
    hook: {
      kind: "after_card_effect",
      card: { cardInstanceId: "ci-stagecoach", physicalCardTypeId: "stagecoach", effectCardTypeId: "stagecoach" },
      boundary: "resolution_complete",
      handCardCountAfterEffect: 2,
      pendingInteractionKind: null,
    },
  },
  vulture_sam: {
    ...common,
    characterId: "vulture_sam",
    playerId: "p-vulture",
    hook: {
      kind: "elimination_cleanup",
      eliminatedPlayerId: "p-outlaw",
      sourcePlayerId: "p-vulture",
      cause: "BANG",
      salvageableCards: {
        handCardInstanceIds: ["ci-hand"],
        inPlayCardInstanceIds: ["ci-barrel"],
      },
    },
  },
  willy_the_kid: {
    ...common,
    characterId: "willy_the_kid",
    playerId: "p-willy",
    hook: {
      kind: "bang_quota_query",
      turnPlayerId: "p-willy",
      card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      bangCardPlaysThisTurn: 1,
      volcanicEquipped: false,
    },
  },
} satisfies { [C in CharacterAbilityId]: CharacterAbilityInput<C> };

const additionalValidInputs = [
  {
    ...common,
    characterId: "jourdonnais",
    playerId: "p-jourdonnais",
    hook: {
      kind: "judgment",
      judgment: {
        kind: "jourdonnais",
        playerId: "p-jourdonnais",
        attack: {
          kind: "bang",
          attackerPlayerId: "p-attacker",
          defenderPlayerId: "p-jourdonnais",
          card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
        },
        candidate: card("ci-barrel-judgment"),
      },
    },
  },
  {
    ...common,
    characterId: "suzy_lafayette",
    playerId: "p-suzy",
    hook: {
      kind: "after_response",
      interactionId: "interaction-bang",
      responderPlayerId: "p-suzy",
      response: {
        interactionKind: "BANG_RESPONSE",
        choice: "USE_MISSED",
        card: { cardInstanceId: "ci-missed", physicalCardTypeId: "missed", effectCardTypeId: "missed" },
      },
      responseSeries: "continuing",
      handCardCountAfterResponse: 0,
    },
  },
  {
    ...common,
    characterId: "suzy_lafayette",
    playerId: "p-suzy",
    hook: {
      kind: "after_card_effect",
      card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      boundary: "before_el_gringo_reward",
      trigger: { kind: "EL_GRINGO_DAMAGE", victimPlayerId: "p-el-gringo" },
      handCardCountAfterEffect: 0,
      pendingInteractionKind: null,
    },
  },
] satisfies readonly [
  CharacterAbilityInput<"jourdonnais">,
  CharacterAbilityInput<"suzy_lafayette">,
  CharacterAbilityInput<"suzy_lafayette">,
];

// Compile-time rejection cases: character/hook, damage context, card conversion,
// draw timing, Sid cost, and query-result discriminants must remain distinct.
const wrongBartHook: DrawSlotHookInput = {
  kind: "draw_slot",
  timing: "before",
  distribution: { kind: "normal_turn", position: "first" },
  sourceOptions: [{ kind: "draw_pile", visibility: "recipient_only" }],
};
// @ts-expect-error Bart only accepts the C01 damage-resolved hook.
const bartCannotDraw: CharacterAbilityInput<"bart_cassidy"> = { ...common, characterId: "bart_cassidy", playerId: "p-bart", hook: wrongBartHook };
void bartCannotDraw;

const firstNormalDrawSlot: DrawSlotHookInput = {
  kind: "draw_slot",
  timing: "before",
  distribution: { kind: "normal_turn", position: "first" },
  sourceOptions: [{ kind: "draw_pile", visibility: "recipient_only" }],
};
const blackJackCannotUseFirstSlot: CharacterAbilityInput<"black_jack"> = {
  ...common,
  characterId: "black_jack",
  playerId: "p-black-jack",
  // @ts-expect-error Black Jack only receives the exposed second normal turn slot.
  hook: firstNormalDrawSlot,
};
void blackJackCannotUseFirstSlot;

const jourdonnaisJudgment: JudgmentHookInput = {
  kind: "judgment",
  judgment: {
    kind: "jourdonnais",
    playerId: "p-jourdonnais",
    attack: {
      kind: "bang",
      attackerPlayerId: "p-attacker",
      defenderPlayerId: "p-jourdonnais",
      card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
    },
    candidate: card("ci-jourdonnais"),
  },
};
const luckyCannotUseJourdonnaisJudgment: CharacterAbilityInput<"lucky_duke"> = {
  ...common,
  characterId: "lucky_duke",
  playerId: "p-lucky",
  // @ts-expect-error Lucky Duke accepts Draw! judgments with two candidates, not Jourdonnais checks.
  hook: jourdonnaisJudgment,
};
void luckyCannotUseJourdonnaisJudgment;

// @ts-expect-error Damage-resolved input requires actual hpLost and post-rescue survival.
const incompleteDamage: DamageResolvedHookInput = {
  kind: "damage_resolved",
  victimPlayerId: "p-bart",
  damageAmount: 1,
  source: { playerId: "p-other", card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" }, cause: "BANG" },
  survivedAfterRescue: true,
};
void incompleteDamage;

// @ts-expect-error A physical BANG cannot become Missed during an Indians response.
const invalidCalamityPair: CardSubstitutionHookInput = {
  kind: "card_substitution_query",
  card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "missed" },
  context: { kind: "indians_response", interactionId: "i1", sourcePlayerId: "p-other", sourceCard: { cardInstanceId: "ci-indians", physicalCardTypeId: "indians", effectCardTypeId: "indians" } },
};
void invalidCalamityPair;

// @ts-expect-error An after-draw hook must carry the actual card instance.
const incompleteDraw: DrawSlotHookInput = {
  kind: "draw_slot",
  timing: "after",
  distribution: { kind: "normal_turn", position: "second" },
  source: { kind: "draw_pile" },
  visibility: "public",
};
void incompleteDraw;

const publicOpponentHandDraw: DrawSlotHookInput = {
  kind: "draw_slot",
  timing: "after",
  distribution: { kind: "normal_turn", position: "first" },
  // @ts-expect-error A hidden hand source cannot be made public by the draw hook.
  source: { kind: "opponent_hand", playerId: "p-other" },
  visibility: "public",
  card: card("ci-hidden-hand-card"),
};
void publicOpponentHandDraw;

const invalidSidUse: SidAbilityUseHookInput = {
  kind: "sid_ability_use",
  abilityId: "sid-ketchum",
  window: { kind: "death_rescue", interactionId: "rescue-1", victimPlayerId: "p-sid" },
  // @ts-expect-error The tuple must contain two card IDs.
  costCardInstanceIds: ["ci-only-one"],
};
void invalidSidUse;

const wrongDistanceResult: CharacterAbilityResult<"rose_doolan"> = {
  // @ts-expect-error A distance query cannot return a card-substitution result.
  kind: "card_substitution_query",
  allowed: true,
  physicalCardTypeId: "missed",
  effectCardTypeId: "bang",
  bangQuota: "counts",
};
void wrongDistanceResult;

const gatlingAttackQuery: AttackResponseQueryHookInput = {
  kind: "attack_response_query",
  perspective: "attacker",
  attack: {
    kind: "gatling",
    attackerPlayerId: "p-slab",
    defenderPlayerId: "p-defender",
    card: { cardInstanceId: "ci-gatling", physicalCardTypeId: "gatling", effectCardTypeId: "gatling" },
  },
  missedCardsAlreadySubmitted: 0,
  judgmentSourcesAlreadyAttempted: [],
};
const slabCannotBoostGatling: CharacterAbilityInput<"slab_the_killer"> = {
  ...common,
  characterId: "slab_the_killer",
  playerId: "p-slab",
  // @ts-expect-error Slab's query applies only to his physical BANG card attacks.
  hook: gatlingAttackQuery,
};
void slabCannotBoostGatling;

const suzyCannotTriggerOnTakingHit: SuzyAfterResponseHookInput = {
  kind: "after_response",
  interactionId: "interaction-bang",
  responderPlayerId: "p-suzy",
  // @ts-expect-error Taking a hit does not play a card and cannot trigger Suzy.
  response: { interactionKind: "BANG_RESPONSE", choice: "TAKE_HIT" },
  responseSeries: "effect_complete",
  handCardCountAfterResponse: 0,
};
void suzyCannotTriggerOnTakingHit;

// @ts-expect-error The special ordering boundary cannot be represented without its rule trigger.
const suzyOrderingCannotOmitItsRuleTrigger: SuzyAfterCardEffectHookInput = {
  kind: "after_card_effect",
  card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
  boundary: "before_el_gringo_reward",
  handCardCountAfterEffect: 0,
  pendingInteractionKind: null,
};
void suzyOrderingCannotOmitItsRuleTrigger;

const suzyOrderingCannotUseAnotherTrigger: SuzyAfterCardEffectHookInput = {
  kind: "after_card_effect",
  card: { cardInstanceId: "ci-bang", physicalCardTypeId: "bang", effectCardTypeId: "bang" },
  boundary: "before_el_gringo_reward",
  // @ts-expect-error The special ordering boundary is restricted to the C04 trigger.
  trigger: { kind: "OTHER_DAMAGE", victimPlayerId: "p-el-gringo" },
  handCardCountAfterEffect: 0,
  pendingInteractionKind: null,
};
void suzyOrderingCannotUseAnotherTrigger;

const queryResults = {
  calamity: {
    kind: "card_substitution_query",
    allowed: true,
    physicalCardTypeId: "missed",
    effectCardTypeId: "bang",
    bangQuota: "counts",
  },
  jourdonnais: {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 0,
    availableJudgmentSources: ["jourdonnais"],
  },
  paul: { kind: "distance_query", adjustment: 1 },
  rose: { kind: "distance_query", adjustment: -1 },
  slab: {
    kind: "attack_response_query",
    additionalMissedCardsRequired: 1,
    availableJudgmentSources: [],
  },
  willy: { kind: "bang_quota_query", maximumPerTurn: "unlimited" },
} satisfies {
  calamity: CharacterAbilityResult<"calamity_janet">;
  jourdonnais: CharacterAbilityResult<"jourdonnais">;
  paul: CharacterAbilityResult<"paul_regret">;
  rose: CharacterAbilityResult<"rose_doolan">;
  slab: CharacterAbilityResult<"slab_the_killer">;
  willy: CharacterAbilityResult<"willy_the_kid">;
};

const t12ChoiceResult: CharacterAbilityResult<"lucky_duke"> = {
  kind: "choice_required",
  request: {
    kind: "LUCKY_DRAW",
    responders: [{
      playerId: "p-lucky",
      options: [
        { choice: "SELECT_JUDGMENT", payload: { cardInstanceId: "ci-lucky-a" } },
        { choice: "SELECT_JUDGMENT", payload: { cardInstanceId: "ci-lucky-b" } },
      ],
    }],
    context: { playerId: "p-lucky" },
    resumeFrameId: "frame-character-api",
  },
  events: [],
  steps: [],
};

void additionalValidInputs;
void validInputs;
void queryResults;
void t12ChoiceResult;

test("the API fixture covers all sixteen character-specific hook allowlists", () => {
  assert.deepEqual(Object.keys(validInputs).sort(), [
    "bart_cassidy",
    "black_jack",
    "calamity_janet",
    "el_gringo",
    "jesse_jones",
    "jourdonnais",
    "kit_carlson",
    "lucky_duke",
    "paul_regret",
    "pedro_ramirez",
    "rose_doolan",
    "sid_ketchum",
    "slab_the_killer",
    "suzy_lafayette",
    "vulture_sam",
    "willy_the_kid",
  ]);
  assert.equal(validInputs.bart_cassidy.hook.kind, "damage_resolved");
  assert.equal(validInputs.black_jack.hook.kind, "draw_slot");
  assert.equal(additionalValidInputs[0].hook.kind, "judgment");
  assert.equal(additionalValidInputs[1].hook.kind, "after_response");
  assert.equal(additionalValidInputs[2].hook.kind, "after_card_effect");
  if (additionalValidInputs[2].hook.kind === "after_card_effect") {
    assert.equal(additionalValidInputs[2].hook.boundary, "before_el_gringo_reward");
    assert.equal(additionalValidInputs[2].hook.trigger.kind, "EL_GRINGO_DAMAGE");
  }
});

test("query outputs are deterministic values and effect outcomes reuse T12 requests", () => {
  assert.equal(queryResults.paul.adjustment, 1);
  assert.equal(queryResults.rose.adjustment, -1);
  assert.equal(queryResults.willy.maximumPerTurn, "unlimited");
  assert.equal(t12ChoiceResult.kind, "choice_required");
  if (t12ChoiceResult.kind !== "choice_required") return;
  assert.equal(t12ChoiceResult.request.kind, "LUCKY_DRAW");
  assert.equal(t12ChoiceResult.request.resumeFrameId, "frame-character-api");
});
