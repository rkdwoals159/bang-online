// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { applyMatchCommand } from "../../../src/commands/index.ts";
import { bangEffect } from "../../../src/effects/cards/basic-actions.ts";
import { duelEffect } from "../../../src/effects/cards/duel.ts";
import { gatlingEffect, indiansEffect } from "../../../src/effects/cards/tablewide.ts";
import { calamityJanetAbility } from "../../../src/effects/characters/calamity-janet.ts";
import { createEffectCommandHandlers } from "../../../src/effects/runtime/index.ts";
import type {
  CardSubstitutionHookInput,
  CharacterAbilityInput,
  CharacterCardReference,
} from "../../../src/effects/character-api.ts";
import type {
  CardEffectInput,
  CardEffectResult,
  CompletedEffectInteraction,
  EffectTarget,
} from "../../../src/effects/api.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { GameState } from "../../../src/state/types.ts";

const ACTOR_ID = "player-1";
const TARGET_ID = "player-2";
const FRAME_ID = "frame-calamity-janet";

type CalamityInput = CharacterAbilityInput<"calamity_janet">;

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("card substitution must not consume randomness"); } };
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  state.turn.currentPlayerId = ACTOR_ID;
  state.turn.phase = "play";
  return state;
}

function cardIdsOfType(state: GameState, typeId: string): string[] {
  const definitions = new Set(
    BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId).map((card) => card.definitionId),
  );
  return Object.values(state.zones.cardsByInstanceId)
    .filter((card) => definitions.has(card.cardDefinitionId))
    .map((card) => card.cardInstanceId);
}

function typeOf(state: GameState, cardInstanceId: string): string | undefined {
  const card = state.zones.cardsByInstanceId[cardInstanceId];
  return card && BASE_PHYSICAL_CARDS.find((definition) => definition.definitionId === card.cardDefinitionId)?.typeId;
}

function seat(state: GameState, playerId: string) {
  const matches = state.seats.filter((entry) => entry.public.playerId === playerId);
  assert.equal(matches.length, 1, `expected one seat for ${playerId}`);
  return matches[0]!;
}

function assignCharacter(state: GameState, playerId: string, characterId: string): void {
  const assignedSeat = seat(state, playerId);
  const previousOwner = state.seats.find((entry) =>
    entry.public.playerId !== playerId && entry.public.characterId === characterId);
  if (previousOwner) previousOwner.public.characterId = assignedSeat.public.characterId;
  assignedSeat.public.characterId = characterId;
}

function setHands(state: GameState, hands: Readonly<Record<string, readonly string[]>>): void {
  const allCards = Object.keys(state.zones.cardsByInstanceId);
  const assigned = Object.values(hands).flatMap((ids) => [...ids]);
  assert.equal(new Set(assigned).size, assigned.length, "fixture hand cards must be unique");
  assert.ok(assigned.every((id) => state.zones.cardsByInstanceId[id]), "fixture cards must exist");

  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = [...(hands[seat.public.playerId] ?? [])];
    seat.public.inPlayCardInstanceIds = [];
  }
  state.zones.drawPileCardInstanceIds = [];
  state.zones.revealedPoolCardInstanceIds = [];
  state.zones.discardPileCardInstanceIds = allCards.filter((id) => !assigned.includes(id));
}

function effectInput(
  state: GameState,
  actorPlayerId: string,
  sourceCardInstanceId: string,
  targetPlayerId?: string,
  completedInteractions: readonly CompletedEffectInteraction[] = [],
): CardEffectInput {
  const targets: readonly EffectTarget[] = targetPlayerId === undefined
    ? []
    : [{ kind: "player", playerId: targetPlayerId }];
  return {
    state,
    actorPlayerId,
    sourceCardInstanceId,
    continuationFrameId: FRAME_ID,
    targets,
    random: unusedRandom(),
    completedInteractions,
  };
}

function completedResponse(
  result: CardEffectResult,
  playerId: string,
  choice: string,
  cardInstanceId?: string,
  interactionId = "interaction-calamity-test",
): CompletedEffectInteraction {
  assert.equal(result.kind, "response_required");
  if (result.kind !== "response_required") throw new Error("expected a response request");
  return {
    interactionId,
    kind: result.request.kind,
    context: result.request.context,
    responses: [{
      playerId,
      choice,
      payload: cardInstanceId === undefined ? {} : { cardInstanceId },
    }],
  };
}

function calamityInput(
  state: GameState,
  playerId: string,
  hook: CardSubstitutionHookInput,
): CalamityInput {
  return {
    characterId: "calamity_janet",
    playerId,
    state,
    continuationFrameId: FRAME_ID,
    random: unusedRandom(),
    completedInteractions: [],
    hook,
  };
}

