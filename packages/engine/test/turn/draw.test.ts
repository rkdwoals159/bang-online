import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../catalog/src/cards/index.ts";
import { projectMatchSnapshot } from "../../src/state/projection.ts";
import { submitInteractionResponse } from "../../src/resolution/index.ts";
import { applyMatchCommand } from "../../src/commands/index.ts";
import { createEffectCommandHandlers, type EffectRuntimeOptions } from "../../src/effects/runtime/index.ts";
import { initializeGame, type SetupPlayer } from "../../src/setup/initialize.ts";
import type { GameState } from "../../src/state/types.ts";
import type { RandomSource } from "../../src/random/shuffle.ts";
import type { InteractionIdentity } from "../../src/effects/runtime/index.ts";
import { executeTurnDraw, resolveTurnStart, withTurnStartEffects } from "../../src/turn/draw.ts";

const ACTOR = "player-1";

function fixedRandom(values: readonly number[] = [0.25]): RandomSource {
  let cursor = 0;
  return { nextFloat: () => values[cursor++] ?? values.at(-1) ?? 0.25 };
}

function makeState(characterId = "paul_regret", phase: "start" | "draw" = "draw"): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: fixedRandom([0.17, 0.61, 0.32]) });
  state.turn.currentPlayerId = ACTOR;
  state.turn.phase = phase;
  state.seats.find((seat) => seat.public.playerId === ACTOR)!.public.characterId = characterId;
  return state;
}

function actorSeat(state: GameState) {
  return state.seats.find((seat) => seat.public.playerId === ACTOR)!;
}

function typeId(state: GameState, cardInstanceId: string): string | undefined {
  const card = state.zones.cardsByInstanceId[cardInstanceId];
  return BASE_PHYSICAL_CARDS.find((definition) => definition.definitionId === card?.cardDefinitionId)?.typeId;
}

function moveCard(state: GameState, cardInstanceId: string, to: "hand" | "in_play" | "discard", playerId = ACTOR): void {
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  if (to === "discard") state.zones.discardPileCardInstanceIds.push(cardInstanceId);
  else {
    const owner = state.seats.find((seat) => seat.public.playerId === playerId);
    assert.ok(owner);
    if (to === "hand") owner.private.handCardInstanceIds.push(cardInstanceId);
    else owner.public.inPlayCardInstanceIds.push(cardInstanceId);
  }
}

function moveTopCards(state: GameState, count: number, playerId: string): string[] {
  const ids = state.zones.drawPileCardInstanceIds.slice(0, count);
  for (const id of ids) moveCard(state, id!, "hand", playerId);
  return ids;
}

function setDrawTop(state: GameState, ids: readonly string[]): void {
  const selected = new Set(ids);
  state.zones.drawPileCardInstanceIds = [...ids, ...state.zones.drawPileCardInstanceIds.filter((id) => !selected.has(id))];
}

function cardInDrawWithSuit(state: GameState, suit: "HEARTS" | "DIAMONDS"): string {
  const cardInstanceId = state.zones.drawPileCardInstanceIds.find((id) => state.zones.cardsByInstanceId[id]?.suit === suit);
  assert.ok(cardInstanceId, `fixture needs a ${suit} draw-pile card`);
  return cardInstanceId;
}

function assertBaseDeckInvariant(state: GameState): void {
  const allIds = [
    ...state.seats.flatMap((seat) => [...seat.private.handCardInstanceIds, ...seat.public.inPlayCardInstanceIds]),
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
  ];
  assert.equal(allIds.length, 80);
  assert.equal(new Set(allIds).size, 80);
  assert.deepEqual(new Set(allIds), new Set(Object.keys(state.zones.cardsByInstanceId)));
}

function nextIdentity(): () => InteractionIdentity {
  let serial = 0;
  return () => ({ interactionId: `draw-interaction-${++serial}`, createdAt: `2026-09-28T00:00:${String(serial).padStart(2, "0")}.000Z` });
}

function startRuntimeOptions(): EffectRuntimeOptions {
  return { registry: { cards: {} }, nextInteractionIdentity: nextIdentity() };
}

function successful(result: ReturnType<typeof executeTurnDraw> | ReturnType<typeof resolveTurnStart>): GameState {
  assert.equal(result.ok, true, result.ok ? undefined : `${result.error.code}: ${result.error.message}`);
  if (!result.ok) throw new Error(result.error.message);
  return result.output.state;
}

