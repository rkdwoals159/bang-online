import { emptySuzyDrawEvents } from "../effects/characters/suzy-lafayette.js";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { DeepReadonly, EffectEventDraft } from "../effects/api.js";
import { jailStartEffect } from "../effects/cards/jail.js";
import { dynamiteStartEffect } from "../effects/cards/dynamite-barrel.js";
import { blackJackAbility } from "../effects/characters/black-jack.js";
import { jesseJonesAbility } from "../effects/characters/jesse-jones.js";
import { kitCarlsonAbility } from "../effects/characters/kit-carlson.js";
import { pedroRamirezAbility } from "../effects/characters/pedro-ramirez.js";
import { planDrawPileSupply } from "../effects/draw-pile.js";
import type { CharacterEffectResult } from "../effects/character-api.js";
import type { CompletedEffectInteraction as CharacterCompletedInteraction } from "../effects/api.js";
import type { EffectRuntimeOptions, InteractionIdentity } from "../effects/runtime/index.js";
import { executeCardEffect } from "../effects/runtime/index.js";
import type { RandomSource } from "../random/shuffle.js";
import {
  beginEffectResolution,
  completeEffectStep,
  finishEffectResolution,
  openPendingInteraction,
} from "../resolution/index.js";
import type { CardInstance, EffectStep, GameState, JsonValue, ResolutionFrame } from "../state/types.js";
import { completeDraw, completeStartEffects, skipTurnAfterStartResolution } from "./reducer.js";

const TURN_DRAW_FRAME_KIND = "TURN_DRAW";
const TURN_START_DYNAMITE_EFFECT = "__turn_start_dynamite";
const TURN_START_JAIL_EFFECT = "__turn_start_jail";
const INTERACTION_RESULTS_KEY = "__resolutionResults";

const CARD_TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

export interface TurnDrawInput {
  readonly state: GameState;
  readonly actorPlayerId: string;
  readonly random: RandomSource;
  readonly nextInteractionIdentity: () => InteractionIdentity;
  /** Stable IDs allow a caller to bind turn-phase continuations to its own command. */
  readonly continuationFrameId?: string;
}

export interface TurnStartInput extends TurnDrawInput {
  readonly runtimeOptions: EffectRuntimeOptions;
}

export interface TurnPhaseError {
  readonly code: string;
  readonly message: string;
}

export interface TurnPhaseOutput {
  readonly state: GameState;
  readonly events: readonly EffectEventDraft[];
  readonly value: JsonValue;
}

export type TurnPhaseResult =
  | { readonly ok: true; readonly output: TurnPhaseOutput }
  | { readonly ok: false; readonly error: TurnPhaseError };

type ZoneName = "draw_pile" | "discard" | "revealed_pool" | "hand" | "in_play";

function failure(code: string, message: string): TurnPhaseResult {
  return { ok: false, error: { code, message } };
}

function success(state: GameState, events: readonly EffectEventDraft[], value: JsonValue): TurnPhaseResult {
  return { ok: true, output: { state, events, value } };
}

function uniqueSeat(state: GameState, playerId: string) {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function cardType(state: GameState, cardInstanceId: string): string | undefined {
  const card = state.zones.cardsByInstanceId[cardInstanceId];
  if (!card || card.cardInstanceId !== cardInstanceId) return undefined;
  return CARD_TYPE_BY_DEFINITION_ID.get(card.cardDefinitionId);
}

function currentTurnError(state: GameState, actorPlayerId: string, phase: "start" | "draw"): TurnPhaseError | undefined {
  if (state.status !== "playing") return { code: "MATCH_NOT_PLAYING", message: "The match is not in play." };
  if (state.turn.phase !== phase) return { code: "ILLEGAL_PHASE", message: `Turn start requires the '${phase}' phase.` };
  if (state.turn.currentPlayerId !== actorPlayerId) return { code: "NOT_YOUR_TURN", message: "The actor is not the current player." };
  const seat = uniqueSeat(state, actorPlayerId);
  if (!seat || seat.public.eliminated || seat.public.hp <= 0) return { code: "INVALID_STATE", message: "The current turn actor must be a living player." };
  return undefined;
}

function resolutionIdle(state: GameState): boolean {
  const resolution = state.resolution;
  return resolution.effectQueue.length === 0 && resolution.continuations.length === 0 &&
    resolution.pendingInteraction === null && resolution.pendingDeath === null &&
    resolution.victoryCheckDeferredByEffectId === null;
}

function isInteractionPending(value: JsonValue): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value) && value.kind === "interaction_pending";
}

function turnStartRuntimeOptions(options: EffectRuntimeOptions): EffectRuntimeOptions {
  return {
    ...options,
    registry: {
      ...options.registry,
      cards: {
        ...options.registry.cards,
        [TURN_START_DYNAMITE_EFFECT]: dynamiteStartEffect,
        [TURN_START_JAIL_EFFECT]: jailStartEffect,
      },
    },
  };
}

