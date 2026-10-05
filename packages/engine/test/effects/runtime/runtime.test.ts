import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import type { EngineCommand } from "../../../src/commands/index.ts";
import { applyMatchCommand } from "../../../src/commands/index.ts";
import { bangEffect, beerEffect, missedEffect } from "../../../src/effects/cards/basic-actions.ts";
import { duelEffect } from "../../../src/effects/cards/duel.ts";
import { stagecoachEffect } from "../../../src/effects/cards/draw-select.ts";
import { dynamiteStartEffect } from "../../../src/effects/cards/dynamite-barrel.ts";
import { equipmentEffect } from "../../../src/effects/cards/equipment.ts";
import { createEffectRegistry } from "../../../src/effects/registry.ts";
import { jailEffect } from "../../../src/effects/cards/jail.ts";
import { panicEffect, catBalouEffect } from "../../../src/effects/cards/steal-discard.ts";
import { gatlingEffect, indiansEffect, saloonEffect } from "../../../src/effects/cards/tablewide.ts";
import { createEffectCommandHandlers, executeCardEffect, earlyTablewideInteraction, projectTablewideAttack, type EffectRuntimeOptions } from "../../../src/effects/runtime/index.ts";
import { projectMatchSnapshot } from "../../../src/state/projection.ts";
import type { CharacterAbilityModule, DamageResolvedHookInput } from "../../../src/effects/character-api.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { GameState } from "../../../src/state/types.ts";

for (const cardType of ["gatling", "indians"] as const) {
  test(`${cardType}: future targets submit in reverse order, privately and durably, without blocking`, () => {
    const state = makeState();
    state.seats.forEach(seat => { seat.public.characterId = "willy_the_kid"; seat.public.hp = seat.public.maxHp; });
    const [actor, first, second, third] = state.seats;
    const attackCard = moveCardToHand(state, cardType, actor!.public.playerId);
    const responseCards = [second!, third!].map(seat => moveCardToHand(state, cardType === "gatling" ? "missed" : "bang", seat.public.playerId));
    const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
    const opened = applyMatchCommand(state, actor!.public.playerId, playCard(state, actor!.public.playerId, attackCard), commandContext(handlers));
    assert.ok(opened.ok); if (!opened.ok) return;
    let saved = opened.state;
    const firstInteractionId = saved.resolution.pendingInteraction!.interactionId;
    const hpBefore = saved.seats.map(seat => seat.public.hp);
    for (const index of [1, 0]) {
      const target = [second!, third!][index]!;
      const prompt = earlyTablewideInteraction(saved, target.public.playerId)!;
      assert.ok(prompt);
      const choice = cardType === "gatling" ? "USE_MISSED" : "USE_BANG";
      const payload = { interactionId: prompt.interactionId, choice, cardInstanceId: responseCards[index]! };
      const forged = applyMatchCommand(saved, target.public.playerId, { type: "RESPOND", payload: { ...payload, cardInstanceId: attackCard } } as EngineCommand, commandContext(handlers));
      assert.equal(forged.ok, false);
      const submitted = applyMatchCommand(saved, target.public.playerId, { type: "RESPOND", payload } as EngineCommand, commandContext(handlers));
      assert.ok(submitted.ok); if (!submitted.ok) return;
      saved = JSON.parse(JSON.stringify(submitted.state));
      assert.equal(saved.resolution.pendingInteraction!.interactionId, firstInteractionId);
      assert.deepEqual(saved.seats.map(seat => seat.public.hp), hpBefore);
      assert.equal(projectTablewideAttack(saved)!.targets.find(item => item.playerId === target.public.playerId)!.status, "submitted");
      const duplicate = applyMatchCommand(saved, target.public.playerId, { type: "RESPOND", payload } as EngineCommand, commandContext(handlers));
      assert.equal(duplicate.ok, false);
      const observer = JSON.stringify(projectMatchSnapshot(saved, actor!.public.playerId, BASE_PHYSICAL_CARDS));
      assert.equal(observer.includes(responseCards[index]!), false, "reserved card IDs stay private");
    }
    const resolved = applyMatchCommand(saved, first!.public.playerId, respond(saved, firstInteractionId, "TAKE_HIT"), commandContext(handlers));
    assert.ok(resolved.ok); if (!resolved.ok) return;
    assert.equal(resolved.state.resolution.pendingInteraction, null);
    assert.equal(projectTablewideAttack(resolved.state), null);
    assert.equal(resolved.state.seats[1]!.public.hp, hpBefore[1]! - 1);
    for (const index of [0, 1]) assert.equal(resolved.state.seats[index + 2]!.private.handCardInstanceIds.includes(responseCards[index]!), false);
    assertCardZonesComplete(resolved.state);
  });
}

