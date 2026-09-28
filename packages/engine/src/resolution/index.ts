import type {
  EffectStep,
  GameState,
  InteractionOption,
  JsonValue,
  PendingDeath,
  PendingInteraction,
  ResolutionFrame,
  ResolutionState,
  SeatState,
} from "../state/types.js";

const INTERACTION_CURSOR_KEY = "__resolutionCursor";
const INTERACTION_RESULTS_KEY = "__resolutionResults";

export type ResolutionErrorCode =
  | "MATCH_NOT_PLAYING"
  | "INVALID_STATE"
  | "RESOLUTION_ALREADY_ACTIVE"
  | "NO_PENDING_INTERACTION"
  | "WRONG_INTERACTION"
  | "WRONG_RESPONDER"
  | "INVALID_CHOICE"
  | "INVALID_DISCARD_ORDER"
  | "INVALID_DEATH_STAGE"
  | "FRAME_NOT_FOUND"
  | "EFFECT_STEP_MISMATCH";

export interface ResolutionError {
  code: ResolutionErrorCode;
  message: string;
}

export type ResolutionResult<T> =
  | { ok: true; state: GameState; value: T }
  | { ok: false; error: ResolutionError };

export type ReadonlyResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ResolutionError };

export interface EffectResolutionInput {
  steps: readonly EffectStep[];
  continuation: ResolutionFrame;
  /** The engine must defer victory until this effect's final step completes. */
  deferredVictoryCheckEffectId?: string;
}

export interface ClockwiseTargetStepsInput {
  effectId: string;
  kind: string;
  sourcePlayerId: string;
  sourceCardInstanceId: string | null;
  payload: { [key: string]: JsonValue };
}

export interface InteractionResponderPlan {
  playerId: string;
  options: readonly InteractionOption[];
}

export interface OpenInteractionInput {
  interactionId: string;
  kind: string;
  responders: readonly InteractionResponderPlan[];
  context: { [key: string]: JsonValue };
  resumeFrameId: string;
  createdAt: string;
}

export interface InteractionResponseInput {
  interactionId: string;
  actorPlayerId: string;
  choice: string;
  payload: { [key: string]: JsonValue };
}

export interface InteractionResponseProgress {
  completed: boolean;
  cursor: number;
  nextActorPlayerId: string | null;
  responseCount: number;
}

export interface BeginDeathRescueInput {
  victimPlayerId: string;
  sourcePlayerId: string | null;
  interactionId: string;
  options: readonly InteractionOption[];
  context: { [key: string]: JsonValue };
  resumeFrameId: string;
  createdAt: string;
}

export type DeathRescueOutcome = "survived" | "accept_elimination";

export type DiscardOrderReason = "turn_hand_limit" | "elimination_cleanup" | "effect_cleanup";

export interface BeginDiscardOrderInput {
  interactionId: string;
  playerId: string;
  cardInstanceIds: readonly string[];
  requiredCount: number;
  reason: DiscardOrderReason;
  context: { [key: string]: JsonValue };
  resumeFrameId: string;
  createdAt: string;
}

export interface SubmitDiscardOrderInput {
  interactionId: string;
  actorPlayerId: string;
  choice: string;
  orderedCardInstanceIds: readonly string[];
}

function failure<T = never>(code: ResolutionErrorCode, message: string): ResolutionResult<T> {
  return { ok: false, error: { code, message } };
}

function readonlyFailure<T = never>(code: ResolutionErrorCode, message: string): ReadonlyResult<T> {
  return { ok: false, error: { code, message } };
}

function commit<T>(state: GameState, resolution: ResolutionState, value: T): ResolutionResult<T> {
  return {
    ok: true,
    state: { ...state, resolution, version: state.version + 1 },
    value,
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;
  ancestors.add(value);

  const valid = Array.isArray(value)
    ? value.every((entry) => isJsonValue(entry, ancestors))
    : isPlainRecord(value) && Object.values(value).every((entry) => isJsonValue(entry, ancestors));

  ancestors.delete(value);
  return valid;
}

function cloneJsonValue<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneJsonValue(entry)) as T;
  if (isPlainRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry as JsonValue)]),
    ) as T;
  }
  return value;
}