function attackReference(state: GameState, cardInstanceId: string): CharacterCardReference {
  const physicalCardTypeId = typeOf(state, cardInstanceId);
  if (physicalCardTypeId !== "bang" && physicalCardTypeId !== "missed") {
    throw new Error("expected a BANG-symbol physical card");
  }
  return { cardInstanceId, physicalCardTypeId, effectCardTypeId: "bang" };
}

test("Calamity can play a physical Missed as BANG and its substitution counts toward quota", () => {
  const state = initialState();
  assignCharacter(state, ACTOR_ID, "calamity_janet");
  const missedId = cardIdsOfType(state, "missed")[0]!;
  const targetBangId = cardIdsOfType(state, "bang")[0]!;
  const targetMissedId = cardIdsOfType(state, "missed")[1]!;
  setHands(state, { [ACTOR_ID]: [missedId], [TARGET_ID]: [targetBangId, targetMissedId] });
  const before = structuredClone(state);
  const hook: CardSubstitutionHookInput = {
    kind: "card_substitution_query",
    card: { cardInstanceId: missedId, physicalCardTypeId: "missed", effectCardTypeId: "bang" },
    context: { kind: "play_card", phase: "play" },
  };
  const query = calamityInput(state, ACTOR_ID, hook);
  const first = calamityJanetAbility(query);
  const second = calamityJanetAbility(query);
  assert.deepEqual(first, {
    kind: "card_substitution_query",
    allowed: true,
    physicalCardTypeId: "missed",
    effectCardTypeId: "bang",
    bangQuota: "counts",
  });
  assert.deepEqual(second, first, "fixed inputs produce the same stateless query result");
  assert.deepEqual(state, before, "query and effect modules do not mutate their input state");

  const attack = bangEffect(effectInput(state, ACTOR_ID, missedId, TARGET_ID));
  assert.equal(attack.kind, "response_required");
  if (attack.kind === "response_required") {
    assert.equal(attack.request.kind, "BANG_RESPONSE");
    assert.equal(attack.events[0]?.type, "BANG_ATTACKED");
  }

  let routedType = "";
  const command = {
    type: "PLAY_CARD" as const,
    payload: { cardInstanceId: missedId, targetPlayerId: TARGET_ID, asCardType: "bang" },
  };
  const accepted = applyMatchCommand(state, ACTOR_ID, command, {
    random: unusedRandom(),
    handlers: {
      playCard(input) {
        routedType = input.cardTypeId;
        return { ok: true, output: { state: structuredClone(input.state) as GameState, events: [], value: null } };
      },
    },
  });
  assert.equal(accepted.ok, true);
  assert.equal(routedType, "bang");
  if (accepted.ok) assert.equal(accepted.state.turn.bangCardPlaysThisTurn, 1,
    "T71 counts the successfully resolved converted BANG at the command boundary");
  assert.equal(typeOf(state, missedId), "missed", "physical card identity remains unchanged");

  let interactionNumber = 0;
  const runtimeHandlers = createEffectCommandHandlers({
    registry: { cards: { bang: bangEffect } },
    nextInteractionIdentity: () => ({
      interactionId: `calamity-runtime-${++interactionNumber}`,
      createdAt: "2026-09-28T00:00:00.000Z",
    }),
  });
  const runtime = applyMatchCommand(state, ACTOR_ID, command, {
    random: unusedRandom(),
    handlers: runtimeHandlers,
  });
  assert.equal(runtime.ok, true, "T66 should route this physical Missed through the effective BANG module");
  if (runtime.ok) {
    assert.equal(runtime.state.turn.bangCardPlaysThisTurn, 1);
    const pending = runtime.state.resolution.pendingInteraction;
    assert.equal(pending?.kind, "BANG_RESPONSE");
    assert.ok(pending?.options.some((option) =>
      option.choice === "USE_MISSED" && option.payload.cardInstanceId === targetMissedId));
    assert.ok(runtime.state.zones.discardPileCardInstanceIds.includes(missedId),
      "the runtime consumes the physical source card while retaining its BANG effect");

    const response = applyMatchCommand(runtime.state, TARGET_ID, {
      type: "RESPOND",
      payload: { interactionId: pending!.interactionId, choice: "USE_MISSED", cardInstanceId: targetMissedId },
    }, { random: unusedRandom(), handlers: runtimeHandlers });
    assert.equal(response.ok, true,
      "T66 must validate the converted source after it moved to discard and resume the BANG response");
    if (response.ok) {
      assert.equal(response.state.resolution.pendingInteraction, null);
      assert.equal(response.state.turn.bangCardPlaysThisTurn, 1);
      assert.equal(seat(response.state, TARGET_ID).public.hp, seat(runtime.state, TARGET_ID).public.hp);
      assert.ok(response.state.zones.discardPileCardInstanceIds.includes(targetMissedId));
    }
  }
  assert.deepEqual(state, before, "the command and runtime candidates do not mutate the submitted snapshot");

  state.turn.bangCardPlaysThisTurn = 1;
  const overQuota = applyMatchCommand(state, ACTOR_ID, command, {
    random: unusedRandom(),
    handlers: { playCard: () => assert.fail("over-quota converted BANG reached the effect handler") },
  });
  assert.equal(overQuota.ok, false);
  if (!overQuota.ok) assert.equal(overQuota.error.code, "BANG_LIMIT_REACHED");
});

