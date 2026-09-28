import type { CardEffectResult, CompletedEffectInteraction, DeepReadonly } from "./api.js";
import type { RandomSource } from "../random/shuffle.js";
import type { CardInstance, GameState } from "../state/types.js";

/** Base-game character IDs accepted by the ruleset. */
export type CharacterAbilityId =
  | "bart_cassidy"
  | "black_jack"
  | "calamity_janet"
  | "el_gringo"
  | "jesse_jones"
  | "jourdonnais"
  | "kit_carlson"
  | "lucky_duke"
  | "paul_regret"
  | "pedro_ramirez"
  | "rose_doolan"
  | "sid_ketchum"
  | "slab_the_killer"
  | "suzy_lafayette"
  | "vulture_sam"
  | "willy_the_kid";

/** The physical base-deck card types. Character conversions are separate effect types. */
export type BaseCardTypeId =
  | "bang"
  | "missed"
  | "beer"
  | "saloon"
  | "stagecoach"
  | "wells_fargo"
  | "general_store"
  | "panic"
  | "cat_balou"
  | "gatling"
  | "indians"
  | "duel"
  | "barrel"
  | "jail"
  | "dynamite"
  | "mustang"
  | "scope"
  | "volcanic"
  | "schofield"
  | "remington"
  | "carabine"
  | "winchester";

export type CharacterEffectResult = Extract<
  CardEffectResult,
  { readonly kind: "applied" | "choice_required" | "response_required" }
>;

export interface CharacterCardReference {
  readonly cardInstanceId: string | null;
  readonly physicalCardTypeId: BaseCardTypeId | null;
  readonly effectCardTypeId: BaseCardTypeId | null;
}

export type DamageCause = "BANG" | "GATLING" | "INDIANS" | "DUEL" | "DYNAMITE";

/** Fired once after R27 has finished, including the result of any rescue. */
export interface DamageResolvedHookInput {
  readonly kind: "damage_resolved";
  readonly victimPlayerId: string;
  readonly damageAmount: number;
  /** HP actually removed before rescue; this can differ from damageAmount at zero HP. */
  readonly hpLost: number;
  readonly source: {
    readonly playerId: string | null;
    readonly card: CharacterCardReference;
    readonly cause: DamageCause;
  };
  /** False means the victim accepted elimination or could not complete R27 rescue. */
  readonly survivedAfterRescue: boolean;
}

export type DrawSource =
  | { readonly kind: "draw_pile" }
  /** A hidden hand is identified by its owner only; no hidden card ID is carried. */
  | { readonly kind: "opponent_hand"; readonly playerId: string }
  /** Only the already-visible top card may be identified here. */
  | { readonly kind: "discard_top"; readonly cardInstanceId: string }
  /** Private cards shown to the drawing player for an ability choice, such as Kit Carlson. */
  | { readonly kind: "revealed_pool"; readonly cardInstanceIds: readonly string[] };

export type DrawDistribution =
  | { readonly kind: "initial_deal"; readonly cardIndex: number }
  | { readonly kind: "normal_turn"; readonly position: "first" | "second" }
  | {
      readonly kind: "bonus";
      readonly bonusIndex: number;
      readonly reason: "character_ability" | "card_effect" | "outlaw_reward";
    };

/** A source offered before a draw; hidden hand contents are never listed. */
export type DrawSourceOption =
  | { readonly kind: "draw_pile"; readonly visibility: "recipient_only" }
  | {
      readonly kind: "opponent_hand";
      readonly playerId: string;
      readonly handCardCount: number;
      readonly visibility: "recipient_only";
    }
  | { readonly kind: "discard_top"; readonly cardInstanceId: string; readonly visibility: "public" };