/**
 * Adds the engine-owned Dynamite start effect to a runtime registry. A caller
 * must use the returned options for both initial resolution and T66 resumes.
 */
export function withTurnStartEffects(options: EffectRuntimeOptions): EffectRuntimeOptions {
  return turnStartRuntimeOptions(options);
}

function installedCards(state: GameState, actorPlayerId: string, typeId: string): string[] {
  const actor = uniqueSeat(state, actorPlayerId);
  if (!actor) return [];
  return actor.public.inPlayCardInstanceIds.filter((cardInstanceId) => cardType(state, cardInstanceId) === typeId);
}

/** Resolves Dynamite, then Jail, and enters draw only after both complete. */
export function resolveTurnStart(input: TurnStartInput): TurnPhaseResult {
  const issue = currentTurnError(input.state, input.actorPlayerId, "start");
  if (issue) return { ok: false, error: issue };
  if (!resolutionIdle(input.state)) return failure("ILLEGAL_PHASE", "Turn start is blocked while another resolution is active.");

  let state = input.state;
  const events: EffectEventDraft[] = [];
  const dynamicIds = installedCards(state, input.actorPlayerId, "dynamite");
  if (dynamicIds.length > 1) {
    return failure("UNSUPPORTED_START_STATE", "More than one Dynamite is installed on the current player; the rules input does not define this case.");
  }
  const dynamiteId = dynamicIds[0];
  if (dynamiteId) {
    const effect = executeCardEffect({
      state,
      actorPlayerId: input.actorPlayerId,
      effectTypeId: TURN_START_DYNAMITE_EFFECT,
      sourceCardInstanceId: dynamiteId,
      continuationFrameId: input.continuationFrameId ?? `turn:${state.turn.turnNumber}:${input.actorPlayerId}:dynamite`,
      random: input.random,
    }, turnStartRuntimeOptions(input.runtimeOptions));
    if (!effect.ok) return failure(effect.error.code, effect.error.message);
    state = effect.output.state;
    events.push(...effect.output.events);
    if (isInteractionPending(effect.output.value)) {
      return success(state, events, effect.output.value);
    }
    if (state.status !== "playing") return success(state, events, effect.output.value);
  }

  const actorAfterDynamite = uniqueSeat(state, input.actorPlayerId);
  if (!actorAfterDynamite || actorAfterDynamite.public.eliminated || actorAfterDynamite.public.hp <= 0) {
    const skipped = skipTurnAfterStartResolution(state);
    return skipped.ok
      ? success(skipped.state, events, { kind: "turn_skipped", reason: "actor_eliminated_during_start" })
      : failure(skipped.error.code, skipped.error.message);
  }

  const jailIds = installedCards(state, input.actorPlayerId, "jail");
  if (jailIds.length > 1) {
    return failure("UNSUPPORTED_START_STATE", "More than one Jail is installed on the current player.");
  }
  const jailId = jailIds[0];
  let jailSkippedTurn = false;
  if (jailId) {
    // Run Jail through T66 so Lucky's judgment selection remains a saved
    // T12 interaction and resumes before the turn phase advances.
    const jailEffect = executeCardEffect({
      state,
      actorPlayerId: input.actorPlayerId,
      effectTypeId: TURN_START_JAIL_EFFECT,
      sourceCardInstanceId: jailId,
      continuationFrameId: input.continuationFrameId
        ? `${input.continuationFrameId}:jail`
        : `turn:${state.turn.turnNumber}:${input.actorPlayerId}:jail`,
      random: input.random,
    }, turnStartRuntimeOptions(input.runtimeOptions));
    if (!jailEffect.ok) return failure(jailEffect.error.code, jailEffect.error.message);
    state = jailEffect.output.state;
    events.push(...jailEffect.output.events);
    if (isInteractionPending(jailEffect.output.value)) return success(state, events, jailEffect.output.value);
    if (state.status !== "playing") return success(state, events, { kind: "start_paused" });
    jailSkippedTurn = jailEffect.output.events.some((event) => event.type === "JAIL_JUDGMENT_RESOLVED" && event.payload.turnSkipped === true);
  }

  const transition = jailSkippedTurn
    ? skipTurnAfterStartResolution(state)
    : completeStartEffects(state, input.actorPlayerId);
  if (!transition.ok) return failure(transition.error.code, transition.error.message);
  return success(transition.state, events, jailSkippedTurn
    ? { kind: "turn_skipped", reason: "jail_judgment" }
    : { kind: "draw_phase_started" });
}

function location(state: GameState, cardInstanceId: string): { zone: ZoneName; playerId: string | null }[] {
  const found: { zone: ZoneName; playerId: string | null }[] = [];
  const record = (zone: ZoneName, ids: readonly string[], playerId: string | null = null) => {
    for (const id of ids) if (id === cardInstanceId) found.push({ zone, playerId });
  };
  for (const seat of state.seats) {
    record("hand", seat.private.handCardInstanceIds, seat.public.playerId);
    record("in_play", seat.public.inPlayCardInstanceIds, seat.public.playerId);
  }
  record("draw_pile", state.zones.drawPileCardInstanceIds);
  record("discard", state.zones.discardPileCardInstanceIds);
  record("revealed_pool", state.zones.revealedPoolCardInstanceIds);
  return found;
}