function cloneJsonRecord(value: { [key: string]: JsonValue }): { [key: string]: JsonValue } {
  return cloneJsonValue(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasIdleResolution(state: GameState): boolean {
  const resolution = state.resolution;
  return (
    resolution.effectQueue.length === 0 &&
    resolution.continuations.length === 0 &&
    resolution.pendingInteraction === null &&
    resolution.pendingDeath === null &&
    resolution.victoryCheckDeferredByEffectId === null
  );
}

function frameIndex(state: GameState, frameId: string): number {
  const indices = state.resolution.continuations
    .map((frame, index) => (frame.frameId === frameId ? index : -1))
    .filter((index) => index >= 0);
  return indices.length === 1 ? indices[0]! : -1;
}

function frameExists(state: GameState, frameId: string): boolean {
  return frameIndex(state, frameId) >= 0;
}

function validateFrame(frame: ResolutionFrame): string | null {
  if (!isNonEmptyString(frame.frameId) || !isNonEmptyString(frame.kind)) return "Continuation frame needs an ID and kind.";
  if (frame.sourcePlayerId !== null && !isNonEmptyString(frame.sourcePlayerId)) return "Continuation source player ID is invalid.";
  if (frame.sourceCardInstanceId !== null && !isNonEmptyString(frame.sourceCardInstanceId)) return "Continuation source card ID is invalid.";
  if (!isPlainRecord(frame.payload) || !isJsonValue(frame.payload)) return "Continuation payload must be a JSON object.";
  return null;
}

function validateEffectStep(step: EffectStep): string | null {
  if (!isNonEmptyString(step.effectId) || !isNonEmptyString(step.kind)) return "Effect step needs an effect ID and kind.";
  if (step.sourcePlayerId !== null && !isNonEmptyString(step.sourcePlayerId)) return "Effect source player ID is invalid.";
  if (step.targetPlayerId !== null && !isNonEmptyString(step.targetPlayerId)) return "Effect target player ID is invalid.";
  if (step.sourceCardInstanceId !== null && !isNonEmptyString(step.sourceCardInstanceId)) return "Effect source card ID is invalid.";
  if (!isPlainRecord(step.payload) || !isJsonValue(step.payload)) return "Effect payload must be a JSON object.";
  return null;
}

function validateOption(option: InteractionOption): string | null {
  if (!isNonEmptyString(option.choice)) return "Interaction options need a choice name.";
  if (!isPlainRecord(option.payload) || !isJsonValue(option.payload)) return "Interaction option payload must be a JSON object.";
  return null;
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]!));
  }
  if (isPlainRecord(left) || isPlainRecord(right)) {
    if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonEqual(left[key] as JsonValue, right[key] as JsonValue),
    );
  }
  return false;
}

function findUniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function responderPlanIsValid(responders: readonly InteractionResponderPlan[]): string | null {
  if (responders.length === 0) return "An interaction needs at least one responder.";
  const seenPlayers = new Set<string>();
  for (const responder of responders) {
    if (!isNonEmptyString(responder.playerId) || seenPlayers.has(responder.playerId)) {
      return "Interaction responders must be unique player IDs.";
    }
    seenPlayers.add(responder.playerId);
    if (responder.options.length === 0) return "Each responder needs at least one allowed option.";
    for (let index = 0; index < responder.options.length; index += 1) {
      const option = responder.options[index]!;
      const issue = validateOption(option);
      if (issue) return issue;
      if (responder.options.slice(0, index).some((prior) => prior.choice === option.choice && jsonEqual(prior.payload, option.payload))) {
        return "A responder's options must not contain duplicates.";
      }
    }
  }
  return null;
}

interface SavedResponder {
  playerId: string;
  options: InteractionOption[];
}

interface SavedResponse {
  playerId: string;
  choice: string;
  payload: { [key: string]: JsonValue };
}

interface SavedCursor {
  cursor: number;
  responders: SavedResponder[];
  responses: SavedResponse[];
}

function createPendingInteraction(
  state: GameState,
  input: OpenInteractionInput,
): ResolutionResult<PendingInteraction> | { ok: false; error: ResolutionError } {
  if (!isNonEmptyString(input.interactionId) || !isNonEmptyString(input.kind) || !isNonEmptyString(input.createdAt)) {
    return failure("INVALID_STATE", "Interaction ID, kind, and caller-supplied createdAt are required.");
  }
  if (!isNonEmptyString(input.resumeFrameId) || !frameExists(state, input.resumeFrameId)) {
    return failure("FRAME_NOT_FOUND", "The interaction must name one saved continuation frame.");
  }
  if (!isPlainRecord(input.context) || !isJsonValue(input.context) || INTERACTION_CURSOR_KEY in input.context) {
    return failure("INVALID_STATE", "Interaction context must be JSON and must not use the reserved cursor key.");
  }
  const planIssue = responderPlanIsValid(input.responders);
  if (planIssue) return failure("INVALID_STATE", planIssue);
  for (const responder of input.responders) {
    if (!findUniqueSeat(state, responder.playerId)) {
      return failure("INVALID_STATE", `Responder '${responder.playerId}' must identify exactly one seat.`);
    }
  }

  const responders = input.responders.map((responder) => ({
    playerId: responder.playerId,
    options: responder.options.map((option) => ({
      choice: option.choice,
      payload: cloneJsonRecord(option.payload),
    })),
  }));
  const firstResponder = responders[0]!;
  const cursor: SavedCursor = { cursor: 0, responders, responses: [] };
  const context = cloneJsonRecord(input.context);
  context[INTERACTION_CURSOR_KEY] = cursor as unknown as JsonValue;

  return {
    ok: true,
    state,
    value: {
      interactionId: input.interactionId,
      kind: input.kind,
      actorPlayerIds: [firstResponder.playerId],
      options: firstResponder.options,
      context,
      resumeFrameId: input.resumeFrameId,
      createdAt: input.createdAt,
    },
  };
}

function readSavedCursor(pending: PendingInteraction): SavedCursor | undefined {
  const raw = pending.context[INTERACTION_CURSOR_KEY];
  if (!isPlainRecord(raw) || !Array.isArray(raw.responders) || !Array.isArray(raw.responses)) return undefined;
  if (!Number.isInteger(raw.cursor) || (raw.cursor as number) < 0) return undefined;
  const responders = raw.responders as unknown as SavedResponder[];
  const responses = raw.responses as unknown as SavedResponse[];
  if ((raw.cursor as number) >= responders.length || responders.length === 0) return undefined;
  if (responses.length !== (raw.cursor as number)) return undefined;
  const current = responders[raw.cursor as number];
  if (!current || pending.actorPlayerIds.length !== 1 || pending.actorPlayerIds[0] !== current.playerId) return undefined;
  if (!jsonEqual(pending.options as unknown as JsonValue, current.options as unknown as JsonValue)) return undefined;
  return { cursor: raw.cursor as number, responders, responses };
}

