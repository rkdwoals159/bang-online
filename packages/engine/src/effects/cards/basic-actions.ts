import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  EffectTarget,
} from "../api.js";
import type { EffectStep, JsonValue } from "../../state/types.js";
import { calamityJanetAbility } from "../characters/calamity-janet.js";
import type {
  BangResponseContext,
  CardSubstitutionQueryResult,
  CharacterAbilityInput,
  CharacterCardReference,
} from "../character-api.js";

type EffectSeat = CardEffectInput["state"]["seats"][number];
type DefenseSource = "barrel" | "jourdonnais";

interface BangDefenseProgress {
  readonly successfulMisses: number;
  readonly attemptedDefenseSources: readonly DefenseSource[];
  readonly requiredMisses: 1 | 2;
}

const PHYSICAL_CARD_TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map((card) => [card.definitionId, card.typeId]),
);

function cardType(state: CardEffectInput["state"], cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  return instance ? PHYSICAL_CARD_TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId) : undefined;
}

function uniqueSeat(state: CardEffectInput["state"], playerId: string): EffectSeat | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function invalidTarget(code: Extract<CardEffectResult, { kind: "invalid_target" }>['code']): CardEffectResult {
  return { kind: "invalid_target", code };
}

function sourceCardError(input: CardEffectInput, expectedType: string): CardEffectResult | undefined {
  return cardType(input.state, input.sourceCardInstanceId) === expectedType
    ? undefined
    : invalidTarget("TARGET_NOT_ALLOWED");
}

function characterInput(
  input: CardEffectInput,
  playerId: string,
  hook: CharacterAbilityInput<"calamity_janet">["hook"],
): CharacterAbilityInput<"calamity_janet"> {
  return {
    characterId: "calamity_janet",
    playerId,
    state: input.state,
    continuationFrameId: input.continuationFrameId,
    random: input.random,
    completedInteractions: input.completedInteractions,
    hook,
  };
}

function queryMissedAsBang(
  input: CardEffectInput,
  playerId: string,
  cardInstanceId: string,
): CardSubstitutionQueryResult {
  return calamityJanetAbility(characterInput(input, playerId, {
    kind: "card_substitution_query",
    card: { cardInstanceId, physicalCardTypeId: "missed", effectCardTypeId: "bang" },
    context: { kind: "play_card", phase: "play" },
  }));
}

function queryBangAsMissed(
  input: CardEffectInput,
  playerId: string,
  cardInstanceId: string,
  interactionId: string,
  attackCard: CharacterCardReference,
  attackerPlayerId: string,
): CardSubstitutionQueryResult {
  const context: BangResponseContext = {
    kind: "bang_response",
    interactionId,
    attackerPlayerId,
    attackCard,
  };
  return calamityJanetAbility(characterInput(input, playerId, {
    kind: "card_substitution_query",
    card: { cardInstanceId, physicalCardTypeId: "bang", effectCardTypeId: "missed" },
    context,
  }));
}

function bangAttackReference(input: CardEffectInput): CharacterCardReference | undefined {
  const cardInstanceId = input.sourceCardInstanceId;
  const physicalCardTypeId = cardType(input.state, cardInstanceId);
  if (!cardInstanceId || (physicalCardTypeId !== "bang" && physicalCardTypeId !== "missed")) return undefined;
  return { cardInstanceId, physicalCardTypeId, effectCardTypeId: "bang" };
}

function bangSourceError(input: CardEffectInput): CardEffectResult | undefined {
  const physicalCardTypeId = cardType(input.state, input.sourceCardInstanceId);
  if (physicalCardTypeId === "bang") return undefined;
  if (physicalCardTypeId !== "missed" || !input.sourceCardInstanceId) {
    return invalidTarget("TARGET_NOT_ALLOWED");
  }
  return queryMissedAsBang(input, input.actorPlayerId, input.sourceCardInstanceId).allowed
    ? undefined
    : invalidTarget("TARGET_NOT_ALLOWED");
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Record<string, JsonValue>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function step(
  input: CardEffectInput,
  kind: string,
  sourcePlayerId: string,
  targetPlayerId: string,
  payload: Record<string, JsonValue>,
): EffectStep {
  return {
    effectId: `${input.continuationFrameId}:${kind.toLowerCase()}:${input.sourceCardInstanceId ?? "ability"}`,
    kind,
    sourcePlayerId,
    targetPlayerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload,
  };
}

function playerTarget(input: CardEffectInput): EffectTarget | undefined {
  return input.targets.length === 1 && input.targets[0]?.kind === "player"
    ? input.targets[0]
    : undefined;
}

function findInteraction(
  input: CardEffectInput,
  kind: string,
): CompletedEffectInteraction | undefined {
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (
      interaction.kind === kind &&
      (interaction.context.continuationFrameId === undefined ||
        interaction.context.continuationFrameId === input.continuationFrameId)
    ) {
      return interaction;
    }
  }
  return undefined;
}

