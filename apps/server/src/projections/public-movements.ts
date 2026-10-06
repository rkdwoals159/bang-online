import { BASE_PHYSICAL_CARDS } from "../../../../packages/catalog/src/cards/index.js";
import type { PublicMatchEvent } from "../../../../packages/contracts/src/protocol.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";
import type { MatchEventRecord } from "../storage/repository.js";

/** Describe observable movements without revealing a received private card. */
export function projectPublicMovement(event: MatchEventRecord, state: GameState): PublicMatchEvent | undefined {
  if (!["CARD_TRANSFERRED", "CARD_DISCARDED", "CARD_DRAWN"].includes(event.type) ||
      typeof event.payload !== "object" || !event.payload || Array.isArray(event.payload)) return;
  const p = event.payload;
  const knownPlayer = (id: unknown): id is string => typeof id === "string" && state.seats.some(seat => seat.public.playerId === id);
  const faceType = (id: unknown) => {
    const card = typeof id === "string" ? state.zones.cardsByInstanceId[id] : undefined;
    return card && BASE_PHYSICAL_CARDS.find(face => face.definitionId === card.cardDefinitionId)?.typeId;
  };
  const cardType = faceType(p.cardInstanceId), sourceType = faceType(p.sourceCardInstanceId);
  const actorPlayerId = knownPlayer(event.actorPlayerId) ? event.actorPlayerId : undefined;
  const toPlayerId = knownPlayer(p.toPlayerId) ? p.toPlayerId : knownPlayer(p.playerId) ? p.playerId : undefined;
  const owner = knownPlayer(p.ownerPlayerId) ? p.ownerPlayerId : knownPlayer(p.fromPlayerId) ? p.fromPlayerId : undefined;
  const emit = (type: string, payload: Record<string, unknown>) => ({ eventSeq: event.eventSeq,
    occurredAt: event.createdAt.toISOString(), type, payload });
  if (event.type === "CARD_DISCARDED" && p.toZone === "discard") {
    if (p.cardInstanceId === p.sourceCardInstanceId) {
      if (actorPlayerId && sourceType && ["stagecoach", "wells_fargo", "general_store"].includes(sourceType)) {
        return emit("CARD_USED", { actorPlayerId, cardType: sourceType });
      }
      return; // Attacks, healing and defenses already have semantic result events.
    }
    if (owner && (p.fromZone === "hand" || p.fromZone === "in_play")) return emit("PUBLIC_CARD_DISCARDED", {
      ...(actorPlayerId ? { actorPlayerId } : {}), targetPlayerId: owner, fromZone: p.fromZone,
      ...(cardType ? { cardType } : {}),
    });
    if (p.fromZone === "revealed_pool" && sourceType === "general_store") return emit("STORE_CARD_DISCARDED", {
      ...(actorPlayerId ? { actorPlayerId } : {}), ...(cardType ? { cardType } : {}),
    });
    return;
  }
  if (event.type === "CARD_TRANSFERRED" && p.toZone === "in_play" && toPlayerId && actorPlayerId && cardType) {
    if (p.fromZone === "in_play") return; // DYNAMITE_PASSED describes passing separately.
    return emit("CARD_EQUIPPED", { actorPlayerId, targetPlayerId: toPlayerId, cardType });
  }
  if (p.toZone !== "hand" || !toPlayerId) return;
  if (p.cardInstanceId === p.sourceCardInstanceId && p.fromZone === "hand") return;
  if (p.fromZone === "hand" && owner && owner !== toPlayerId) return emit("PUBLIC_CARD_TAKEN", {
    actorPlayerId: toPlayerId, targetPlayerId: owner, targetZone: "hand",
  });
  if (p.fromZone === "in_play" && owner && owner !== toPlayerId) return emit("PUBLIC_CARD_TAKEN", {
    actorPlayerId: toPlayerId, targetPlayerId: owner, targetZone: "in_play", ...(cardType ? { cardType } : {}),
  });
  if (p.fromZone === "revealed_pool" && sourceType === "general_store") return emit("STORE_CARD_PICKED", {
    actorPlayerId: toPlayerId, ...(cardType ? { cardType } : {}),
  });
  // Draw counts are public; chosen faces, deck order and received hand cards stay private.
  if (p.fromZone === "draw_pile" || p.fromZone === "revealed_pool") return emit("CARD_RECEIVED", { actorPlayerId: toPlayerId, count: 1 });
  if (p.fromZone === "discard") return emit("DISCARD_CARD_TAKEN", { actorPlayerId: toPlayerId, ...(cardType ? { cardType } : {}) });
  return;
}
