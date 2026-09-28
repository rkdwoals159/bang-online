import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.js";
import type { MatchOutcome } from "../state/types.js";
import type { GameState, JsonValue, ResolutionFrame, SeatState } from "../state/types.js";
import { shuffle, type RandomSource } from "../random/shuffle.js";
import {
  beginDiscardOrder,
  canCheckVictory,
  completeDeathCleanup,
  completeDeathWinCheck,
  markDeathCleanupReady,
} from "../resolution/index.js";

const ENDGAME_RECORD_KEY = "__endgameElimination";
const RESOLUTION_RESULTS_KEY = "__resolutionResults";

export type EndgameErrorCode =
  | "MATCH_NOT_PLAYING"
  | "INVALID_STATE"
  | "INVALID_DEATH_STAGE"
  | "INVALID_ATTRIBUTION"
  | "INVALID_DISCARD_ORDER"
  | "FRAME_NOT_FOUND"
  | "NO_VICTORY_BOUNDARY"
  | "INVALID_RANDOM";

export interface EndgameError {
  code: EndgameErrorCode;
  message: string;
}

export type EndgameResult<T> =
  | { ok: true; state: GameState; value: T }
  | { ok: false; error: EndgameError };

export type DeathAttribution =
  | { kind: "player_effect" }
  | { kind: "dynamite" }
  | { kind: "duel"; initiatorPlayerId: string };

export interface BeginEliminationInput {
  victimPlayerId: string;
  attribution: DeathAttribution;
  /** Required only when the victim has cards and no living Vulture Sam exists. */
  discardInteractionId?: string;
  /** Required with discardInteractionId; timestamps are supplied by the caller for replayability. */
  createdAt?: string;
}

export interface AdvanceEliminationInput {
  /** Used if the Sheriff must choose an order for their post-kill penalty. */
  interactionId?: string;
  createdAt?: string;
  /** Used only when an Outlaw reward needs a discard-pile reshuffle. */
  random: RandomSource;
}

export type EliminationProgress =
  | { stage: "awaiting_discard"; interactionId: string; actorPlayerId: string }
  | { stage: "awaiting_resolution"; rewardCardsRemaining: number }
  | { stage: "resource_exhausted"; rewardCardsRemaining: number }
  | {
      stage: "cleanup_complete";
      winCheckRequired: boolean;
      victoryChecked: boolean;
      outcome: MatchOutcome | null;
    };

export interface BeginEliminationResult {
  victimPlayerId: string;
  vultureSamPlayerId: string | null;
  discardedDynamiteCardInstanceIds: string[];
  awaitingInteractionId: string | null;
  sheriffPenaltyPlayerId: string | null;
  rewardPlayerId: string | null;
}

type EliminationPhase = "victim_discard" | "after_victim_discard" | "sheriff_discard" | "reward" | "cleanup";
type EndgameDiscardReason = "elimination_cleanup" | "effect_cleanup";

interface SavedDiscardOrder {
  interactionId: string;
  ownerPlayerId: string;
  reason: EndgameDiscardReason;
  allowedCardInstanceIds: string[];
  requiredCount: number;
}

interface SavedElimination {
  schemaVersion: 1;
  victimPlayerId: string;
  sourcePlayerId: string | null;
  attributionKind: DeathAttribution["kind"];
  duelInitiatorPlayerId: string | null;
  responsiblePlayerId: string | null;
  sheriffPenaltyPlayerId: string | null;
  rewardPlayerId: string | null;
  rewardCardsRemaining: number;
  phase: EliminationPhase;
  pendingDiscard: SavedDiscardOrder | null;
}

function failure<T = never>(code: EndgameErrorCode, message: string): EndgameResult<T> {
  return { ok: false, error: { code, message } };
}