function moveCard(
  state: GameState,
  cardInstanceId: string,
  fromZone: ZoneName,
  fromPlayerId: string | null,
  toZone: ZoneName,
  toPlayerId: string | null,
): GameState | undefined {
  const locations = location(state, cardInstanceId);
  if (locations.length !== 1 || locations[0]!.zone !== fromZone || locations[0]!.playerId !== fromPlayerId) return undefined;
  if ((toZone === "hand" || toZone === "in_play") !== (toPlayerId !== null)) return undefined;
  const zones = {
    ...state.zones,
    drawPileCardInstanceIds: [...state.zones.drawPileCardInstanceIds],
    discardPileCardInstanceIds: [...state.zones.discardPileCardInstanceIds],
    revealedPoolCardInstanceIds: [...state.zones.revealedPoolCardInstanceIds],
  };
  const seats = state.seats.map((seat) => ({
    ...seat,
    private: { ...seat.private, handCardInstanceIds: [...seat.private.handCardInstanceIds] },
    public: { ...seat.public, inPlayCardInstanceIds: [...seat.public.inPlayCardInstanceIds] },
  }));
  const seatFor = (playerId: string) => seats.find((seat) => seat.public.playerId === playerId);
  const remove = () => {
    if (fromZone === "draw_pile") zones.drawPileCardInstanceIds.splice(zones.drawPileCardInstanceIds.indexOf(cardInstanceId), 1);
    else if (fromZone === "discard") zones.discardPileCardInstanceIds.splice(zones.discardPileCardInstanceIds.indexOf(cardInstanceId), 1);
    else if (fromZone === "revealed_pool") zones.revealedPoolCardInstanceIds.splice(zones.revealedPoolCardInstanceIds.indexOf(cardInstanceId), 1);
    else if (fromZone === "hand") {
      const seat = fromPlayerId ? seatFor(fromPlayerId) : undefined;
      if (!seat) return false;
      seat.private.handCardInstanceIds.splice(seat.private.handCardInstanceIds.indexOf(cardInstanceId), 1);
    } else {
      const seat = fromPlayerId ? seatFor(fromPlayerId) : undefined;
      if (!seat) return false;
      seat.public.inPlayCardInstanceIds.splice(seat.public.inPlayCardInstanceIds.indexOf(cardInstanceId), 1);
    }
    return true;
  };
  if (!remove()) return undefined;
  if (toZone === "draw_pile") zones.drawPileCardInstanceIds.unshift(cardInstanceId);
  else if (toZone === "discard") zones.discardPileCardInstanceIds.push(cardInstanceId);
  else if (toZone === "revealed_pool") zones.revealedPoolCardInstanceIds.push(cardInstanceId);
  else if (toZone === "hand") {
    const seat = toPlayerId ? seatFor(toPlayerId) : undefined;
    if (!seat) return undefined;
    seat.private.handCardInstanceIds.push(cardInstanceId);
  } else {
    const seat = toPlayerId ? seatFor(toPlayerId) : undefined;
    if (!seat) return undefined;
    seat.public.inPlayCardInstanceIds.push(cardInstanceId);
  }
  return { ...state, seats, zones };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function applyDrawEvent(state: GameState, event: EffectEventDraft): GameState | undefined {
  const payload = recordOf(event.payload);
  if (!payload) return undefined;
  if (event.type === "DRAW_PILE_RESHUFFLED") {
    const ids = payload.cardInstanceIds;
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") ||
        ids.length !== state.zones.discardPileCardInstanceIds.length ||
        new Set(ids).size !== ids.length || ids.some((id) => !state.zones.discardPileCardInstanceIds.includes(id))) return undefined;
    if (state.zones.drawPileCardInstanceIds.length !== 0) return undefined;
    return { ...state, zones: { ...state.zones, drawPileCardInstanceIds: [...ids] as string[], discardPileCardInstanceIds: [] } };
  }
  if (event.type === "RULE_RESOURCE_EXHAUSTED") {
    return { ...state, status: "paused", pauseReason: "RULE_RESOURCE_EXHAUSTED" };
  }
  if (event.type === "CARD_DRAWN" || event.type === "GENERAL_STORE_CARD_REVEALED" || event.type === "JAIL_JUDGMENT_REVEALED" || event.type === "CARD_TRANSFERRED" || event.type === "CARD_DISCARDED") {
    const cardInstanceId = typeof payload.cardInstanceId === "string"
      ? payload.cardInstanceId
      : event.type === "JAIL_JUDGMENT_REVEALED" && typeof payload.judgmentCardInstanceId === "string"
        ? payload.judgmentCardInstanceId
        : undefined;
    if (!cardInstanceId || typeof payload.fromZone !== "string" || typeof payload.toZone !== "string") return undefined;
    const validZones: readonly string[] = ["draw_pile", "discard", "revealed_pool", "hand", "in_play"];
    if (!validZones.includes(payload.fromZone) || !validZones.includes(payload.toZone)) return undefined;
    const fromZone = payload.fromZone as ZoneName;
    const toZone = payload.toZone as ZoneName;
    const fromPlayerId = typeof payload.fromPlayerId === "string"
      ? payload.fromPlayerId
      : (fromZone === "hand" || fromZone === "in_play") && typeof payload.ownerPlayerId === "string" ? payload.ownerPlayerId : null;
    const toPlayerId = typeof payload.toPlayerId === "string"
      ? payload.toPlayerId
      : (toZone === "hand" || toZone === "in_play") && typeof payload.playerId === "string" ? payload.playerId : null;
    return moveCard(state, cardInstanceId, fromZone, fromPlayerId, toZone, toPlayerId);
  }
  return state;
}