function visibleContext(context: { [key: string]: JsonValue }): { [key: string]: JsonValue } {
  const result = cloneJsonRecord(context);
  delete result[INTERACTION_CURSOR_KEY];
  return result;
}

function appendCompletedInteraction(
  state: GameState,
  pending: PendingInteraction,
  responses: SavedResponse[],
): ResolutionResult<ResolutionFrame> | { ok: false; error: ResolutionError } {
  const index = frameIndex(state, pending.resumeFrameId ?? "");
  if (index < 0) return failure("FRAME_NOT_FOUND", "The saved continuation frame is missing or ambiguous.");
  const frame = state.resolution.continuations[index]!;
  const previous = frame.payload[INTERACTION_RESULTS_KEY];
  if (previous !== undefined && !Array.isArray(previous)) {
    return failure("INVALID_STATE", "Continuation interaction results are not a JSON array.");
  }
  const result = {
    interactionId: pending.interactionId,
    kind: pending.kind,
    context: visibleContext(pending.context),
    responses: responses.map((response) => ({
      playerId: response.playerId,
      choice: response.choice,
      payload: cloneJsonRecord(response.payload),
    })),
  } as unknown as JsonValue;
  const nextFrame: ResolutionFrame = {
    ...frame,
    payload: {
      ...frame.payload,
      [INTERACTION_RESULTS_KEY]: [...(previous as JsonValue[] | undefined ?? []).map((value) => cloneJsonValue(value)), result],
    },
  };
  const nextFrames = [...state.resolution.continuations];
  nextFrames[index] = nextFrame;
  return {
    ok: true,
    state: { ...state, resolution: { ...state.resolution, continuations: nextFrames } },
    value: nextFrame,
  };
}

function setInteractionResponse(
  state: GameState,
  input: InteractionResponseInput,
  options: { requireKind?: string; allowChoice?: readonly string[] } = {},
): ResolutionResult<InteractionResponseProgress> {
  const pending = state.resolution.pendingInteraction;
  if (!pending) return failure("NO_PENDING_INTERACTION", "There is no interaction awaiting a response.");
  if (pending.interactionId !== input.interactionId) {
    return failure("WRONG_INTERACTION", "The response refers to a stale interaction ID.");
  }
  if (options.requireKind && pending.kind !== options.requireKind) {
    return failure("INVALID_CHOICE", `This response requires a '${options.requireKind}' interaction.`);
  }
  if (pending.actorPlayerIds.length !== 1 || pending.actorPlayerIds[0] !== input.actorPlayerId) {
    return failure("WRONG_RESPONDER", "Only the currently authorized responder may answer this interaction.");
  }
  if (!isNonEmptyString(input.choice) || !isPlainRecord(input.payload) || !isJsonValue(input.payload)) {
    return failure("INVALID_CHOICE", "A response needs a choice and a JSON object payload.");
  }
  if (options.allowChoice && !options.allowChoice.includes(input.choice)) {
    return failure("INVALID_CHOICE", "That choice is not allowed for this interaction kind.");
  }

  const saved = readSavedCursor(pending);
  if (!saved) return failure("INVALID_STATE", "The serialized response cursor does not match the pending actor/options.");
  const responder = saved.responders[saved.cursor]!;
  const selected = responder.options.find(
    (option) => option.choice === input.choice && jsonEqual(option.payload, input.payload as JsonValue),
  );
  if (!selected) return failure("INVALID_CHOICE", "The choice and payload are not among this responder's saved options.");

  const responses = [
    ...saved.responses,
    {
      playerId: input.actorPlayerId,
      choice: selected.choice,
      payload: cloneJsonRecord(input.payload),
    },
  ];
  const nextCursor = saved.cursor + 1;
  if (nextCursor < saved.responders.length) {
    const nextResponder = saved.responders[nextCursor]!;
    const nextPending: PendingInteraction = {
      ...pending,
      actorPlayerIds: [nextResponder.playerId],
      options: nextResponder.options,
      context: {
        ...visibleContext(pending.context),
        [INTERACTION_CURSOR_KEY]: {
          cursor: nextCursor,
          responders: saved.responders,
          responses,
        } as unknown as JsonValue,
      },
    };
    const nextResolution = { ...state.resolution, pendingInteraction: nextPending };
    return commit(state, nextResolution, {
      completed: false,
      cursor: nextCursor,
      nextActorPlayerId: nextResponder.playerId,
      responseCount: responses.length,
    });
  }

  const persisted = appendCompletedInteraction(state, pending, responses);
  if (!persisted.ok) return persisted;
  const nextResolution: ResolutionState = {
    ...state.resolution,
    continuations: persisted.state.resolution.continuations,
    pendingInteraction: null,
  };
  return commit(state, nextResolution, {
    completed: true,
    cursor: nextCursor,
    nextActorPlayerId: null,
    responseCount: responses.length,
  });
}

