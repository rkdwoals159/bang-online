import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  JesseFirstTurnDrawSlotHookInput,
} from "../character-api.js";

const SOURCE_INTERACTION = "JESSE_DRAW_SOURCE";
const DRAW_FROM_PILE = "DRAW_FROM_PILE";
const TAKE_FROM_HAND = "TAKE_FROM_HAND";

const BASE_CARD_DEFINITION_IDS = new Set(BASE_PHYSICAL_CARDS.map(({ definitionId }) => definitionId));

type JesseInput = CharacterAbilityInput<"jesse_jones">;
type JesseState = JesseInput["state"];
type JesseSeat = JesseState["seats"][number];

interface EligibleHandSource {
  readonly playerId: string;
  readonly cardInstanceIds: readonly string[];
}

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function uniqueSeat(state: JesseState, playerId: string): JesseSeat | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function validPhysicalHandCards(state: JesseState, seat: JesseSeat): string[] {
  const occurrences = new Map<string, number>();
  const recordOccurrences = (cardInstanceIds: readonly string[]) => {
    for (const cardInstanceId of cardInstanceIds) {
      occurrences.set(cardInstanceId, (occurrences.get(cardInstanceId) ?? 0) + 1);
    }
  };

  for (const currentSeat of state.seats) {
    recordOccurrences(currentSeat.private.handCardInstanceIds);
    recordOccurrences(currentSeat.public.inPlayCardInstanceIds);
  }
  recordOccurrences(state.zones.drawPileCardInstanceIds);
  recordOccurrences(state.zones.discardPileCardInstanceIds);
  recordOccurrences(state.zones.revealedPoolCardInstanceIds);

  return [...new Set(seat.private.handCardInstanceIds)].filter((cardInstanceId) => {
    const card = state.zones.cardsByInstanceId[cardInstanceId];
    return card?.cardInstanceId === cardInstanceId &&
      BASE_CARD_DEFINITION_IDS.has(card.cardDefinitionId) &&
      occurrences.get(cardInstanceId) === 1;
  });
}

function eligibleHandSources(input: JesseInput): EligibleHandSource[] {
  const offeredPlayerIds = new Set<string>();
  const sources: EligibleHandSource[] = [];

  for (const offered of input.hook.sourceOptions.eligibleOpponentHands) {
    if (offered.visibility !== "recipient_only" ||
        !Number.isSafeInteger(offered.handCardCount) || offered.handCardCount <= 0 ||
        offered.playerId === input.playerId || offeredPlayerIds.has(offered.playerId)) {
      continue;
    }

    const source = uniqueSeat(input.state, offered.playerId);
    if (!source || source.public.eliminated || source.public.hp <= 0) continue;

    const cardInstanceIds = validPhysicalHandCards(input.state, source);
    if (cardInstanceIds.length === 0) continue;

    offeredPlayerIds.add(offered.playerId);
    sources.push({ playerId: offered.playerId, cardInstanceIds });
  }

  return sources;
}

function latestSourceChoice(input: JesseInput) {
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

function randomIndex(length: number, input: JesseInput): number {
  const sample = input.random.nextFloat();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("RandomSource.nextFloat() must return a finite value in [0, 1).");
  }
  return Math.floor(sample * length);
}

function transferEvent(input: JesseInput, sourcePlayerId: string, cardInstanceId: string): EffectEventDraft {
  return {
    type: "CARD_TRANSFERRED",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      fromPlayerId: sourcePlayerId,
      fromZone: "hand",
      toPlayerId: input.playerId,
      toZone: "hand",
    },
  };
}

function finishSelectedSource(input: JesseInput, sources: readonly EligibleHandSource[]): CharacterEffectResult {
  const completed = latestSourceChoice(input);
  if (!completed) return noEffect();
  if (completed.responses.length !== 1) return noEffect();

  const response = completed.responses[0]!;
  if (response.playerId !== input.playerId) return noEffect();

  if (response.choice === DRAW_FROM_PILE && exactPayloadKeys(response.payload, [])) {
    // An empty result leaves the normal draw path in charge of R08/D05.
    return noEffect();
  }

  if (response.choice !== TAKE_FROM_HAND || !exactPayloadKeys(response.payload, ["sourcePlayerId"])) {
    return noEffect();
  }

  const sourcePlayerId = response.payload.sourcePlayerId;
  if (typeof sourcePlayerId !== "string") return noEffect();

  const source = sources.find((candidate) => candidate.playerId === sourcePlayerId);
  if (!source || source.cardInstanceIds.length === 0) return noEffect();

  const cardInstanceId = source.cardInstanceIds[randomIndex(source.cardInstanceIds.length, input)];
  if (!cardInstanceId) return noEffect();

  return { kind: "applied", events: [transferEvent(input, sourcePlayerId, cardInstanceId)], steps: [] };
}

function requestSourceChoice(
  input: JesseInput,
  sources: readonly EligibleHandSource[],
): CharacterEffectResult {
  return {
    kind: "choice_required",
    request: {
      kind: SOURCE_INTERACTION,
      responders: [{
        playerId: input.playerId,
        options: [
          { choice: DRAW_FROM_PILE, payload: {} },
          ...sources.map(({ playerId }) => ({
            choice: TAKE_FROM_HAND,
            payload: { sourcePlayerId: playerId },
          })),
        ],
      }],
      context: {
        continuationFrameId: input.continuationFrameId,
        actorPlayerId: input.playerId,
      },
      resumeFrameId: input.continuationFrameId,
    },
    events: [],
    steps: [],
  };
}

function isFirstTurnDraw(input: JesseInput): boolean {
  const hook: JesseFirstTurnDrawSlotHookInput = input.hook;
  return hook.kind === "draw_slot" &&
    hook.timing === "before" &&
    hook.distribution.kind === "normal_turn" &&
    hook.distribution.position === "first" &&
    hook.sourceOptions.drawPile.kind === "draw_pile" &&
    hook.sourceOptions.drawPile.visibility === "recipient_only";
}

/** C05 offers one private source choice for the first ordinary turn draw slot. */
export const jesseJonesAbility: CharacterAbilityModule<"jesse_jones"> = (input) => {
  if (!isFirstTurnDraw(input)) return noEffect();

  const actor = uniqueSeat(input.state, input.playerId);
  if (!actor || actor.public.characterId !== "jesse_jones" || actor.public.eliminated || actor.public.hp <= 0) {
    return noEffect();
  }

  const sources = eligibleHandSources(input);
  if (latestSourceChoice(input)) return finishSelectedSource(input, sources);
  if (sources.length === 0) return noEffect();
  return requestSourceChoice(input, sources);
};