test("normal turn draw takes the first two deck cards and leaves its input unchanged", () => {
  const state = makeState();
  const before = structuredClone(state);
  const topTwo = state.zones.drawPileCardInstanceIds.slice(0, 2);
  const originalHand = [...actorSeat(state).private.handCardInstanceIds];
  const result = executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() });

  const next = successful(result);
  assert.deepEqual(actorSeat(next).private.handCardInstanceIds, [...originalHand, ...topTwo]);
  assert.equal(next.turn.phase, "play");
  assert.deepEqual(state, before);
  assertBaseDeckInvariant(next);
  const replay = executeTurnDraw({ state: structuredClone(before), actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() });
  assert.deepEqual(replay, result);
});

test("Jesse keeps the first-slot source private and resumes to one hand steal plus the second deck slot", () => {
  const state = makeState("jesse_jones");
  const originalActorHand = [...actorSeat(state).private.handCardInstanceIds];
  const sourceIds = moveTopCards(state, 2, "player-2");
  const random = fixedRandom([0.75]);
  const pendingResult = executeTurnDraw({ state, actorPlayerId: ACTOR, random, nextInteractionIdentity: nextIdentity() });
  const pendingState = successful(pendingResult);
  const pending = pendingState.resolution.pendingInteraction;
  assert.ok(pending);
  assert.deepEqual(pending.actorPlayerIds, [ACTOR]);
  assert.equal(pending.options.some((option) => JSON.stringify(option.payload).includes(sourceIds[0]!) || JSON.stringify(option.payload).includes(sourceIds[1]!)), false);
  assert.ok(pending.options.some((option) => option.payload.sourcePlayerId === "player-2"));

  const actorView = projectMatchSnapshot(pendingState, ACTOR, BASE_PHYSICAL_CARDS);
  const otherView = projectMatchSnapshot(pendingState, "player-3", BASE_PHYSICAL_CARDS);
  assert.ok(actorView.pendingInteraction);
  assert.deepEqual(otherView.pendingInteraction, {
    interactionId: pending.interactionId,
    kind: "JESSE_DRAW_SOURCE",
    allowedChoices: [],
    currentResponderPlayerId: ACTOR,
    step: { current: 1, total: 1 },
  });
  assert.equal(JSON.stringify(otherView).includes(sourceIds[0]!), false);
  assert.equal(JSON.stringify(otherView).includes(sourceIds[1]!), false);

  const option = pending.options.find((candidate) => candidate.choice === "TAKE_FROM_HAND" && candidate.payload.sourcePlayerId === "player-2");
  assert.ok(option);
  const response = submitInteractionResponse(pendingState, {
    interactionId: pending.interactionId,
    actorPlayerId: ACTOR,
    choice: option.choice,
    payload: option.payload,
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;

  const resumedResult = executeTurnDraw({ state: response.state, actorPlayerId: ACTOR, random, nextInteractionIdentity: nextIdentity() });
  const next = successful(resumedResult);
  const gained = actorSeat(next).private.handCardInstanceIds.filter((id) => !originalActorHand.includes(id));
  assert.equal(gained.length, 2);
  assert.ok(sourceIds.includes(gained[0]!));
  assert.equal(next.seats.find((seat) => seat.public.playerId === "player-2")!.private.handCardInstanceIds.length, 5);
  assert.equal(next.turn.phase, "play");
  assertBaseDeckInvariant(next);
});

test("Lucky does not replace either ordinary turn draw slot with a judgment", () => {
  const state = makeState("lucky_duke");
  const topTwo = state.zones.drawPileCardInstanceIds.slice(0, 2);
  const result = executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() });
  const next = successful(result);

  assert.equal(next.resolution.pendingInteraction, null);
  assert.deepEqual(actorSeat(next).private.handCardInstanceIds.slice(-2), topTwo);
  assert.deepEqual(next.zones.revealedPoolCardInstanceIds, []);
  assert.equal(result.ok && result.output.events.some((event) => event.type === "LUCKY_DRAW" || event.type.endsWith("_JUDGMENT_REVEALED")), false);
  assertBaseDeckInvariant(next);
});

