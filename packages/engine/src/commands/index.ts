import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { MatchCommand, RespondPayload } from "../../../contracts/src/index.js";
import type { EffectEventDraft, DeepReadonly } from "../effects/api.js";
import { checkPlayCardLegality, type PlayCardLegalityInput } from "../rules/legality.js";
import { completeDiscard, endTurn } from "../turn/reducer.js";
import {
  beginDiscardOrder,
  beginEffectResolution,
  completeEffectStep,
  finishEffectResolution,
  submitDeathRescueResponse,
  submitDiscardOrder,
  submitInteractionResponse,
  type InteractionResponseProgress,
  type ResolutionErrorCode,
} from "../resolution/index.js";
import type { RandomSource } from "../random/shuffle.js";
import type { GameState, JsonValue, PendingInteraction, SeatState } from "../state/types.js";
import type { PlayCardLegalityErrorCode } from "../rules/legality.js";
import type { TurnTransitionErrorCode } from "../turn/reducer.js";

/** The protocol DTO stripped of server-owned actor, version, and idempotency fields. */
export type EngineCommand = MatchCommand extends infer Command
  ? Command extends { type: infer Type extends string; payload: infer Payload }
    ? { type: Type; payload: Payload }
    : never
  : never;

export type PlayCardCommand = Extract<EngineCommand, { type: "PLAY_CARD" }>;
export type RespondCommand = Extract<EngineCommand, { type: "RESPOND" }>;
export type UseAbilityCommand = Extract<EngineCommand, { type: "USE_ABILITY" }>;

export type EngineCommandErrorCode =
  | PlayCardLegalityErrorCode
  | TurnTransitionErrorCode
  | ResolutionErrorCode
  | "INVALID_CARD_CONVERSION"
  | "ABILITY_NOT_AVAILABLE"
  | "INVALID_ABILITY_COST"
  | "INTERACTION_METADATA_REQUIRED"
  | "COMMAND_EXECUTOR_UNAVAILABLE";

export interface EngineCommandError {
  code: EngineCommandErrorCode;
  message: string;
}

export interface CommandExecutionOutput {
  /** A new candidate state. The command boundary sets the single commit version. */
  state: GameState;
  /** Ordered engine event drafts; event sequence and timestamps belong to the server boundary. */
  events: readonly EffectEventDraft[];
  value: JsonValue;
}

export type CommandExecutionResult =
  | { ok: true; output: CommandExecutionOutput }
  | { ok: false; error: EngineCommandError };

export interface PlayCardExecutionInput {
  readonly state: DeepReadonly<GameState>;
  readonly actorPlayerId: string;
  readonly command: PlayCardCommand;
  /** The effective catalog type after the supported Calamity conversion is checked. */
  readonly cardTypeId: string;
  readonly random: RandomSource;
}

export interface AbilityExecutionInput {
  readonly state: DeepReadonly<GameState>;
  readonly actorPlayerId: string;
  readonly command: UseAbilityCommand;
  readonly random: RandomSource;
}

export interface CompletedInteractionExecutionInput {
  /** State after T12 has persisted the completed response in its continuation frame. */
  readonly state: DeepReadonly<GameState>;
  readonly actorPlayerId: string;
  readonly command: RespondCommand;
  readonly interactionKind: string;
  readonly progress: InteractionResponseProgress;
  readonly random: RandomSource;
}

/**
 * T14 owns command validation and routing. Card/character effect state changes
 * are supplied by the later static effect registry; they receive read-only
 * state and return a candidate state plus event drafts.
 */
export interface CommandExecutionHandlers {
  /** Collect an independent tablewide response without advancing another player's effect. */
  tablewideRespond?: (input: { state: GameState; actorPlayerId: string; command: RespondCommand }) => CommandExecutionResult | null;
  playCard?: (input: PlayCardExecutionInput) => CommandExecutionResult;
  useAbility?: (input: AbilityExecutionInput) => CommandExecutionResult;
  /** Called only after T12 completes the current interaction cursor. */
  resumeInteraction?: (input: CompletedInteractionExecutionInput) => CommandExecutionResult;
}

export interface ApplyMatchCommandContext {
  /** Every random branch used by an effect must consume this prepared source. */
  random: RandomSource;
  /** Server-prepared identity metadata for a turn-end discard prompt, if needed. */
  interaction?: { interactionId: string; createdAt: string };
  handlers?: CommandExecutionHandlers;
}

