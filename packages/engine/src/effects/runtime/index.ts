import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { gatlingEffect, indiansEffect } from "../cards/tablewide.js";
import {
  type CommandExecutionHandlers,
  type CommandExecutionResult,
  type EngineCommand,
  type EngineCommandErrorCode,
  type PlayCardExecutionInput,
  type AbilityExecutionInput,
  type CompletedInteractionExecutionInput,
} from "../../commands/index.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  DeepReadonly,
  EffectEventDraft,
  EffectTarget,
} from "../api.js";
import {
  resolveBarrelCheckStep,
  type ResolveBarrelCheckStepInput,
} from "../cards/dynamite-barrel.js";
import type {
  CharacterAbilityHook,
  CharacterAbilityId,
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterCardReference,
  CharacterEffectResult,
  BaseCardTypeId,
  DamageCause,
  DamageResolvedHookInput,
  SuzyAfterCardEffectHookInput,
  SuzyAfterResponseHookInput,
} from "../character-api.js";
import { advanceAfterCurrentPlayerElimination, skipTurnAfterStartResolution } from "../../turn/reducer.js";
import { emptySuzyDrawEvents } from "../characters/suzy-lafayette.js";
import { checkVictoryAtBoundary, beginElimination, advanceElimination } from "../../endgame/index.js";
import {
  beginDeathRescue,
  beginEffectResolution,
  completeDeathRescue,
  completeEffectStep,
  finishEffectResolution,
  openPendingInteraction,
  submitInteractionResponse,
} from "../../resolution/index.js";
import type { RandomSource } from "../../random/shuffle.js";
import type { EffectStep, GameState, InteractionOption, JsonValue, PendingInteraction, ResolutionFrame, SeatState } from "../../state/types.js";
import type { TablewideAttackView } from "../../../../contracts/src/protocol.js";

const FRAME_KIND = "EFFECT_RUNTIME";
const INTERACTION_RESULTS_KEY = "__resolutionResults";
const SUZY_RESPONSE_HOOKS_KEY = "__suzyResponseHookInteractions";
const RUN_EFFECT = "RUN_EFFECT";
const RUN_DAMAGE_HOOK = "RUN_DAMAGE_HOOK";
const MAX_STEPS_PER_COMMAND = 512;
const EARLY_RESPONSES_KEY = "__tablewideEarlyResponses";
const TABLEWIDE_TARGETS_KEY = "__tablewideTargets";
const TABLEWIDE_ATTACK_ID_KEY = "__tablewideAttackId";

function tablewideFrame(state: GameState): ResolutionFrame | undefined {
  return state.resolution.continuations.find(frame => frame.kind === FRAME_KIND &&
    ["gatling", "indians"].includes(runtimeContext(frame)?.effectTypeId ?? ""));
}

function earlyResponses(frame: ResolutionFrame): CompletedEffectInteraction[] {
  const value = frame.payload[EARLY_RESPONSES_KEY];
  return Array.isArray(value) ? value as unknown as CompletedEffectInteraction[] : [];
}

/** A future target may commit its exact choice while the earlier target resolves. */
export function earlyTablewideInteraction(state: GameState, playerId: string): PendingInteraction | null {
  if (state.status !== "playing" || state.resolution.pendingInteraction?.actorPlayerIds.includes(playerId)) return null;
  const frame = tablewideFrame(state), context = frame && runtimeContext(frame);
  if (!frame || !context || typeof frame.payload[TABLEWIDE_ATTACK_ID_KEY] !== "string" || earlyResponses(frame).some(response => response.responses.some(answer => answer.playerId === playerId))) return null;
  const step = state.resolution.effectQueue.find(step => ["GATLING_TARGET", "INDIANS_TARGET"].includes(step.kind) && step.targetPlayerId === playerId);
  if (!step || !uniqueSeat(state, playerId) || uniqueSeat(state, playerId)!.public.eliminated) return null;
  const module = context.effectTypeId === "gatling" ? gatlingEffect : indiansEffect;
  const result = module(moduleCardInput(state, context, frame.frameId, [{ kind: "player", playerId }], { nextFloat: () => 0.5 }, completedInteractions(frame) ?? []));
  if (result.kind !== "response_required") return null;
  // Build a candidate prompt independently of another target's rescue cursor.
  // Collection writes only to the original frame and keeps the real pending death intact.
  const opened = openPendingInteraction({ ...state, resolution: { ...state.resolution, pendingInteraction: null, pendingDeath: null } }, {
    interactionId: `${frame.payload[TABLEWIDE_ATTACK_ID_KEY]}:tablewide:${playerId}`,
    kind: result.request.kind,
    responders: result.request.responders,
    context: result.request.context,
    resumeFrameId: frame.frameId,
    createdAt: state.resolution.pendingInteraction?.createdAt ?? "2000-01-01T00:00:00.000Z",
  });
  return opened.ok ? opened.state.resolution.pendingInteraction : null;
}

/** A valid independent response can be revalidated against a newer aggregate version. */
export function isConcurrentTablewideResponse(state: GameState, playerId: string, command: EngineCommand): boolean {
  if (command.type !== "RESPOND" || state.status !== "playing" || !tablewideFrame(state)) return false;
  const pending = state.resolution.pendingInteraction;
  if (pending && ["GATLING_RESPONSE", "INDIANS_RESPONSE"].includes(pending.kind) &&
      pending.actorPlayerIds.includes(playerId) && pending.interactionId === command.payload.interactionId) return true;
  return earlyTablewideInteraction(state, playerId)?.interactionId === command.payload.interactionId;
}

export function projectTablewideAttack(state: GameState): TablewideAttackView | null {
  const frame = tablewideFrame(state), context = frame && runtimeContext(frame);
  const rawTargets = frame?.payload[TABLEWIDE_TARGETS_KEY];
  if (!frame || !context || !Array.isArray(rawTargets) || typeof frame.payload[TABLEWIDE_ATTACK_ID_KEY] !== "string") return null;
  const pending = state.resolution.pendingInteraction;
  const reserved = earlyResponses(frame);
  const completed = completedInteractions(frame) ?? [];
  return {
    attackId: frame.payload[TABLEWIDE_ATTACK_ID_KEY], kind: context.effectTypeId === "gatling" ? "gatling" : "indians", sourcePlayerId: context.actorPlayerId,
    targets: rawTargets.flatMap(id => {
      if (typeof id !== "string") return [];
      const seat = uniqueSeat(state, id);
      if (!seat) return [];
      const status = seat.public.eliminated ? "eliminated" : pending?.actorPlayerIds.includes(id) ? "responding" :
        state.resolution.effectQueue.some(step => step.targetPlayerId === id) ?
          reserved.some(response => response.responses.some(answer => answer.playerId === id)) ? "submitted" : "waiting" : "resolved";
      const interactionKind = context.effectTypeId === "gatling" ? "GATLING_RESPONSE" : "INDIANS_RESPONSE";
      const matches = (interaction: CompletedEffectInteraction) => interaction.kind === interactionKind &&
        interaction.context.sourcePlayerId === context.actorPlayerId && interaction.context.targetPlayerId === id;
      const answer = ([...completed].reverse().find(matches) ?? [...reserved].reverse().find(matches))?.responses.find(response => response.playerId === id);
      const choice = answer?.choice;
      const response = choice === "USE_BANG" || choice === "USE_MISSED" || choice === "USE_BARREL" || choice === "USE_JOURDONNAIS" || choice === "TAKE_HIT" ? choice : undefined;
      return [{ playerId: id, status, ...(response && status !== "waiting" ? { response } : {}) }];
    }),
  };
}

function collectTablewideResponse(input: { state: GameState; actorPlayerId: string; command: Extract<EngineCommand, { type: "RESPOND" }> }): CommandExecutionResult | null {
  const pending = earlyTablewideInteraction(input.state, input.actorPlayerId);
  if (!pending || input.command.payload.interactionId !== pending.interactionId) return null;
  const { interactionId, choice, ...payload } = input.command.payload;
  const answered = submitInteractionResponse({ ...input.state, resolution: { ...input.state.resolution, pendingInteraction: pending } }, {
    actorPlayerId: input.actorPlayerId, interactionId, choice, payload: payload as Record<string, JsonValue>,
  });
  if (!answered.ok) return commandFailure(answered.error.code, answered.error.message);
  const frame = tablewideFrame(input.state)!;
  const answer = completedInteractions(frameFor(answered.state, frame.frameId)!)?.at(-1);
  if (!answer) return commandFailure("INVALID_STATE", "An independent response did not produce a saved choice.");
  const updated = updateFramePayload(input.state, frame.frameId, { [EARLY_RESPONSES_KEY]: [...earlyResponses(frame), answer] as unknown as JsonValue });
  if (!updated.ok) return commandFailure(updated.code, updated.message);
  return safeResult(updated.value, [eventDraft("TABLEWIDE_RESPONSE_SUBMITTED", input.actorPlayerId, { playerId: input.actorPlayerId })], { kind: "response_submitted" });
}

type RuntimeCardRegistry = Readonly<Record<string, CardEffectModule | undefined>>;
type RuntimeCharacterRegistry = Partial<{
  [CharacterId in CharacterAbilityId]: CharacterAbilityModule<CharacterId>;
}>;
type RuntimeCharacterInvoker = (input: CharacterAbilityInput<CharacterAbilityId>) => CharacterEffectResult;

export interface InteractionIdentity {
  readonly interactionId: string;
  readonly createdAt: string;
}

export interface EffectRuntimeRegistry {
  /** Card modules are indexed by the effective catalog type ID (after conversion). */
  readonly cards: RuntimeCardRegistry;
  /** Character modules are injected by the eventual static registry. */
  readonly characters?: RuntimeCharacterRegistry;
}

export interface EffectRuntimeOptions {
  readonly registry: EffectRuntimeRegistry;
  /** Every T12 interaction gets a caller-allocated, replayable identity and timestamp. */
  readonly nextInteractionIdentity: () => InteractionIdentity;
}

interface RuntimeContext {
  readonly actorPlayerId: string;
  readonly effectId: string;
  readonly mode: "card" | "character";
  readonly effectTypeId: string | null;
  readonly abilityId: string | null;
  readonly sourceCardInstanceId: string | null;
  readonly targets: readonly EffectTarget[];
  readonly costCardInstanceIds: readonly string[];
}

interface RuntimeRunResult {
  readonly state: GameState;
  readonly events: readonly EffectEventDraft[];
  readonly value: JsonValue;
}

interface InternalResult<T> {
  readonly ok: true;
  readonly value: T;
}

interface InternalFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

type Internal<T> = InternalResult<T> | InternalFailure;

function fail(code: string, message: string): InternalFailure {
  return { ok: false, code, message };
}

