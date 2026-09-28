import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import type { EngineCommand } from "../../../src/commands/index.ts";
import { applyMatchCommand } from "../../../src/commands/index.ts";
import { bangEffect, beerEffect } from "../../../src/effects/cards/basic-actions.ts";
import type { CharacterAbilityInput, CharacterAbilityModule } from "../../../src/effects/character-api.ts";
import { createEffectCommandHandlers } from "../../../src/effects/runtime/index.ts";
import { sidKetchumAbility } from "../../../src/effects/characters/sid-ketchum.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { GameState } from "../../../src/state/types.ts";

function fixedRandom(): RandomSource {
  let cursor = 0;
  return { nextFloat: () => ((cursor++ * 67 + 11) % 997) / 997 };
}

function makeState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({ playerId: `player-${index + 1}`, displayName: `Player ${index + 1}` }));
  const state = initializeGame({ players, random: fixedRandom() });
  state.turn.currentPlayerId = state.seats[0]!.public.playerId;
  state.turn.phase = "play";
  const characters = ["sid_ketchum", "bart_cassidy", "suzy_lafayette", "willy_the_kid"];
  state.seats.forEach((seat, index) => { seat.public.characterId = characters[index]!; });
  return state;
}

function cardType(state: GameState, cardInstanceId: string): string | undefined {
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  return instance && BASE_PHYSICAL_CARDS.find((card) => card.definitionId === instance.cardDefinitionId)?.typeId;
}

function cardLocationCount(state: GameState, cardInstanceId: string): number {
  let count = 0;
  const countIn = (ids: readonly string[]) => { count += ids.filter((id) => id === cardInstanceId).length; };
  for (const seat of state.seats) {
    countIn(seat.private.handCardInstanceIds);
    countIn(seat.public.inPlayCardInstanceIds);
  }
  countIn(state.zones.drawPileCardInstanceIds);
  countIn(state.zones.discardPileCardInstanceIds);
  countIn(state.zones.revealedPoolCardInstanceIds);
  return count;
}

function removeFromEveryZone(state: GameState, cardInstanceId: string): void {
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
}

function resetHandToDrawPile(state: GameState, playerId: string): void {
  const seat = state.seats.find((candidate) => candidate.public.playerId === playerId);
  assert.ok(seat);
  const hand = [...seat.private.handCardInstanceIds];
  seat.private.handCardInstanceIds = [];
  for (const cardInstanceId of hand) removeFromEveryZone(state, cardInstanceId);
  state.zones.drawPileCardInstanceIds = [...hand, ...state.zones.drawPileCardInstanceIds];
}

function moveCardToHand(state: GameState, typeId: string, playerId: string): string {
  const card = Object.values(state.zones.cardsByInstanceId).find((candidate) =>
    BASE_PHYSICAL_CARDS.some((definition) => definition.definitionId === candidate.cardDefinitionId && definition.typeId === typeId) &&
    cardLocationCount(state, candidate.cardInstanceId) === 1,
  );
  assert.ok(card, `fixture needs a ${typeId} card`);
  removeFromEveryZone(state, card.cardInstanceId);
  const owner = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(owner);
  owner.private.handCardInstanceIds.push(card.cardInstanceId);
  return card.cardInstanceId;
}

function runtimeOptions(sidModule: CharacterAbilityModule<"sid_ketchum"> = sidKetchumAbility) {
  let serial = 0;
  return {
    registry: {
      cards: { bang: bangEffect, beer: beerEffect },
      characters: { sid_ketchum: sidModule },
    },
    nextInteractionIdentity: () => ({
      interactionId: `sid-runtime-${++serial}`,
      createdAt: `2026-09-28T00:00:${String(serial).padStart(2, "0")}.000Z`,
    }),
  };
}

function ability(cardInstanceIds: readonly string[]): EngineCommand {
  return { type: "USE_ABILITY", payload: { abilityId: "sid-ketchum", cardInstanceIds: [...cardInstanceIds] } };
}

function playBang(cardInstanceId: string, targetPlayerId: string): EngineCommand {
  return { type: "PLAY_CARD", payload: { cardInstanceId, targetPlayerId } };
}

function response(interactionId: string, choice: "TAKE_HIT" | "USE_SID", cardInstanceIds?: readonly string[]): EngineCommand {
  return {
    type: "RESPOND",
    payload: {
      interactionId,
      choice,
      ...(cardInstanceIds ? { cardInstanceIds: [...cardInstanceIds] } : {}),
    } as Extract<EngineCommand, { type: "RESPOND" }>["payload"],
  };
}

