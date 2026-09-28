import assert from "node:assert/strict";
import test from "node:test";
import { BASE_CARD_DEFINITIONS } from "../../../catalog/src/cards/index.ts";
import { characters as BASE_CHARACTERS } from "../../../catalog/src/characters/index.ts";
import { bangEffect, beerEffect } from "../../src/effects/cards/basic-actions.ts";
import { dynamiteInstallEffect, dynamiteStartEffect } from "../../src/effects/cards/dynamite-barrel.ts";
import { equipmentEffect } from "../../src/effects/cards/equipment.ts";
import {
  buildEffectRegistry,
  createEffectRegistry,
  type CardEffectRegistration,
  type CharacterAbilityRegistration,
} from "../../src/effects/registry.ts";
import {
  createEffectCommandHandlers,
  type EffectRuntimeOptions,
  type EffectRuntimeRegistry,
} from "../../src/effects/runtime/index.ts";

function registrations(registry = createEffectRegistry()): {
  cards: CardEffectRegistration[];
  characters: CharacterAbilityRegistration[];
} {
  return {
    cards: Object.entries(registry.cards) as unknown as CardEffectRegistration[],
    characters: Object.entries(registry.characters) as unknown as CharacterAbilityRegistration[],
  };
}

test("registers every base card and character once with their matching modules", () => {
  const registry = createEffectRegistry();
  const cardIds = Object.keys(registry.cards).sort();
  const characterIds = Object.keys(registry.characters).sort();

  assert.deepEqual(cardIds, BASE_CARD_DEFINITIONS.map(({ typeId }) => typeId).sort());
  assert.deepEqual(characterIds, BASE_CHARACTERS.map(({ id }) => id).sort());
  assert.equal(cardIds.length, 22);
  assert.equal(new Set(cardIds).size, 22);
  assert.equal(characterIds.length, 16);
  assert.equal(new Set(characterIds).size, 16);
  assert.ok(Object.values(registry.cards).every((module) => typeof module === "function"));
  assert.ok(Object.values(registry.characters).every((module) => typeof module === "function"));

  assert.equal(registry.cards.bang, bangEffect);
  assert.equal(registry.cards.beer, beerEffect);
  assert.equal(registry.cards.barrel, equipmentEffect);
  assert.equal(registry.cards.dynamite, dynamiteInstallEffect);
  assert.notEqual(registry.cards.dynamite, dynamiteStartEffect);
});

test("builds a registry whose types fit the T66 runtime injection API", () => {
  const registry = createEffectRegistry();
  const runtimeRegistry: EffectRuntimeRegistry = registry;
  const options: EffectRuntimeOptions = {
    registry: runtimeRegistry,
    nextInteractionIdentity: () => ({ interactionId: "registry-test", createdAt: "2026-01-01T00:00:00.000Z" }),
  };

  assert.ok(createEffectCommandHandlers(options));
});

test("rejects duplicate card and character identifiers", () => {
  const entries = registrations();
  assert.throws(
    () => buildEffectRegistry([...entries.cards, entries.cards[0]!], entries.characters),
    /Duplicate card registry ID/,
  );
  assert.throws(
    () => buildEffectRegistry(entries.cards, [...entries.characters, entries.characters[0]!]),
    /Duplicate character registry ID/,
  );
});

test("rejects missing card and character identifiers", () => {
  const entries = registrations();
  assert.throws(
    () => buildEffectRegistry(entries.cards.slice(1), entries.characters),
    /Missing card registry ID/,
  );
  assert.throws(
    () => buildEffectRegistry(entries.cards, entries.characters.slice(1)),
    /Missing character registry ID/,
  );
});

test("rejects unknown card and character identifiers", () => {
  const entries = registrations();
  const unknownCard = ["not_a_base_card", bangEffect] as unknown as CardEffectRegistration;
  const unknownCharacter = ["not_a_character", entries.characters[0]![1]] as unknown as CharacterAbilityRegistration;

  assert.throws(
    () => buildEffectRegistry([...entries.cards, unknownCard], entries.characters),
    /Unknown card registry ID 'not_a_base_card'/,
  );
  assert.throws(
    () => buildEffectRegistry(entries.cards, [...entries.characters, unknownCharacter]),
    /Unknown character registry ID 'not_a_character'/,
  );
});

test("rejects malformed entries and non-module registrations", () => {
  const entries = registrations();
  const malformedCard = ["bang"] as unknown as CardEffectRegistration;
  const invalidCharacterModule = [
    entries.characters[0]![0],
    {},
  ] as unknown as CharacterAbilityRegistration;

  assert.throws(
    () => buildEffectRegistry([malformedCard, ...entries.cards.slice(1)], entries.characters),
    /must be an \[id, module\] pair/,
  );
  assert.throws(
    () => buildEffectRegistry(entries.cards, [invalidCharacterModule, ...entries.characters.slice(1)]),
    /must be a function/,
  );
});