function commandFailure(code: string, message: string): CommandExecutionResult {
  return { ok: false, error: { code: code as EngineCommandErrorCode, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asJsonRecord(value: unknown): Record<string, JsonValue> | undefined {
  if (!isRecord(value)) return undefined;
  return value as Record<string, JsonValue>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nullableStringField(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  return value === null ? null : typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function frameFor(state: GameState, frameId: string): ResolutionFrame | undefined {
  const matches = state.resolution.continuations.filter((frame) => frame.frameId === frameId);
  return matches.length === 1 ? matches[0] : undefined;
}

function frameIndex(state: GameState, frameId: string): number {
  const matches = state.resolution.continuations
    .map((frame, index) => frame.frameId === frameId ? index : -1)
    .filter((index) => index >= 0);
  return matches.length === 1 ? matches[0]! : -1;
}

function replaceFrame(state: GameState, frameId: string, frame: ResolutionFrame): GameState | undefined {
  const index = frameIndex(state, frameId);
  if (index < 0) return undefined;
  const continuations = [...state.resolution.continuations];
  continuations[index] = frame;
  return { ...state, resolution: { ...state.resolution, continuations } };
}

function runtimeContext(frame: ResolutionFrame): RuntimeContext | undefined {
  if (frame.kind !== FRAME_KIND) return undefined;
  const payload = frame.payload;
  const actorPlayerId = stringField(payload, "actorPlayerId");
  const effectId = stringField(payload, "effectId");
  const mode = payload.mode;
  const effectTypeId = nullableStringField(payload, "effectTypeId");
  const abilityId = nullableStringField(payload, "abilityId");
  const sourceCardInstanceId = nullableStringField(payload, "sourceCardInstanceId");
  const targets = payload.targets;
  const costCardInstanceIds = payload.costCardInstanceIds;
  if (!actorPlayerId || !effectId || (mode !== "card" && mode !== "character") ||
      effectTypeId === undefined || abilityId === undefined || sourceCardInstanceId === undefined ||
      !Array.isArray(targets) || !Array.isArray(costCardInstanceIds) ||
      targets.some((target) => !isRecord(target) || typeof target.kind !== "string") ||
      costCardInstanceIds.some((cardId) => typeof cardId !== "string")) return undefined;
  return {
    actorPlayerId,
    effectId,
    mode,
    effectTypeId,
    abilityId,
    sourceCardInstanceId,
    targets: targets as unknown as EffectTarget[],
    costCardInstanceIds: costCardInstanceIds as string[],
  };
}

function completedInteractions(frame: ResolutionFrame): CompletedEffectInteraction[] | undefined {
  const raw = frame.payload[INTERACTION_RESULTS_KEY];
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return undefined;
  const results: CompletedEffectInteraction[] = [];
  for (const item of raw) {
    if (!isRecord(item) || typeof item.interactionId !== "string" || typeof item.kind !== "string" ||
        !isRecord(item.context) || !Array.isArray(item.responses)) return undefined;
    const responses = item.responses.flatMap((response) => {
      if (!isRecord(response) || typeof response.playerId !== "string" || typeof response.choice !== "string" || !isRecord(response.payload)) return [];
      return [{
        playerId: response.playerId,
        choice: response.choice,
        payload: response.payload as Record<string, JsonValue>,
      }];
    });
    if (responses.length !== item.responses.length) return undefined;
    results.push({
      interactionId: item.interactionId,
      kind: item.kind,
      context: item.context as Record<string, JsonValue>,
      responses,
    });
  }
  return results;
}

function cardTypeId(state: GameState, cardInstanceId: string | null): BaseCardTypeId | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  if (!instance || instance.cardInstanceId !== cardInstanceId) return undefined;
  return BASE_PHYSICAL_CARDS.find((card) => card.definitionId === instance.cardDefinitionId)?.typeId as BaseCardTypeId | undefined;
}

function targetsFromCommand(command: Extract<EngineCommand, { type: "PLAY_CARD" }>): EffectTarget[] {
  const payload = command.payload;
  if (!payload.targetPlayerId) return [];
  if (payload.targetZone === "HAND") return [{ kind: "hand", playerId: payload.targetPlayerId }];
  if (payload.targetZone === "IN_PLAY" && payload.targetCardInstanceId) {
    return [{ kind: "in_play_card", playerId: payload.targetPlayerId, cardInstanceId: payload.targetCardInstanceId }];
  }
  return [{ kind: "player", playerId: payload.targetPlayerId }];
}

function step(
  effectId: string,
  kind: string,
  sourcePlayerId: string | null,
  targetPlayerId: string | null,
  sourceCardInstanceId: string | null,
  payload: Record<string, JsonValue> = {},
): EffectStep {
  return { effectId, kind, sourcePlayerId, targetPlayerId, sourceCardInstanceId, payload };
}

function eventDraft(
  type: string,
  actorPlayerId: string | null,
  payload: Record<string, JsonValue>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function locationOf(state: GameState, cardInstanceId: string): { zone: string; playerId: string | null }[] {
  const locations: { zone: string; playerId: string | null }[] = [];
  for (const seat of state.seats) {
    if (seat.private.handCardInstanceIds.includes(cardInstanceId)) locations.push({ zone: "hand", playerId: seat.public.playerId });
    if (seat.public.inPlayCardInstanceIds.includes(cardInstanceId)) locations.push({ zone: "in_play", playerId: seat.public.playerId });
  }
  if (state.zones.drawPileCardInstanceIds.includes(cardInstanceId)) locations.push({ zone: "draw_pile", playerId: null });
  if (state.zones.discardPileCardInstanceIds.includes(cardInstanceId)) locations.push({ zone: "discard", playerId: null });
  if (state.zones.revealedPoolCardInstanceIds.includes(cardInstanceId)) locations.push({ zone: "revealed_pool", playerId: null });
  return locations;
}

function removeCardFromZone(
  state: GameState,
  cardInstanceId: string,
  fromZone: string,
  fromPlayerId: string | null,
): GameState | undefined {
  const locations = locationOf(state, cardInstanceId);
  if (locations.length !== 1 || locations[0]!.zone !== fromZone ||
      (fromZone === "hand" || fromZone === "in_play") && locations[0]!.playerId !== fromPlayerId) return undefined;
  if (fromZone === "hand" || fromZone === "in_play") {
    if (fromPlayerId === null) return undefined;
    return {
      ...state,
      seats: state.seats.map((seat) => {
        if (seat.public.playerId !== fromPlayerId) return seat;
        return fromZone === "hand"
          ? { ...seat, private: { ...seat.private, handCardInstanceIds: seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId) } }
          : { ...seat, public: { ...seat.public, inPlayCardInstanceIds: seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId) } };
      }),
    };
  }
  if (fromZone === "draw_pile") return { ...state, zones: { ...state.zones, drawPileCardInstanceIds: state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId) } };
  if (fromZone === "discard") return { ...state, zones: { ...state.zones, discardPileCardInstanceIds: state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId) } };
  if (fromZone === "revealed_pool") return { ...state, zones: { ...state.zones, revealedPoolCardInstanceIds: state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId) } };
  return undefined;
}

function addCardToZone(
  state: GameState,
  cardInstanceId: string,
  toZone: string,
  toPlayerId: string | null,
): GameState | undefined {
  if (locationOf(state, cardInstanceId).length !== 0) return undefined;
  if (toZone === "hand" || toZone === "in_play") {
    if (toPlayerId === null) return undefined;
    const seat = uniqueSeat(state, toPlayerId);
    if (!seat) return undefined;
    return {
      ...state,
      seats: state.seats.map((item) => item.public.playerId !== toPlayerId ? item : toZone === "hand"
        ? { ...item, private: { ...item.private, handCardInstanceIds: [...item.private.handCardInstanceIds, cardInstanceId] } }
        : { ...item, public: { ...item.public, inPlayCardInstanceIds: [...item.public.inPlayCardInstanceIds, cardInstanceId] } }),
    };
  }
  if (toZone === "draw_pile") return { ...state, zones: { ...state.zones, drawPileCardInstanceIds: [cardInstanceId, ...state.zones.drawPileCardInstanceIds] } };
  if (toZone === "discard") return { ...state, zones: { ...state.zones, discardPileCardInstanceIds: [...state.zones.discardPileCardInstanceIds, cardInstanceId] } };
  if (toZone === "revealed_pool") return { ...state, zones: { ...state.zones, revealedPoolCardInstanceIds: [...state.zones.revealedPoolCardInstanceIds, cardInstanceId] } };
  return undefined;
}

function moveCard(
  state: GameState,
  cardInstanceId: string,
  fromZone: string,
  fromPlayerId: string | null,
  toZone: string,
  toPlayerId: string | null,
): GameState | undefined {
  if (!state.zones.cardsByInstanceId[cardInstanceId]) return undefined;
  const removed = removeCardFromZone(state, cardInstanceId, fromZone, fromPlayerId);
  if (!removed) return undefined;
  return addCardToZone(removed, cardInstanceId, toZone, toPlayerId);
}

function applyEvent(state: GameState, draft: EffectEventDraft): Internal<GameState> {
  const payload = asJsonRecord(draft.payload);
  if (!payload) return fail("INVALID_EFFECT_EVENT", "Effect event payload must be a JSON object.");
  if (draft.type === "CARD_TRANSFERRED" || draft.type === "CARD_DISCARDED" || draft.type === "CARD_DRAWN" ||
      draft.type === "GENERAL_STORE_CARD_REVEALED" || draft.type === "JAIL_JUDGMENT_REVEALED") {
    const cardInstanceId = stringField(payload, "cardInstanceId") ?? stringField(payload, "judgmentCardInstanceId");
    if (!cardInstanceId) return fail("INVALID_EFFECT_EVENT", `${draft.type} needs a card instance ID.`);
    const fromZone = stringField(payload, "fromZone") ?? (draft.type === "JAIL_JUDGMENT_REVEALED" ? "draw_pile" : undefined);
    if (!fromZone) return fail("INVALID_EFFECT_EVENT", `${draft.type} needs a source zone.`);
    const fromPlayerId = nullableStringField(payload, "fromPlayerId") ??
      (fromZone === "hand" || fromZone === "in_play" ? nullableStringField(payload, "ownerPlayerId") ?? null : null);
    const toZone = stringField(payload, "toZone") ??
      (draft.type === "CARD_DRAWN" ? "hand" : draft.type === "GENERAL_STORE_CARD_REVEALED" || draft.type === "JAIL_JUDGMENT_REVEALED" ? "revealed_pool" : undefined);
    if (!toZone) return fail("INVALID_EFFECT_EVENT", `${draft.type} needs a destination zone.`);
    const toPlayerId = nullableStringField(payload, "toPlayerId") ??
      (toZone === "hand" || toZone === "in_play" ? nullableStringField(payload, "playerId") ?? null : null);
    const moved = moveCard(state, cardInstanceId, fromZone, fromPlayerId, toZone, toPlayerId);
    return moved ? { ok: true, value: moved } : fail("INVALID_EFFECT_EVENT", `${draft.type} does not match the current card zones.`);
  }
  if (draft.type === "DRAW_PILE_RESHUFFLED") {
    const cardInstanceIds = payload.cardInstanceIds;
    if (!Array.isArray(cardInstanceIds) || cardInstanceIds.some((value) => typeof value !== "string")) {
      return fail("INVALID_EFFECT_EVENT", "DRAW_PILE_RESHUFFLED needs an ordered card ID list.");
    }
    const ids = cardInstanceIds as string[];
    if (ids.length !== state.zones.discardPileCardInstanceIds.length ||
        new Set(ids).size !== ids.length || ids.some((id) => !state.zones.discardPileCardInstanceIds.includes(id))) {
      return fail("INVALID_EFFECT_EVENT", "DRAW_PILE_RESHUFFLED must contain the current discard pile exactly once.");
    }
    return { ok: true, value: { ...state, zones: { ...state.zones, drawPileCardInstanceIds: ids, discardPileCardInstanceIds: [] } } };
  }
  if (draft.type === "MISSED_USED") {
    const cardInstanceId = stringField(payload, "cardInstanceId");
    if (!cardInstanceId) return fail("INVALID_EFFECT_EVENT", "MISSED_USED needs a card instance ID.");
    const owner = uniqueSeat(state, draft.actorPlayerId ?? "");
    const moved = moveCard(state, cardInstanceId, "hand", owner?.public.playerId ?? null, "discard", null);
    return moved ? { ok: true, value: moved } : fail("INVALID_EFFECT_EVENT", "MISSED_USED does not refer to its actor's hand card.");
  }
  if (draft.type === "BANG_MISSED") {
    const cardInstanceId = stringField(payload, "missedCardInstanceId");
    // Barrel/Jourdonnais success also records a BANG_MISSED event, but the
    // judgment card (rather than a Missed! hand card) completed that defense.
    if (!cardInstanceId) return { ok: true, value: state };
    const ownerId = stringField(payload, "targetPlayerId");
    const moved = cardInstanceId && ownerId ? moveCard(state, cardInstanceId, "hand", ownerId, "discard", null) : undefined;
    return moved ? { ok: true, value: moved } : fail("INVALID_EFFECT_EVENT", "BANG_MISSED does not refer to the target's hand card.");
  }
  if (draft.type === "RULE_RESOURCE_EXHAUSTED") {
    return { ok: true, value: { ...state, status: "paused", pauseReason: "RULE_RESOURCE_EXHAUSTED" } };
  }
  return { ok: true, value: state };
}

