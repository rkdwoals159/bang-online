import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { luckyDukeAbility } from "../characters/lucky-duke.js";
import { planDrawPileSupply } from "../draw-pile.js";
import type { RandomSource } from "../../random/shuffle.js";
import type { GameState, JsonValue, SeatState } from "../../state/types.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  EffectTarget,
  IllegalEffectTargetCode,
} from "../api.js";
import type { DrawJudgmentSource, LuckyDrawJudgmentHookInput } from "../character-api.js";

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function reject(code: IllegalEffectTargetCode): CardEffectResult {
  return { kind: "invalid_target", code };
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function cardType(input: CardEffectInput, cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId
    ? TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId)
    : undefined;
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Readonly<Record<string, JsonValue>>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function sourceIsJail(input: CardEffectInput): boolean {
  return cardType(input, input.sourceCardInstanceId) === "jail";
}

function targetFromInput(input: CardEffectInput): EffectTarget | undefined {
  return input.targets.length === 1 ? input.targets[0] : undefined;
}

/** Installs Jail on one legal living player, leaving zone movement to the event applier. */
export const jailEffect: CardEffectModule = (input) => {
  if (!sourceIsJail(input)) return reject("TARGET_NOT_ALLOWED");
  if (input.targets.length === 0) return { kind: "target_required" };
  const targetRef = targetFromInput(input);
  if (!targetRef || targetRef.kind !== "player") return reject("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");
  const target = uniqueSeat(input.state as unknown as GameState, targetRef.playerId);
  if (!target) return reject("TARGET_NOT_FOUND");
  if (target.public.eliminated) return reject("TARGET_NOT_ALIVE");
  if (target.public.playerId === actor.public.playerId) return reject("TARGET_IS_SELF");
  if (target.private.roleId === "sheriff") return reject("TARGET_NOT_ALLOWED");

  const sourceCardInstanceId = input.sourceCardInstanceId;
  if (sourceCardInstanceId === null || !actor.private.handCardInstanceIds.includes(sourceCardInstanceId)) {
    return reject("TARGET_NOT_ALLOWED");
  }
  if (target.public.inPlayCardInstanceIds.some((cardInstanceId) => cardType(input, cardInstanceId) === "jail")) {
    return reject("TARGET_NOT_ALLOWED");
  }

  return {
    kind: "applied",
    events: [event("CARD_TRANSFERRED", input.actorPlayerId, {
      sourceCardInstanceId,
      cardInstanceId: sourceCardInstanceId,
      fromPlayerId: input.actorPlayerId,
      fromZone: "hand",
      toPlayerId: target.public.playerId,
      toZone: "in_play",
    })],
    steps: [],
  };
};

function runtimeJailFrameIsActive(input: CardEffectInput): boolean {
  return input.state.resolution.effectQueue.length === 1 &&
    input.state.resolution.effectQueue[0]?.kind === "RUN_EFFECT" &&
    input.state.resolution.effectQueue[0]?.effectId === `${input.continuationFrameId}:effect` &&
    input.state.resolution.continuations.some((frame) => frame.frameId === input.continuationFrameId && frame.kind === "EFFECT_RUNTIME");
}

function startJailIsValid(input: CardEffectInput, allowRuntimeFrame: boolean): boolean {
  if (!sourceIsJail(input) || input.targets.length !== 0) return false;
  if (input.state.status !== "playing" || input.state.turn.phase !== "start" ||
      input.state.turn.currentPlayerId !== input.actorPlayerId) return false;
  const resolution = input.state.resolution;
  const idle = resolution.effectQueue.length === 0 && resolution.continuations.length === 0 &&
    resolution.pendingInteraction === null && resolution.pendingDeath === null &&
    resolution.victoryCheckDeferredByEffectId === null;
  if (!idle && (!allowRuntimeFrame || !runtimeJailFrameIsActive(input) ||
      resolution.pendingInteraction !== null || resolution.pendingDeath !== null ||
      resolution.victoryCheckDeferredByEffectId !== null)) return false;

  const seat = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!seat || seat.public.eliminated || seat.private.roleId === "sheriff") return false;
  const jailCardInstanceId = input.sourceCardInstanceId;
  if (jailCardInstanceId === null || !seat.public.inPlayCardInstanceIds.includes(jailCardInstanceId)) return false;

  const installedJailIds = seat.public.inPlayCardInstanceIds.filter((cardInstanceId) =>
    cardType(input, cardInstanceId) === "jail",
  );
  if (installedJailIds.length !== 1 || installedJailIds[0] !== jailCardInstanceId) return false;

  // R05 puts Dynamite ahead of Jail; the caller must resolve/remove any
  // Dynamite on this seat before invoking this start-effect helper.
  return !seat.public.inPlayCardInstanceIds.some((cardInstanceId) => cardType(input, cardInstanceId) === "dynamite");
}

