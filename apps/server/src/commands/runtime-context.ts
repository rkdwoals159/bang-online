import { randomBytes, randomUUID } from "node:crypto";
import { createEffectCommandHandlers } from "../../../../packages/engine/src/effects/runtime/index.js";
import { createEffectRegistry } from "../../../../packages/engine/src/effects/registry.js";
import { withTurnStartEffects } from "../../../../packages/engine/src/turn/draw.js";
import { settleForfeits } from "../../../../packages/engine/src/endgame/forfeit.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";
import type { EffectEventDraft } from "../../../../packages/engine/src/effects/api.js";
import { advanceTurnPhases, createTurnAwareCommandHandlers } from "./turn-runtime.js";
import { hasAutomaticEliminationCleanup, hasUnavoidableElimination, settleEliminationCleanup, settleUnavoidableElimination } from "./elimination-cleanup.js";

export function prepareGameRuntime(matchId: string) {
  const random = { nextFloat: () => {
    let value = 0;
    for (const byte of Buffer.from(randomBytes(6).toString("base64url"), "base64url")) value = value * 256 + byte;
    return value / 0x1_0000_0000_0000;
  } };
  const nextInteractionIdentity = () => ({ interactionId: `interaction_${randomUUID()}`, createdAt: new Date().toISOString() });
  const runtimeOptions = withTurnStartEffects({ registry: createEffectRegistry(), nextInteractionIdentity });
  const runtime = { matchId, random, nextInteractionIdentity, runtimeOptions };
  const context = { random, interaction: nextInteractionIdentity(),
    handlers: createTurnAwareCommandHandlers(createEffectCommandHandlers(runtimeOptions), runtime) };
  return { ...context, continueTurnPhases(initial: GameState) {
    let state = initial;
    const events: EffectEventDraft[] = [];
    for (let transition = 0; transition < 64; transition++) {
      const settled = settleForfeits(state, context);
      events.push(...settled.events);
      const eliminated = settleUnavoidableElimination(settled.state, context);
      events.push(...eliminated.events);
      const cleaned = settleEliminationCleanup(eliminated.state, context);
      events.push(...cleaned.events);
      const advanced = advanceTurnPhases(cleaned.state, runtime);
      events.push(...advanced.events);
      state = advanced.state;
      const pendingActor = state.resolution.pendingInteraction?.actorPlayerIds.some(id => state.forfeitedPlayerIds?.includes(id));
      if (!pendingActor && !hasAutomaticEliminationCleanup(state) && !hasUnavoidableElimination(state)) return { state, events };
    }
    throw new Error("Automatic turn progression exceeded its bounded loop.");
  } };
}
