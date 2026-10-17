import { applyMatchCommand, type ApplyMatchCommandContext, type EngineCommand } from "../commands/index.js";
import type { EffectEventDraft } from "../effects/api.js";
import { earlyTablewideInteraction, stateMovementEvents } from "../effects/runtime/index.js";
import { advanceAfterCurrentPlayerElimination } from "../turn/reducer.js";
import type { GameState, PendingInteraction } from "../state/types.js";
import { eliminateForfeitAtBoundary } from "./index.js";

export function resolutionIsIdle(state: GameState): boolean {
  const r = state.resolution;
  return !r.pendingInteraction && !r.pendingDeath && !r.effectQueue.length && !r.continuations.length && !r.victoryCheckDeferredByEffectId;
}

/** Only answer the departed player's prompts; never choose for another participant. */
function departureResponse(pending: PendingInteraction): EngineCommand {
  const option = ["ACCEPT_ELIMINATION", "TAKE_HIT", "YIELD", "DRAW_FROM_PILE", "DRAW_PILE"].map(choice =>
    pending.options.find(option => option.choice === choice)).find(Boolean) ?? pending.options[0];
  if (!option) throw new Error("A departed player has no saved response option.");
  const payload = { ...option.payload, interactionId: pending.interactionId, choice: option.choice };
  if (option.choice === "ORDER_CARDS") {
    const spec = pending.context.discardOrder;
    if (!spec || typeof spec !== "object" || Array.isArray(spec) || !Array.isArray(spec.allowedCardInstanceIds) ||
        typeof spec.requiredCount !== "number") throw new Error("Departure discard context is malformed.");
    return { type: "RESPOND", payload: { interactionId: pending.interactionId, choice: "ORDER_CARDS",
      orderedCardInstanceIds: spec.allowedCardInstanceIds.slice(0, spec.requiredCount) as string[] } };
  }
  return { type: "RESPOND", payload } as EngineCommand;
}

/** Keeps the existing effect/death cursor valid, including simultaneous attacks and private draw prompts. */
export function settleForfeits(initial: GameState, context: ApplyMatchCommandContext): { state: GameState; events: EffectEventDraft[] } {
  let state = initial;
  const events: EffectEventDraft[] = [];
  for (let step = 0; step < 512; step++) {
    if (state.status !== "playing" && state.status !== "paused") return { state, events };
    const ids = state.forfeitedPlayerIds ?? [];
    const live = ids.filter(id => state.seats.some(seat => seat.public.playerId === id && !seat.public.eliminated));
    // Elimination cleanup can still belong to a departed, already eliminated player.
    const pending = state.resolution.pendingInteraction;
    const actor = pending?.actorPlayerIds.find(id => ids.includes(id));
    const earlyActor = live.find(id => earlyTablewideInteraction(state, id) !== null);
    const responder = actor ?? earlyActor;
    if (responder && state.status === "playing") {
      const prompt = actor ? pending! : earlyTablewideInteraction(state, responder)!;
      const applied = applyMatchCommand(state, responder, departureResponse(prompt), context);
      if (!applied.ok) throw new Error(`Departure response failed: ${applied.error.code}`);
      state = applied.state;
      events.push(...applied.events);
      continue;
    }
    if (!live.length || !resolutionIsIdle(state)) return { state, events };
    const id = live[0]!;
    const eliminated = eliminateForfeitAtBoundary(state, id);
    events.push(...stateMovementEvents(state, eliminated), { type: "PLAYER_ELIMINATED", actorPlayerId: id,
      payload: { playerId: id, sourcePlayerId: null, cause: "FORFEIT" } });
    state = eliminated;
    if (state.status === "completed") {
      events.push({ type: "MATCH_COMPLETED", actorPlayerId: null, payload: {
        winningFaction: state.outcome!.winningFaction, winningPlayerIds: state.outcome!.winningPlayerIds } });
      return { state, events };
    }
    if (state.status === "playing") {
      const advanced = advanceAfterCurrentPlayerElimination(state);
      if (!advanced.ok) throw new Error(advanced.error.message);
      state = advanced.state;
    }
  }
  throw new Error("Departure resolution exceeded its bounded loop.");
}
