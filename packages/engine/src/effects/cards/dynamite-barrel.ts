import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { luckyDukeAbility } from "../characters/lucky-duke.js";
import { planDrawPileSupply } from "../draw-pile.js";
import type { RandomSource } from "../../random/shuffle.js";
import type { GameState, JsonValue } from "../../state/types.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  DeepReadonly,
  EffectEventDraft,
} from "../api.js";
import type {
  CharacterCardReference,
  DrawJudgmentSource,
  LuckyDrawJudgmentHookInput,
} from "../character-api.js";
import type { EffectStep, InteractionOption } from "../../state/types.js";

type EffectSeat = CardEffectInput["state"]["seats"][number];
type AttackKind = "BANG" | "GATLING";
type DefenseSource = "barrel" | "jourdonnais";

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

interface PreparedJudgment {
  readonly cardInstanceId: string;
  readonly rank: number | string;
  readonly suit: string;
  readonly events: readonly EffectEventDraft[];
}

interface JudgmentContext {
  readonly state: DeepReadonly<GameState>;
  readonly playerId: string;
  readonly continuationFrameId: string;
  readonly completedInteractions: readonly CompletedEffectInteraction[];
  readonly random: RandomSource;
}

type LuckyCandidate = LuckyDrawJudgmentHookInput["judgment"]["candidates"][number];

type JudgmentPreparation = PreparedJudgment
  | { readonly exhausted: true; readonly events: readonly EffectEventDraft[] }
  | { readonly invalid: true }
  | { readonly pending: Extract<CardEffectResult, { readonly kind: "choice_required" }> };

interface BarrelProgress {
  readonly successfulMisses: number;
  readonly attemptedDefenseSources: readonly DefenseSource[];
  readonly usedMissedCardInstanceIds: readonly string[];
  readonly requiredMisses: 1 | 2;
}

export interface ResolveBarrelCheckStepInput {
  /** Full server state; this function returns drafts and never mutates it. */
  readonly state: DeepReadonly<GameState>;
  /** The serialized `BARREL_CHECK` step emitted by T18 (or the BANG runner). */
  readonly step: EffectStep;
  readonly continuationFrameId: string;
  readonly completedInteractions: readonly CompletedEffectInteraction[];
  readonly random: RandomSource;
}

function invalid(code: Extract<CardEffectResult, { kind: "invalid_target" }>['code']): CardEffectResult {
  return { kind: "invalid_target", code };
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Record<string, JsonValue>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function cardType(state: CardEffectInput["state"], cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId
    ? TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId)
    : undefined;
}

function uniqueSeat(state: CardEffectInput["state"], playerId: string): EffectSeat | undefined {
  const seats = state.seats.filter((seat) => seat.public.playerId === playerId);
  return seats.length === 1 ? seats[0] : undefined;
}

function nextLivingOpponent(state: CardEffectInput["state"], playerId: string): EffectSeat | undefined {
  const seats = [...state.seats].sort((left, right) => left.public.seatIndex - right.public.seatIndex);
  const startIndex = seats.findIndex((seat) => seat.public.playerId === playerId);
  if (startIndex < 0 || seats.filter((seat) => seat.public.playerId === playerId).length !== 1) return undefined;
  for (let offset = 1; offset < seats.length; offset += 1) {
    const candidate = seats[(startIndex + offset) % seats.length]!;
    if (!candidate.public.eliminated) return candidate;
  }
  return undefined;
}

function matchingLuckyInteraction(
  input: JudgmentContext,
  source: DrawJudgmentSource,
): { readonly interaction: CompletedEffectInteraction; readonly candidateIds: readonly [string, string] } | undefined {
  const sourceCardInstanceId = source.kind === "jourdonnais_virtual_barrel"
    ? source.attackCard.cardInstanceId
    : source.cardInstanceId;
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (interaction.kind !== "LUCKY_DRAW" || interaction.context.continuationFrameId !== input.continuationFrameId ||
        interaction.context.playerId !== input.playerId || interaction.context.sourceKind !== source.kind ||
        interaction.context.sourceCardInstanceId !== sourceCardInstanceId) continue;
    const rawIds = interaction.context.candidateCardInstanceIds;
    if (!Array.isArray(rawIds) || rawIds.length !== 2 || rawIds.some((id) => typeof id !== "string" || id.trim() === "") ||
        new Set(rawIds).size !== 2) return undefined;
    return { interaction, candidateIds: rawIds as [string, string] };
  }
  return undefined;
}