test("early Gatling defense triggers Suzy once at actual card consumption", () => {
  const state = makeState();
  state.seats.forEach(seat => { seat.public.characterId = "willy_the_kid"; seat.public.hp = seat.public.maxHp; });
  const [actor, first, second, suzy] = state.seats;
  suzy!.public.characterId = "suzy_lafayette";
  clearHandToDrawPile(state, suzy!.public.playerId);
  const defense = moveCardToHand(state, "missed", suzy!.public.playerId);
  const attack = moveCardToHand(state, "gatling", actor!.public.playerId);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
  const opened = applyMatchCommand(state, actor!.public.playerId, playCard(state, actor!.public.playerId, attack), commandContext(handlers));
  assert.ok(opened.ok); if (!opened.ok) return;
  const prompt = earlyTablewideInteraction(opened.state, suzy!.public.playerId)!;
  const reserved = applyMatchCommand(opened.state, suzy!.public.playerId, respond(opened.state, prompt.interactionId, "USE_MISSED", defense), commandContext(handlers));
  assert.ok(reserved.ok); if (!reserved.ok) return;
  assert.deepEqual(reserved.state.seats[3]!.private.handCardInstanceIds, [defense]);
  const firstHit = applyMatchCommand(reserved.state, first!.public.playerId, respond(reserved.state, reserved.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.ok(firstHit.ok); if (!firstHit.ok) return;
  const expectedDraw = firstHit.state.zones.drawPileCardInstanceIds[0];
  const secondHit = applyMatchCommand(firstHit.state, second!.public.playerId, respond(firstHit.state, firstHit.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.ok(secondHit.ok); if (!secondHit.ok) return;
  assert.deepEqual(secondHit.state.seats[3]!.private.handCardInstanceIds, [expectedDraw]);
  assertCardZonesComplete(secondHit.state);
});

test("a future target can reserve defense during another player's death rescue", () => {
  const state = makeState();
  state.seats.forEach(seat => { seat.public.characterId = "willy_the_kid"; seat.public.hp = seat.public.maxHp; });
  const [actor, wounded, , future] = state.seats;
  wounded!.public.hp = 1;
  clearHandToDrawPile(state, wounded!.public.playerId);
  moveCardToHand(state, "beer", wounded!.public.playerId);
  const attack = moveCardToHand(state, "gatling", actor!.public.playerId);
  const defense = moveCardToHand(state, "missed", future!.public.playerId);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
  const opened = applyMatchCommand(state, actor!.public.playerId, playCard(state, actor!.public.playerId, attack), commandContext(handlers));
  assert.ok(opened.ok); if (!opened.ok) return;
  const hit = applyMatchCommand(opened.state, wounded!.public.playerId, respond(opened.state, opened.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.ok(hit.ok); if (!hit.ok) return;
  assert.equal(hit.state.resolution.pendingInteraction!.kind, "DEATH_RESCUE");
  const futurePrompt = earlyTablewideInteraction(hit.state, future!.public.playerId);
  assert.ok(futurePrompt);
  const saved = applyMatchCommand(hit.state, future!.public.playerId, respond(hit.state, futurePrompt.interactionId, "USE_MISSED", defense), commandContext(handlers));
  assert.ok(saved.ok); if (!saved.ok) return;
  assert.deepEqual(saved.state.resolution.pendingDeath, hit.state.resolution.pendingDeath);
  assert.equal(saved.state.resolution.pendingInteraction!.interactionId, hit.state.resolution.pendingInteraction!.interactionId);
  assertCardZonesComplete(saved.state);
});

test("an early Barrel failure opens a fresh response and cannot reuse its old choice", () => {
  const state = makeState();
  state.seats.forEach(seat => { seat.public.characterId = "willy_the_kid"; seat.public.hp = seat.public.maxHp; });
  const [actor, first, second, future] = state.seats;
  const attack = moveCardToHand(state, "gatling", actor!.public.playerId);
  moveCardToPlay(state, "barrel", future!.public.playerId);
  const club = state.zones.drawPileCardInstanceIds.find(id => state.zones.cardsByInstanceId[id]!.suit === "CLUBS")!;
  moveCardToDrawTop(state, club);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
  const opened = applyMatchCommand(state, actor!.public.playerId, playCard(state, actor!.public.playerId, attack), commandContext(handlers));
  assert.ok(opened.ok); if (!opened.ok) return;
  const prompt = earlyTablewideInteraction(opened.state, future!.public.playerId)!;
  const reserved = applyMatchCommand(opened.state, future!.public.playerId, respond(opened.state, prompt.interactionId, "USE_BARREL"), commandContext(handlers));
  assert.ok(reserved.ok); if (!reserved.ok) return;
  let current = reserved.state;
  for (const target of [first!, second!]) {
    const result = applyMatchCommand(current, target.public.playerId, respond(current, current.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
    assert.ok(result.ok); if (!result.ok) return;
    current = result.state;
  }
  assert.equal(current.resolution.pendingInteraction!.actorPlayerIds[0], future!.public.playerId);
  assert.notEqual(current.resolution.pendingInteraction!.interactionId, prompt.interactionId);
  assert.equal(current.resolution.pendingInteraction!.options.some(option => option.choice === "USE_BARREL"), false);
  const complete = applyMatchCommand(current, future!.public.playerId, respond(current, current.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.ok(complete.ok); if (!complete.ok) return;
  assert.equal(complete.state.resolution.pendingInteraction, null);
  assertCardZonesComplete(complete.state);
});

function fixedRandom(): RandomSource {
  let cursor = 0;
  return { nextFloat: () => ((cursor++ * 67 + 11) % 997) / 997 };
}

function makeState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({ playerId: `player-${index + 1}`, displayName: `Player ${index + 1}` }));
  const state = initializeGame({ players, random: fixedRandom() });
  state.turn.currentPlayerId = state.seats[0]!.public.playerId;
  state.turn.phase = "play";
  return state;
}

function moveCardToHand(state: GameState, typeId: string, playerId: string): string {
  const matchesType = (cardInstanceId: string) => {
    const candidate = state.zones.cardsByInstanceId[cardInstanceId];
    return candidate && BASE_PHYSICAL_CARDS.some((card) => card.definitionId === candidate.cardDefinitionId && card.typeId === typeId);
  };
  const instanceId = state.zones.drawPileCardInstanceIds.find(matchesType) ??
    Object.values(state.zones.cardsByInstanceId).find((candidate) =>
      BASE_PHYSICAL_CARDS.some((card) => card.definitionId === candidate.cardDefinitionId && card.typeId === typeId),
    )?.cardInstanceId;
  const instance = instanceId ? state.zones.cardsByInstanceId[instanceId] : undefined;
  assert.ok(instance, `fixture needs a ${typeId} card`);
  const id = instance.cardInstanceId;
  removeCardFromZones(state, id);
  const owner = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(owner);
  owner.private.handCardInstanceIds = [...owner.private.handCardInstanceIds, id];
  return id;
}

function removeCardFromZones(state: GameState, cardInstanceId: string): void {
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
}

function clearHandToDrawPile(state: GameState, playerId: string): void {
  const seat = state.seats.find((entry) => entry.public.playerId === playerId);
  assert.ok(seat);
  state.zones.drawPileCardInstanceIds.push(...seat.private.handCardInstanceIds);
  seat.private.handCardInstanceIds = [];
}

function moveCardToDrawTop(state: GameState, cardInstanceId: string): void {
  removeCardFromZones(state, cardInstanceId);
  state.zones.drawPileCardInstanceIds.unshift(cardInstanceId);
}

function cardForFace(state: GameState, suit: string, rank: number | string): string {
  const definition = BASE_PHYSICAL_CARDS.find((card) => card.suit === suit && card.rank === rank);
  assert.ok(definition, `fixture needs ${suit} ${rank}`);
  const instance = Object.values(state.zones.cardsByInstanceId).find((card) => card.cardDefinitionId === definition.definitionId);
  assert.ok(instance);
  return instance.cardInstanceId;
}

function assertCardZonesComplete(state: GameState): void {
  const zoneIds = [
    ...state.zones.drawPileCardInstanceIds,
    ...state.zones.discardPileCardInstanceIds,
    ...state.zones.revealedPoolCardInstanceIds,
    ...state.seats.flatMap((seat) => seat.private.handCardInstanceIds),
    ...state.seats.flatMap((seat) => seat.public.inPlayCardInstanceIds),
  ];
  assert.equal(zoneIds.length, Object.keys(state.zones.cardsByInstanceId).length);
  assert.equal(new Set(zoneIds).size, zoneIds.length);
  assert.deepEqual(new Set(zoneIds), new Set(Object.keys(state.zones.cardsByInstanceId)));
}

function moveCardToPlay(state: GameState, typeId: string, playerId: string): string {
  const id = moveCardToHand(state, typeId, playerId);
  const seat = state.seats.find((candidate) => candidate.public.playerId === playerId)!;
  seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((entry) => entry !== id);
  seat.public.inPlayCardInstanceIds.push(id);
  return id;
}

function runtimeOptions(): EffectRuntimeOptions {
  let serial = 0;
  return {
    registry: {
      cards: {
        bang: bangEffect,
        missed: missedEffect,
        beer: beerEffect,
        panic: panicEffect,
        cat_balou: catBalouEffect,
        gatling: gatlingEffect,
        indians: indiansEffect,
        saloon: saloonEffect,
        duel: duelEffect,
        stagecoach: stagecoachEffect,
        jail: jailEffect,
        mustang: equipmentEffect,
      },
    },
    nextInteractionIdentity: () => ({ interactionId: `runtime-interaction-${++serial}`, createdAt: `2026-09-28T00:00:${String(serial).padStart(2, "0")}.000Z` }),
  };
}

function registeredRuntimeOptions(): EffectRuntimeOptions {
  const options = runtimeOptions();
  return { ...options, registry: createEffectRegistry() };
}

function explodingDynamiteRuntimeOptions(): EffectRuntimeOptions {
  const options = registeredRuntimeOptions();
  return {
    ...options,
    registry: { ...options.registry, cards: { ...options.registry.cards, dynamite: dynamiteStartEffect } },
  };
}

function prepareDynamiteExplosion(state: GameState, targetPlayerId: string): string {
  const dynamiteId = moveCardToPlay(state, "dynamite", targetPlayerId);
  const explosionCardId = cardForFace(state, "SPADES", 2);
  moveCardToDrawTop(state, explosionCardId);
  state.turn.currentPlayerId = targetPlayerId;
  state.turn.phase = "start";
  assertCardZonesComplete(state);
  return dynamiteId;
}

function startDynamiteExplosion(
  state: GameState,
  actorPlayerId: string,
  dynamiteId: string,
  options: EffectRuntimeOptions,
  continuationFrameId: string,
): GameState {
  const started = executeCardEffect({
    state,
    actorPlayerId,
    effectTypeId: "dynamite",
    sourceCardInstanceId: dynamiteId,
    continuationFrameId,
    random: fixedRandom(),
  }, options);
  assert.equal(started.ok, true, started.ok ? undefined : `${started.error.code}: ${started.error.message}`);
  if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
  return started.output.state;
}

function commandContext(handlers: ReturnType<typeof createEffectCommandHandlers>) {
  return { handlers, random: fixedRandom() };
}

function playCard(state: GameState, actorId: string, cardInstanceId: string, targetPlayerId?: string): EngineCommand {
  return {
    type: "PLAY_CARD",
    payload: { cardInstanceId, ...(targetPlayerId ? { targetPlayerId } : {}) },
  };
}

function respond(
  state: GameState,
  interactionId: string,
  choice: "TAKE_HIT" | "USE_BEER" | "YIELD" | "USE_MISSED" | "USE_BARREL" | "USE_JOURDONNAIS",
  cardInstanceId?: string,
): EngineCommand {
  return {
    type: "RESPOND",
    payload: {
      interactionId,
      choice,
      ...(cardInstanceId ? { cardInstanceId } : {}),
    } as Extract<EngineCommand, { type: "RESPOND" }>['payload'],
  };
}

test("BANG response persists as JSON, applies the hit, and closes its continuation", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const handlers = createEffectCommandHandlers(runtimeOptions());

  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
  assert.ok(opened.state.zones.discardPileCardInstanceIds.includes(bangId));

  const persisted = JSON.parse(JSON.stringify(opened.state)) as GameState;
  const interactionId = persisted.resolution.pendingInteraction!.interactionId;
  const hit = applyMatchCommand(persisted, target.public.playerId, respond(persisted, interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  assert.equal(hit.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, target.public.hp - 1);
  assert.equal(hit.state.resolution.pendingInteraction, null);
  assert.equal(hit.state.resolution.effectQueue.length, 0);
  assert.ok(hit.events.some((event) => event.type === "PLAYER_DAMAGED" && event.payload.hpLost === 1));
});

test("Slab physical BANG saves a second response after one Missed and applies TAKE_HIT after JSON resume", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  actor.public.characterId = "slab_the_killer";
  clearHandToDrawPile(state, target.public.playerId);
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const missedId = moveCardToHand(state, "missed", target.public.playerId);
  const attackQueries: unknown[] = [];
  const slab: CharacterAbilityModule<"slab_the_killer"> = (input) => {
    assert.equal(input.hook.kind, "attack_response_query");
    if (input.hook.kind !== "attack_response_query") throw new Error("wrong Slab hook");
    attackQueries.push(structuredClone(input.hook));
    return { kind: "attack_response_query", additionalMissedCardsRequired: 1, availableJudgmentSources: [] };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { slab_the_killer: slab } },
  });
  assertCardZonesComplete(state);

  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
  assert.equal(opened.state.resolution.pendingInteraction?.context.requiredMisses, 2);
  const firstPrompt = opened.state.resolution.pendingInteraction!;
  const firstMissed = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, firstPrompt.interactionId, "USE_MISSED", missedId), commandContext(handlers));
  assert.equal(firstMissed.ok, true, firstMissed.ok ? undefined : `${firstMissed.error.code}: ${firstMissed.error.message}`);
  if (!firstMissed.ok) return;
  const secondPrompt = firstMissed.state.resolution.pendingInteraction;
  assert.equal(secondPrompt?.kind, "BANG_RESPONSE");
  assert.equal(secondPrompt?.context.requiredMisses, 2);
  assert.equal((secondPrompt?.context.barrelProgress as { successfulMisses?: number } | undefined)?.successfulMisses, 1);
  assert.ok(firstMissed.state.zones.discardPileCardInstanceIds.includes(missedId));
  assertCardZonesComplete(firstMissed.state);

  const persisted = JSON.parse(JSON.stringify(firstMissed.state)) as GameState;
  const beforeHp = persisted.seats.find((seat) => seat.public.playerId === target.public.playerId)!.public.hp;
  const hit = applyMatchCommand(persisted, target.public.playerId, respond(persisted, persisted.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(hit.ok, true, hit.ok ? undefined : `${hit.error.code}: ${hit.error.message}`);
  if (!hit.ok) return;
  assert.equal(hit.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, beforeHp - 1);
  assert.equal(hit.state.resolution.pendingInteraction, null);
  assert.equal(hit.state.resolution.effectQueue.length, 0);
  assert.equal(attackQueries.length, 2);
  assert.equal((attackQueries[0] as { missedCardsAlreadySubmitted: number }).missedCardsAlreadySubmitted, 0);
  assert.equal((attackQueries[1] as { missedCardsAlreadySubmitted: number }).missedCardsAlreadySubmitted, 1);
  assert.ok(attackQueries.every((query) => {
    const hook = query as { attack?: { kind?: string; card?: { physicalCardTypeId?: string; effectCardTypeId?: string } } };
    return hook.attack?.kind === "bang" && hook.attack.card?.physicalCardTypeId === "bang" && hook.attack.card.effectCardTypeId === "bang";
  }));
  assertCardZonesComplete(hit.state);
});

test("Suzy draws after the first Slab Missed before the second defense prompt opens", () => {
  const state = makeState();
  const [attacker, suzy] = state.seats;
  assert.ok(attacker && suzy);
  attacker.public.characterId = "slab_the_killer";
  suzy.public.characterId = "suzy_lafayette";
  clearHandToDrawPile(state, suzy.public.playerId);
  const bangId = moveCardToHand(state, "bang", attacker.public.playerId);
  const firstMissed = moveCardToHand(state, "missed", suzy.public.playerId);
  const secondMissed = moveCardToHand(state, "missed", suzy.public.playerId);
  moveCardToDrawTop(state, secondMissed);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
  assertCardZonesComplete(state);

  const opened = applyMatchCommand(state, attacker.public.playerId, playCard(state, attacker.public.playerId, bangId, suzy.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const firstPrompt = opened.state.resolution.pendingInteraction!;
  const firstResponse = applyMatchCommand(opened.state, suzy.public.playerId, respond(opened.state, firstPrompt.interactionId, "USE_MISSED", firstMissed), commandContext(handlers));
  assert.equal(firstResponse.ok, true, firstResponse.ok ? undefined : `${firstResponse.error.code}: ${firstResponse.error.message}`);
  if (!firstResponse.ok) return;

  const secondPrompt = firstResponse.state.resolution.pendingInteraction;
  assert.equal(secondPrompt?.kind, "BANG_RESPONSE");
  assert.ok(secondPrompt?.options.some((option) => option.choice === "USE_MISSED" && option.payload.cardInstanceId === secondMissed));
  assert.deepEqual(
    firstResponse.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds,
    [secondMissed],
  );
  assert.ok(firstResponse.events.some((event) => event.type === "CARD_DRAWN" && event.payload.cardInstanceId === secondMissed));
  assert.ok(firstResponse.events.findIndex((event) => event.type === "CARD_DISCARDED" && event.payload.cardInstanceId === firstMissed) <
    firstResponse.events.findIndex((event) => event.type === "CARD_DRAWN" && event.payload.cardInstanceId === secondMissed));

  const secondResponse = applyMatchCommand(firstResponse.state, suzy.public.playerId, respond(firstResponse.state, secondPrompt!.interactionId, "USE_MISSED", secondMissed), commandContext(handlers));
  assert.equal(secondResponse.ok, true, secondResponse.ok ? undefined : `${secondResponse.error.code}: ${secondResponse.error.message}`);
  if (!secondResponse.ok) return;
  assert.equal(secondResponse.state.resolution.pendingInteraction, null);
  assert.equal(secondResponse.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds.length, 1);
  assertCardZonesComplete(secondResponse.state);
});

test("Suzy waits until an initiated Duel fully resolves before drawing", () => {
  const state = makeState();
  const [suzy, target] = state.seats;
  assert.ok(suzy && target);
  suzy.public.characterId = "suzy_lafayette";
  clearHandToDrawPile(state, suzy.public.playerId);
  clearHandToDrawPile(state, target.public.playerId);
  const duelId = moveCardToHand(state, "duel", suzy.public.playerId);
  const bangId = moveCardToHand(state, "bang", target.public.playerId);
  const nextCard = state.zones.drawPileCardInstanceIds[0];
  assert.ok(nextCard);
  moveCardToDrawTop(state, nextCard);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());

  const opened = applyMatchCommand(state, suzy.public.playerId, playCard(state, suzy.public.playerId, duelId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.kind, "DUEL_RESPONSE");
  assert.deepEqual(opened.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds, []);
  assert.ok(opened.state.zones.drawPileCardInstanceIds.includes(nextCard), "the pending Duel has not triggered Suzy yet");

  const response = applyMatchCommand(opened.state, target.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: opened.state.resolution.pendingInteraction!.interactionId, choice: "PLAY_BANG", cardInstanceId: bangId },
  }, commandContext(handlers));
  assert.equal(response.ok, true, response.ok ? undefined : `${response.error.code}: ${response.error.message}`);
  if (!response.ok) return;
  assert.equal(response.state.resolution.pendingInteraction, null);
  assert.equal(response.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds.length, 1);
  assert.ok(response.events.some((event) => event.type === "CARD_DRAWN" && event.payload.cardInstanceId === nextCard));
});

test("Slab BANG counts successful Barrel and Jourdonnais judgments once each across JSON resume", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  actor.public.characterId = "slab_the_killer";
  target.public.characterId = "jourdonnais";
  clearHandToDrawPile(state, target.public.playerId);
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const barrelId = moveCardToPlay(state, "barrel", target.public.playerId);
  const missedId = moveCardToHand(state, "missed", target.public.playerId);
  const firstHeart = cardForFace(state, "HEARTS", 2);
  const secondHeart = cardForFace(state, "HEARTS", 3);
  moveCardToDrawTop(state, secondHeart);
  moveCardToDrawTop(state, firstHeart);
  const slab: CharacterAbilityModule<"slab_the_killer"> = () => ({
    kind: "attack_response_query",
    additionalMissedCardsRequired: 1,
    availableJudgmentSources: [],
  });
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { slab_the_killer: slab } },
  });
  assert.ok(target.public.inPlayCardInstanceIds.includes(barrelId));
  assertCardZonesComplete(state);

  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const firstPrompt = opened.state.resolution.pendingInteraction!;
  assert.ok(firstPrompt.options.some((option) => option.choice === "USE_BARREL"));
  assert.ok(firstPrompt.options.some((option) => option.choice === "USE_JOURDONNAIS"));
  const barrel = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, firstPrompt.interactionId, "USE_BARREL"), commandContext(handlers));
  assert.equal(barrel.ok, true, barrel.ok ? undefined : `${barrel.error.code}: ${barrel.error.message}`);
  if (!barrel.ok) return;
  const secondPrompt = barrel.state.resolution.pendingInteraction;
  assert.equal(secondPrompt?.kind, "BANG_RESPONSE");
  assert.equal(secondPrompt?.context.requiredMisses, 2);
  assert.equal((secondPrompt?.context.barrelProgress as { successfulMisses?: number } | undefined)?.successfulMisses, 1);
  assert.ok(secondPrompt?.options.some((option) => option.choice === "USE_JOURDONNAIS"));
  assert.ok(secondPrompt?.options.some((option) => option.choice === "USE_MISSED" && option.payload.cardInstanceId === missedId));
  assert.ok(barrel.events.some((event) => event.type === "BARREL_CHECK_RESOLVED" && event.payload.succeeded === true));
  assertCardZonesComplete(barrel.state);

  const persisted = JSON.parse(JSON.stringify(barrel.state)) as GameState;
  const resolved = applyMatchCommand(persisted, target.public.playerId, respond(persisted, persisted.resolution.pendingInteraction!.interactionId, "USE_JOURDONNAIS"), commandContext(handlers));
  assert.equal(resolved.ok, true, resolved.ok ? undefined : `${resolved.error.code}: ${resolved.error.message}`);
  if (!resolved.ok) return;
  assert.equal(resolved.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, target.public.hp);
  assert.equal(resolved.state.resolution.pendingInteraction, null);
  assert.ok(resolved.events.some((event) => event.type === "BARREL_CHECK_RESOLVED" && event.payload.defenseSource === "jourdonnais" && event.payload.succeeded === true));
  assert.ok(resolved.events.some((event) => event.type === "BANG_MISSED"));
  assert.ok(resolved.state.zones.discardPileCardInstanceIds.includes(firstHeart));
  assert.ok(resolved.state.zones.discardPileCardInstanceIds.includes(secondHeart));
  assertCardZonesComplete(resolved.state);
});