export type EngineCommandValue =
  | { kind: "turn_transition"; currentPlayerId: string; phase: GameState["turn"]["phase"]; interactionId?: string }
  | { kind: "play_card"; cardTypeId: string; effectResult: JsonValue }
  | { kind: "use_ability"; abilityId: string; effectResult: JsonValue }
  | {
      kind: "response";
      interactionKind: string;
      completed: boolean;
      cursor: number;
      nextActorPlayerId: string | null;
      responseCount: number;
      effectResumed: boolean;
      effectResult?: JsonValue;
    };

export type ApplyMatchCommandResult =
  | { ok: true; state: GameState; events: readonly EffectEventDraft[]; value: EngineCommandValue }
  | { ok: false; error: EngineCommandError };

function failure(code: EngineCommandErrorCode, message: string): ApplyMatchCommandResult {
  return { ok: false, error: { code, message } };
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function resolutionIsIdle(state: GameState): boolean {
  return state.resolution.effectQueue.length === 0 &&
    state.resolution.continuations.length === 0 &&
    state.resolution.pendingInteraction === null &&
    state.resolution.pendingDeath === null &&
    state.resolution.victoryCheckDeferredByEffectId === null;
}

function commit(
  previous: GameState,
  next: GameState,
  events: readonly EffectEventDraft[],
  value: EngineCommandValue,
): ApplyMatchCommandResult {
  return {
    ok: true,
    state: {
      ...next,
      // Reducers/effect handlers may perform several internal pure steps for a
      // single client command; one outer command is one aggregate version.
      version: previous.version + 1,
      // The server assigns eventSeq while persisting the returned event drafts.
      eventSeq: previous.eventSeq,
    },
    events: [...events],
    value,
  };
}

function asCommandFailure(error: { code: string; message: string }): ApplyMatchCommandResult {
  return failure(error.code as EngineCommandErrorCode, error.message);
}

function cardLegalityInput(actorPlayerId: string, command: PlayCardCommand): PlayCardLegalityInput {
  const payload = command.payload;
  return {
    actorPlayerId,
    cardInstanceId: payload.cardInstanceId,
    ...(payload.targetPlayerId === undefined ? {} : { targetPlayerId: payload.targetPlayerId }),
    ...(payload.targetZone === undefined ? {} : { targetZone: payload.targetZone }),
    ...(payload.targetCardInstanceId === undefined ? {} : { targetCardInstanceId: payload.targetCardInstanceId }),
  };
}

/** Pure card legality/conversion validation shared with action projection. */
export function validatePlayCard(
  state: GameState,
  actorPlayerId: string,
  command: PlayCardCommand,
): { ok: true; cardTypeId: string } | { ok: false; error: { code: EngineCommandErrorCode; message: string } } {
  const input = cardLegalityInput(actorPlayerId, command);
  const ordinary = checkPlayCardLegality(state, input);
  const requestedType = command.payload.asCardType;

  if (requestedType === undefined) {
    return ordinary.ok ? ordinary : { ok: false, error: ordinary.error };
  }

  const card = state.zones.cardsByInstanceId[command.payload.cardInstanceId];
  const physical = card && BASE_PHYSICAL_CARDS.find((definition) => definition.definitionId === card.cardDefinitionId);
  if (physical?.typeId === "missed" && requestedType === "bang") {
    const actor = uniqueSeat(state, actorPlayerId);
    if (actor?.public.characterId !== "calamity_janet") {
      return ordinary.ok ? {
        ok: false,
        error: { code: "INVALID_CARD_CONVERSION", message: "Only Calamity Janet may use a Missed! card as BANG!." },
      } : { ok: false, error: ordinary.error };
    }
    const bangDefinition = BASE_PHYSICAL_CARDS.find((definition) => definition.typeId === "bang");
    if (!card || !bangDefinition) {
      return { ok: false, error: { code: "INVALID_STATE", message: "The converted card must resolve to a catalog BANG! definition." } };
    }

    // T11 currently accepts physical card types only. Validate the converted
    // type against a private validation copy without changing the real card.
    const converted: GameState = {
      ...state,
      zones: {
        ...state.zones,
        cardsByInstanceId: {
          ...state.zones.cardsByInstanceId,
          [card.cardInstanceId]: { ...card, cardDefinitionId: bangDefinition.definitionId },
        },
      },
    };
    const checked = checkPlayCardLegality(converted, input);
    return checked.ok ? checked : { ok: false, error: checked.error };
  }

  if (!ordinary.ok) return { ok: false, error: ordinary.error };
  return {
    ok: false,
    error: {
      code: "INVALID_CARD_CONVERSION",
      message: `The requested '${requestedType}' conversion is not allowed for this physical card in PLAY_CARD.`,
    },
  };
}

/** Pure ability validation shared by execution and action projection. */
export function validateAbility(
  state: GameState,
  actorPlayerId: string,
  command: UseAbilityCommand,
): EngineCommandError | undefined {
  if (state.status !== "playing") {
    return { code: "MATCH_NOT_PLAYING", message: "The match is not in play." };
  }
  if (state.turn.currentPlayerId !== actorPlayerId) {
    return { code: "NOT_YOUR_TURN", message: "The actor is not the current player." };
  }
  const actor = uniqueSeat(state, actorPlayerId);
  if (!actor) return { code: "INVALID_STATE", message: "The actor must identify exactly one seat." };
  if (actor.public.eliminated) return { code: "INVALID_STATE", message: "An eliminated player cannot use an ability." };
  if (state.turn.phase !== "play") {
    return { code: "ILLEGAL_PHASE", message: "Sid Ketchum's ability is available only during the play phase." };
  }
  if (!resolutionIsIdle(state)) {
    return { code: "RESOLUTION_PENDING", message: "Finish the current effect or interaction before starting an ability." };
  }
  if (command.payload.abilityId !== "sid-ketchum" || actor.public.characterId !== "sid_ketchum") {
    return { code: "ABILITY_NOT_AVAILABLE", message: "Only Sid Ketchum may use the sid-ketchum ability." };
  }
  const cardIds = command.payload.cardInstanceIds;
  if (cardIds.length !== 2 || cardIds[0] === cardIds[1] ||
      cardIds.some((cardInstanceId) => !actor.private.handCardInstanceIds.includes(cardInstanceId))) {
    return { code: "INVALID_ABILITY_COST", message: "Sid Ketchum must discard two distinct cards from their own hand." };
  }
  return undefined;
}

function responsePayload(payload: RespondPayload): { [key: string]: JsonValue } {
  const result: { [key: string]: JsonValue } = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === "interactionId" || key === "choice") continue;
    result[key] = value as JsonValue;
  }
  return result;
}

