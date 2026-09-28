import type { EffectEventDraft } from "./api.js";
import { shuffle, type RandomSource } from "../random/shuffle.js";
import type { JsonValue } from "../state/types.js";

export type DrawPileDestination = "hand" | "revealed_pool" | "peek";

export interface DrawPileSupplyInput {
  /** Piles at the draw point, after any earlier event drafts have been applied. */
  readonly drawPileCardInstanceIds: readonly string[];
  readonly discardPileCardInstanceIds: readonly string[];
  readonly requestedCount: number;
  readonly actorPlayerId: string;
  /** Event attribution only; callers supply the correct post-prior-event piles separately. */
  readonly sourceCardInstanceId: string | null;
  readonly destination: DrawPileDestination;
  readonly random: RandomSource;
  /** Optional legacy effect context carried by T19's exhaustion event. */
  readonly cardTypeId?: string;
}

export interface DrawPileSupplyPlan {
  /** Peek candidates are returned only to the caller and have no movement event. */
  readonly cardInstanceIds: readonly string[];
  readonly events: readonly EffectEventDraft[];
  readonly fulfilledCount: number;
  readonly exhausted: boolean;
}

function event(
  type: string,
  actorPlayerId: string,
  payload: Readonly<Record<string, JsonValue>>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

/**
 * Plans a deterministic R08 draw without changing either pile. A source card
 * already placed in the discard pile by the caller is eligible for reshuffle.
 */
export function planDrawPileSupply(input: DrawPileSupplyInput): DrawPileSupplyPlan {
  if (!Number.isSafeInteger(input.requestedCount) || input.requestedCount < 0) {
    throw new RangeError("requestedCount must be a non-negative safe integer.");
  }

  const drawPile = [...input.drawPileCardInstanceIds];
  let discardPile = [...input.discardPileCardInstanceIds];
  const cardInstanceIds: string[] = [];
  const events: EffectEventDraft[] = [];

  for (let index = 0; index < input.requestedCount; index += 1) {
    if (drawPile.length === 0 && discardPile.length > 0) {
      const shuffled = shuffle(discardPile, input.random);
      events.push(event("DRAW_PILE_RESHUFFLED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        cardInstanceIds: shuffled,
      }));
      drawPile.push(...shuffled);
      discardPile = [];
    }

    const cardInstanceId = drawPile.shift();
    if (cardInstanceId === undefined) {
      events.push(event("RULE_RESOURCE_EXHAUSTED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        ...(input.cardTypeId === undefined ? {} : { cardTypeId: input.cardTypeId }),
        requestedCount: input.requestedCount,
        fulfilledCount: cardInstanceIds.length,
        status: "paused",
        pauseReason: "RULE_RESOURCE_EXHAUSTED",
      }));
      return {
        cardInstanceIds,
        events,
        fulfilledCount: cardInstanceIds.length,
        exhausted: true,
      };
    }

    cardInstanceIds.push(cardInstanceId);
    if (input.destination === "hand") {
      events.push(event("CARD_DRAWN", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        cardInstanceId,
        playerId: input.actorPlayerId,
        fromZone: "draw_pile",
        toZone: "hand",
      }));
    } else if (input.destination === "revealed_pool") {
      events.push(event("GENERAL_STORE_CARD_REVEALED", input.actorPlayerId, {
        sourceCardInstanceId: input.sourceCardInstanceId,
        cardInstanceId,
        fromZone: "draw_pile",
        toZone: "revealed_pool",
      }));
    }
  }

  return {
    cardInstanceIds,
    events,
    fulfilledCount: cardInstanceIds.length,
    exhausted: false,
  };
}