function judgmentExhausted(input: CardEffectInput): EffectEventDraft {
  return event("RULE_RESOURCE_EXHAUSTED", input.actorPlayerId, {
    sourceCardInstanceId: input.sourceCardInstanceId,
    cardTypeId: "jail",
    requestedCount: 1,
    fulfilledCount: 0,
    status: "paused",
    pauseReason: "RULE_RESOURCE_EXHAUSTED",
  });
}

type LuckyCandidate = LuckyDrawJudgmentHookInput["judgment"]["candidates"][number];

function matchingLuckyInteraction(
  input: CardEffectInput,
  source: DrawJudgmentSource,
  playerId: string,
): { readonly interaction: CompletedEffectInteraction; readonly candidateIds: readonly [string, string] } | undefined {
  const sourceCardInstanceId = source.kind === "jourdonnais_virtual_barrel"
    ? source.attackCard.cardInstanceId
    : source.cardInstanceId;
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (interaction.kind !== "LUCKY_DRAW" || interaction.context.continuationFrameId !== input.continuationFrameId ||
        interaction.context.playerId !== playerId || interaction.context.sourceKind !== source.kind ||
        interaction.context.sourceCardInstanceId !== sourceCardInstanceId) continue;
    const rawIds = interaction.context.candidateCardInstanceIds;
    if (!Array.isArray(rawIds) || rawIds.length !== 2 || rawIds.some((id) => typeof id !== "string" || id.trim() === "") ||
        new Set(rawIds).size !== 2) return undefined;
    return { interaction, candidateIds: rawIds as [string, string] };
  }
  return undefined;
}

function luckyCandidateCards(input: CardEffectInput, candidateIds: readonly [string, string]): readonly [LuckyCandidate, LuckyCandidate] | undefined {
  const first = input.state.zones.cardsByInstanceId[candidateIds[0]];
  const second = input.state.zones.cardsByInstanceId[candidateIds[1]];
  if (!first || !second || first.cardInstanceId !== candidateIds[0] || second.cardInstanceId !== candidateIds[1]) return undefined;
  return [first, second];
}

function stateAfterPlannedReshuffle(input: CardEffectInput, events: readonly EffectEventDraft[]): CardEffectInput["state"] | undefined {
  const reshuffle = events.find(({ type }) => type === "DRAW_PILE_RESHUFFLED");
  if (!reshuffle) return input.state;
  const shuffledIds = reshuffle.payload.cardInstanceIds;
  if (!Array.isArray(shuffledIds)) return undefined;
  const stringIds = shuffledIds.filter((id): id is string => typeof id === "string");
  if (stringIds.length !== shuffledIds.length) return undefined;
  return {
    ...input.state,
    zones: {
      ...input.state.zones,
      drawPileCardInstanceIds: [...input.state.zones.drawPileCardInstanceIds, ...stringIds],
      discardPileCardInstanceIds: [],
    },
  };
}

function luckyJailJudgment(input: CardEffectInput, sourceCardInstanceId: string, playerId: string):
  | { readonly kind: "selected"; readonly card: LuckyCandidate; readonly events: readonly EffectEventDraft[] }
  | { readonly kind: "choice_required"; readonly request: Extract<CardEffectResult, { kind: "choice_required" }>["request"]; readonly events: readonly EffectEventDraft[] }
  | { readonly kind: "exhausted"; readonly events: readonly EffectEventDraft[] }
  | { readonly kind: "invalid" } {
  const source: DrawJudgmentSource = { kind: "jail", cardInstanceId: sourceCardInstanceId };
  const saved = matchingLuckyInteraction(input, source, playerId);
  let candidateIds: readonly [string, string];
  let supplyEvents: readonly EffectEventDraft[] = [];
  if (saved) {
    candidateIds = saved.candidateIds;
  } else {
    const supply = planDrawPileSupply({
      drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
      discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
      requestedCount: 2,
      actorPlayerId: playerId,
      sourceCardInstanceId,
      destination: "peek",
      random: input.random,
      cardTypeId: "jail",
    });
    supplyEvents = supply.events;
    if (supply.exhausted) return { kind: "exhausted", events: supplyEvents };
    if (supply.cardInstanceIds.length !== 2 || new Set(supply.cardInstanceIds).size !== 2) return { kind: "invalid" };
    candidateIds = supply.cardInstanceIds as [string, string];
  }

  const candidates = luckyCandidateCards(input, candidateIds);
  if (!candidates) return { kind: "invalid" };
  const response = saved?.interaction.responses.length === 1 ? saved.interaction.responses[0] : undefined;
  const rawSelectedId = response?.choice === "SELECT_JUDGMENT" ? response.payload.selectedCardInstanceId : undefined;
  const selectedId = typeof rawSelectedId === "string" ? rawSelectedId : undefined;
  if (saved && (!selectedId || !candidateIds.includes(selectedId))) return { kind: "invalid" };
  const luckyState = saved ? input.state : stateAfterPlannedReshuffle(input, supplyEvents);
  if (!luckyState) return { kind: "invalid" };

  const result = luckyDukeAbility({
    characterId: "lucky_duke",
    playerId,
    state: luckyState,
    continuationFrameId: input.continuationFrameId,
    random: input.random,
    completedInteractions: input.completedInteractions,
    hook: {
      kind: "judgment",
      judgment: {
        kind: "lucky_draw",
        playerId,
        source,
        candidates,
        selection: selectedId === undefined ? { kind: "awaiting_choice" } : { kind: "selected", cardInstanceId: selectedId },
      },
    },
  });
  if (result.kind === "choice_required") {
    return { kind: "choice_required", request: result.request, events: [...supplyEvents, ...result.events] };
  }
  if (result.kind !== "applied" || !saved || typeof selectedId !== "string") return { kind: "invalid" };
  const selected = candidates.find((card) => card.cardInstanceId === selectedId);
  if (!selected) return { kind: "invalid" };
  return {
    kind: "selected",
    card: selected,
    events: result.events,
  };
}