function isDefenseSource(value: unknown): value is DefenseSource {
  return value === "barrel" || value === "jourdonnais";
}

function readBangDefenseProgress(interaction: CompletedEffectInteraction): BangDefenseProgress | undefined {
  const raw = interaction.context.barrelProgress;
  let successfulMisses = 0;
  let attemptedDefenseSources: DefenseSource[] = [];
  if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
    const progress = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(progress.successfulMisses) || (progress.successfulMisses as number) < 0 ||
        !Array.isArray(progress.attemptedDefenseSources) ||
        progress.attemptedDefenseSources.some((source) => !isDefenseSource(source)) ||
        new Set(progress.attemptedDefenseSources).size !== progress.attemptedDefenseSources.length) return undefined;
    successfulMisses = progress.successfulMisses as number;
    attemptedDefenseSources = progress.attemptedDefenseSources as DefenseSource[];
  }
  const required = interaction.context.requiredMisses;
  if (required !== undefined && required !== 1 && required !== 2) return undefined;
  const requiredMisses = (required ?? 1) as 1 | 2;
  if (successfulMisses > requiredMisses) return undefined;
  return { successfulMisses, attemptedDefenseSources, requiredMisses };
}

function hasDefenseSource(target: EffectSeat, state: CardEffectInput["state"], source: DefenseSource): boolean {
  return source === "barrel"
    ? target.public.inPlayCardInstanceIds.some((id) => cardType(state, id) === "barrel")
    : target.public.characterId === "jourdonnais";
}

function bangResponseRequest(
  input: CardEffectInput,
  target: EffectSeat,
  progress: BangDefenseProgress = {
    successfulMisses: 0,
    attemptedDefenseSources: [],
    requiredMisses: 1,
  },
  events: readonly EffectEventDraft[] = [event("BANG_ATTACKED", input.actorPlayerId, {
    sourceCardInstanceId: input.sourceCardInstanceId,
    targetPlayerId: target.public.playerId,
  })],
  excludedMissedCardInstanceIds: readonly string[] = [],
): Extract<CardEffectResult, { kind: "response_required" }> {
  const excluded = new Set(excludedMissedCardInstanceIds);
  const missedOptions = target.private.handCardInstanceIds
    .filter((cardInstanceId) => !excluded.has(cardInstanceId) && cardType(input.state, cardInstanceId) === "missed")
    .map((cardInstanceId) => ({
      choice: "USE_MISSED",
      payload: { cardInstanceId },
    }));
  const bangOptions = target.public.characterId === "calamity_janet"
    ? target.private.handCardInstanceIds
      .filter((cardInstanceId) => !excluded.has(cardInstanceId) && cardType(input.state, cardInstanceId) === "bang")
      .map((cardInstanceId) => ({ choice: "USE_MISSED", payload: { cardInstanceId } }))
    : [];
  const targetStepId = `${input.continuationFrameId}:${input.sourceCardInstanceId ?? "bang"}:bang:${target.public.playerId}`;
  const defenseOptions = (['barrel', 'jourdonnais'] as const)
    .filter((source) => !progress.attemptedDefenseSources.includes(source) && hasDefenseSource(target, input.state, source))
    .map((source) => ({ choice: source === "barrel" ? "USE_BARREL" : "USE_JOURDONNAIS", payload: {} }));

  return {
    kind: "response_required",
    request: {
      kind: "BANG_RESPONSE",
      responders: [{
        playerId: target.public.playerId,
        options: [...missedOptions, ...bangOptions, ...defenseOptions, { choice: "TAKE_HIT", payload: {} }],
      }],
      context: {
        continuationFrameId: input.continuationFrameId,
        sourcePlayerId: input.actorPlayerId,
        targetPlayerId: target.public.playerId,
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetStepId,
        requiredMisses: progress.requiredMisses,
        barrelProgress: {
          successfulMisses: progress.successfulMisses,
          attemptedDefenseSources: [...progress.attemptedDefenseSources],
        },
      },
      resumeFrameId: input.continuationFrameId,
    },
    events: [...events],
    steps: [],
  };
}