function luckyCandidateCards(input: JudgmentContext, candidateIds: readonly [string, string]): readonly [LuckyCandidate, LuckyCandidate] | undefined {
  const first = input.state.zones.cardsByInstanceId[candidateIds[0]];
  const second = input.state.zones.cardsByInstanceId[candidateIds[1]];
  if (!first || !second || first.cardInstanceId !== candidateIds[0] || second.cardInstanceId !== candidateIds[1]) return undefined;
  return [first, second];
}

function stateAfterPlannedReshuffle(
  state: DeepReadonly<GameState>,
  events: readonly EffectEventDraft[],
): DeepReadonly<GameState> | undefined {
  const reshuffle = events.find(({ type }) => type === "DRAW_PILE_RESHUFFLED");
  if (!reshuffle) return state;
  const shuffledIds = reshuffle.payload.cardInstanceIds;
  if (!Array.isArray(shuffledIds)) return undefined;
  const stringIds = shuffledIds.filter((id): id is string => typeof id === "string");
  if (stringIds.length !== shuffledIds.length) return undefined;
  return {
    ...state,
    zones: {
      ...state.zones,
      drawPileCardInstanceIds: [...state.zones.drawPileCardInstanceIds, ...stringIds],
      discardPileCardInstanceIds: [],
    },
  };
}

function prepareLuckyJudgment(
  input: JudgmentContext,
  eventSourceCardInstanceId: string,
  checkKind: "DYNAMITE" | "BARREL",
  source: DrawJudgmentSource,
): JudgmentPreparation {
  const saved = matchingLuckyInteraction(input, source);
  let candidateIds: readonly [string, string];
  let supplyEvents: readonly EffectEventDraft[] = [];
  if (saved) {
    candidateIds = saved.candidateIds;
  } else {
    const supply = planDrawPileSupply({
      drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
      discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
      requestedCount: 2,
      actorPlayerId: input.playerId,
      sourceCardInstanceId: eventSourceCardInstanceId,
      destination: "peek",
      random: input.random,
      cardTypeId: checkKind === "DYNAMITE" ? "dynamite" : "barrel",
    });
    supplyEvents = supply.events;
    if (supply.exhausted) return { exhausted: true, events: supplyEvents };
    if (supply.cardInstanceIds.length !== 2 || new Set(supply.cardInstanceIds).size !== 2) return { invalid: true };
    candidateIds = supply.cardInstanceIds as [string, string];
  }

  const candidates = luckyCandidateCards(input, candidateIds);
  if (!candidates) return { invalid: true };
  const response = saved?.interaction.responses.length === 1 ? saved.interaction.responses[0] : undefined;
  const rawSelectedId = response?.choice === "SELECT_JUDGMENT" ? response.payload.selectedCardInstanceId : undefined;
  const selectedId = typeof rawSelectedId === "string" ? rawSelectedId : undefined;
  if (saved && (!selectedId || !candidateIds.includes(selectedId))) return { invalid: true };
  const luckyState = saved ? input.state : stateAfterPlannedReshuffle(input.state, supplyEvents);
  if (!luckyState) return { invalid: true };

  const result = luckyDukeAbility({
    characterId: "lucky_duke",
    playerId: input.playerId,
    state: luckyState,
    continuationFrameId: input.continuationFrameId,
    random: input.random,
    completedInteractions: input.completedInteractions,
    hook: {
      kind: "judgment",
      judgment: {
        kind: "lucky_draw",
        playerId: input.playerId,
        source,
        candidates,
        selection: selectedId === undefined ? { kind: "awaiting_choice" } : { kind: "selected", cardInstanceId: selectedId },
      },
    },
  });
  if (result.kind === "choice_required") {
    return { pending: { kind: "choice_required", request: result.request, events: [...supplyEvents, ...result.events], steps: [] } };
  }
  if (result.kind !== "applied" || !saved || typeof selectedId !== "string") return { invalid: true };
  const selected = candidates.find((card) => card.cardInstanceId === selectedId);
  if (!selected) return { invalid: true };
  return {
    cardInstanceId: selected.cardInstanceId,
    rank: selected.rank,
    suit: selected.suit,
    events: [event(`${checkKind}_JUDGMENT_REVEALED`, input.playerId, {
      sourceCardInstanceId: eventSourceCardInstanceId,
      cardInstanceId: selected.cardInstanceId,
      rank: selected.rank,
      suit: selected.suit,
      fromZone: "revealed_pool",
      toZone: "revealed_pool",
    }), ...result.events],
  };
}

