import type {
  MatchOutcomeView,
  MatchSnapshotView,
  CardFaceView,
  PendingRespondOption,
  PendingInteractionView,
} from "../../../contracts/src/protocol.js";
import { parsePendingInteractionView } from "../../../contracts/src/validation.js";
import type { PhysicalCard as CatalogPhysicalCard } from "../../../catalog/src/schema.js";
import { buildLegalActionCandidates } from "../actions/index.js";
import { earlyTablewideInteraction, projectTablewideAttack } from "../effects/runtime/index.js";
import type { GameState, JsonValue } from "./types.js";

const INTERACTION_CURSOR_KEY = "__resolutionCursor";

function interactionStep(pending: NonNullable<GameState["resolution"]["pendingInteraction"]>): {
  current: number;
  total: number;
} {
  const saved = pending.context[INTERACTION_CURSOR_KEY];
  if (typeof saved === "object" && saved !== null && !Array.isArray(saved)) {
    const cursor = saved.cursor;
    const responders = saved.responders;
    if (typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0 &&
        Array.isArray(responders) && responders.length > cursor) {
      return { current: cursor + 1, total: responders.length };
    }
  }
  // T07 states created by older snapshots have no serialized cursor. They
  // still have a single actionable responder, which is a one-step prompt.
  return { current: 1, total: 1 };
}

function projectPendingInteraction(
  pending: NonNullable<GameState["resolution"]["pendingInteraction"]> | null,
  viewerPlayerId: string,
  toCardFace: (cardInstanceId: string) => CardFaceView,
): PendingInteractionView | null {
  if (!pending) return null;
  if (pending.actorPlayerIds.length !== 1 || !pending.actorPlayerIds[0]) {
    throw new Error("A saved pending interaction must identify exactly one current responder.");
  }
  const currentResponderPlayerId = pending.actorPlayerIds[0];

  const base = {
    interactionId: pending.interactionId,
    kind: pending.kind,
    currentResponderPlayerId,
    step: interactionStep(pending),
  };
  let view: unknown;
  if (currentResponderPlayerId === viewerPlayerId) {
    const responseOptions: PendingRespondOption[] = pending.options.map((option) => {
      if ("interactionId" in option.payload || "choice" in option.payload) {
        throw new Error("A saved interaction option payload must not contain response envelope fields.");
      }
      return {
        ...option.payload,
        interactionId: pending.interactionId,
        choice: option.choice,
      } as PendingRespondOption;
    });
    let discardOrder: { requiredCount: number; allowedCards: readonly CardFaceView[] } | undefined;
    if (pending.kind === "DISCARDS_ORDER") {
      const rawDiscardOrder = pending.context.discardOrder;
      if (typeof rawDiscardOrder !== "object" || rawDiscardOrder === null || Array.isArray(rawDiscardOrder)) {
        throw new Error("A saved DISCARDS_ORDER interaction must include its candidate context.");
      }
      const spec = rawDiscardOrder as Record<string, JsonValue>;
      const allowedCardInstanceIds = spec.allowedCardInstanceIds;
      const requiredCount = spec.requiredCount;
      if (!Array.isArray(allowedCardInstanceIds) ||
          allowedCardInstanceIds.some((cardId) => typeof cardId !== "string" || cardId.length === 0) ||
          new Set(allowedCardInstanceIds).size !== allowedCardInstanceIds.length ||
          typeof requiredCount !== "number" || !Number.isSafeInteger(requiredCount) ||
          requiredCount <= 0 || requiredCount > allowedCardInstanceIds.length) {
        throw new Error("A saved DISCARDS_ORDER candidate context is malformed.");
      }
      discardOrder = {
        requiredCount,
        allowedCards: allowedCardInstanceIds.map((cardId) => toCardFace(cardId as string)),
      };
    }
    view = {
      ...base,
      allowedChoices: [...new Set(responseOptions.map((option) => option.choice))],
      responseOptions,
      ...(discardOrder ? { discardOrder } : {}),
      ...(pending.kind === "KIT_CARLSON_PICK" ? {
        choiceCards: [...new Set(pending.options.flatMap(option => {
          const ids = option.payload.selectedCardInstanceIds;
          return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
        }))].map(toCardFace),
      } : {}),
    };
  } else {
    view = {
      ...base,
      allowedChoices: [] as const,
    };
  }
  const parsed = parsePendingInteractionView(view, viewerPlayerId);
  if (!parsed.ok) {
    throw new Error(`Saved pending interaction cannot be projected as T68 DTO (${parsed.path}).`);
  }
  return parsed.value;
}

/**
 * Build the authenticated seat's allowlisted snapshot view.
 *
 * Runtime cardDefinitionId values refer to catalog physical-card definitionId
 * values. The physical catalog supplies the public card type name; rank and
 * suit come from the match instance.
 */