test("Calamity privately receives and may use a physical BANG as Missed in a BANG response", () => {
  const state = initialState();
  assignCharacter(state, TARGET_ID, "calamity_janet");
  const attackId = cardIdsOfType(state, "bang")[0]!;
  const defenseId = cardIdsOfType(state, "bang")[1]!;
  setHands(state, { [ACTOR_ID]: [attackId], [TARGET_ID]: [defenseId] });
  const initial = bangEffect(effectInput(state, ACTOR_ID, attackId, TARGET_ID));
  assert.equal(initial.kind, "response_required");
  if (initial.kind !== "response_required") return;
  assert.deepEqual(initial.request.responders.map((responder) => responder.playerId), [TARGET_ID]);
  assert.deepEqual(initial.request.responders[0]?.options, [
    { choice: "USE_MISSED", payload: { cardInstanceId: defenseId } },
    { choice: "TAKE_HIT", payload: {} },
  ]);
  assert.ok(!initial.request.responders[0]?.options.some((option) =>
    option.payload.cardInstanceId === attackId), "another player's private hand card is not offered");

  const response = completedResponse(initial, TARGET_ID, "USE_MISSED", defenseId);
  const before = structuredClone(state);
  const resolved = bangEffect(effectInput(state, ACTOR_ID, attackId, TARGET_ID, [response]));
  assert.equal(resolved.kind, "applied");
  if (resolved.kind !== "applied") return;
  assert.deepEqual(resolved.events.map((entry) => entry.type), ["BANG_MISSED"]);
  assert.equal(resolved.events[0]?.payload.missedCardInstanceId, defenseId);
  assert.deepEqual(state, before, "the effect drafts the discard event without mutating state");

  const gatlingState = initialState();
  assignCharacter(gatlingState, TARGET_ID, "calamity_janet");
  const gatlingId = cardIdsOfType(gatlingState, "gatling")[0]!;
  const gatlingDefenseId = cardIdsOfType(gatlingState, "bang")[0]!;
  setHands(gatlingState, { [ACTOR_ID]: [gatlingId], [TARGET_ID]: [gatlingDefenseId] });
  const gatlingStart = gatlingEffect(effectInput(gatlingState, ACTOR_ID, gatlingId, TARGET_ID));
  assert.equal(gatlingStart.kind, "response_required");
  if (gatlingStart.kind !== "response_required") return;
  assert.deepEqual(gatlingStart.request.responders[0]?.options, [
    { choice: "USE_MISSED", payload: { cardInstanceId: gatlingDefenseId } },
    { choice: "TAKE_HIT", payload: {} },
  ]);
  const gatlingResponse = completedResponse(gatlingStart, TARGET_ID, "USE_MISSED", gatlingDefenseId);
  const gatlingResolved = gatlingEffect(effectInput(gatlingState, ACTOR_ID, gatlingId, TARGET_ID, [gatlingResponse]));
  assert.equal(gatlingResolved.kind, "applied");
  if (gatlingResolved.kind === "applied") {
    assert.deepEqual(gatlingResolved.events.map((entry) => entry.type), ["CARD_DISCARDED", "GATLING_MISSED"]);
    assert.equal(gatlingResolved.events[0]?.payload.cardInstanceId, gatlingDefenseId);
  }
});