export type DrawSlotHookInput =
  | {
      readonly kind: "draw_slot";
      readonly timing: "before";
      readonly distribution: DrawDistribution;
      readonly sourceOptions: readonly DrawSourceOption[];
      readonly card?: never;
    }
  | ({
      readonly kind: "draw_slot";
      readonly timing: "after";
      readonly distribution: DrawDistribution;
      readonly card: DeepReadonly<CardInstance>;
    } & (
      | { readonly source: { readonly kind: "draw_pile" }; readonly visibility: "recipient_only" | "public" }
      | { readonly source: { readonly kind: "opponent_hand"; readonly playerId: string }; readonly visibility: "recipient_only" }
      | { readonly source: { readonly kind: "discard_top"; readonly cardInstanceId: string }; readonly visibility: "public" }
      | { readonly source: { readonly kind: "revealed_pool"; readonly cardInstanceIds: readonly string[] }; readonly visibility: "recipient_only" }
    ));

/** C02 is invoked only for the public second slot of an ordinary turn draw. */
export interface BlackJackDrawSlotHookInput {
  readonly kind: "draw_slot";
  readonly timing: "after";
  readonly distribution: { readonly kind: "normal_turn"; readonly position: "second" };
  readonly source: { readonly kind: "draw_pile" };
  readonly visibility: "public";
  readonly card: DeepReadonly<CardInstance>;
}

/** Jesse may take the first ordinary turn card from the deck or another hand. */
export interface JesseFirstTurnDrawSlotHookInput {
  readonly kind: "draw_slot";
  readonly timing: "before";
  readonly distribution: { readonly kind: "normal_turn"; readonly position: "first" };
  readonly sourceOptions: {
    readonly drawPile: { readonly kind: "draw_pile"; readonly visibility: "recipient_only" };
    readonly eligibleOpponentHands: readonly {
      readonly kind: "opponent_hand";
      readonly playerId: string;
      readonly handCardCount: number;
      readonly visibility: "recipient_only";
    }[];
  };
  readonly card?: never;
}

/** Pedro may replace only the first ordinary turn slot with the public discard top. */
export interface PedroFirstTurnDrawSlotHookInput {
  readonly kind: "draw_slot";
  readonly timing: "before";
  readonly distribution: { readonly kind: "normal_turn"; readonly position: "first" };
  readonly sourceOptions: {
    readonly drawPile: { readonly kind: "draw_pile"; readonly visibility: "recipient_only" };
    readonly discardTop: { readonly kind: "discard_top"; readonly cardInstanceId: string; readonly visibility: "public" } | null;
  };
  readonly card?: never;
}

/** Kit replaces the two normal turn slots with a private three-card selection. */
export interface DrawPhaseHookInput {
  readonly kind: "draw_phase";
  readonly timing: "before";
  readonly distribution: "normal_turn";
  readonly requestedCardCount: 2;
  readonly candidates: readonly [DeepReadonly<CardInstance>, DeepReadonly<CardInstance>, DeepReadonly<CardInstance>];
  readonly source: { readonly kind: "draw_pile" };
  readonly visibility: "recipient_only";
}

export interface PlayCardContext {
  readonly kind: "play_card";
  readonly phase: "play";
}

export interface BangResponseContext {
  readonly kind: "bang_response";
  readonly interactionId: string;
  readonly attackerPlayerId: string;
  readonly attackCard: CharacterCardReference;
}

export interface GatlingResponseContext {
  readonly kind: "gatling_response";
  readonly interactionId: string;
  readonly attackerPlayerId: string;
  readonly attackCard: CharacterCardReference;
}

export interface IndiansResponseContext {
  readonly kind: "indians_response";
  readonly interactionId: string;
  readonly sourcePlayerId: string;
  readonly sourceCard: CharacterCardReference;
}

export interface DuelResponseContext {
  readonly kind: "duel_response";
  readonly interactionId: string;
  readonly duelInitiatorPlayerId: string;
  readonly sourceCard: CharacterCardReference;
}