function commit<T>(previous: GameState, state: GameState, value: T): EndgameResult<T> {
  return { ok: true, state: { ...state, version: previous.version + 1 }, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function uniqueFrameIndex(state: GameState, frameId: string): number {
  const matches = state.resolution.continuations
    .map((frame, index) => (frame.frameId === frameId ? index : -1))
    .filter((index) => index >= 0);
  return matches.length === 1 ? matches[0]! : -1;
}

function frameFor(state: GameState, frameId: string): ResolutionFrame | undefined {
  const index = uniqueFrameIndex(state, frameId);
  return index < 0 ? undefined : state.resolution.continuations[index];
}

function replaceFrame(state: GameState, frameId: string, frame: ResolutionFrame): GameState | undefined {
  const index = uniqueFrameIndex(state, frameId);
  if (index < 0) return undefined;
  const continuations = [...state.resolution.continuations];
  continuations[index] = frame;
  return { ...state, resolution: { ...state.resolution, continuations } };
}

function saveElimination(state: GameState, frameId: string, record: SavedElimination | null): GameState | undefined {
  const frame = frameFor(state, frameId);
  if (!frame) return undefined;
  const payload = { ...frame.payload };
  if (record === null) {
    delete payload[ENDGAME_RECORD_KEY];
  } else {
    payload[ENDGAME_RECORD_KEY] = record as unknown as JsonValue;
  }
  return replaceFrame(state, frameId, { ...frame, payload });
}

function isSavedDiscardOrder(value: unknown): value is SavedDiscardOrder {
  return isRecord(value) &&
    nonEmptyString(value.interactionId) &&
    nonEmptyString(value.ownerPlayerId) &&
    (value.reason === "elimination_cleanup" || value.reason === "effect_cleanup") &&
    Array.isArray(value.allowedCardInstanceIds) &&
    value.allowedCardInstanceIds.every(nonEmptyString) &&
    Number.isInteger(value.requiredCount) &&
    value.requiredCount === value.allowedCardInstanceIds.length;
}

function isSavedElimination(value: unknown): value is SavedElimination {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    nonEmptyString(value.victimPlayerId) &&
    (value.sourcePlayerId === null || nonEmptyString(value.sourcePlayerId)) &&
    (value.attributionKind === "player_effect" || value.attributionKind === "dynamite" || value.attributionKind === "duel") &&
    (value.duelInitiatorPlayerId === null || nonEmptyString(value.duelInitiatorPlayerId)) &&
    (value.responsiblePlayerId === null || nonEmptyString(value.responsiblePlayerId)) &&
    (value.sheriffPenaltyPlayerId === null || nonEmptyString(value.sheriffPenaltyPlayerId)) &&
    (value.rewardPlayerId === null || nonEmptyString(value.rewardPlayerId)) &&
    Number.isInteger(value.rewardCardsRemaining) && (value.rewardCardsRemaining as number) >= 0 &&
    (value.phase === "victim_discard" || value.phase === "after_victim_discard" ||
      value.phase === "sheriff_discard" || value.phase === "reward" || value.phase === "cleanup") &&
    (value.pendingDiscard === null || isSavedDiscardOrder(value.pendingDiscard));
}

function getSavedElimination(state: GameState, frameId: string): SavedElimination | undefined {
  const frame = frameFor(state, frameId);
  const value = frame?.payload[ENDGAME_RECORD_KEY];
  return isSavedElimination(value) ? value : undefined;
}

function checkCardZoneInvariant(state: GameState): string | null {
  const knownIds = Object.keys(state.zones.cardsByInstanceId);
  const seen = new Set<string>();
  const cardIds = [
    ...state.seats.flatMap((seat) => [
      ...seat.private.handCardInstanceIds,
      ...seat.public.inPlayCardInstanceIds,
    ]),
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
  ];
  for (const cardInstanceId of cardIds) {
    if (!nonEmptyString(cardInstanceId) || seen.has(cardInstanceId) || !state.zones.cardsByInstanceId[cardInstanceId]) {
      return "Every physical card must occur in exactly one known zone.";
    }
    seen.add(cardInstanceId);
  }
  if (seen.size !== knownIds.length || knownIds.some((cardInstanceId) => !seen.has(cardInstanceId))) {
    return "Every cataloged physical card must occur in exactly one known zone.";
  }
  return null;
}

function allOwnedCards(seat: SeatState): string[] {
  return [...seat.private.handCardInstanceIds, ...seat.public.inPlayCardInstanceIds];
}

function getDynamiteDefinitionIds(): Set<string> {
  return new Set(BASE_PHYSICAL_CARDS.filter((card) => card.typeId === "dynamite").map((card) => card.definitionId));
}

const DYNAMITE_DEFINITION_IDS = getDynamiteDefinitionIds();

function isDynamiteCard(state: GameState, cardInstanceId: string): boolean {
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  return Boolean(instance && DYNAMITE_DEFINITION_IDS.has(instance.cardDefinitionId));
}

function moveCardsToDiscard(state: GameState, ownerPlayerId: string, orderedCardInstanceIds: readonly string[]): GameState | undefined {
  const owner = uniqueSeat(state, ownerPlayerId);
  if (!owner || orderedCardInstanceIds.length === 0) return undefined;
  const owned = allOwnedCards(owner);
  if (new Set(owned).size !== owned.length ||
      orderedCardInstanceIds.length !== owned.length ||
      new Set(orderedCardInstanceIds).size !== orderedCardInstanceIds.length ||
      orderedCardInstanceIds.some((cardId) => !owned.includes(cardId))) {
    return undefined;
  }

  const nextOwner: SeatState = {
    ...owner,
    private: { ...owner.private, handCardInstanceIds: [] },
    public: { ...owner.public, inPlayCardInstanceIds: [] },
  };
  const seats = state.seats.map((seat) => seat.public.playerId === ownerPlayerId ? nextOwner : seat);
  return {
    ...state,
    seats,
    zones: {
      ...state.zones,
      discardPileCardInstanceIds: [...state.zones.discardPileCardInstanceIds, ...orderedCardInstanceIds],
    },
  };
}

function interactionResult(frame: ResolutionFrame, interactionId: string): Record<string, unknown> | undefined {
  const results = frame.payload[RESOLUTION_RESULTS_KEY];
  if (!Array.isArray(results)) return undefined;
  const matches = results.filter((result) => isRecord(result) && result.interactionId === interactionId);
  return matches.length === 1 && isRecord(matches[0]) ? matches[0] : undefined;
}

function savedDiscardOrder(
  frame: ResolutionFrame,
  record: SavedElimination,
): string[] | undefined {
  const pending = record.pendingDiscard;
  if (!pending) return undefined;
  const result = interactionResult(frame, pending.interactionId);
  if (!result || result.kind !== "DISCARDS_ORDER" || !Array.isArray(result.responses) || result.responses.length !== 1) {
    return undefined;
  }
  const context = result.context;
  const spec = isRecord(context) ? context.discardOrder : undefined;
  const response = result.responses[0];
  if (!isRecord(response) || response.playerId !== pending.ownerPlayerId || response.choice !== "ORDER_CARDS" ||
      !isRecord(response.payload) || !Array.isArray(response.payload.orderedCardInstanceIds) ||
      !isRecord(spec) || spec.reason !== pending.reason ||
      spec.requiredCount !== pending.requiredCount ||
      !Array.isArray(spec.allowedCardInstanceIds) ||
      JSON.stringify(spec.allowedCardInstanceIds) !== JSON.stringify(pending.allowedCardInstanceIds)) {
    return undefined;
  }
  const ordered = response.payload.orderedCardInstanceIds;
  if (ordered.length !== pending.requiredCount ||
      !ordered.every((cardId) => nonEmptyString(cardId) && pending.allowedCardInstanceIds.includes(cardId)) ||
      new Set(ordered).size !== ordered.length) {
    return undefined;
  }
  return [...ordered] as string[];
}

function victoryOutcome(state: GameState): MatchOutcome | null | string {
  const playerIds = state.seats.map((seat) => seat.public.playerId);
  if (new Set(playerIds).size !== playerIds.length || playerIds.some((playerId) => !nonEmptyString(playerId))) {
    return "The match must contain unique, non-empty player IDs before victory can be checked.";
  }
  const sheriffs = state.seats.filter((seat) => seat.private.roleId === "sheriff");
  if (sheriffs.length !== 1) return "The match must contain exactly one Sheriff.";
  const sheriffAlive = !sheriffs[0]!.public.eliminated;
  const living = state.seats.filter((seat) => !seat.public.eliminated);

  if (!sheriffAlive) {
    if (living.length === 1 && living[0]!.private.roleId === "renegade") {
      return {
        winningFaction: "renegade",
        winningPlayerIds: [living[0]!.public.playerId],
      };
    }
    return {
      winningFaction: "outlaws",
      winningPlayerIds: state.seats.filter((seat) => seat.private.roleId === "outlaw")
        .sort((left, right) => left.public.seatIndex - right.public.seatIndex)
        .map((seat) => seat.public.playerId),
    };
  }

  const opposingRolesRemain = living.some((seat) => seat.private.roleId === "outlaw" || seat.private.roleId === "renegade");
  if (!opposingRolesRemain) {
    return {
      winningFaction: "sheriff_and_deputies",
      winningPlayerIds: state.seats
        .filter((seat) => seat.private.roleId === "sheriff" || seat.private.roleId === "deputy")
        .sort((left, right) => left.public.seatIndex - right.public.seatIndex)
        .map((seat) => seat.public.playerId),
    };
  }
  return null;
}

function recordOutcome(state: GameState, outcome: MatchOutcome | null): GameState {
  if (!outcome) return state;
  return {
    ...state,
    status: "completed",
    pauseReason: null,
    outcome,
    seats: state.seats.map((seat) => ({
      ...seat,
      public: { ...seat.public, roleRevealed: true },
    })),
  };
}

/** Checks a normal effect boundary. T12 must have closed every queue, prompt, death stage, and frame. */
export function checkVictoryAtBoundary(
  state: GameState,
): EndgameResult<{ finished: boolean; outcome: MatchOutcome | null }> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "Victory cannot be checked after a match has left play.");
  if (!canCheckVictory(state)) return failure("NO_VICTORY_BOUNDARY", "Victory is checked only after T12 has closed all resolution work.");
  const outcome = victoryOutcome(state);
  if (typeof outcome === "string") return failure("INVALID_STATE", outcome);
  if (outcome === null) {
    return { ok: true, state, value: { finished: false, outcome: null } };
  }
  return commit(state, recordOutcome(state, outcome), { finished: outcome !== null, outcome });
}

