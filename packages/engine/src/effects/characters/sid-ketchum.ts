import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  SidAbilityUseHookInput,
} from "../character-api.js";

type SidInput = CharacterAbilityInput<"sid_ketchum">;
type SidSeat = SidInput["state"]["seats"][number];

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function uniqueSeat(input: SidInput, playerId: string): SidSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function cardLocationCount(input: SidInput, cardInstanceId: string): number {
  let count = 0;
  const countIn = (ids: readonly string[]) => {
    count += ids.filter((id) => id === cardInstanceId).length;
  };

  for (const seat of input.state.seats) {
    countIn(seat.private.handCardInstanceIds);
    countIn(seat.public.inPlayCardInstanceIds);
  }
  countIn(input.state.zones.drawPileCardInstanceIds);
  countIn(input.state.zones.discardPileCardInstanceIds);
  countIn(input.state.zones.revealedPoolCardInstanceIds);
  return count;
}

function validCost(input: SidInput, actor: SidSeat, hook: SidAbilityUseHookInput): boolean {
  const ids: readonly string[] = hook.costCardInstanceIds;
  if (ids.length !== 2 || ids.some((id) => typeof id !== "string" || id.trim().length === 0) ||
      ids[0] === ids[1]) return false;

  return ids.every((id) => {
    const card = input.state.zones.cardsByInstanceId[id];
    return Boolean(card && card.cardInstanceId === id &&
      actor.private.handCardInstanceIds.filter((handId) => handId === id).length === 1 &&
      cardLocationCount(input, id) === 1);
  });
}

function completedRescueMatches(input: SidInput, hook: SidAbilityUseHookInput): boolean {
  if (hook.window.kind !== "death_rescue") return false;
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (interaction.kind !== "DEATH_RESCUE" || interaction.interactionId !== hook.window.interactionId ||
        interaction.context.continuationFrameId !== input.continuationFrameId ||
        interaction.context.victimPlayerId !== input.playerId || interaction.responses.length !== 1) continue;

    const response = interaction.responses[0]!;
    const rawIds = response.payload.cardInstanceIds;
    if (response.playerId !== input.playerId || response.choice !== "USE_SID" ||
        Object.keys(response.payload).length !== 1 || !Array.isArray(rawIds) || rawIds.length !== 2 ||
        rawIds[0] !== hook.costCardInstanceIds[0] || rawIds[1] !== hook.costCardInstanceIds[1]) return false;
    return true;
  }
  return false;
}

function validWindow(input: SidInput, actor: SidSeat, hook: SidAbilityUseHookInput): boolean {
  const { state } = input;
  if (hook.abilityId !== "sid-ketchum") return false;

  if (hook.window.kind === "play_phase") {
    return actor.public.hp > 0 && state.turn.currentPlayerId === input.playerId && state.turn.phase === "play" &&
      state.resolution.pendingInteraction === null && state.resolution.pendingDeath === null &&
      !input.completedInteractions.some((interaction) => interaction.kind === "DEATH_RESCUE");
  }

  const death = state.resolution.pendingDeath;
  return hook.window.interactionId.trim().length > 0 && hook.window.victimPlayerId === input.playerId &&
    actor.public.hp <= 0 && state.resolution.pendingInteraction === null && death !== null &&
    death.victimPlayerId === input.playerId && death.consequenceStage === "rescue" &&
    death.resumeFrameId === input.continuationFrameId && death.rescueCursor === death.rescueResponderIds.length &&
    death.rescueResponderIds.length === 1 && death.rescueResponderIds[0] === input.playerId &&
    completedRescueMatches(input, hook);
}

function healedResult(input: SidInput, actor: SidSeat): CharacterEffectResult {
  const amount = Math.min(1, Math.max(0, actor.public.maxHp - actor.public.hp));
  const events: EffectEventDraft[] = amount > 0
    ? [{
        type: "PLAYER_HEALED",
        actorPlayerId: input.playerId,
        payload: { targetPlayerId: input.playerId, amount, cause: "SID" },
      }]
    : [];
  const steps = amount > 0
    ? [{
        effectId: `${input.continuationFrameId}:sid-ketchum:heal`,
        kind: "HEAL_PLAYER",
        sourcePlayerId: input.playerId,
        targetPlayerId: input.playerId,
        sourceCardInstanceId: null,
        payload: { amount, cause: "SID" },
      }]
    : [];
  return { kind: "applied", events, steps };
}

/** C12/D02: a validated two-card use heals Sid in the play phase or her own rescue window. */
export const sidKetchumAbility: CharacterAbilityModule<"sid_ketchum"> = (input) => {
  if (input.characterId !== "sid_ketchum" || input.state.status !== "playing" ||
      !input.hook || input.hook.kind !== "sid_ability_use") return noEffect();
  const actor = uniqueSeat(input, input.playerId);
  if (!actor || actor.public.characterId !== "sid_ketchum" || actor.public.eliminated ||
      !Number.isSafeInteger(actor.public.hp) || !Number.isSafeInteger(actor.public.maxHp) ||
      actor.public.maxHp < 1 || actor.public.hp > actor.public.maxHp ||
      !validCost(input, actor, input.hook) || !validWindow(input, actor, input.hook)) return noEffect();

  // T66 applies the hook's two-card cost. This module contributes only the capped heal.
  return healedResult(input, actor);
};