function applyDrawEvents(state: GameState, events: readonly EffectEventDraft[]): GameState | undefined {
  let next = state;
  for (const event of events) {
    const applied = applyDrawEvent(next, event);
    if (!applied) return undefined;
    next = applied;
  }
  return next;
}

function drawEvent(
  actorPlayerId: string,
  cardInstanceId: string,
  fromZone: ZoneName,
  toZone: ZoneName,
  toPlayerId: string | null,
  extra: Readonly<Record<string, JsonValue>> = {},
): EffectEventDraft {
  return {
    type: "CARD_TRANSFERRED",
    actorPlayerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      fromZone,
      ...(fromZone === "hand" || fromZone === "in_play" ? { fromPlayerId: actorPlayerId } : {}),
      ...(toPlayerId === null ? {} : { toPlayerId }),
      toZone,
      ...extra,
    },
  };
}

function drawStep(frameId: string, actorPlayerId: string): EffectStep {
  return {
    effectId: `${frameId}:effect`,
    kind: "TURN_DRAW",
    sourcePlayerId: actorPlayerId,
    targetPlayerId: null,
    sourceCardInstanceId: null,
    payload: {},
  };
}

function frameFor(state: GameState): ResolutionFrame | undefined {
  const matches = state.resolution.continuations.filter((frame) => frame.kind === TURN_DRAW_FRAME_KIND);
  return matches.length === 1 ? matches[0] : undefined;
}