function eventAlreadyMovesCard(events: readonly EffectEventDraft[], cardInstanceId: string): boolean {
  return events.some((draft) => {
    if (!["CARD_TRANSFERRED", "CARD_DISCARDED", "CARD_DRAWN", "GENERAL_STORE_CARD_REVEALED", "JAIL_JUDGMENT_REVEALED", "MISSED_USED", "BANG_MISSED"].includes(draft.type)) return false;
    const payload = asJsonRecord(draft.payload);
    if (!payload) return false;
    return payload.cardInstanceId === cardInstanceId || payload.missedCardInstanceId === cardInstanceId ||
      payload.judgmentCardInstanceId === cardInstanceId;
  });
}

function discardEvent(cardInstanceId: string, ownerPlayerId: string, sourceCardInstanceId: string | null): EffectEventDraft {
  return eventDraft("CARD_DISCARDED", ownerPlayerId, {
    sourceCardInstanceId,
    cardInstanceId,
    ownerPlayerId,
    fromZone: "hand",
    toZone: "discard",
  });
}

function cardCostEvents(
  state: GameState,
  actorPlayerId: string,
  cardIds: readonly string[],
  alreadyEmitted: readonly EffectEventDraft[],
  sourceCardInstanceId: string | null,
): Internal<EffectEventDraft[]> {
  const seat = uniqueSeat(state, actorPlayerId);
  if (!seat) return fail("INVALID_STATE", "Effect actor does not identify exactly one player.");
  const events: EffectEventDraft[] = [];
  for (const cardId of cardIds) {
    if (!seat.private.handCardInstanceIds.includes(cardId)) return fail("INVALID_ABILITY_COST", "A character ability cost card is no longer in the actor's hand.");
    if (!eventAlreadyMovesCard(alreadyEmitted, cardId)) events.push(discardEvent(cardId, actorPlayerId, sourceCardInstanceId));
  }
  return { ok: true, value: events };
}

function sourceCardEvent(
  state: GameState,
  actorPlayerId: string,
  sourceCardInstanceId: string | null,
  events: readonly EffectEventDraft[],
): EffectEventDraft[] {
  if (!sourceCardInstanceId || eventAlreadyMovesCard(events, sourceCardInstanceId)) return [...events];
  const actor = uniqueSeat(state, actorPlayerId);
  if (!actor?.private.handCardInstanceIds.includes(sourceCardInstanceId)) return [...events];
  return [discardEvent(sourceCardInstanceId, actorPlayerId, sourceCardInstanceId), ...events];
}

function applyEvents(state: GameState, drafts: readonly EffectEventDraft[]): Internal<{ state: GameState; events: EffectEventDraft[] }> {
  let candidate = state;
  const applied: EffectEventDraft[] = [];
  for (const draft of drafts) {
    const next = applyEvent(candidate, draft);
    if (!next.ok) return next;
    candidate = next.value;
    applied.push(draft);
  }
  return { ok: true, value: { state: candidate, events: applied } };
}

function replaceQueue(state: GameState, effectQueue: readonly EffectStep[]): GameState {
  return { ...state, resolution: { ...state.resolution, effectQueue: [...effectQueue] } };
}

function insertStepsAfterHead(state: GameState, current: EffectStep, additions: readonly EffectStep[]): Internal<GameState> {
  const completed = completeEffectStep(state, current);
  if (!completed.ok) return fail(completed.error.code, completed.error.message);
  let next = replaceQueue(completed.state, [...additions, ...completed.state.resolution.effectQueue]);
  const deferred = additions.find((item) => item.payload.deferVictoryCheckUntilQueueEnds === true);
  if (deferred && next.resolution.victoryCheckDeferredByEffectId === null) {
    next = { ...next, resolution: { ...next.resolution, victoryCheckDeferredByEffectId: deferred.effectId } };
  }
  return { ok: true, value: next };
}

function updateFramePayload(state: GameState, frameId: string, patch: Record<string, JsonValue>): Internal<GameState> {
  const frame = frameFor(state, frameId);
  if (!frame) return fail("FRAME_NOT_FOUND", "The effect runtime continuation frame is missing.");
  const replaced = replaceFrame(state, frameId, { ...frame, payload: { ...frame.payload, ...patch } });
  return replaced ? { ok: true, value: replaced } : fail("FRAME_NOT_FOUND", "The effect runtime continuation frame is ambiguous.");
}

function setQueueHeadPayload(state: GameState, payloadPatch: Record<string, JsonValue>): GameState {
  const [head, ...tail] = state.resolution.effectQueue;
  if (!head) return state;
  return replaceQueue(state, [{ ...head, payload: { ...head.payload, ...payloadPatch } }, ...tail]);
}

function characterInvoker(registry: EffectRuntimeRegistry, characterId: CharacterAbilityId): RuntimeCharacterInvoker | undefined {
  const module = (registry.characters as unknown as Partial<Record<CharacterAbilityId, RuntimeCharacterInvoker>> | undefined)?.[characterId];
  return module;
}

function isCharacterAbilityId(value: string): value is CharacterAbilityId {
  return ["bart_cassidy", "black_jack", "calamity_janet", "el_gringo", "jesse_jones", "jourdonnais", "kit_carlson", "lucky_duke", "paul_regret", "pedro_ramirez", "rose_doolan", "sid_ketchum", "slab_the_killer", "suzy_lafayette", "vulture_sam", "willy_the_kid"].includes(value);
}

function characterInput(
  characterId: CharacterAbilityId,
  playerId: string,
  state: GameState,
  frameId: string,
  random: RandomSource,
  completed: readonly CompletedEffectInteraction[],
  hook: CharacterAbilityInput<CharacterAbilityId>["hook"],
): CharacterAbilityInput<CharacterAbilityId> {
  return {
    characterId,
    playerId,
    state: state as DeepReadonly<GameState>,
    continuationFrameId: frameId,
    random,
    completedInteractions: completed,
    hook,
  };
}

function characterCardReference(
  state: GameState,
  cardInstanceId: string | null,
  effectCardTypeId?: BaseCardTypeId,
): CharacterCardReference | undefined {
  if (!cardInstanceId) return undefined;
  const physicalCardTypeId = cardTypeId(state, cardInstanceId);
  if (!physicalCardTypeId) return undefined;
  return {
    cardInstanceId,
    physicalCardTypeId,
    effectCardTypeId: effectCardTypeId ?? physicalCardTypeId,
  };
}

function applySuzyHook(
  state: GameState,
  frame: ResolutionFrame,
  playerId: string,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
  hook: SuzyAfterCardEffectHookInput | SuzyAfterResponseHookInput,
): Internal<{ state: GameState; events: EffectEventDraft[] }> {
  const module = characterInvoker(registry, "suzy_lafayette");
  if (!module) return { ok: true, value: { state, events: [] } };
  const interactions = completedInteractions(frame);
  if (!interactions) return fail("INVALID_STATE", "Saved effect interaction history is malformed.");
  const result = module(characterInput(
    "suzy_lafayette",
    playerId,
    state,
    frame.frameId,
    random,
    interactions,
    hook,
  ));
  if (result.kind !== "applied" || result.steps.length > 0) {
    return fail("INVALID_CHARACTER_RESULT", "Suzy's automatic hook must return immediate events without prompts or queued steps.");
  }
  const applied = applyEvents(state, result.events);
  return applied.ok
    ? { ok: true, value: { state: applied.value.state, events: applied.value.events } }
    : applied;
}

