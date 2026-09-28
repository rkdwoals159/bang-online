import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { GameState, SeatState } from "../state/types.js";

const CARD_TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

const BANG_RANGE_BY_WEAPON: Readonly<Record<string, number>> = {
  volcanic: 1,
  schofield: 2,
  remington: 3,
  carabine: 4,
  winchester: 5,
};

export interface DistanceBreakdown {
  baseDistance: number;
  targetMustangBonus: number;
  targetPaulRegretBonus: number;
  sourceScopeReduction: number;
  sourceRoseDoolanReduction: number;
  distance: number;
}

function uniqueLivingSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  if (matches.length !== 1 || matches[0]!.public.eliminated) return undefined;
  return matches[0];
}

/**
 * Returns the static card types currently represented by a seat's public
 * in-play instances. An invalid seat or unknown instance returns undefined.
 */
export function getEquippedCardTypeIds(state: GameState, playerId: string): string[] | undefined {
  const seatMatches = state.seats.filter((seat) => seat.public.playerId === playerId);
  if (seatMatches.length !== 1) return undefined;

  const seat = seatMatches[0]!;
  const types: string[] = [];
  for (const cardInstanceId of seat.public.inPlayCardInstanceIds) {
    const instance = state.zones.cardsByInstanceId[cardInstanceId];
    const typeId = instance && CARD_TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId);
    if (!typeId) return undefined;
    types.push(typeId);
  }
  return types;
}

/**
 * Computes base distance around the currently living seats, ordered by their
 * stable seatIndex. A self distance is zero; card rules decide whether self
 * targeting is permitted.
 */
export function calculateBaseDistance(
  state: GameState,
  fromPlayerId: string,
  toPlayerId: string,
): number | undefined {
  if (!uniqueLivingSeat(state, fromPlayerId) || !uniqueLivingSeat(state, toPlayerId)) return undefined;

  const livingSeats = state.seats
    .filter((seat) => !seat.public.eliminated)
    .sort((left, right) => left.public.seatIndex - right.public.seatIndex);
  if (new Set(livingSeats.map((seat) => seat.public.seatIndex)).size !== livingSeats.length) return undefined;

  const fromIndex = livingSeats.findIndex((seat) => seat.public.playerId === fromPlayerId);
  const toIndex = livingSeats.findIndex((seat) => seat.public.playerId === toPlayerId);
  if (fromIndex < 0 || toIndex < 0) return undefined;

  const clockwiseSteps = Math.abs(fromIndex - toIndex);
  return Math.min(clockwiseSteps, livingSeats.length - clockwiseSteps);
}

/**
 * Calculates direction-specific R10 distance. Equipped range cards and
 * character distance rules modify distance; weapons do not.
 */
export function calculateDistance(
  state: GameState,
  fromPlayerId: string,
  toPlayerId: string,
): DistanceBreakdown | undefined {
  const baseDistance = calculateBaseDistance(state, fromPlayerId, toPlayerId);
  const source = uniqueLivingSeat(state, fromPlayerId);
  const target = uniqueLivingSeat(state, toPlayerId);
  if (baseDistance === undefined || !source || !target) return undefined;

  const sourceTypes = getEquippedCardTypeIds(state, fromPlayerId);
  const targetTypes = getEquippedCardTypeIds(state, toPlayerId);
  if (!sourceTypes || !targetTypes) return undefined;

  const targetMustangBonus = Number(targetTypes.includes("mustang"));
  const targetPaulRegretBonus = Number(target.public.characterId === "paul_regret");
  const sourceScopeReduction = Number(sourceTypes.includes("scope"));
  const sourceRoseDoolanReduction = Number(source.public.characterId === "rose_doolan");
  const distance = Math.max(
    1,
    baseDistance + targetMustangBonus + targetPaulRegretBonus - sourceScopeReduction - sourceRoseDoolanReduction,
  );

  return {
    baseDistance,
    targetMustangBonus,
    targetPaulRegretBonus,
    sourceScopeReduction,
    sourceRoseDoolanReduction,
    distance,
  };
}

/**
 * Returns the actor's maximum BANG! range. The virtual Colt .45 has range 1;
 * an invalid seat or a state with multiple equipped weapons returns undefined.
 */
export function getMaxBangRange(state: GameState, playerId: string): number | undefined {
  const seat = uniqueLivingSeat(state, playerId);
  const equippedTypes = getEquippedCardTypeIds(state, playerId);
  if (!seat || !equippedTypes) return undefined;

  const weapons = equippedTypes.filter((typeId) => typeId in BANG_RANGE_BY_WEAPON);
  if (weapons.length > 1) return undefined;
  return weapons.length === 0 ? 1 : BANG_RANGE_BY_WEAPON[weapons[0]!];
}