test("a Calamity physical Missed used as BANG stays at the ordinary one-card defense quota", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  actor.public.characterId = "calamity_janet";
  clearHandToDrawPile(state, target.public.playerId);
  const convertedBang = moveCardToHand(state, "missed", actor.public.playerId);
  const defenderMissed = moveCardToHand(state, "missed", target.public.playerId);
  let slabQueryCount = 0;
  const slab: CharacterAbilityModule<"slab_the_killer"> = () => {
    slabQueryCount += 1;
    return { kind: "attack_response_query", additionalMissedCardsRequired: 1, availableJudgmentSources: [] };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { slab_the_killer: slab } },
  });

  const opened = applyMatchCommand(state, actor.public.playerId, {
    type: "PLAY_CARD",
    payload: { cardInstanceId: convertedBang, targetPlayerId: target.public.playerId, asCardType: "bang" },
  }, commandContext(handlers));
  assert.equal(opened.ok, true, opened.ok ? undefined : `${opened.error.code}: ${opened.error.message}`);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.context.requiredMisses, 1);
  const response = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, opened.state.resolution.pendingInteraction!.interactionId, "USE_MISSED", defenderMissed), commandContext(handlers));
  assert.equal(response.ok, true, response.ok ? undefined : `${response.error.code}: ${response.error.message}`);
  if (!response.ok) return;
  assert.equal(response.state.resolution.pendingInteraction, null);
  assert.equal(slabQueryCount, 0);
  assert.ok(response.events.some((event) => event.type === "BANG_MISSED"));
});