type BangToMissedSubstitution = {
  readonly kind: "card_substitution_query";
  readonly card: {
    readonly cardInstanceId: string;
    readonly physicalCardTypeId: "bang";
    readonly effectCardTypeId: "missed";
  };
  readonly context: BangResponseContext | GatlingResponseContext;
};

type MissedToBangSubstitution = {
  readonly kind: "card_substitution_query";
  readonly card: {
    readonly cardInstanceId: string;
    readonly physicalCardTypeId: "missed";
    readonly effectCardTypeId: "bang";
  };
  readonly context: PlayCardContext | IndiansResponseContext | DuelResponseContext;
};

/** C03's legal physical/effect type pairs and their precise use/response windows. */
export type CardSubstitutionHookInput = BangToMissedSubstitution | MissedToBangSubstitution;

export interface AttackResponseQueryHookInput {
  readonly kind: "attack_response_query";
  readonly perspective: "attacker" | "defender";
  readonly attack: {
    readonly kind: "bang" | "gatling";
    readonly attackerPlayerId: string;
    readonly defenderPlayerId: string;
    readonly card: CharacterCardReference;
  };
  readonly missedCardsAlreadySubmitted: number;
  readonly judgmentSourcesAlreadyAttempted: readonly ("barrel" | "jourdonnais")[];
}

type JourdonnaisAttackResponseQueryHookInput = AttackResponseQueryHookInput & {
  readonly perspective: "defender";
};

type SlabAttackResponseQueryHookInput = Omit<AttackResponseQueryHookInput, "attack" | "perspective"> & {
  readonly perspective: "attacker";
  readonly attack: Omit<AttackResponseQueryHookInput["attack"], "kind" | "card"> & {
    readonly kind: "bang";
    readonly card: {
      readonly cardInstanceId: string;
      readonly physicalCardTypeId: "bang";
      readonly effectCardTypeId: "bang";
    };
  };
};

export type DrawJudgmentSource =
  | { readonly kind: "barrel"; readonly cardInstanceId: string }
  | { readonly kind: "dynamite"; readonly cardInstanceId: string }
  | { readonly kind: "jail"; readonly cardInstanceId: string }
  | { readonly kind: "jourdonnais_virtual_barrel"; readonly attackCard: CharacterCardReference };

export type JudgmentHookInput =
  | {
      readonly kind: "judgment";
      readonly judgment: {
        readonly kind: "lucky_draw";
        readonly playerId: string;
        readonly source: DrawJudgmentSource;
        readonly candidates: readonly [DeepReadonly<CardInstance>, DeepReadonly<CardInstance>];
        readonly selection: { readonly kind: "awaiting_choice" } | {
          readonly kind: "selected";
          readonly cardInstanceId: string;
        };
      };
    }
  | {
      readonly kind: "judgment";
      readonly judgment: {
        readonly kind: "jourdonnais";
        readonly playerId: string;
        readonly attack: AttackResponseQueryHookInput["attack"];
        readonly candidate: DeepReadonly<CardInstance>;
      };
    };

export type LuckyDrawJudgmentHookInput = Extract<
  JudgmentHookInput,
  { readonly judgment: { readonly kind: "lucky_draw" } }
>;

export type JourdonnaisJudgmentHookInput = Extract<
  JudgmentHookInput,
  { readonly judgment: { readonly kind: "jourdonnais" } }
>;

export interface DirectionalDistanceQueryHookInput {
  readonly kind: "distance_query";
  /** T11 owns base distance; the character hook contributes a directional adjustment. */
  readonly fromPlayerId: string;
  readonly toPlayerId: string;
  readonly baseDistance: number;
}

export interface SidAbilityUseHookInput {
  readonly kind: "sid_ability_use";
  readonly abilityId: "sid-ketchum";
  readonly window:
    | { readonly kind: "play_phase" }
    | { readonly kind: "death_rescue"; readonly interactionId: string; readonly victimPlayerId: string };
  readonly costCardInstanceIds: readonly [string, string];
}