function prepareJudgment(
  input: JudgmentContext,
  sourceCardInstanceId: string,
  checkKind: "DYNAMITE" | "BARREL",
  source: DrawJudgmentSource,
): JudgmentPreparation {
  const actor = uniqueSeat(input.state as CardEffectInput["state"], input.playerId);
  if (!actor) return { invalid: true };
  if (actor.public.characterId === "lucky_duke") {
    const drawSourceCardInstanceId = source.kind === "jourdonnais_virtual_barrel"
      ? source.attackCard.cardInstanceId
      : source.cardInstanceId;
    if (!drawSourceCardInstanceId) return { invalid: true };
    return prepareLuckyJudgment(input, drawSourceCardInstanceId, checkKind, source);
  }

  const supply = planDrawPileSupply({
    drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
    requestedCount: 1,
    actorPlayerId: input.playerId,
    sourceCardInstanceId,
    destination: "peek",
    random: input.random,
    cardTypeId: checkKind === "DYNAMITE" ? "dynamite" : "barrel",
  });
  if (supply.exhausted) return { exhausted: true, events: supply.events };
  const cardInstanceId = supply.cardInstanceIds[0];
  const instance = cardInstanceId ? input.state.zones.cardsByInstanceId[cardInstanceId] : undefined;
  if (!cardInstanceId || !instance || instance.cardInstanceId !== cardInstanceId) return { invalid: true };
  return {
    cardInstanceId,
    rank: instance.rank,
    suit: instance.suit,
    events: [
      ...supply.events,
      event(`${checkKind}_JUDGMENT_REVEALED`, input.playerId, {
        sourceCardInstanceId,
        cardInstanceId,
        rank: instance.rank,
        suit: instance.suit,
      }),
      event("CARD_DISCARDED", input.playerId, {
        sourceCardInstanceId,
        cardInstanceId,
        fromZone: "draw_pile",
        toZone: "discard",
        cause: `${checkKind}_JUDGMENT`,
      }),
    ],
  };
}

function checkStep(
  input: CardEffectInput,
  targetPlayerId: string,
  kind: AttackKind,
): EffectStep {
  return {
    effectId: `${input.continuationFrameId}:damage:${input.sourceCardInstanceId ?? "attack"}:${targetPlayerId}`,
    kind: "DAMAGE_PLAYER",
    sourcePlayerId: input.actorPlayerId,
    targetPlayerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload: { amount: 1, cause: kind },
  };
}

function dynamiteDamageStep(input: CardEffectInput, targetPlayerId: string): EffectStep {
  return {
    effectId: `${input.continuationFrameId}:dynamite-damage:${input.sourceCardInstanceId}`,
    kind: "DAMAGE_PLAYER",
    sourcePlayerId: null,
    targetPlayerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload: { amount: 3, cause: "DYNAMITE" },
  };
}

function dynamiteExplodes(judgment: PreparedJudgment): boolean {
  return judgment.suit === "SPADES" && typeof judgment.rank === "number" &&
    judgment.rank >= 2 && judgment.rank <= 9;
}