/**
 * Resolves an installed Jail at its owner's start phase, after the caller has
 * handled Dynamite. The result event's `turnSkipped` tells the turn layer
 * whether to call skipTurnAfterStartResolution or completeStartEffects.
 */
function resolveJail(input: CardEffectInput, allowRuntimeFrame: boolean): CardEffectResult {
  if (!startJailIsValid(input, allowRuntimeFrame)) return reject("TARGET_NOT_ALLOWED");
  const jailCardInstanceId = input.sourceCardInstanceId;
  if (jailCardInstanceId === null) return reject("TARGET_NOT_ALLOWED");
  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");

  let judgmentCardInstanceId: string | undefined;
  let rank: number | string;
  let suit: string;
  let events: readonly EffectEventDraft[];
  if (actor.public.characterId === "lucky_duke") {
    const lucky = luckyJailJudgment(input, jailCardInstanceId, actor.public.playerId);
    if (lucky.kind === "invalid") return reject("TARGET_NOT_FOUND");
    if (lucky.kind === "exhausted") return { kind: "applied", events: lucky.events, steps: [] };
    if (lucky.kind === "choice_required") return { kind: "choice_required", request: lucky.request, events: lucky.events, steps: [] };
    judgmentCardInstanceId = lucky.card.cardInstanceId;
    rank = lucky.card.rank;
    suit = lucky.card.suit;
    events = lucky.events;
  } else {
    const supply = planDrawPileSupply({
      drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
      discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
      requestedCount: 1,
      actorPlayerId: input.actorPlayerId,
      sourceCardInstanceId: jailCardInstanceId,
      destination: "peek",
      random: input.random,
      cardTypeId: "jail",
    });
    const candidateId = supply.cardInstanceIds[0];
    if (!candidateId) return { kind: "applied", events: supply.events.length ? supply.events : [judgmentExhausted(input)], steps: [] };
    const card = input.state.zones.cardsByInstanceId[candidateId];
    if (!card || card.cardInstanceId !== candidateId) return reject("TARGET_NOT_FOUND");
    judgmentCardInstanceId = candidateId;
    rank = card.rank;
    suit = card.suit;
    events = [
      ...supply.events,
      event("JAIL_JUDGMENT_REVEALED", input.actorPlayerId, {
        sourceCardInstanceId: jailCardInstanceId,
        judgmentCardInstanceId: candidateId,
        rank,
        suit,
        fromZone: "draw_pile",
        toZone: "revealed_pool",
      }),
      event("CARD_DISCARDED", input.actorPlayerId, {
        sourceCardInstanceId: jailCardInstanceId,
        cardInstanceId: candidateId,
        ownerPlayerId: null,
        fromZone: "revealed_pool",
        toZone: "discard",
      }),
    ];
  }

  const heart = suit === "HEARTS";
  return {
    kind: "applied",
    events: [
      ...events,
      event("CARD_DISCARDED", input.actorPlayerId, {
        sourceCardInstanceId: jailCardInstanceId,
        cardInstanceId: jailCardInstanceId,
        ownerPlayerId: input.actorPlayerId,
        fromZone: "in_play",
        toZone: "discard",
      }),
      event("JAIL_JUDGMENT_RESOLVED", input.actorPlayerId, {
        sourceCardInstanceId: jailCardInstanceId,
        judgmentCardInstanceId,
        suit,
        heart,
        turnSkipped: !heart,
      }),
    ],
    steps: [],
  };
}

/** Runtime phase module used by T67 so Lucky's pending choice is saved by T12. */
export const jailStartEffect: CardEffectModule = (input) => resolveJail(input, true);

/** Direct compatibility helper used by focused card tests; requires an idle T12 state. */
export function resolveJailAtTurnStart(input: CardEffectInput): CardEffectResult {
  return resolveJail(input, false);
}
