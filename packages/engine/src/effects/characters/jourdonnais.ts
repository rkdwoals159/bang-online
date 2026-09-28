import type { EffectEventDraft } from "../api.js";
import type {
  AttackResponseQueryHookInput,
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  JourdonnaisJudgmentHookInput,
} from "../character-api.js";

type JourdonnaisInput = CharacterAbilityInput<"jourdonnais">;
type JourdonnaisSeat = JourdonnaisInput["state"]["seats"][number];
type JourdonnaisAttackQuery = Extract<JourdonnaisInput["hook"], { readonly kind: "attack_response_query" }>;

function uniqueSeat(input: JourdonnaisInput, playerId: string): JourdonnaisSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function isBangSymbolAttack(attack: AttackResponseQueryHookInput["attack"]): boolean {
  if (attack.kind === "bang") {
    return attack.card.effectCardTypeId === "bang" &&
      (attack.card.physicalCardTypeId === "bang" || attack.card.physicalCardTypeId === "missed");
  }
  return attack.card.effectCardTypeId === "gatling" && attack.card.physicalCardTypeId === "gatling";
}

function isLiveJourdonnais(input: JourdonnaisInput, playerId: string): boolean {
  const seat = uniqueSeat(input, playerId);
  return Boolean(seat && seat.public.characterId === "jourdonnais" && !seat.public.eliminated && seat.public.hp > 0);
}

function queryResult(input: JourdonnaisInput, hook: JourdonnaisAttackQuery) {
  if (
    hook.attack.defenderPlayerId !== input.playerId ||
    hook.attack.attackerPlayerId === input.playerId ||
    !isLiveJourdonnais(input, input.playerId) ||
    !isBangSymbolAttack(hook.attack) ||
    !Number.isSafeInteger(hook.missedCardsAlreadySubmitted) || hook.missedCardsAlreadySubmitted < 0 ||
    hook.judgmentSourcesAlreadyAttempted.includes("jourdonnais")
  ) {
    return {
      kind: "attack_response_query" as const,
      additionalMissedCardsRequired: 0 as const,
      availableJudgmentSources: [],
    };
  }

  return {
    kind: "attack_response_query" as const,
    additionalMissedCardsRequired: 0 as const,
    availableJudgmentSources: ["jourdonnais"] as const,
  };
}

function judgmentEvent(input: JourdonnaisInput, hook: JourdonnaisJudgmentHookInput): EffectEventDraft | undefined {
  const { judgment } = hook;
  if (
    judgment.playerId !== input.playerId ||
    judgment.attack.defenderPlayerId !== input.playerId ||
    judgment.attack.attackerPlayerId === input.playerId ||
    !isLiveJourdonnais(input, input.playerId) ||
    !isBangSymbolAttack(judgment.attack)
  ) return undefined;

  const candidate = input.state.zones.cardsByInstanceId[judgment.candidate.cardInstanceId];
  if (
    !candidate ||
    candidate.cardInstanceId !== judgment.candidate.cardInstanceId ||
    candidate.cardDefinitionId !== judgment.candidate.cardDefinitionId ||
    candidate.rank !== judgment.candidate.rank ||
    candidate.suit !== judgment.candidate.suit
  ) return undefined;

  const succeeded = candidate.suit === "HEARTS";
  return {
    type: "BARREL_CHECK_RESOLVED",
    actorPlayerId: input.playerId,
    payload: {
      attackKind: judgment.attack.kind === "bang" ? "BANG" : "GATLING",
      defenseSource: "jourdonnais",
      sourceCardInstanceId: judgment.attack.card.cardInstanceId,
      targetPlayerId: input.playerId,
      judgmentCardInstanceId: candidate.cardInstanceId,
      succeeded,
      missesGranted: succeeded ? 1 : 0,
    },
  };
}

/** C06/R13 contributes one virtual Barrel check to each BANG-symbol response. */
export const jourdonnaisAbility: CharacterAbilityModule<"jourdonnais"> = (input) => {
  if (input.hook.kind === "attack_response_query") return queryResult(input, input.hook);

  const resolved = judgmentEvent(input, input.hook);
  return resolved
    ? { kind: "applied", events: [resolved], steps: [] }
    : noEffect();
};