function directInput(state: GameState, cardInstanceIds: readonly [string, string]): CharacterAbilityInput<"sid_ketchum"> {
  const actor = state.seats[0]!;
  return {
    characterId: "sid_ketchum",
    playerId: actor.public.playerId,
    state,
    continuationFrameId: "sid-direct-frame",
    random: { nextFloat: () => { throw new Error("Sid must not consume randomness"); } },
    completedInteractions: [],
    hook: {
      kind: "sid_ability_use",
      abilityId: "sid-ketchum",
      window: { kind: "play_phase" },
      costCardInstanceIds: cardInstanceIds,
    },
  };
}

test("Sid direct module returns only a capped heal step for a valid play-phase hook", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  actor.public.hp = 3;
  actor.public.maxHp = 4;
  resetHandToDrawPile(state, actor.public.playerId);
  const costs = [moveCardToHand(state, "bang", actor.public.playerId), moveCardToHand(state, "panic", actor.public.playerId)] as const;
  const before = structuredClone(state);

  const result = sidKetchumAbility(directInput(state, costs));
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") return;
  assert.deepEqual(result.events, [{
    type: "PLAYER_HEALED",
    actorPlayerId: actor.public.playerId,
    payload: { targetPlayerId: actor.public.playerId, amount: 1, cause: "SID" },
  }]);
  assert.equal(result.steps.length, 1);
  assert.deepEqual(result.steps[0], {
    effectId: "sid-direct-frame:sid-ketchum:heal",
    kind: "HEAL_PLAYER",
    sourcePlayerId: actor.public.playerId,
    targetPlayerId: actor.public.playerId,
    sourceCardInstanceId: null,
    payload: { amount: 1, cause: "SID" },
  });
  assert.equal(result.events.some((event) => event.type === "CARD_DISCARDED"), false);
  assert.deepEqual(state, before);

  const duplicateCost = directInput(state, [costs[0], costs[0]]);
  const rejected = sidKetchumAbility(duplicateCost);
  assert.deepEqual(rejected, { kind: "applied", events: [], steps: [] });
});

test("Sid can spend two exact hand cards repeatedly and never exceed max HP", () => {
  let state = makeState();
  const actor = state.seats[0]!;
  actor.public.hp = 2;
  actor.public.maxHp = 4;
  state.turn.currentPlayerId = actor.public.playerId;
  resetHandToDrawPile(state, actor.public.playerId);
  const costs = [
    moveCardToHand(state, "bang", actor.public.playerId),
    moveCardToHand(state, "missed", actor.public.playerId),
    moveCardToHand(state, "beer", actor.public.playerId),
    moveCardToHand(state, "panic", actor.public.playerId),
  ];
  const handlers = createEffectCommandHandlers(runtimeOptions());
  const first = applyMatchCommand(state, actor.public.playerId, ability(costs.slice(0, 2)), { handlers, random: fixedRandom() });
  assert.equal(first.ok, true, first.ok ? undefined : `${first.error.code}: ${first.error.message}`);
  if (!first.ok) return;
  state = first.state;
  assert.equal(state.seats[0]!.public.hp, 3);
  assert.deepEqual(state.seats[0]!.private.handCardInstanceIds, costs.slice(2));
  assert.deepEqual(first.events.filter((event) => event.type === "CARD_DISCARDED").map((event) => event.payload.cardInstanceId), costs.slice(0, 2));

  const second = applyMatchCommand(state, actor.public.playerId, ability(costs.slice(2, 4)), { handlers, random: fixedRandom() });
  assert.equal(second.ok, true, second.ok ? undefined : `${second.error.code}: ${second.error.message}`);
  if (!second.ok) return;
  state = second.state;
  assert.equal(state.seats[0]!.public.hp, 4);
  assert.ok(state.seats[0]!.public.hp <= state.seats[0]!.public.maxHp);
  assert.deepEqual(state.seats[0]!.private.handCardInstanceIds, []);
  assert.deepEqual(second.events.filter((event) => event.type === "CARD_DISCARDED").map((event) => event.payload.cardInstanceId), costs.slice(2, 4));
  assert.equal(state.zones.discardPileCardInstanceIds.filter((id) => costs.includes(id)).length, 4);

  const overdraw = applyMatchCommand(state, actor.public.playerId, ability(costs.slice(0, 2)), { handlers, random: fixedRandom() });
  assert.equal(overdraw.ok, false);
  if (!overdraw.ok) assert.equal(overdraw.error.code, "INVALID_ABILITY_COST");
});