function submitResponse(
  state: GameState,
  actorPlayerId: string,
  command: RespondCommand,
): { ok: true; state: GameState; interactionKind: string; progress: InteractionResponseProgress }
  | { ok: false; error: { code: string; message: string } } {
  const pending = state.resolution.pendingInteraction;
  if (!pending) {
    return { ok: false, error: { code: "NO_PENDING_INTERACTION", message: "There is no interaction awaiting a response." } };
  }
  const { interactionId, choice } = command.payload;
  const payload = responsePayload(command.payload);

  if (pending.kind === "DISCARDS_ORDER") {
    if (choice !== "ORDER_CARDS" || !("orderedCardInstanceIds" in command.payload)) {
      return { ok: false, error: { code: "INVALID_CHOICE", message: "A discard-order response requires ORDER_CARDS and orderedCardInstanceIds." } };
    }
    const submitted = submitDiscardOrder(state, {
      interactionId,
      actorPlayerId,
      choice,
      orderedCardInstanceIds: command.payload.orderedCardInstanceIds,
    });
    if (!submitted.ok) return submitted;
    return {
      ok: true,
      state: submitted.state,
      interactionKind: pending.kind,
      progress: { completed: true, cursor: 1, nextActorPlayerId: null, responseCount: 1 },
    };
  }

  if (choice === "ORDER_CARDS") {
    return { ok: false, error: { code: "INVALID_CHOICE", message: "ORDER_CARDS is valid only for a DISCARDS_ORDER interaction." } };
  }

  const input = { interactionId, actorPlayerId, choice, payload };
  const submitted = pending.kind === "DEATH_RESCUE"
    ? submitDeathRescueResponse(state, input)
    : submitInteractionResponse(state, input);
  if (!submitted.ok) return submitted;
  return {
    ok: true,
    state: submitted.state,
    interactionKind: pending.kind,
    progress: submitted.value,
  };
}