/**
 * Begins elimination only after T12 has accepted or exhausted the victim's
 * rescue choices. It reveals the role, transfers custody, and opens any owner
 * discard order before kill after-effects can proceed.
 */
export function beginElimination(
  state: GameState,
  input: BeginEliminationInput,
): EndgameResult<BeginEliminationResult> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "Elimination can only begin during a playing match.");
  const pendingDeath = state.resolution.pendingDeath;
  if (!pendingDeath || pendingDeath.consequenceStage !== "elimination" || pendingDeath.victimPlayerId !== input.victimPlayerId ||
      state.resolution.pendingInteraction !== null) {
    return failure("INVALID_DEATH_STAGE", "T12 must finish the victim-only rescue stage before elimination begins.");
  }
  if (!pendingDeath.resumeFrameId || uniqueFrameIndex(state, pendingDeath.resumeFrameId) < 0) {
    return failure("FRAME_NOT_FOUND", "Elimination needs the saved T12 continuation frame.");
  }
  const zoneIssue = checkCardZoneInvariant(state);
  if (zoneIssue) return failure("INVALID_STATE", zoneIssue);
  const victim = uniqueSeat(state, input.victimPlayerId);
  if (!victim || victim.public.eliminated || victim.public.hp > 0) {
    return failure("INVALID_STATE", "The victim must be a unique, non-eliminated seat at zero or fewer HP.");
  }
  const priorRecord = frameFor(state, pendingDeath.resumeFrameId)!.payload[ENDGAME_RECORD_KEY];
  if (priorRecord !== undefined) return failure("INVALID_STATE", "This continuation already owns an elimination record.");

  let responsiblePlayerId: string | null = null;
  if (input.attribution.kind === "player_effect") {
    if (!pendingDeath.sourcePlayerId || !uniqueSeat(state, pendingDeath.sourcePlayerId)) {
      return failure("INVALID_ATTRIBUTION", "A player-caused elimination needs the saved source player.");
    }
    responsiblePlayerId = pendingDeath.sourcePlayerId === input.victimPlayerId ? null : pendingDeath.sourcePlayerId;
  } else if (input.attribution.kind === "dynamite") {
    if (pendingDeath.sourcePlayerId !== null) {
      return failure("INVALID_ATTRIBUTION", "Dynamite has no responsible player under R24 and R28.");
    }
  } else {
    if (!nonEmptyString(input.attribution.initiatorPlayerId) ||
        pendingDeath.sourcePlayerId !== input.attribution.initiatorPlayerId) {
      return failure("INVALID_ATTRIBUTION", "A Duel elimination must retain its saved initiator as the source.");
    }
    if (input.attribution.initiatorPlayerId !== input.victimPlayerId) {
      responsiblePlayerId = input.attribution.initiatorPlayerId;
    }
  }

  const livingSam = state.seats.filter((seat) => !seat.public.eliminated &&
    seat.public.playerId !== input.victimPlayerId && seat.public.characterId === "vulture_sam");
  if (livingSam.length > 1) return failure("INVALID_STATE", "Only one living Vulture Sam may receive eliminated cards.");
  const vultureSam = livingSam[0];

  const victimCards = allOwnedCards(victim);
  const dynamiteIds = input.attribution.kind === "dynamite"
    ? victim.public.inPlayCardInstanceIds.filter((cardInstanceId) => isDynamiteCard(state, cardInstanceId))
    : [];
  const custodyCardIds = victimCards.filter((cardInstanceId) => !dynamiteIds.includes(cardInstanceId));
  const isAlreadyDiscarded = dynamiteIds.every((cardInstanceId) => state.zones.discardPileCardInstanceIds.includes(cardInstanceId));

  let nextState: GameState = {
    ...state,
    seats: state.seats.map((seat) => seat.public.playerId === input.victimPlayerId
      ? { ...seat, public: { ...seat.public, eliminated: true, roleRevealed: true } }
      : seat),
  };

  if (dynamiteIds.length > 0 && !isAlreadyDiscarded) {
    const updatedVictim: SeatState = {
      ...victim,
      public: {
        ...victim.public,
        eliminated: true,
        roleRevealed: true,
        inPlayCardInstanceIds: victim.public.inPlayCardInstanceIds.filter((cardId) => !dynamiteIds.includes(cardId)),
      },
    };
    nextState = {
      ...nextState,
      seats: nextState.seats.map((seat) => seat.public.playerId === input.victimPlayerId ? updatedVictim : seat),
      zones: {
        ...nextState.zones,
        discardPileCardInstanceIds: [...nextState.zones.discardPileCardInstanceIds, ...dynamiteIds],
      },
    };
  }

  if (vultureSam) {
    const currentSam = uniqueSeat(nextState, vultureSam.public.playerId)!;
    const updatedSam: SeatState = {
      ...currentSam,
      private: {
        ...currentSam.private,
        handCardInstanceIds: [...currentSam.private.handCardInstanceIds, ...custodyCardIds],
      },
    };
    const updatedVictim: SeatState = {
      ...uniqueSeat(nextState, input.victimPlayerId)!,
      private: { ...victim.private, handCardInstanceIds: [] },
      public: { ...victim.public, eliminated: true, roleRevealed: true, inPlayCardInstanceIds: [] },
    };
    nextState = {
      ...nextState,
      seats: nextState.seats.map((seat) => {
        if (seat.public.playerId === vultureSam.public.playerId) return updatedSam;
        if (seat.public.playerId === input.victimPlayerId) return updatedVictim;
        return seat;
      }),
    };
  }

  const cleanupReady = markDeathCleanupReady(nextState, input.victimPlayerId);
  if (!cleanupReady.ok) return failure("INVALID_DEATH_STAGE", cleanupReady.error.message);
  nextState = cleanupReady.state;

  const responsibleSeat = responsiblePlayerId ? uniqueSeat(nextState, responsiblePlayerId) : undefined;
  const sheriffPenaltyPlayerId = responsibleSeat && !responsibleSeat.public.eliminated &&
    responsibleSeat.private.roleId === "sheriff" && victim.private.roleId === "deputy"
    ? responsibleSeat.public.playerId
    : null;
  const rewardPlayerId = responsibleSeat && !responsibleSeat.public.eliminated &&
    responsibleSeat.public.playerId !== input.victimPlayerId && victim.private.roleId === "outlaw"
    ? responsibleSeat.public.playerId
    : null;

  const needsVictimOrder = !vultureSam && custodyCardIds.length > 0;
  const record: SavedElimination = {
    schemaVersion: 1,
    victimPlayerId: input.victimPlayerId,
    sourcePlayerId: pendingDeath.sourcePlayerId,
    attributionKind: input.attribution.kind,
    duelInitiatorPlayerId: input.attribution.kind === "duel" ? input.attribution.initiatorPlayerId : null,
    responsiblePlayerId,
    sheriffPenaltyPlayerId,
    rewardPlayerId,
    rewardCardsRemaining: rewardPlayerId ? 3 : 0,
    phase: needsVictimOrder ? "victim_discard" : "after_victim_discard",
    pendingDiscard: needsVictimOrder
      ? {
          interactionId: input.discardInteractionId ?? "",
          ownerPlayerId: input.victimPlayerId,
          reason: "elimination_cleanup",
          allowedCardInstanceIds: [...custodyCardIds],
          requiredCount: custodyCardIds.length,
        }
      : null,
  };
  if (needsVictimOrder && (!nonEmptyString(input.discardInteractionId) || !nonEmptyString(input.createdAt))) {
    return failure("INVALID_STATE", "The eliminated owner needs a discard interaction ID and caller-supplied timestamp.");
  }
  const saved = saveElimination(nextState, pendingDeath.resumeFrameId, record);
  if (!saved) return failure("FRAME_NOT_FOUND", "The elimination continuation frame disappeared.");
  nextState = saved;

  let awaitingInteractionId: string | null = null;
  if (needsVictimOrder) {
    const discarded = beginDiscardOrder(nextState, {
      interactionId: input.discardInteractionId!,
      playerId: input.victimPlayerId,
      cardInstanceIds: custodyCardIds,
      requiredCount: custodyCardIds.length,
      reason: "elimination_cleanup",
      context: { endgameStage: "victim_card_cleanup" },
      resumeFrameId: pendingDeath.resumeFrameId,
      createdAt: input.createdAt!,
    });
    if (!discarded.ok) return failure("INVALID_DISCARD_ORDER", discarded.error.message);
    nextState = discarded.state;
    awaitingInteractionId = input.discardInteractionId!;
  }

  return commit(state, nextState, {
    victimPlayerId: input.victimPlayerId,
    vultureSamPlayerId: vultureSam?.public.playerId ?? null,
    discardedDynamiteCardInstanceIds: dynamiteIds,
    awaitingInteractionId,
    sheriffPenaltyPlayerId,
    rewardPlayerId,
  });
}

