import type { GameState, SeatState, TurnPhase, TurnState } from "../state/types.js";

export type TurnTransitionErrorCode =
  | "MATCH_NOT_PLAYING"
  | "NOT_YOUR_TURN"
  | "ILLEGAL_PHASE"
  | "HAND_OVER_LIMIT"
  | "INVALID_STATE";

export interface TurnTransitionError {
  code: TurnTransitionErrorCode;
  message: string;
}

export type TurnTransitionResult =
  | { ok: true; state: GameState }
  | { ok: false; error: TurnTransitionError };

type CurrentSeatResult =
  | { ok: true; seat: SeatState }
  | { ok: false; error: TurnTransitionError };

function reject(code: TurnTransitionErrorCode, message: string): TurnTransitionResult {
  return { ok: false, error: { code, message } };
}

function currentSeat(
  state: GameState,
  actorPlayerId: string,
  allowEliminated = false,
): CurrentSeatResult {
  if (state.status !== "playing") {
    return { ok: false, error: { code: "MATCH_NOT_PLAYING", message: "The match is not in play." } };
  }
  if (state.turn.currentPlayerId !== actorPlayerId) {
    return { ok: false, error: { code: "NOT_YOUR_TURN", message: "The actor is not the current player." } };
  }

  const matches = state.seats.filter((seat) => seat.public.playerId === state.turn.currentPlayerId);
  if (matches.length !== 1) {
    return { ok: false, error: { code: "INVALID_STATE", message: "The current player must identify exactly one seat." } };
  }

  const [match] = matches;
  if (!allowEliminated && match!.public.eliminated) {
    return { ok: false, error: { code: "INVALID_STATE", message: "The current player is eliminated." } };
  }
  return { ok: true, seat: match! };
}

function requirePhase(state: GameState, phase: TurnPhase): TurnTransitionError | undefined {
  if (state.turn.phase !== phase) {
    return {
      code: "ILLEGAL_PHASE",
      message: `This transition requires the '${phase}' phase; current phase is '${state.turn.phase}'.`,
    };
  }
  return undefined;
}

function requireResolutionIdle(state: GameState): TurnTransitionError | undefined {
  const resolution = state.resolution;
  if (
    resolution.effectQueue.length > 0 ||
    resolution.continuations.length > 0 ||
    resolution.pendingInteraction !== null ||
    resolution.pendingDeath !== null ||
    resolution.victoryCheckDeferredByEffectId !== null
  ) {
    return {
      code: "ILLEGAL_PHASE",
      message: "Turn progression is blocked while a resolution or interaction is pending.",
    };
  }
  return undefined;
}

function commitTurn(state: GameState, turn: TurnState): TurnTransitionResult {
  return {
    ok: true,
    state: {
      ...state,
      turn,
      // One successful reducer transition corresponds to one aggregate commit.
      // eventSeq is maintained by the command/event layer because this reducer emits no events.
      version: state.version + 1,
    },
  };
}

function nextLivingSeat(state: GameState, currentPlayerId: string): SeatState | undefined {
  const orderedSeats = [...state.seats].sort((left, right) => left.public.seatIndex - right.public.seatIndex);
  const currentIndex = orderedSeats.findIndex((seat) => seat.public.playerId === currentPlayerId);
  if (currentIndex < 0 || orderedSeats.filter((seat) => seat.public.playerId === currentPlayerId).length !== 1) {
    return undefined;
  }

  for (let offset = 1; offset <= orderedSeats.length; offset += 1) {
    const candidate = orderedSeats[(currentIndex + offset) % orderedSeats.length]!;
    if (!candidate.public.eliminated) return candidate;
  }
  return undefined;
}

function beginNextTurn(state: GameState, currentPlayerId: string): TurnTransitionResult {
  const nextSeat = nextLivingSeat(state, currentPlayerId);
  if (!nextSeat) {
    return reject("INVALID_STATE", "A playing match must have at least one living seat.");
  }

  return commitTurn(state, {
    ...state.turn,
    currentPlayerId: nextSeat.public.playerId,
    phase: "start",
    bangCardPlaysThisTurn: 0,
    turnNumber: state.turn.turnNumber + 1,
  });
}

