import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  DrawJudgmentSource,
  LuckyDrawJudgmentHookInput,
} from "../character-api.js";

const LUCKY_DRAW_INTERACTION = "LUCKY_DRAW";
const SELECT_JUDGMENT = "SELECT_JUDGMENT";

type LuckyInput = CharacterAbilityInput<"lucky_duke">;
type LuckySeat = LuckyInput["state"]["seats"][number];
type Candidate = LuckyDrawJudgmentHookInput["judgment"]["candidates"][number];
type CandidateStorage = "draw_pile" | "revealed_pool";

const CARD_TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function isLuckyDrawHook(input: LuckyInput): input is LuckyInput & { readonly hook: LuckyDrawJudgmentHookInput } {
  return input.hook.kind === "judgment" && input.hook.judgment.kind === "lucky_draw";
}

function uniqueSeat(input: LuckyInput, playerId: string): LuckySeat | undefined {
  const matches = input.state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function sourceCardInstanceId(source: DrawJudgmentSource): string | undefined {
  const candidate = source.kind === "jourdonnais_virtual_barrel"
    ? source.attackCard.cardInstanceId
    : source.cardInstanceId;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function sourceIsValid(input: LuckyInput, source: DrawJudgmentSource): boolean {
  const cardInstanceId = sourceCardInstanceId(source);
  if (!cardInstanceId) return false;

  const sourceCard = input.state.zones.cardsByInstanceId[cardInstanceId];
  if (!sourceCard || sourceCard.cardInstanceId !== cardInstanceId) return false;
  const actualType = CARD_TYPE_BY_DEFINITION_ID.get(sourceCard.cardDefinitionId);
  if (source.kind === "jourdonnais_virtual_barrel") {
    return source.attackCard.physicalCardTypeId === actualType;
  }

  return actualType === source.kind;
}

function currentLocations(input: LuckyInput, cardInstanceId: string): string[] {
  const locations: string[] = [];
  const record = (zone: string, ids: readonly string[]) => {
    for (const currentId of ids) {
      if (currentId === cardInstanceId) locations.push(zone);
    }
  };

  for (const seat of input.state.seats) {
    record("hand", seat.private.handCardInstanceIds);
    record("in_play", seat.public.inPlayCardInstanceIds);
  }
  record("draw_pile", input.state.zones.drawPileCardInstanceIds);
  record("discard", input.state.zones.discardPileCardInstanceIds);
  record("revealed_pool", input.state.zones.revealedPoolCardInstanceIds);
  return locations;
}

function currentCandidateStorage(input: LuckyInput, candidates: readonly Candidate[]): CandidateStorage | undefined {
  const candidateIds = candidates.map(({ cardInstanceId }) => cardInstanceId);
  if (candidateIds.length !== 2 || candidateIds.some((id) => typeof id !== "string" || id.length === 0) ||
      new Set(candidateIds).size !== 2) return undefined;

  for (const candidate of candidates) {
    const current = input.state.zones.cardsByInstanceId[candidate.cardInstanceId];
    if (!current || current.cardInstanceId !== candidate.cardInstanceId ||
        current.cardDefinitionId !== candidate.cardDefinitionId || current.rank !== candidate.rank ||
        current.suit !== candidate.suit || currentLocations(input, candidate.cardInstanceId).length !== 1) {
      return undefined;
    }
  }

  const candidateLocations = candidateIds.map((cardInstanceId) => currentLocations(input, cardInstanceId)[0]);
  if (candidateLocations.every((zone) => zone === "revealed_pool") &&
      input.state.zones.revealedPoolCardInstanceIds.length === 2 &&
      input.state.zones.revealedPoolCardInstanceIds.every((cardInstanceId, index) => cardInstanceId === candidateIds[index])) {
    return "revealed_pool";
  }

  if (candidateLocations.every((zone) => zone === "draw_pile") &&
      input.state.zones.drawPileCardInstanceIds[0] === candidateIds[0] &&
      input.state.zones.drawPileCardInstanceIds[1] === candidateIds[1]) {
    return "draw_pile";
  }

  return undefined;
}

function requestContext(input: LuckyInput, source: DrawJudgmentSource, candidates: readonly Candidate[]) {
  return {
    continuationFrameId: input.continuationFrameId,
    playerId: input.playerId,
    sourceKind: source.kind,
    sourceCardInstanceId: sourceCardInstanceId(source)!,
    candidateCardInstanceIds: candidates.map(({ cardInstanceId }) => cardInstanceId),
  };
}

function choiceOptions(candidates: readonly Candidate[]): Array<{
  readonly choice: string;
  readonly payload: { readonly selectedCardInstanceId: string; readonly orderedCardInstanceIds: string[] };
}> {
  const [first, second] = candidates;
  if (!first || !second) return [];

  const orders = [
    [first.cardInstanceId, second.cardInstanceId],
    [second.cardInstanceId, first.cardInstanceId],
  ];
  return candidates.flatMap(({ cardInstanceId: selectedCardInstanceId }) => orders.map((orderedCardInstanceIds) => ({
    choice: SELECT_JUDGMENT,
    payload: { selectedCardInstanceId, orderedCardInstanceIds: [...orderedCardInstanceIds] },
  })));
}

function revealEvents(
  input: LuckyInput,
  source: DrawJudgmentSource,
  candidates: readonly Candidate[],
  storage: CandidateStorage,
): readonly EffectEventDraft[] {
  if (storage === "revealed_pool") return [];
  const sourceId = sourceCardInstanceId(source)!;
  return candidates.map(({ cardInstanceId }) => ({
    type: "CARD_TRANSFERRED",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: sourceId,
      cardInstanceId,
      fromZone: "draw_pile",
      toZone: "revealed_pool",
    },
  }));
}

function choiceRequest(
  input: LuckyInput,
  source: DrawJudgmentSource,
  candidates: readonly Candidate[],
  storage: CandidateStorage,
): CharacterEffectResult {
  return {
    kind: "choice_required",
    request: {
      kind: LUCKY_DRAW_INTERACTION,
      responders: [{ playerId: input.playerId, options: choiceOptions(candidates) }],
      context: requestContext(input, source, candidates),
      resumeFrameId: input.continuationFrameId,
    },
    events: revealEvents(input, source, candidates, storage),
    steps: [],
  };
}

function interactionMatches(
  input: LuckyInput,
  source: DrawJudgmentSource,
  candidates: readonly Candidate[],
): LuckyInput["completedInteractions"][number] | undefined {
  const expectedContext = requestContext(input, source, candidates);
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (interaction.kind !== LUCKY_DRAW_INTERACTION) continue;
    const context = interaction.context;
    const contextIds = context.candidateCardInstanceIds;
    if (context.continuationFrameId === expectedContext.continuationFrameId &&
        context.playerId === expectedContext.playerId &&
        context.sourceKind === expectedContext.sourceKind &&
        context.sourceCardInstanceId === expectedContext.sourceCardInstanceId &&
        Array.isArray(contextIds) && contextIds.length === 2 &&
        contextIds.every((cardInstanceId, idIndex) => cardInstanceId === expectedContext.candidateCardInstanceIds[idIndex])) {
      return interaction;
    }
  }
  return undefined;
}

