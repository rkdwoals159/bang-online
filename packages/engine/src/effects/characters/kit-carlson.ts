import type { EffectEventDraft } from "../api.js";
import type {
  CharacterAbilityInput,
  CharacterAbilityModule,
  CharacterEffectResult,
  DrawPhaseHookInput,
} from "../character-api.js";

const PICK_INTERACTION = "KIT_CARLSON_PICK";
const PICK_CARDS_CHOICE = "CHOOSE_CARDS";

type KitInput = CharacterAbilityInput<"kit_carlson">;
type KitCandidate = DrawPhaseHookInput["candidates"][number];
type CandidateStorage = "draw_pile" | "revealed_pool";

function noEffect(): CharacterEffectResult {
  return { kind: "applied", events: [], steps: [] };
}

function isKitDrawPhase(input: KitInput): boolean {
  return input.hook.kind === "draw_phase" &&
    input.hook.timing === "before" &&
    input.hook.distribution === "normal_turn" &&
    input.hook.requestedCardCount === 2 &&
    input.hook.source.kind === "draw_pile" &&
    input.hook.visibility === "recipient_only";
}

function currentLocations(input: KitInput, cardInstanceId: string): string[] {
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

function currentCandidateStorage(input: KitInput): CandidateStorage | undefined {
  const candidates = input.hook.candidates;
  const candidateIds = candidates.map(({ cardInstanceId }) => cardInstanceId);
  if (candidateIds.length !== 3 || new Set(candidateIds).size !== 3) return undefined;

  for (const candidate of candidates) {
    const current = input.state.zones.cardsByInstanceId[candidate.cardInstanceId];
    if (!current || current.cardInstanceId !== candidate.cardInstanceId ||
        current.cardDefinitionId !== candidate.cardDefinitionId || current.rank !== candidate.rank ||
        current.suit !== candidate.suit || currentLocations(input, candidate.cardInstanceId).length !== 1) {
      return undefined;
    }
  }

  const inRevealedPool = candidateIds.every((cardInstanceId) =>
    currentLocations(input, cardInstanceId)[0] === "revealed_pool");
  if (inRevealedPool) return "revealed_pool";

  const topThree = input.state.zones.drawPileCardInstanceIds.slice(0, 3);
  const inDrawPile = candidateIds.every((cardInstanceId) => currentLocations(input, cardInstanceId)[0] === "draw_pile");
  if (inDrawPile && topThree.length === 3 && topThree.every((cardInstanceId, index) => cardInstanceId === candidateIds[index])) {
    return "draw_pile";
  }

  return undefined;
}

function latestPick(input: KitInput) {
  for (let index = input.completedInteractions.length - 1; index >= 0; index -= 1) {
    const interaction = input.completedInteractions[index]!;
    if (interaction.kind === PICK_INTERACTION &&
        interaction.context.continuationFrameId === input.continuationFrameId &&
        interaction.context.actorPlayerId === input.playerId) {
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

function selectedCardIds(input: KitInput): readonly string[] | undefined {
  const completed = latestPick(input);
  if (!completed || completed.responses.length !== 1) return undefined;

  const response = completed.responses[0]!;
  if (response.playerId !== input.playerId || response.choice !== PICK_CARDS_CHOICE ||
      !hasExactPayloadKeys(response.payload, ["selectedCardInstanceIds"])) return undefined;

  const value = response.payload.selectedCardInstanceIds;
  if (!Array.isArray(value) || value.length !== 2 || value.some((cardInstanceId) => typeof cardInstanceId !== "string")) {
    return undefined;
  }
  const ids = value as string[];
  const candidates = input.hook.candidates.map(({ cardInstanceId }) => cardInstanceId);
  if (new Set(ids).size !== 2 || ids.some((cardInstanceId) => !candidates.includes(cardInstanceId))) return undefined;
  return ids;
}

function pickOptions(candidates: readonly KitCandidate[]): Array<{
  readonly choice: string;
  readonly payload: { readonly selectedCardInstanceIds: string[] };
}> {
  const options: Array<{
    readonly choice: string;
    readonly payload: { readonly selectedCardInstanceIds: string[] };
  }> = [];

  for (let first = 0; first < candidates.length; first += 1) {
    for (let second = first + 1; second < candidates.length; second += 1) {
      const firstId = candidates[first]!.cardInstanceId;
      const secondId = candidates[second]!.cardInstanceId;
      options.push(
        { choice: PICK_CARDS_CHOICE, payload: { selectedCardInstanceIds: [firstId, secondId] } },
        { choice: PICK_CARDS_CHOICE, payload: { selectedCardInstanceIds: [secondId, firstId] } },
      );
    }
  }
  return options;
}

function choiceRequest(input: KitInput): CharacterEffectResult {
  return {
    kind: "choice_required",
    request: {
      kind: PICK_INTERACTION,
      responders: [{
        playerId: input.playerId,
        options: pickOptions(input.hook.candidates),
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

function drawFromPileEvent(input: KitInput, cardInstanceId: string): EffectEventDraft {
  return {
    type: "CARD_DRAWN",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      playerId: input.playerId,
      fromZone: "draw_pile",
      toZone: "hand",
    },
  };
}

function transferFromRevealedPoolEvent(
  input: KitInput,
  cardInstanceId: string,
  toZone: "hand" | "draw_pile",
): EffectEventDraft {
  return {
    type: "CARD_TRANSFERRED",
    actorPlayerId: input.playerId,
    payload: {
      sourceCardInstanceId: null,
      cardInstanceId,
      fromZone: "revealed_pool",
      ...(toZone === "hand" ? { toPlayerId: input.playerId } : {}),
      toZone,
    },
  };
}

function applyPick(input: KitInput, storage: CandidateStorage): CharacterEffectResult {
  const selected = selectedCardIds(input);
  if (!selected) return noEffect();

  const selectedSet = new Set(selected);
  const candidateIds = input.hook.candidates.map(({ cardInstanceId }) => cardInstanceId);
  const gained = candidateIds.filter((cardInstanceId) => selectedSet.has(cardInstanceId));
  const returnedToTop = candidateIds.find((cardInstanceId) => !selectedSet.has(cardInstanceId));
  if (gained.length !== 2 || !returnedToTop) return noEffect();

  const events = storage === "draw_pile"
    ? gained.map((cardInstanceId) => drawFromPileEvent(input, cardInstanceId))
    : [
        ...gained.map((cardInstanceId) => transferFromRevealedPoolEvent(input, cardInstanceId, "hand")),
        transferFromRevealedPoolEvent(input, returnedToTop, "draw_pile"),
      ];

  return { kind: "applied", events, steps: [] };
}

/** C07 privately selects two of the three supplied draw-pile candidates. */
export const kitCarlsonAbility: CharacterAbilityModule<"kit_carlson"> = (input) => {
  if (!isKitDrawPhase(input)) return noEffect();

  const actorMatches = input.state.seats.filter((seat) => seat.public.playerId === input.playerId);
  const actor = actorMatches.length === 1 ? actorMatches[0] : undefined;
  if (input.state.status !== "playing" || input.state.turn.phase !== "draw" ||
      input.state.turn.currentPlayerId !== input.playerId || !actor ||
      actor.public.characterId !== "kit_carlson" || actor.public.eliminated || actor.public.hp <= 0) {
    return noEffect();
  }

  const storage = currentCandidateStorage(input);
  if (!storage) return noEffect();
  return latestPick(input) ? applyPick(input, storage) : choiceRequest(input);
};
