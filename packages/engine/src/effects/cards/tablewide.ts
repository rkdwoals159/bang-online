import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { buildClockwiseTargetSteps } from "../../resolution/index.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  EffectTarget,
} from "../api.js";
import type { EffectStep, GameState, JsonValue } from "../../state/types.js";
import { calamityJanetAbility } from "../characters/calamity-janet.js";
import type {
  CardSubstitutionQueryResult,
  CharacterAbilityInput,
  CharacterCardReference,
  GatlingResponseContext,
  IndiansResponseContext,
} from "../character-api.js";

type EffectSeat = CardEffectInput["state"]["seats"][number];

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function cardType(input: CardEffectInput, cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId
    ? TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId)
    : undefined;
}

function uniqueSeat(input: CardEffectInput, playerId: string): EffectSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function reject(code: Extract<CardEffectResult, { kind: "invalid_target" }>['code']): CardEffectResult {
  return { kind: "invalid_target", code };
}

function sourceIssue(input: CardEffectInput, expectedTypeId: string): CardEffectResult | undefined {
  return cardType(input, input.sourceCardInstanceId) === expectedTypeId
    ? undefined
    : reject("TARGET_NOT_ALLOWED");
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

function queryBangAsMissed(
  input: CardEffectInput,
  playerId: string,
  cardInstanceId: string,
  interactionId: string,
  attackerPlayerId: string,
): CardSubstitutionQueryResult {
  const sourceCardInstanceId = input.sourceCardInstanceId;
  if (!sourceCardInstanceId) return {
    kind: "card_substitution_query",
    allowed: false,
    physicalCardTypeId: "bang",
    effectCardTypeId: "missed",
    bangQuota: "does_not_count",
  };
  const context: GatlingResponseContext = {
    kind: "gatling_response",
    interactionId,
    attackerPlayerId,
    attackCard: {
      cardInstanceId: sourceCardInstanceId,
      physicalCardTypeId: "gatling",
      effectCardTypeId: "gatling",
    },
  };
  return calamityJanetAbility(characterInput(input, playerId, {
    kind: "card_substitution_query",
    card: { cardInstanceId, physicalCardTypeId: "bang", effectCardTypeId: "missed" },
    context,
  }));
}

function querySourceMissedAsBang(
  input: CardEffectInput,
  playerId: string,
  cardInstanceId: string,
  interactionId: string,
  sourceCard: CharacterCardReference,
): CardSubstitutionQueryResult {
  const context: IndiansResponseContext = {
    kind: "indians_response",
    interactionId,
    sourcePlayerId: input.actorPlayerId,
    sourceCard,
  };
  return calamityJanetAbility(characterInput(input, playerId, {
    kind: "card_substitution_query",
    card: { cardInstanceId, physicalCardTypeId: "missed", effectCardTypeId: "bang" },
    context,
  }));
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Record<string, JsonValue>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function effectId(input: CardEffectInput, name: string): string {
  return `${input.continuationFrameId}:${input.sourceCardInstanceId}:${name}`;
}

function damageStep(
  input: CardEffectInput,
  targetPlayerId: string,
  cause: "GATLING" | "INDIANS",
): EffectStep {
  return {
    effectId: effectId(input, `${cause.toLowerCase()}:damage:${targetPlayerId}`),
    kind: "DAMAGE_PLAYER",
    sourcePlayerId: input.actorPlayerId,
    targetPlayerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload: { amount: 1, cause },
  };
}

function targetFromInput(input: CardEffectInput): EffectTarget | undefined {
  return input.targets.length === 1 && input.targets[0]?.kind === "player"
    ? input.targets[0]
    : undefined;
}

function findTargetInteraction(
  input: CardEffectInput,
  kind: "GATLING_RESPONSE" | "INDIANS_RESPONSE",
  targetPlayerId: string,
): CompletedEffectInteraction | undefined {
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (
      interaction.kind === kind &&
      interaction.context.continuationFrameId === input.continuationFrameId &&
      interaction.context.sourceCardInstanceId === input.sourceCardInstanceId &&
      interaction.context.targetPlayerId === targetPlayerId
    ) {
      return interaction;
    }
  }
  return undefined;
}

function targetQueue(
  input: CardEffectInput,
  typeId: "gatling" | "indians",
): { readonly steps: readonly EffectStep[]; readonly targetPlayerIds: readonly string[] } | CardEffectResult {
  const actor = uniqueSeat(input, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const built = buildClockwiseTargetSteps(input.state as unknown as GameState, {
    effectId: effectId(input, typeId),
    kind: typeId === "gatling" ? "GATLING_TARGET" : "INDIANS_TARGET",
    sourcePlayerId: input.actorPlayerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload: {
      cardType: typeId,
      deferVictoryCheckUntilQueueEnds: true,
    },
  });
  if (!built.ok) return reject("TARGET_NOT_FOUND");
  return {
    steps: built.value,
    targetPlayerIds: built.value.flatMap((step) => step.targetPlayerId === null ? [] : [step.targetPlayerId]),
  };
}

function makeTargetResponseRequest(
  input: CardEffectInput,
  target: EffectSeat,
  kind: "GATLING_RESPONSE" | "INDIANS_RESPONSE",
  options: readonly { readonly choice: string; readonly payload: Record<string, JsonValue> }[],
  targetStepId: string,
): Extract<CardEffectResult, { kind: "response_required" }> {
  return {
    kind: "response_required",
    request: {
      kind,
      responders: [{ playerId: target.public.playerId, options }],
      context: {
        continuationFrameId: input.continuationFrameId,
        sourceCardInstanceId: input.sourceCardInstanceId,
        sourcePlayerId: input.actorPlayerId,
        targetPlayerId: target.public.playerId,
        targetStepId,
      },
      resumeFrameId: input.continuationFrameId,
    },
    events: [],
    steps: [],
  };
}

function resolveGatlingTarget(input: CardEffectInput, target: EffectSeat): CardEffectResult {
  if (target.public.eliminated) {
    return { kind: "applied", events: [], steps: [] };
  }
  const missed = target.private.handCardInstanceIds
    .filter((cardInstanceId) => cardType(input, cardInstanceId) === "missed")
    .map((cardInstanceId) => ({ choice: "USE_MISSED", payload: { cardInstanceId } }));
  const bangAsMissed = target.public.characterId === "calamity_janet"
    ? target.private.handCardInstanceIds
      .filter((cardInstanceId) => cardType(input, cardInstanceId) === "bang")
      .map((cardInstanceId) => ({ choice: "USE_MISSED", payload: { cardInstanceId } }))
    : [];
  const hasBarrel = target.public.inPlayCardInstanceIds.some((cardInstanceId) => cardType(input, cardInstanceId) === "barrel");
  const hasJourdonnais = target.public.characterId === "jourdonnais";
  const targetStepId = effectId(input, `gatling:target:${target.public.playerId}`);
  const response = findTargetInteraction(input, "GATLING_RESPONSE", target.public.playerId);

  if (!response) {
    return makeTargetResponseRequest(input, target, "GATLING_RESPONSE", [
      ...missed,
      ...bangAsMissed,
      ...(hasBarrel ? [{ choice: "USE_BARREL", payload: {} }] : []),
      ...(hasJourdonnais ? [{ choice: "USE_JOURDONNAIS", payload: {} }] : []),
      { choice: "TAKE_HIT", payload: {} },
    ], targetStepId);
  }

  const answer = response.responses[0];
  if (
    !answer || answer.playerId !== target.public.playerId ||
    response.context.sourcePlayerId !== input.actorPlayerId ||
    response.context.targetStepId !== targetStepId
  ) return reject("TARGET_NOT_ALLOWED");
  if (answer.choice === "TAKE_HIT" && Object.keys(answer.payload).length === 0) {
    return {
      kind: "applied",
      events: [event("GATLING_HIT", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerId: target.public.playerId,
        damage: 1,
      })],
      steps: [damageStep(input, target.public.playerId, "GATLING")],
    };
  }
  if (answer.choice === "USE_MISSED") {
    const cardInstanceId = answer.payload.cardInstanceId;
    const physicalTypeId = typeof cardInstanceId === "string" ? cardType(input, cardInstanceId) : undefined;
    const isOrdinaryMissed = typeof cardInstanceId === "string" &&
      target.private.handCardInstanceIds.includes(cardInstanceId) && physicalTypeId === "missed";
    const isCalamityBangAsMissed = typeof cardInstanceId === "string" &&
      target.private.handCardInstanceIds.includes(cardInstanceId) && physicalTypeId === "bang" &&
      target.public.characterId === "calamity_janet" &&
      queryBangAsMissed(input, target.public.playerId, cardInstanceId, response.interactionId, input.actorPlayerId).allowed;
    if (!isOrdinaryMissed && !isCalamityBangAsMissed) {
      return reject("TARGET_NOT_ALLOWED");
    }
    return {
      kind: "applied",
      events: [
        event("CARD_DISCARDED", target.public.playerId, {
          sourceCardInstanceId: input.sourceCardInstanceId,
          cardInstanceId,
          ownerPlayerId: target.public.playerId,
          fromZone: "hand",
          toZone: "discard",
        }),
        event("GATLING_MISSED", target.public.playerId, {
          sourceCardInstanceId: input.sourceCardInstanceId,
          targetPlayerId: target.public.playerId,
        }),
      ],
      steps: [],
    };
  }
  if (answer.choice === "USE_BARREL" || answer.choice === "USE_JOURDONNAIS") {
    if (Object.keys(answer.payload).length !== 0) return reject("TARGET_NOT_ALLOWED");
    const defenseSource = answer.choice === "USE_BARREL" ? "barrel" : "jourdonnais";
    if ((defenseSource === "barrel" && !hasBarrel) || (defenseSource === "jourdonnais" && !hasJourdonnais)) {
      return reject("TARGET_NOT_ALLOWED");
    }
    return {
      kind: "applied",
      events: [event("BARREL_CHECK_REQUESTED", target.public.playerId, {
        attackKind: "GATLING",
        defenseSource,
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerId: target.public.playerId,
      })],
      steps: [{
        effectId: effectId(input, `gatling:barrel-check:${target.public.playerId}:${defenseSource}`),
        kind: "BARREL_CHECK",
        sourcePlayerId: input.actorPlayerId,
        targetPlayerId: target.public.playerId,
        sourceCardInstanceId: input.sourceCardInstanceId,
        payload: {
          attackKind: "GATLING",
          defenseSource,
          targetStepId,
        },
      }],
    };
  }
  return reject("TARGET_NOT_ALLOWED");
}

/** Gatling queues each living opponent clockwise; each target is resolved separately. */
export const gatlingEffect: CardEffectModule = (input) => {
  const issue = sourceIssue(input, "gatling");
  if (issue) return issue;

  if (input.targets.length === 0) {
    const queue = targetQueue(input, "gatling");
    if ("kind" in queue) return queue;
    return {
      kind: "applied",
      events: [event("GATLING_STARTED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerIds: [...queue.targetPlayerIds],
      })],
      steps: queue.steps,
    };
  }

  const targetRef = targetFromInput(input);
  if (!targetRef) return reject("TARGET_NOT_ALLOWED");
  if (targetRef.playerId === input.actorPlayerId) return reject("TARGET_IS_SELF");
  const actor = uniqueSeat(input, input.actorPlayerId);
  const target = uniqueSeat(input, targetRef.playerId);
  if (!actor || !target) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");
  return resolveGatlingTarget(input, target);
};