function dispatchSuzyAfterResponse(
  state: GameState,
  frame: ResolutionFrame,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
): Internal<{ state: GameState; events: EffectEventDraft[] }> {
  const interactions = completedInteractions(frame);
  if (!interactions) return fail("INVALID_STATE", "Saved effect interaction history is malformed.");
  const interaction = interactions.at(-1);
  if (!interaction || !["BANG_RESPONSE", "GATLING_RESPONSE", "INDIANS_RESPONSE"].includes(interaction.kind)) {
    return { ok: true, value: { state, events: [] } };
  }
  const rawProcessed = frame.payload[SUZY_RESPONSE_HOOKS_KEY];
  if (rawProcessed !== undefined && (!Array.isArray(rawProcessed) || rawProcessed.some((id) => typeof id !== "string"))) {
    return fail("INVALID_STATE", "Saved Suzy response-hook cursor is malformed.");
  }
  const processedIds = (rawProcessed as string[] | undefined) ?? [];
  if (processedIds.includes(interaction.interactionId) || interaction.responses.length !== 1) {
    return { ok: true, value: { state, events: [] } };
  }

  const response = interaction.responses[0]!;
  const actor = uniqueSeat(state, response.playerId);
  if (!actor || actor.public.characterId !== "suzy_lafayette") {
    return { ok: true, value: { state, events: [] } };
  }

  const responseKind = interaction.kind;
  const responseChoice = response.choice;
  const isMissedResponse = (responseKind === "BANG_RESPONSE" || responseKind === "GATLING_RESPONSE") && responseChoice === "USE_MISSED";
  const isBangResponse = responseKind === "INDIANS_RESPONSE" && responseChoice === "USE_BANG";
  if (!isMissedResponse && !isBangResponse) return { ok: true, value: { state, events: [] } };
  const effectCardTypeId: BaseCardTypeId = isMissedResponse ? "missed" : "bang";

  const cardInstanceId = response.payload.cardInstanceId;
  if (typeof cardInstanceId !== "string" || !state.zones.discardPileCardInstanceIds.includes(cardInstanceId)) {
    return { ok: true, value: { state, events: [] } };
  }
  const card = characterCardReference(state, cardInstanceId, effectCardTypeId);
  if (!card) return { ok: true, value: { state, events: [] } };

  let responseSeries: SuzyAfterResponseHookInput["responseSeries"] = "effect_complete";
  if (responseKind === "BANG_RESPONSE" && responseChoice === "USE_MISSED") {
    const requiredMisses = interaction.context.requiredMisses;
    const rawProgress = interaction.context.barrelProgress;
    const priorMisses = isRecord(rawProgress) && Number.isSafeInteger(rawProgress.successfulMisses)
      ? rawProgress.successfulMisses as number
      : 0;
    const required = requiredMisses === 2 ? 2 : 1;
    if (priorMisses + 1 < required) responseSeries = "continuing";
  }

  const suzyResponse: SuzyAfterResponseHookInput["response"] = isMissedResponse
    ? {
        interactionKind: responseKind as "BANG_RESPONSE" | "GATLING_RESPONSE",
        choice: "USE_MISSED",
        card,
      }
    : { interactionKind: "INDIANS_RESPONSE", choice: "USE_BANG", card };
  const hook: SuzyAfterResponseHookInput = {
    kind: "after_response",
    interactionId: interaction.interactionId,
    responderPlayerId: response.playerId,
    response: suzyResponse,
    responseSeries,
    handCardCountAfterResponse: actor.private.handCardInstanceIds.length,
  };
  const invoked = applySuzyHook(state, frame, actor.public.playerId, random, registry, hook);
  if (!invoked.ok) return invoked;
  const updated = updateFramePayload(invoked.value.state, frame.frameId, {
    [SUZY_RESPONSE_HOOKS_KEY]: [...processedIds, interaction.interactionId],
  });
  return updated.ok
    ? { ok: true, value: { state: updated.value, events: invoked.value.events } }
    : updated;
}

function dispatchSuzyAfterCardEffect(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
): Internal<{ state: GameState; events: EffectEventDraft[] }> {
  if (!characterInvoker(registry, "suzy_lafayette")) return { ok: true, value: { state, events: [] } };
  // C14 belongs to every affected living Suzy, including the other Duel participant.
  const drafts = emptySuzyDrawEvents(state, random, context.sourceCardInstanceId);
  const applied = applyEvents(state, drafts);
  return applied.ok ? { ok: true, value: applied.value } : applied;
}

function moduleCardInput(
  state: GameState,
  context: RuntimeContext,
  frameId: string,
  targets: readonly EffectTarget[],
  random: RandomSource,
  completed: readonly CompletedEffectInteraction[],
): CardEffectInput {
  return {
    state: state as DeepReadonly<GameState>,
    actorPlayerId: context.actorPlayerId,
    sourceCardInstanceId: context.sourceCardInstanceId,
    continuationFrameId: frameId,
    targets,
    random,
    completedInteractions: completed,
  };
}

function applySlabAttackRequirement(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
  interactions: readonly CompletedEffectInteraction[],
  result: CardEffectResult,
): Internal<CardEffectResult> {
  if (result.kind !== "response_required" || result.request.kind !== "BANG_RESPONSE" ||
      context.mode !== "card" || context.effectTypeId !== "bang" ||
      cardTypeId(state, context.sourceCardInstanceId) !== "bang") {
    return { ok: true, value: result };
  }

  const attacker = uniqueSeat(state, context.actorPlayerId);
  if (!attacker || attacker.public.characterId !== "slab_the_killer") return { ok: true, value: result };
  if (result.request.responders.length !== 1) {
    return fail("INVALID_EFFECT_RESULT", "A BANG response query requires exactly one defender.");
  }

  const module = registry.characters?.slab_the_killer;
  if (!module) {
    return fail("COMMAND_EXECUTOR_UNAVAILABLE", "A Slab BANG requires the registered Slab attack-response module.");
  }
  const rawProgress = result.request.context.barrelProgress;
  if (!isRecord(rawProgress) || !Number.isSafeInteger(rawProgress.successfulMisses) ||
      (rawProgress.successfulMisses as number) < 0 || !Array.isArray(rawProgress.attemptedDefenseSources) ||
      rawProgress.attemptedDefenseSources.some((source) => source !== "barrel" && source !== "jourdonnais")) {
    return fail("INVALID_EFFECT_RESULT", "A BANG response query is missing valid saved defense progress.");
  }

  const hook: CharacterAbilityHook<"slab_the_killer"> = {
    kind: "attack_response_query",
    perspective: "attacker",
    attack: {
      kind: "bang",
      attackerPlayerId: attacker.public.playerId,
      defenderPlayerId: result.request.responders[0]!.playerId,
      card: {
        cardInstanceId: context.sourceCardInstanceId!,
        physicalCardTypeId: "bang",
        effectCardTypeId: "bang",
      },
    },
    missedCardsAlreadySubmitted: rawProgress.successfulMisses as number,
    judgmentSourcesAlreadyAttempted: rawProgress.attemptedDefenseSources as ("barrel" | "jourdonnais")[],
  };
  const query: unknown = module({
    characterId: "slab_the_killer",
    playerId: attacker.public.playerId,
    state: state as DeepReadonly<GameState>,
    continuationFrameId: frame.frameId,
    random,
    completedInteractions: interactions,
    hook,
  });
  if (!isRecord(query) || query.kind !== "attack_response_query" ||
      (query.additionalMissedCardsRequired !== 0 && query.additionalMissedCardsRequired !== 1)) {
    return fail("INVALID_CHARACTER_RESULT", "The Slab attack-response module returned an invalid query result.");
  }

  return {
    ok: true,
    value: {
      ...result,
      request: {
        ...result.request,
        context: {
          ...result.request.context,
          requiredMisses: 1 + (query.additionalMissedCardsRequired as 0 | 1),
        },
      },
    },
  };
}

function interactionIdentity(next: () => InteractionIdentity): Internal<InteractionIdentity> {
  try {
    const identity = next();
    if (!identity || typeof identity.interactionId !== "string" || identity.interactionId.trim() === "" ||
        typeof identity.createdAt !== "string" || identity.createdAt.trim() === "") {
      return fail("INTERACTION_METADATA_REQUIRED", "Runtime interaction identity and createdAt must be caller supplied non-empty strings.");
    }
    return { ok: true, value: identity };
  } catch {
    return fail("INTERACTION_METADATA_REQUIRED", "Runtime interaction identity provider failed.");
  }
}

function applySourceAndCostEvents(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  result: CardEffectResult | CharacterEffectResult,
): Internal<{ state: GameState; events: EffectEventDraft[]; frame: ResolutionFrame }> {
  if (result.kind === "invalid_target" || result.kind === "target_required") {
    return fail(result.kind === "invalid_target" ? result.code : "TARGET_REQUIRED", result.kind === "invalid_target" ? `Card effect rejected target (${result.code}).` : "Card effect requires a target.");
  }
  let drafts = [...result.events];
  if (context.mode === "card" && frame.payload.sourceConsumed !== true) {
    drafts = sourceCardEvent(state, context.actorPlayerId, context.sourceCardInstanceId, drafts);
  }
  if (context.mode === "character" && frame.payload.costsApplied !== true && context.costCardInstanceIds.length > 0) {
    const costs = cardCostEvents(state, context.actorPlayerId, context.costCardInstanceIds, drafts, context.sourceCardInstanceId);
    if (!costs.ok) return costs;
    drafts = [...costs.value, ...drafts];
  }
  const applied = applyEvents(state, drafts);
  if (!applied.ok) return applied;
  const patch: Record<string, JsonValue> = {};
  if (result.steps.some(step => step.kind === "GATLING_TARGET" || step.kind === "INDIANS_TARGET") && frame.payload[TABLEWIDE_TARGETS_KEY] === undefined) {
    patch[TABLEWIDE_TARGETS_KEY] = result.steps.flatMap(step => step.targetPlayerId === null ? [] : [step.targetPlayerId]);
  }
  if (context.mode === "card" && frame.payload.sourceConsumed !== true) patch.sourceConsumed = true;
  if (context.mode === "character" && frame.payload.costsApplied !== true) patch.costsApplied = true;
  const updated = Object.keys(patch).length > 0
    ? updateFramePayload(applied.value.state, frame.frameId, patch)
    : { ok: true as const, value: applied.value.state };
  if (!updated.ok) return updated;
  const updatedFrame = frameFor(updated.value, frame.frameId);
  if (!updatedFrame) return fail("FRAME_NOT_FOUND", "The effect runtime continuation frame disappeared.");
  return { ok: true, value: { state: updated.value, events: applied.value.events, frame: updatedFrame } };
}

function openEffectRequest(
  state: GameState,
  frameId: string,
  result: Extract<CardEffectResult, { kind: "choice_required" | "response_required" }>,
  identityFactory: () => InteractionIdentity,
): Internal<GameState> {
  if (result.steps.length > 0) {
    return fail("UNSUPPORTED_EFFECT_RESULT", "A pending effect request cannot also queue steps with the current T12 continuation contract.");
  }
  if (result.request.resumeFrameId !== frameId) return fail("INVALID_STATE", "The effect interaction must resume its owning runtime frame.");
  const identity = interactionIdentity(identityFactory);
  if (!identity.ok) return identity;
  const frame = frameFor(state, frameId);
  let prepared = state;
  if (frame?.payload[TABLEWIDE_TARGETS_KEY] !== undefined && frame.payload[TABLEWIDE_ATTACK_ID_KEY] === undefined) {
    const saved = updateFramePayload(state, frameId, { [TABLEWIDE_ATTACK_ID_KEY]: identity.value.interactionId });
    if (!saved.ok) return saved;
    prepared = saved.value;
  }
  const attackId = frame?.payload[TABLEWIDE_ATTACK_ID_KEY];
  const targetId = result.request.responders[0]?.playerId;
  const hasPriorResponse = frame && completedInteractions(frame)?.some(response =>
    response.kind === result.request.kind && response.context.targetPlayerId === targetId);
  const canonicalId = typeof attackId === "string" && targetId && !hasPriorResponse &&
    ["GATLING_RESPONSE", "INDIANS_RESPONSE"].includes(result.request.kind)
    ? `${attackId}:tablewide:${targetId}` : identity.value.interactionId;
  const opened = openPendingInteraction(prepared, { ...result.request, ...identity.value, interactionId: canonicalId });
  return opened.ok ? { ok: true, value: opened.state } : fail(opened.error.code, opened.error.message);
}