function dynamiteResult(input: CardEffectInput, actor: EffectSeat, judgment: PreparedJudgment): CardEffectResult {
  const sourceCardInstanceId = input.sourceCardInstanceId!;
  if (dynamiteExplodes(judgment)) {
    return {
      kind: "applied",
      events: [
        ...judgment.events,
        event("CARD_DISCARDED", null, {
          sourceCardInstanceId,
          cardInstanceId: sourceCardInstanceId,
          ownerPlayerId: actor.public.playerId,
          fromZone: "in_play",
          toZone: "discard",
          cause: "DYNAMITE_EXPLODED",
        }),
        event("DYNAMITE_EXPLODED", null, {
          sourceCardInstanceId,
          cardInstanceId: sourceCardInstanceId,
          targetPlayerId: actor.public.playerId,
          damage: 3,
          responsiblePlayerId: null,
        }),
      ],
      steps: [dynamiteDamageStep(input, actor.public.playerId)],
    };
  }

  const next = nextLivingOpponent(input.state, actor.public.playerId);
  if (!next) return invalid("TARGET_NOT_FOUND");
  return {
    kind: "applied",
    events: [
      ...judgment.events,
      event("CARD_TRANSFERRED", actor.public.playerId, {
        sourceCardInstanceId,
        cardInstanceId: sourceCardInstanceId,
        fromPlayerId: actor.public.playerId,
        fromZone: "in_play",
        toPlayerId: next.public.playerId,
        toZone: "in_play",
      }),
      event("DYNAMITE_PASSED", actor.public.playerId, {
        sourceCardInstanceId,
        cardInstanceId: sourceCardInstanceId,
        fromPlayerId: actor.public.playerId,
        toPlayerId: next.public.playerId,
        judgmentCardInstanceId: judgment.cardInstanceId,
      }),
    ],
    steps: [],
  };
}

/** Installs a physical Dynamite from the actor's hand; its judgment is a later start-phase effect. */
export const dynamiteInstallEffect: CardEffectModule = (input) => {
  if (input.targets.length > 0) return invalid("TARGET_NOT_ALLOWED");

  const sourceCardInstanceId = input.sourceCardInstanceId;
  if (!sourceCardInstanceId || cardType(input.state, sourceCardInstanceId) !== "dynamite") {
    return invalid("TARGET_NOT_ALLOWED");
  }

  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!actor) return invalid("TARGET_NOT_FOUND");
  if (actor.public.eliminated || actor.public.hp <= 0) return invalid("TARGET_NOT_ALIVE");
  if (!actor.private.handCardInstanceIds.includes(sourceCardInstanceId) ||
      actor.public.inPlayCardInstanceIds.some((cardInstanceId) =>
        cardType(input.state, cardInstanceId) === "dynamite")) {
    return invalid("TARGET_NOT_ALLOWED");
  }

  return {
    kind: "applied",
    events: [event("CARD_TRANSFERRED", input.actorPlayerId, {
      sourceCardInstanceId,
      cardInstanceId: sourceCardInstanceId,
      fromPlayerId: input.actorPlayerId,
      fromZone: "hand",
      toPlayerId: input.actorPlayerId,
      toZone: "in_play",
    })],
    steps: [],
  };
};

/** Resolve the current player's Dynamite at turn start, before the Jail layer. */
export const dynamiteStartEffect: CardEffectModule = (input) => {
  if (input.targets.length > 0) return invalid("TARGET_NOT_ALLOWED");
  if (input.state.status !== "playing" || input.state.turn.phase !== "start" ||
      input.state.turn.currentPlayerId !== input.actorPlayerId) return invalid("TARGET_NOT_ALLOWED");
  const actor = uniqueSeat(input.state, input.actorPlayerId);
  if (!actor) return invalid("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return invalid("TARGET_NOT_ALIVE");

  if (input.sourceCardInstanceId === null) {
    return { kind: "applied", events: [], steps: [] };
  }
  if (cardType(input.state, input.sourceCardInstanceId) !== "dynamite" ||
      !actor.public.inPlayCardInstanceIds.includes(input.sourceCardInstanceId)) {
    return invalid("TARGET_NOT_ALLOWED");
  }

  const judgment = prepareJudgment(
    {
      state: input.state,
      playerId: actor.public.playerId,
      continuationFrameId: input.continuationFrameId,
      completedInteractions: input.completedInteractions,
      random: input.random,
    },
    input.sourceCardInstanceId,
    "DYNAMITE",
    { kind: "dynamite", cardInstanceId: input.sourceCardInstanceId },
  );
  if ("invalid" in judgment) return invalid("TARGET_NOT_FOUND");
  if ("exhausted" in judgment) return { kind: "applied", events: judgment.events, steps: [] };
  if ("pending" in judgment) return judgment.pending;
  return dynamiteResult(input, actor, judgment);
};

function isDefenseSource(value: unknown): value is DefenseSource {
  return value === "barrel" || value === "jourdonnais";
}

function isAttackKind(value: unknown): value is AttackKind {
  return value === "BANG" || value === "GATLING";
}

function interactionKind(kind: AttackKind): "BANG_RESPONSE" | "GATLING_RESPONSE" {
  return kind === "BANG" ? "BANG_RESPONSE" : "GATLING_RESPONSE";
}

function findAttackInteraction(
  input: ResolveBarrelCheckStepInput,
  kind: AttackKind,
  sourcePlayerId: string,
  targetPlayerId: string,
  sourceCardInstanceId: string,
  targetStepId: string | null,
): CompletedEffectInteraction | undefined {
  const expectedKind = interactionKind(kind);
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (
      interaction.kind === expectedKind &&
      interaction.context.continuationFrameId === input.continuationFrameId &&
      interaction.context.sourcePlayerId === sourcePlayerId &&
      interaction.context.targetPlayerId === targetPlayerId &&
      interaction.context.sourceCardInstanceId === sourceCardInstanceId &&
      (targetStepId === null || interaction.context.targetStepId === undefined ||
        interaction.context.targetStepId === targetStepId)
    ) return interaction;
  }
  return undefined;
}