function seatOwnsCard(seat: SeatState, cardInstanceId: string): boolean {
  return seat.private.handCardInstanceIds.includes(cardInstanceId) || seat.public.inPlayCardInstanceIds.includes(cardInstanceId);
}

function completedInteractions(frame: ResolutionFrame): unknown[] {
  const results = frame.payload[INTERACTION_RESULTS_KEY];
  return Array.isArray(results) ? results : [];
}

function lastCompletedChoice(frame: ResolutionFrame, kind: string): string | undefined {
  const results = completedInteractions(frame);
  for (let index = results.length - 1; index >= 0; index -= 1) {
    const result = results[index];
    if (!isPlainRecord(result) || result.kind !== kind || !Array.isArray(result.responses)) continue;
    const response = result.responses[result.responses.length - 1];
    if (isPlainRecord(response) && typeof response.choice === "string") return response.choice;
  }
  return undefined;
}

/**
 * Captures the living seats clockwise after a source. The returned queue is a
 * snapshot of start-time targets; later eliminations do not reorder or remove it.
 */
export function buildClockwiseTargetSteps(
  state: GameState,
  input: ClockwiseTargetStepsInput,
): ReadonlyResult<EffectStep[]> {
  if (state.status !== "playing") return readonlyFailure("MATCH_NOT_PLAYING", "Target queues can only be built during a playing match.");
  if (!isNonEmptyString(input.effectId) || !isNonEmptyString(input.kind) || !isNonEmptyString(input.sourcePlayerId)) {
    return readonlyFailure("INVALID_STATE", "Target queue needs an effect, kind, and source player ID.");
  }
  if (input.sourceCardInstanceId !== null && !isNonEmptyString(input.sourceCardInstanceId)) {
    return readonlyFailure("INVALID_STATE", "Source card ID must be null or a non-empty ID.");
  }
  if (!isPlainRecord(input.payload) || !isJsonValue(input.payload)) {
    return readonlyFailure("INVALID_STATE", "Target step payload must be a JSON object.");
  }
  const sorted = [...state.seats].sort((left, right) => left.public.seatIndex - right.public.seatIndex);
  if (new Set(sorted.map((seat) => seat.public.playerId)).size !== sorted.length ||
      new Set(sorted.map((seat) => seat.public.seatIndex)).size !== sorted.length) {
    return readonlyFailure("INVALID_STATE", "Target order requires unique players and seat indexes.");
  }
  const sourceIndexes = sorted
    .map((seat, index) => (seat.public.playerId === input.sourcePlayerId ? index : -1))
    .filter((index) => index >= 0);
  if (sourceIndexes.length !== 1 || sorted[sourceIndexes[0]!]!.public.eliminated) {
    return readonlyFailure("INVALID_STATE", "The source must identify one living seat.");
  }

  const sourceIndex = sourceIndexes[0]!;
  const steps: EffectStep[] = [];
  for (let offset = 1; offset < sorted.length; offset += 1) {
    const target = sorted[(sourceIndex + offset) % sorted.length]!;
    if (target.public.eliminated) continue;
    steps.push({
      effectId: input.effectId,
      kind: input.kind,
      sourcePlayerId: input.sourcePlayerId,
      targetPlayerId: target.public.playerId,
      sourceCardInstanceId: input.sourceCardInstanceId,
      payload: cloneJsonRecord(input.payload),
    });
  }
  return { ok: true, value: steps };
}

/** Starts one serialized effect, retaining its resume frame and target cursor. */
export function beginEffectResolution(
  state: GameState,
  input: EffectResolutionInput,
): ResolutionResult<{ frameId: string; queuedStepCount: number }> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "A resolution cannot start outside a playing match.");
  if (!hasIdleResolution(state)) return failure("RESOLUTION_ALREADY_ACTIVE", "An effect, interaction, or death flow is already active.");
  const frameIssue = validateFrame(input.continuation);
  if (frameIssue) return failure("INVALID_STATE", frameIssue);
  if (state.resolution.continuations.some((frame) => frame.frameId === input.continuation.frameId)) {
    return failure("INVALID_STATE", "Continuation frame IDs must be unique.");
  }
  if (input.steps.length === 0) return failure("INVALID_STATE", "An effect resolution needs at least one queued step.");
  for (const step of input.steps) {
    const issue = validateEffectStep(step);
    if (issue) return failure("INVALID_STATE", issue);
  }
  if (input.deferredVictoryCheckEffectId !== undefined &&
      (!isNonEmptyString(input.deferredVictoryCheckEffectId) ||
        !input.steps.some((step) => step.effectId === input.deferredVictoryCheckEffectId))) {
    return failure("INVALID_STATE", "Deferred victory must refer to an effect represented in the initial queue.");
  }

  const continuation = {
    ...input.continuation,
    payload: cloneJsonRecord(input.continuation.payload),
  };
  const resolution: ResolutionState = {
    effectQueue: input.steps.map((step) => ({ ...step, payload: cloneJsonRecord(step.payload) })),
    continuations: [continuation],
    pendingInteraction: null,
    pendingDeath: null,
    victoryCheckDeferredByEffectId: input.deferredVictoryCheckEffectId ?? null,
  };
  return commit(state, resolution, {
    frameId: continuation.frameId,
    queuedStepCount: resolution.effectQueue.length,
  });
}