function nextDiscardForSheriff(
  state: GameState,
  frameId: string,
  record: SavedElimination,
  input: AdvanceEliminationInput,
): EndgameResult<{ state: GameState; record: SavedElimination }> {
  const sheriffId = record.sheriffPenaltyPlayerId;
  if (!sheriffId) {
    return { ok: true, state, value: { state, record: { ...record, phase: "reward", pendingDiscard: null } } };
  }
  const sheriff = uniqueSeat(state, sheriffId);
  if (!sheriff || sheriff.public.eliminated) {
    return failure("INVALID_STATE", "The living Sheriff penalty owner must still exist before their penalty resolves.");
  }
  const candidateIds = allOwnedCards(sheriff);
  if (candidateIds.length === 0) {
    return { ok: true, state, value: { state, record: { ...record, phase: "reward", pendingDiscard: null } } };
  }
  if (!nonEmptyString(input.interactionId) || !nonEmptyString(input.createdAt)) {
    return failure("INVALID_STATE", "The Sheriff penalty needs a discard interaction ID and caller-supplied timestamp.");
  }
  const pendingDiscard: SavedDiscardOrder = {
    interactionId: input.interactionId,
    ownerPlayerId: sheriffId,
    reason: "effect_cleanup",
    allowedCardInstanceIds: [...candidateIds],
    requiredCount: candidateIds.length,
  };
  const nextRecord: SavedElimination = { ...record, phase: "sheriff_discard", pendingDiscard };
  const saved = saveElimination(state, frameId, nextRecord);
  if (!saved) return failure("FRAME_NOT_FOUND", "The Sheriff penalty continuation frame disappeared.");
  const opened = beginDiscardOrder(saved, {
    interactionId: input.interactionId,
    playerId: sheriffId,
    cardInstanceIds: candidateIds,
    requiredCount: candidateIds.length,
    reason: "effect_cleanup",
    context: { endgameStage: "sheriff_deputy_penalty", victimPlayerId: record.victimPlayerId },
    resumeFrameId: frameId,
    createdAt: input.createdAt,
  });
  if (!opened.ok) return failure("INVALID_DISCARD_ORDER", opened.error.message);
  return { ok: true, state, value: { state: opened.state, record: nextRecord } };
}