test("T66 preserves Calamity's BANG-as-Missed response across the saved BANG continuation", () => {
  const state = initialState();
  assignCharacter(state, TARGET_ID, "calamity_janet");
  const attackId = cardIdsOfType(state, "bang")[0]!;
  const defenseId = cardIdsOfType(state, "bang")[1]!;
  setHands(state, { [ACTOR_ID]: [attackId], [TARGET_ID]: [defenseId] });
  const before = structuredClone(state);

  let interactionNumber = 0;
  const handlers = createEffectCommandHandlers({
    registry: { cards: { bang: bangEffect } },
    nextInteractionIdentity: () => ({
      interactionId: `calamity-resume-${++interactionNumber}`,
      createdAt: "2026-09-28T00:00:00.000Z",
    }),
  });
  const played = applyMatchCommand(state, ACTOR_ID, {
    type: "PLAY_CARD",
    payload: { cardInstanceId: attackId, targetPlayerId: TARGET_ID },
  }, { random: unusedRandom(), handlers });
  assert.equal(played.ok, true);
  if (!played.ok) return;
  const pending = played.state.resolution.pendingInteraction;
  assert.equal(pending?.kind, "BANG_RESPONSE");
  assert.ok(pending?.options.some((option) =>
    option.choice === "USE_MISSED" && option.payload.cardInstanceId === defenseId));
  assert.equal(played.state.turn.bangCardPlaysThisTurn, 1);

  const response = applyMatchCommand(played.state, TARGET_ID, {
    type: "RESPOND",
    payload: { interactionId: pending!.interactionId, choice: "USE_MISSED", cardInstanceId: defenseId },
  }, { random: unusedRandom(), handlers });
  assert.equal(response.ok, true);
  if (response.ok) {
    assert.equal(response.state.resolution.pendingInteraction, null);
    assert.equal(response.state.turn.bangCardPlaysThisTurn, 1,
      "a BANG used as Missed in RESPOND does not consume another turn quota");
    assert.equal(seat(response.state, TARGET_ID).public.hp, seat(played.state, TARGET_ID).public.hp);
    assert.ok(response.state.zones.discardPileCardInstanceIds.includes(attackId));
    assert.ok(response.state.zones.discardPileCardInstanceIds.includes(defenseId));
  }
  assert.deepEqual(state, before, "PLAY_CARD and saved RESPOND operate on candidate snapshots");
});

test("a non-Calamity cannot submit a BANG as Missed", () => {
  const state = initialState();
  assignCharacter(state, TARGET_ID, "bart_cassidy");
  const attackId = cardIdsOfType(state, "bang")[0]!;
  const forgedDefenseId = cardIdsOfType(state, "bang")[1]!;
  setHands(state, { [ACTOR_ID]: [attackId], [TARGET_ID]: [forgedDefenseId] });
  const initial = bangEffect(effectInput(state, ACTOR_ID, attackId, TARGET_ID));
  assert.equal(initial.kind, "response_required");
  if (initial.kind !== "response_required") return;
  assert.deepEqual(initial.request.responders[0]?.options, [{ choice: "TAKE_HIT", payload: {} }]);

  const forged = completedResponse(initial, TARGET_ID, "USE_MISSED", forgedDefenseId);
  assert.deepEqual(bangEffect(effectInput(state, ACTOR_ID, attackId, TARGET_ID, [forged])), {
    kind: "invalid_target",
    code: "TARGET_NOT_ALLOWED",
  });
});