/** Opens an ordered, serialized interaction; only the current responder's options are exposed. */
export function openPendingInteraction(
  state: GameState,
  input: OpenInteractionInput,
): ResolutionResult<{ currentActorPlayerId: string }> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "An interaction cannot open outside a playing match.");
  if (state.resolution.pendingInteraction !== null || state.resolution.pendingDeath !== null) {
    return failure("RESOLUTION_ALREADY_ACTIVE", "Another interaction or death flow is already open.");
  }
  const pending = createPendingInteraction(state, input);
  if (!pending.ok) return pending;
  const currentActorPlayerId = pending.value.actorPlayerIds[0]!;
  const resolution = { ...state.resolution, pendingInteraction: pending.value };
  return commit(state, resolution, { currentActorPlayerId });
}

/**
 * Accepts exactly one saved option for the current actor. A response advances
 * one cursor position, or is written to the saved continuation before the
 * pending interaction is cleared.
 */
export function submitInteractionResponse(
  state: GameState,
  input: InteractionResponseInput,
): ResolutionResult<InteractionResponseProgress> {
  return setInteractionResponse(state, input);
}

/** Opens the victim-only rescue window and keeps HP/elimination effects external. */
export function beginDeathRescue(
  state: GameState,
  input: BeginDeathRescueInput,
): ResolutionResult<{ victimPlayerId: string }> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "Death rescue cannot open outside a playing match.");
  if (state.resolution.pendingInteraction !== null) return failure("RESOLUTION_ALREADY_ACTIVE", "Another interaction is already open.");
  if (!isNonEmptyString(input.victimPlayerId) || (input.sourcePlayerId !== null && !isNonEmptyString(input.sourcePlayerId))) {
    return failure("INVALID_STATE", "Death rescue victim/source identity is invalid.");
  }
  const victim = findUniqueSeat(state, input.victimPlayerId);
  if (!victim || victim.public.eliminated || victim.public.hp > 0) {
    return failure("INVALID_STATE", "Only a non-eliminated player at zero or fewer HP can enter rescue.");
  }
  const existing = state.resolution.pendingDeath;
  if (existing) {
    if (existing.victimPlayerId !== input.victimPlayerId ||
        existing.sourcePlayerId !== input.sourcePlayerId || existing.resumeFrameId !== input.resumeFrameId ||
        existing.consequenceStage !== "rescue" || !Number.isInteger(existing.rescueCursor) ||
        existing.rescueCursor < 0 || existing.rescueCursor > 1 ||
        existing.rescueResponderIds.length !== 1 || existing.rescueResponderIds[0] !== input.victimPlayerId) {
      return failure("INVALID_DEATH_STAGE", "A different death consequence is already pending.");
    }
    if (existing.rescueCursor === 1) {
      const frame = state.resolution.continuations[frameIndex(state, existing.resumeFrameId ?? "")];
      const previousChoice = frame ? lastCompletedChoice(frame, "DEATH_RESCUE") : undefined;
      if (previousChoice !== "USE_BEER" && previousChoice !== "USE_SID") {
        return failure("INVALID_DEATH_STAGE", "Only a completed Beer or Sid rescue action may open another rescue window.");
      }
    }
  }
  const rescueChoices = new Set(["USE_BEER", "USE_SID", "ACCEPT_ELIMINATION"]);
  if (input.options.length === 0 || input.options.some((option) => !rescueChoices.has(option.choice))) {
    return failure("INVALID_CHOICE", "Rescue options may only offer Beer, Sid, or accepting elimination.");
  }
  const frameId = input.resumeFrameId;
  const open = createPendingInteraction(state, {
    interactionId: input.interactionId,
    kind: "DEATH_RESCUE",
    responders: [{ playerId: input.victimPlayerId, options: input.options }],
    context: input.context,
    resumeFrameId: frameId,
    createdAt: input.createdAt,
  });
  if (!open.ok) return open;
  const pendingDeath: PendingDeath = existing
    ? { ...existing, rescueCursor: 0 }
    : {
        victimPlayerId: input.victimPlayerId,
        sourcePlayerId: input.sourcePlayerId,
        rescueResponderIds: [input.victimPlayerId],
        rescueCursor: 0,
        consequenceStage: "rescue",
        resumeFrameId: frameId,
      };
  return commit(state, {
    ...state.resolution,
    pendingInteraction: open.value,
    pendingDeath,
  }, { victimPlayerId: input.victimPlayerId });
}

/** Submits only a saved Beer/Sid/accept option from the wounded player. */
export function submitDeathRescueResponse(
  state: GameState,
  input: InteractionResponseInput,
): ResolutionResult<InteractionResponseProgress> {
  const pendingDeath = state.resolution.pendingDeath;
  if (!pendingDeath || pendingDeath.consequenceStage !== "rescue") {
    return failure("INVALID_DEATH_STAGE", "There is no death rescue awaiting a response.");
  }
  if (pendingDeath.rescueResponderIds.length !== 1 || pendingDeath.rescueCursor !== 0 ||
      input.actorPlayerId !== pendingDeath.victimPlayerId ||
      pendingDeath.rescueResponderIds[pendingDeath.rescueCursor] !== input.actorPlayerId) {
    return failure("WRONG_RESPONDER", "Only the wounded player may answer their rescue window.");
  }
  const response = setInteractionResponse(state, input, {
    requireKind: "DEATH_RESCUE",
    allowChoice: ["USE_BEER", "USE_SID", "ACCEPT_ELIMINATION"],
  });
  if (!response.ok || !response.value.completed) return response;
  return {
    ...response,
    state: {
      ...response.state,
      resolution: {
        ...response.state.resolution,
        pendingDeath: { ...pendingDeath, rescueCursor: pendingDeath.rescueCursor + 1 },
      },
    },
  };
}

