import { BASE_CARD_DEFINITIONS, BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { GameState, SeatState } from "../state/types.js";
import { calculateDistance, getEquippedCardTypeIds, getMaxBangRange } from "./distance.js";

const PHYSICAL_CARD_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map((card) => [card.definitionId, card]),
);
const CARD_DEFINITION_BY_TYPE_ID = new Map(
  BASE_CARD_DEFINITIONS.map((definition) => [definition.typeId, definition]),
);
const SINGLE_TARGET_CARD_TYPES = new Set(["bang", "duel", "jail", "panic", "cat_balou"]);

export type TargetZone = "HAND" | "IN_PLAY";

export interface PlayCardLegalityInput {
  actorPlayerId: string;
  cardInstanceId: string;
  /** Used for cards that select one player. Hidden hand card IDs are never accepted. */
  targetPlayerId?: string;
  targetZone?: TargetZone;
  /** Required only to select an actual public in-play card. */
  targetCardInstanceId?: string;
}

export type PlayCardLegalityErrorCode =
  | "MATCH_NOT_PLAYING"
  | "NOT_YOUR_TURN"
  | "ILLEGAL_PHASE"
  | "RESOLUTION_PENDING"
  | "INVALID_STATE"
  | "CARD_NOT_IN_HAND"
  | "UNKNOWN_CARD"
  | "CARD_NOT_PLAYABLE"
  | "TARGET_REQUIRED"
  | "TARGET_NOT_ALLOWED"
  | "TARGET_NOT_FOUND"
  | "TARGET_NOT_ALIVE"
  | "TARGET_IS_SELF"
  | "TARGET_ZONE_REQUIRED"
  | "TARGET_CARD_REQUIRED"
  | "TARGET_CARD_NOT_IN_PLAY"
  | "TARGET_HAS_NO_CARDS"
  | "TARGET_OUT_OF_RANGE"
  | "BANG_LIMIT_REACHED"
  | "SHERIFF_CANNOT_BE_JAILED"
  | "DUPLICATE_EQUIPMENT";

export type PlayCardLegalityResult =
  | { ok: true; cardTypeId: string }
  | { ok: false; error: { code: PlayCardLegalityErrorCode; message: string } };