function beginTurnHandLimitDiscard(
  state: GameState,
  actorPlayerId: string,
  interaction: { interactionId: string; createdAt: string } | undefined,
): { ok: true; state: GameState; interactionId: string; requiredCount: number }
  | { ok: false; error: { code: string; message: string } } {
  if (!interaction || typeof interaction.interactionId !== "string" || interaction.interactionId.trim() === "" ||
      typeof interaction.createdAt !== "string" || interaction.createdAt.trim() === "") {
    return {
      ok: false,
      error: { code: "INTERACTION_METADATA_REQUIRED", message: "END_TURN needs server-prepared interactionId and createdAt when the active hand exceeds HP." },
    };
  }
  const actor = uniqueSeat(state, actorPlayerId);
  if (!actor) return { ok: false, error: { code: "INVALID_STATE", message: "The discard owner must identify exactly one seat." } };
  const requiredCount = actor.private.handCardInstanceIds.length - actor.public.hp;
  if (state.turn.phase !== "discard" || requiredCount < 1) {
    return { ok: false, error: { code: "INVALID_DISCARD_ORDER", message: "A turn hand-limit prompt requires an active discard phase with a positive hand excess." } };
  }

  const effectId = `turn-hand-limit:${interaction.interactionId}`;
  const frameId = `${effectId}:frame`;
  const started = beginEffectResolution(state, {
    steps: [{
      effectId,
      kind: "APPLY_TURN_HAND_LIMIT",
      sourcePlayerId: actorPlayerId,
      targetPlayerId: actorPlayerId,
      sourceCardInstanceId: null,
      payload: { reason: "turn_hand_limit", requiredCount },
    }],
    continuation: {
      frameId,
      kind: "TURN_HAND_LIMIT",
      sourcePlayerId: actorPlayerId,
      sourceCardInstanceId: null,
      payload: { effectId, actorPlayerId, requiredCount },
    },
  });
  if (!started.ok) return started;

  const opened = beginDiscardOrder(started.state, {
    interactionId: interaction.interactionId,
    playerId: actorPlayerId,
    cardInstanceIds: [...actor.private.handCardInstanceIds],
    requiredCount,
    reason: "turn_hand_limit",
    context: {},
    resumeFrameId: frameId,
    createdAt: interaction.createdAt,
  });
  if (!opened.ok) return opened;
  return { ok: true, state: opened.state, interactionId: interaction.interactionId, requiredCount };
}

