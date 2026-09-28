import type {
  CommandExecutionHandlers,
  CommandExecutionResult,
  CompletedInteractionExecutionInput,
  EngineCommandErrorCode,
} from "../../../../packages/engine/src/commands/index.js";
import type { EffectRuntimeOptions, InteractionIdentity } from "../../../../packages/engine/src/effects/runtime/index.js";
import type { RandomSource } from "../../../../packages/engine/src/random/shuffle.js";
import { executeTurnDraw, resolveTurnStart } from "../../../../packages/engine/src/turn/draw.js";
import { skipTurnAfterStartResolution } from "../../../../packages/engine/src/turn/reducer.js";
import type { EffectEventDraft } from "../../../../packages/engine/src/effects/api.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";

export interface ServerTurnRuntimeContext {
  readonly matchId: string;
  readonly random: RandomSource;
  readonly nextInteractionIdentity: () => InteractionIdentity;
  readonly runtimeOptions: EffectRuntimeOptions;
}

function resolutionIsIdle(state: GameState): boolean {
  const resolution = state.resolution;
  return resolution.effectQueue.length === 0 && resolution.continuations.length === 0 &&
    resolution.pendingInteraction === null && resolution.pendingDeath === null &&
    resolution.victoryCheckDeferredByEffectId === null;
}

function executeSavedTurnDraw(
  input: CompletedInteractionExecutionInput,
  runtime: ServerTurnRuntimeContext,
): CommandExecutionResult {
  const frames = input.state.resolution.continuations.filter((frame) => frame.kind === "TURN_DRAW");
  if (frames.length !== 1) {
    return {
      ok: false,
      error: { code: "INVALID_STATE", message: "The saved turn draw must identify exactly one continuation frame." },
    };
  }
  const frame = frames[0]!;
  const resumed = executeTurnDraw({
    state: input.state as GameState,
    actorPlayerId: input.actorPlayerId,
    random: input.random,
    nextInteractionIdentity: runtime.nextInteractionIdentity,
    continuationFrameId: frame.frameId,
  });
  if (!resumed.ok) {
    return {
      ok: false,
      error: { code: resumed.error.code as EngineCommandErrorCode, message: resumed.error.message },
    };
  }
  return {
    ok: true,
    output: {
      state: resumed.output.state,
      events: resumed.output.events,
      value: resumed.output.value,
    },
  };
}

/** T67 frames resume in T67; all other completed responses stay with T66. */
export function createTurnAwareCommandHandlers(
  effectHandlers: CommandExecutionHandlers,
  runtime: ServerTurnRuntimeContext,
): CommandExecutionHandlers {
  return {
    ...effectHandlers,
    resumeInteraction: (input) => {
      if (input.state.resolution.continuations.some((frame) => frame.kind === "TURN_DRAW")) {
        return executeSavedTurnDraw(input, runtime);
      }
      return effectHandlers.resumeInteraction?.(input) ?? {
        ok: false,
        error: {
          code: "COMMAND_EXECUTOR_UNAVAILABLE",
          message: "No registered effect continuation handler is available.",
        },
      };
    },
  };
}

/**
 * Finishes start effects and the T67 draw phase before the originating relay
 * command commits. The caller persists the returned state/events once.
 */
export function advanceTurnPhases(
  initialState: GameState,
  runtime: ServerTurnRuntimeContext,
): { readonly state: GameState; readonly events: readonly EffectEventDraft[] } {
  let state = initialState;
  const events: EffectEventDraft[] = [];

  for (let transition = 0; transition < 64; transition += 1) {
    if (state.status !== "playing" || state.turn.phase !== "start" || !resolutionIsIdle(state)) {
      return { state, events };
    }

    const currentActors = state.seats.filter((seat) => seat.public.playerId === state.turn.currentPlayerId);
    if (currentActors.length !== 1) throw new Error("Turn start must identify exactly one current seat.");
    const actor = currentActors[0]!;
    if (actor.public.eliminated || actor.public.hp <= 0) {
      const skipped = skipTurnAfterStartResolution(state);
      if (!skipped.ok) throw new Error(skipped.error.message);
      state = skipped.state;
      continue;
    }

    const frameBase = `${runtime.matchId}:turn:${state.turn.turnNumber}:${actor.public.playerId}`;
    const started = resolveTurnStart({
      state,
      actorPlayerId: actor.public.playerId,
      random: runtime.random,
      nextInteractionIdentity: runtime.nextInteractionIdentity,
      continuationFrameId: `${frameBase}:start`,
      runtimeOptions: runtime.runtimeOptions,
    });
    if (!started.ok) throw new Error(started.error.message);
    state = started.output.state;
    events.push(...started.output.events);

    if (state.status !== "playing" || !resolutionIsIdle(state)) return { state, events };
    if (state.turn.phase === "start") continue;
    if (state.turn.phase !== "draw") throw new Error("Turn start must enter draw, skip to another start, or pause for an interaction.");

    const drawn = executeTurnDraw({
      state,
      actorPlayerId: actor.public.playerId,
      random: runtime.random,
      nextInteractionIdentity: runtime.nextInteractionIdentity,
      continuationFrameId: `${frameBase}:draw`,
    });
    if (!drawn.ok) throw new Error(drawn.error.message);
    state = drawn.output.state;
    events.push(...drawn.output.events);

    if (state.status !== "playing" || !resolutionIsIdle(state)) return { state, events };
    if (state.turn.phase === "play") return { state, events };
    if (state.turn.phase === "start") continue;
    throw new Error("Turn draw must enter play, skip, or pause for an interaction.");
  }

  throw new Error("Turn start exceeded the bounded continuation count.");
}