test("a non-Slab physical BANG does not dispatch the Slab query", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  actor.public.characterId = "bart_cassidy";
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  let slabQueryCount = 0;
  const slab: CharacterAbilityModule<"slab_the_killer"> = () => {
    slabQueryCount += 1;
    return { kind: "attack_response_query", additionalMissedCardsRequired: 1, availableJudgmentSources: [] };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { slab_the_killer: slab } },
  });

  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true, opened.ok ? undefined : `${opened.error.code}: ${opened.error.message}`);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.context.requiredMisses, 1);
  assert.equal(slabQueryCount, 0);
});

test("Beer rescue resumes after JSON persistence and records damage only after recovery", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  target.public.hp = 1;
  target.public.characterId = "bart_cassidy";
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const beerId = moveCardToHand(state, "beer", target.public.playerId);
  const damageHooks: DamageResolvedHookInput[] = [];
  const bart: CharacterAbilityModule<"bart_cassidy"> = (input) => {
    assert.equal(input.hook.kind, "damage_resolved");
    if (input.hook.kind !== "damage_resolved") throw new Error("wrong Bart hook");
    damageHooks.push(structuredClone(input.hook));
    return { kind: "applied", events: [], steps: [] };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { bart_cassidy: bart } },
  });

  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const responseId = opened.state.resolution.pendingInteraction!.interactionId;
  const wounded = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, responseId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(wounded.ok, true);
  if (!wounded.ok) return;
  assert.equal(wounded.state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(wounded.state.resolution.pendingInteraction?.actorPlayerIds[0], target.public.playerId);

  const persisted = JSON.parse(JSON.stringify(wounded.state)) as GameState;
  const rescueId = persisted.resolution.pendingInteraction!.interactionId;
  const rescued = applyMatchCommand(persisted, target.public.playerId, respond(persisted, rescueId, "USE_BEER", beerId), commandContext(handlers));
  assert.equal(rescued.ok, true, rescued.ok ? undefined : `${rescued.error.code}: ${rescued.error.message}`);
  if (!rescued.ok) return;
  assert.equal(rescued.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 1);
  assert.equal(rescued.state.resolution.pendingDeath, null);
  assert.equal(rescued.state.resolution.pendingInteraction, null);
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(beerId));
  assert.ok(rescued.events.some((event) => event.type === "BEER_USED"));
  assert.equal(rescued.state.resolution.continuations.length, 0);
  assert.deepEqual(damageHooks, [{
    kind: "damage_resolved",
    victimPlayerId: target.public.playerId,
    damageAmount: 1,
    hpLost: 1,
    source: {
      playerId: actor.public.playerId,
      card: { cardInstanceId: bangId, physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      cause: "BANG",
    },
    survivedAfterRescue: true,
  }]);
});