function resolveIndiansTarget(input: CardEffectInput, target: EffectSeat): CardEffectResult {
  if (target.public.eliminated) return { kind: "applied", events: [], steps: [] };
  const canConvertMissed = target.public.characterId === "calamity_janet";
  const sourceCard = {
    cardInstanceId: input.sourceCardInstanceId,
    physicalCardTypeId: "indians",
    effectCardTypeId: "indians",
  } as const;
  const bangOptions = target.private.handCardInstanceIds
    .filter((cardInstanceId) => {
      const typeId = cardType(input, cardInstanceId);
      return typeId === "bang" || (canConvertMissed && typeId === "missed");
    })
    .map((cardInstanceId) => ({ choice: "USE_BANG", payload: { cardInstanceId } }));
  const targetStepId = effectId(input, `indians:target:${target.public.playerId}`);
  const response = findTargetInteraction(input, "INDIANS_RESPONSE", target.public.playerId);

  if (!response) {
    return makeTargetResponseRequest(input, target, "INDIANS_RESPONSE", [
      ...bangOptions,
      { choice: "TAKE_HIT", payload: {} },
    ], targetStepId);
  }

  const answer = response.responses[0];
  if (
    !answer || answer.playerId !== target.public.playerId ||
    response.context.sourcePlayerId !== input.actorPlayerId ||
    response.context.targetStepId !== targetStepId
  ) return reject("TARGET_NOT_ALLOWED");
  if (answer.choice === "TAKE_HIT" && Object.keys(answer.payload).length === 0) {
    return {
      kind: "applied",
      events: [event("INDIANS_HIT", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerId: target.public.playerId,
        damage: 1,
      })],
      steps: [damageStep(input, target.public.playerId, "INDIANS")],
    };
  }
  if (answer.choice === "USE_BANG") {
    const cardInstanceId = answer.payload.cardInstanceId;
    const typeId = typeof cardInstanceId === "string" ? cardType(input, cardInstanceId) : undefined;
    const convertedMissedAllowed = typeof cardInstanceId === "string" && typeId === "missed" &&
      canConvertMissed && querySourceMissedAsBang(
        input,
        target.public.playerId,
        cardInstanceId,
        response.interactionId,
        sourceCard,
      ).allowed;
    if (typeof cardInstanceId !== "string" ||
        !target.private.handCardInstanceIds.includes(cardInstanceId) ||
        (typeId !== "bang" && !convertedMissedAllowed)) {
      return reject("TARGET_NOT_ALLOWED");
    }
    return {
      kind: "applied",
      events: [
        event("CARD_DISCARDED", target.public.playerId, {
          sourceCardInstanceId: input.sourceCardInstanceId,
          cardInstanceId,
          ownerPlayerId: target.public.playerId,
          fromZone: "hand",
          toZone: "discard",
        }),
        event("INDIANS_DEFENDED", target.public.playerId, {
          sourceCardInstanceId: input.sourceCardInstanceId,
          targetPlayerId: target.public.playerId,
          cardInstanceId,
          convertedFromMissed: typeId === "missed",
        }),
      ],
      steps: [],
    };
  }
  return reject("TARGET_NOT_ALLOWED");
}