function drawOutlawReward(
  state: GameState,
  record: SavedElimination,
  random: RandomSource,
): EndgameResult<{ state: GameState; record: SavedElimination; paused: boolean }> {
  if (!record.rewardPlayerId || record.rewardCardsRemaining === 0) {
    return {
      ok: true,
      state,
      value: { state, record: { ...record, phase: "cleanup", rewardCardsRemaining: 0 }, paused: false },
    };
  }
  const recipient = uniqueSeat(state, record.rewardPlayerId);
  if (!recipient || recipient.public.eliminated) {
    return failure("INVALID_STATE", "The Outlaw reward recipient must remain alive until the reward resolves.");
  }

  let drawPile = [...state.zones.drawPileCardInstanceIds];
  let discardPile = [...state.zones.discardPileCardInstanceIds];
  const hand = [...recipient.private.handCardInstanceIds];
  let remaining = record.rewardCardsRemaining;
  while (remaining > 0) {
    if (drawPile.length === 0) {
      if (discardPile.length === 0) {
        const paused: GameState = {
          ...state,
          status: "paused",
          pauseReason: "RULE_RESOURCE_EXHAUSTED",
          zones: { ...state.zones, drawPileCardInstanceIds: drawPile, discardPileCardInstanceIds: discardPile },
          seats: state.seats.map((seat) => seat.public.playerId === record.rewardPlayerId
            ? { ...seat, private: { ...seat.private, handCardInstanceIds: hand } }
            : seat),
        };
        return {
          ok: true,
          state,
          value: {
            state: paused,
            record: { ...record, phase: "reward", rewardCardsRemaining: remaining },
            paused: true,
          },
        };
      }
      try {
        drawPile = shuffle(discardPile, random);
      } catch {
        return failure("INVALID_RANDOM", "Outlaw reward reshuffle requires a finite random source in [0, 1)." );
      }
      discardPile = [];
    }
    hand.push(drawPile.shift()!);
    remaining -= 1;
  }

  const nextState: GameState = {
    ...state,
    zones: { ...state.zones, drawPileCardInstanceIds: drawPile, discardPileCardInstanceIds: discardPile },
    seats: state.seats.map((seat) => seat.public.playerId === record.rewardPlayerId
      ? { ...seat, private: { ...seat.private, handCardInstanceIds: hand } }
      : seat),
  };
  return {
    ok: true,
    state,
    value: {
      state: nextState,
      record: { ...record, phase: "cleanup", rewardCardsRemaining: 0 },
      paused: false,
    },
  };
}

