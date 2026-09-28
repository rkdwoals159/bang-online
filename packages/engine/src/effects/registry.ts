import { BASE_CARD_DEFINITIONS } from "../../../catalog/src/cards/index.js";
import { characters as BASE_CHARACTERS } from "../../../catalog/src/characters/index.js";
import type { CardEffectModule } from "./api.js";
import { bangEffect, beerEffect, missedEffect } from "./cards/basic-actions.js";
import { dynamiteInstallEffect } from "./cards/dynamite-barrel.js";
import { duelEffect } from "./cards/duel.js";
import { equipmentEffect } from "./cards/equipment.js";
import { generalStoreEffect, stagecoachEffect, wellsFargoEffect } from "./cards/draw-select.js";
import { jailEffect } from "./cards/jail.js";
import { catBalouEffect, panicEffect } from "./cards/steal-discard.js";
import { gatlingEffect, indiansEffect, saloonEffect } from "./cards/tablewide.js";
import type {
  BaseCardTypeId,
  CharacterAbilityId,
  CharacterAbilityModule,
} from "./character-api.js";
import { bartCassidyAbility } from "./characters/bart-cassidy.js";
import { blackJackAbility } from "./characters/black-jack.js";
import { calamityJanetAbility } from "./characters/calamity-janet.js";
import { elGringoAbility } from "./characters/el-gringo.js";
import { jesseJonesAbility } from "./characters/jesse-jones.js";
import { jourdonnaisAbility } from "./characters/jourdonnais.js";
import { kitCarlsonAbility } from "./characters/kit-carlson.js";
import { luckyDukeAbility } from "./characters/lucky-duke.js";
import { paulRegretAbility } from "./characters/paul-regret.js";
import { pedroRamirezAbility } from "./characters/pedro-ramirez.js";
import { roseDoolanAbility } from "./characters/rose-doolan.js";
import { sidKetchumAbility } from "./characters/sid-ketchum.js";
import { slabAbility } from "./characters/slab.js";
import { suzyLafayetteAbility } from "./characters/suzy-lafayette.js";
import { vultureSamAbility } from "./characters/vulture-sam.js";
import { willyTheKidAbility } from "./characters/willy-the-kid.js";
import type { EffectRuntimeRegistry } from "./runtime/index.js";

/** A card registration uses the T65 physical/effective catalog type ID. */
export type CardEffectRegistration = readonly [cardTypeId: BaseCardTypeId, module: CardEffectModule];

/** Keeps each character ID paired with the matching T65 hook/result module type. */
export type CharacterAbilityRegistration = {
  [C in CharacterAbilityId]: readonly [characterId: C, module: CharacterAbilityModule<C>];
}[CharacterAbilityId];

export interface StaticEffectRegistry extends EffectRuntimeRegistry {
  readonly cards: Readonly<Record<BaseCardTypeId, CardEffectModule>>;
  readonly characters: Readonly<{
    [C in CharacterAbilityId]: CharacterAbilityModule<C>;
  }>;
}

const CARD_EFFECTS = {
  barrel: equipmentEffect,
  dynamite: dynamiteInstallEffect,
  jail: jailEffect,
  mustang: equipmentEffect,
  remington: equipmentEffect,
  carabine: equipmentEffect,
  schofield: equipmentEffect,
  scope: equipmentEffect,
  volcanic: equipmentEffect,
  winchester: equipmentEffect,
  bang: bangEffect,
  beer: beerEffect,
  cat_balou: catBalouEffect,
  duel: duelEffect,
  gatling: gatlingEffect,
  general_store: generalStoreEffect,
  indians: indiansEffect,
  missed: missedEffect,
  panic: panicEffect,
  saloon: saloonEffect,
  stagecoach: stagecoachEffect,
  wells_fargo: wellsFargoEffect,
} satisfies Readonly<Record<BaseCardTypeId, CardEffectModule>>;

const CHARACTER_ABILITIES = {
  bart_cassidy: bartCassidyAbility,
  black_jack: blackJackAbility,
  calamity_janet: calamityJanetAbility,
  el_gringo: elGringoAbility,
  jesse_jones: jesseJonesAbility,
  jourdonnais: jourdonnaisAbility,
  kit_carlson: kitCarlsonAbility,
  lucky_duke: luckyDukeAbility,
  paul_regret: paulRegretAbility,
  pedro_ramirez: pedroRamirezAbility,
  rose_doolan: roseDoolanAbility,
  sid_ketchum: sidKetchumAbility,
  slab_the_killer: slabAbility,
  suzy_lafayette: suzyLafayetteAbility,
  vulture_sam: vultureSamAbility,
  willy_the_kid: willyTheKidAbility,
} satisfies Readonly<{
  [C in CharacterAbilityId]: CharacterAbilityModule<C>;
}>;