function readBarrelProgress(interaction: CompletedEffectInteraction, kind: AttackKind): BarrelProgress | undefined {
  const required = interaction.context.requiredMisses;
  if (required !== undefined && required !== 1 && required !== 2) return undefined;
  const requiredMisses = kind === "GATLING" ? 1 : (required ?? 1) as 1 | 2;
  const raw = interaction.context.barrelProgress;
  if (raw === undefined) {
    return { successfulMisses: 0, attemptedDefenseSources: [], usedMissedCardInstanceIds: [], requiredMisses };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (!Number.isInteger(record.successfulMisses) || (record.successfulMisses as number) < 0 ||
      !Array.isArray(record.attemptedDefenseSources) ||
      record.attemptedDefenseSources.some((source) => !isDefenseSource(source)) ||
      new Set(record.attemptedDefenseSources).size !== record.attemptedDefenseSources.length ||
      (record.usedMissedCardInstanceIds !== undefined &&
        (!Array.isArray(record.usedMissedCardInstanceIds) ||
          record.usedMissedCardInstanceIds.some((cardId) => typeof cardId !== "string" || cardId.trim() === "") ||
          new Set(record.usedMissedCardInstanceIds).size !== record.usedMissedCardInstanceIds.length))) return undefined;
  const usedMissedCardInstanceIds = record.usedMissedCardInstanceIds === undefined
    ? []
    : record.usedMissedCardInstanceIds as string[];
  return {
    successfulMisses: record.successfulMisses as number,
    attemptedDefenseSources: record.attemptedDefenseSources as DefenseSource[],
    usedMissedCardInstanceIds,
    requiredMisses,
  };
}

function cardIsMissed(input: ResolveBarrelCheckStepInput, cardInstanceId: string): boolean {
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId &&
    TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId) === "missed";
}

function targetDefenseOptions(
  input: ResolveBarrelCheckStepInput,
  target: EffectSeat,
  attempted: readonly DefenseSource[],
  usedMissedCardInstanceIds: readonly string[],
): InteractionOption[] {
  const usedMissed = new Set(usedMissedCardInstanceIds);
  const options: InteractionOption[] = target.private.handCardInstanceIds
    .filter((cardId) => !usedMissed.has(cardId) && cardIsMissed(input, cardId))
    .map((cardInstanceId) => ({ choice: "USE_MISSED", payload: { cardInstanceId } }));
  const hasBarrel = target.public.inPlayCardInstanceIds.some((id) => cardType(input.state as CardEffectInput["state"], id) === "barrel");
  const hasJourdonnais = target.public.characterId === "jourdonnais";
  if (hasBarrel && !attempted.includes("barrel")) options.push({ choice: "USE_BARREL", payload: {} });
  if (hasJourdonnais && !attempted.includes("jourdonnais")) options.push({ choice: "USE_JOURDONNAIS", payload: {} });
  options.push({ choice: "TAKE_HIT", payload: {} });
  return options;
}