/** Applies saved owner-order choices and advances death cleanup, rewards, and the safe victory boundary. */
export function advanceElimination(
  state: GameState,
  input: AdvanceEliminationInput,
): EndgameResult<EliminationProgress> {
  if (state.status !== "playing") return failure("MATCH_NOT_PLAYING", "Elimination cleanup can only advance during a playing match.");
  const pendingDeath = state.resolution.pendingDeath;
  if (!pendingDeath || pendingDeath.consequenceStage !== "cleanup" || !pendingDeath.resumeFrameId) {
    return failure("INVALID_DEATH_STAGE", "T12 must mark the victim's elimination cleanup stage before it can advance.");
  }
  const frameId = pendingDeath.resumeFrameId;
  let record = getSavedElimination(state, frameId);
  if (!record || record.victimPlayerId !== pendingDeath.victimPlayerId) {
    return failure("INVALID_STATE", "The serialized elimination continuation is missing or malformed.");
  }
  let nextState = state;

  if (record.phase === "victim_discard" || record.phase === "sheriff_discard") {
    const order = record.pendingDiscard;
    if (!order) return failure("INVALID_STATE", "The saved discard-order interaction is missing.");
    const pending = state.resolution.pendingInteraction;
    if (pending) {
      if (pending.kind !== "DISCARDS_ORDER" || pending.interactionId !== order.interactionId ||
          pending.actorPlayerIds.length !== 1 || pending.actorPlayerIds[0] !== order.ownerPlayerId) {
        return failure("INVALID_STATE", "A different pending interaction blocks elimination cleanup.");
      }
      return {
        ok: true,
        state,
        value: { stage: "awaiting_discard", interactionId: order.interactionId, actorPlayerId: order.ownerPlayerId },
      };
    }
    const savedOrder = savedDiscardOrder(frameFor(state, frameId)!, record);
    if (!savedOrder) return failure("INVALID_DISCARD_ORDER", "The completed discard order is missing or does not match the saved candidates.");
    const moved = moveCardsToDiscard(state, order.ownerPlayerId, savedOrder);
    if (!moved) return failure("INVALID_DISCARD_ORDER", "The owner no longer holds the exact saved cleanup card set.");
    nextState = moved;
    record = order.reason === "elimination_cleanup"
      ? { ...record, phase: "after_victim_discard", pendingDiscard: null }
      : { ...record, phase: "reward", pendingDiscard: null };
  }

  if (record.phase === "after_victim_discard") {
    const opened = nextDiscardForSheriff(nextState, frameId, record, input);
    if (!opened.ok) return opened;
    nextState = opened.value.state;
    record = opened.value.record;
    if (record.phase === "sheriff_discard" && nextState.resolution.pendingInteraction) {
      const committed = saveElimination(nextState, frameId, record);
      if (!committed) return failure("FRAME_NOT_FOUND", "The Sheriff penalty continuation frame disappeared.");
      return commit(state, committed, {
        stage: "awaiting_discard",
        interactionId: record.pendingDiscard!.interactionId,
        actorPlayerId: record.pendingDiscard!.ownerPlayerId,
      });
    }
  }

  if (record.phase === "reward") {
    const reward = drawOutlawReward(nextState, record, input.random);
    if (!reward.ok) return reward;
    nextState = reward.value.state;
    record = reward.value.record;
    const saved = saveElimination(nextState, frameId, record);
    if (!saved) return failure("FRAME_NOT_FOUND", "The elimination reward continuation frame disappeared.");
    nextState = saved;
    if (reward.value.paused) {
      return commit(state, nextState, { stage: "resource_exhausted", rewardCardsRemaining: record.rewardCardsRemaining });
    }
  }

  if (record.phase !== "cleanup") {
    const saved = saveElimination(nextState, frameId, record);
    if (!saved) return failure("FRAME_NOT_FOUND", "The elimination continuation frame disappeared.");
    return commit(state, saved, { stage: "awaiting_resolution", rewardCardsRemaining: record.rewardCardsRemaining });
  }

  const cleanup = completeDeathCleanup(nextState, record.victimPlayerId);
  if (!cleanup.ok) return failure("INVALID_DEATH_STAGE", cleanup.error.message);
  nextState = cleanup.state;
  const saved = saveElimination(nextState, frameId, null);
  if (!saved) return failure("FRAME_NOT_FOUND", "The completed elimination continuation frame disappeared.");
  nextState = saved;

  if (cleanup.value.consequenceStage === "win_check") {
    const outcome = victoryOutcome(nextState);
    if (typeof outcome === "string") return failure("INVALID_STATE", outcome);
    const withOutcome = recordOutcome(nextState, outcome);
    const closed = completeDeathWinCheck(withOutcome, record.victimPlayerId);
    if (!closed.ok) return failure("INVALID_DEATH_STAGE", closed.error.message);
    return commit(state, closed.state, {
      stage: "cleanup_complete",
      winCheckRequired: true,
      victoryChecked: true,
      outcome,
    });
  }

  return commit(state, nextState, {
    stage: "cleanup_complete",
    winCheckRequired: false,
    victoryChecked: false,
    outcome: null,
  });
}