function completeTurnHandLimitDiscard(
  state: GameState,
  actorPlayerId: string,
  command: RespondCommand,
  pending: PendingInteraction,
  responseState: GameState,
): { ok: true; state: GameState } | { ok: false; error: { code: string; message: string } } {
  const spec = pending.context.discardOrder;
  if (!spec || typeof spec !== "object" || Array.isArray(spec) ||
      spec.reason !== "turn_hand_limit" || !Array.isArray(spec.allowedCardInstanceIds) ||
      !Number.isInteger(spec.requiredCount)) {
    return { ok: false, error: { code: "INVALID_STATE", message: "The saved turn hand-limit discard specification is malformed." } };
  }
  if (command.payload.choice !== "ORDER_CARDS") {
    return { ok: false, error: { code: "INVALID_CHOICE", message: "A turn hand-limit prompt requires ORDER_CARDS." } };
  }
  const actor = uniqueSeat(responseState, actorPlayerId);
  if (!actor || actor.public.eliminated || responseState.turn.currentPlayerId !== actorPlayerId || responseState.turn.phase !== "discard") {
    return { ok: false, error: { code: "INVALID_STATE", message: "The saved hand-limit owner must remain the active player in discard phase." } };
  }
  const requiredCount = actor.private.handCardInstanceIds.length - actor.public.hp;
  const orderedCardInstanceIds = command.payload.orderedCardInstanceIds;
  const allowed = spec.allowedCardInstanceIds;
  if (!Number.isInteger(spec.requiredCount) || spec.requiredCount !== requiredCount || requiredCount < 1 ||
      !allowed.every((id) => typeof id === "string" && actor.private.handCardInstanceIds.includes(id)) ||
      allowed.length !== actor.private.handCardInstanceIds.length ||
      actor.private.handCardInstanceIds.some((id) => !allowed.includes(id)) ||
      orderedCardInstanceIds.length !== requiredCount ||
      orderedCardInstanceIds.some((id) => !actor.private.handCardInstanceIds.includes(id))) {
    return { ok: false, error: { code: "INVALID_DISCARD_ORDER", message: "The saved order must discard the exact current hand excess from the active player's hand." } };
  }

  const frameId = pending.resumeFrameId;
  const frames = responseState.resolution.continuations.filter((frame) => frame.frameId === frameId);
  const frame = frames.length === 1 ? frames[0] : undefined;
  const step = responseState.resolution.effectQueue[0];
  if (frameId === null || !frame || frame.kind !== "TURN_HAND_LIMIT" || frame.sourcePlayerId !== actorPlayerId ||
      frame.payload.actorPlayerId !== actorPlayerId || frame.payload.requiredCount !== requiredCount ||
      typeof frame.payload.effectId !== "string" || frame.payload.effectId.trim() === "" ||
      !step || step.effectId !== frame.payload.effectId || step.kind !== "APPLY_TURN_HAND_LIMIT" ||
      step.sourcePlayerId !== actorPlayerId || step.targetPlayerId !== actorPlayerId ||
      step.payload.reason !== "turn_hand_limit" || step.payload.requiredCount !== requiredCount ||
      responseState.resolution.effectQueue.length !== 1 || responseState.resolution.pendingInteraction !== null ||
      responseState.resolution.pendingDeath !== null) {
    return { ok: false, error: { code: "INVALID_STATE", message: "The saved turn hand-limit effect frame is missing or inconsistent." } };
  }
  const effectId = frame.payload.effectId as string;

  const discarded = new Set(orderedCardInstanceIds);
  const moved: GameState = {
    ...responseState,
    seats: responseState.seats.map((seat) => seat.public.playerId === actorPlayerId
      ? { ...seat, private: { ...seat.private, handCardInstanceIds: seat.private.handCardInstanceIds.filter((id) => !discarded.has(id)) } }
      : seat),
    zones: {
      ...responseState.zones,
      // T12's ordering convention is first discarded first, so the final ID is pile top.
      discardPileCardInstanceIds: [...responseState.zones.discardPileCardInstanceIds, ...orderedCardInstanceIds],
    },
  };
  const stepCompleted = completeEffectStep(moved, step);
  if (!stepCompleted.ok) return stepCompleted;
  const frameCompleted = finishEffectResolution(stepCompleted.state, effectId, frameId);
  if (!frameCompleted.ok) return frameCompleted;
  const turnCompleted = completeDiscard(frameCompleted.state, actorPlayerId);
  if (!turnCompleted.ok) return turnCompleted;
  return { ok: true, state: turnCompleted.state };
}

/**
 * Validates and applies one match-domain command. Authentication, expected
 * version checks, command receipts, persistence, timestamps, and eventSeq are
 * intentionally handled by the server command boundary.
 */