test("Calamity may answer Indians and Duel with Missed as BANG without spending turn quota", () => {
  const state = initialState();
  assignCharacter(state, TARGET_ID, "calamity_janet");
  const indiansId = cardIdsOfType(state, "indians")[0]!;
  const duelId = cardIdsOfType(state, "duel")[0]!;
  const missedId = cardIdsOfType(state, "missed")[0]!;
  const initiatorBangId = cardIdsOfType(state, "bang")[0]!;
  setHands(state, {
    [ACTOR_ID]: [indiansId, duelId],
    [TARGET_ID]: [missedId],
  });

  const indiansHook: CardSubstitutionHookInput = {
    kind: "card_substitution_query",
    card: { cardInstanceId: missedId, physicalCardTypeId: "missed", effectCardTypeId: "bang" },
    context: {
      kind: "indians_response",
      interactionId: "interaction-indians",
      sourcePlayerId: ACTOR_ID,
      sourceCard: { cardInstanceId: indiansId, physicalCardTypeId: "indians", effectCardTypeId: "indians" },
    },
  };
  const indiansQuery = calamityJanetAbility(calamityInput(state, TARGET_ID, indiansHook));
  assert.equal(indiansQuery.allowed, true);
  assert.equal(indiansQuery.bangQuota, "does_not_count");

  const indians = indiansEffect(effectInput(state, ACTOR_ID, indiansId, TARGET_ID));
  assert.equal(indians.kind, "response_required");
  if (indians.kind !== "response_required") return;
  assert.ok(indians.request.responders[0]?.options.some((option) =>
    option.choice === "USE_BANG" && option.payload.cardInstanceId === missedId));
  const indiansResponse = completedResponse(indians, TARGET_ID, "USE_BANG", missedId, "interaction-indians");
  const defended = indiansEffect(effectInput(state, ACTOR_ID, indiansId, TARGET_ID, [indiansResponse]));
  assert.equal(defended.kind, "applied");
  if (defended.kind === "applied") {
    assert.equal(defended.events[1]?.type, "INDIANS_DEFENDED");
    assert.equal(defended.events[1]?.payload.convertedFromMissed, true);
    assert.deepEqual(defended.steps, []);
  }

  const duelHook: CardSubstitutionHookInput = {
    kind: "card_substitution_query",
    card: { cardInstanceId: missedId, physicalCardTypeId: "missed", effectCardTypeId: "bang" },
    context: {
      kind: "duel_response",
      interactionId: "interaction-duel",
      duelInitiatorPlayerId: ACTOR_ID,
      sourceCard: { cardInstanceId: duelId, physicalCardTypeId: "duel", effectCardTypeId: "duel" },
    },
  };
  const duelQuery = calamityJanetAbility(calamityInput(state, TARGET_ID, duelHook));
  assert.equal(duelQuery.allowed, true);
  assert.equal(duelQuery.bangQuota, "does_not_count");

  const duel = duelEffect(effectInput(state, ACTOR_ID, duelId, TARGET_ID));
  assert.equal(duel.kind, "response_required");
  if (duel.kind !== "response_required") return;
  assert.ok(duel.request.responders[0]?.options.some((option) =>
    option.choice === "PLAY_BANG" && option.payload.cardInstanceId === missedId));
  const duelResponse = completedResponse(duel, TARGET_ID, "PLAY_BANG", missedId, "interaction-duel");
  const resumedDuel = duelEffect(effectInput(state, ACTOR_ID, duelId, TARGET_ID, [duelResponse]));
  assert.equal(resumedDuel.kind, "applied");
  if (resumedDuel.kind === "applied") {
    assert.ok(resumedDuel.events.some((entry) =>
      entry.type === "DUEL_BANG_PLAYED" && entry.payload.cardType === "missed" && entry.payload.asCardType === "bang"));
    assert.deepEqual(resumedDuel.steps[0]?.payload, {
      amount: 1,
      cause: "DUEL",
      duelInitiatorPlayerId: ACTOR_ID,
    });
  }
  assert.equal(state.turn.bangCardPlaysThisTurn, 0);
});

test("Calamity converts Missed for Indians, but a forged physical/effect pair or wrong character is denied", () => {
  const state = initialState();
  assignCharacter(state, ACTOR_ID, "calamity_janet");
  const missedId = cardIdsOfType(state, "missed")[0]!;
  const bangId = cardIdsOfType(state, "bang")[0]!;
  setHands(state, { [ACTOR_ID]: [missedId], [TARGET_ID]: [bangId] });
  const before = structuredClone(state);
  const attackCard = attackReference(state, bangId);
  const valid: CardSubstitutionHookInput = {
    kind: "card_substitution_query",
    card: { cardInstanceId: missedId, physicalCardTypeId: "missed", effectCardTypeId: "bang" },
    context: {
      kind: "indians_response",
      interactionId: "interaction-indians-valid",
      sourcePlayerId: TARGET_ID,
      sourceCard: {
        cardInstanceId: cardIdsOfType(state, "indians")[0]!,
        physicalCardTypeId: "indians",
        effectCardTypeId: "indians",
      },
    },
  };
  const input = calamityInput(state, ACTOR_ID, valid);
  const first = calamityJanetAbility(input);
  const second = calamityJanetAbility(input);
  assert.deepEqual(first, second);
  assert.equal(first.allowed, true);
  assert.deepEqual(state, before);

  const forged = {
    ...valid,
    card: { cardInstanceId: bangId, physicalCardTypeId: "bang", effectCardTypeId: "bang" },
    context: {
      kind: "bang_response",
      interactionId: "interaction-forged-pair",
      attackerPlayerId: TARGET_ID,
      attackCard,
    },
  } as unknown as CardSubstitutionHookInput;
  assert.equal(calamityJanetAbility(calamityInput(state, ACTOR_ID, forged)).allowed, false);

  assignCharacter(state, ACTOR_ID, "bart_cassidy");
  assert.equal(calamityJanetAbility(calamityInput(state, ACTOR_ID, valid)).allowed, false);
});
