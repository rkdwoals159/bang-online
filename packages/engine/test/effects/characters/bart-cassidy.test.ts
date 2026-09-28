// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import type { EngineCommand } from "../../../src/commands/index.ts";
import { applyMatchCommand } from "../../../src/commands/index.ts";
import { bangEffect, beerEffect, missedEffect } from "../../../src/effects/cards/basic-actions.ts";
import type { CharacterAbilityInput, DamageResolvedHookInput } from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import { bartCassidyAbility } from "../../../src/effects/characters/bart-cassidy.ts";
import { createEffectCommandHandlers, type EffectRuntimeOptions } from "../../../src/effects/runtime/index.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";

interface Fixture {
  readonly state: GameState;
  readonly victim: SeatState;
}

function initialState(): Fixture {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  const victim = state.seats.find((seat) => seat.public.playerId === "player-1");
  assert.ok(victim, "fixture needs player-1");
  victim.public.characterId = "bart_cassidy";
  victim.public.maxHp = 4;
  victim.public.hp = 1;
  return { state, victim };
}

function cardIdOfType(state: GameState, typeId: string): string {
  const definitions = new Set(BASE_PHYSICAL_CARDS
    .filter((card) => card.typeId === typeId)
    .map((card) => card.definitionId));
  const card = Object.values(state.zones.cardsByInstanceId)
    .find((candidate) => definitions.has(candidate.cardDefinitionId));
  assert.ok(card, `fixture needs a ${typeId} card`);
  return card.cardInstanceId;
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

function moveCardToHand(state: GameState, typeId: string, playerId: string): string {
  const cardInstanceId = cardIdOfType(state, typeId);
  removeCardFromZones(state, cardInstanceId);
  const owner = state.seats.find((seat) => seat.public.playerId === playerId);
  assert.ok(owner, `fixture needs ${playerId}`);
  owner.private.handCardInstanceIds.push(cardInstanceId);
  return cardInstanceId;
}

function moveCardToDiscard(state: GameState, cardInstanceId: string): void {
  removeCardFromZones(state, cardInstanceId);
  state.zones.discardPileCardInstanceIds.push(cardInstanceId);
}

function moveCardToDrawTop(state: GameState, cardInstanceId: string): void {
  removeCardFromZones(state, cardInstanceId);
  state.zones.drawPileCardInstanceIds.unshift(cardInstanceId);
}

/** Keeps all physical instances in exactly one zone while setting test piles. */
function setPiles(state: GameState, drawPile: readonly string[], discardPile: readonly string[]): void {
  const pileIds = [...drawPile, ...discardPile];
  assert.equal(new Set(pileIds).size, pileIds.length, "fixture piles must not duplicate cards");
  for (const cardInstanceId of pileIds) assert.ok(state.zones.cardsByInstanceId[cardInstanceId]);

  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = [];
    seat.public.inPlayCardInstanceIds = [];
  }
  state.zones.drawPileCardInstanceIds = [...drawPile];
  state.zones.discardPileCardInstanceIds = [...discardPile];
  state.zones.revealedPoolCardInstanceIds = [];

  const pileIdSet = new Set(pileIds);
  const remainingIds = Object.keys(state.zones.cardsByInstanceId).filter((id) => !pileIdSet.has(id));
  state.seats.find((seat) => seat.public.playerId === "player-1")!.private.handCardInstanceIds = remainingIds;
}

function fixedRandom(values: readonly number[] = []): RandomSource {
  let cursor = 0;
  return {
    nextFloat() {
      const value = values[cursor];
      if (value === undefined) throw new Error("random fixture exhausted");
      cursor += 1;
      return value;
    },
  };
}

function unusedRandom(): RandomSource {
  return { nextFloat: () => { throw new Error("this path must not consume randomness"); } };
}

function runtimeRandom(): RandomSource {
  let cursor = 0;
  return { nextFloat: () => ((cursor++ * 67 + 11) % 997) / 997 };
}

function runtimeHandlers(): ReturnType<typeof createEffectCommandHandlers> {
  let serial = 0;
  const options: EffectRuntimeOptions = {
    registry: {
      cards: { bang: bangEffect, missed: missedEffect, beer: beerEffect },
      characters: { bart_cassidy: bartCassidyAbility },
    },
    nextInteractionIdentity: () => ({
      interactionId: `bart-runtime-${++serial}`,
      createdAt: `2026-09-28T00:00:${String(serial).padStart(2, "0")}.000Z`,
    }),
  };
  return createEffectCommandHandlers(options);
}

