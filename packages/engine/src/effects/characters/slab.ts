import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type {
  AttackResponseQueryResult,
  CharacterAbilityInput,
  CharacterAbilityModule,
} from "../character-api.js";

type SlabInput = CharacterAbilityInput<"slab_the_killer">;
type SlabSeat = SlabInput["state"]["seats"][number];
type SlabAttackQuery = Extract<SlabInput["hook"], { readonly kind: "attack_response_query" }>;

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDefenseSource(value: unknown): value is "barrel" | "jourdonnais" {
  return value === "barrel" || value === "jourdonnais";
}

function isSlabAttackQuery(value: unknown): value is SlabAttackQuery {
  if (!isRecord(value) || value.kind !== "attack_response_query" || value.perspective !== "attacker" ||
      !isRecord(value.attack) || value.attack.kind !== "bang" || !isRecord(value.attack.card)) {
    return false;
  }

  const attack = value.attack;
  const card = attack.card;
  if (!isRecord(card)) return false;
  const attempted = value.judgmentSourcesAlreadyAttempted;
  return typeof attack.attackerPlayerId === "string" && attack.attackerPlayerId.trim().length > 0 &&
    typeof attack.defenderPlayerId === "string" && attack.defenderPlayerId.trim().length > 0 &&
    typeof card.cardInstanceId === "string" && card.cardInstanceId.trim().length > 0 &&
    card.physicalCardTypeId === "bang" && card.effectCardTypeId === "bang" &&
    typeof value.missedCardsAlreadySubmitted === "number" &&
    Number.isSafeInteger(value.missedCardsAlreadySubmitted) &&
    value.missedCardsAlreadySubmitted >= 0 && value.missedCardsAlreadySubmitted < 2 &&
    Array.isArray(attempted) && attempted.every(isDefenseSource) &&
    new Set(attempted).size === attempted.length;
}

function uniqueSeat(input: SlabInput, playerId: string): SlabSeat | undefined {
  const state: unknown = input.state;
  if (!isRecord(state) || !Array.isArray(state.seats)) return undefined;
  const matches = state.seats.filter((candidate) =>
    isRecord(candidate) && isRecord(candidate.public) && candidate.public.playerId === playerId);
  return matches.length === 1 ? matches[0] as SlabSeat : undefined;
}

function isLiving(seat: SlabSeat | undefined): seat is SlabSeat {
  return Boolean(seat && !seat.public.eliminated && seat.public.hp > 0);
}

function physicalCardType(input: SlabInput, cardInstanceId: string): string | undefined {
  const state: unknown = input.state;
  if (!isRecord(state) || !isRecord(state.zones) || !isRecord(state.zones.cardsByInstanceId)) return undefined;
  const card = state.zones.cardsByInstanceId[cardInstanceId];
  if (!isRecord(card) || card.cardInstanceId !== cardInstanceId || typeof card.cardDefinitionId !== "string") {
    return undefined;
  }
  return TYPE_BY_DEFINITION_ID.get(card.cardDefinitionId);
}

function queryResult(additionalMissedCardsRequired: 0 | 1): AttackResponseQueryResult {
  return {
    kind: "attack_response_query",
    additionalMissedCardsRequired,
    availableJudgmentSources: [],
  };
}

function additionalMissedRequirement(input: SlabInput): 0 | 1 {
  const hook: unknown = input.hook;
  if (input.characterId !== "slab_the_killer" || !isSlabAttackQuery(hook) ||
      typeof input.playerId !== "string" || input.playerId.trim().length === 0) {
    return 0;
  }

  const attacker = uniqueSeat(input, input.playerId);
  const defender = uniqueSeat(input, hook.attack.defenderPlayerId);
  if (!isLiving(attacker) || attacker.public.playerId !== hook.attack.attackerPlayerId ||
      attacker.public.characterId !== "slab_the_killer" || !isLiving(defender) ||
      defender.public.playerId === attacker.public.playerId ||
      input.state.status !== "playing" || input.state.turn.phase !== "play" ||
      input.state.turn.currentPlayerId !== input.playerId ||
      physicalCardType(input, hook.attack.card.cardInstanceId) !== "bang") {
    return 0;
  }

  return 1;
}

/** C13 adds one Missed requirement only to Slab's own physical BANG attack. */
export const slabAbility: CharacterAbilityModule<"slab_the_killer"> = (input) =>
  queryResult(additionalMissedRequirement(input));