test("Dynamite overkill keeps the rescue HP deficit through repeated Beer and runs Bart after survival", () => {
  const state = makeState();
  const target = state.seats[1]!;
  target.public.characterId = "bart_cassidy";
  target.public.maxHp = 4;
  target.public.hp = 2;
  const beerOne = moveCardToHand(state, "beer", target.public.playerId);
  const beerTwo = moveCardToHand(state, "beer", target.public.playerId);
  const dynamiteId = prepareDynamiteExplosion(state, target.public.playerId);
  const options = explodingDynamiteRuntimeOptions();
  const handlers = createEffectCommandHandlers(options);
  const openedState = startDynamiteExplosion(state, target.public.playerId, dynamiteId, options, "t85:beer-overkill");
  const openedVictim = openedState.seats.find((seat) => seat.public.playerId === target.public.playerId)!;
  assert.equal(openedVictim.public.hp, 0, "overkill stays hidden behind the public zero HP floor");
  assert.equal(openedState.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(openedState.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.equal(openedState.resolution.continuations.find((frame) => frame.frameId === "t85:beer-overkill")?.payload.rescueHp, -1);
  assertCardZonesComplete(openedState);

  const firstPrompt = openedState.resolution.pendingInteraction!;
  const firstBeer = applyMatchCommand(openedState, target.public.playerId, respond(openedState, firstPrompt.interactionId, "USE_BEER", beerOne), commandContext(handlers));
  assert.equal(firstBeer.ok, true, firstBeer.ok ? undefined : `${firstBeer.error.code}: ${firstBeer.error.message}`);
  if (!firstBeer.ok) return;
  assert.equal(firstBeer.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 0);
  assert.equal(firstBeer.state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(firstBeer.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.equal(firstBeer.state.resolution.continuations.find((frame) => frame.frameId === "t85:beer-overkill")?.payload.rescueHp, 0);
  assert.ok(firstBeer.state.zones.discardPileCardInstanceIds.includes(beerOne));
  assert.ok(firstBeer.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.private.handCardInstanceIds.includes(beerTwo));
  assertCardZonesComplete(firstBeer.state);

  const persistedPartial = JSON.parse(JSON.stringify(firstBeer.state)) as GameState;
  assert.equal(persistedPartial.resolution.continuations.find((frame) => frame.frameId === "t85:beer-overkill")?.payload.rescueHp, 0);
  const secondPrompt = persistedPartial.resolution.pendingInteraction!;
  assert.ok(secondPrompt.options.some((option) => option.choice === "USE_BEER" && option.payload.cardInstanceId === beerTwo));
  const secondBeer = applyMatchCommand(persistedPartial, target.public.playerId, respond(persistedPartial, secondPrompt.interactionId, "USE_BEER", beerTwo), commandContext(handlers));
  assert.equal(secondBeer.ok, true, secondBeer.ok ? undefined : `${secondBeer.error.code}: ${secondBeer.error.message}`);
  if (!secondBeer.ok) return;
  const rescued = secondBeer.state.seats.find((seat) => seat.public.playerId === target.public.playerId)!;
  assert.equal(rescued.public.hp, 1);
  assert.equal(secondBeer.state.resolution.pendingDeath, null);
  assert.equal(secondBeer.state.resolution.pendingInteraction, null);
  assert.equal(secondBeer.state.resolution.continuations.length, 0);
  assert.equal(secondBeer.events.filter((event) => event.type === "CARD_DRAWN").length, 2, "Bart runs after rescue and draws for the two HP actually lost");
  assert.ok(secondBeer.state.zones.discardPileCardInstanceIds.includes(beerTwo));
  assertCardZonesComplete(secondBeer.state);
});

test("after one partial Beer rescue, accepting elimination follows normal R28 cleanup", () => {
  const state = makeState();
  const target = state.seats[1]!;
  target.public.characterId = "bart_cassidy";
  target.public.maxHp = 4;
  target.public.hp = 2;
  target.private.roleId = "outlaw";
  state.seats[0]!.private.roleId = "sheriff";
  state.seats[2]!.private.roleId = "outlaw";
  state.seats[3]!.private.roleId = "renegade";
  state.seats[0]!.public.characterId = "willy_the_kid";
  state.seats[2]!.public.characterId = "sid_ketchum";
  state.seats[3]!.public.characterId = "black_jack";
  const beerId = moveCardToHand(state, "beer", target.public.playerId);
  const discardedTargetCards = target.private.handCardInstanceIds.filter((cardId) => cardId !== beerId);
  target.private.handCardInstanceIds = [beerId];
  state.zones.discardPileCardInstanceIds.push(...discardedTargetCards);
  const dynamiteId = prepareDynamiteExplosion(state, target.public.playerId);
  const options = explodingDynamiteRuntimeOptions();
  const handlers = createEffectCommandHandlers(options);
  const opened = startDynamiteExplosion(state, target.public.playerId, dynamiteId, options, "t85:accept-overkill");
  const firstPrompt = opened.resolution.pendingInteraction!;
  const partial = applyMatchCommand(opened, target.public.playerId, respond(opened, firstPrompt.interactionId, "USE_BEER", beerId), commandContext(handlers));
  assert.equal(partial.ok, true, partial.ok ? undefined : `${partial.error.code}: ${partial.error.message}`);
  if (!partial.ok) return;
  assert.equal(partial.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 0);
  assert.equal(partial.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.deepEqual(partial.state.resolution.pendingInteraction?.options.map((option) => option.choice), ["ACCEPT_ELIMINATION"]);

  const prompt = partial.state.resolution.pendingInteraction!;
  const eliminated = applyMatchCommand(partial.state, target.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: prompt.interactionId, choice: "ACCEPT_ELIMINATION" },
  }, commandContext(handlers));
  assert.equal(eliminated.ok, true, eliminated.ok ? undefined : `${eliminated.error.code}: ${eliminated.error.message}`);
  if (!eliminated.ok) return;
  assert.equal(eliminated.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.eliminated, true);
  assert.equal(eliminated.state.resolution.pendingDeath, null);
  assert.equal(eliminated.state.resolution.pendingInteraction, null);
  assert.equal(eliminated.state.resolution.effectQueue.length, 0);
  assert.equal(eliminated.state.resolution.continuations.length, 0);
  assert.ok(eliminated.events.some((event) => event.type === "PLAYER_ELIMINATED"));
  assertCardZonesComplete(eliminated.state);
});

test("Sid healing also keeps an overkill rescue open until HP becomes positive after JSON resume", () => {
  const state = makeState();
  const target = state.seats[1]!;
  target.public.characterId = "sid_ketchum";
  target.public.maxHp = 4;
  target.public.hp = 2;
  const costs = [
    moveCardToHand(state, "bang", target.public.playerId),
    moveCardToHand(state, "missed", target.public.playerId),
    moveCardToHand(state, "beer", target.public.playerId),
    moveCardToHand(state, "panic", target.public.playerId),
  ];
  const dynamiteId = prepareDynamiteExplosion(state, target.public.playerId);
  const options = explodingDynamiteRuntimeOptions();
  const handlers = createEffectCommandHandlers(options);
  const opened = startDynamiteExplosion(state, target.public.playerId, dynamiteId, options, "t85:sid-overkill");
  const firstPrompt = opened.resolution.pendingInteraction!;
  const firstSid = applyMatchCommand(opened, target.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: firstPrompt.interactionId, choice: "USE_SID", cardInstanceIds: costs.slice(0, 2) },
  }, commandContext(handlers));
  assert.equal(firstSid.ok, true, firstSid.ok ? undefined : `${firstSid.error.code}: ${firstSid.error.message}`);
  if (!firstSid.ok) return;
  assert.equal(firstSid.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 0);
  assert.equal(firstSid.state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(firstSid.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.equal(firstSid.state.resolution.continuations.find((frame) => frame.frameId === "t85:sid-overkill")?.payload.rescueHp, 0);
  assert.ok(costs.slice(0, 2).every((cardId) => firstSid.state.zones.discardPileCardInstanceIds.includes(cardId)));
  assertCardZonesComplete(firstSid.state);

  const persisted = JSON.parse(JSON.stringify(firstSid.state)) as GameState;
  const secondPrompt = persisted.resolution.pendingInteraction!;
  assert.ok(secondPrompt.options.some((option) => option.choice === "USE_SID" &&
    JSON.stringify(option.payload.cardInstanceIds) === JSON.stringify(costs.slice(2))));
  const secondSid = applyMatchCommand(persisted, target.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: secondPrompt.interactionId, choice: "USE_SID", cardInstanceIds: costs.slice(2) },
  }, commandContext(handlers));
  assert.equal(secondSid.ok, true, secondSid.ok ? undefined : `${secondSid.error.code}: ${secondSid.error.message}`);
  if (!secondSid.ok) return;
  assert.equal(secondSid.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 1);
  assert.equal(secondSid.state.resolution.pendingDeath, null);
  assert.equal(secondSid.state.resolution.pendingInteraction, null);
  assert.equal(secondSid.state.resolution.continuations.length, 0);
  assert.ok(costs.every((cardId) => secondSid.state.zones.discardPileCardInstanceIds.includes(cardId)));
  assertCardZonesComplete(secondSid.state);
});

test("a single Beer rescues damage that leaves HP exactly zero", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  target.public.maxHp = 4;
  target.public.hp = 1;
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const beerId = moveCardToHand(state, "beer", target.public.playerId);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
  const attack = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(attack.ok, true, attack.ok ? undefined : `${attack.error.code}: ${attack.error.message}`);
  if (!attack.ok) return;
  const hit = applyMatchCommand(attack.state, target.public.playerId, respond(attack.state, attack.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(hit.ok, true, hit.ok ? undefined : `${hit.error.code}: ${hit.error.message}`);
  if (!hit.ok) return;
  assert.equal(hit.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 0);
  const rescue = applyMatchCommand(hit.state, target.public.playerId, respond(hit.state, hit.state.resolution.pendingInteraction!.interactionId, "USE_BEER", beerId), commandContext(handlers));
  assert.equal(rescue.ok, true, rescue.ok ? undefined : `${rescue.error.code}: ${rescue.error.message}`);
  if (!rescue.ok) return;
  assert.equal(rescue.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 1);
  assert.equal(rescue.state.resolution.pendingDeath, null);
  assert.equal(rescue.state.resolution.pendingInteraction, null);
  assertCardZonesComplete(rescue.state);
});

test("Sid rescue spends the saved two-card pair before recovery continues", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  target.public.hp = 1;
  target.public.characterId = "sid_ketchum";
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const costOne = moveCardToHand(state, "missed", target.public.playerId);
  const costTwo = moveCardToHand(state, "beer", target.public.playerId);
  let rescueHookCount = 0;
  const sid: CharacterAbilityModule<"sid_ketchum"> = (input) => {
    assert.equal(input.hook.kind, "sid_ability_use");
    if (input.hook.kind !== "sid_ability_use") throw new Error("wrong Sid hook");
    assert.equal(input.hook.window.kind, "death_rescue");
    assert.deepEqual(input.hook.costCardInstanceIds, [costOne, costTwo]);
    rescueHookCount += 1;
    return {
      kind: "applied",
      events: [{ type: "PLAYER_HEALED", actorPlayerId: input.playerId, payload: { targetPlayerId: input.playerId, amount: 1, cause: "SID" } }],
      steps: [{ effectId: `${input.continuationFrameId}:sid-rescue-heal`, kind: "HEAL_PLAYER", sourcePlayerId: input.playerId, targetPlayerId: input.playerId, sourceCardInstanceId: null, payload: { amount: 1, cause: "SID" } }],
    };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { sid_ketchum: sid } },
  });
  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const wounded = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, opened.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(wounded.ok, true);
  if (!wounded.ok) return;
  const rescueId = wounded.state.resolution.pendingInteraction!.interactionId;
  const rescued = applyMatchCommand(wounded.state, target.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: rescueId, choice: "USE_SID", cardInstanceIds: [costOne, costTwo] },
  }, commandContext(handlers));
  assert.equal(rescued.ok, true, rescued.ok ? undefined : `${rescued.error.code}: ${rescued.error.message}`);
  if (!rescued.ok) return;
  assert.equal(rescueHookCount, 1);
  assert.equal(rescued.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, 1);
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(costOne));
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(costTwo));
  assert.equal(rescued.state.resolution.pendingDeath, null);
});

