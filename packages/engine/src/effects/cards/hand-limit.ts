import type { JsonValue } from "../../state/types.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  IllegalEffectTargetCode,
} from "../api.js";

const DISCARD_INTERACTION = "DISCARDS_ORDER";
const TURN_HAND_LIMIT_REASON = "turn_hand_limit";

type EffectSeat = CardEffectInput["state"]["seats"][number];

interface SavedDiscardOrder {
  readonly reason: string;
  readonly allowedCardInstanceIds: readonly string[];
  readonly requiredCount: number;
}

function reject(code: IllegalEffectTargetCode): CardEffectResult {
  return { kind: "invalid_target", code };
}

function uniqueSeat(input: CardEffectInput, playerId: string): EffectSeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function jsonRecord(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) return undefined;
  return [...value] as string[];
}

function savedDiscardOrder(interaction: CompletedEffectInteraction): SavedDiscardOrder | undefined {
  const saved = jsonRecord(interaction.context.discardOrder);
  const reason = saved?.reason;
  const allowedCardInstanceIds = stringArray(saved?.allowedCardInstanceIds);
  const requiredCount = saved?.requiredCount;
  if (typeof reason !== "string" || !allowedCardInstanceIds ||
      typeof requiredCount !== "number" || !Number.isInteger(requiredCount)) return undefined;
  return { reason, allowedCardInstanceIds, requiredCount };
}

function completedTurnDiscard(input: CardEffectInput): CompletedEffectInteraction | undefined {
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const completed = input.completedInteractions[index]!;
    if (completed.kind === DISCARD_INTERACTION &&
        completed.context.continuationFrameId === input.continuationFrameId &&
        completed.context.actorPlayerId === input.actorPlayerId &&
        completed.context.reason === TURN_HAND_LIMIT_REASON) {
      return completed;
    }
  }
  return undefined;
}

function requiredDiscardCount(handSize: number, currentHp: number): number {
  return Math.max(0, handSize - currentHp);
}

function orderRequest(input: CardEffectInput, actor: EffectSeat, requiredCount: number): CardEffectResult {
  return {
    kind: "choice_required",
    request: {
      kind: DISCARD_INTERACTION,
      responders: [{
        playerId: actor.public.playerId,
        options: [{ choice: "ORDER_CARDS", payload: {} }],
      }],
      context: {
        continuationFrameId: input.continuationFrameId,
        actorPlayerId: actor.public.playerId,
        reason: TURN_HAND_LIMIT_REASON,
        turnNumber: input.state.turn.turnNumber,
        currentHp: actor.public.hp,
        requiredCount,
      },
      resumeFrameId: input.continuationFrameId,
    },
    events: [],
    steps: [],
  };
}

function discardEvent(actorPlayerId: string, cardInstanceId: string): EffectEventDraft {
  return {
    type: "CARD_DISCARDED",
    actorPlayerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      ownerPlayerId: actorPlayerId,
      fromZone: "hand",
      toZone: "discard",
    },
  };
}

function resolveCompletedOrder(
  input: CardEffectInput,
  actor: EffectSeat,
  requiredCount: number,
  completed: CompletedEffectInteraction,
): CardEffectResult {
  const saved = savedDiscardOrder(completed);
  const response = completed.responses.length === 1 ? completed.responses[0] : undefined;
  const orderedCardInstanceIds = stringArray(response?.payload.orderedCardInstanceIds);
  const handCardInstanceIds = actor.private.handCardInstanceIds;

  if (!saved || saved.reason !== TURN_HAND_LIMIT_REASON || saved.requiredCount !== requiredCount ||
      completed.context.turnNumber !== input.state.turn.turnNumber ||
      completed.context.currentHp !== actor.public.hp ||
      completed.context.requiredCount !== requiredCount ||
      new Set(saved.allowedCardInstanceIds).size !== saved.allowedCardInstanceIds.length ||
      saved.allowedCardInstanceIds.length !== handCardInstanceIds.length ||
      handCardInstanceIds.some((cardInstanceId) => !saved.allowedCardInstanceIds.includes(cardInstanceId)) ||
      !response || response.playerId !== actor.public.playerId || response.choice !== "ORDER_CARDS" ||
      Object.keys(response.payload).length !== 1 || !orderedCardInstanceIds ||
      orderedCardInstanceIds.length !== requiredCount ||
      new Set(orderedCardInstanceIds).size !== requiredCount ||
      orderedCardInstanceIds.some((cardInstanceId) =>
        !saved.allowedCardInstanceIds.includes(cardInstanceId) || !handCardInstanceIds.includes(cardInstanceId),
      )) {
    return reject("TARGET_NOT_ALLOWED");
  }

  return {
    kind: "applied",
    events: orderedCardInstanceIds.map((cardInstanceId) => discardEvent(actor.public.playerId, cardInstanceId)),
    steps: [],
  };
}

/** Builds/replays the active player's end-of-turn hand-limit discard order. */
export const turnHandLimitEffect: CardEffectModule = (input) => {
  if (input.sourceCardInstanceId !== null || input.targets.length > 0) return reject("TARGET_NOT_ALLOWED");
  if (input.state.status !== "playing" || input.state.turn.phase !== "discard" ||
      input.state.turn.currentPlayerId !== input.actorPlayerId ||
      input.state.resolution.pendingDeath !== null ||
      input.state.resolution.pendingInteraction !== null) return reject("TARGET_NOT_ALLOWED");

  const actor = uniqueSeat(input, input.actorPlayerId);
  if (!actor) return reject("TARGET_NOT_FOUND");
  if (actor.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const requiredCount = requiredDiscardCount(actor.private.handCardInstanceIds.length, actor.public.hp);
  const completed = completedTurnDiscard(input);
  if (completed) {
    if (requiredCount === 0) return reject("TARGET_NOT_ALLOWED");
    return resolveCompletedOrder(input, actor, requiredCount, completed);
  }
  if (requiredCount === 0) return { kind: "applied", events: [], steps: [] };
  return orderRequest(input, actor, requiredCount);
};