function completedInteractions(frame: ResolutionFrame): CharacterCompletedInteraction[] | undefined {
  const raw = frame.payload[INTERACTION_RESULTS_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const result: CharacterCompletedInteraction[] = [];
  for (const entry of raw) {
    const item = recordOf(entry);
    if (!item || typeof item.interactionId !== "string" || typeof item.kind !== "string" ||
        !recordOf(item.context) || !Array.isArray(item.responses)) return undefined;
    const responses = item.responses.map((response) => {
      const value = recordOf(response);
      if (!value || typeof value.playerId !== "string" || typeof value.choice !== "string" || !recordOf(value.payload)) return undefined;
      return { playerId: value.playerId, choice: value.choice, payload: value.payload as Record<string, JsonValue> };
    });
    if (responses.some((response) => response === undefined)) return undefined;
    result.push({
      interactionId: item.interactionId,
      kind: item.kind,
      context: item.context as Record<string, JsonValue>,
      responses: responses as CharacterCompletedInteraction["responses"],
    });
  }
  return result;
}

function latestInteraction(
  interactions: readonly CharacterCompletedInteraction[],
  kind: string,
): CharacterCompletedInteraction | undefined {
  for (let index = interactions.length - 1; index >= 0; index -= 1) {
    const interaction = interactions[index]!;
    if (interaction.kind !== kind || interaction.responses.length !== 1) continue;
    return interaction;
  }
  return undefined;
}

function actorCharacter(state: GameState, playerId: string) {
  return uniqueSeat(state, playerId)?.public.characterId;
}

function jesseHook(state: GameState) {
  const eligibleOpponentHands = state.seats
    .filter((seat) => seat.public.playerId !== state.turn.currentPlayerId && !seat.public.eliminated && seat.public.hp > 0 && seat.private.handCardInstanceIds.length > 0)
    .sort((left, right) => left.public.seatIndex - right.public.seatIndex)
    .map((seat) => ({ kind: "opponent_hand" as const, playerId: seat.public.playerId, handCardCount: seat.private.handCardInstanceIds.length, visibility: "recipient_only" as const }));
  return {
    kind: "draw_slot" as const,
    timing: "before" as const,
    distribution: { kind: "normal_turn" as const, position: "first" as const },
    sourceOptions: {
      drawPile: { kind: "draw_pile" as const, visibility: "recipient_only" as const },
      eligibleOpponentHands,
    },
  };
}

function pedroHook(state: GameState) {
  const discardTopCardInstanceId = state.zones.discardPileCardInstanceIds.at(-1);
  return {
    kind: "draw_slot" as const,
    timing: "before" as const,
    distribution: { kind: "normal_turn" as const, position: "first" as const },
    sourceOptions: {
      drawPile: { kind: "draw_pile" as const, visibility: "recipient_only" as const },
      discardTop: discardTopCardInstanceId
        ? { kind: "discard_top" as const, cardInstanceId: discardTopCardInstanceId, visibility: "public" as const }
        : null,
    },
  };
}

function kitHook(state: GameState, candidates: readonly [CardInstance, CardInstance, CardInstance]) {
  return {
    kind: "draw_phase" as const,
    timing: "before" as const,
    distribution: "normal_turn" as const,
    requestedCardCount: 2 as const,
    candidates,
    source: { kind: "draw_pile" as const },
    visibility: "recipient_only" as const,
  };
}

function emptyInteractions(): CharacterCompletedInteraction[] {
  return [];
}

function invokeSourceAbility(
  state: GameState,
  actorPlayerId: string,
  frameId: string,
  random: RandomSource,
  interactions: readonly CharacterCompletedInteraction[],
): { character: "jesse_jones" | "pedro_ramirez"; result: CharacterEffectResult } | undefined {
  const character = actorCharacter(state, actorPlayerId);
  if (character === "jesse_jones") {
    return {
      character,
      result: jesseJonesAbility({
        characterId: "jesse_jones", playerId: actorPlayerId, state: state as DeepReadonly<GameState>,
        continuationFrameId: frameId, random, completedInteractions: interactions, hook: jesseHook(state),
      }),
    };
  }
  if (character === "pedro_ramirez") {
    return {
      character,
      result: pedroRamirezAbility({
        characterId: "pedro_ramirez", playerId: actorPlayerId, state: state as DeepReadonly<GameState>,
        continuationFrameId: frameId, random, completedInteractions: interactions, hook: pedroHook(state),
      }),
    };
  }
  return undefined;
}

function supplyKitCandidates(
  state: GameState,
  actorPlayerId: string,
  random: RandomSource,
): { readonly state: GameState; readonly events: readonly EffectEventDraft[]; readonly candidates?: readonly [CardInstance, CardInstance, CardInstance] } | undefined {
  let next = state;
  const events: EffectEventDraft[] = [];
  const candidates: CardInstance[] = [];
  for (let index = 0; index < 3; index += 1) {
    const supply = planDrawPileSupply({
      drawPileCardInstanceIds: next.zones.drawPileCardInstanceIds,
      discardPileCardInstanceIds: next.zones.discardPileCardInstanceIds,
      requestedCount: 1,
      actorPlayerId,
      sourceCardInstanceId: null,
      destination: "peek",
      random,
    });
    const reshuffles = supply.events.filter((event) => event.type === "DRAW_PILE_RESHUFFLED");
    const appliedShuffleState = applyDrawEvents(next, reshuffles);
    if (!appliedShuffleState) return undefined;
    next = appliedShuffleState;
    events.push(...reshuffles);

    const cardInstanceId = supply.cardInstanceIds[0];
    if (!cardInstanceId) {
      const exhausted = supply.events.find((event) => event.type === "RULE_RESOURCE_EXHAUSTED");
      const rollback = [...candidates].reverse().map((card) => drawEvent(actorPlayerId, card.cardInstanceId, "revealed_pool", "draw_pile", null, { visibility: "recipient_only" }));
      const rolledBack = applyDrawEvents(next, rollback);
      if (!rolledBack) return undefined;
      next = rolledBack;
      events.push(...rollback);
      if (exhausted) {
        const paused = applyDrawEvents(next, [exhausted]);
        if (!paused) return undefined;
        next = paused;
        events.push(exhausted);
      }
      return { state: next, events };
    }

    const card = next.zones.cardsByInstanceId[cardInstanceId];
    if (!card || card.cardInstanceId !== cardInstanceId) return undefined;
    const reveal = drawEvent(actorPlayerId, cardInstanceId, "draw_pile", "revealed_pool", null, { visibility: "recipient_only" });
    const moved = applyDrawEvents(next, [reveal]);
    if (!moved) return undefined;
    next = moved;
    events.push(reveal);
    candidates.push(card);
  }
  if (candidates.length !== 3) return undefined;
  return { state: next, events, candidates: candidates as [CardInstance, CardInstance, CardInstance] };
}

function publicizeCardDraw(event: EffectEventDraft, card: CardInstance): EffectEventDraft {
  return {
    ...event,
    payload: { ...event.payload, visibility: "public", rank: card.rank, suit: card.suit, reason: "BLACK_JACK_SECOND_DRAW" },
  };
}

function drawOne(
  state: GameState,
  actorPlayerId: string,
  random: RandomSource,
  position: "first" | "second",
  revealPublicSecond: boolean,
): { readonly state: GameState; readonly events: readonly EffectEventDraft[]; readonly card?: CardInstance } | undefined {
  const supply = planDrawPileSupply({
    drawPileCardInstanceIds: state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds: state.zones.discardPileCardInstanceIds,
    requestedCount: 1,
    actorPlayerId,
    sourceCardInstanceId: null,
    destination: "hand",
    random,
  });
  const cardId = supply.cardInstanceIds[0];
  const card = cardId ? state.zones.cardsByInstanceId[cardId] : undefined;
  if (cardId && (!card || card.cardInstanceId !== cardId)) return undefined;
  const drafts = card && position === "second" && revealPublicSecond
    ? supply.events.map((event) => event.type === "CARD_DRAWN" ? publicizeCardDraw(event, card) : event)
    : supply.events;
  const next = applyDrawEvents(state, drafts);
  if (!next) return undefined;
  return { state: next, events: drafts, ...(card ? { card } : {}) };
}

function openChoice(
  state: GameState,
  frameId: string,
  result: Extract<CharacterEffectResult, { readonly kind: "choice_required" | "response_required" }>,
  nextInteractionIdentity: () => InteractionIdentity,
): { readonly state: GameState } | undefined {
  if (result.steps.length !== 0 || result.request.resumeFrameId !== frameId) return undefined;
  let identity: InteractionIdentity;
  try {
    identity = nextInteractionIdentity();
  } catch {
    return undefined;
  }
  if (!identity || typeof identity.interactionId !== "string" || !identity.interactionId.trim() ||
      typeof identity.createdAt !== "string" || !identity.createdAt.trim()) return undefined;
  const opened = openPendingInteraction(state, { ...result.request, ...identity });
  return opened.ok ? { state: opened.state } : undefined;
}

function beginDrawResolution(
  state: GameState,
  actorPlayerId: string,
  frameId: string,
  kitCandidateIds: readonly string[] = [],
): { readonly state: GameState; readonly step: EffectStep } | undefined {
  const step = drawStep(frameId, actorPlayerId);
  const continuation: ResolutionFrame = {
    frameId,
    kind: TURN_DRAW_FRAME_KIND,
    sourcePlayerId: actorPlayerId,
    sourceCardInstanceId: null,
    payload: { turnNumber: state.turn.turnNumber, actorPlayerId, kitCandidateIds: [...kitCandidateIds] },
  };
  const begun = beginEffectResolution(state, { continuation, steps: [step] });
  return begun.ok ? { state: begun.state, step } : undefined;
}

function finishDrawResolution(
  state: GameState,
  step: EffectStep,
  frameId: string,
  actorPlayerId: string,
  events: readonly EffectEventDraft[],
  inputRandomForBoundary: RandomSource,
): TurnPhaseResult {
  const suzyEvents = emptySuzyDrawEvents(state, inputRandomForBoundary, null);
  const withSuzy = applyDrawEvents(state, suzyEvents);
  if (!withSuzy) return failure("INVALID_DRAW_EVENT", "Suzy boundary draw did not match current zones.");
  state = withSuzy;
  events = [...events, ...suzyEvents];
  const popped = completeEffectStep(state, step);
  if (!popped.ok) return failure(popped.error.code, popped.error.message);
  const finished = finishEffectResolution(popped.state, step.effectId, frameId);
  if (!finished.ok) return failure(finished.error.code, finished.error.message);
  if (finished.state.status !== "playing") return success(finished.state, events, { kind: "draw_paused" });
  if (finished.state.pauseReason !== null) return success(finished.state, events, { kind: "draw_paused" });
  const transition = completeDraw(finished.state, actorPlayerId);
  if (!transition.ok) return failure(transition.error.code, transition.error.message);
  return success(transition.state, events, { kind: "draw_completed" });
}

function applyModuleEvents(state: GameState, result: CharacterEffectResult): GameState | undefined {
  if (result.kind !== "applied" && result.kind !== "choice_required" && result.kind !== "response_required") return undefined;
  if (result.steps.length !== 0) return undefined;
  return applyDrawEvents(state, result.events);
}

function modulePending(
  state: GameState,
  result: CharacterEffectResult,
  frameId: string,
  nextInteractionIdentity: () => InteractionIdentity,
): GameState | undefined {
  if (result.kind !== "choice_required" && result.kind !== "response_required") return undefined;
  return openChoice(state, frameId, result, nextInteractionIdentity)?.state;
}

function sourceChoiceConsumedFirstSlot(
  character: "jesse_jones" | "pedro_ramirez",
  interaction: CharacterCompletedInteraction | undefined,
): boolean {
  const response = interaction?.responses[0];
  if (!response) return false;
  if (character === "jesse_jones") return response.choice === "TAKE_FROM_HAND";
  return response.choice === "SELECT_SOURCE" && response.payload.source === "DISCARD_TOP";
}

function normalDraws(
  initialState: GameState,
  actorPlayerId: string,
  frameId: string,
  random: RandomSource,
  events: EffectEventDraft[],
  firstSlotReplaced: boolean,
  interactions: readonly CharacterCompletedInteraction[],
): { readonly state: GameState; readonly exhausted: boolean } | undefined {
  let state = initialState;
  const actorCharacterId = actorCharacter(state, actorPlayerId);
  const remainingPositions: readonly ("first" | "second")[] = firstSlotReplaced ? ["second"] : ["first", "second"];
  for (const position of remainingPositions) {
    const drawn = drawOne(state, actorPlayerId, random, position, actorCharacterId === "black_jack");
    if (!drawn) return undefined;
    state = drawn.state;
    events.push(...drawn.events);
    if (state.status !== "playing") return { state, exhausted: true };

    if (position === "second" && actorCharacterId === "black_jack" && drawn.card) {
      const hook = {
        kind: "draw_slot" as const,
        timing: "after" as const,
        distribution: { kind: "normal_turn" as const, position: "second" as const },
        source: { kind: "draw_pile" as const },
        visibility: "public" as const,
        card: drawn.card as DeepReadonly<CardInstance>,
      };
      const result = blackJackAbility({
        characterId: "black_jack", playerId: actorPlayerId, state: state as DeepReadonly<GameState>,
        continuationFrameId: frameId, random, completedInteractions: interactions, hook,
      });
      const next = applyModuleEvents(state, result);
      if (!next) return undefined;
      state = next;
      events.push(...result.events);
    }
  }
  return { state, exhausted: state.status !== "playing" };
}

function resumeDraw(input: TurnDrawInput, frame: ResolutionFrame): TurnPhaseResult {
  const frameId = frame.frameId;
  const actorPlayerId = input.actorPlayerId;
  if (frame.sourcePlayerId !== actorPlayerId || frame.payload.actorPlayerId !== actorPlayerId ||
      frame.payload.turnNumber !== input.state.turn.turnNumber || input.state.turn.currentPlayerId !== actorPlayerId ||
      input.state.turn.phase !== "draw" || input.state.resolution.pendingInteraction !== null) {
    return failure("INVALID_STATE", "The saved draw continuation does not match this active draw phase.");
  }
  const step = input.state.resolution.effectQueue[0];
  if (!step || step.kind !== "TURN_DRAW" || step.effectId !== `${frameId}:effect`) {
    return failure("INVALID_STATE", "The saved draw continuation has no matching draw step.");
  }
  const interactions = completedInteractions(frame);
  if (!interactions) return failure("INVALID_STATE", "Saved draw interaction history is malformed.");

  const events: EffectEventDraft[] = [];
  const character = actorCharacter(input.state, actorPlayerId);
  if (character === "kit_carlson") {
    const candidateIds = frame.payload.kitCandidateIds;
    if (!Array.isArray(candidateIds) || candidateIds.length !== 3 || candidateIds.some((id) => typeof id !== "string")) {
      return failure("INVALID_STATE", "Kit Carlson's saved candidate list is malformed.");
    }
    const cards = candidateIds.map((id) => input.state.zones.cardsByInstanceId[id as string]);
    if (cards.some((card) => !card)) return failure("INVALID_STATE", "A saved Kit candidate is missing from the card catalog.");
    const hook = kitHook(input.state, cards as [CardInstance, CardInstance, CardInstance]);
    const result = kitCarlsonAbility({
      characterId: "kit_carlson", playerId: actorPlayerId, state: input.state as DeepReadonly<GameState>,
      continuationFrameId: frameId, random: input.random, completedInteractions: interactions, hook,
    });
    if (result.kind !== "applied") return failure("INVALID_STATE", "Kit Carlson did not complete its saved card choice.");
    const applied = applyModuleEvents(input.state, result);
    if (!applied) return failure("INVALID_DRAW_EVENT", "Kit Carlson returned an event that does not match the current card zones.");
    events.push(...result.events);
    return finishDrawResolution(applied, step, frameId, actorPlayerId, events, input.random);
  }

  const source = invokeSourceAbility(input.state, actorPlayerId, frameId, input.random, interactions);
  let state = input.state;
  let firstSlotReplaced = false;
  if (source) {
    const result = source.result;
    if (result.kind === "choice_required" || result.kind === "response_required") {
      return failure("INVALID_STATE", "A completed source choice unexpectedly requested another interaction.");
    }
    const applied = applyModuleEvents(state, result);
    if (!applied) return failure("INVALID_DRAW_EVENT", "A draw source ability returned an unsupported event.");
    state = applied;
    events.push(...result.events);
    const completedSourceChoice = latestInteraction(
      interactions,
      source.character === "jesse_jones" ? "JESSE_DRAW_SOURCE" : "PEDRO_DISCARD_TOP",
    );
    const selectedAlternateSource = sourceChoiceConsumedFirstSlot(source.character, completedSourceChoice);
    const sourceMoved = result.events.some((event) => event.type === "CARD_TRANSFERRED" &&
      (source.character === "jesse_jones" ? event.payload.fromZone === "hand" : event.payload.fromZone === "discard"));
    if (selectedAlternateSource !== sourceMoved) {
      return failure("INVALID_STATE", "The saved alternate-source choice and card transfer do not agree.");
    }
    firstSlotReplaced = selectedAlternateSource;
  }

  const draw = normalDraws(state, actorPlayerId, frameId, input.random, events, firstSlotReplaced, interactions);
  if (!draw) return failure("INVALID_DRAW_EVENT", "Draw supply or a character module returned an event that does not match the current card zones.");
  return finishDrawResolution(draw.state, step, frameId, actorPlayerId, events, input.random);
}

/** Executes or resumes one two-card turn draw, including its character hooks. */
export function executeTurnDraw(input: TurnDrawInput): TurnPhaseResult {
  const savedFrame = frameFor(input.state);
  if (savedFrame) {
    const pending = input.state.resolution.pendingInteraction;
    if (pending) return success(input.state, [], { kind: "interaction_pending", interactionKind: pending.kind });
    return resumeDraw(input, savedFrame);
  }
  const issue = currentTurnError(input.state, input.actorPlayerId, "draw");
  if (issue) return { ok: false, error: issue };
  if (!resolutionIdle(input.state)) return failure("ILLEGAL_PHASE", "Drawing is blocked while another resolution is active.");

  const frameId = input.continuationFrameId ?? `turn:${input.state.turn.turnNumber}:${input.actorPlayerId}:draw`;
  const events: EffectEventDraft[] = [];
  let state = input.state;
  let kitCandidates: readonly [CardInstance, CardInstance, CardInstance] | undefined;
  if (actorCharacter(state, input.actorPlayerId) === "kit_carlson") {
    const supplied = supplyKitCandidates(state, input.actorPlayerId, input.random);
    if (!supplied) return failure("INVALID_DRAW_EVENT", "Kit candidate supply did not match the current draw and discard piles.");
    state = supplied.state;
    events.push(...supplied.events);
    kitCandidates = supplied.candidates;
  }

  const begun = beginDrawResolution(input.state, input.actorPlayerId, frameId, kitCandidates?.map(({ cardInstanceId }) => cardInstanceId) ?? []);
  if (!begun) return failure("ILLEGAL_PHASE", "A T12 draw continuation could not be started.");
  const withCandidateEvents = applyDrawEvents(begun.state, events);
  if (!withCandidateEvents) return failure("INVALID_DRAW_EVENT", "Kit candidate events could not be applied to the T12 draw continuation.");
  state = withCandidateEvents;
  if (state.status !== "playing") return finishDrawResolution(state, begun.step, frameId, input.actorPlayerId, events, input.random);

  if (kitCandidates) {
    const hook = kitHook(state, kitCandidates);
    const result = kitCarlsonAbility({
      characterId: "kit_carlson", playerId: input.actorPlayerId, state: state as DeepReadonly<GameState>,
      continuationFrameId: frameId, random: input.random, completedInteractions: emptyInteractions(), hook,
    });
    if (result.kind === "choice_required" || result.kind === "response_required") {
      const opened = modulePending(state, result, frameId, input.nextInteractionIdentity);
      return opened
        ? success(opened, events, { kind: "interaction_pending", interactionKind: result.request.kind })
        : failure("INTERACTION_METADATA_REQUIRED", "Kit's private selection needs a valid T12 interaction identity.");
    }
    const applied = applyModuleEvents(state, result);
    if (!applied) return failure("INVALID_DRAW_EVENT", "Kit Carlson returned an unsupported draw event.");
    events.push(...result.events);
    return finishDrawResolution(applied, begun.step, frameId, input.actorPlayerId, events, input.random);
  }

  const source = invokeSourceAbility(state, input.actorPlayerId, frameId, input.random, emptyInteractions());
  let firstSlotReplaced = false;
  let interactions = emptyInteractions();
  if (source && source.result.kind === "choice_required") {
    const opened = modulePending(state, source.result, frameId, input.nextInteractionIdentity);
    return opened
      ? success(opened, events, { kind: "interaction_pending", interactionKind: source.result.request.kind })
      : failure("INTERACTION_METADATA_REQUIRED", "The private draw source choice needs a valid T12 interaction identity.");
  }
  if (source && source.result.kind === "response_required") {
    const opened = modulePending(state, source.result, frameId, input.nextInteractionIdentity);
    return opened
      ? success(opened, events, { kind: "interaction_pending", interactionKind: source.result.request.kind })
      : failure("INTERACTION_METADATA_REQUIRED", "The draw source response needs a valid T12 interaction identity.");
  }
  if (source) {
    const applied = applyModuleEvents(state, source.result);
    if (!applied) return failure("INVALID_DRAW_EVENT", "A draw source ability returned an unsupported event.");
    state = applied;
    events.push(...source.result.events);
  }

  const draw = normalDraws(state, input.actorPlayerId, frameId, input.random, events, firstSlotReplaced, interactions);
  if (!draw) return failure("INVALID_DRAW_EVENT", "Draw supply or a character module returned an event that does not match the current card zones.");
  return finishDrawResolution(draw.state, begun.step, frameId, input.actorPlayerId, events, input.random);
}