/**
 * Called after the start-effect layer has resolved Dynamite and then Jail.
 * The caller owns those effects and must use skipTurnAfterStartResolution if
 * the resolved Jail result (or another handled start outcome) skips the turn.
 */
export function completeStartEffects(state: GameState, actorPlayerId: string): TurnTransitionResult {
  const seat = currentSeat(state, actorPlayerId);
  if (!seat.ok) return { ok: false, error: seat.error };
  const phaseError = requirePhase(state, "start");
  if (phaseError) return { ok: false, error: phaseError };
  const resolutionError = requireResolutionIdle(state);
  if (resolutionError) return { ok: false, error: resolutionError };

  return commitTurn(state, { ...state.turn, phase: "draw" });
}

/** Called after the caller has completed the required draw procedure. */
export function completeDraw(state: GameState, actorPlayerId: string): TurnTransitionResult {
  const seat = currentSeat(state, actorPlayerId);
  if (!seat.ok) return { ok: false, error: seat.error };
  const phaseError = requirePhase(state, "draw");
  if (phaseError) return { ok: false, error: phaseError };
  const resolutionError = requireResolutionIdle(state);
  if (resolutionError) return { ok: false, error: resolutionError };

  return commitTurn(state, { ...state.turn, phase: "play" });
}

/**
 * Implements the END_TURN rule from protocol v1. The payload remains `{}`;
 * the authenticated actor is supplied separately by the command handler.
 */
export function endTurn(state: GameState, actorPlayerId: string): TurnTransitionResult {
  const current = currentSeat(state, actorPlayerId);
  if (!current.ok) return { ok: false, error: current.error };
  const phaseError = requirePhase(state, "play");
  if (phaseError) return { ok: false, error: phaseError };
  const resolutionError = requireResolutionIdle(state);
  if (resolutionError) return { ok: false, error: resolutionError };

  if (current.seat.private.handCardInstanceIds.length > current.seat.public.hp) {
    return commitTurn(state, { ...state.turn, phase: "discard" });
  }
  return beginNextTurn(state, actorPlayerId);
}

/** Called after the caller has applied the chosen discard order. */
export function completeDiscard(state: GameState, actorPlayerId: string): TurnTransitionResult {
  const current = currentSeat(state, actorPlayerId);
  if (!current.ok) return { ok: false, error: current.error };
  const phaseError = requirePhase(state, "discard");
  if (phaseError) return { ok: false, error: phaseError };
  const resolutionError = requireResolutionIdle(state);
  if (resolutionError) return { ok: false, error: resolutionError };

  if (current.seat.private.handCardInstanceIds.length > current.seat.public.hp) {
    return reject("HAND_OVER_LIMIT", "The hand must be at or below current HP before the next turn.");
  }
  return beginNextTurn(state, actorPlayerId);
}

/**
 * Called by the start-effect resolver after it has determined the current turn
 * is skipped. This reducer does not inspect Dynamite, Jail, or their judgments.
 */
export function skipTurnAfterStartResolution(state: GameState): TurnTransitionResult {
  if (state.status !== "playing") {
    return reject("MATCH_NOT_PLAYING", "The match is not in play.");
  }
  const phaseError = requirePhase(state, "start");
  if (phaseError) return { ok: false, error: phaseError };
  const resolutionError = requireResolutionIdle(state);
  if (resolutionError) return { ok: false, error: resolutionError };

  const currentId = state.turn.currentPlayerId;
  const matches = state.seats.filter((seat) => seat.public.playerId === currentId);
  if (matches.length !== 1) {
    return reject("INVALID_STATE", "The current player must identify exactly one seat.");
  }
  return beginNextTurn(state, currentId);
}
