import type { DeepReadonly } from "../api.js";
import type { GameState } from "../../state/types.js";
import type { RandomSource } from "../../random/shuffle.js";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import { planDrawPileSupply } from "../draw-pile.js";
import type { CharacterAbilityInput, CharacterAbilityModule, CharacterEffectResult } from "../character-api.js";

type SuzyInput = CharacterAbilityInput<"suzy_lafayette">;
type SuzySeat = SuzyInput["state"]["seats"][number];

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function uniqueSeat(input: SuzyInput, playerId: string): SuzySeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function locations(input: SuzyInput, cardInstanceId: string): Array<{ zone: string; playerId: string | null }> {
  const found: Array<{ zone: string; playerId: string | null }> = [];
  for (const seat of input.state.seats) {
    for (const id of seat.private.handCardInstanceIds) if (id === cardInstanceId) found.push({ zone: "hand", playerId: seat.public.playerId });
    for (const id of seat.public.inPlayCardInstanceIds) if (id === cardInstanceId) found.push({ zone: "in_play", playerId: seat.public.playerId });
  }
  for (const id of input.state.zones.drawPileCardInstanceIds) if (id === cardInstanceId) found.push({ zone: "draw_pile", playerId: null });
  for (const id of input.state.zones.discardPileCardInstanceIds) if (id === cardInstanceId) found.push({ zone: "discard", playerId: null });
  for (const id of input.state.zones.revealedPoolCardInstanceIds) if (id === cardInstanceId) found.push({ zone: "revealed_pool", playerId: null });
  return found;
}

function validCardReference(
  input: SuzyInput,
  card: { readonly cardInstanceId: string | null; readonly physicalCardTypeId: string | null },
  allowInPlayForActor: boolean,
): string | undefined {
  const cardInstanceId = card.cardInstanceId;
  if (!cardInstanceId || cardInstanceId.trim().length === 0) return undefined;
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  if (!instance || instance.cardInstanceId !== cardInstanceId ||
      TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId) !== card.physicalCardTypeId) return undefined;
  const current = locations(input, cardInstanceId);
  if (current.length !== 1) return undefined;
  const location = current[0]!;
  if (location.zone === "discard") return cardInstanceId;
  if (allowInPlayForActor && location.zone === "in_play" && location.playerId === input.playerId) return cardInstanceId;
  return undefined;
}

function drawOne(input: SuzyInput, sourceCardInstanceId: string | null): CharacterEffectResult {
  const supply = planDrawPileSupply({
    drawPileCardInstanceIds: input.state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds: input.state.zones.discardPileCardInstanceIds,
    requestedCount: 1,
    actorPlayerId: input.playerId,
    sourceCardInstanceId,
    destination: "hand",
    random: input.random,
  });
  return { kind: "applied", events: supply.events, steps: [] };
}

function afterResponse(input: SuzyInput): CharacterEffectResult {
  const hook = input.hook;
  if (hook.kind !== "after_response" || hook.responderPlayerId !== input.playerId ||
      !Number.isSafeInteger(hook.handCardCountAfterResponse) || hook.handCardCountAfterResponse !== 0) return noEffect();
  const actor = uniqueSeat(input, input.playerId);
  if (!actor || actor.public.characterId !== "suzy_lafayette" || actor.public.eliminated || actor.public.hp <= 0 ||
      actor.private.handCardInstanceIds.length !== 0) return noEffect();

  const sourceCardInstanceId = validCardReference(input, hook.response.card, false);
  if (!sourceCardInstanceId || hook.interactionId.trim().length === 0) return noEffect();
  return drawOne(input, sourceCardInstanceId);
}

function afterCardEffect(input: SuzyInput): CharacterEffectResult {
  const hook = input.hook;
  if (hook.kind !== "after_card_effect" || hook.pendingInteractionKind !== null ||
      !Number.isSafeInteger(hook.handCardCountAfterEffect) || hook.handCardCountAfterEffect !== 0) return noEffect();
  const actor = uniqueSeat(input, input.playerId);
  if (!actor || actor.public.characterId !== "suzy_lafayette" || actor.public.eliminated || actor.public.hp <= 0 ||
      actor.private.handCardInstanceIds.length !== 0) return noEffect();

  if (hook.boundary === "before_el_gringo_reward") {
    const victim = uniqueSeat(input, hook.trigger.victimPlayerId);
    if (!victim || victim.public.characterId !== "el_gringo" || victim.public.eliminated || victim.public.hp <= 0) return noEffect();
    const sourceCardInstanceId = validCardReference(input, hook.card, false);
    return sourceCardInstanceId ? drawOne(input, sourceCardInstanceId) : noEffect();
  }

  if (hook.boundary !== "resolution_complete") return noEffect();
  const sourceCardInstanceId = validCardReference(input, hook.card, true);
  if (!sourceCardInstanceId) return noEffect();
  return drawOne(input, sourceCardInstanceId);
}

/** C14 draws once when a supported response or a complete card effect leaves Suzy's hand empty. */
export const suzyLafayetteAbility: CharacterAbilityModule<"suzy_lafayette"> = (input) => {
  if (input.characterId !== "suzy_lafayette" || input.state.status !== "playing") return noEffect();
  if (input.hook.kind === "after_response") return afterResponse(input);
  if (input.hook.kind === "after_card_effect") return afterCardEffect(input);
  return noEffect();
};

/** Automatic C14 check at a completed effect/draw boundary, never during a Duel. */
export function emptySuzyDrawEvents(state: DeepReadonly<GameState>, random: RandomSource, sourceCardInstanceId: string | null) {
  const suzy = state.seats.find((seat) => seat.public.characterId === "suzy_lafayette" &&
    !seat.public.eliminated && seat.public.hp > 0 && seat.private.handCardInstanceIds.length === 0);
  if (state.status !== "playing" || !suzy) return [];
  return planDrawPileSupply({ drawPileCardInstanceIds: state.zones.drawPileCardInstanceIds,
    discardPileCardInstanceIds: state.zones.discardPileCardInstanceIds, requestedCount: 1,
    actorPlayerId: suzy.public.playerId, sourceCardInstanceId, destination: "hand", random }).events;
}
