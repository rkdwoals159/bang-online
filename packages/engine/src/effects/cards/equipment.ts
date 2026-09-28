import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { getEquippedCardTypeIds } from "../../rules/distance.js";
import type { GameState, JsonValue } from "../../state/types.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  EffectEventDraft,
  IllegalEffectTargetCode,
} from "../api.js";

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

const WEAPON_TYPES = new Set(["volcanic", "schofield", "remington", "carabine", "winchester"]);
const DISTANCE_EQUIPMENT_TYPES = new Set(["mustang", "scope"]);
const OTHER_EQUIPMENT_TYPES = new Set(["barrel"]);

function reject(code: IllegalEffectTargetCode): CardEffectResult {
  return { kind: "invalid_target", code };
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Readonly<Record<string, JsonValue>>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function cardType(input: CardEffectInput, cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId
    ? TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId)
    : undefined;
}

function transferToPlay(input: CardEffectInput, cardInstanceId: string): EffectEventDraft {
  return event("CARD_TRANSFERRED", input.actorPlayerId, {
    sourceCardInstanceId: cardInstanceId,
    cardInstanceId,
    fromPlayerId: input.actorPlayerId,
    fromZone: "hand",
    toPlayerId: input.actorPlayerId,
    toZone: "in_play",
  });
}

function discardEquippedWeapon(input: CardEffectInput, cardInstanceId: string): EffectEventDraft {
  return event("CARD_DISCARDED", input.actorPlayerId, {
    sourceCardInstanceId: input.sourceCardInstanceId,
    cardInstanceId,
    ownerPlayerId: input.actorPlayerId,
    fromZone: "in_play",
    toZone: "discard",
  });
}

/** Installs Barrel, Mustang/Scope, or a weapon; replacing a weapon discards it first. */
export const equipmentEffect: CardEffectModule = (input) => {
  if (input.targets.length > 0) return reject("TARGET_NOT_ALLOWED");
  const sourceCardInstanceId = input.sourceCardInstanceId;
  const sourceTypeId = cardType(input, sourceCardInstanceId);
  if (!sourceCardInstanceId || !sourceTypeId ||
      (!WEAPON_TYPES.has(sourceTypeId) && !DISTANCE_EQUIPMENT_TYPES.has(sourceTypeId) &&
        !OTHER_EQUIPMENT_TYPES.has(sourceTypeId))) {
    return reject("TARGET_NOT_ALLOWED");
  }

  const actorMatches = input.state.seats.filter((seat) => seat.public.playerId === input.actorPlayerId);
  if (actorMatches.length !== 1) return reject("TARGET_NOT_FOUND");
  const actor = actorMatches[0]!;
  if (actor.public.eliminated || actor.public.hp <= 0) return reject("TARGET_NOT_ALIVE");
  if (!actor.private.handCardInstanceIds.includes(sourceCardInstanceId)) return reject("TARGET_NOT_ALLOWED");

  const equippedTypes = getEquippedCardTypeIds(input.state as unknown as GameState, input.actorPlayerId);
  if (!equippedTypes) return reject("TARGET_NOT_FOUND");
  if (equippedTypes.includes(sourceTypeId)) return reject("TARGET_NOT_ALLOWED");

  const equippedWeapons = actor.public.inPlayCardInstanceIds.filter((cardInstanceId) =>
    WEAPON_TYPES.has(cardType(input, cardInstanceId) ?? ""),
  );
  if (equippedWeapons.length > 1) return reject("TARGET_NOT_ALLOWED");

  const events: EffectEventDraft[] = [];
  if (WEAPON_TYPES.has(sourceTypeId) && equippedWeapons.length === 1) {
    events.push(discardEquippedWeapon(input, equippedWeapons[0]!));
  }
  events.push(transferToPlay(input, sourceCardInstanceId));
  return { kind: "applied", events, steps: [] };
};