function followupResponse(
  input: ResolveBarrelCheckStepInput,
  kind: AttackKind,
  targetPlayerId: string,
  sourcePlayerId: string,
  sourceCardInstanceId: string,
  targetStepId: string,
  progress: BarrelProgress,
  events: readonly EffectEventDraft[],
): CardEffectResult {
  const target = uniqueSeat(input.state as CardEffectInput["state"], targetPlayerId);
  if (!target || target.public.eliminated) return invalid("TARGET_NOT_ALIVE");
  return {
    kind: "response_required",
    request: {
      kind: interactionKind(kind),
      responders: [{
        playerId: targetPlayerId,
        options: targetDefenseOptions(
          input,
          target,
          progress.attemptedDefenseSources,
          progress.usedMissedCardInstanceIds,
        ),
      }],
      context: {
        continuationFrameId: input.continuationFrameId,
        sourcePlayerId,
        targetPlayerId,
        sourceCardInstanceId,
        targetStepId,
        attackKind: kind,
        barrelProgress: {
          successfulMisses: progress.successfulMisses,
          attemptedDefenseSources: [...progress.attemptedDefenseSources],
          usedMissedCardInstanceIds: [...progress.usedMissedCardInstanceIds],
        },
        requiredMisses: progress.requiredMisses,
      },
      resumeFrameId: input.continuationFrameId,
    },
    events: [...events],
    steps: [],
  };
}

function damageResult(
  input: ResolveBarrelCheckStepInput,
  sourcePlayerId: string,
  targetPlayerId: string,
  sourceCardInstanceId: string,
  kind: AttackKind,
  events: readonly EffectEventDraft[],
): CardEffectResult {
  return {
    kind: "applied",
    events: [...events],
    steps: [{
      effectId: `${input.continuationFrameId}:damage:${sourceCardInstanceId}:${targetPlayerId}`,
      kind: "DAMAGE_PLAYER",
      sourcePlayerId,
      targetPlayerId,
      sourceCardInstanceId,
      payload: { amount: 1, cause: kind },
    }],
  };
}

function defenseCompleteEvent(
  kind: AttackKind,
  sourcePlayerId: string,
  targetPlayerId: string,
  sourceCardInstanceId: string,
): EffectEventDraft {
  return event(kind === "GATLING" ? "GATLING_MISSED" : "BANG_MISSED", targetPlayerId, {
    sourcePlayerId,
    targetPlayerId,
    sourceCardInstanceId,
  });
}

function responseAfterCheck(
  input: ResolveBarrelCheckStepInput,
  kind: AttackKind,
  targetPlayerId: string,
  sourcePlayerId: string,
  sourceCardInstanceId: string,
  targetStepId: string,
  progress: BarrelProgress,
  events: readonly EffectEventDraft[],
): CardEffectResult {
  if (progress.successfulMisses >= progress.requiredMisses) {
    return {
      kind: "applied",
      events: [
        ...events,
        defenseCompleteEvent(kind, sourcePlayerId, targetPlayerId, sourceCardInstanceId),
      ],
      steps: [],
    };
  }
  return followupResponse(
    input,
    kind,
    targetPlayerId,
    sourcePlayerId,
    sourceCardInstanceId,
    targetStepId,
    progress,
    events,
  );
}

function useDefenseResponse(
  input: ResolveBarrelCheckStepInput,
  interaction: CompletedEffectInteraction,
  step: EffectStep,
  kind: AttackKind,
  defenseSource: DefenseSource,
  target: EffectSeat,
  sourcePlayerId: string,
  sourceCardInstanceId: string,
  targetStepId: string,
  progress: BarrelProgress,
): CardEffectResult {
  const answer = interaction.responses.at(-1);
  if (!answer || answer.playerId !== target.public.playerId) return invalid("TARGET_NOT_ALLOWED");

  if (answer.choice === "TAKE_HIT" && Object.keys(answer.payload).length === 0) {
    return damageResult(input, sourcePlayerId, target.public.playerId, sourceCardInstanceId, kind, [
      event(kind === "GATLING" ? "GATLING_HIT" : "BANG_HIT", sourcePlayerId, {
        sourceCardInstanceId,
        targetPlayerId: target.public.playerId,
        damage: 1,
      }),
    ]);
  }

  if (answer.choice === "USE_MISSED") {
    const cardInstanceId = answer.payload.cardInstanceId;
    if (typeof cardInstanceId !== "string" || !target.private.handCardInstanceIds.includes(cardInstanceId) ||
        !cardIsMissed(input, cardInstanceId)) return invalid("TARGET_NOT_ALLOWED");
    const next: BarrelProgress = {
      ...progress,
      successfulMisses: progress.successfulMisses + 1,
      usedMissedCardInstanceIds: [...progress.usedMissedCardInstanceIds, cardInstanceId],
    };
    const discard = event("CARD_DISCARDED", target.public.playerId, {
      sourceCardInstanceId,
      cardInstanceId,
      ownerPlayerId: target.public.playerId,
      fromZone: "hand",
      toZone: "discard",
    });
    return responseAfterCheck(input, kind, target.public.playerId, sourcePlayerId, sourceCardInstanceId, targetStepId, next, [discard]);
  }

  if (answer.choice === "USE_BARREL" || answer.choice === "USE_JOURDONNAIS") {
    const selectedSource: DefenseSource = answer.choice === "USE_BARREL" ? "barrel" : "jourdonnais";
    if (Object.keys(answer.payload).length !== 0 || selectedSource !== defenseSource ||
        progress.attemptedDefenseSources.includes(selectedSource)) return invalid("TARGET_NOT_ALLOWED");
    return runBarrelCheck(input, step, kind, selectedSource, target, sourcePlayerId, sourceCardInstanceId, targetStepId, progress);
  }

  return invalid("TARGET_NOT_ALLOWED");
}