test("Stagecoach and equipment modules produce candidate card-zone changes through runtime", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  const stagecoachId = moveCardToHand(state, "stagecoach", actor.public.playerId);
  const handlers = createEffectCommandHandlers(runtimeOptions());
  const beforeHandCount = actor.private.handCardInstanceIds.length;
  const drawn = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, stagecoachId), commandContext(handlers));
  assert.equal(drawn.ok, true);
  if (!drawn.ok) return;
  assert.equal(drawn.state.seats.find((seat) => seat.public.playerId === actor.public.playerId)?.private.handCardInstanceIds.length, beforeHandCount + 1);
  assert.ok(drawn.state.zones.discardPileCardInstanceIds.includes(stagecoachId));
  assert.equal(drawn.events.filter((event) => event.type === "CARD_DRAWN").length, 2);

  const equipment = makeState();
  const equipmentActor = equipment.seats[0]!;
  const mustangId = moveCardToHand(equipment, "mustang", equipmentActor.public.playerId);
  const installed = applyMatchCommand(equipment, equipmentActor.public.playerId, playCard(equipment, equipmentActor.public.playerId, mustangId), commandContext(handlers));
  assert.equal(installed.ok, true);
  if (!installed.ok) return;
  assert.ok(installed.state.seats.find((seat) => seat.public.playerId === equipmentActor.public.playerId)?.public.inPlayCardInstanceIds.includes(mustangId));
  assert.ok(!installed.state.zones.discardPileCardInstanceIds.includes(mustangId));
});

test("Suzy does not draw again after General Store, Stagecoach, or Wells Fargo provides cards", () => {
  const cases = [
    { typeId: "general_store", expectedHandCount: 1 },
    { typeId: "stagecoach", expectedHandCount: 2 },
    { typeId: "wells_fargo", expectedHandCount: 3 },
  ] as const;

  for (const cardCase of cases) {
    const state = makeState();
    const suzy = state.seats[0]!;
    suzy.public.characterId = "suzy_lafayette";
    clearHandToDrawPile(state, suzy.public.playerId);
    const sourceCardId = moveCardToHand(state, cardCase.typeId, suzy.public.playerId);
    const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
    const opened = applyMatchCommand(state, suzy.public.playerId, playCard(state, suzy.public.playerId, sourceCardId), commandContext(handlers));
    assert.equal(opened.ok, true, cardCase.typeId);
    if (!opened.ok) return;
    let resolvedState = opened.state;
    for (let responseCount = 0; resolvedState.resolution.pendingInteraction !== null; responseCount += 1) {
      assert.ok(responseCount < state.seats.length, `${cardCase.typeId} should complete within one choice per living player`);
      const pending = resolvedState.resolution.pendingInteraction!;
      const actorPlayerId = pending.actorPlayerIds[0]!;
      const option = pending.options[0]!;
      const response: EngineCommand = {
        type: "RESPOND",
        payload: {
          interactionId: pending.interactionId,
          choice: option.choice,
          ...option.payload,
        } as Extract<EngineCommand, { type: "RESPOND" }>["payload"],
      };
      const next = applyMatchCommand(resolvedState, actorPlayerId, response, commandContext(handlers));
      assert.equal(next.ok, true, cardCase.typeId);
      if (!next.ok) return;
      resolvedState = next.state;
    }
    assert.equal(resolvedState.resolution.continuations.length, 0, cardCase.typeId);
    assert.equal(resolvedState.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds.length, cardCase.expectedHandCount, cardCase.typeId);
  }
});

test("Duel prompt and sequential target resolution use the serialized module result", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  const duelId = moveCardToHand(state, "duel", actor.public.playerId);
  const handlers = createEffectCommandHandlers(runtimeOptions());
  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, duelId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const interactionId = opened.state.resolution.pendingInteraction!.interactionId;
  const yielded = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, interactionId, "YIELD"), commandContext(handlers));
  assert.equal(yielded.ok, true);
  if (!yielded.ok) return;
  assert.equal(yielded.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, target.public.hp - 1);
  assert.ok(yielded.events.some((event) => event.type === "DUEL_YIELDED"));
});

test("Gatling resumes its clockwise queue after a public Barrel judgment", () => {
  const state = makeState();
  const [actor, barrelTarget, secondTarget, thirdTarget] = state.seats;
  assert.ok(actor && barrelTarget && secondTarget && thirdTarget);
  actor.public.characterId = "slab_the_killer";
  const gatlingId = moveCardToHand(state, "gatling", actor.public.playerId);
  moveCardToPlay(state, "barrel", barrelTarget.public.playerId);
  const heartId = state.zones.drawPileCardInstanceIds.find((id) => state.zones.cardsByInstanceId[id]?.suit === "HEARTS");
  assert.ok(heartId);
  state.zones.drawPileCardInstanceIds = [heartId, ...state.zones.drawPileCardInstanceIds.filter((id) => id !== heartId)];
  let slabQueryCount = 0;
  const slab: CharacterAbilityModule<"slab_the_killer"> = () => {
    slabQueryCount += 1;
    return { kind: "attack_response_query", additionalMissedCardsRequired: 1, availableJudgmentSources: [] };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { slab_the_killer: slab } },
  });

  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, gatlingId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.equal(opened.state.resolution.pendingInteraction?.actorPlayerIds[0], barrelTarget.public.playerId);
  const firstPrompt = opened.state.resolution.pendingInteraction!;
  assert.ok(firstPrompt.options.some((option) => option.choice === "USE_BARREL"));

  const barrel = applyMatchCommand(opened.state, barrelTarget.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: firstPrompt.interactionId, choice: "USE_BARREL" },
  }, commandContext(handlers));
  assert.equal(barrel.ok, true);
  if (!barrel.ok) return;
  assert.equal(barrel.state.seats.find((seat) => seat.public.playerId === barrelTarget.public.playerId)?.public.hp, barrelTarget.public.hp);
  assert.ok(barrel.events.some((event) => event.type === "BARREL_CHECK_RESOLVED"));

  const secondPrompt = barrel.state.resolution.pendingInteraction!;
  assert.equal(secondPrompt.actorPlayerIds[0], secondTarget.public.playerId);
  const secondHit = applyMatchCommand(barrel.state, secondTarget.public.playerId, respond(barrel.state, secondPrompt.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(secondHit.ok, true);
  if (!secondHit.ok) return;
  const thirdPrompt = secondHit.state.resolution.pendingInteraction!;
  assert.equal(thirdPrompt.actorPlayerIds[0], thirdTarget.public.playerId);
  const thirdHit = applyMatchCommand(secondHit.state, thirdTarget.public.playerId, respond(secondHit.state, thirdPrompt.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(thirdHit.ok, true);
  if (!thirdHit.ok) return;
  assert.equal(thirdHit.state.resolution.effectQueue.length, 0);
  assert.equal(thirdHit.state.resolution.pendingInteraction, null);
  assert.equal(thirdHit.state.seats.find((seat) => seat.public.playerId === secondTarget.public.playerId)?.public.hp, secondTarget.public.hp - 1);
  assert.equal(thirdHit.state.seats.find((seat) => seat.public.playerId === thirdTarget.public.playerId)?.public.hp, thirdTarget.public.hp - 1);
  assert.equal(slabQueryCount, 0, "Slab does not query or strengthen Gatling defense");
});

test("Jail and Panic results apply their declared zone movements", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  target.private.roleId = "outlaw";
  const jailId = moveCardToHand(state, "jail", actor.public.playerId);
  const handlers = createEffectCommandHandlers(runtimeOptions());
  const jailed = applyMatchCommand(state, actor.public.playerId, {
    type: "PLAY_CARD",
    payload: { cardInstanceId: jailId, targetPlayerId: target.public.playerId },
  }, commandContext(handlers));
  assert.equal(jailed.ok, true);
  if (!jailed.ok) return;
  assert.ok(jailed.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.inPlayCardInstanceIds.includes(jailId));

  const panicState = makeState();
  const [panicActor, panicTarget] = panicState.seats;
  assert.ok(panicActor && panicTarget);
  const panicId = moveCardToHand(panicState, "panic", panicActor.public.playerId);
  const targetHandCount = panicTarget.private.handCardInstanceIds.length;
  const panicked = applyMatchCommand(panicState, panicActor.public.playerId, {
    type: "PLAY_CARD",
    payload: { cardInstanceId: panicId, targetPlayerId: panicTarget.public.playerId, targetZone: "HAND" },
  }, commandContext(handlers));
  assert.equal(panicked.ok, true);
  if (!panicked.ok) return;
  assert.equal(panicked.state.seats.find((seat) => seat.public.playerId === panicTarget.public.playerId)?.private.handCardInstanceIds.length, targetHandCount - 1);
  assert.ok(panicked.events.some((event) => event.type === "CARD_TRANSFERRED"));
  assert.ok(panicked.state.zones.discardPileCardInstanceIds.includes(panicId));
});

test("direct phase-effect entrypoint runs Dynamite under an explicit continuation ID", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  state.turn.phase = "start";
  const dynamiteId = moveCardToPlay(state, "dynamite", actor.public.playerId);
  const passingCard = state.zones.drawPileCardInstanceIds.find((id) => {
    const instance = state.zones.cardsByInstanceId[id]!;
    return instance.suit !== "SPADES" || !(Number(instance.rank) >= 2 && Number(instance.rank) <= 9);
  });
  assert.ok(passingCard);
  state.zones.drawPileCardInstanceIds = [passingCard, ...state.zones.drawPileCardInstanceIds.filter((id) => id !== passingCard)];
  const options = runtimeOptions();
  const resolved = executeCardEffect({
    state,
    actorPlayerId: actor.public.playerId,
    effectTypeId: "dynamite",
    sourceCardInstanceId: dynamiteId,
    continuationFrameId: "turn-start:dynamite:one",
    random: fixedRandom(),
  }, {
    ...options,
    registry: { ...options.registry, cards: { ...options.registry.cards, dynamite: dynamiteStartEffect } },
  });
  assert.equal(resolved.ok, true, resolved.ok ? undefined : `${resolved.error.code}: ${resolved.error.message}`);
  if (!resolved.ok) return;
  const nextPlayer = state.seats[1]!.public.playerId;
  assert.ok(resolved.output.state.seats.find((seat) => seat.public.playerId === nextPlayer)?.public.inPlayCardInstanceIds.includes(dynamiteId));
  assert.ok(resolved.output.events.some((event) => event.type === "DYNAMITE_PASSED"));
  assert.equal(resolved.output.state.resolution.continuations.length, 0);
});

