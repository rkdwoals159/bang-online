// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import assert from "node:assert/strict";
// @ts-ignore The engine package does not depend on @types/node; Node provides these at runtime.
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../catalog/src/cards/index.ts";
import type { CharacterAbilityInput, EliminationCleanupHookInput } from "../../../src/effects/character-api.ts";
import type { EffectEventDraft } from "../../../src/effects/api.ts";
import { vultureSamAbility } from "../../../src/effects/characters/vulture-sam.ts";
import { initializeGame, type SetupPlayer } from "../../../src/setup/initialize.ts";
import type { GameState, SeatState } from "../../../src/state/types.ts";

interface Fixture {
  state: GameState;
  vulture: SeatState;
  victim: SeatState;
}

function fixture(): Fixture {
  const players: SetupPlayer[] = Array.from({ length: 4 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Player ${index + 1}`,
  }));
  const state = initializeGame({ players, random: { nextFloat: () => 0 } });
  const vulture = state.seats[0]!;
  const victim = state.seats[1]!;
  vulture.public.characterId = "vulture_sam";
  victim.public.eliminated = true;
  victim.public.hp = 0;
  for (const cardInstanceId of [...victim.private.handCardInstanceIds, ...victim.public.inPlayCardInstanceIds]) {
    moveCard(state, cardInstanceId, "discard");
  }
  return { state, vulture, victim };
}

function cardIdOfType(state: GameState, typeId: string, excluded: readonly string[] = []): string {
  const definitions = new Set(BASE_PHYSICAL_CARDS
    .filter((card) => card.typeId === typeId)
    .map((card) => card.definitionId));
  const card = Object.values(state.zones.cardsByInstanceId).find((entry) =>
    definitions.has(entry.cardDefinitionId) && !excluded.includes(entry.cardInstanceId));
  assert.ok(card, `fixture needs a ${typeId} card`);
  return card.cardInstanceId;
}

function moveCard(state: GameState, cardInstanceId: string, destination: "hand" | "in_play" | "discard", player?: SeatState): void {
  for (const seat of state.seats) {
    seat.private.handCardInstanceIds = seat.private.handCardInstanceIds.filter((id) => id !== cardInstanceId);
    seat.public.inPlayCardInstanceIds = seat.public.inPlayCardInstanceIds.filter((id) => id !== cardInstanceId);
  }
  state.zones.drawPileCardInstanceIds = state.zones.drawPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.discardPileCardInstanceIds = state.zones.discardPileCardInstanceIds.filter((id) => id !== cardInstanceId);
  state.zones.revealedPoolCardInstanceIds = state.zones.revealedPoolCardInstanceIds.filter((id) => id !== cardInstanceId);

  if (destination === "discard") {
    state.zones.discardPileCardInstanceIds.push(cardInstanceId);
  } else if (destination === "hand") {
    assert.ok(player, "hand destination needs a player");
    player.private.handCardInstanceIds.push(cardInstanceId);
  } else {
    assert.ok(player, "in-play destination needs a player");
    player.public.inPlayCardInstanceIds.push(cardInstanceId);
  }
}

function hookFor(f: Fixture, overrides: Partial<EliminationCleanupHookInput> = {}): EliminationCleanupHookInput {
  return {
    kind: "elimination_cleanup",
    eliminatedPlayerId: f.victim.public.playerId,
    sourcePlayerId: f.vulture.public.playerId,
    cause: "BANG",
    salvageableCards: {
      handCardInstanceIds: [...f.victim.private.handCardInstanceIds],
      inPlayCardInstanceIds: [...f.victim.public.inPlayCardInstanceIds],
    },
    ...overrides,
  };
}

function runAbility(f: Fixture, hook: EliminationCleanupHookInput = hookFor(f)) {
  const input: CharacterAbilityInput<"vulture_sam"> = {
    characterId: "vulture_sam",
    playerId: f.vulture.public.playerId,
    state: f.state,
    continuationFrameId: "vulture-sam-frame",
    random: { nextFloat: () => { throw new Error("Vulture Sam must not consume randomness"); } },
    completedInteractions: [],
    hook,
  };
  return vultureSamAbility(input);
}

function eventsOf(result: ReturnType<typeof vultureSamAbility>): readonly EffectEventDraft[] {
  assert.equal(result.kind, "applied");
  if (result.kind !== "applied") throw new Error(`expected applied result, got ${result.kind}`);
  return result.events;
}

function eventCardIds(events: readonly EffectEventDraft[], victimPlayerId: string, vulturePlayerId: string): string[] {
  return events.map((event) => {
    assert.equal(event.type, "CARD_TRANSFERRED");
    assert.equal(event.actorPlayerId, vulturePlayerId);
    assert.equal(event.payload.fromPlayerId, victimPlayerId);
    assert.ok(event.payload.fromZone === "hand" || event.payload.fromZone === "in_play");
    assert.equal(event.payload.toPlayerId, vulturePlayerId);
    assert.equal(event.payload.toZone, "hand");
    assert.equal(typeof event.payload.cardInstanceId, "string");
    return event.payload.cardInstanceId as string;
  });
}

function applyTransferEvents(state: GameState, events: readonly EffectEventDraft[]): void {
  for (const event of events) {
    if (event.type !== "CARD_TRANSFERRED") throw new Error(`unexpected event ${event.type}`);
    const cardInstanceId = event.payload.cardInstanceId;
    const toPlayerId = event.payload.toPlayerId;
    assert.equal(typeof cardInstanceId, "string");
    assert.equal(typeof toPlayerId, "string");
    const destination = state.seats.find((seat) => seat.public.playerId === toPlayerId);
    assert.ok(destination);
    moveCard(state, cardInstanceId, "hand", destination);
  }
}

test("Vulture Sam transfers eliminated player's hand and equipment to hand without mutating state", () => {
  const f = fixture();
  const handIds = [cardIdOfType(f.state, "bang"), cardIdOfType(f.state, "beer")];
  const equipmentIds = [cardIdOfType(f.state, "barrel"), cardIdOfType(f.state, "scope")];
  for (const id of handIds) moveCard(f.state, id, "hand", f.victim);
  for (const id of equipmentIds) moveCard(f.state, id, "in_play", f.victim);
  const before = structuredClone(f.state);

  const events = eventsOf(runAbility(f));

  assert.deepEqual(eventCardIds(events, f.victim.public.playerId, f.vulture.public.playerId), [...handIds, ...equipmentIds]);
  assert.deepEqual(events.map((event) => event.payload.fromZone), ["hand", "hand", "in_play", "in_play"]);
  assert.ok(events.every((event) => event.payload.toZone === "hand"), "equipment is not auto-equipped");
  assert.deepEqual(f.state, before, "the module returns events and leaves its snapshot untouched");

  applyTransferEvents(f.state, events);
  const staleHookResult = runAbility(f, hookFor(f, {
    salvageableCards: { handCardInstanceIds: [...handIds], inPlayCardInstanceIds: [...equipmentIds] },
  }));
  assert.deepEqual(eventsOf(staleHookResult), [], "a repeated cleanup against the updated state cannot reclaim cards");
});

test("Vulture Sam cannot recover a Dynamite already discarded by its explosion", () => {
  const f = fixture();
  const handId = cardIdOfType(f.state, "bang");
  const equipmentId = cardIdOfType(f.state, "barrel");
  const dynamiteId = cardIdOfType(f.state, "dynamite");
  moveCard(f.state, handId, "hand", f.victim);
  moveCard(f.state, equipmentId, "in_play", f.victim);
  moveCard(f.state, dynamiteId, "discard");
  const hook = hookFor(f, {
    cause: "DYNAMITE",
    salvageableCards: { handCardInstanceIds: [handId], inPlayCardInstanceIds: [equipmentId] },
  });

  const events = eventsOf(runAbility(f, hook));

  assert.deepEqual(eventCardIds(events, f.victim.public.playerId, f.vulture.public.playerId), [handId, equipmentId]);
  assert.ok(f.state.zones.discardPileCardInstanceIds.includes(dynamiteId));
  assert.ok(!events.some((event) => event.payload.cardInstanceId === dynamiteId));
});

test("Vulture Sam ignores malformed or stale cleanup snapshots", () => {
  const f = fixture();
  const handId = cardIdOfType(f.state, "bang");
  moveCard(f.state, handId, "hand", f.victim);

  const duplicateCard = hookFor(f, {
    salvageableCards: { handCardInstanceIds: [handId, handId], inPlayCardInstanceIds: [] },
  });
  assert.deepEqual(eventsOf(runAbility(f, duplicateCard)), []);

  const stillLivingVictim = fixture();
  stillLivingVictim.victim.public.eliminated = false;
  assert.deepEqual(eventsOf(runAbility(stillLivingVictim)), []);

  f.vulture.public.eliminated = true;
  assert.deepEqual(eventsOf(runAbility(f)), []);
});
