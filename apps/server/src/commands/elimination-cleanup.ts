import { applyMatchCommand, type ApplyMatchCommandContext } from "../../../../packages/engine/src/commands/index.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";

/** The engine's legal rescue options are authoritative, including Beer/Sid and two-player exceptions. */
export function hasUnavoidableElimination(state: GameState): boolean {
  const pending = state.resolution.pendingInteraction, death = state.resolution.pendingDeath;
  return state.status === "playing" && pending?.kind === "DEATH_RESCUE" &&
    death?.consequenceStage === "rescue" && pending.actorPlayerIds.length === 1 &&
    pending.actorPlayerIds[0] === death.victimPlayerId &&
    pending.options.length === 1 && pending.options[0]?.choice === "ACCEPT_ELIMINATION";
}

export function settleUnavoidableElimination(state: GameState, context: ApplyMatchCommandContext) {
  if (!hasUnavoidableElimination(state)) return { state, events: [] };
  const pending = state.resolution.pendingInteraction!;
  const result = applyMatchCommand(state, pending.actorPlayerIds[0]!, { type: "RESPOND", payload: {
    interactionId: pending.interactionId, choice: "ACCEPT_ELIMINATION",
  } }, context);
  if (!result.ok) throw new Error(`Automatic elimination failed: ${result.error.code}`);
  return { state: result.state, events: result.events };
}

/** Product policy: an eliminated owner never has to order their remaining cards. */
export function hasAutomaticEliminationCleanup(state: GameState): boolean {
  const pending = state.resolution.pendingInteraction;
  const death = state.resolution.pendingDeath;
  return state.status === "playing" && pending?.kind === "DISCARDS_ORDER" &&
    pending.context.endgameStage === "victim_card_cleanup" &&
    death?.consequenceStage === "cleanup" && pending.actorPlayerIds.length === 1 &&
    pending.actorPlayerIds[0] === death.victimPlayerId &&
    state.seats.some(seat => seat.public.playerId === death.victimPlayerId && seat.public.eliminated);
}

export function settleEliminationCleanup(state: GameState, context: ApplyMatchCommandContext) {
  if (!hasAutomaticEliminationCleanup(state)) return { state, events: [] };
  const pending = state.resolution.pendingInteraction!;
  const spec = pending.context.discardOrder;
  if (!spec || typeof spec !== "object" || Array.isArray(spec) || spec.reason !== "elimination_cleanup" ||
      !Array.isArray(spec.allowedCardInstanceIds) || spec.allowedCardInstanceIds.some(id => typeof id !== "string") ||
      spec.requiredCount !== spec.allowedCardInstanceIds.length) throw new Error("Invalid automatic elimination cleanup.");
  // Preserve the engine's saved candidate order; do not choose cards for living players.
  const result = applyMatchCommand(state, pending.actorPlayerIds[0]!, { type: "RESPOND", payload: {
    interactionId: pending.interactionId, choice: "ORDER_CARDS",
    orderedCardInstanceIds: spec.allowedCardInstanceIds as string[],
  } }, context);
  if (!result.ok) throw new Error(`Automatic elimination cleanup failed: ${result.error.code}`);
  return { state: result.state, events: result.events };
}