export function projectMatchSnapshot(
  state: GameState,
  viewerPlayerId: string,
  physicalCards: readonly CatalogPhysicalCard[],
): MatchSnapshotView {
  const viewerSeat = state.seats.find((seat) => seat.public.playerId === viewerPlayerId);
  if (!viewerSeat) {
    throw new RangeError(`Player '${viewerPlayerId}' does not have a seat in this match.`);
  }

  const typeIdByDefinitionId = new Map<string, string>();
  for (const physicalCard of physicalCards) {
    if (typeIdByDefinitionId.has(physicalCard.definitionId)) {
      throw new Error(`Duplicate physical card definition '${physicalCard.definitionId}'.`);
    }
    typeIdByDefinitionId.set(physicalCard.definitionId, physicalCard.typeId);
  }

  const toCardFace = (cardInstanceId: string): CardFaceView => {
    const card = state.zones.cardsByInstanceId[cardInstanceId];
    if (!card) {
      throw new Error(`Card instance '${cardInstanceId}' is missing from the match card map.`);
    }
    const typeId = typeIdByDefinitionId.get(card.cardDefinitionId);
    if (!typeId) {
      throw new Error(`Card definition '${card.cardDefinitionId}' is missing from the catalog.`);
    }
    return {
      cardInstanceId: card.cardInstanceId,
      typeId,
      rank: String(card.rank),
      suit: card.suit,
    };
  };

  const revealAllRoles = state.status === "completed";
  const publicPlayers: MatchSnapshotView["publicTable"]["players"] = state.seats.map((seat) => ({
    playerId: seat.public.playerId,
    displayName: seat.public.displayName,
    seatIndex: seat.public.seatIndex,
    characterId: seat.public.characterId,
    hp: seat.public.hp,
    maxHp: seat.public.maxHp,
    eliminated: seat.public.eliminated,
    handCount: seat.private.handCardInstanceIds.length,
    role: seat.public.roleRevealed || revealAllRoles ? seat.private.roleId : null,
    inPlay: seat.public.inPlayCardInstanceIds.map(toCardFace),
  }));

  const discardPile = state.zones.discardPileCardInstanceIds;
  const discardTopId = discardPile.at(-1);
  const pending = state.resolution.pendingInteraction;
  const tablewideAttack = projectTablewideAttack(state);
  const viewerPending = earlyTablewideInteraction(state, viewerPlayerId) ?? pending;
  const viewerEliminated = viewerSeat.public.eliminated;
  const outcome: MatchOutcomeView | undefined = state.status === "completed"
    ? state.outcome
      ? {
          winningFaction: state.outcome.winningFaction,
          winningPlayerIds: [...state.outcome.winningPlayerIds],
        }
      : undefined
    : undefined;

  if (state.status === "completed" && !outcome) {
    throw new Error("A completed match must include the authoritative engine outcome.");
  }

  return {
    status: state.status,
    viewer: {
      playerId: viewerSeat.public.playerId,
      seatIndex: viewerSeat.public.seatIndex,
      mode: viewerEliminated ? "eliminated_observer" : "active",
    },
    publicTable: {
      players: publicPlayers,
      turn: {
        currentPlayerId: state.turn.currentPlayerId,
        phase: state.turn.phase,
      },
      deckCount: state.zones.drawPileCardInstanceIds.length,
      ...(state.resolution.pendingInteraction?.kind === "LUCKY_DRAW" ? {
        luckyJudgment: {
          sourceKind: state.resolution.pendingInteraction.context.sourceKind as "jail" | "dynamite" | "barrel" | "jourdonnais_virtual_barrel",
          cards: state.zones.revealedPoolCardInstanceIds.map(toCardFace),
        },
      } : {}),
      publicDiscard: {
        topCard: discardTopId === undefined ? null : toCardFace(discardTopId),
        count: discardPile.length,
      },
      ...(pending?.kind === "GENERAL_STORE_PICK"
        ? { generalStoreCards: state.zones.revealedPoolCardInstanceIds.map(toCardFace) }
        : {}),
      ...(tablewideAttack ? { tablewideAttack } : {}),
    },
    selfPrivate: viewerEliminated
      ? null
      : {
          role: viewerSeat.private.roleId,
          hand: viewerSeat.private.handCardInstanceIds.map(toCardFace),
        },
    legalActions: buildLegalActionCandidates(state, viewerPlayerId, { compactAbilityCosts: true }),
    ...(outcome ? { outcome } : {}),
    pendingInteraction: projectPendingInteraction(viewerPending, viewerPlayerId, toCardFace),
  };
}