export type ResponseContext =
  | {
      readonly interactionKind: "BANG_RESPONSE" | "GATLING_RESPONSE";
      readonly choice: "USE_MISSED";
      readonly card: CharacterCardReference;
    }
  | {
      readonly interactionKind: "BANG_RESPONSE" | "GATLING_RESPONSE";
      readonly choice: "USE_BARREL" | "USE_JOURDONNAIS" | "TAKE_HIT";
    }
  | {
      readonly interactionKind: "INDIANS_RESPONSE";
      readonly choice: "USE_BANG";
      readonly card: CharacterCardReference;
    }
  | {
      readonly interactionKind: "INDIANS_RESPONSE";
      readonly choice: "TAKE_HIT";
    }
  | {
      readonly interactionKind: "DUEL_RESPONSE";
      readonly choice: "PLAY_BANG";
      readonly card: CharacterCardReference;
    }
  | {
      readonly interactionKind: "DUEL_RESPONSE";
      readonly choice: "YIELD";
    };

export interface AfterResponseHookInput {
  readonly kind: "after_response";
  readonly interactionId: string;
  readonly responderPlayerId: string;
  readonly response: ResponseContext;
  readonly responseSeries: "continuing" | "effect_complete";
  readonly handCardCountAfterResponse: number;
}

/** Suzy triggers after a card response, not after Barrel, taking a hit, or Duel. */
type SuzyCardResponseContext =
  | Extract<ResponseContext, { readonly interactionKind: "BANG_RESPONSE" | "GATLING_RESPONSE"; readonly choice: "USE_MISSED" }>
  | Extract<ResponseContext, { readonly interactionKind: "INDIANS_RESPONSE"; readonly choice: "USE_BANG" }>;

export type SuzyAfterResponseHookInput = Omit<AfterResponseHookInput, "response"> & {
  readonly response: SuzyCardResponseContext;
};

export interface AfterCardEffectHookInput {
  readonly kind: "after_card_effect";
  readonly card: CharacterCardReference;
  /**
   * `card_result_committed` is the direct card-use boundary; `resolution_complete`
   * follows all continuations. Runtime chooses the boundary required by the rule.
   */
  readonly boundary: "card_result_committed" | "resolution_complete";
  readonly handCardCountAfterEffect: number;
  readonly pendingInteractionKind: string | null;
}

/** Suzy normally checks hand size only when the full effect and continuations end. */
export type SuzyAfterCardEffectHookInput =
  | Omit<AfterCardEffectHookInput, "boundary" | "pendingInteractionKind"> & {
      readonly boundary: "resolution_complete";
      readonly pendingInteractionKind: null;
    }
  /**
   * C14/S5 p13 ordering point: after a surviving El Gringo has actually lost HP,
   * before El Gringo takes a card from Suzy. The runtime may emit this only for
   * damage caused by Suzy's just-played card; it is not a general pre-damage hook.
   */
  | Omit<AfterCardEffectHookInput, "boundary" | "pendingInteractionKind"> & {
      readonly boundary: "before_el_gringo_reward";
      readonly pendingInteractionKind: null;
      readonly trigger: {
        readonly kind: "EL_GRINGO_DAMAGE";
        readonly victimPlayerId: string;
      };
    };

export interface EliminationCleanupHookInput {
  readonly kind: "elimination_cleanup";
  readonly eliminatedPlayerId: string;
  readonly sourcePlayerId: string | null;
  readonly cause: DamageCause;
  /** R28 calls this after cards already discarded by the damage effect are removed. */
  readonly salvageableCards: {
    readonly handCardInstanceIds: readonly string[];
    readonly inPlayCardInstanceIds: readonly string[];
  };
}

export interface BangQuotaQueryHookInput {
  readonly kind: "bang_quota_query";
  readonly turnPlayerId: string;
  readonly card: {
    readonly cardInstanceId: string;
    readonly physicalCardTypeId: "bang" | "missed";
    readonly effectCardTypeId: "bang";
  };
  readonly bangCardPlaysThisTurn: number;
  readonly volcanicEquipped: boolean;
}