function damageHookStep(
  current: EffectStep,
  damageAmount: number,
  hpLost: number,
  cause: DamageCause,
  effectTypeId: string | null,
  physicalCardTypeId: string | null,
  survives: boolean | null,
): EffectStep {
  return step(
    `${current.effectId}:damage-resolved:${current.targetPlayerId}`,
    RUN_DAMAGE_HOOK,
    current.sourcePlayerId,
    current.targetPlayerId,
    current.sourceCardInstanceId,
    {
      damageAmount,
      hpLost,
      cause,
      effectTypeId,
      physicalCardTypeId,
      survivedAfterRescue: survives,
    },
  );
}

function validDamageCause(value: unknown): value is DamageCause {
  return value === "BANG" || value === "GATLING" || value === "INDIANS" || value === "DUEL" || value === "DYNAMITE";
}

function updateDamageHookSurvival(state: GameState, victimPlayerId: string, survives: boolean): GameState | undefined {
  const index = state.resolution.effectQueue.findIndex((queued) => queued.kind === RUN_DAMAGE_HOOK && queued.targetPlayerId === victimPlayerId && queued.payload.survivedAfterRescue === null);
  if (index < 0) return undefined;
  const queue = [...state.resolution.effectQueue];
  queue[index] = { ...queue[index]!, payload: { ...queue[index]!.payload, survivedAfterRescue: survives } };
  return replaceQueue(state, queue);
}

function rescueOptions(state: GameState, registry: EffectRuntimeRegistry, victim: SeatState): InteractionOption[] {
  const aliveCount = state.seats.filter((seat) => !seat.public.eliminated).length;
  const options: InteractionOption[] = [];
  if (aliveCount > 2 && registry.cards.beer) {
    for (const cardInstanceId of victim.private.handCardInstanceIds) {
      if (cardTypeId(state, cardInstanceId) === "beer") options.push({ choice: "USE_BEER", payload: { cardInstanceId } });
    }
  }
  if (victim.public.characterId === "sid_ketchum" && registry.characters?.sid_ketchum) {
    const cards = victim.private.handCardInstanceIds;
    for (let first = 0; first < cards.length; first += 1) {
      for (let second = first + 1; second < cards.length; second += 1) {
        options.push({ choice: "USE_SID", payload: { cardInstanceIds: [cards[first]!, cards[second]!] } });
      }
    }
  }
  options.push({ choice: "ACCEPT_ELIMINATION", payload: {} });
  return options;
}

function openRescue(
  state: GameState,
  registry: EffectRuntimeRegistry,
  identityFactory: () => InteractionIdentity,
  victimPlayerId: string,
  sourcePlayerId: string | null,
  frameId: string,
): Internal<GameState> {
  const victim = uniqueSeat(state, victimPlayerId);
  if (!victim) return fail("INVALID_STATE", "Damage victim does not identify exactly one seat.");
  const identity = interactionIdentity(identityFactory);
  if (!identity.ok) return identity;
  const opened = beginDeathRescue(state, {
    victimPlayerId,
    sourcePlayerId,
    interactionId: identity.value.interactionId,
    options: rescueOptions(state, registry, victim),
    context: { continuationFrameId: frameId, victimPlayerId, sourcePlayerId },
    resumeFrameId: frameId,
    createdAt: identity.value.createdAt,
  });
  return opened.ok ? { ok: true, value: opened.state } : fail(opened.error.code, opened.error.message);
}

function cardLocations(state: GameState): Map<string, { zone: string; playerId: string | null }> {
  const locations = new Map<string, { zone: string; playerId: string | null }>();
  for (const seat of state.seats) {
    for (const id of seat.private.handCardInstanceIds) locations.set(id, { zone: "hand", playerId: seat.public.playerId });
    for (const id of seat.public.inPlayCardInstanceIds) locations.set(id, { zone: "in_play", playerId: seat.public.playerId });
  }
  for (const id of state.zones.drawPileCardInstanceIds) locations.set(id, { zone: "draw_pile", playerId: null });
  for (const id of state.zones.discardPileCardInstanceIds) locations.set(id, { zone: "discard", playerId: null });
  for (const id of state.zones.revealedPoolCardInstanceIds) locations.set(id, { zone: "revealed_pool", playerId: null });
  return locations;
}

function stateMovementEvents(before: GameState, after: GameState): EffectEventDraft[] {
  const beforeLocations = cardLocations(before);
  const afterLocations = cardLocations(after);
  const orderedIds = [
    ...after.seats.flatMap((seat) => [...seat.private.handCardInstanceIds, ...seat.public.inPlayCardInstanceIds]),
    ...after.zones.drawPileCardInstanceIds,
    ...after.zones.revealedPoolCardInstanceIds,
    ...after.zones.discardPileCardInstanceIds,
  ];
  const emitted: EffectEventDraft[] = [];
  for (const cardInstanceId of orderedIds) {
    const oldLocation = beforeLocations.get(cardInstanceId);
    const newLocation = afterLocations.get(cardInstanceId);
    if (!oldLocation || !newLocation || oldLocation.zone === newLocation.zone && oldLocation.playerId === newLocation.playerId) continue;
    if (newLocation.zone === "discard") {
      emitted.push(eventDraft("CARD_DISCARDED", oldLocation.playerId, {
        sourceCardInstanceId: null,
        cardInstanceId,
        ownerPlayerId: oldLocation.playerId,
        fromZone: oldLocation.zone,
        toZone: "discard",
      }));
    } else if (oldLocation.zone === "draw_pile" && newLocation.zone === "hand") {
      emitted.push(eventDraft("CARD_DRAWN", newLocation.playerId, {
        sourceCardInstanceId: null,
        cardInstanceId,
        playerId: newLocation.playerId,
        fromZone: "draw_pile",
        toZone: "hand",
      }));
    } else {
      emitted.push(eventDraft("CARD_TRANSFERRED", newLocation.playerId ?? oldLocation.playerId, {
        sourceCardInstanceId: null,
        cardInstanceId,
        ...(oldLocation.playerId === null ? {} : { fromPlayerId: oldLocation.playerId }),
        fromZone: oldLocation.zone,
        ...(newLocation.playerId === null ? {} : { toPlayerId: newLocation.playerId }),
        toZone: newLocation.zone,
      }));
    }
  }
  return emitted;
}

function safeResult(state: GameState, events: readonly EffectEventDraft[], value: JsonValue): CommandExecutionResult {
  return { ok: true, output: { state, events, value } };
}

function startRuntimeEffect(
  state: GameState,
  mode: RuntimeContext["mode"],
  actorPlayerId: string,
  effectTypeId: string | null,
  abilityId: string | null,
  sourceCardInstanceId: string | null,
  targets: readonly EffectTarget[],
  costCardInstanceIds: readonly string[],
  random: RandomSource,
  options: EffectRuntimeOptions,
  continuationFrameId?: string,
): CommandExecutionResult {
  const rootId = continuationFrameId ?? `${mode}:${state.version}:${actorPlayerId}:${sourceCardInstanceId ?? abilityId ?? "effect"}`;
  const effectId = `${rootId}:effect`;
  const frameId = continuationFrameId ?? `${effectId}:frame`;
  const runtimeFrame: ResolutionFrame = {
    frameId,
    kind: FRAME_KIND,
    sourcePlayerId: actorPlayerId,
    sourceCardInstanceId,
    payload: {
      runtimeVersion: 1,
      mode,
      effectId,
      effectTypeId,
      abilityId,
      actorPlayerId,
      sourceCardInstanceId,
      targets: targets as unknown as JsonValue,
      costCardInstanceIds: [...costCardInstanceIds],
      sourceConsumed: false,
      costsApplied: false,
    },
  };
  const begun = beginEffectResolution(state, {
    continuation: runtimeFrame,
    steps: [step(effectId, RUN_EFFECT, actorPlayerId, null, sourceCardInstanceId)],
  });
  if (!begun.ok) return commandFailure(begun.error.code, begun.error.message);
  const runtimeResult = runQueue(begun.state, frameId, random, options.registry, options.nextInteractionIdentity);
  if (!runtimeResult.ok) return commandFailure(runtimeResult.code, runtimeResult.message);
  return safeResult(runtimeResult.value.state, runtimeResult.value.events, runtimeResult.value.value);
}

export interface DirectCardEffectInput {
  readonly state: GameState;
  readonly actorPlayerId: string;
  /** Registry key for the start/turn-phase card effect module. */
  readonly effectTypeId: string;
  readonly sourceCardInstanceId: string | null;
  readonly targets?: readonly EffectTarget[];
  /** Caller-owned ID keeps external turn-start continuations stable across retries. */
  readonly continuationFrameId: string;
  readonly random: RandomSource;
}

/** Runs an injected card module for engine-owned phase effects such as Jail or Dynamite. */
export function executeCardEffect(input: DirectCardEffectInput, options: EffectRuntimeOptions): CommandExecutionResult {
  if (input.continuationFrameId.trim() === "") return commandFailure("INVALID_STATE", "A direct card effect needs a caller-supplied continuation frame ID.");
  return startRuntimeEffect(
    input.state,
    "card",
    input.actorPlayerId,
    input.effectTypeId,
    null,
    input.sourceCardInstanceId,
    input.targets ?? [],
    [],
    input.random,
    options,
    input.continuationFrameId,
  );
}

/**
 * Connects the existing T14 command boundary, T12 continuation cursor, T13
 * elimination API, and injected card/character modules without owning a
 * process-global registry or randomness source.
 */