function runBarrelCheck(
  input: ResolveBarrelCheckStepInput,
  step: EffectStep,
  kind: AttackKind,
  defenseSource: DefenseSource,
  target: EffectSeat,
  sourcePlayerId: string,
  sourceCardInstanceId: string,
  targetStepId: string,
  progress: BarrelProgress,
): CardEffectResult {
  if (progress.attemptedDefenseSources.includes(defenseSource)) return invalid("TARGET_NOT_ALLOWED");
  const hasBarrel = target.public.inPlayCardInstanceIds.some((id) => cardType(input.state as CardEffectInput["state"], id) === "barrel");
  const hasJourdonnais = target.public.characterId === "jourdonnais";
  if ((defenseSource === "barrel" && !hasBarrel) || (defenseSource === "jourdonnais" && !hasJourdonnais)) {
    return invalid("TARGET_NOT_ALLOWED");
  }

  let drawSource: DrawJudgmentSource;
  if (defenseSource === "barrel") {
    const barrelIds = target.public.inPlayCardInstanceIds.filter((id) => cardType(input.state as CardEffectInput["state"], id) === "barrel");
    if (barrelIds.length !== 1) return invalid("TARGET_NOT_ALLOWED");
    drawSource = { kind: "barrel", cardInstanceId: barrelIds[0]! };
  } else {
    const attackCard = input.state.zones.cardsByInstanceId[sourceCardInstanceId];
    const physicalType = attackCard && TYPE_BY_DEFINITION_ID.get(attackCard.cardDefinitionId);
    if (!attackCard || (physicalType !== "bang" && physicalType !== "missed" && physicalType !== "gatling")) {
      return invalid("TARGET_NOT_ALLOWED");
    }
    const attackCardReference: CharacterCardReference = {
      cardInstanceId: sourceCardInstanceId,
      physicalCardTypeId: physicalType,
      effectCardTypeId: kind === "GATLING" ? "gatling" : "bang",
    };
    drawSource = { kind: "jourdonnais_virtual_barrel", attackCard: attackCardReference };
  }
  const judgment = prepareJudgment({
    state: input.state,
    playerId: target.public.playerId,
    continuationFrameId: input.continuationFrameId,
    completedInteractions: input.completedInteractions,
    random: input.random,
  }, sourceCardInstanceId, "BARREL", drawSource);
  if ("invalid" in judgment) return invalid("TARGET_NOT_FOUND");
  if ("exhausted" in judgment) return { kind: "applied", events: judgment.events, steps: [] };
  if ("pending" in judgment) return judgment.pending;
  const heart = judgment.suit === "HEARTS";
  const attemptedDefenseSources = [...progress.attemptedDefenseSources, defenseSource];
  const next: BarrelProgress = {
    successfulMisses: progress.successfulMisses + Number(heart),
    attemptedDefenseSources,
    usedMissedCardInstanceIds: [...progress.usedMissedCardInstanceIds],
    requiredMisses: progress.requiredMisses,
  };
  const result = event("BARREL_CHECK_RESOLVED", target.public.playerId, {
    attackKind: kind,
    defenseSource,
    sourceCardInstanceId,
    targetPlayerId: target.public.playerId,
    judgmentCardInstanceId: judgment.cardInstanceId,
    succeeded: heart,
    successfulMisses: next.successfulMisses,
    requiredMisses: progress.requiredMisses,
  });
  return responseAfterCheck(input, kind, target.public.playerId, sourcePlayerId, sourceCardInstanceId, targetStepId, next, [
    ...judgment.events,
    result,
  ]);
}