export function applyMatchCommand(
  state: GameState,
  actorPlayerId: string,
  command: EngineCommand,
  context: ApplyMatchCommandContext,
): ApplyMatchCommandResult {
  if (state.status !== "playing") {
    return failure("MATCH_NOT_PLAYING", "The match is not in play.");
  }

  if (command.type === "END_TURN") {
    const reduced = endTurn(state, actorPlayerId);
    if (!reduced.ok) return asCommandFailure(reduced.error);
    if (reduced.state.turn.phase === "discard") {
      const opened = beginTurnHandLimitDiscard(reduced.state, actorPlayerId, context.interaction);
      if (!opened.ok) return asCommandFailure(opened.error);
      return commit(state, opened.state, [], {
        kind: "turn_transition",
        currentPlayerId: opened.state.turn.currentPlayerId,
        phase: opened.state.turn.phase,
        interactionId: opened.interactionId,
      });
    }
    return commit(state, reduced.state, [], {
      kind: "turn_transition",
      currentPlayerId: reduced.state.turn.currentPlayerId,
      phase: reduced.state.turn.phase,
    });
  }

  if (command.type === "PLAY_CARD") {
    const legal = validatePlayCard(state, actorPlayerId, command);
    if (!legal.ok) return failure(legal.error.code, legal.error.message);
    const handler = context.handlers?.playCard;
    if (!handler) return failure("COMMAND_EXECUTOR_UNAVAILABLE", "No registered card-effect executor is available for this legal card command.");
    const executed = handler({
      state: state as DeepReadonly<GameState>,
      actorPlayerId,
      command,
      cardTypeId: legal.cardTypeId,
      random: context.random,
    });
    if (!executed.ok) return executed;
    const nextState = legal.cardTypeId === "bang"
      ? {
          ...executed.output.state,
          turn: {
            ...executed.output.state.turn,
            // Count only a successfully resolved normal BANG! play. Use the
            // pre-command value so effect handlers cannot double-count it.
            bangCardPlaysThisTurn: state.turn.bangCardPlaysThisTurn + 1,
          },
        }
      : executed.output.state;
    return commit(state, nextState, executed.output.events, {
      kind: "play_card",
      cardTypeId: legal.cardTypeId,
      effectResult: executed.output.value,
    });
  }

  if (command.type === "USE_ABILITY") {
    const issue = validateAbility(state, actorPlayerId, command);
    if (issue) return { ok: false, error: issue };
    const handler = context.handlers?.useAbility;
    if (!handler) return failure("COMMAND_EXECUTOR_UNAVAILABLE", "No registered character-ability executor is available for this legal ability command.");
    const executed = handler({
      state: state as DeepReadonly<GameState>,
      actorPlayerId,
      command,
      random: context.random,
    });
    if (!executed.ok) return executed;
    return commit(state, executed.output.state, executed.output.events, {
      kind: "use_ability",
      abilityId: command.payload.abilityId,
      effectResult: executed.output.value,
    });
  }

  const earlyResponse = context.handlers?.tablewideRespond?.({ state, actorPlayerId, command });
  if (earlyResponse) {
    if (!earlyResponse.ok) return earlyResponse;
    return commit(state, earlyResponse.output.state, earlyResponse.output.events, {
      kind: "response", interactionKind: "TABLEWIDE_RESPONSE", completed: true, cursor: 0,
      nextActorPlayerId: null, responseCount: 1, effectResumed: false, effectResult: earlyResponse.output.value,
    });
  }
  const pendingBefore = state.resolution.pendingInteraction;
  const submitted = submitResponse(state, actorPlayerId, command);
  if (!submitted.ok) return asCommandFailure(submitted.error);
  if (!submitted.progress.completed) {
    return commit(state, submitted.state, [], {
      kind: "response",
      interactionKind: submitted.interactionKind,
      ...submitted.progress,
      effectResumed: false,
    });
  }

  if (submitted.interactionKind === "DISCARDS_ORDER" &&
      pendingBefore?.context.discardOrder !== undefined &&
      typeof pendingBefore.context.discardOrder === "object" &&
      pendingBefore.context.discardOrder !== null &&
      !Array.isArray(pendingBefore.context.discardOrder) &&
      pendingBefore.context.discardOrder.reason === "turn_hand_limit") {
    const completed = completeTurnHandLimitDiscard(state, actorPlayerId, command, pendingBefore, submitted.state);
    if (!completed.ok) return asCommandFailure(completed.error);
    return commit(state, completed.state, [], {
      kind: "response",
      interactionKind: submitted.interactionKind,
      ...submitted.progress,
      effectResumed: true,
      effectResult: {
        kind: "turn_transition",
        currentPlayerId: completed.state.turn.currentPlayerId,
        phase: completed.state.turn.phase,
      },
    });
  }

  const resume = context.handlers?.resumeInteraction;
  if (!resume) {
    return commit(state, submitted.state, [], {
      kind: "response",
      interactionKind: submitted.interactionKind,
      ...submitted.progress,
      effectResumed: false,
    });
  }
  const resumed = resume({
    state: submitted.state as DeepReadonly<GameState>,
    actorPlayerId,
    command,
    interactionKind: submitted.interactionKind,
    progress: submitted.progress,
    random: context.random,
  });
  if (!resumed.ok) return resumed;
  return commit(state, resumed.output.state, resumed.output.events, {
    kind: "response",
    interactionKind: submitted.interactionKind,
    ...submitted.progress,
    effectResumed: true,
    effectResult: resumed.output.value,
  });
}