export function createEffectCommandHandlers(options: EffectRuntimeOptions): CommandExecutionHandlers {
  const start = (
    state: GameState,
    mode: RuntimeContext["mode"],
    actorPlayerId: string,
    effectTypeId: string | null,
    abilityId: string | null,
    sourceCardInstanceId: string | null,
    targets: readonly EffectTarget[],
    costCardInstanceIds: readonly string[],
    random: RandomSource,
  ): CommandExecutionResult => startRuntimeEffect(
    state, mode, actorPlayerId, effectTypeId, abilityId, sourceCardInstanceId, targets,
    costCardInstanceIds, random, options,
  );

  const resume = (input: CompletedInteractionExecutionInput): CommandExecutionResult => {
    let state = input.state as GameState;
    const events: EffectEventDraft[] = [];
    const pendingBefore = input.state.resolution.pendingDeath;
    const pendingInteractionKind = input.interactionKind;
    const frameId = pendingBefore?.resumeFrameId ??
      input.state.resolution.continuations.find((frame) => frame.kind === FRAME_KIND)?.frameId ?? "";
    // T14 passes the post-response snapshot, where pendingInteraction has already
    // been cleared. Resolve the continuation from its queue/death cursor instead.
    const candidateFrames = state.resolution.continuations.filter((frame) => frame.kind === FRAME_KIND);
    const selectedFrame = pendingBefore?.resumeFrameId
      ? frameFor(state, pendingBefore.resumeFrameId)
      : candidateFrames.length === 1 ? candidateFrames[0] : undefined;
    const resolvedFrameId = selectedFrame?.frameId ?? frameId;
    const contextFrame = selectedFrame && runtimeContext(selectedFrame) ? selectedFrame : undefined;
    if (!selectedFrame || !contextFrame) return commandFailure("FRAME_NOT_FOUND", "The completed interaction has no unambiguous effect runtime continuation.");

    if (pendingInteractionKind === "DEATH_RESCUE") {
      const death = state.resolution.pendingDeath;
      if (!death || death.consequenceStage !== "rescue" || death.resumeFrameId !== resolvedFrameId) {
        return commandFailure("INVALID_DEATH_STAGE", "The completed rescue response does not match its saved damage continuation.");
      }
      const choice = input.command.payload.choice;
      if (choice === "ACCEPT_ELIMINATION") {
        const completed = completeDeathRescue(state, death.victimPlayerId, "accept_elimination");
        if (!completed.ok) return commandFailure(completed.error.code, completed.error.message);
        const clearedRescueHp = updateFramePayload(completed.state, resolvedFrameId, { rescueHp: null });
        if (!clearedRescueHp.ok) return commandFailure(clearedRescueHp.code, clearedRescueHp.message);
        state = clearedRescueHp.value;
        const updatedHookState = updateDamageHookSurvival(state, death.victimPlayerId, false);
        if (!updatedHookState) return commandFailure("INVALID_STATE", "The pending damage hook disappeared before elimination.");
        state = updatedHookState;
        const hook = state.resolution.effectQueue.find((queued) => queued.kind === RUN_DAMAGE_HOOK && queued.targetPlayerId === death.victimPlayerId);
        const hookData = hook ? hook.payload : undefined;
        const cause = hookData?.cause;
        const sourcePlayerId = hook?.sourcePlayerId ?? null;
        const attribution = cause === "DYNAMITE"
          ? { kind: "dynamite" as const }
          : cause === "DUEL"
            ? { kind: "duel" as const, initiatorPlayerId: sourcePlayerId ?? "" }
            : { kind: "player_effect" as const };
        const identity = interactionIdentity(options.nextInteractionIdentity);
        if (!identity.ok) return commandFailure(identity.code, identity.message);
        const begun = beginElimination(state, {
          victimPlayerId: death.victimPlayerId,
          attribution,
          discardInteractionId: identity.value.interactionId,
          createdAt: identity.value.createdAt,
        });
        if (!begun.ok) return commandFailure(begun.error.code, begun.error.message);
        events.push(...stateMovementEvents(state, begun.state));
        events.push(eventDraft("PLAYER_ELIMINATED", sourcePlayerId, {
          playerId: death.victimPlayerId,
          sourcePlayerId,
          cause: typeof cause === "string" ? cause : "UNKNOWN",
        }));
        state = begun.state;
        const advanced = advanceEndgameUntilPaused(state, input.random, options.nextInteractionIdentity);
        if (!advanced.ok) return commandFailure(advanced.code, advanced.message);
        state = advanced.value.state;
        events.push(...advanced.value.events);
        if (state.status !== "playing" || state.resolution.pendingInteraction !== null) {
          return safeResult(state, events, { kind: "resolution_pending", pendingInteractionKind: state.resolution.pendingInteraction?.kind ?? null });
        }
      } else if (choice === "USE_BEER" || choice === "USE_SID") {
        const responseHistory = completedInteractions(selectedFrame);
        if (!responseHistory) return commandFailure("INVALID_STATE", "Saved response history is malformed.");
        const applied = runRescueModule(state, selectedFrame, input, responseHistory, options.registry);
        if (!applied.ok) return commandFailure(applied.code, applied.message);
        state = applied.value.state;
        events.push(...applied.value.events);
        for (const rescueStep of applied.value.steps) {
          if (rescueStep.kind !== "HEAL_PLAYER") {
            return commandFailure("UNSUPPORTED_RESCUE_EFFECT", `Death rescue cannot apply nested step '${rescueStep.kind}' while T12 holds the death cursor.`);
          }
          const healed = applyRescueHealAmount(state, resolvedFrameId, death.victimPlayerId, rescueStep);
          if (!healed.ok) return commandFailure(healed.code, healed.message);
          state = healed.value;
        }
        const rescuedSeat = uniqueSeat(state, death.victimPlayerId);
        if (!rescuedSeat) return commandFailure("INVALID_STATE", "The rescued player no longer identifies one seat.");
        if (rescuedSeat.public.hp > 0) {
          const closed = completeDeathRescue(state, death.victimPlayerId, "survived");
          if (!closed.ok) return commandFailure(closed.error.code, closed.error.message);
          const clearedRescueHp = updateFramePayload(closed.state, resolvedFrameId, { rescueHp: null });
          if (!clearedRescueHp.ok) return commandFailure(clearedRescueHp.code, clearedRescueHp.message);
          const updatedHookState = updateDamageHookSurvival(clearedRescueHp.value, death.victimPlayerId, true);
          if (!updatedHookState) return commandFailure("INVALID_STATE", "The pending damage hook disappeared after rescue.");
          state = replaceQueue(updatedHookState, [...applied.value.steps.filter((item) => item.kind !== "HEAL_PLAYER"), ...updatedHookState.resolution.effectQueue]);
        } else {
          const reopened = openRescue(state, options.registry, options.nextInteractionIdentity, death.victimPlayerId, death.sourcePlayerId, resolvedFrameId);
          if (!reopened.ok) return commandFailure(reopened.code, reopened.message);
          return safeResult(reopened.value, events, { kind: "interaction_pending", interactionKind: "DEATH_RESCUE" });
        }
      } else {
        return commandFailure("INVALID_CHOICE", "Death rescue supports Beer, Sid, or accepting elimination.");
      }
    } else if (state.resolution.pendingDeath?.consequenceStage === "cleanup") {
      const advanced = advanceEndgameUntilPaused(state, input.random, options.nextInteractionIdentity);
      if (!advanced.ok) return commandFailure(advanced.code, advanced.message);
      state = advanced.value.state;
      events.push(...advanced.value.events);
      if (state.status !== "playing" || state.resolution.pendingInteraction !== null) {
        return safeResult(state, events, { kind: "resolution_pending", pendingInteractionKind: state.resolution.pendingInteraction?.kind ?? null });
      }
    }

    const run = runQueue(state, resolvedFrameId, input.random, options.registry, options.nextInteractionIdentity);
    if (!run.ok) return commandFailure(run.code, run.message);
    let resumedState = run.value.state;
    if (pendingInteractionKind === "LUCKY_DRAW" && runtimeContext(contextFrame)?.effectTypeId === "__turn_start_jail" &&
        resumedState.status === "playing" && resumedState.resolution.continuations.length === 0 &&
        run.value.events.some((event) => event.type === "JAIL_JUDGMENT_RESOLVED" && event.payload.turnSkipped === true)) {
      const skipped = skipTurnAfterStartResolution(resumedState);
      if (!skipped.ok) return commandFailure(skipped.error.code, skipped.error.message);
      resumedState = skipped.state;
    }
    return safeResult(resumedState, [...events, ...run.value.events], run.value.value);
  };

  return {
    playCard: (input: PlayCardExecutionInput) => start(
      input.state as GameState,
      "card",
      input.actorPlayerId,
      input.cardTypeId,
      null,
      input.command.payload.cardInstanceId,
      targetsFromCommand(input.command),
      [],
      input.random,
    ),
    useAbility: (input: AbilityExecutionInput) => {
      const actor = uniqueSeat(input.state as GameState, input.actorPlayerId);
      if (!actor || !isCharacterAbilityId(actor.public.characterId)) return commandFailure("ABILITY_NOT_AVAILABLE", "The ability actor has no registered character module.");
      const module = characterInvoker(options.registry, actor.public.characterId);
      if (!module) return commandFailure("COMMAND_EXECUTOR_UNAVAILABLE", `No character module is registered for '${actor.public.characterId}'.`);
      return start(
        input.state as GameState,
        "character",
        input.actorPlayerId,
        null,
        input.command.payload.abilityId,
        null,
        [],
        input.command.payload.cardInstanceIds,
        input.random,
      );
    },
    resumeInteraction: resume,
    tablewideRespond: collectTablewideResponse,
  };
}

function invokeFrameModule(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
  targetOverride?: readonly EffectTarget[],
): Internal<CardEffectResult | CharacterEffectResult> {
  const interactions = completedInteractions(frame);
  if (!interactions) return fail("INVALID_STATE", "Saved effect interaction history is malformed.");
  if (context.mode === "card") {
    const module = context.effectTypeId ? registry.cards[context.effectTypeId] : undefined;
    if (!module) return fail("COMMAND_EXECUTOR_UNAVAILABLE", `No card-effect module is registered for '${context.effectTypeId ?? "unknown"}'.`);
    const result = module(moduleCardInput(state, context, frame.frameId, targetOverride ?? context.targets, random, interactions));
    const withSlabRequirement = applySlabAttackRequirement(state, frame, context, random, registry, interactions, result);
    return withSlabRequirement;
  }
  if (!context.abilityId || context.abilityId !== "sid-ketchum") return fail("ABILITY_NOT_AVAILABLE", "The runtime does not support this character ability ID.");
  const actor = uniqueSeat(state, context.actorPlayerId);
  if (!actor || !isCharacterAbilityId(actor.public.characterId)) return fail("INVALID_STATE", "Character ability actor does not identify a supported character.");
  const module = characterInvoker(registry, actor.public.characterId);
  if (!module) return fail("COMMAND_EXECUTOR_UNAVAILABLE", `No character module is registered for '${actor.public.characterId}'.`);
  const hook = {
    kind: "sid_ability_use" as const,
    abilityId: "sid-ketchum" as const,
    window: { kind: "play_phase" as const },
    costCardInstanceIds: context.costCardInstanceIds as [string, string],
  };
  return { ok: true, value: module(characterInput(actor.public.characterId, actor.public.playerId, state, frame.frameId, random, interactions, hook)) };
}

function processModuleResult(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  current: EffectStep,
  result: CardEffectResult | CharacterEffectResult,
  registry: EffectRuntimeRegistry,
  random: RandomSource,
  identityFactory: () => InteractionIdentity,
): Internal<{ state: GameState; events: EffectEventDraft[]; pending: boolean }> {
  const handled = applySourceAndCostEvents(state, frame, context, result);
  if (!handled.ok) return handled;
  let nextState = handled.value.state;
  const events = [...handled.value.events];
  let resolvedResult = result;
  if (context.mode === "card") {
    const responseHook = dispatchSuzyAfterResponse(nextState, handled.value.frame, random, registry);
    if (!responseHook.ok) return responseHook;
    nextState = responseHook.value.state;
    events.push(...responseHook.value.events);

    // Slab may require another Missed after the current response. Its prompt
    // must be built after Suzy's draw so the newly drawn card is a legal option.
    if (result.kind === "response_required" && result.request.kind === "BANG_RESPONSE" &&
        responseHook.value.events.some((draft) => draft.type === "CARD_DRAWN")) {
      const updatedFrame = frameFor(nextState, frame.frameId);
      if (!updatedFrame) return fail("FRAME_NOT_FOUND", "The Suzy response hook lost its effect runtime continuation.");
      const refreshed = invokeFrameModule(nextState, updatedFrame, context, random, registry);
      if (!refreshed.ok) return refreshed;
      if (refreshed.value.kind !== "response_required" || refreshed.value.request.kind !== "BANG_RESPONSE") {
        return fail("INVALID_EFFECT_RESULT", "A Suzy draw changed the ongoing BANG response into an unsupported result.");
      }
      resolvedResult = { ...result, request: refreshed.value.request };
    }
  }
  if (resolvedResult.kind === "choice_required" || resolvedResult.kind === "response_required") {
    const opened = openEffectRequest(nextState, frame.frameId, resolvedResult, identityFactory);
    if (!opened.ok) return opened;
    return { ok: true, value: { state: opened.value, events, pending: true } };
  }
  if (result.kind !== "applied") return fail("INVALID_STATE", "Effect result was not applicable after validation.");
  const inserted = insertStepsAfterHead(nextState, current, result.steps);
  if (!inserted.ok) return inserted;
  nextState = inserted.value;
  return { ok: true, value: { state: nextState, events, pending: false } };
}