function bangHit(input: CardEffectInput, targetPlayerId: string): CardEffectResult {
  return {
    kind: "applied",
    events: [event("BANG_HIT", input.actorPlayerId, {
      sourceCardInstanceId: input.sourceCardInstanceId,
      targetPlayerId,
      damage: 1,
    })],
    steps: [step(input, "DAMAGE_PLAYER", input.actorPlayerId, targetPlayerId, {
      amount: 1,
      cause: "BANG",
    })],
  };
}

/** Resolve a legal BANG target and connect its result to T12's response frame. */
export const bangEffect: CardEffectModule = (input) => {
  const sourceIssue = bangSourceError(input);
  if (sourceIssue) return sourceIssue;

  if (input.targets.length === 0) return { kind: "target_required" };
  const targetRef = playerTarget(input);
  if (!targetRef) return invalidTarget("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input.state, input.actorPlayerId);
  if (!actor) return invalidTarget("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return invalidTarget("TARGET_NOT_ALIVE");
  if (targetRef.playerId === input.actorPlayerId) return invalidTarget("TARGET_IS_SELF");

  const target = uniqueSeat(input.state, targetRef.playerId);
  if (!target) return invalidTarget("TARGET_NOT_FOUND");
  if (target.public.eliminated) return invalidTarget("TARGET_NOT_ALIVE");

  const response = findInteraction(input, "BANG_RESPONSE");
  if (!response) {
    return bangResponseRequest(input, target);
  }

  if (
    response.context.targetPlayerId !== target.public.playerId ||
    response.context.sourcePlayerId !== input.actorPlayerId ||
    response.context.sourceCardInstanceId !== input.sourceCardInstanceId
  ) return invalidTarget("TARGET_NOT_ALLOWED");

  const [answer] = response.responses;
  if (!answer || answer.playerId !== target.public.playerId) return invalidTarget("TARGET_NOT_ALLOWED");
  const progress = readBangDefenseProgress(response);
  if (!progress) return invalidTarget("TARGET_NOT_ALLOWED");
  if (answer.choice === "TAKE_HIT" && Object.keys(answer.payload).length === 0) {
    return bangHit(input, target.public.playerId);
  }
  if (answer.choice === "USE_MISSED") {
    const cardInstanceId = answer.payload.cardInstanceId;
    const physicalTypeId = typeof cardInstanceId === "string" ? cardType(input.state, cardInstanceId) : undefined;
    const responseCardIsOwnedOrConsumed = typeof cardInstanceId === "string" &&
      (target.private.handCardInstanceIds.includes(cardInstanceId) ||
        input.state.zones.discardPileCardInstanceIds.includes(cardInstanceId));
    const isOrdinaryMissed = physicalTypeId === "missed" && responseCardIsOwnedOrConsumed;
    const attackCard = bangAttackReference(input);
    const isCalamityBangAsMissed = physicalTypeId === "bang" &&
      responseCardIsOwnedOrConsumed &&
      target.public.characterId === "calamity_janet" &&
      attackCard !== undefined &&
      queryBangAsMissed(
        input,
        target.public.playerId,
        cardInstanceId as string,
        response.interactionId,
        attackCard,
        input.actorPlayerId,
      ).allowed;
    if (!isOrdinaryMissed && !isCalamityBangAsMissed) {
      return invalidTarget("TARGET_NOT_ALLOWED");
    }
    const nextProgress: BangDefenseProgress = {
      ...progress,
      successfulMisses: progress.successfulMisses + 1,
    };
    if (nextProgress.successfulMisses < nextProgress.requiredMisses) {
      return bangResponseRequest(
        input,
        target,
        nextProgress,
        [event("CARD_DISCARDED", target.public.playerId, {
          sourceCardInstanceId: input.sourceCardInstanceId,
          cardInstanceId,
          ownerPlayerId: target.public.playerId,
          fromZone: "hand",
          toZone: "discard",
          cause: "BANG_RESPONSE",
        })],
        [cardInstanceId as string],
      );
    }
    return {
      kind: "applied",
      events: [event("BANG_MISSED", target.public.playerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerId: target.public.playerId,
        missedCardInstanceId: cardInstanceId,
      })],
      steps: [],
    };
  }

  if (answer.choice === "USE_BARREL" || answer.choice === "USE_JOURDONNAIS") {
    const defenseSource: DefenseSource = answer.choice === "USE_BARREL" ? "barrel" : "jourdonnais";
    if (Object.keys(answer.payload).length !== 0 ||
        progress.attemptedDefenseSources.includes(defenseSource) ||
        !hasDefenseSource(target, input.state, defenseSource) ||
        !input.sourceCardInstanceId) return invalidTarget("TARGET_NOT_ALLOWED");
    const targetStepId = typeof response.context.targetStepId === "string"
      ? response.context.targetStepId
      : `${input.continuationFrameId}:${input.sourceCardInstanceId}:bang:${target.public.playerId}`;
    return {
      kind: "applied",
      events: [event("BARREL_CHECK_REQUESTED", target.public.playerId, {
        attackKind: "BANG",
        defenseSource,
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerId: target.public.playerId,
      })],
      steps: [step(input, "BARREL_CHECK", input.actorPlayerId, target.public.playerId, {
        attackKind: "BANG",
        defenseSource,
        targetStepId,
      })],
    };
  }

  return invalidTarget("TARGET_NOT_ALLOWED");
};

/** Validate and report the Missed! card consumed by a completed BANG response. */
export const missedEffect: CardEffectModule = (input) => {
  const sourceIssue = sourceCardError(input, "missed");
  if (sourceIssue) return sourceIssue;
  if (input.targets.length > 0) return invalidTarget("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input.state, input.actorPlayerId);
  if (!actor) return invalidTarget("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return invalidTarget("TARGET_NOT_ALIVE");
  const sourceCardInstanceId = input.sourceCardInstanceId;
  if (!sourceCardInstanceId) return invalidTarget("TARGET_NOT_ALLOWED");

  const response = findInteraction(input, "BANG_RESPONSE");
  const answer = response?.responses.find((item) => item.playerId === input.actorPlayerId);
  if (
    !answer || answer.choice !== "USE_MISSED" ||
    answer.payload.cardInstanceId !== sourceCardInstanceId ||
    response?.context.targetPlayerId !== input.actorPlayerId
  ) {
    return invalidTarget("TARGET_NOT_ALLOWED");
  }

  return {
    kind: "applied",
    events: [event("MISSED_USED", input.actorPlayerId, {
      cardInstanceId: sourceCardInstanceId,
      interactionId: response.interactionId,
    })],
    steps: [],
  };
};

function livingPlayerCount(state: CardEffectInput["state"]): number {
  return state.seats.filter((seat) => !seat.public.eliminated).length;
}

function beerResult(
  input: CardEffectInput,
  actor: EffectSeat,
  mode: "normal" | "death_rescue",
): CardEffectResult {
  const canHeal = livingPlayerCount(input.state) > 2;
  if (mode === "death_rescue" && (actor.public.hp > 0 || actor.public.eliminated)) {
    return invalidTarget("TARGET_NOT_ALLOWED");
  }
  const healed = canHeal ? Math.min(1, Math.max(0, actor.public.maxHp - actor.public.hp)) : 0;

  return {
    kind: "applied",
    events: [event("BEER_USED", input.actorPlayerId, {
      cardInstanceId: input.sourceCardInstanceId,
      mode,
      healed,
    })],
    steps: healed === 0
      ? []
      : [step(input, "HEAL_PLAYER", input.actorPlayerId, actor.public.playerId, {
          amount: healed,
          cause: "BEER",
          rescue: mode === "death_rescue",
        })],
  };
}

/** Beer heals only its user, caps at max HP, and is ineffective with two alive. */
export const beerEffect: CardEffectModule = (input) => {
  const sourceIssue = sourceCardError(input, "beer");
  if (sourceIssue) return sourceIssue;
  if (input.targets.length > 0) return invalidTarget("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input.state, input.actorPlayerId);
  if (!actor) return invalidTarget("TARGET_NOT_FOUND");

  if (input.state.resolution.pendingDeath !== null) {
    const pendingDeath = input.state.resolution.pendingDeath;
    const response = findInteraction(input, "DEATH_RESCUE");
    const answer = response?.responses.find((item) => item.playerId === input.actorPlayerId);
    if (
      pendingDeath.victimPlayerId !== input.actorPlayerId ||
      pendingDeath.consequenceStage !== "rescue" ||
      answer?.choice !== "USE_BEER" ||
      answer.payload.cardInstanceId !== input.sourceCardInstanceId
    ) {
      return invalidTarget("TARGET_NOT_ALLOWED");
    }
    return beerResult(input, actor, "death_rescue");
  }

  if (input.completedInteractions.some((interaction) => interaction.kind === "DEATH_RESCUE")) {
    return invalidTarget("TARGET_NOT_ALLOWED");
  }
  if (actor.public.eliminated) return invalidTarget("TARGET_NOT_ALIVE");
  return beerResult(input, actor, "normal");
};