test("Lucky's Dynamite judgment choice persists its two candidates and selected safe result across JSON resume", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  actor.public.characterId = "lucky_duke";
  state.turn.phase = "start";
  const dynamiteId = moveCardToPlay(state, "dynamite", actor.public.playerId);
  const exploding = cardForFace(state, "SPADES", 2);
  const heart = cardForFace(state, "HEARTS", 3);
  moveCardToDrawTop(state, heart);
  moveCardToDrawTop(state, exploding);
  const candidateIds = [exploding, heart];
  const effectTypeId = "test_lucky_dynamite_start";
  const baseOptions = runtimeOptions();
  const options: EffectRuntimeOptions = {
    ...baseOptions,
    registry: { ...baseOptions.registry, cards: { ...baseOptions.registry.cards, [effectTypeId]: dynamiteStartEffect } },
  };
  const handlers = createEffectCommandHandlers(options);
  const opened = executeCardEffect({
    state,
    actorPlayerId: actor.public.playerId,
    effectTypeId,
    sourceCardInstanceId: dynamiteId,
    continuationFrameId: "lucky-dynamite-continuation",
    random: fixedRandom(),
  }, options);
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const firstPendingState = opened.output.state;
  const pending = firstPendingState.resolution.pendingInteraction;
  assert.equal(pending?.kind, "LUCKY_DRAW");
  assert.deepEqual(firstPendingState.zones.revealedPoolCardInstanceIds, candidateIds);
  assert.deepEqual(pending?.context.candidateCardInstanceIds, candidateIds);
  assert.equal(pending?.options.length, 4);
  assert.deepEqual(firstPendingState.zones.drawPileCardInstanceIds.slice(0, 2), state.zones.drawPileCardInstanceIds.slice(2, 4));
  assertCardZonesComplete(firstPendingState);

  const replayOptionsBase = runtimeOptions();
  const replayOptions: EffectRuntimeOptions = {
    ...replayOptionsBase,
    registry: { ...replayOptionsBase.registry, cards: { ...replayOptionsBase.registry.cards, [effectTypeId]: dynamiteStartEffect } },
  };
  const replay = executeCardEffect({
    state: structuredClone(state),
    actorPlayerId: actor.public.playerId,
    effectTypeId,
    sourceCardInstanceId: dynamiteId,
    continuationFrameId: "lucky-dynamite-continuation",
    random: fixedRandom(),
  }, replayOptions);
  assert.equal(replay.ok, true);
  if (replay.ok) {
    assert.deepEqual(replay.output.state.resolution.pendingInteraction?.context.candidateCardInstanceIds, candidateIds);
    assert.deepEqual(replay.output.state.resolution.pendingInteraction?.options, pending?.options);
  }

  const persisted = JSON.parse(JSON.stringify(firstPendingState)) as GameState;
  const prompt = persisted.resolution.pendingInteraction!;
  const order = [exploding, heart];
  const selectedOption = prompt.options.find((option) => option.payload.selectedCardInstanceId === heart &&
    JSON.stringify(option.payload.orderedCardInstanceIds) === JSON.stringify(order));
  assert.ok(selectedOption);
  const resumed = applyMatchCommand(persisted, actor.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: prompt.interactionId, choice: selectedOption.choice, ...selectedOption.payload },
  }, commandContext(handlers));
  assert.equal(resumed.ok, true, resumed.ok ? undefined : `${resumed.error.code}: ${resumed.error.message}`);
  if (!resumed.ok) return;
  assert.equal(resumed.state.resolution.pendingInteraction, null);
  assert.deepEqual(resumed.state.zones.discardPileCardInstanceIds.slice(-2), order);
  const passed = resumed.events.find((event) => event.type === "DYNAMITE_PASSED");
  assert.equal(passed?.payload.judgmentCardInstanceId, heart);
  assert.equal(typeof passed?.payload.toPlayerId, "string");
  assert.ok(resumed.state.seats.find((seat) => seat.public.playerId === passed?.payload.toPlayerId)?.public.inPlayCardInstanceIds.includes(dynamiteId));
  assert.equal(resumed.events.some((event) => event.type === "DYNAMITE_EXPLODED"), false);
  assertCardZonesComplete(resumed.state);
});