function playBang(bangCardInstanceId: string): EngineCommand {
  return {
    type: "PLAY_CARD",
    payload: { cardInstanceId: bangCardInstanceId, targetPlayerId: "player-1" },
  };
}

function respond(
  state: GameState,
  choice: string,
  cardInstanceId?: string,
): EngineCommand {
  const interactionId = state.resolution.pendingInteraction?.interactionId;
  assert.ok(interactionId, "fixture needs a pending interaction");
  return {
    type: "RESPOND",
    payload: {
      interactionId,
      choice,
      ...(cardInstanceId === undefined ? {} : { cardInstanceId }),
    } as Extract<EngineCommand, { type: "RESPOND" }>['payload'],
  };
}

function input(
  fixture: Fixture,
  hookOverrides: Partial<DamageResolvedHookInput> = {},
  options: { readonly playerId?: string; readonly random?: RandomSource } = {},
): CharacterAbilityInput<"bart_cassidy"> {
  const hook: DamageResolvedHookInput = {
    kind: "damage_resolved",
    victimPlayerId: fixture.victim.public.playerId,
    damageAmount: 1,
    hpLost: 1,
    source: {
      playerId: "player-2",
      card: { cardInstanceId: null, physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      cause: "BANG",
    },
    survivedAfterRescue: true,
    ...hookOverrides,
  };
  return {
    characterId: "bart_cassidy",
    playerId: options.playerId ?? fixture.victim.public.playerId,
    state: fixture.state,
    continuationFrameId: "frame-bart-cassidy",
    random: options.random ?? unusedRandom(),
    completedInteractions: [],
    hook,
  };
}

function appliedEvents(result: ReturnType<typeof bartCassidyAbility>): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied result, received ${result.kind}`);
  return result.events;
}

function drawnCardIds(events: readonly EffectEventDraft[], playerId: string): string[] {
  return events.map((draft) => {
    assert.equal(draft.type, "CARD_DRAWN");
    assert.equal(draft.actorPlayerId, playerId);
    assert.equal(draft.payload.playerId, playerId);
    assert.equal(draft.payload.fromZone, "draw_pile");
    assert.equal(draft.payload.toZone, "hand");
    assert.equal(typeof draft.payload.cardInstanceId, "string");
    return draft.payload.cardInstanceId as string;
  });
}

test("surviving Bart draws one top card for each HP lost, including source-less Dynamite damage", () => {
  const fixture = initialState();
  const topCards = fixture.state.zones.drawPileCardInstanceIds.slice(0, 3);
  setPiles(fixture.state, topCards, []);
  const before = structuredClone(fixture.state);

  const events = appliedEvents(bartCassidyAbility(input(fixture, {
    damageAmount: 3,
    hpLost: 3,
    source: {
      playerId: null,
      card: { cardInstanceId: null, physicalCardTypeId: null, effectCardTypeId: null },
      cause: "DYNAMITE",
    },
  })));

  assert.deepEqual(drawnCardIds(events, fixture.victim.public.playerId), topCards);
  assert.ok(events.every((draft) => draft.payload.sourceCardInstanceId === null));
  assert.deepEqual(fixture.state, before, "Bart returns draw drafts without changing the input snapshot");
});

test("Bart draws for actual HP lost rather than the incoming damage amount", () => {
  const fixture = initialState();
  const topCards = fixture.state.zones.drawPileCardInstanceIds.slice(0, 3);
  setPiles(fixture.state, topCards, []);

  const events = appliedEvents(bartCassidyAbility(input(fixture, {
    damageAmount: 3,
    hpLost: 1,
  })));

  assert.deepEqual(drawnCardIds(events, fixture.victim.public.playerId), [topCards[0]]);
});

test("Bart waits until rescue ends and requires a matching live Bart with positive integral HP loss", () => {
  const cases: Array<{
    readonly name: string;
    readonly hook?: Partial<DamageResolvedHookInput>;
    readonly playerId?: string;
    readonly characterId?: "bart_cassidy" | "el_gringo";
    readonly hp?: number;
    readonly eliminated?: boolean;
  }> = [
    { name: "zero HP loss", hook: { hpLost: 0 } },
    { name: "negative HP loss", hook: { hpLost: -1 } },
    { name: "fractional HP loss", hook: { hpLost: 0.5 } },
    { name: "did not survive rescue", hook: { survivedAfterRescue: false } },
    { name: "hook names another victim", hook: { victimPlayerId: "player-2" } },
    { name: "input player differs from victim", playerId: "player-2" },
    { name: "seat is another character", characterId: "el_gringo" },
    { name: "seat is eliminated", eliminated: true },
    { name: "seat has no remaining HP", hp: 0 },
  ];

  for (const scenario of cases) {
    const fixture = initialState();
    const beerCard = cardIdOfType(fixture.state, "beer");
    setPiles(fixture.state, [beerCard], []);
    if (scenario.characterId) fixture.victim.public.characterId = scenario.characterId;
    if (scenario.hp !== undefined) fixture.victim.public.hp = scenario.hp;
    if (scenario.eliminated) fixture.victim.public.eliminated = true;

    assert.deepEqual(
      bartCassidyAbility(input(fixture, scenario.hook, { playerId: scenario.playerId, random: unusedRandom() })),
      { kind: "applied", events: [], steps: [] },
      scenario.name,
    );
  }
});

test("D05 stops after partial R08 supply without inventing cards", () => {
  const fixture = initialState();
  const available = [
    cardIdOfType(fixture.state, "bang"),
    cardIdOfType(fixture.state, "beer"),
    cardIdOfType(fixture.state, "missed"),
  ];
  setPiles(fixture.state, [available[0]!], available.slice(1));
  const before = structuredClone(fixture.state);
  const args = input(fixture, { hpLost: 4 }, { random: fixedRandom([0]) });

  const first = bartCassidyAbility(args);
  const second = bartCassidyAbility({ ...args, random: fixedRandom([0]) });

  assert.deepEqual(second, first, "same state and injected RNG must produce the same plan");
  const events = appliedEvents(first);
  assert.deepEqual(events.map((draft) => draft.type), [
    "CARD_DRAWN",
    "DRAW_PILE_RESHUFFLED",
    "CARD_DRAWN",
    "CARD_DRAWN",
    "RULE_RESOURCE_EXHAUSTED",
  ]);
  assert.equal(events[4]?.payload.requestedCount, 4);
  assert.equal(events[4]?.payload.fulfilledCount, 3);
  assert.equal(events[4]?.payload.pauseReason, "RULE_RESOURCE_EXHAUSTED");
  assert.equal(drawnCardIds(events.slice(0, 1).concat(events.slice(2, 4)), fixture.victim.public.playerId).length, 3);
  assert.deepEqual(fixture.state, before, "R08 planning must not move cards in the module state");
});

test("a damage source owned by another player does not change draw recipient attribution", () => {
  const fixture = initialState();
  const sourceCardInstanceId = cardIdOfType(fixture.state, "bang");
  const topCard = fixture.state.zones.drawPileCardInstanceIds.find((id) => id !== sourceCardInstanceId)!;
  setPiles(fixture.state, [topCard], [sourceCardInstanceId]);

  const events = appliedEvents(bartCassidyAbility(input(fixture, {
    source: {
      playerId: "player-2",
      card: { cardInstanceId: sourceCardInstanceId, physicalCardTypeId: "bang", effectCardTypeId: "bang" },
      cause: "BANG",
    },
  })));

  assert.deepEqual(drawnCardIds(events, fixture.victim.public.playerId), [topCard]);
  assert.equal(events[0]?.payload.sourceCardInstanceId, sourceCardInstanceId);
  assert.notEqual(events[0]?.actorPlayerId, "player-2");
});

test("T66 calls Bart after a lethal hit is rescued with Beer", () => {
  const fixture = initialState();
  const state = fixture.state;
  const attackerPlayerId = "player-2";
  state.turn.currentPlayerId = attackerPlayerId;
  state.turn.phase = "play";
  const bangCardInstanceId = moveCardToHand(state, "bang", attackerPlayerId);
  const beerCardInstanceId = moveCardToHand(state, "beer", fixture.victim.public.playerId);
  const expectedDrawId = state.zones.drawPileCardInstanceIds[0]!;
  const handlers = runtimeHandlers();
  const context = () => ({ handlers, random: runtimeRandom() });

  const played = applyMatchCommand(state, attackerPlayerId, playBang(bangCardInstanceId), context());
  assert.equal(played.ok, true, played.ok ? undefined : `${played.error.code}: ${played.error.message}`);
  if (!played.ok) return;
  assert.equal(played.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");

  const hit = applyMatchCommand(
    played.state,
    fixture.victim.public.playerId,
    respond(played.state, "TAKE_HIT"),
    context(),
  );
  assert.equal(hit.ok, true, hit.ok ? undefined : `${hit.error.code}: ${hit.error.message}`);
  if (!hit.ok) return;
  assert.equal(hit.state.resolution.pendingDeath?.consequenceStage, "rescue");
  assert.equal(hit.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.equal(hit.events.some((event) =>
    event.type === "CARD_DRAWN" && event.payload.playerId === fixture.victim.public.playerId,
  ), false, "Bart must not draw while the rescue prompt is open");

  const rescued = applyMatchCommand(
    hit.state,
    fixture.victim.public.playerId,
    respond(hit.state, "USE_BEER", beerCardInstanceId),
    context(),
  );
  assert.equal(rescued.ok, true, rescued.ok ? undefined : `${rescued.error.code}: ${rescued.error.message}`);
  if (!rescued.ok) return;
  assert.equal(rescued.state.seats.find((seat) => seat.public.playerId === fixture.victim.public.playerId)?.public.hp, 1);
  assert.equal(rescued.state.resolution.pendingDeath, null);
  assert.ok(rescued.state.zones.discardPileCardInstanceIds.includes(beerCardInstanceId));
  const bartDraws = rescued.events.filter((event) =>
    event.type === "CARD_DRAWN" && event.payload.playerId === fixture.victim.public.playerId,
  );
  assert.deepEqual(bartDraws.map((event) => event.payload.cardInstanceId), [expectedDrawId]);
});

test("T66 does not let Bart draw the top Beer during an unrescued death window", () => {
  const fixture = initialState();
  const state = fixture.state;
  const attackerPlayerId = "player-2";
  state.turn.currentPlayerId = attackerPlayerId;
  state.turn.phase = "play";
  fixture.victim.private.roleId = "renegade";
  for (const cardInstanceId of [...fixture.victim.private.handCardInstanceIds]) {
    moveCardToDiscard(state, cardInstanceId);
  }
  const bangCardInstanceId = moveCardToHand(state, "bang", attackerPlayerId);
  const beerCardInstanceId = cardIdOfType(state, "beer");
  moveCardToDrawTop(state, beerCardInstanceId);
  assert.equal(fixture.victim.private.handCardInstanceIds.length, 0);
  const handlers = runtimeHandlers();
  const context = () => ({ handlers, random: runtimeRandom() });

  const played = applyMatchCommand(state, attackerPlayerId, playBang(bangCardInstanceId), context());
  assert.equal(played.ok, true, played.ok ? undefined : `${played.error.code}: ${played.error.message}`);
  if (!played.ok) return;
  const hit = applyMatchCommand(
    played.state,
    fixture.victim.public.playerId,
    respond(played.state, "TAKE_HIT"),
    context(),
  );
  assert.equal(hit.ok, true, hit.ok ? undefined : `${hit.error.code}: ${hit.error.message}`);
  if (!hit.ok) return;
  assert.equal(hit.state.resolution.pendingInteraction?.kind, "DEATH_RESCUE");
  assert.equal(hit.state.resolution.pendingInteraction?.options.some((option) => option.choice === "USE_BEER"), false);
  assert.equal(hit.state.zones.drawPileCardInstanceIds[0], beerCardInstanceId);

  const eliminated = applyMatchCommand(
    hit.state,
    fixture.victim.public.playerId,
    respond(hit.state, "ACCEPT_ELIMINATION"),
    context(),
  );
  assert.equal(eliminated.ok, true, eliminated.ok ? undefined : `${eliminated.error.code}: ${eliminated.error.message}`);
  if (!eliminated.ok) return;
  assert.equal(eliminated.state.seats.find((seat) => seat.public.playerId === fixture.victim.public.playerId)?.public.eliminated, true);
  assert.equal(eliminated.state.zones.drawPileCardInstanceIds[0], beerCardInstanceId);
  assert.equal(eliminated.events.some((event) =>
    event.type === "CARD_DRAWN" && event.payload.playerId === fixture.victim.public.playerId,
  ), false);
});