/** Advances rescue to elimination or closes it after the caller has applied healing. */
export function completeDeathRescue(
  state: GameState,
  victimPlayerId: string,
  outcome: DeathRescueOutcome,
): ResolutionResult<{ consequenceStage: PendingDeath["consequenceStage"] | null }> {
  const pendingDeath = state.resolution.pendingDeath;
  if (!pendingDeath || pendingDeath.victimPlayerId !== victimPlayerId || pendingDeath.consequenceStage !== "rescue") {
    return failure("INVALID_DEATH_STAGE", "The requested victim has no active rescue stage.");
  }
  if (state.resolution.pendingInteraction !== null) {
    return failure("INVALID_DEATH_STAGE", "Resolve or close the current rescue interaction before advancing death handling.");
  }
  if (pendingDeath.rescueCursor !== pendingDeath.rescueResponderIds.length) {
    return failure("INVALID_DEATH_STAGE", "The saved rescue responder cursor has not reached the end.");
  }
  const victim = findUniqueSeat(state, victimPlayerId);
  if (!victim) return failure("INVALID_STATE", "The pending death victim must identify exactly one seat.");
  const frame = state.resolution.continuations[frameIndex(state, pendingDeath.resumeFrameId ?? "")] ?? undefined;
  if (!frame) return failure("FRAME_NOT_FOUND", "The death rescue continuation frame is missing.");
  const lastChoice = lastCompletedChoice(frame, "DEATH_RESCUE");

  if (outcome === "survived") {
    if ((lastChoice !== "USE_BEER" && lastChoice !== "USE_SID") || victim.public.eliminated || victim.public.hp <= 0) {
      return failure("INVALID_DEATH_STAGE", "A rescued player must have positive HP and remain active.");
    }
    const resolution = { ...state.resolution, pendingDeath: null };
    return commit(state, resolution, { consequenceStage: null });
  }

  if (outcome !== "accept_elimination" || victim.public.hp > 0 || victim.public.eliminated || lastChoice !== "ACCEPT_ELIMINATION") {
    return failure("INVALID_DEATH_STAGE", "Elimination requires zero HP and the victim's saved accept-elimination response.");
  }
  const nextDeath: PendingDeath = { ...pendingDeath, consequenceStage: "elimination" };
  return commit(state, { ...state.resolution, pendingDeath: nextDeath }, { consequenceStage: "elimination" });
}

/** Called after the owning death/elimination layer marks the victim eliminated. */
export function markDeathCleanupReady(
  state: GameState,
  victimPlayerId: string,
): ResolutionResult<{ consequenceStage: "cleanup" }> {
  const pendingDeath = state.resolution.pendingDeath;
  const victim = findUniqueSeat(state, victimPlayerId);
  if (!pendingDeath || pendingDeath.victimPlayerId !== victimPlayerId || pendingDeath.consequenceStage !== "elimination") {
    return failure("INVALID_DEATH_STAGE", "The victim is not at the elimination consequence stage.");
  }
  if (!victim?.public.eliminated || state.resolution.pendingInteraction !== null) {
    return failure("INVALID_DEATH_STAGE", "Elimination must be applied before cleanup begins.");
  }
  return commit(state, {
    ...state.resolution,
    pendingDeath: { ...pendingDeath, consequenceStage: "cleanup" },
  }, { consequenceStage: "cleanup" });
}

/**
 * Ends card custody/reward cleanup. A queued/deferred effect resumes its next
 * saved step; otherwise the caller gets an explicit win-check stage.
 */
export function completeDeathCleanup(
  state: GameState,
  victimPlayerId: string,
): ResolutionResult<{ consequenceStage: "win_check" | null }> {
  const pendingDeath = state.resolution.pendingDeath;
  if (!pendingDeath || pendingDeath.victimPlayerId !== victimPlayerId || pendingDeath.consequenceStage !== "cleanup") {
    return failure("INVALID_DEATH_STAGE", "The victim is not at the cleanup consequence stage.");
  }
  if (state.resolution.pendingInteraction !== null) {
    return failure("INVALID_DEATH_STAGE", "Finish the pending card-order interaction before closing cleanup.");
  }
  const mustResumeEffect = state.resolution.effectQueue.length > 0 ||
    state.resolution.victoryCheckDeferredByEffectId !== null;
  if (mustResumeEffect) {
    return commit(state, { ...state.resolution, pendingDeath: null }, { consequenceStage: null });
  }
  return commit(state, {
    ...state.resolution,
    pendingDeath: { ...pendingDeath, consequenceStage: "win_check" },
  }, { consequenceStage: "win_check" });
}

/** Closes the final death stage after the endgame layer has checked the result. */
export function completeDeathWinCheck(
  state: GameState,
  victimPlayerId: string,
): ResolutionResult<{ completed: true }> {
  const pendingDeath = state.resolution.pendingDeath;
  const victim = findUniqueSeat(state, victimPlayerId);
  if (!pendingDeath || pendingDeath.victimPlayerId !== victimPlayerId || pendingDeath.consequenceStage !== "win_check") {
    return failure("INVALID_DEATH_STAGE", "The victim is not waiting at the win-check stage.");
  }
  if (!victim?.public.eliminated || state.resolution.effectQueue.length > 0 ||
      state.resolution.pendingInteraction !== null || state.resolution.victoryCheckDeferredByEffectId !== null) {
    return failure("INVALID_DEATH_STAGE", "Win checking must follow completed cleanup and effect resolution.");
  }
  return commit(state, { ...state.resolution, pendingDeath: null }, { completed: true });
}

