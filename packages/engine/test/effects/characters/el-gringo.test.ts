// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { CharacterAbilityInput, DamageResolvedHookInput } from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import type { RandomSource } from "../../../src/random/shuffle.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";
import { elGringoAbility } from "../../../src/effects/characters/el-gringo.ts";

interface Fixture {
  state: GameState;
  victim: SeatState;
  source: SeatState;
  sourceCardInstanceId: string;
  sourceHandCardInstanceIds: string[];
}

function initialState(): GameState {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  return initializeGame({ players, random: { nextFloat: () => 0 } });
}

function seat(state: GameState, playerId: string): SeatState {
  const matches = state.seats.filter((entry) => entry.public.playerId === playerId);
  assert.equal(matches.length, 1, `expected one seat for ${playerId}`);
  return matches[0]!;
}

function cardIdOfType(state: GameState, typeId: string, excludedCardInstanceIds: readonly string[] = []): string {
  const definitionIds = new Set(
    BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId).map((card) => card.definitionId),
  );
  if (definitionIds.size === 0) throw new Error(`missing physical card type ${typeId}`);
  const excluded = new Set(excludedCardInstanceIds);
  const instance = Object.values(state.zones.cardsByInstanceId).find(
    (card) => definitionIds.has(card.cardDefinitionId) && !excluded.has(card.cardInstanceId),
  );
  if (!instance) throw new Error(`missing runtime card for ${typeId}`);
  return instance.cardInstanceId;
}

function moveCard(state: GameState, cardInstanceId: string, destination: "hand" | "discard", playerId?: string): void {
  for (const entry of state.seats) {
    entry.private.handCardInstanceIds = entry.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    entry.public.inPlayCardInstanceIds = entry.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);

  if (destination === "discard") {
    state.zones.discardPileCardInstanceIds.push(cardInstanceId);
    return;
  }
  if (!playerId) throw new Error("hand cards need an owner");
  seat(state, playerId).private.handCardInstanceIds.push(cardInstanceId);
}

function fixture(sourceHandCount = 3, sourceTypeId = "bang"): Fixture {
  const state = initialState();
  const victim = seat(state, "player-1");
  const source = seat(state, "player-2");
  victim.public.characterId = "el_gringo";
  victim.public.maxHp = 3;
  victim.public.hp = 2;

  for (const cardInstanceId of [...source.private.handCardInstanceIds]) {
    moveCard(state, cardInstanceId, "discard");
  }
  const sourceCardInstanceId = cardIdOfType(state, sourceTypeId);
  moveCard(state, sourceCardInstanceId, "discard");
  const sourceHandCardInstanceIds = Object.keys(state.zones.cardsByInstanceId)
    .filter((cardInstanceId) => cardInstanceId !== sourceCardInstanceId)
    .slice(0, sourceHandCount);
  for (const cardInstanceId of sourceHandCardInstanceIds) {
    moveCard(state, cardInstanceId, "hand", source.public.playerId);
  }

  return { state, victim, source, sourceCardInstanceId, sourceHandCardInstanceIds };
}

function countedRandom(values: readonly number[]): { random: RandomSource; calls: () => number } {
  let cursor = 0;
  return {
    random: {
      nextFloat() {
        const value = values[cursor];
        if (value === undefined) throw new Error("random fixture exhausted");
        cursor += 1;
        return value;
      },
    },
    calls: () => cursor,
  };
}

function input(
  f: Fixture,
  hookOverrides: Partial<DamageResolvedHookInput> = {},
  random: RandomSource = { nextFloat: () => { throw new Error("unexpected random draw"); } },
): CharacterAbilityInput<"el_gringo"> {
  const hook: DamageResolvedHookInput = {
    kind: "damage_resolved",
    victimPlayerId: f.victim.public.playerId,
    damageAmount: 1,
    hpLost: 1,
    source: damageSource(f, f.sourceCardInstanceId, f.source.public.playerId),
    survivedAfterRescue: true,
    ...hookOverrides,
  };
  return {
    characterId: "el_gringo",
    playerId: f.victim.public.playerId,
    state: f.state,
    continuationFrameId: "frame-el-gringo",
    random,
    completedInteractions: [],
    hook,
  };
}

function damageSource(
  f: Fixture,
  cardInstanceId: string,
  playerId: string | null,
): DamageResolvedHookInput["source"] {
  const typeId = sourceType(cardInstanceId, f.state);
  return {
    playerId,
    card: {
      cardInstanceId,
      physicalCardTypeId: typeId,
      effectCardTypeId: typeId,
    },
    cause: sourceCause(cardInstanceId, f.state),
  };
}

function sourceType(cardInstanceId: string, state: GameState): "bang" | "dynamite" | "duel" {
  const instance = state.zones.cardsByInstanceId[cardInstanceId];
  if (!instance) throw new Error(`missing runtime card ${cardInstanceId}`);
  const definition = BASE_PHYSICAL_CARDS.find((card) => card.definitionId === instance.cardDefinitionId);
  if (!definition) throw new Error(`missing physical definition ${instance.cardDefinitionId}`);
  if (definition.typeId !== "bang" && definition.typeId !== "dynamite" && definition.typeId !== "duel") {
    throw new Error(`unsupported source card type ${definition.typeId}`);
  }
  return definition.typeId;
}