/**
 * Resolves a saved T18 `BARREL_CHECK` step and its follow-up response. The
 * target queue step stays serialized until this result and any damage/death
 * consequence are completed by the caller.
 */
export function resolveBarrelCheckStep(input: ResolveBarrelCheckStepInput): CardEffectResult {
  const step = input.step;
  if (step.kind !== "BARREL_CHECK" || !step.targetPlayerId || !step.sourcePlayerId || !step.sourceCardInstanceId) {
    return invalid("TARGET_NOT_ALLOWED");
  }
  const rawKind = step.payload.attackKind;
  const rawDefenseSource = step.payload.defenseSource;
  const targetStepId = typeof step.payload.targetStepId === "string" ? step.payload.targetStepId : null;
  if (!isAttackKind(rawKind) || !isDefenseSource(rawDefenseSource)) return invalid("TARGET_NOT_ALLOWED");
  if (input.state.status !== "playing") return invalid("TARGET_NOT_ALLOWED");
  const target = uniqueSeat(input.state as CardEffectInput["state"], step.targetPlayerId);
  if (!target) return invalid("TARGET_NOT_FOUND");
  if (target.public.eliminated) return { kind: "applied", events: [], steps: [] };
  const attacker = uniqueSeat(input.state as CardEffectInput["state"], step.sourcePlayerId);
  if (!attacker) return invalid("TARGET_NOT_FOUND");
  const sourceType = cardType(input.state as CardEffectInput["state"], step.sourceCardInstanceId);
  if ((rawKind === "GATLING" && sourceType !== "gatling") ||
      (rawKind === "BANG" && sourceType !== "bang" &&
        !(sourceType === "missed" && attacker.public.characterId === "calamity_janet"))) {
    return invalid("TARGET_NOT_ALLOWED");
  }

  const interaction = findAttackInteraction(
    input,
    rawKind,
    step.sourcePlayerId,
    target.public.playerId,
    step.sourceCardInstanceId,
    targetStepId,
  );
  if (!interaction) return invalid("TARGET_NOT_ALLOWED");
  const answer = interaction.responses.at(-1);
  const hasProgress = interaction.context.barrelProgress !== undefined;
  const progress = readBarrelProgress(interaction, rawKind);
  if (!progress) return invalid("TARGET_NOT_ALLOWED");
  if (progress.successfulMisses > progress.requiredMisses) {
    return invalid("TARGET_NOT_ALLOWED");
  }
  if (!answer || answer.playerId !== target.public.playerId) return invalid("TARGET_NOT_ALLOWED");

  if (answer.choice === "USE_BARREL" || answer.choice === "USE_JOURDONNAIS") {
    // After one source has been attempted, a follow-up response may choose
    // the other available source while the serialized BARREL_CHECK step is
    // still at the head of the queue. Resolve the source from the saved
    // response; runBarrelCheck validates availability and one-attempt limits.
    const selectedSource: DefenseSource = answer.choice === "USE_BARREL" ? "barrel" : "jourdonnais";
    return runBarrelCheck(
      input,
      step,
      rawKind,
      selectedSource,
      target,
      step.sourcePlayerId,
      step.sourceCardInstanceId,
      targetStepId ?? `${input.continuationFrameId}:${step.sourceCardInstanceId}:${rawKind.toLowerCase()}:${target.public.playerId}`,
      progress,
    );
  }

  if (!hasProgress) return invalid("TARGET_NOT_ALLOWED");
  return useDefenseResponse(
    input,
    interaction,
    step,
    rawKind,
    rawDefenseSource,
    target,
    step.sourcePlayerId,
    step.sourceCardInstanceId,
    targetStepId ?? `${input.continuationFrameId}:${step.sourceCardInstanceId}:${rawKind.toLowerCase()}:${target.public.playerId}`,
    progress,
  );
}
