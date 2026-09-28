import type {
  BangQuotaQueryHookInput,
  BangQuotaQueryResult,
  CharacterAbilityInput,
  CharacterAbilityModule,
} from "../character-api.js";

type WillyInput = CharacterAbilityInput<"willy_the_kid">;
type WillySeat = WillyInput["state"]["seats"][number];

function standardQuota(): BangQuotaQueryResult {
  return { kind: "bang_quota_query", maximumPerTurn: 1 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBangQuotaHook(value: unknown): value is BangQuotaQueryHookInput {
  if (!isRecord(value) || value.kind !== "bang_quota_query" || !isRecord(value.card)) return false;
  return typeof value.turnPlayerId === "string" && value.turnPlayerId.trim().length > 0 &&
    typeof value.card.cardInstanceId === "string" && value.card.cardInstanceId.trim().length > 0 &&
    (value.card.physicalCardTypeId === "bang" || value.card.physicalCardTypeId === "missed") &&
    value.card.effectCardTypeId === "bang" &&
    Number.isSafeInteger(value.bangCardPlaysThisTurn) &&
    typeof value.bangCardPlaysThisTurn === "number" && value.bangCardPlaysThisTurn >= 0 &&
    typeof value.volcanicEquipped === "boolean";
}

function uniqueSeat(input: WillyInput, playerId: string): WillySeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function quotaResult(input: WillyInput): BangQuotaQueryResult {
  const hook: unknown = input.hook;
  if (input.characterId !== "willy_the_kid" || !isBangQuotaHook(hook)) return standardQuota();

  const actor = uniqueSeat(input, input.playerId);
  if (!actor || actor.public.characterId !== "willy_the_kid" || actor.public.eliminated ||
      input.state.status !== "playing" || input.state.turn.phase !== "play" ||
      input.state.turn.currentPlayerId !== input.playerId || hook.turnPlayerId !== input.playerId ||
      !Number.isSafeInteger(input.state.turn.bangCardPlaysThisTurn) ||
      input.state.turn.bangCardPlaysThisTurn < 0 ||
      hook.bangCardPlaysThisTurn !== input.state.turn.bangCardPlaysThisTurn) {
    return standardQuota();
  }

  return { kind: "bang_quota_query", maximumPerTurn: "unlimited" };
}

/** C16 removes only Willy's own-turn BANG quota; target legality stays with T11. */
export const willyTheKidAbility: CharacterAbilityModule<"willy_the_kid"> = (input) => quotaResult(input);