function sourceCause(cardInstanceId: string, state: GameState): DamageResolvedHookInput["source"]["cause"] {
  const typeId = sourceType(cardInstanceId, state);
  if (typeId === "dynamite") return "DYNAMITE";
  if (typeId === "duel") return "DUEL";
  return "BANG";
}

function appliedEvents(result: ReturnType<typeof elGringoAbility>): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied result, received ${result.kind}`);
  return result.events;
}

function transferredCardIds(events: readonly EffectEventDraft[]): string[] {
  return events.map((entry) => {
    assert.equal(entry.type, "CARD_TRANSFERRED");
    assert.equal(entry.actorPlayerId, "player-1");
    assert.equal(entry.payload.fromPlayerId, "player-2");
    assert.equal(entry.payload.fromZone, "hand");
    assert.equal(entry.payload.toPlayerId, "player-1");
    assert.equal(entry.payload.toZone, "hand");
    assert.equal(typeof entry.payload.cardInstanceId, "string");
    return entry.payload.cardInstanceId as string;
  });
}

test("El Gringo takes one fixed-RNG hand card for each HP actually lost", () => {
  const f = fixture(3);
  const before = structuredClone(f.state);
  const rng = countedRandom([0.99, 0]);

  const events = appliedEvents(elGringoAbility(input(f, { damageAmount: 3, hpLost: 2 }, rng.random)));

  assert.deepEqual(transferredCardIds(events), [f.sourceHandCardInstanceIds[2], f.sourceHandCardInstanceIds[0]]);
  assert.equal(rng.calls(), 2);
  assert.deepEqual(f.state, before, "the module returns movement events without mutating its input state");
});

test("El Gringo stops taking cards when the source hand runs out", () => {
  const f = fixture(2);
  const rng = countedRandom([0.5, 0]);

  const events = appliedEvents(elGringoAbility(input(f, { damageAmount: 4, hpLost: 4 }, rng.random)));

  assert.deepEqual(transferredCardIds(events), [f.sourceHandCardInstanceIds[1], f.sourceHandCardInstanceIds[0]]);
  assert.equal(rng.calls(), 2);
});

test("El Gringo does not trigger before post-rescue survival or without actual HP loss", () => {
  const f = fixture(2);
  const cases: Array<{ name: string; hook: Partial<DamageResolvedHookInput> }> = [
    { name: "no HP lost", hook: { hpLost: 0 } },
    { name: "fractional HP loss", hook: { hpLost: 0.5 } },
    { name: "did not survive rescue", hook: { survivedAfterRescue: false } },
    { name: "wrong victim", hook: { victimPlayerId: f.source.public.playerId } },
  ];

  for (const scenario of cases) {
    const rng = countedRandom([]);
    assert.deepEqual(
      elGringoAbility(input(f, scenario.hook, rng.random)),
      { kind: "applied", events: [], steps: [] },
      scenario.name,
    );
    assert.equal(rng.calls(), 0, `${scenario.name} must not consume RNG`);
  }
});

test("El Gringo ignores Dynamite, self-caused damage, and a Duel he initiated", () => {
  const dynamite = fixture(2, "dynamite");
  const self = fixture(2);
  const selfDuel = fixture(2, "duel");
  const victimOwnedBangInstanceId = cardIdOfType(self.state, "bang", [self.sourceCardInstanceId]);
  moveCard(self.state, victimOwnedBangInstanceId, "hand", self.victim.public.playerId);
  moveCard(self.state, victimOwnedBangInstanceId, "discard");
  const cases: Array<{ f: Fixture; hook: Partial<DamageResolvedHookInput>; name: string }> = [
    { f: dynamite, hook: {}, name: "Dynamite" },
    {
      f: self,
      hook: { source: damageSource(self, victimOwnedBangInstanceId, self.victim.public.playerId) },
      name: "self-caused damage",
    },
    {
      f: selfDuel,
      hook: { source: damageSource(selfDuel, selfDuel.sourceCardInstanceId, selfDuel.victim.public.playerId) },
      name: "El Gringo loses a Duel he initiated",
    },
    {
      f: self,
      hook: { source: { ...input(self).hook.source, playerId: null } },
      name: "damage without a player source",
    },
  ];

  for (const scenario of cases) {
    const rng = countedRandom([]);
    assert.deepEqual(
      elGringoAbility(input(scenario.f, scenario.hook, rng.random)),
      { kind: "applied", events: [], steps: [] },
      scenario.name,
    );
    assert.equal(rng.calls(), 0, `${scenario.name} must not consume RNG`);
  }
});

test("El Gringo may take a card after losing another player's Duel and gets nothing from an empty hand", () => {
  const duel = fixture(1, "duel");
  const duelResult = elGringoAbility(input(duel, {}, { nextFloat: () => 0 }));
  assert.deepEqual(transferredCardIds(appliedEvents(duelResult)), [duel.sourceHandCardInstanceIds[0]]);

  const emptyHand = fixture(0);
  const rng = countedRandom([]);
  assert.deepEqual(
    elGringoAbility(input(emptyHand, {}, rng.random)),
    { kind: "applied", events: [], steps: [] },
  );
  assert.equal(rng.calls(), 0);
});

test("El Gringo validates every injected random sample before selecting a card", () => {
  for (const sample of [-0.01, 1, Number.NaN]) {
    const f = fixture(1);
    assert.throws(
      () => elGringoAbility(input(f, {}, { nextFloat: () => sample })),
      RangeError,
    );
  }
});