test("T14 refuses Sid use while another card resolution is awaiting a response", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const target = state.seats[1]!;
  actor.public.hp = 2;
  actor.public.maxHp = 4;
  resetHandToDrawPile(state, actor.public.playerId);
  const costs = [moveCardToHand(state, "beer", actor.public.playerId), moveCardToHand(state, "panic", actor.public.playerId)];
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  let sidInvocations = 0;
  const instrumentedSid: CharacterAbilityModule<"sid_ketchum"> = (input) => {
    sidInvocations += 1;
    return sidKetchumAbility(input);
  };
  const handlers = createEffectCommandHandlers(runtimeOptions(instrumentedSid));
  const opened = applyMatchCommand(state, actor.public.playerId, playBang(bangId, target.public.playerId), { handlers, random: fixedRandom() });
  assert.equal(opened.ok, true, opened.ok ? undefined : `${opened.error.code}: ${opened.error.message}`);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");

  const attempted = applyMatchCommand(opened.state, actor.public.playerId, ability(costs), { handlers, random: fixedRandom() });
  assert.equal(attempted.ok, false);
  if (!attempted.ok) assert.equal(attempted.error.code, "RESOLUTION_PENDING");
  assert.equal(sidInvocations, 0);
});

test("Sid is the only death-rescue responder and can rescue at two living players", () => {
  const state = makeState();
  const source = state.seats[0]!;
  const sid = state.seats[1]!;
  source.public.characterId = "bart_cassidy";
  sid.public.characterId = "sid_ketchum";
  source.private.roleId = "sheriff";
  sid.private.roleId = "outlaw";
  source.public.roleRevealed = true;
  source.public.hp = source.public.maxHp;
  sid.public.hp = 1;
  sid.public.maxHp = 4;
  for (const seat of state.seats.slice(2)) {
    seat.public.eliminated = true;
    seat.public.hp = 0;
  }
  resetHandToDrawPile(state, sid.public.playerId);
  const costs = [moveCardToHand(state, "beer", sid.public.playerId), moveCardToHand(state, "panic", sid.public.playerId)];
  const bangId = moveCardToHand(state, "bang", source.public.playerId);
  const handlers = createEffectCommandHandlers(runtimeOptions());

  const opened = applyMatchCommand(state, source.public.playerId, playBang(bangId, sid.public.playerId), { handlers, random: fixedRandom() });
  assert.equal(opened.ok, true, opened.ok ? undefined : `${opened.error.code}: ${opened.error.message}`);
  if (!opened.ok) return;
  const attack = opened.state.resolution.pendingInteraction;
  assert.equal(attack?.kind, "BANG_RESPONSE");
  assert.equal(attack?.actorPlayerIds[0], sid.public.playerId);

  const hit = applyMatchCommand(opened.state, sid.public.playerId, response(attack!.interactionId, "TAKE_HIT"), { handlers, random: fixedRandom() });
  assert.equal(hit.ok, true, hit.ok ? undefined : `${hit.error.code}: ${hit.error.message}`);
  if (!hit.ok) return;
  assert.equal(hit.state.resolution.pendingDeath?.consequenceStage, "rescue");
  const rescue = hit.state.resolution.pendingInteraction;
  assert.equal(rescue?.kind, "DEATH_RESCUE");
  assert.equal(rescue?.actorPlayerIds[0], sid.public.playerId);
  assert.equal(rescue?.options.some((option) => option.choice === "USE_BEER"), false);
  assert.ok(rescue?.options.some((option) => option.choice === "USE_SID" &&
    JSON.stringify(option.payload.cardInstanceIds) === JSON.stringify(costs)));

  const forgedResponder = applyMatchCommand(hit.state, source.public.playerId, response(rescue!.interactionId, "USE_SID", costs), { handlers, random: fixedRandom() });
  assert.equal(forgedResponder.ok, false);
  if (!forgedResponder.ok) assert.equal(forgedResponder.error.code, "WRONG_RESPONDER");

  const rescued = applyMatchCommand(hit.state, sid.public.playerId, response(rescue!.interactionId, "USE_SID", costs), { handlers, random: fixedRandom() });
  assert.equal(rescued.ok, true, rescued.ok ? undefined : `${rescued.error.code}: ${rescued.error.message}`);
  if (!rescued.ok) return;
  const savedSid = rescued.state.seats.find((seat) => seat.public.playerId === sid.public.playerId)!;
  assert.equal(savedSid.public.hp, 1);
  assert.equal(savedSid.public.eliminated, false);
  assert.equal(rescued.state.resolution.pendingDeath, null);
  assert.equal(rescued.state.resolution.pendingInteraction, null);
  assert.equal(rescued.state.resolution.effectQueue.length, 0);
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(costs[0]));
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(costs[1]));
  assert.deepEqual(rescued.events.filter((event) => event.type === "CARD_DISCARDED").map((event) => event.payload.cardInstanceId), costs);
  assert.ok(rescued.events.some((event) => event.type === "PLAYER_HEALED" && event.payload.cause === "SID"));
});