function applyDamageStep(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  current: EffectStep,
  registry: EffectRuntimeRegistry,
  identityFactory: () => InteractionIdentity,
): Internal<{ state: GameState; events: EffectEventDraft[]; pending: boolean }> {
  if (!current.targetPlayerId || !Number.isInteger(current.payload.amount) || typeof current.payload.amount !== "number" || current.payload.amount < 1 || !validDamageCause(current.payload.cause)) {
    return fail("INVALID_STATE", "DAMAGE_PLAYER needs a positive integer amount, target, and supported cause.");
  }
  const victim = uniqueSeat(state, current.targetPlayerId);
  if (!victim || victim.public.eliminated) return fail("INVALID_STATE", "Damage target must identify one living player.");
  const amount = current.payload.amount;
  const hpBefore = victim.public.hp;
  const hpLost = Math.min(Math.max(0, hpBefore), amount);
  const rescueHp = hpBefore - amount;
  const hpAfter = Math.max(0, rescueHp);
  const nextState: GameState = {
    ...state,
    seats: state.seats.map((seat) => seat.public.playerId === current.targetPlayerId
      ? { ...seat, public: { ...seat.public, hp: hpAfter } }
      : seat),
  };
  const cause = current.payload.cause;
  const damageHook = damageHookStep(
    current,
    amount,
    hpLost,
    cause,
    context.effectTypeId,
    cardTypeId(state, current.sourceCardInstanceId) ?? null,
    hpAfter > 0 ? true : null,
  );
  const applied = completeEffectStep(nextState, current);
  if (!applied.ok) return fail(applied.error.code, applied.error.message);
  const queued = replaceQueue(applied.state, [damageHook, ...applied.state.resolution.effectQueue]);
  const event = eventDraft("PLAYER_DAMAGED", current.sourcePlayerId, {
    sourceCardInstanceId: current.sourceCardInstanceId,
    sourcePlayerId: current.sourcePlayerId,
    targetPlayerId: current.targetPlayerId,
    cause,
    amount,
    hpLost,
    hpBefore,
    hpAfter,
  });
  if (hpAfter > 0) return { ok: true, value: { state: queued, events: [event], pending: false } };
  const savedRescueHp = updateFramePayload(queued, frame.frameId, { rescueHp });
  if (!savedRescueHp.ok) return savedRescueHp;
  const opened = openRescue(savedRescueHp.value, registry, identityFactory, current.targetPlayerId, current.sourcePlayerId, frame.frameId);
  return opened.ok
    ? { ok: true, value: { state: opened.value, events: [event], pending: true } }
    : opened;
}

function applyHealAmount(state: GameState, current: EffectStep): Internal<GameState> {
  if (!current.targetPlayerId || !Number.isInteger(current.payload.amount) || typeof current.payload.amount !== "number" || current.payload.amount < 1) {
    return fail("INVALID_STATE", "HEAL_PLAYER needs a positive integer amount and target.");
  }
  const target = uniqueSeat(state, current.targetPlayerId);
  if (!target || target.public.eliminated) return fail("INVALID_STATE", "Healing target must identify one living player.");
  const hp = Math.min(target.public.maxHp, target.public.hp + current.payload.amount);
  const updated: GameState = {
    ...state,
    seats: state.seats.map((seat) => seat.public.playerId === current.targetPlayerId
      ? { ...seat, public: { ...seat.public, hp } }
      : seat),
  };
  return { ok: true, value: updated };
}

function applyRescueHealAmount(
  state: GameState,
  frameId: string,
  victimPlayerId: string,
  current: EffectStep,
): Internal<GameState> {
  if (current.targetPlayerId !== victimPlayerId || !Number.isSafeInteger(current.payload.amount) ||
      typeof current.payload.amount !== "number" || current.payload.amount < 1) {
    return fail("INVALID_STATE", "A rescue HEAL_PLAYER step must heal its victim by a positive integer amount.");
  }
  const victim = uniqueSeat(state, victimPlayerId);
  const frame = frameFor(state, frameId);
  if (!victim || victim.public.eliminated || !frame) {
    return fail("INVALID_STATE", "The rescue victim or its saved damage continuation is missing.");
  }
  const savedRescueHp = frame.payload.rescueHp;
  const rescueHp = savedRescueHp === undefined ? victim.public.hp : savedRescueHp;
  if (typeof rescueHp !== "number" || !Number.isSafeInteger(rescueHp) || rescueHp > 0 || victim.public.hp !== 0) {
    return fail("INVALID_STATE", "The saved rescue HP is malformed or does not match the public zero-HP state.");
  }
  const nextRescueHp = Math.min(victim.public.maxHp, rescueHp + current.payload.amount);
  const updated: GameState = {
    ...state,
    seats: state.seats.map((seat) => seat.public.playerId === victimPlayerId
      ? { ...seat, public: { ...seat.public, hp: Math.max(0, nextRescueHp) } }
      : seat),
  };
  return updateFramePayload(updated, frameId, { rescueHp: nextRescueHp });
}

function applyHealStep(state: GameState, current: EffectStep): Internal<GameState> {
  const updated = applyHealAmount(state, current);
  if (!updated.ok) return updated;
  const completed = completeEffectStep(updated.value, current);
  return completed.ok ? { ok: true, value: completed.state } : fail(completed.error.code, completed.error.message);
}

function invokeDamageHook(
  state: GameState,
  frame: ResolutionFrame,
  current: EffectStep,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
): Internal<CardEffectResult | CharacterEffectResult | null> {
  if (typeof current.payload.damageAmount !== "number" || typeof current.payload.hpLost !== "number" ||
      !validDamageCause(current.payload.cause) || typeof current.payload.survivedAfterRescue !== "boolean" || !current.targetPlayerId) {
    return fail("INVALID_STATE", "Damage-resolved hook is missing its saved result data.");
  }
  const victim = uniqueSeat(state, current.targetPlayerId);
  if (!victim || !isCharacterAbilityId(victim.public.characterId)) return fail("INVALID_STATE", "Damage victim has no supported character identity.");
  if (victim.public.characterId !== "bart_cassidy" && victim.public.characterId !== "el_gringo") {
    return { ok: true, value: null };
  }
  const module = characterInvoker(registry, victim.public.characterId);
  if (!module) return { ok: true, value: null };
  const interactions = completedInteractions(frame);
  if (!interactions) return fail("INVALID_STATE", "Saved effect interaction history is malformed.");
  const hook: DamageResolvedHookInput = {
    kind: "damage_resolved",
    victimPlayerId: victim.public.playerId,
    damageAmount: current.payload.damageAmount,
    hpLost: current.payload.hpLost,
    source: {
      playerId: current.sourcePlayerId,
      card: {
        cardInstanceId: current.sourceCardInstanceId,
        physicalCardTypeId: current.payload.physicalCardTypeId as DamageResolvedHookInput["source"]["card"]["physicalCardTypeId"],
        effectCardTypeId: current.payload.effectTypeId as DamageResolvedHookInput["source"]["card"]["effectCardTypeId"],
      },
      cause: current.payload.cause,
    },
    survivedAfterRescue: current.payload.survivedAfterRescue,
  };
  return { ok: true, value: module(characterInput(victim.public.characterId, victim.public.playerId, state, frame.frameId, random, interactions, hook)) };
}

function dispatchSuzyBeforeElGringoReward(
  state: GameState,
  frame: ResolutionFrame,
  context: RuntimeContext,
  current: EffectStep,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
): Internal<{ state: GameState; events: EffectEventDraft[] }> {
  if (context.mode !== "card" || context.sourceCardInstanceId === null ||
      current.sourcePlayerId !== context.actorPlayerId || current.sourceCardInstanceId !== context.sourceCardInstanceId ||
      typeof current.payload.hpLost !== "number" || current.payload.hpLost <= 0 ||
      current.payload.survivedAfterRescue !== true || current.payload.cause === "DYNAMITE" || !current.targetPlayerId ||
      !characterInvoker(registry, "el_gringo")) {
    return { ok: true, value: { state, events: [] } };
  }
  const source = uniqueSeat(state, context.actorPlayerId);
  const victim = uniqueSeat(state, current.targetPlayerId);
  if (!source || source.public.characterId !== "suzy_lafayette" || source.public.eliminated ||
      !victim || victim.public.characterId !== "el_gringo" || victim.public.eliminated || victim.public.hp <= 0) {
    return { ok: true, value: { state, events: [] } };
  }
  const card = characterCardReference(state, context.sourceCardInstanceId);
  if (!card) return { ok: true, value: { state, events: [] } };
  const hook: SuzyAfterCardEffectHookInput = {
    kind: "after_card_effect",
    card,
    boundary: "before_el_gringo_reward",
    handCardCountAfterEffect: source.private.handCardInstanceIds.length,
    pendingInteractionKind: null,
    trigger: { kind: "EL_GRINGO_DAMAGE", victimPlayerId: victim.public.playerId },
  };
  return applySuzyHook(state, frame, source.public.playerId, random, registry, hook);
}