function reject(code: PlayCardLegalityErrorCode, message: string): PlayCardLegalityResult {
  return { ok: false, error: { code, message } };
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function hasPendingResolution(state: GameState): boolean {
  const resolution = state.resolution;
  return (
    resolution.effectQueue.length > 0 ||
    resolution.continuations.length > 0 ||
    resolution.pendingInteraction !== null ||
    resolution.pendingDeath !== null ||
    resolution.victoryCheckDeferredByEffectId !== null
  );
}

function targetFieldsPresent(input: PlayCardLegalityInput): boolean {
  return input.targetPlayerId !== undefined ||
    input.targetZone !== undefined ||
    input.targetCardInstanceId !== undefined;
}

function validateTargetCardZone(
  state: GameState,
  actor: SeatState,
  target: SeatState,
  input: PlayCardLegalityInput,
): PlayCardLegalityResult | undefined {
  if (input.targetZone !== "HAND" && input.targetZone !== "IN_PLAY") {
    return reject("TARGET_ZONE_REQUIRED", "Panic! and Cat Balou require a HAND or IN_PLAY target zone.");
  }

  if (input.targetZone === "HAND") {
    if (input.targetCardInstanceId !== undefined) {
      return reject("TARGET_NOT_ALLOWED", "A hidden hand card ID must not be supplied by the client.");
    }
    if (target.public.playerId === actor.public.playerId) {
      return reject("TARGET_IS_SELF", "A player's own hand cannot be selected as a target.");
    }
    if (target.private.handCardInstanceIds.length === 0) {
      return reject("TARGET_HAS_NO_CARDS", "The target has no hand card in the selected zone.");
    }
    return undefined;
  }

  if (input.targetCardInstanceId === undefined) {
    return reject("TARGET_CARD_REQUIRED", "Selecting an in-play card requires its public card instance ID.");
  }
  if (!target.public.inPlayCardInstanceIds.includes(input.targetCardInstanceId)) {
    return reject("TARGET_CARD_NOT_IN_PLAY", "The selected card is not an actual card in the target's public in-play area.");
  }

  const instance = state.zones.cardsByInstanceId[input.targetCardInstanceId];
  if (!instance || !PHYSICAL_CARD_BY_DEFINITION_ID.has(instance.cardDefinitionId)) {
    return reject("TARGET_CARD_NOT_IN_PLAY", "Only a physical catalog card in the public in-play area can be selected.");
  }
  return undefined;
}

function validateEquipmentUniqueness(
  state: GameState,
  cardTypeId: string,
  recipient: SeatState,
): PlayCardLegalityResult | undefined {
  const definition = CARD_DEFINITION_BY_TYPE_ID.get(cardTypeId);
  if (!definition || definition.color !== "blue") return undefined;

  const equippedTypes = getEquippedCardTypeIds(state, recipient.public.playerId);
  if (!equippedTypes) {
    return reject("INVALID_STATE", "The recipient's public in-play cards must exist in the catalog.");
  }
  if (equippedTypes.includes(cardTypeId)) {
    return reject("DUPLICATE_EQUIPMENT", "A card with the same name is already in play for this player.");
  }
  // A different weapon is permitted; the card effect layer performs the replacement.
  return undefined;
}

/**
 * Purely validates a normal PLAY_CARD action against current turn, ownership,
 * base-game targeting, distance, range, BANG! quota, and blue-card uniqueness.
 * This does not apply any card effect or mutate the supplied snapshot.
 */
export function checkPlayCardLegality(
  state: GameState,
  input: PlayCardLegalityInput,
): PlayCardLegalityResult {
  if (state.status !== "playing") {
    return reject("MATCH_NOT_PLAYING", "The match is not in play.");
  }
  if (state.turn.currentPlayerId !== input.actorPlayerId) {
    return reject("NOT_YOUR_TURN", "The actor is not the current player.");
  }

  const actor = uniqueSeat(state, input.actorPlayerId);
  if (!actor) return reject("INVALID_STATE", "The actor must identify exactly one seat.");
  if (actor.public.eliminated) return reject("INVALID_STATE", "An eliminated player cannot play a card.");
  if (state.turn.phase !== "play") {
    return reject("ILLEGAL_PHASE", "Normal cards may be played only during the current play phase.");
  }
  if (hasPendingResolution(state)) {
    return reject("RESOLUTION_PENDING", "A card resolution or interaction must finish before another card can start.");
  }
  if (!actor.private.handCardInstanceIds.includes(input.cardInstanceId)) {
    return reject("CARD_NOT_IN_HAND", "The played card must be in the actor's hand.");
  }

  const instance = state.zones.cardsByInstanceId[input.cardInstanceId];
  const physicalCard = instance && PHYSICAL_CARD_BY_DEFINITION_ID.get(instance.cardDefinitionId);
  if (!physicalCard || !CARD_DEFINITION_BY_TYPE_ID.has(physicalCard.typeId)) {
    return reject("UNKNOWN_CARD", "The card instance must identify a physical card in the base catalog.");
  }
  const cardTypeId = physicalCard.typeId;
  if (cardTypeId === "missed") {
    return reject("CARD_NOT_PLAYABLE", "Missed! is a response card, not a normal-use card.");
  }

  const requiresPlayerTarget = SINGLE_TARGET_CARD_TYPES.has(cardTypeId);
  if (!requiresPlayerTarget && targetFieldsPresent(input)) {
    return reject("TARGET_NOT_ALLOWED", "This card does not accept a single-player target.");
  }
  if (requiresPlayerTarget && input.targetPlayerId === undefined) {
    return reject("TARGET_REQUIRED", "This card requires a target player.");
  }

  if (!requiresPlayerTarget) {
    const uniquenessError = validateEquipmentUniqueness(state, cardTypeId, actor);
    if (uniquenessError) return uniquenessError;
  } else {
    const target = uniqueSeat(state, input.targetPlayerId!);
    if (!target) return reject("TARGET_NOT_FOUND", "The target player must identify exactly one seat.");
    if (target.public.eliminated) return reject("TARGET_NOT_ALIVE", "An eliminated player cannot be targeted.");

    if (cardTypeId === "bang") {
      if (input.targetZone !== undefined || input.targetCardInstanceId !== undefined) {
        return reject("TARGET_NOT_ALLOWED", "BANG! targets a player, not a card zone or card ID.");
      }
      if (target.public.playerId === actor.public.playerId) {
        return reject("TARGET_IS_SELF", "BANG! must target a different living player.");
      }

      const distance = calculateDistance(state, actor.public.playerId, target.public.playerId);
      const range = getMaxBangRange(state, actor.public.playerId);
      if (distance === undefined || range === undefined) {
        return reject("INVALID_STATE", "BANG! distance and range require valid living seats and equipment.");
      }
      if (distance.distance > range) {
        return reject("TARGET_OUT_OF_RANGE", `The target is at distance ${distance.distance}, beyond range ${range}.`);
      }

      const equippedTypes = getEquippedCardTypeIds(state, actor.public.playerId);
      if (!equippedTypes) return reject("INVALID_STATE", "The actor's public in-play cards must exist in the catalog.");
      const isVolcanic = equippedTypes.includes("volcanic");
      const isWillyTheKid = actor.public.characterId === "willy_the_kid";
      if (state.turn.bangCardPlaysThisTurn >= 1 && !isVolcanic && !isWillyTheKid) {
        return reject("BANG_LIMIT_REACHED", "Only one BANG! card may be used per turn without Volcanic or Willy the Kid.");
      }
    } else if (cardTypeId === "duel") {
      if (input.targetZone !== undefined || input.targetCardInstanceId !== undefined) {
        return reject("TARGET_NOT_ALLOWED", "Duel targets a player, not a card zone or card ID.");
      }
      if (target.public.playerId === actor.public.playerId) {
        return reject("TARGET_IS_SELF", "Duel must target a different living player.");
      }
    } else if (cardTypeId === "jail") {
      if (input.targetZone !== undefined || input.targetCardInstanceId !== undefined) {
        return reject("TARGET_NOT_ALLOWED", "Jail targets a player, not a card zone or card ID.");
      }
      if (target.public.playerId === actor.public.playerId) {
        return reject("TARGET_IS_SELF", "Jail cannot target its user.");
      }
      if (target.private.roleId === "sheriff") {
        return reject("SHERIFF_CANNOT_BE_JAILED", "Jail cannot target the Sheriff.");
      }
      const uniquenessError = validateEquipmentUniqueness(state, cardTypeId, target);
      if (uniquenessError) return uniquenessError;
    } else {
      // Panic! is range-limited for other players; Cat Balou has no distance limit.
      if (cardTypeId === "panic" && target.public.playerId !== actor.public.playerId) {
        const distance = calculateDistance(state, actor.public.playerId, target.public.playerId);
        if (!distance) return reject("INVALID_STATE", "Panic! distance requires valid living seats and equipment.");
        if (distance.distance > 1) {
          return reject("TARGET_OUT_OF_RANGE", `Panic! requires distance 1; the target is at distance ${distance.distance}.`);
        }
      }
      const zoneError = validateTargetCardZone(state, actor, target, input);
      if (zoneError) return zoneError;
    }
  }

  return { ok: true, cardTypeId };
}