/** Opens a server-authored discard-order choice. It does not move cards. */
export function beginDiscardOrder(
  state: GameState,
  input: BeginDiscardOrderInput,
): ResolutionResult<{ playerId: string; requiredCount: number }> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "A discard order cannot open outside a playing match.");
  if (state.resolution.pendingInteraction !== null) return failure("RESOLUTION_ALREADY_ACTIVE", "Another interaction is already open.");
  if (!isNonEmptyString(input.playerId) || !isNonEmptyString(input.interactionId) ||
      !isNonEmptyString(input.createdAt) || !isNonEmptyString(input.resumeFrameId)) {
    return failure("INVALID_STATE", "Discard order needs an interaction, player, frame, and caller-supplied timestamp.");
  }
  if (input.reason !== "turn_hand_limit" && input.reason !== "elimination_cleanup" && input.reason !== "effect_cleanup") {
    return failure("INVALID_DISCARD_ORDER", "Discard ordering needs a recognized reason.");
  }
  if (!isPlainRecord(input.context) || !isJsonValue(input.context) || INTERACTION_CURSOR_KEY in input.context) {
    return failure("INVALID_STATE", "Discard context must be JSON and must not use the reserved cursor key.");
  }
  if (!Number.isInteger(input.requiredCount) || input.requiredCount < 1 || input.requiredCount > input.cardInstanceIds.length) {
    return failure("INVALID_DISCARD_ORDER", "Discard count must be a positive number no greater than the candidate set.");
  }
  const seat = findUniqueSeat(state, input.playerId);
  if (!seat) return failure("INVALID_STATE", "Discard owner must identify exactly one seat.");
  if (frameIndex(state, input.resumeFrameId) < 0) return failure("FRAME_NOT_FOUND", "Discard ordering must resume a saved continuation frame.");
  if (new Set(input.cardInstanceIds).size !== input.cardInstanceIds.length ||
      input.cardInstanceIds.some((id) => !isNonEmptyString(id) || !seatOwnsCard(seat, id))) {
    return failure("INVALID_DISCARD_ORDER", "Discard candidates must be unique cards in the owner's hand or public in-play area.");
  }

  if (input.reason === "turn_hand_limit") {
    const excess = Math.max(0, seat.private.handCardInstanceIds.length - seat.public.hp);
    if (seat.public.eliminated || state.turn.currentPlayerId !== input.playerId || state.turn.phase !== "discard" ||
        input.requiredCount !== excess || input.cardInstanceIds.some((id) => !seat.private.handCardInstanceIds.includes(id))) {
      return failure("INVALID_DISCARD_ORDER", "Turn-end discard must be the exact hand excess for the active discard phase.");
    }
  } else if (input.reason === "elimination_cleanup") {
    const ownedCards = [...seat.private.handCardInstanceIds, ...seat.public.inPlayCardInstanceIds];
    if (!seat.public.eliminated || input.requiredCount !== input.cardInstanceIds.length ||
        input.cardInstanceIds.length !== ownedCards.length || ownedCards.some((id) => !input.cardInstanceIds.includes(id))) {
      return failure("INVALID_DISCARD_ORDER", "Elimination cleanup must order every remaining hand and in-play card for that eliminated owner.");
    }
  }

  if (state.resolution.pendingDeath && state.resolution.pendingDeath.consequenceStage !== "cleanup") {
    return failure("INVALID_DEATH_STAGE", "Discard ordering during death handling is only available in cleanup.");
  }
  const context: { [key: string]: JsonValue } = {
    ...cloneJsonRecord(input.context),
    discardOrder: {
      reason: input.reason,
      allowedCardInstanceIds: [...input.cardInstanceIds],
      requiredCount: input.requiredCount,
    },
  };
  const opened = createPendingInteraction(state, {
    interactionId: input.interactionId,
    kind: "DISCARDS_ORDER",
    responders: [{
      playerId: input.playerId,
      options: [{ choice: "ORDER_CARDS", payload: {} }],
    }],
    context,
    resumeFrameId: input.resumeFrameId,
    createdAt: input.createdAt,
  });
  if (!opened.ok) return opened;
  return commit(state, {
    ...state.resolution,
    pendingInteraction: opened.value,
  }, { playerId: input.playerId, requiredCount: input.requiredCount });
}