function runRescueModule(
  state: GameState,
  frame: ResolutionFrame,
  input: CompletedInteractionExecutionInput,
  interactions: readonly CompletedEffectInteraction[],
  registry: EffectRuntimeRegistry,
): Internal<{ state: GameState; events: EffectEventDraft[]; steps: readonly EffectStep[] }> {
  const choice = input.command.payload.choice;
  const death = state.resolution.pendingDeath;
  if (!death) return fail("INVALID_DEATH_STAGE", "Death rescue has already closed.");
  let result: CardEffectResult | CharacterEffectResult;
  let sourceCardInstanceId: string | null = null;
  let actorId = death.victimPlayerId;
  let context: RuntimeContext;
  const savedContext = runtimeContext(frame);
  if (!savedContext) return fail("FRAME_NOT_FOUND", "The damage continuation frame is malformed.");

  if (choice === "USE_BEER") {
    if (!("cardInstanceId" in input.command.payload)) return fail("INVALID_CHOICE", "Beer rescue requires its selected hand card.");
    sourceCardInstanceId = input.command.payload.cardInstanceId;
    const module = registry.cards.beer;
    if (!module) return fail("COMMAND_EXECUTOR_UNAVAILABLE", "No Beer effect module is registered for rescue.");
    context = { ...savedContext, mode: "card", effectTypeId: "beer", actorPlayerId: actorId, sourceCardInstanceId };
    result = module(moduleCardInput(state, context, frame.frameId, [], input.random, interactions));
  } else if (choice === "USE_SID") {
    if (!("cardInstanceIds" in input.command.payload)) return fail("INVALID_CHOICE", "Sid rescue requires two selected hand cards.");
    const victim = uniqueSeat(state, actorId);
    if (!victim || victim.public.characterId !== "sid_ketchum") return fail("INVALID_CHOICE", "Only Sid Ketchum can use Sid rescue.");
    const module = characterInvoker(registry, "sid_ketchum");
    if (!module) return fail("COMMAND_EXECUTOR_UNAVAILABLE", "No Sid character module is registered for rescue.");
    const hook = {
      kind: "sid_ability_use" as const,
      abilityId: "sid-ketchum" as const,
      window: { kind: "death_rescue" as const, interactionId: input.command.payload.interactionId, victimPlayerId: actorId },
      costCardInstanceIds: input.command.payload.cardInstanceIds,
    };
    context = { ...savedContext, mode: "character", effectTypeId: null, abilityId: "sid-ketchum", actorPlayerId: actorId, sourceCardInstanceId: null, costCardInstanceIds: input.command.payload.cardInstanceIds };
    result = module(characterInput("sid_ketchum", actorId, state, frame.frameId, input.random, interactions, hook));
  } else {
    return fail("INVALID_CHOICE", "The selected response is not a Beer or Sid rescue.");
  }

  if (result.kind === "invalid_target" || result.kind === "target_required") return fail("INVALID_CHOICE", "The selected rescue module rejected its saved response.");
  if (result.kind === "choice_required" || result.kind === "response_required") return fail("NESTED_RESCUE_INTERACTION_UNSUPPORTED", "T12 does not allow a second prompt while a death-rescue stage remains open.");
  let drafts = [...result.events];
  if (choice === "USE_BEER" && sourceCardInstanceId) drafts = sourceCardEvent(state, actorId, sourceCardInstanceId, drafts);
  if (choice === "USE_SID" && context.costCardInstanceIds.length > 0) {
    const costs = cardCostEvents(state, actorId, context.costCardInstanceIds, drafts, null);
    if (!costs.ok) return costs;
    drafts = [...costs.value, ...drafts];
  }
  const applied = applyEvents(state, drafts);
  if (!applied.ok) return applied;
  return { ok: true, value: { state: applied.value.state, events: applied.value.events, steps: result.steps } };
}

function advanceEndgameUntilPaused(
  initial: GameState,
  random: RandomSource,
  identityFactory: () => InteractionIdentity,
): Internal<{ state: GameState; events: EffectEventDraft[] }> {
  let state = initial;
  const events: EffectEventDraft[] = [];
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const death = state.resolution.pendingDeath;
    if (!death || death.consequenceStage !== "cleanup") return { ok: true, value: { state, events } };
    const before = state;
    const id = interactionIdentity(identityFactory);
    if (!id.ok) return id;
    const advanced = advanceElimination(state, {
      random,
      interactionId: id.value.interactionId,
      createdAt: id.value.createdAt,
    });
    if (!advanced.ok) return fail(advanced.error.code, advanced.error.message);
    state = advanced.state;
    events.push(...stateMovementEvents(before, state));
    if (advanced.value.stage === "awaiting_discard" || advanced.value.stage === "resource_exhausted") {
      return { ok: true, value: { state, events } };
    }
    if (advanced.value.stage === "cleanup_complete") {
      if (advanced.value.outcome) events.push(eventDraft("MATCH_COMPLETED", null, {
        winningFaction: advanced.value.outcome.winningFaction,
        winningPlayerIds: advanced.value.outcome.winningPlayerIds,
      }));
      return { ok: true, value: { state, events } };
    }
  }
  return fail("RESOLUTION_LIMIT_EXCEEDED", "Elimination cleanup exceeded its bounded continuation loop.");
}

function runQueue(
  initial: GameState,
  frameId: string,
  random: RandomSource,
  registry: EffectRuntimeRegistry,
  identityFactory: () => InteractionIdentity,
): Internal<RuntimeRunResult> {
  let state = initial;
  const events: EffectEventDraft[] = [];
  for (let iteration = 0; iteration < MAX_STEPS_PER_COMMAND; iteration += 1) {
    if (state.resolution.pendingInteraction !== null) {
      return { ok: true, value: { state, events, value: { kind: "interaction_pending", interactionKind: state.resolution.pendingInteraction.kind } } };
    }
    let frame = frameFor(state, frameId);
    const context = frame ? runtimeContext(frame) : undefined;
    if (!frame || !context) return fail("FRAME_NOT_FOUND", "Effect runtime continuation is missing or malformed.");
    const current = state.resolution.effectQueue[0];
    if (!current) {
      if (state.resolution.pendingDeath !== null) return fail("INVALID_DEATH_STAGE", "Effect queue cannot close while a death consequence remains pending.");
      const completionHook = dispatchSuzyAfterCardEffect(state, frame, context, random, registry);
      if (!completionHook.ok) return completionHook;
      state = completionHook.value.state;
      events.push(...completionHook.value.events);
      const deferredEffectId = state.resolution.victoryCheckDeferredByEffectId ?? context.effectId;
      const finished = finishEffectResolution(state, deferredEffectId, frameId);
      if (!finished.ok) return fail(finished.error.code, finished.error.message);
      state = finished.state;
      if (state.status === "playing") {
        const checked = checkVictoryAtBoundary(state);
        if (checked.ok) {
          if (checked.value.outcome) events.push(eventDraft("MATCH_COMPLETED", null, {
            winningFaction: checked.value.outcome.winningFaction,
            winningPlayerIds: checked.value.outcome.winningPlayerIds,
          }));
          state = checked.state;
        } else if (checked.error.code !== "NO_VICTORY_BOUNDARY") {
          return fail(checked.error.code, checked.error.message);
        }
      }
      if (state.status === "playing" && state.turn.phase !== "start") {
        const advanced = advanceAfterCurrentPlayerElimination(state);
        if (!advanced.ok) return fail(advanced.error.code, advanced.error.message);
        state = advanced.state;
      }
      return { ok: true, value: { state, events, value: { kind: "resolved", effectTypeId: context.effectTypeId, abilityId: context.abilityId } } };
    }

    if (current.kind === RUN_EFFECT) {
      const invoked = invokeFrameModule(state, frame, context, random, registry);
      if (!invoked.ok) return invoked;
      const processed = processModuleResult(state, frame, context, current, invoked.value, registry, random, identityFactory);
      if (!processed.ok) return processed;
      state = processed.value.state;
      events.push(...processed.value.events);
      if (processed.value.pending) return { ok: true, value: { state, events, value: { kind: "interaction_pending", interactionKind: state.resolution.pendingInteraction?.kind ?? null } } };
      continue;
    }

    if (current.kind === "DAMAGE_PLAYER") {
      const damage = applyDamageStep(state, frame, context, current, registry, identityFactory);
      if (!damage.ok) return damage;
      state = damage.value.state;
      events.push(...damage.value.events);
      if (damage.value.pending) return { ok: true, value: { state, events, value: { kind: "interaction_pending", interactionKind: state.resolution.pendingInteraction?.kind ?? "DEATH_RESCUE" } } };
      continue;
    }

    if (current.kind === "HEAL_PLAYER") {
      const healed = applyHealStep(state, current);
      if (!healed.ok) return healed;
      state = healed.value;
      continue;
    }

    if (current.kind === RUN_DAMAGE_HOOK) {
      const beforeReward = dispatchSuzyBeforeElGringoReward(state, frame, context, current, random, registry);
      if (!beforeReward.ok) return beforeReward;
      state = beforeReward.value.state;
      events.push(...beforeReward.value.events);
      const invoked = invokeDamageHook(state, frame, current, random, registry);
      if (!invoked.ok) return invoked;
      if (invoked.value === null) {
        const popped = completeEffectStep(state, current);
        if (!popped.ok) return fail(popped.error.code, popped.error.message);
        state = popped.state;
        continue;
      }
      const processed = processModuleResult(state, frame, { ...context, mode: "card", effectTypeId: null, sourceCardInstanceId: null, targets: [] }, current, invoked.value, registry, random, identityFactory);
      if (!processed.ok) return processed;
      state = processed.value.state;
      events.push(...processed.value.events);
      if (processed.value.pending) return { ok: true, value: { state, events, value: { kind: "interaction_pending", interactionKind: state.resolution.pendingInteraction?.kind ?? null } } };
      continue;
    }

    if (current.kind === "GATLING_TARGET" || current.kind === "INDIANS_TARGET") {
      const target = current.targetPlayerId;
      if (!target) return fail("INVALID_STATE", `${current.kind} requires a target player.`);
      const early = earlyResponses(frame).find(response => response.context.targetPlayerId === target);
      const prior = completedInteractions(frame);
      if (early && prior && !prior.some(response => response.interactionId === early.interactionId)) {
        const saved = updateFramePayload(state, frameId, { [INTERACTION_RESULTS_KEY]: [...prior, early] as unknown as JsonValue });
        if (!saved.ok) return saved;
        state = saved.value;
        frame = frameFor(state, frameId)!;
      }
      const interactions = completedInteractions(frame);
      if (!interactions) return fail("INVALID_STATE", "Saved effect interaction history is malformed.");
      const targetType = current.kind === "GATLING_TARGET" ? "gatling" : "indians";
      const module = registry.cards[targetType];
      if (!module) return fail("COMMAND_EXECUTOR_UNAVAILABLE", `No card-effect module is registered for '${targetType}'.`);
      const invoked = module(moduleCardInput(state, context, frameId, [{ kind: "player", playerId: target }], random, interactions));
      const processed = processModuleResult(state, frame, context, current, invoked, registry, random, identityFactory);
      if (!processed.ok) return processed;
      state = processed.value.state;
      events.push(...processed.value.events);
      if (processed.value.pending) return { ok: true, value: { state, events, value: { kind: "interaction_pending", interactionKind: state.resolution.pendingInteraction?.kind ?? null } } };
      continue;
    }

    if (current.kind === "BARREL_CHECK") {
      const interactions = completedInteractions(frame);
      if (!interactions) return fail("INVALID_STATE", "Saved effect interaction history is malformed.");
      const invoked = resolveBarrelCheckStep({
        state: state as DeepReadonly<GameState>,
        continuationFrameId: frameId,
        step: current,
        random,
        completedInteractions: interactions,
      } satisfies ResolveBarrelCheckStepInput);
      const processed = processModuleResult(state, frame, context, current, invoked, registry, random, identityFactory);
      if (!processed.ok) return processed;
      state = processed.value.state;
      events.push(...processed.value.events);
      if (processed.value.pending) return { ok: true, value: { state, events, value: { kind: "interaction_pending", interactionKind: state.resolution.pendingInteraction?.kind ?? null } } };
      continue;
    }

    return fail("UNSUPPORTED_EFFECT_STEP", `No runtime handler is registered for effect step '${current.kind}'.`);
  }
  return fail("RESOLUTION_LIMIT_EXCEEDED", "Effect queue exceeded its bounded continuation loop.");
}

