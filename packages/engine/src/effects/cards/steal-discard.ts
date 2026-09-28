import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { calculateDistance } from "../../rules/distance.js";
import type { GameState, SeatState } from "../../state/types.js";
import type { CardEffectInput, CardEffectModule, CardEffectResult, EffectEventDraft } from "../api.js";

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function reject(code: NonNullable<Extract<CardEffectResult, { kind: "invalid_target" }>['code']>): CardEffectResult {
  return { kind: "invalid_target", code };
}

function uniqueSeat(state: GameState, playerId: string): SeatState | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function hasValidSource(input: CardEffectInput, expectedTypeId: "panic" | "cat_balou"): boolean {
  if (input.sourceCardInstanceId === null) return false;
  const instance = input.state.zones.cardsByInstanceId[input.sourceCardInstanceId];
  return instance?.cardInstanceId === input.sourceCardInstanceId &&
    TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId) === expectedTypeId;
}

function isPhysicalInstance(input: CardEffectInput, cardInstanceId: string): boolean {
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId &&
    TYPE_BY_DEFINITION_ID.has(instance.cardDefinitionId);
}

function targetDistanceIsAllowed(
  input: CardEffectInput,
  targetPlayerId: string,
  effectType: "panic" | "cat_balou",
): boolean {
  if (effectType === "cat_balou" || targetPlayerId === input.actorPlayerId) return true;
  const distance = calculateDistance(input.state as unknown as GameState, input.actorPlayerId, targetPlayerId);
  // T11 has already rejected invalid seat/equipment state before a card effect is
  // called. Treat an unresolvable distance as out of range here as a safe fallback.
  return distance?.distance === 1;
}

function movementEvent(
  input: CardEffectInput,
  targetPlayerId: string,
  cardInstanceId: string,
  fromZone: "hand" | "in_play",
  destination: "hand" | "discard",
): EffectEventDraft {
  return destination === "hand"
    ? {
        type: "CARD_TRANSFERRED",
        actorPlayerId: input.actorPlayerId,
        payload: {
          sourceCardInstanceId: input.sourceCardInstanceId,
          cardInstanceId,
          fromPlayerId: targetPlayerId,
          fromZone,
          toPlayerId: input.actorPlayerId,
          toZone: "hand",
        },
      }
    : {
        type: "CARD_DISCARDED",
        actorPlayerId: input.actorPlayerId,
        payload: {
          sourceCardInstanceId: input.sourceCardInstanceId,
          cardInstanceId,
          ownerPlayerId: targetPlayerId,
          fromZone,
          toZone: "discard",
        },
      };
}

function applyStealOrDiscard(
  input: CardEffectInput,
  effectType: "panic" | "cat_balou",
): CardEffectResult {
  if (!hasValidSource(input, effectType)) return reject("TARGET_NOT_ALLOWED");
  if (input.targets.length === 0) return { kind: "target_required" };
  if (input.targets.length !== 1) return reject("TARGET_NOT_ALLOWED");

  const target = input.targets[0]!;
  if (target.kind === "player") return reject("TARGET_ZONE_REQUIRED");

  const actor = uniqueSeat(input.state as unknown as GameState, input.actorPlayerId);
  if (!actor || actor.public.eliminated) return reject("TARGET_NOT_FOUND");

  const targetSeat = uniqueSeat(input.state as unknown as GameState, target.playerId);
  if (!targetSeat) return reject("TARGET_NOT_FOUND");
  if (targetSeat.public.eliminated) return reject("TARGET_NOT_ALIVE");

  if (!targetDistanceIsAllowed(input, target.playerId, effectType)) {
    return reject("TARGET_OUT_OF_RANGE");
  }

  if (target.kind === "hand") {
    if (target.playerId === input.actorPlayerId) return reject("TARGET_IS_SELF");
    const handCardInstanceIds = targetSeat.private.handCardInstanceIds;
    if (handCardInstanceIds.length === 0) return reject("TARGET_HAS_NO_CARDS");

    const sample = input.random.nextFloat();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
      throw new RangeError("RandomSource.nextFloat() must return a finite value in [0, 1).");
    }
    const cardInstanceId = handCardInstanceIds[Math.floor(sample * handCardInstanceIds.length)]!;
    if (!isPhysicalInstance(input, cardInstanceId)) return reject("TARGET_NOT_FOUND");

    return {
      kind: "applied",
      events: [movementEvent(
        input,
        target.playerId,
        cardInstanceId,
        "hand",
        effectType === "panic" ? "hand" : "discard",
      )],
      steps: [],
    };
  }

  if (!targetSeat.public.inPlayCardInstanceIds.includes(target.cardInstanceId) ||
      !isPhysicalInstance(input, target.cardInstanceId)) {
    return reject("TARGET_CARD_NOT_IN_PLAY");
  }

  return {
    kind: "applied",
    events: [movementEvent(
      input,
      target.playerId,
      target.cardInstanceId,
      "in_play",
      effectType === "panic" ? "hand" : "discard",
    )],
    steps: [],
  };
}

/** Panic! takes one random card from an adjacent opponent's hand or a chosen public card. */
export const panicEffect: CardEffectModule = (input) => applyStealOrDiscard(input, "panic");

/** Cat Balou discards one random hand card or a chosen public card at any distance. */
export const catBalouEffect: CardEffectModule = (input) => applyStealOrDiscard(input, "cat_balou");