test("Jesse has no source prompt when every other hand is empty", () => {
  const state = makeState("jesse_jones");
  for (const seat of state.seats) {
    if (seat.public.playerId === ACTOR) continue;
    for (const cardInstanceId of [...seat.private.handCardInstanceIds]) moveCard(state, cardInstanceId, "discard");
  }
  const topTwo = state.zones.drawPileCardInstanceIds.slice(0, 2);
  const originalHand = [...actorSeat(state).private.handCardInstanceIds];
  const next = successful(executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() }));

  assert.equal(next.resolution.pendingInteraction, null);
  assert.deepEqual(actorSeat(next).private.handCardInstanceIds, [...originalHand, ...topTwo]);
  assert.equal(next.turn.phase, "play");
  assertBaseDeckInvariant(next);
});

test("Pedro may replace only the first slot with the discard top", () => {
  const state = makeState("pedro_ramirez");
  const originalHand = [...actorSeat(state).private.handCardInstanceIds];
  const discardTop = state.zones.drawPileCardInstanceIds.at(-1)!;
  moveCard(state, discardTop, "discard");
  const deckSecond = state.zones.drawPileCardInstanceIds[0]!;
  const pending = successful(executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() }));
  const interaction = pending.resolution.pendingInteraction;
  assert.ok(interaction);
  assert.deepEqual(interaction.actorPlayerIds, [ACTOR]);
  const option = interaction.options.find((candidate) => candidate.choice === "SELECT_SOURCE" && candidate.payload.source === "DISCARD_TOP");
  assert.ok(option);
  const response = submitInteractionResponse(pending, {
    interactionId: interaction.interactionId,
    actorPlayerId: ACTOR,
    choice: option.choice,
    payload: option.payload,
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;

  const next = successful(executeTurnDraw({ state: response.state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() }));
  const gained = actorSeat(next).private.handCardInstanceIds.filter((id) => !originalHand.includes(id));
  assert.deepEqual(gained, [discardTop, deckSecond]);
  assert.equal(next.zones.discardPileCardInstanceIds.includes(discardTop), false);
  assert.equal(next.turn.phase, "play");
  assertBaseDeckInvariant(next);
});

test("Kit's candidate choice is actor-only and returns the unchosen third card to the deck top", () => {
  const state = makeState("kit_carlson");
  const originalHand = [...actorSeat(state).private.handCardInstanceIds];
  const candidates = state.zones.drawPileCardInstanceIds.slice(0, 3);
  const result = executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() });
  const pendingState = successful(result);
  const pending = pendingState.resolution.pendingInteraction;
  assert.ok(pending);
  assert.deepEqual(pending.actorPlayerIds, [ACTOR]);
  assert.deepEqual(pendingState.zones.revealedPoolCardInstanceIds, candidates);
  const opponentView = projectMatchSnapshot(pendingState, "player-2", BASE_PHYSICAL_CARDS);
  assert.deepEqual(opponentView.pendingInteraction, {
    interactionId: pending.interactionId,
    kind: "KIT_CARLSON_PICK",
    allowedChoices: [],
    currentResponderPlayerId: ACTOR,
    step: { current: 1, total: 1 },
  });
  assert.equal(candidates.some((id) => JSON.stringify(opponentView).includes(id)), false);
  assertBaseDeckInvariant(pendingState);

  const option = pending.options.find((candidate) => {
    const ids = candidate.payload.selectedCardInstanceIds;
    return Array.isArray(ids) && ids.includes(candidates[0]!) && ids.includes(candidates[1]!);
  });
  assert.ok(option);
  const response = submitInteractionResponse(pendingState, {
    interactionId: pending.interactionId,
    actorPlayerId: ACTOR,
    choice: option.choice,
    payload: option.payload,
  });
  assert.equal(response.ok, true);
  if (!response.ok) return;

  const completed = successful(executeTurnDraw({ state: response.state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() }));
  assert.equal(completed.turn.phase, "play");
  assert.deepEqual(actorSeat(completed).private.handCardInstanceIds, [...originalHand, candidates[0], candidates[1]]);
  assert.equal(completed.zones.drawPileCardInstanceIds[0], candidates[2]);
  assert.equal(completed.zones.revealedPoolCardInstanceIds.length, 0);
  assertBaseDeckInvariant(completed);
});