test("Lucky's actual Barrel Draw! saves selection and chosen discard order through the runtime queue", () => {
  const state = makeState();
  const [attacker, target] = state.seats;
  assert.ok(attacker && target);
  target.public.characterId = "lucky_duke";
  clearHandToDrawPile(state, target.public.playerId);
  const bangId = moveCardToHand(state, "bang", attacker.public.playerId);
  const barrelId = moveCardToPlay(state, "barrel", target.public.playerId);
  const nonHeart = cardForFace(state, "SPADES", 10);
  const heart = cardForFace(state, "HEARTS", 4);
  moveCardToDrawTop(state, heart);
  moveCardToDrawTop(state, nonHeart);
  const candidateIds = [nonHeart, heart];
  const handlers = createEffectCommandHandlers(runtimeOptions());

  const attack = applyMatchCommand(state, attacker.public.playerId, playCard(state, attacker.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(attack.ok, true, attack.ok ? undefined : `${attack.error.code}: ${attack.error.message}`);
  if (!attack.ok) return;
  const defensePrompt = attack.state.resolution.pendingInteraction!;
  assert.ok(defensePrompt.options.some((option) => option.choice === "USE_BARREL"));
  const barrel = applyMatchCommand(attack.state, target.public.playerId, respond(attack.state, defensePrompt.interactionId, "USE_BARREL"), commandContext(handlers));
  assert.equal(barrel.ok, true, barrel.ok ? undefined : `${barrel.error.code}: ${barrel.error.message}`);
  if (!barrel.ok) return;
  const prompt = barrel.state.resolution.pendingInteraction;
  assert.equal(prompt?.kind, "LUCKY_DRAW");
  assert.equal(prompt?.context.sourceKind, "barrel");
  assert.equal(prompt?.context.sourceCardInstanceId, barrelId);
  assert.deepEqual(barrel.state.zones.revealedPoolCardInstanceIds, candidateIds);
  assertCardZonesComplete(barrel.state);

  const persisted = JSON.parse(JSON.stringify(barrel.state)) as GameState;
  const pending = persisted.resolution.pendingInteraction!;
  const order = [heart, nonHeart];
  const selectedOption = pending.options.find((option) => option.payload.selectedCardInstanceId === heart &&
    JSON.stringify(option.payload.orderedCardInstanceIds) === JSON.stringify(order));
  assert.ok(selectedOption);
  const responded = applyMatchCommand(persisted, target.public.playerId, {
    type: "RESPOND",
    payload: { interactionId: pending.interactionId, choice: selectedOption.choice, ...selectedOption.payload },
  }, commandContext(handlers));
  assert.equal(responded.ok, true, responded.ok ? undefined : `${responded.error.code}: ${responded.error.message}`);
  if (!responded.ok) return;
  assert.equal(responded.state.resolution.pendingInteraction, null);
  assert.equal(responded.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.hp, target.public.hp);
  assert.deepEqual(responded.state.zones.discardPileCardInstanceIds.slice(-2), order);
  assert.ok(responded.events.some((event) => event.type === "BARREL_CHECK_RESOLVED" &&
    event.payload.judgmentCardInstanceId === heart && event.payload.succeeded === true));
  assert.ok(responded.events.some((event) => event.type === "BANG_MISSED"));
  assertCardZonesComplete(responded.state);
});

test("Elimination rescue accept resumes R28 cleanup before the saved damage hook", () => {
  const state = makeState();
  const [actor, target] = state.seats;
  assert.ok(actor && target);
  target.public.hp = 1;
  target.public.characterId = "el_gringo";
  state.zones.discardPileCardInstanceIds.push(...target.private.handCardInstanceIds, ...target.public.inPlayCardInstanceIds);
  target.private.handCardInstanceIds = [];
  target.public.inPlayCardInstanceIds = [];
  target.private.roleId = "renegade";
  const bangId = moveCardToHand(state, "bang", actor.public.playerId);
  const damageHooks: DamageResolvedHookInput[] = [];
  const elGringo: CharacterAbilityModule<"el_gringo"> = (input) => {
    assert.equal(input.hook.kind, "damage_resolved");
    if (input.hook.kind !== "damage_resolved") throw new Error("wrong El Gringo hook");
    damageHooks.push(structuredClone(input.hook));
    return { kind: "applied", events: [], steps: [] };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { el_gringo: elGringo } },
  });
  const opened = applyMatchCommand(state, actor.public.playerId, playCard(state, actor.public.playerId, bangId, target.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const hit = applyMatchCommand(opened.state, target.public.playerId, respond(opened.state, opened.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  const deathPrompt = hit.state.resolution.pendingInteraction;
  assert.equal(deathPrompt?.kind, "DEATH_RESCUE");
  const eliminated = applyMatchCommand(hit.state, target.public.playerId, respond(hit.state, deathPrompt!.interactionId, "ACCEPT_ELIMINATION"), commandContext(handlers));
  assert.equal(eliminated.ok, true, eliminated.ok ? undefined : `${eliminated.error.code}: ${eliminated.error.message}`);
  if (!eliminated.ok) return;
  assert.equal(eliminated.state.seats.find((seat) => seat.public.playerId === target.public.playerId)?.public.eliminated, true);
  assert.equal(eliminated.state.resolution.pendingDeath, null);
  assert.ok(eliminated.events.some((event) => event.type === "PLAYER_ELIMINATED"));
  assert.equal(eliminated.state.resolution.effectQueue.length, 0);
  assert.equal(damageHooks.length, 1);
  assert.equal(damageHooks[0]?.hpLost, 1);
  assert.equal(damageHooks[0]?.survivedAfterRescue, false);
});

test("Suzy draws after R27 rescue before El Gringo steals, then checks again at resolution completion", () => {
  const state = makeState();
  const [suzy, elGringo] = state.seats;
  assert.ok(suzy && elGringo);
  suzy.public.characterId = "suzy_lafayette";
  elGringo.public.characterId = "el_gringo";
  elGringo.public.hp = 1;
  clearHandToDrawPile(state, suzy.public.playerId);
  clearHandToDrawPile(state, elGringo.public.playerId);
  const bangId = moveCardToHand(state, "bang", suzy.public.playerId);
  const beerId = moveCardToHand(state, "beer", elGringo.public.playerId);
  const firstSuzyDraw = state.zones.drawPileCardInstanceIds[0];
  const secondSuzyDraw = state.zones.drawPileCardInstanceIds[1];
  assert.ok(firstSuzyDraw && secondSuzyDraw);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());
  assertCardZonesComplete(state);

  const opened = applyMatchCommand(state, suzy.public.playerId, playCard(state, suzy.public.playerId, bangId, elGringo.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  assert.deepEqual(opened.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds, []);
  assert.ok(opened.state.zones.drawPileCardInstanceIds.includes(firstSuzyDraw), "Suzy waits for the BANG damage and rescue result");

  const hit = applyMatchCommand(opened.state, elGringo.public.playerId, respond(opened.state, opened.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  assert.equal(hit.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.ok(hit.state.zones.drawPileCardInstanceIds.includes(firstSuzyDraw), "the before-reward hook waits until R27 resolves");
  assert.ok(hit.state.seats.find((seat) => seat.public.playerId === elGringo.public.playerId)?.private.handCardInstanceIds.includes(beerId));

  const rescued = applyMatchCommand(hit.state, elGringo.public.playerId, respond(hit.state, hit.state.resolution.pendingInteraction!.interactionId, "USE_BEER", beerId), commandContext(handlers));
  assert.equal(rescued.ok, true, rescued.ok ? undefined : `${rescued.error.code}: ${rescued.error.message}`);
  if (!rescued.ok) return;
  assert.equal(rescued.state.seats.find((seat) => seat.public.playerId === elGringo.public.playerId)?.public.hp, 1);
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(beerId));
  assert.deepEqual(rescued.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds, [secondSuzyDraw]);
  assert.ok(rescued.state.seats.find((seat) => seat.public.playerId === elGringo.public.playerId)?.private.handCardInstanceIds.includes(firstSuzyDraw));
  const firstDrawIndex = rescued.events.findIndex((event) => event.type === "CARD_DRAWN" && event.payload.cardInstanceId === firstSuzyDraw);
  const stealIndex = rescued.events.findIndex((event) => event.type === "CARD_TRANSFERRED" && event.payload.cardInstanceId === firstSuzyDraw);
  const secondDrawIndex = rescued.events.findIndex((event) => event.type === "CARD_DRAWN" && event.payload.cardInstanceId === secondSuzyDraw);
  assert.ok(firstDrawIndex >= 0 && firstDrawIndex < stealIndex && stealIndex < secondDrawIndex, "event order is Suzy draw, El Gringo steal, Suzy completion draw");
  assert.equal(rescued.state.resolution.pendingInteraction, null);
  assert.equal(rescued.state.resolution.continuations.length, 0);
  assertCardZonesComplete(rescued.state);
});

test("Suzy does not make a completion draw when El Gringo leaves her with a card", () => {
  const state = makeState();
  const [suzy, elGringo] = state.seats;
  assert.ok(suzy && elGringo);
  suzy.public.characterId = "suzy_lafayette";
  elGringo.public.characterId = "el_gringo";
  clearHandToDrawPile(state, suzy.public.playerId);
  clearHandToDrawPile(state, elGringo.public.playerId);
  const bangId = moveCardToHand(state, "bang", suzy.public.playerId);
  moveCardToHand(state, "beer", suzy.public.playerId);
  moveCardToHand(state, "missed", suzy.public.playerId);
  const nextCard = state.zones.drawPileCardInstanceIds[0];
  assert.ok(nextCard);
  const handlers = createEffectCommandHandlers(registeredRuntimeOptions());

  const opened = applyMatchCommand(state, suzy.public.playerId, playCard(state, suzy.public.playerId, bangId, elGringo.public.playerId), commandContext(handlers));
  assert.equal(opened.ok, true);
  if (!opened.ok) return;
  const hit = applyMatchCommand(opened.state, elGringo.public.playerId, respond(opened.state, opened.state.resolution.pendingInteraction!.interactionId, "TAKE_HIT"), commandContext(handlers));
  assert.equal(hit.ok, true);
  if (!hit.ok) return;
  assert.equal(hit.state.seats.find((seat) => seat.public.playerId === suzy.public.playerId)?.private.handCardInstanceIds.length, 1);
  assert.equal(hit.events.filter((event) => event.type === "CARD_DRAWN").length, 0);
  assert.ok(hit.state.zones.drawPileCardInstanceIds.includes(nextCard));
  assertCardZonesComplete(hit.state);
});

test("Sid ability module receives the caller-selected two-card cost and runtime applies it once", () => {
  const state = makeState();
  const actor = state.seats[0]!;
  actor.public.characterId = "sid_ketchum";
  actor.public.hp = Math.max(1, actor.public.maxHp - 1);
  const costOne = moveCardToHand(state, "bang", actor.public.playerId);
  const costTwo = moveCardToHand(state, "missed", actor.public.playerId);
  const sid: CharacterAbilityModule<"sid_ketchum"> = (input) => {
    assert.equal(input.hook.kind, "sid_ability_use");
    if (input.hook.kind !== "sid_ability_use") throw new Error("wrong Sid hook");
    assert.deepEqual(input.hook.costCardInstanceIds, [costOne, costTwo]);
    return {
      kind: "applied",
      events: [{ type: "PLAYER_HEALED", actorPlayerId: input.playerId, payload: { targetPlayerId: input.playerId, amount: 1, cause: "SID" } }],
      steps: [{ effectId: `${input.continuationFrameId}:heal`, kind: "HEAL_PLAYER", sourcePlayerId: input.playerId, targetPlayerId: input.playerId, sourceCardInstanceId: null, payload: { amount: 1, cause: "SID" } }],
    };
  };
  const options = runtimeOptions();
  const handlers = createEffectCommandHandlers({
    ...options,
    registry: { ...options.registry, characters: { sid_ketchum: sid } },
  });
  const used = applyMatchCommand(state, actor.public.playerId, {
    type: "USE_ABILITY",
    payload: { abilityId: "sid-ketchum", cardInstanceIds: [costOne, costTwo] },
  }, commandContext(handlers));
  assert.equal(used.ok, true);
  if (!used.ok) return;
  assert.equal(used.state.seats.find((seat) => seat.public.playerId === actor.public.playerId)?.public.hp, actor.public.hp + 1);
  assert.ok(used.state.zones.discardPileCardInstanceIds.includes(costOne));
  assert.ok(used.state.zones.discardPileCardInstanceIds.includes(costTwo));
  assert.equal(used.state.resolution.continuations.length, 0);
});