const CARD_TYPE_IDS = Object.keys(CARD_EFFECTS) as BaseCardTypeId[];
const CHARACTER_IDS = Object.keys(CHARACTER_ABILITIES) as CharacterAbilityId[];

const DEFAULT_CARD_REGISTRATIONS = Object.entries(CARD_EFFECTS) as unknown as readonly CardEffectRegistration[];
const DEFAULT_CHARACTER_REGISTRATIONS = Object.entries(CHARACTER_ABILITIES) as unknown as readonly CharacterAbilityRegistration[];

function assertCatalogIdsMatchContract(
  kind: "card" | "character",
  contractIds: readonly string[],
  catalogIds: readonly string[],
): void {
  const expected = new Set(contractIds);
  const actual = new Set(catalogIds);
  const missing = contractIds.filter((id) => !actual.has(id));
  const unknown = catalogIds.filter((id) => !expected.has(id));
  if (catalogIds.length !== actual.size || missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `The ${kind} registry IDs do not match the base catalog (missing: ${missing.join(", ") || "none"}; ` +
      `unknown: ${unknown.join(", ") || "none"}; duplicate catalog IDs: ${catalogIds.length - actual.size}).`,
    );
  }
}

function indexRegistrations<Id extends string, Module>(
  kind: "card" | "character",
  expectedIds: readonly Id[],
  registrations: unknown,
): Record<Id, Module> {
  if (!Array.isArray(registrations)) {
    throw new TypeError(`The ${kind} registry entries must be an array.`);
  }

  const expected = new Set<string>(expectedIds);
  const indexed: Record<string, Module> = Object.create(null) as Record<string, Module>;
  for (const [index, entry] of registrations.entries()) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new TypeError(`The ${kind} registry entry at index ${index} must be an [id, module] pair.`);
    }
    const [id, module] = entry as unknown as readonly [unknown, unknown];
    if (typeof id !== "string" || !expected.has(id)) {
      throw new RangeError(`Unknown ${kind} registry ID '${String(id)}'.`);
    }
    if (Object.prototype.hasOwnProperty.call(indexed, id)) {
      throw new Error(`Duplicate ${kind} registry ID '${id}'.`);
    }
    if (typeof module !== "function") {
      throw new TypeError(`The ${kind} registry module for '${id}' must be a function.`);
    }
    indexed[id] = module as Module;
  }

  const missing = expectedIds.filter((id) => !Object.prototype.hasOwnProperty.call(indexed, id));
  if (missing.length > 0) {
    throw new Error(`Missing ${kind} registry ID${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`);
  }
  return indexed as Record<Id, Module>;
}

/**
 * Builds a complete runtime-compatible registry and rejects duplicate,
 * missing, and unknown identifiers before it can be injected into T66/T67.
 */
export function buildEffectRegistry(
  cardRegistrations: readonly CardEffectRegistration[],
  characterRegistrations: readonly CharacterAbilityRegistration[],
): StaticEffectRegistry {
  assertCatalogIdsMatchContract(
    "card",
    CARD_TYPE_IDS,
    BASE_CARD_DEFINITIONS.map(({ typeId }) => typeId),
  );
  assertCatalogIdsMatchContract(
    "character",
    CHARACTER_IDS,
    BASE_CHARACTERS.map(({ id }) => id),
  );

  const cards = indexRegistrations<BaseCardTypeId, CardEffectModule>("card", CARD_TYPE_IDS, cardRegistrations);
  const characters = indexRegistrations<CharacterAbilityId, CharacterAbilityModule<CharacterAbilityId>>(
    "character",
    CHARACTER_IDS,
    characterRegistrations,
  );
  return { cards, characters } as StaticEffectRegistry;
}

/** Creates the complete base-game card and character registry. */
export function createEffectRegistry(): StaticEffectRegistry {
  return buildEffectRegistry(DEFAULT_CARD_REGISTRATIONS, DEFAULT_CHARACTER_REGISTRATIONS);
}