/** Checks count and membership, then persists the exact order; first is discarded first, last becomes pile top. */
export function submitDiscardOrder(
  state: GameState,
  input: SubmitDiscardOrderInput,
): ResolutionResult<{ orderedCardInstanceIds: string[] }> {
  const pending = state.resolution.pendingInteraction;
  if (!pending) return failure("NO_PENDING_INTERACTION", "There is no discard order awaiting a response.");
  if (pending.kind !== "DISCARDS_ORDER") return failure("INVALID_CHOICE", "The current interaction is not a discard order.");
  if (pending.interactionId !== input.interactionId) return failure("WRONG_INTERACTION", "The discard order refers to a stale interaction ID.");
  if (pending.actorPlayerIds.length !== 1 || pending.actorPlayerIds[0] !== input.actorPlayerId) {
    return failure("WRONG_RESPONDER", "Only the current card owner may choose this discard order.");
  }
  if (input.choice !== "ORDER_CARDS") return failure("INVALID_CHOICE", "Discard ordering requires the saved ORDER_CARDS choice.");
  const spec = pending.context.discardOrder;
  if (!isPlainRecord(spec) || !Array.isArray(spec.allowedCardInstanceIds) || !Number.isInteger(spec.requiredCount)) {
    return failure("INVALID_STATE", "The saved discard candidate set is malformed.");
  }
  const allowed = spec.allowedCardInstanceIds;
  const requiredCount = spec.requiredCount as number;
  if (input.orderedCardInstanceIds.length !== requiredCount ||
      new Set(input.orderedCardInstanceIds).size !== input.orderedCardInstanceIds.length ||
      input.orderedCardInstanceIds.some((id) => !allowed.includes(id))) {
    return failure("INVALID_DISCARD_ORDER", "Choose the exact required number of unique cards from the saved candidate set.");
  }
  const plan = readSavedCursor(pending);
  if (!plan || plan.cursor !== 0 || plan.responders.length !== 1 || plan.responders[0]!.playerId !== input.actorPlayerId) {
    return failure("INVALID_STATE", "The discard interaction cursor is malformed.");
  }
  if (!plan.responders[0]!.options.some((option) => option.choice === input.choice && Object.keys(option.payload).length === 0)) {
    return failure("INVALID_CHOICE", "The discard choice is not among the saved options.");
  }
  const response: SavedResponse = {
    playerId: input.actorPlayerId,
    choice: "ORDER_CARDS",
    payload: { orderedCardInstanceIds: [...input.orderedCardInstanceIds] },
  };
  const persisted = appendCompletedInteraction(state, pending, [response]);
  if (!persisted.ok) return persisted;
  const resolution = {
    ...state.resolution,
    continuations: persisted.state.resolution.continuations,
    pendingInteraction: null,
  };
  return commit(state, resolution, { orderedCardInstanceIds: [...input.orderedCardInstanceIds] });
}

/** Removes exactly the expected head step; its remaining queue stays serialized. */
export function completeEffectStep(
  state: GameState,
  expectedStep: EffectStep,
): ResolutionResult<{ remainingStepCount: number }> {
  const current = state.resolution.effectQueue[0];
  if (!current) return failure("EFFECT_STEP_MISMATCH", "There is no effect step waiting to complete.");
  if (!jsonEqual(current as unknown as JsonValue, expectedStep as unknown as JsonValue)) {
    return failure("EFFECT_STEP_MISMATCH", "Only the currently saved effect step may advance the queue.");
  }
  if (state.resolution.pendingInteraction !== null || state.resolution.pendingDeath !== null) {
    return failure("INVALID_DEATH_STAGE", "Finish the active interaction/death stage before advancing the effect queue.");
  }
  const effectQueue = state.resolution.effectQueue.slice(1);
  return commit(state, { ...state.resolution, effectQueue }, { remainingStepCount: effectQueue.length });
}

/** Pops the active resume frame only after all queued work and prompts are complete. */
export function finishEffectResolution(
  state: GameState,
  effectId: string,
  frameId: string,
): ResolutionResult<{ frame: ResolutionFrame; canCheckVictory: boolean }> {
  if (!isNonEmptyString(effectId) || !isNonEmptyString(frameId)) return failure("INVALID_STATE", "Effect and frame IDs are required.");
  if (state.resolution.effectQueue.length > 0 || state.resolution.pendingInteraction !== null || state.resolution.pendingDeath !== null) {
    return failure("RESOLUTION_ALREADY_ACTIVE", "Queued work and all interaction/death stages must finish before resuming the frame.");
  }
  const deferred = state.resolution.victoryCheckDeferredByEffectId;
  if (deferred !== null && deferred !== effectId) {
    return failure("INVALID_STATE", "Only the effect that owns the deferred victory check may finish it.");
  }
  const index = frameIndex(state, frameId);
  if (index < 0 || index !== state.resolution.continuations.length - 1) {
    return failure("FRAME_NOT_FOUND", "Only the unique top continuation frame may be resumed.");
  }
  const frame = state.resolution.continuations[index]!;
  const continuations = state.resolution.continuations.slice(0, -1);
  const resolution: ResolutionState = {
    ...state.resolution,
    continuations,
    victoryCheckDeferredByEffectId: deferred === effectId ? null : deferred,
  };
  const nextState = { ...state, resolution, version: state.version + 1 };
  return {
    ok: true,
    state: nextState,
    value: { frame: cloneJsonValue(frame as unknown as JsonValue) as unknown as ResolutionFrame, canCheckVictory: canCheckVictory(nextState) },
  };
}

/** Victory may be evaluated only after the saved work/cursors have been consumed. */
export function canCheckVictory(state: GameState): boolean {
  return state.status === "playing" &&
    state.resolution.effectQueue.length === 0 &&
    state.resolution.continuations.length === 0 &&
    state.resolution.pendingInteraction === null &&
    state.resolution.pendingDeath === null &&
    state.resolution.victoryCheckDeferredByEffectId === null;
}

