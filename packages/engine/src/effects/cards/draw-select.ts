import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type { GameState, JsonValue, SeatState } from "../../state/types.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  EffectInteractionRequest,
  IllegalEffectTargetCode,
} from "../api.js";
import { planDrawPileSupply, type DrawPileDestination, type DrawPileSupplyPlan } from "../draw-pile.js";

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);
const GENERAL_STORE_INTERACTION = "GENERAL_STORE_PICK";
const GENERAL_STORE_CHOICE = "CHOOSE_CARD";

type DrawCardType = "stagecoach" | "wells_fargo" | "general_store";

function reject(code: IllegalEffectTargetCode): CardEffectResult {
  return { kind: "invalid_target", code };
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function validSourceCard(input: CardEffectInput, expectedTypeId: DrawCardType): boolean {
  if (input.sourceCardInstanceId === null) return false;
  const instance = input.state.zones.cardsByInstanceId[input.sourceCardInstanceId];
  return instance?.cardInstanceId === input.sourceCardInstanceId &&
    TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId) === expectedTypeId;
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Readonly<Record<string, JsonValue>>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

/**
 * Plans the post-cost piles. Runtime commits a played source card before these
 * drafts, so include it in the virtual discard pile when it is still in hand.
 */
function prepareDraw(
  input: CardEffectInput,
  cardTypeId: DrawCardType,
  count: number,
  destination: DrawPileDestination,
): DrawPileSupplyPlan {
  const discardPileCardInstanceIds = [...input.state.zones.discardPileCardInstanceIds];
  const sourceCardInstanceId = input.sourceCardInstanceId;
  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (sourceCardInstanceId && actor?.private.handCardInstanceIds.includes(sourceCardInstanceId) &&
      !discardPileCardInstanceIds.includes(sourceCardInstanceId)) {
    discardPileCardInstanceIds.push(sourceCardInstanceId);
  }

  return planDrawPileSupply({
    drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds,
    requestedCount: count,
    actorPlayerId: input.actorPlayerId,
    sourceCardInstanceId,
    destination,
    random: input.random,
    cardTypeId,
  });
}

function drawCardEffect(input: CardEffectInput, cardTypeId: "stagecoach" | "wells_fargo"): CardEffectResult {
  if (!validSourceCard(input, cardTypeId)) return reject("TARGET_NOT_ALLOWED");
  if (input.targets.length > 0) return reject("TARGET_NOT_ALLOWED");
  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const count = cardTypeId === "stagecoach" ? 2 : 3;
  const prepared = prepareDraw(input, cardTypeId, count, "hand");
  return { kind: "applied", events: prepared.events, steps: [] };
}

function sourceForContextMatches(
  input: CardEffectInput,
  context: Readonly<Record<string, JsonValue>>,
): boolean {
  return context.actorPlayerId === input.actorPlayerId &&
    context.sourceCardInstanceId === input.sourceCardInstanceId;
}

function latestGeneralStorePick(input: CardEffectInput): CompletedEffectInteraction | undefined {
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const completed = input.completedInteractions[index]!;
    if (completed.kind === GENERAL_STORE_INTERACTION) return completed;
  }
  return undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return [...value] as string[];
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function uniqueAliveSeatsFromActor(state: GameState, actorPlayerId: string): SeatState[] | undefined {
  const orderedSeats = [...state.seats].sort((left, right) => left.public.seatIndex - right.public.seatIndex);
  if (new Set(orderedSeats.map((seat) => seat.public.playerId)).size !== orderedSeats.length ||
      new Set(orderedSeats.map((seat) => seat.public.seatIndex)).size !== orderedSeats.length) {
    return undefined;
  }
  const living = orderedSeats.filter((seat) => !seat.public.eliminated);
  const actorIndex = living.findIndex((seat) => seat.public.playerId === actorPlayerId);
  if (actorIndex < 0) return undefined;
  return [...living.slice(actorIndex), ...living.slice(0, actorIndex)];
}

function pickRequest(
  input: CardEffectInput,
  respondingPlayerId: string,
  remainingPlayerIds: readonly string[],
  remainingCardInstanceIds: readonly string[],
): EffectInteractionRequest {
  return {
    kind: GENERAL_STORE_INTERACTION,
    responders: [{
      playerId: respondingPlayerId,
      options: remainingCardInstanceIds.map((cardInstanceId) => ({
        choice: GENERAL_STORE_CHOICE,
        payload: { selectedCardInstanceId: cardInstanceId },
      })),
    }],
    context: {
      actorPlayerId: input.actorPlayerId,
      sourceCardInstanceId: input.sourceCardInstanceId,
      respondingPlayerId,
      remainingPlayerIds: [...remainingPlayerIds],
      remainingCardInstanceIds: [...remainingCardInstanceIds],
    },
    resumeFrameId: input.continuationFrameId,
  };
}

function transferFromStore(input: CardEffectInput, playerId: string, cardInstanceId: string): EffectEventDraft {
  return event("CARD_TRANSFERRED", input.actorPlayerId, {
    sourceCardInstanceId: input.sourceCardInstanceId,
    cardInstanceId,
    fromZone: "revealed_pool",
    toPlayerId: playerId,
    toZone: "hand",
  });
}

function discardStoreCard(input: CardEffectInput, cardInstanceId: string): EffectEventDraft {
  return event("CARD_DISCARDED", input.actorPlayerId, {
    sourceCardInstanceId: input.sourceCardInstanceId,
    cardInstanceId,
    fromZone: "revealed_pool",
    toZone: "discard",
  });
}

function beginGeneralStore(input: CardEffectInput, livingSeats: readonly SeatState[]): CardEffectResult {
  const prepared = prepareDraw(input, "general_store", livingSeats.length, "revealed_pool");
  if (prepared.exhausted) {
    return { kind: "applied", events: prepared.events, steps: [] };
  }

  const [current, ...remaining] = livingSeats;
  if (!current || prepared.cardInstanceIds.length !== livingSeats.length) {
    return reject("TARGET_NOT_FOUND");
  }
  return {
    kind: "response_required",
    request: pickRequest(
      input,
      current.public.playerId,
      remaining.map((seat) => seat.public.playerId),
      prepared.cardInstanceIds,
    ),
    events: prepared.events,
    steps: [],
  };
}

function continueGeneralStore(input: CardEffectInput, completed: CompletedEffectInteraction): CardEffectResult {
  if (!sourceForContextMatches(input, completed.context)) return reject("TARGET_NOT_ALLOWED");

  const respondingPlayerId = stringValue(completed.context.respondingPlayerId);
  const remainingPlayerIds = stringArray(completed.context.remainingPlayerIds);
  const remainingCardInstanceIds = stringArray(completed.context.remainingCardInstanceIds);
  if (!respondingPlayerId || !remainingPlayerIds || !remainingCardInstanceIds ||
      completed.responses.length !== 1) {
    return reject("TARGET_NOT_ALLOWED");
  }

  const response = completed.responses[0]!;
  const selectedCardInstanceId = stringValue(response.payload.selectedCardInstanceId);
  if (response.playerId !== respondingPlayerId || response.choice !== GENERAL_STORE_CHOICE ||
      !selectedCardInstanceId || !remainingCardInstanceIds.includes(selectedCardInstanceId)) {
    return reject("TARGET_NOT_ALLOWED");
  }
  if (!input.state.zones.revealedPoolCardInstanceIds.includes(selectedCardInstanceId)) {
    return reject("TARGET_NOT_ALLOWED");
  }
  const currentSeat = uniqueSeat(input.state as unknown as GameState, respondingPlayerId);
  if (!currentSeat) return reject("TARGET_NOT_FOUND");
  if (currentSeat.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const currentPool = input.state.zones.revealedPoolCardInstanceIds;
  if (new Set(currentPool).size !== currentPool.length ||
      currentPool.length !== remainingCardInstanceIds.length ||
      remainingCardInstanceIds.some((cardInstanceId) => !currentPool.includes(cardInstanceId))) {
    return reject("TARGET_NOT_ALLOWED");
  }

  const events = [transferFromStore(input, respondingPlayerId, selectedCardInstanceId)];
  const nextPlayerId = remainingPlayerIds[0];
  const nextPlayerIds = remainingPlayerIds.slice(1);
  const nextCardInstanceIds = remainingCardInstanceIds.filter((id) => id !== selectedCardInstanceId);
  if (nextPlayerId !== undefined) {
    if (nextCardInstanceIds.length === 0) return reject("TARGET_NOT_ALLOWED");
    return {
      kind: "response_required",
      request: pickRequest(input, nextPlayerId, nextPlayerIds, nextCardInstanceIds),
      events,
      steps: [],
    };
  }

  for (const cardInstanceId of nextCardInstanceIds) events.push(discardStoreCard(input, cardInstanceId));
  return { kind: "applied", events, steps: [] };
}

function resolveGeneralStore(input: CardEffectInput): CardEffectResult {
  if (!validSourceCard(input, "general_store")) return reject("TARGET_NOT_ALLOWED");
  if (input.targets.length > 0) return reject("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const completed = latestGeneralStorePick(input);
  if (completed) return continueGeneralStore(input, completed);

  if (input.state.zones.revealedPoolCardInstanceIds.length > 0) return reject("TARGET_NOT_ALLOWED");

  const livingSeats = uniqueAliveSeatsFromActor(input.state as unknown as GameState, input.actorPlayerId);
  if (!livingSeats) return reject("TARGET_NOT_FOUND");
  return beginGeneralStore(input, livingSeats);
}

export const stagecoachEffect: CardEffectModule = (input) => drawCardEffect(input, "stagecoach");
export const wellsFargoEffect: CardEffectModule = (input) => drawCardEffect(input, "wells_fargo");
export const generalStoreEffect: CardEffectModule = (input) => resolveGeneralStore(input);