test("Kit pauses cleanly when fewer than three candidates exist and returns every peeked card", () => {
  const state = makeState("kit_carlson");
  const remaining = state.zones.drawPileCardInstanceIds.slice(0, 2);
  const rest = state.zones.drawPileCardInstanceIds.slice(2);
  state.zones.drawPileCardInstanceIds = remaining;
  actorSeat(state).private.handCardInstanceIds.push(...rest);
  const next = successful(executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() }));

  assert.equal(next.status, "paused");
  assert.equal(next.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.equal(next.turn.phase, "draw");
  assert.deepEqual(next.zones.drawPileCardInstanceIds, remaining);
  assert.equal(next.zones.revealedPoolCardInstanceIds.length, 0);
  assert.equal(next.resolution.effectQueue.length, 0);
  assertBaseDeckInvariant(next);
});

test("R08 reshuffle uses the injected RNG and preserves all cards", () => {
  const state = makeState();
  state.zones.discardPileCardInstanceIds.push(...state.zones.drawPileCardInstanceIds);
  state.zones.drawPileCardInstanceIds = [];
  const randomValues = [0.91, 0.12, 0.72, 0.32, 0.62, 0.02, 0.52, 0.42, 0.22, 0.82];
  const first = executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(randomValues), nextInteractionIdentity: nextIdentity() });
  const replay = executeTurnDraw({ state: structuredClone(state), actorPlayerId: ACTOR, random: fixedRandom(randomValues), nextInteractionIdentity: nextIdentity() });
  assert.deepEqual(replay, first);
  const next = successful(first);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.output.events.filter((event) => event.type === "DRAW_PILE_RESHUFFLED").length, 1);
  assertBaseDeckInvariant(next);
});

test("Black Jack exposes only the second ordinary card and performs one private red-card bonus draw", () => {
  const state = makeState("black_jack");
  const originalHandCount = actorSeat(state).private.handCardInstanceIds.length;
  const redId = cardInDrawWithSuit(state, "HEARTS");
  const firstId = state.zones.drawPileCardInstanceIds.find((id) => id !== redId)!;
  setDrawTop(state, [firstId, redId]);
  const result = executeTurnDraw({ state, actorPlayerId: ACTOR, random: fixedRandom(), nextInteractionIdentity: nextIdentity() });
  const next = successful(result);
  assert.ok(result.ok);
  if (!result.ok) return;
  const drawEvents = result.output.events.filter((event) => event.type === "CARD_DRAWN");
  assert.equal(drawEvents.length, 3);
  assert.equal(drawEvents[0]!.payload.cardInstanceId, firstId);
  assert.equal(drawEvents[1]!.payload.cardInstanceId, redId);
  assert.equal(drawEvents[1]!.payload.visibility, "public");
  assert.equal(drawEvents[1]!.payload.suit, "HEARTS");
  assert.equal(drawEvents[2]!.payload.visibility, undefined);
  assert.equal(actorSeat(next).private.handCardInstanceIds.length, originalHandCount + 3);
  assert.equal(next.turn.phase, "play");
  assertBaseDeckInvariant(next);
});

test("turn start resolves Dynamite before Jail and enters draw only after both finish", () => {
  const state = makeState("paul_regret", "start");
  actorSeat(state).private.roleId = "outlaw";
  const dynamiteId = Object.keys(state.zones.cardsByInstanceId).find((id) => typeId(state, id) === "dynamite")!;
  const jailId = Object.keys(state.zones.cardsByInstanceId).find((id) => typeId(state, id) === "jail")!;
  assert.ok(dynamiteId);
  assert.ok(jailId);
  moveCard(state, dynamiteId, "in_play", ACTOR);
  moveCard(state, jailId, "in_play", ACTOR);
  const safeDynamite = cardInDrawWithSuit(state, "HEARTS");
  const safeJail = state.zones.drawPileCardInstanceIds.find((id) => id !== safeDynamite && state.zones.cardsByInstanceId[id]?.suit === "HEARTS")!;
  setDrawTop(state, [safeDynamite, safeJail]);

  const result = resolveTurnStart({
    state,
    actorPlayerId: ACTOR,
    random: fixedRandom(),
    nextInteractionIdentity: nextIdentity(),
    runtimeOptions: startRuntimeOptions(),
  });
  const next = successful(result);
  assert.equal(next.turn.phase, "draw");
  const passed = result.ok ? result.output.events.findIndex((event) => event.type === "DYNAMITE_PASSED") : -1;
  const jailed = result.ok ? result.output.events.findIndex((event) => event.type === "JAIL_JUDGMENT_RESOLVED") : -1;
  assert.ok(passed >= 0 && jailed > passed);
  assert.ok(next.seats.find((seat) => seat.public.playerId === "player-2")!.public.inPlayCardInstanceIds.includes(dynamiteId));
  assert.ok(next.zones.discardPileCardInstanceIds.includes(jailId));
  assertBaseDeckInvariant(next);
});