function hasExactPayloadKeys(payload: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(payload).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function chosenCards(
  input: LuckyInput,
  source: DrawJudgmentSource,
  candidates: readonly Candidate[],
): readonly [string, string] | undefined {
  const selection = input.hook.judgment.selection;
  if (selection.kind !== "selected") return undefined;
  const candidateIds = candidates.map(({ cardInstanceId }) => cardInstanceId);
  if (!candidateIds.includes(selection.cardInstanceId)) return undefined;

  const interaction = interactionMatches(input, source, candidates);
  if (!interaction || interaction.responses.length !== 1) return undefined;
  const response = interaction.responses[0]!;
  if (response.playerId !== input.playerId || response.choice !== SELECT_JUDGMENT ||
      !hasExactPayloadKeys(response.payload, ["selectedCardInstanceId", "orderedCardInstanceIds"])) return undefined;

  const selectedId = response.payload.selectedCardInstanceId;
  const rawOrder = response.payload.orderedCardInstanceIds;
  if (selectedId !== selection.cardInstanceId || !candidateIds.includes(selectedId as string) ||
      !Array.isArray(rawOrder) || rawOrder.length !== 2 || rawOrder.some((id) => typeof id !== "string")) return undefined;
  const orderedIds = rawOrder as string[];
  if (new Set(orderedIds).size !== 2 || candidateIds.some((id) => !orderedIds.includes(id))) return undefined;
  return [orderedIds[0]!, orderedIds[1]!];
}

function discardEvents(
  input: LuckyInput,
  source: DrawJudgmentSource,
  orderedCardInstanceIds: readonly [string, string],
  storage: CandidateStorage,
): readonly EffectEventDraft[] {
  const sourceId = sourceCardInstanceId(source)!;
  const initialReveal = storage === "draw_pile"
    ? orderedCardInstanceIds.map((cardInstanceId) => ({
        type: "CARD_TRANSFERRED",
        actorPlayerId: input.playerId,
        payload: {
          sourceCardInstanceId: sourceId,
          cardInstanceId,
          fromZone: "draw_pile",
          toZone: "revealed_pool",
        },
      } satisfies EffectEventDraft))
    : [];
  const discards = orderedCardInstanceIds.map((cardInstanceId) => ({
    type: "CARD_DISCARDED",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: sourceId,
      cardInstanceId,
      ownerPlayerId: null,
      fromZone: "revealed_pool",
      toZone: "discard",
      cause: "LUCKY_DRAW",
    },
  } satisfies EffectEventDraft));
  return [...initialReveal, ...discards];
}

function isValidInput(input: LuckyInput): input is LuckyInput & { readonly hook: LuckyDrawJudgmentHookInput } {
  if (input.characterId !== "lucky_duke" || !isLuckyDrawHook(input) || input.state.status !== "playing") return false;
  const actor = uniqueSeat(input, input.playerId);
  return Boolean(actor && actor.public.characterId === "lucky_duke" && !actor.public.eliminated && actor.public.hp > 0 &&
    input.hook.judgment.playerId === input.playerId && sourceIsValid(input, input.hook.judgment.source));
}

/** C08 consumes two caller-supplied Draw! candidates; T67 owns R08 supply. */
export const luckyDukeAbility: CharacterAbilityModule<"lucky_duke"> = (input) => {
  if (!isValidInput(input)) return noEffect();
  const { source, candidates, selection } = input.hook.judgment;
  const storage = currentCandidateStorage(input, candidates);
  if (!storage) return noEffect();

  if (selection.kind === "awaiting_choice") return choiceRequest(input, source, candidates, storage);

  const orderedCardInstanceIds = chosenCards(input, source, candidates);
  if (!orderedCardInstanceIds) return noEffect();
  return {
    kind: "applied",
    events: discardEvents(input, source, orderedCardInstanceIds, storage),
    steps: [],
  };
};
