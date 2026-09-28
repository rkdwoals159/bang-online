import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  PedroFirstTurnDrawSlotHookInput,
} from "../character-api.js";

const SOURCE_INTERACTION = "PEDRO_DISCARD_TOP";
const SELECT_SOURCE = "SELECT_SOURCE";
const DISCARD_TOP = "DISCARD_TOP";
const DRAW_PILE_TOP = "DRAW_PILE_TOP";

const BASE_CARD_DEFINITION_IDS = new Set(BASE_PHYSICAL_CARDS.map(({ definitionId }) => definitionId));

type PedroInput = CharacterAbilityInput<"pedro_ramirez">;
type PedroState = PedroInput["state"];
type PedroSeat = PedroState["seats"][number];

interface DiscardTopSource {
  readonly cardInstanceId: string;
}

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function uniqueSeat(state: PedroState, playerId: string): PedroSeat | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function cardZoneOccurrences(state: PedroState, cardInstanceId: string): number {
  let count = 0;
  for (const seat of state.seats) {
    count += seat.private.handCardInstanceIds.filter((id) => id === cardInstanceId).length;
    count += seat.public.inPlayCardInstanceIds.filter((id) => id === cardInstanceId).length;
  }
  count += state.zones.drawPileCardInstanceIds.filter((id) => id === cardInstanceId).length;
  count += state.zones.discardPileCardInstanceIds.filter((id) => id === cardInstanceId).length;
  count += state.zones.revealedPoolCardInstanceIds.filter((id) => id === cardInstanceId).length;
  return count;
}

function currentDiscardTop(input: PedroInput): DiscardTopSource | undefined {
  const offered = input.hook.sourceOptions.discardTop;
  if (!offered || offered.kind !== "discard_top" || offered.visibility !== "public") return undefined;

  const currentTop = input.state.zones.discardPileCardInstanceIds.at(-1);
  if (!currentTop || currentTop !== offered.cardInstanceId) return undefined;

  const card = input.state.zones.cardsByInstanceId[currentTop];
  if (!card || card.cardInstanceId !== currentTop || !BASE_CARD_DEFINITION_IDS.has(card.cardDefinitionId) ||
      cardZoneOccurrences(input.state, currentTop) !== 1) return undefined;

  return { cardInstanceId: currentTop };
}

function latestSourceChoice(input: PedroInput) {
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (interaction.kind === SOURCE_INTERACTION &&
        interaction.context.continuationFrameId === input.continuationFrameId &&
        interaction.context.actorPlayerId === input.playerId) {
      return interaction;
    }
  }
  return undefined;
}

function exactPayloadKeys(payload: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function transferDiscardTop(input: PedroInput, cardInstanceId: string): EffectEventDraft {
  return {
    type: "CARD_TRANSFERRED",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      fromZone: "discard",
      toPlayerId: input.playerId,
      toZone: "hand",
    },
  };
}

function finishSelectedSource(input: PedroInput, currentTop: DiscardTopSource | undefined): CharacterEffectResult {
  const completed = latestSourceChoice(input);
  if (!completed || completed.responses.length !== 1) return noEffect();

  const response = completed.responses[0]!;
  if (response.playerId !== input.playerId || response.choice !== SELECT_SOURCE ||
      !exactPayloadKeys(response.payload, ["source"])) return noEffect();

  const selectedSource = response.payload.source;
  if (selectedSource === DRAW_PILE_TOP) {
    // The draw orchestrator remains responsible for the normal R08 draw path.
    return noEffect();
  }

  if (selectedSource !== DISCARD_TOP || !currentTop ||
      completed.context.discardTopCardInstanceId !== currentTop.cardInstanceId) return noEffect();

  return { kind: "applied", events: [transferDiscardTop(input, currentTop.cardInstanceId)], steps: [] };
}

function requestSourceChoice(input: PedroInput, currentTop: DiscardTopSource): CharacterEffectResult {
  return {
    kind: "choice_required",
    request: {
      kind: SOURCE_INTERACTION,
      responders: [{
        playerId: input.playerId,
        options: [
          { choice: SELECT_SOURCE, payload: { source: DISCARD_TOP } },
          { choice: SELECT_SOURCE, payload: { source: DRAW_PILE_TOP } },
        ],
      }],
      context: {
        continuationFrameId: input.continuationFrameId,
        actorPlayerId: input.playerId,
        discardTopCardInstanceId: currentTop.cardInstanceId,
      },
      resumeFrameId: input.continuationFrameId,
    },
    events: [],
    steps: [],
  };
}

function isFirstOrdinaryDraw(input: PedroInput): boolean {
  const hook: PedroFirstTurnDrawSlotHookInput = input.hook;
  return hook.kind === "draw_slot" &&
    hook.timing === "before" &&
    hook.distribution.kind === "normal_turn" &&
    hook.distribution.position === "first" &&
    hook.sourceOptions.drawPile.kind === "draw_pile" &&
    hook.sourceOptions.drawPile.visibility === "recipient_only";
}

/** C10 offers the current public discard top only for the first ordinary draw slot. */
export const pedroRamirezAbility: CharacterAbilityModule<"pedro_ramirez"> = (input) => {
  if (!isFirstOrdinaryDraw(input) || input.state.turn.phase !== "draw" ||
      input.state.turn.currentPlayerId !== input.playerId) return noEffect();

  const actor = uniqueSeat(input.state, input.playerId);
  if (!actor || actor.public.characterId !== "pedro_ramirez" || actor.public.eliminated || actor.public.hp <= 0) {
    return noEffect();
  }

  const currentTop = currentDiscardTop(input);
  if (latestSourceChoice(input)) return finishSelectedSource(input, currentTop);
  if (!currentTop) return noEffect();
  return requestSourceChoice(input, currentTop);
};
