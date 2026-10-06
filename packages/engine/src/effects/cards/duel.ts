import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.js";
import type { EffectStep, JsonValue } from "../../state/types.js";
import type {
  CardEffectInput,
  CardEffectModule,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectEventDraft,
  EffectInteractionRequest,
  IllegalEffectTargetCode,
} from "../api.js";

type EffectSeat = CardEffectInput["state"]["seats"][number];
type DuelResponse = CompletedEffectInteraction["responses"][number];

const TYPE_BY_DEFINITION_ID = new Map(
  BASE_PHYSICAL_CARDS.map(({ definitionId, typeId }) => [definitionId, typeId]),
);

function reject(code: IllegalEffectTargetCode): CardEffectResult {
  return { kind: "invalid_target", code };
}

function uniqueSeat(state: CardEffectInput["state"], playerId: string): EffectSeat | undefined {
  const matches = state.seats.filter((seat) => seat.public.playerId === playerId);
  return matches.length === 1 ? matches[0] : undefined;
}

function cardType(input: CardEffectInput, cardInstanceId: string | null): string | undefined {
  if (cardInstanceId === null) return undefined;
  const instance = input.state.zones.cardsByInstanceId[cardInstanceId];
  return instance?.cardInstanceId === cardInstanceId
    ? TYPE_BY_DEFINITION_ID.get(instance.cardDefinitionId)
    : undefined;
}

function event(
  type: string,
  actorPlayerId: string | null,
  payload: Record<string, JsonValue>,
): EffectEventDraft {
  return { type, actorPlayerId, payload };
}

function playerResponseCards(input: CardEffectInput, responder: EffectSeat): string[] {
  const canConvertMissed = responder.public.characterId === "calamity_janet";
  return responder.private.handCardInstanceIds.filter((cardInstanceId) => {
    const typeId = cardType(input, cardInstanceId);
    return typeId === "bang" || (canConvertMissed && typeId === "missed");
  });
}

function interactionRequest(
  input: CardEffectInput,
  initiatorPlayerId: string,
  targetPlayerId: string,
  responder: EffectSeat,
): EffectInteractionRequest | undefined {
  const cardInstanceIds = playerResponseCards(input, responder);
  if (cardInstanceIds.length === 0) return undefined;

  const options: Array<{ choice: string; payload: { [key: string]: JsonValue } }> = cardInstanceIds.map((cardInstanceId) => ({
    choice: "PLAY_BANG",
    payload: { cardInstanceId },
  }));
  options.push({ choice: "YIELD", payload: {} });

  return {
    kind: "DUEL_RESPONSE",
    responders: [{ playerId: responder.public.playerId, options }],
    context: {
      continuationFrameId: input.continuationFrameId,
      sourcePlayerId: initiatorPlayerId,
      sourceCardInstanceId: input.sourceCardInstanceId,
      initiatorPlayerId,
      targetPlayerId,
      responderPlayerId: responder.public.playerId,
    },
    resumeFrameId: input.continuationFrameId,
  };
}

function damageStep(
  input: CardEffectInput,
  initiatorPlayerId: string,
  victimPlayerId: string,
): EffectStep {
  return {
    effectId: `${input.continuationFrameId}:duel:${input.sourceCardInstanceId}:damage:${victimPlayerId}`,
    kind: "DAMAGE_PLAYER",
    // Duel damage retains the card initiator as the cause. T13's R28 rule
    // suppresses a kill reward when that initiator is also the victim.
    sourcePlayerId: initiatorPlayerId,
    targetPlayerId: victimPlayerId,
    sourceCardInstanceId: input.sourceCardInstanceId,
    payload: {
      amount: 1,
      cause: "DUEL",
      duelInitiatorPlayerId: initiatorPlayerId,
    },
  };
}

function damageResult(
  input: CardEffectInput,
  initiatorPlayerId: string,
  victimPlayerId: string,
  prefixEvents: readonly EffectEventDraft[],
  isInitial: boolean,
): CardEffectResult {
  const events = [
    ...(isInitial
      ? [event("DUEL_STARTED", initiatorPlayerId, {
          sourceCardInstanceId: input.sourceCardInstanceId,
          initiatorPlayerId,
          targetPlayerId: victimPlayerId,
        })]
      : []),
    ...prefixEvents,
    event("DUEL_YIELDED", victimPlayerId, {
      sourceCardInstanceId: input.sourceCardInstanceId,
      initiatorPlayerId,
      playerId: victimPlayerId,
      damage: 1,
    }),
  ];
  return {
    kind: "applied",
    events,
    steps: [damageStep(input, initiatorPlayerId, victimPlayerId)],
  };
}

function bangResponseEvents(
  input: CardEffectInput,
  initiatorPlayerId: string,
  opponentPlayerId: string,
  responder: EffectSeat,
  cardInstanceId: string,
  typeId: "bang" | "missed",
): EffectEventDraft[] {
  return [
    event("CARD_DISCARDED", responder.public.playerId, {
      sourceCardInstanceId: input.sourceCardInstanceId,
      cardInstanceId,
      ownerPlayerId: responder.public.playerId,
      fromZone: "hand",
      toZone: "discard",
    }),
    event("DUEL_BANG_PLAYED", responder.public.playerId, {
      sourceCardInstanceId: input.sourceCardInstanceId,
      initiatorPlayerId,
      responderPlayerId: responder.public.playerId,
      targetPlayerId: opponentPlayerId,
      cardInstanceId,
      cardType: typeId,
      asCardType: "bang",
    }),
  ];
}