test("Lucky Jail opens a saved top-two judgment choice and resumes before the draw phase", () => {
  const state = makeState("lucky_duke", "start");
  actorSeat(state).private.roleId = "outlaw";
  const jailId = Object.keys(state.zones.cardsByInstanceId).find((id) => typeId(state, id) === "jail")!;
  assert.ok(jailId);
  moveCard(state, jailId, "in_play", ACTOR);
  const nonHeart = state.zones.drawPileCardInstanceIds.find((id) => state.zones.cardsByInstanceId[id]?.suit !== "HEARTS");
  assert.ok(nonHeart, "fixture needs a non-Heart in the draw pile");
  const heart = cardInDrawWithSuit(state, "HEARTS");
  setDrawTop(state, [nonHeart, heart]);
  const runtimeOptions = startRuntimeOptions();
  const handlers = createEffectCommandHandlers(withTurnStartEffects(runtimeOptions));

  const opened = resolveTurnStart({
    state,
    actorPlayerId: ACTOR,
    random: fixedRandom(),
    nextInteractionIdentity: nextIdentity(),
    runtimeOptions,
  });
  const pendingState = successful(opened);
  const pending = pendingState.resolution.pendingInteraction;
  assert.equal(pending?.kind, "LUCKY_DRAW");
  assert.deepEqual(pending?.context.candidateCardInstanceIds, [nonHeart, heart]);
  assert.deepEqual(pendingState.zones.revealedPoolCardInstanceIds, [nonHeart, heart]);
  assert.equal(pending?.options.length, 4);
  assert.equal(pendingState.turn.phase, "start");
  assertBaseDeckInvariant(pendingState);

  const replay = resolveTurnStart({
    state: structuredClone(state),
    actorPlayerId: ACTOR,
    random: fixedRandom(),
    nextInteractionIdentity: nextIdentity(),
    runtimeOptions: startRuntimeOptions(),
  });
  const replayState = successful(replay);
  assert.deepEqual(replayState.resolution.pendingInteraction?.context.candidateCardInstanceIds, [nonHeart, heart]);
  assert.deepEqual(replayState.resolution.pendingInteraction?.options, pending?.options);

  const persisted = JSON.parse(JSON.stringify(pendingState)) as GameState;
  const prompt = persisted.resolution.pendingInteraction!;
  const discardOrder = [nonHeart, heart];
  const option = prompt.options.find((candidate) => candidate.payload.selectedCardInstanceId === heart &&
    JSON.stringify(candidate.payload.orderedCardInstanceIds) === JSON.stringify(discardOrder));
  assert.ok(option);
  const responded = applyMatchCommand(persisted, ACTOR, {
    type: "RESPOND",
    payload: { interactionId: prompt.interactionId, choice: option.choice, ...option.payload },
  }, { handlers, random: fixedRandom() });
  assert.equal(responded.ok, true, responded.ok ? undefined : `${responded.error.code}: ${responded.error.message}`);
  if (!responded.ok) return;
  assert.equal(responded.state.resolution.pendingInteraction, null);
  assert.equal(responded.state.turn.phase, "start");
  assert.deepEqual(responded.state.zones.discardPileCardInstanceIds.slice(-3), [...discardOrder, jailId]);
  assert.equal(responded.events.find((event) => event.type === "JAIL_JUDGMENT_RESOLVED")?.payload.heart, true);
  assertBaseDeckInvariant(responded.state);

  const completed = resolveTurnStart({
    state: responded.state,
    actorPlayerId: ACTOR,
    random: fixedRandom(),
    nextInteractionIdentity: nextIdentity(),
    runtimeOptions,
  });
  assert.equal(successful(completed).turn.phase, "draw");
});

