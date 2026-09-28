import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  DirectionalDistanceQueryResult,
} from "../character-api.js";

type RoseInput = CharacterAbilityInput<"rose_doolan">;
type RoseSeat = RoseInput["state"]["seats"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject malformed seat rings before using their directional distance query. */
function validSeatRing(input: RoseInput): boolean {
  const state: unknown = input.state;
  if (!isRecord(state) || !Array.isArray(state.seats)) return false;
  const seats = state.seats as readonly unknown[];
  if (seats.length < 4 || seats.length > 7) return false;

  const playerIds = new Set<string>();
  const seatIndices = new Set<number>();
  let roseCount = 0;

  for (const candidate of seats) {
    if (!isRecord(candidate) || !isRecord(candidate.public)) return false;
    const publicState = candidate.public;
    const playerId = publicState.playerId;
    const seatIndex = publicState.seatIndex;
    const characterId = publicState.characterId;
    const hp = publicState.hp;
    const eliminated = publicState.eliminated;

    if (typeof playerId !== "string" || playerId.trim().length === 0 ||
        typeof seatIndex !== "number" || !Number.isSafeInteger(seatIndex) ||
        seatIndex < 0 || seatIndex >= seats.length ||
        typeof characterId !== "string" || characterId.length === 0 ||
        typeof hp !== "number" || !Number.isSafeInteger(hp) || hp < 0 ||
        typeof eliminated !== "boolean") {
      return false;
    }
    if (playerIds.has(playerId) || seatIndices.has(seatIndex)) return false;
    playerIds.add(playerId);
    seatIndices.add(seatIndex);
    if (characterId === "rose_doolan") roseCount += 1;
  }

  return roseCount === 1 && [...seatIndices].every((seatIndex, index) => seatIndices.has(index));
}

function uniqueSeat(input: RoseInput, playerId: string): RoseSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function isLiving(seat: RoseSeat | undefined): seat is RoseSeat {
  // At HP 0 the player remains in the ring until the death-rescue interaction ends.
  return Boolean(seat && !seat.public.eliminated);
}

function queryResult(input: RoseInput): DirectionalDistanceQueryResult {
  const hook = input.hook;
  if (input.characterId !== "rose_doolan" || !validSeatRing(input) ||
      typeof hook.fromPlayerId !== "string" || hook.fromPlayerId.length === 0 ||
      typeof hook.toPlayerId !== "string" || hook.toPlayerId.length === 0 ||
      hook.fromPlayerId === hook.toPlayerId ||
      !Number.isSafeInteger(hook.baseDistance) || hook.baseDistance < 1) {
    return { kind: "distance_query", adjustment: 0 };
  }

  const rose = uniqueSeat(input, input.playerId);
  const source = uniqueSeat(input, hook.fromPlayerId);
  const target = uniqueSeat(input, hook.toPlayerId);
  const livingSeatCount = input.state.seats.filter((seat) => isLiving(seat)).length;
  if (!isLiving(rose) || rose.public.characterId !== "rose_doolan" ||
      !isLiving(source) || !isLiving(target) ||
      hook.baseDistance > Math.floor(livingSeatCount / 2) ||
      hook.fromPlayerId !== input.playerId || hook.toPlayerId === input.playerId) {
    return { kind: "distance_query", adjustment: 0 };
  }

  return { kind: "distance_query", adjustment: -1 };
}

/** C11 reduces only Rose's own directed distance queries to other living seats. */
export const roseDoolanAbility: CharacterAbilityModule<"rose_doolan"> = (input) => queryResult(input);