function relevantInteractions(input: CardEffectInput): CompletedEffectInteraction[] {
  return input.completedInteractions.filter((interaction) =>
    interaction.kind === "DUEL_RESPONSE" &&
    interaction.context.continuationFrameId === input.continuationFrameId &&
    interaction.context.sourceCardInstanceId === input.sourceCardInstanceId,
  );
}

function responseCardIsLegal(
  input: CardEffectInput,
  responder: EffectSeat,
  response: DuelResponse,
  alreadyUsed: ReadonlySet<string>,
  requireCurrentHandOwnership: boolean,
): { cardInstanceId: string; typeId: "bang" | "missed" } | undefined {
  if (Object.keys(response.payload).length !== 1) return undefined;
  const cardInstanceId = response.payload.cardInstanceId;
  if (typeof cardInstanceId !== "string" || alreadyUsed.has(cardInstanceId)) return undefined;
  if (requireCurrentHandOwnership && !responder.private.handCardInstanceIds.includes(cardInstanceId)) return undefined;
  const typeId = cardType(input, cardInstanceId);
  if (
    typeId !== "bang" &&
    !(typeId === "missed" && responder.public.characterId === "calamity_janet")
  ) return undefined;
  return { cardInstanceId, typeId };
}

function resolveDuel(input: CardEffectInput): CardEffectResult {
  if (input.sourceCardInstanceId === null || cardType(input, input.sourceCardInstanceId) !== "duel") {
    return reject("TARGET_NOT_ALLOWED");
  }
  if (input.targets.length === 0) return { kind: "target_required" };
  if (input.targets.length !== 1 || input.targets[0]?.kind !== "player") {
    return reject("TARGET_NOT_ALLOWED");
  }

  const initiator = uniqueSeat(input.state, input.actorPlayerId);
  if (!initiator) return reject("TARGET_NOT_FOUND");
  if (initiator.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const targetPlayerId = input.targets[0].playerId;
  if (targetPlayerId === initiator.public.playerId) return reject("TARGET_IS_SELF");
  const target = uniqueSeat(input.state, targetPlayerId);
  if (!target) return reject("TARGET_NOT_FOUND");
  if (target.public.eliminated) return reject("TARGET_NOT_ALIVE");

  const history = relevantInteractions(input);
  const participants = new Map<string, EffectSeat>([
    [initiator.public.playerId, initiator],
    [target.public.playerId, target],
  ]);
  let expectedResponderId = target.public.playerId;
  const usedCardIds = new Set<string>();
  let lastResponse: { responder: EffectSeat; answer: DuelResponse; card?: { cardInstanceId: string; typeId: "bang" | "missed" } } | undefined;

  for (const [historyIndex, interaction] of history.entries()) {
    if (
      interaction.context.initiatorPlayerId !== initiator.public.playerId ||
      interaction.context.targetPlayerId !== target.public.playerId ||
      interaction.context.sourcePlayerId !== initiator.public.playerId ||
      interaction.context.responderPlayerId !== expectedResponderId ||
      interaction.responses.length !== 1
    ) return reject("TARGET_NOT_ALLOWED");

    const responder = participants.get(expectedResponderId);
    const answer = interaction.responses[0]!;
    if (!responder || answer.playerId !== expectedResponderId) return reject("TARGET_NOT_ALLOWED");

    if (answer.choice === "YIELD") {
      if (Object.keys(answer.payload).length !== 0 || interaction !== history.at(-1)) {
        return reject("TARGET_NOT_ALLOWED");
      }
      lastResponse = { responder, answer };
      break;
    }
    if (answer.choice !== "PLAY_BANG") return reject("TARGET_NOT_ALLOWED");
    const card = responseCardIsLegal(
      input,
      responder,
      answer,
      usedCardIds,
      historyIndex === history.length - 1,
    );
    if (!card) return reject("TARGET_NOT_ALLOWED");
    usedCardIds.add(card.cardInstanceId);
    lastResponse = { responder, answer, card };
    expectedResponderId = expectedResponderId === initiator.public.playerId
      ? target.public.playerId
      : initiator.public.playerId;
  }

  if (lastResponse?.answer.choice === "YIELD") {
    return damageResult(input, initiator.public.playerId, lastResponse.responder.public.playerId, [], false);
  }

  const currentResponder = participants.get(expectedResponderId);
  if (!currentResponder) return reject("TARGET_NOT_FOUND");

  let prefixEvents: EffectEventDraft[] = [];
  if (lastResponse?.card) {
    prefixEvents = bangResponseEvents(
      input,
      initiator.public.playerId,
      currentResponder.public.playerId,
      lastResponse.responder,
      lastResponse.card.cardInstanceId,
      lastResponse.card.typeId,
    );
  }

  const request = interactionRequest(
    input,
    initiator.public.playerId,
    target.public.playerId,
    currentResponder,
  );
  if (!request) {
    return damageResult(
      input,
      initiator.public.playerId,
      currentResponder.public.playerId,
      prefixEvents,
      history.length === 0,
    );
  }

  return {
    kind: "response_required",
    request,
    events: [
      ...(history.length === 0
        ? [event("DUEL_STARTED", initiator.public.playerId, {
            sourceCardInstanceId: input.sourceCardInstanceId,
            initiatorPlayerId: initiator.public.playerId,
            targetPlayerId: target.public.playerId,
          })]
        : []),
      ...prefixEvents,
    ],
    steps: [],
  };
}

/** Target-first, distance-independent Duel response cycle (R21, C03, R28). */
export const duelEffect: CardEffectModule = (input) => resolveDuel(input);