/** Indians asks each living opponent for a BANG discard or one point of damage. */
export const indiansEffect: CardEffectModule = (input) => {
  const issue = sourceIssue(input, "indians");
  if (issue) return issue;

  if (input.targets.length === 0) {
    const queue = targetQueue(input, "indians");
    if ("kind" in queue) return queue;
    return {
      kind: "applied",
      events: [event("INDIANS_STARTED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerIds: [...queue.targetPlayerIds],
      })],
      steps: queue.steps,
    };
  }

  const targetRef = targetFromInput(input);
  if (!targetRef) return reject("TARGET_NOT_ALLOWED");
  if (targetRef.playerId === input.actorPlayerId) return reject("TARGET_IS_SELF");
  const actor = uniqueSeat(input, input.actorPlayerId);
  const target = uniqueSeat(input, targetRef.playerId);
  if (!actor || !target) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");
  return resolveIndiansTarget(input, target);
};

/** Saloon heals every non-eliminated player, including its user, up to max HP. */
export const saloonEffect: CardEffectModule = (input) => {
  const issue = sourceIssue(input, "saloon");
  if (issue) return issue;
  if (input.targets.length > 0) return reject("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");
  if (input.state.resolution.pendingDeath !== null || input.state.resolution.pendingInteraction !== null) {
    return reject("TARGET_NOT_ALLOWED");
  }

  const recipients = [...input.state.seats]
    .sort((left, right) => left.public.seatIndex - right.public.seatIndex)
    .filter((seat) => !seat.public.eliminated && seat.public.hp > 0);
  const healedRecipients = recipients.flatMap((seat) => {
    const amount = Math.min(1, Math.max(0, seat.public.maxHp - seat.public.hp));
    return amount === 0 ? [] : [{ seat, amount }];
  });
  const steps: EffectStep[] = healedRecipients.map(({ seat, amount }) => ({
    effectId: effectId(input, `saloon:heal:${seat.public.playerId}`),
    kind: "HEAL_PLAYER",
    sourcePlayerId: input.actorPlayerId,
    targetPlayerId: seat.public.playerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload: { amount, cause: "SALOON" },
  }));

  return {
    kind: "applied",
    events: [
      event("SALOON_USED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        healedPlayerIds: healedRecipients.map(({ seat }) => seat.public.playerId),
      }),
      ...healedRecipients.map(({ seat, amount }) => event("PLAYER_HEALED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        targetPlayerId: seat.public.playerId,
        amount,
        cause: "SALOON",
      })),
    ],
    steps,
  };
};
