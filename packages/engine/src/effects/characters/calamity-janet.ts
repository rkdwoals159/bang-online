import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type {
  CardSubstitutionHookInput,
  CardSubstitutionQueryResult,
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterCardReference,
} from "../character-api.js";

type CalamityInput = CharacterAbilityInput<"calamity_janet">;

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function seatFor(input: CalamityInput) {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === input.playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function physicalType(input: CalamityInput, cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const card = input.state.zones.cardsByInstanceId[cardInstanceId];
  if (!card || card.cardInstanceId !== cardInstanceId) return undefined;
  return TYPE_BY_DEFINITION_ID.get(card.cardDefinitionId);
}

function substitutionCardIsAvailable(input: CalamityInput, hook: CardSubstitutionHookInput): boolean {
  const actor = seatFor(input);
  const cardInstanceId = hook.card.cardInstanceId;
  const context = hook.context;
  if (!actor || !cardInstanceId) return false;
  if (actor.private.handCardInstanceIds.includes(cardInstanceId)) return true;

  if (!input.state.zones.discardPileCardInstanceIds.includes(cardInstanceId)) return false;
  if (context.kind === "play_card") {
    // A PLAY_CARD source is discarded before its saved BANG_RESPONSE resumes.
    return input.completedInteractions.some((interaction) =>
      interaction.kind === "BANG_RESPONSE" &&
      interaction.context.continuationFrameId === input.continuationFrameId &&
      interaction.context.sourcePlayerId === input.playerId &&
      interaction.context.sourceCardInstanceId === cardInstanceId);
  }

  const expected = context.kind === "bang_response"
    ? { interactionKind: "BANG_RESPONSE", choice: "USE_MISSED" }
    : context.kind === "gatling_response"
      ? { interactionKind: "GATLING_RESPONSE", choice: "USE_MISSED" }
      : context.kind === "indians_response"
        ? { interactionKind: "INDIANS_RESPONSE", choice: "USE_BANG" }
        : { interactionKind: "DUEL_RESPONSE", choice: "PLAY_BANG" };
  return input.completedInteractions.some((interaction) =>
    interaction.kind === expected.interactionKind &&
    interaction.interactionId === context.interactionId &&
    interaction.context.continuationFrameId === input.continuationFrameId &&
    interaction.responses.some((response) =>
      response.playerId === input.playerId &&
      response.choice === expected.choice &&
      response.payload.cardInstanceId === cardInstanceId));
}

function referenceMatches(
  input: CalamityInput,
  reference: CharacterCardReference,
  expected: readonly (readonly [string, string])[],
): boolean {
  if (reference.cardInstanceId === null ||
      !expected.some(([physical, effect]) =>
        reference.physicalCardTypeId === physical && reference.effectCardTypeId === effect)) {
    return false;
  }
  return physicalType(input, reference.cardInstanceId) === reference.physicalCardTypeId;
}

function validInteractionId(value: string): boolean {
  return value.trim().length > 0;
}

function validHookContext(input: CalamityInput, hook: CardSubstitutionHookInput): boolean {
  const context = hook.context;
  if (hook.card.physicalCardTypeId === "bang" && hook.card.effectCardTypeId === "missed") {
    if (context.kind === "bang_response") {
      return validInteractionId(context.interactionId) &&
        context.attackerPlayerId !== input.playerId &&
        referenceMatches(input, context.attackCard, [["bang", "bang"], ["missed", "bang"]]);
    }
    if (context.kind === "gatling_response") {
      return validInteractionId(context.interactionId) &&
        context.attackerPlayerId !== input.playerId &&
        referenceMatches(input, context.attackCard, [["gatling", "gatling"]]);
    }
    return false;
  }

  if (hook.card.physicalCardTypeId !== "missed" || hook.card.effectCardTypeId !== "bang") return false;
  if (context.kind === "play_card") {
    return context.phase === "play" && input.state.turn.phase === "play" &&
      input.state.turn.currentPlayerId === input.playerId;
  }
  if (context.kind === "indians_response") {
    return validInteractionId(context.interactionId) && context.sourcePlayerId !== input.playerId &&
      referenceMatches(input, context.sourceCard, [["indians", "indians"]]);
  }
  if (context.kind === "duel_response") {
    return validInteractionId(context.interactionId) && context.duelInitiatorPlayerId !== input.playerId &&
      referenceMatches(input, context.sourceCard, [["duel", "duel"]]);
  }
  return false;
}

function result(input: CalamityInput, allowed: boolean): CardSubstitutionQueryResult {
  const hook = input.hook as CardSubstitutionHookInput;
  const playConversion = hook.card.physicalCardTypeId === "missed" &&
    hook.card.effectCardTypeId === "bang" && hook.context.kind === "play_card";
  return {
    kind: "card_substitution_query",
    allowed,
    physicalCardTypeId: hook.card.physicalCardTypeId,
    effectCardTypeId: hook.card.effectCardTypeId,
    bangQuota: allowed && playConversion ? "counts" : "does_not_count",
  };
}

/** C03 converts only the two documented physical/effect pairs in their legal windows. */
export const calamityJanetAbility: CharacterAbilityModule<"calamity_janet"> = (input) => {
  const actor = seatFor(input);
  const hook = input.hook;
  const cardExistsWithPhysicalType = physicalType(input, hook.card.cardInstanceId) === hook.card.physicalCardTypeId;
  const allowed = input.characterId === "calamity_janet" &&
    actor?.public.characterId === "calamity_janet" &&
    !actor.public.eliminated && actor.public.hp > 0 &&
    substitutionCardIsAvailable(input, hook) &&
    cardExistsWithPhysicalType && validHookContext(input, hook);
  return result(input, allowed);
};