/** Per-character hook allowlist, derived from C01-C16. */
export interface CharacterAbilityHookById {
  readonly bart_cassidy: DamageResolvedHookInput;
  readonly black_jack: BlackJackDrawSlotHookInput;
  readonly calamity_janet: CardSubstitutionHookInput;
  readonly el_gringo: DamageResolvedHookInput;
  readonly jesse_jones: JesseFirstTurnDrawSlotHookInput;
  readonly jourdonnais: JourdonnaisAttackResponseQueryHookInput | JourdonnaisJudgmentHookInput;
  readonly kit_carlson: DrawPhaseHookInput;
  readonly lucky_duke: LuckyDrawJudgmentHookInput;
  readonly paul_regret: DirectionalDistanceQueryHookInput;
  readonly pedro_ramirez: PedroFirstTurnDrawSlotHookInput;
  readonly rose_doolan: DirectionalDistanceQueryHookInput;
  readonly sid_ketchum: SidAbilityUseHookInput;
  readonly slab_the_killer: SlabAttackResponseQueryHookInput;
  readonly suzy_lafayette: SuzyAfterCardEffectHookInput | SuzyAfterResponseHookInput;
  readonly vulture_sam: EliminationCleanupHookInput;
  readonly willy_the_kid: BangQuotaQueryHookInput;
}

export type CharacterAbilityHook<C extends CharacterAbilityId> = CharacterAbilityHookById[C];

export interface CardSubstitutionQueryResult {
  readonly kind: "card_substitution_query";
  readonly allowed: boolean;
  readonly physicalCardTypeId: "bang" | "missed";
  readonly effectCardTypeId: "bang" | "missed";
  readonly bangQuota: "counts" | "does_not_count";
}

export interface AttackResponseQueryResult {
  readonly kind: "attack_response_query";
  /** Additive to the ordinary one Missed requirement; Slab contributes at most one. */
  readonly additionalMissedCardsRequired: 0 | 1;
  readonly availableJudgmentSources: readonly "jourdonnais"[];
}

export interface DirectionalDistanceQueryResult {
  readonly kind: "distance_query";
  /** T11 applies this to the oriented from/to distance, with the R10 minimum of one. */
  readonly adjustment: -1 | 0 | 1;
}

export interface BangQuotaQueryResult {
  readonly kind: "bang_quota_query";
  readonly maximumPerTurn: 1 | "unlimited";
}

export type CharacterAbilityResultForHook<Hook> = Hook extends { readonly kind: "card_substitution_query" }
  ? CardSubstitutionQueryResult
  : Hook extends { readonly kind: "attack_response_query" }
    ? AttackResponseQueryResult
    : Hook extends { readonly kind: "distance_query" }
      ? DirectionalDistanceQueryResult
      : Hook extends { readonly kind: "bang_quota_query" }
        ? BangQuotaQueryResult
        : CharacterEffectResult;

export type CharacterAbilityResult<C extends CharacterAbilityId> =
  CharacterAbilityResultForHook<CharacterAbilityHook<C>>;

/**
 * Server-internal character module input. State is immutable, randomness is
 * caller-injected, and no protocol or UI DTO is part of this contract.
 */
export interface CharacterAbilityInput<C extends CharacterAbilityId> {
  readonly characterId: C;
  readonly playerId: string;
  readonly state: DeepReadonly<GameState>;
  readonly continuationFrameId: string;
  readonly random: RandomSource;
  readonly completedInteractions: readonly CompletedEffectInteraction[];
  readonly hook: CharacterAbilityHook<C>;
}

export type CharacterAbilityModule<C extends CharacterAbilityId> = (
  input: CharacterAbilityInput<C>,
) => CharacterAbilityResult<C>;
