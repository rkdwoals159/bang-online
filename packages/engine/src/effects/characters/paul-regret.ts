import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  DirectionalDistanceQueryResult,
} from "../character-api.js";

type PaulInput = CharacterAbilityInput<"paul_regret">;
type PaulSeat = PaulInput["state"]["seats"][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reject a malformed seat ring before trusting its directional distance query. */
function validSeatRing(input: PaulInput): boolean {
  const state: unknown = input.state;
  if (!isRecord(state) || !Array.isArray(state.seats)) return false;
  const seats = state.seats as readonly unknown[];
  if (seats.length < 4 || seats.length > 7) return false;

  const playerIds = new Set<string>();
  const seatIndices = new Set<number>();
  let paulCount = 0;

  for (const candidate of seats) {
    if (!isRecord(candidate) || !isRecord(candidate.public)) return false;
    const publicState = candidate.public;
    const playerId = publicState.playerId;
    const seatIndex = publicState.seatIndex;
    const characterId = publicState.characterId;
    const hp = publicState.hp;
    const eliminated = publicState.eliminated;

    if (typeof playerId !== "string" || playerId.trim().length === 0 ||
        !Number.isSafeInteger(seatIndex) || typeof seatIndex !== "number" ||
        seatIndex < 0 || seatIndex >= seats.length ||
        typeof characterId !== "string" || characterId.length === 0 ||
        !Number.isSafeInteger(hp) || typeof hp !== "number" || hp < 0 ||
        typeof eliminated !== "boolean") {
      return false;
    }
    if (playerIds.has(playerId) || seatIndices.has(seatIndex)) return false;
    playerIds.add(playerId);
    seatIndices.add(seatIndex);
    if (characterId === "paul_regret") paulCount += 1;
  }

  return paulCount === 1 && [...seatIndices].every((seatIndex, index) => seatIndices.has(index));
}

function uniqueSeat(input: PaulInput, playerId: string): PaulSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function isLiving(seat: PaulSeat | undefined): seat is PaulSeat {
  return Boolean(seat && !seat.public.eliminated && seat.public.hp > 0);
}

function queryResult(input: PaulInput): DirectionalDistanceQueryResult {
  const hook = input.hook;
  if (input.characterId !== "paul_regret" || !validSeatRing(input) ||
      typeof hook.fromPlayerId !== "string" || hook.fromPlayerId.length === 0 ||
      typeof hook.toPlayerId !== "string" || hook.toPlayerId.length === 0 ||
      hook.fromPlayerId === hook.toPlayerId ||
      !Number.isSafeInteger(hook.baseDistance) || hook.baseDistance < 1) {
    return { kind: "distance_query", adjustment: 0 };
  }

  const paul = uniqueSeat(input, input.playerId);
  const source = uniqueSeat(input, hook.fromPlayerId);
  const target = uniqueSeat(input, hook.toPlayerId);
  const livingSeatCount = input.state.seats.filter((seat) => isLiving(seat)).length;
  if (!isLiving(paul) || paul.public.characterId !== "paul_regret" ||
      !isLiving(source) || !isLiving(target) ||
      hook.baseDistance > Math.floor(livingSeatCount / 2) ||
      hook.toPlayerId !== input.playerId || hook.fromPlayerId === input.playerId) {
    return { kind: "distance_query", adjustment: 0 };
  }

  return { kind: "distance_query", adjustment: 1 };
}

/** C09 adds one only to an opponent's direction of distance toward living Paul. */
export const paulRegretAbility: CharacterAbilityModule<"paul_regret"> = (input) => queryResult(input);
