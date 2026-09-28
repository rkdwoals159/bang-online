import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  EliminationCleanupHookInput,
} from "../character-api.js";

type VultureInput = CharacterAbilityInput<"vulture_sam">;
type VultureSeat = VultureInput["state"]["seats"][number];

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function uniqueSeat(input: VultureInput, playerId: string): VultureSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function sameOrderedIds(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((cardInstanceId, index) => cardInstanceId === actual[index]);
}

function validUniqueIds(ids: readonly string[]): boolean {
  return ids.every((id) => typeof id === "string" && id.trim().length > 0) && new Set(ids).size === ids.length;
}

function locationCount(input: VultureInput, cardInstanceId: string): number {
  let count = 0;
  const countIn = (ids: readonly string[]) => { count += ids.filter((id) => id === cardInstanceId).length; };
  for (const seat of input.state.seats) {
    countIn(seat.private.handCardInstanceIds);
    countIn(seat.public.inPlayCardInstanceIds);
  }
  countIn(input.state.zones.drawPileCardInstanceIds);
  countIn(input.state.zones.discardPileCardInstanceIds);
  countIn(input.state.zones.revealedPoolCardInstanceIds);
  return count;
}

function validSalvage(input: VultureInput, victim: VultureSeat, hook: EliminationCleanupHookInput): boolean {
  const { handCardInstanceIds, inPlayCardInstanceIds } = hook.salvageableCards;
  const allIds = [...handCardInstanceIds, ...inPlayCardInstanceIds];
  if (!validUniqueIds(handCardInstanceIds) || !validUniqueIds(inPlayCardInstanceIds) ||
      !validUniqueIds(allIds) || !sameOrderedIds(handCardInstanceIds, victim.private.handCardInstanceIds) ||
      !sameOrderedIds(inPlayCardInstanceIds, victim.public.inPlayCardInstanceIds)) return false;

  return allIds.every((cardInstanceId) => {
    const card = input.state.zones.cardsByInstanceId[cardInstanceId];
    return Boolean(card && card.cardInstanceId === cardInstanceId && locationCount(input, cardInstanceId) === 1);
  });
}

function transferEvent(
  input: VultureInput,
  victimPlayerId: string,
  cardInstanceId: string,
  fromZone: "hand" | "in_play",
): EffectEventDraft {
  return {
    type: "CARD_TRANSFERRED",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      fromPlayerId: victimPlayerId,
      fromZone,
      toPlayerId: input.playerId,
      toZone: "hand",
    },
  };
}

/** C15 takes another eliminated player's remaining hand/equipment into hand, without auto-equipping. */
export const vultureSamAbility: CharacterAbilityModule<"vulture_sam"> = (input) => {
  const hook = input.hook;
  if (input.characterId !== "vulture_sam" || input.state.status !== "playing" ||
      !hook || hook.kind !== "elimination_cleanup" || hook.eliminatedPlayerId.trim().length === 0) return noEffect();

  const vulture = uniqueSeat(input, input.playerId);
  const victim = uniqueSeat(input, hook.eliminatedPlayerId);
  if (!vulture || !victim || vulture.public.characterId !== "vulture_sam" || vulture.public.eliminated ||
      vulture.public.playerId === victim.public.playerId || !victim.public.eliminated ||
      !validSalvage(input, victim, hook)) return noEffect();

  const events = [
    ...hook.salvageableCards.handCardInstanceIds.map((cardInstanceId) => transferEvent(input, victim.public.playerId, cardInstanceId, "hand")),
    ...hook.salvageableCards.inPlayCardInstanceIds.map((cardInstanceId) => transferEvent(input, victim.public.playerId, cardInstanceId, "in_play")),
  ];
  return events.length === 0 ? noEffect() : { kind: "applied", events, steps: [] };
};
