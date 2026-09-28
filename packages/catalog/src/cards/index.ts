import type { CardDefinition, Catalog, PhysicalCard } from "../schema.js";

/** Prepared source ruleset version for the base-game physical deck. */
export const BASE_DECK_RULESET_VERSION = "base4-ko-online-1.0";

/** One static definition per playing-card type, sourced from card-types.json. */
export const BASE_CARD_DEFINITIONS: CardDefinition[] = [
  {
    "typeId": "barrel",
    "name": "Barrel",
    "quantity": 2,
    "color": "blue",
    "assetPath": "cards/playing/01_barile.png"
  },
  {
    "typeId": "dynamite",
    "name": "Dynamite",
    "quantity": 1,
    "color": "blue",
    "assetPath": "cards/playing/01_dinamite.png"
  },
  {
    "typeId": "jail",
    "name": "Jail",
    "quantity": 3,
    "color": "blue",
    "assetPath": "cards/playing/01_prigione.png"
  },
  {
    "typeId": "mustang",
    "name": "Mustang",
    "quantity": 2,
    "color": "blue",
    "assetPath": "cards/playing/01_mustang.png"
  },
  {
    "typeId": "remington",
    "name": "Remington",
    "quantity": 1,
    "color": "blue",
    "assetPath": "cards/playing/01_remington.png"
  },
  {
    "typeId": "carabine",
    "name": "Rev. Carabine",
    "quantity": 1,
    "color": "blue",
    "assetPath": "cards/playing/01_carabine.png"
  },
  {
    "typeId": "schofield",
    "name": "Schofield",
    "quantity": 3,
    "color": "blue",
    "assetPath": "cards/playing/01_schofield.png"
  },
  {
    "typeId": "scope",
    "name": "Scope",
    "quantity": 1,
    "color": "blue",
    "assetPath": "cards/playing/01_mirino.png"
  },
  {
    "typeId": "volcanic",
    "name": "Volcanic",
    "quantity": 2,
    "color": "blue",
    "assetPath": "cards/playing/01_volcanic.png"
  },
  {
    "typeId": "winchester",
    "name": "Winchester",
    "quantity": 1,
    "color": "blue",
    "assetPath": "cards/playing/01_winchester.png"
  },
  {
    "typeId": "bang",
    "name": "BANG!",
    "quantity": 25,
    "color": "brown",
    "assetPath": "cards/playing/01_bang.png"
  },
  {
    "typeId": "beer",
    "name": "Beer",
    "quantity": 6,
    "color": "brown",
    "assetPath": "cards/playing/01_birra.png"
  },
  {
    "typeId": "cat_balou",
    "name": "Cat Balou",
    "quantity": 4,
    "color": "brown",
    "assetPath": "cards/playing/01_catbalou.png"
  },
  {
    "typeId": "duel",
    "name": "Duel",
    "quantity": 3,
    "color": "brown",
    "assetPath": "cards/playing/01_duello.png"
  },
  {
    "typeId": "gatling",
    "name": "Gatling",
    "quantity": 1,
    "color": "brown",
    "assetPath": "cards/playing/01_gatling.png"
  },
  {
    "typeId": "general_store",
    "name": "General Store",
    "quantity": 2,
    "color": "brown",
    "assetPath": "cards/playing/01_emporio.png"
  },
  {
    "typeId": "indians",
    "name": "Indians!",
    "quantity": 2,
    "color": "brown",
    "assetPath": "cards/playing/01_indiani.png"
  },
  {
    "typeId": "missed",
    "name": "Missed!",
    "quantity": 12,
    "color": "brown",
    "assetPath": "cards/playing/01_mancato.png"
  },
  {
    "typeId": "panic",
    "name": "Panic!",
    "quantity": 4,
    "color": "brown",
    "assetPath": "cards/playing/01_panico.png"
  },
  {
    "typeId": "saloon",
    "name": "Saloon",
    "quantity": 1,
    "color": "brown",
    "assetPath": "cards/playing/01_saloon.png"
  },
  {
    "typeId": "stagecoach",
    "name": "Stagecoach",
    "quantity": 2,
    "color": "brown",
    "assetPath": "cards/playing/01_diligenza.png"
  },
  {
    "typeId": "wells_fargo",
    "name": "Wells Fargo",
    "quantity": 1,
    "color": "brown",
    "assetPath": "cards/playing/01_wellsfargo.png"
  }
];

/** The 80 distinct physical cards, sourced from base-deck.json. */
export const BASE_PHYSICAL_CARDS: PhysicalCard[] = [
  {
    "definitionId": "barrel_01",
    "typeId": "barrel",
    "rank": "Q",
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "barrel_02",
    "typeId": "barrel",
    "rank": "K",
    "suit": "SPADES",
    "copyIndex": 2
  },
  {
    "definitionId": "dynamite_01",
    "typeId": "dynamite",
    "rank": 2,
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "jail_01",
    "typeId": "jail",
    "rank": "J",
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "jail_02",
    "typeId": "jail",
    "rank": 4,
    "suit": "HEARTS",
    "copyIndex": 2
  },
  {
    "definitionId": "jail_03",
    "typeId": "jail",
    "rank": 10,
    "suit": "SPADES",
    "copyIndex": 3
  },
  {
    "definitionId": "mustang_01",
    "typeId": "mustang",
    "rank": 8,
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "mustang_02",
    "typeId": "mustang",
    "rank": 9,
    "suit": "HEARTS",
    "copyIndex": 2
  },
  {
    "definitionId": "remington_01",
    "typeId": "remington",
    "rank": "K",
    "suit": "CLUBS",
    "copyIndex": 1
  },
  {
    "definitionId": "carabine_01",
    "typeId": "carabine",
    "rank": "A",
    "suit": "CLUBS",
    "copyIndex": 1
  },
  {
    "definitionId": "schofield_01",
    "typeId": "schofield",
    "rank": "J",
    "suit": "CLUBS",
    "copyIndex": 1
  },
  {
    "definitionId": "schofield_02",
    "typeId": "schofield",
    "rank": "Q",
    "suit": "CLUBS",
    "copyIndex": 2
  },
  {
    "definitionId": "schofield_03",
    "typeId": "schofield",
    "rank": "K",
    "suit": "SPADES",
    "copyIndex": 3
  },
  {
    "definitionId": "scope_01",
    "typeId": "scope",
    "rank": "A",
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "volcanic_01",
    "typeId": "volcanic",
    "rank": 10,
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "volcanic_02",
    "typeId": "volcanic",
    "rank": 10,
    "suit": "CLUBS",
    "copyIndex": 2
  },
  {
    "definitionId": "winchester_01",
    "typeId": "winchester",
    "rank": 8,
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "bang_01",
    "typeId": "bang",
    "rank": "A",
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "bang_02",
    "typeId": "bang",
    "rank": 2,
    "suit": "DIAMONDS",
    "copyIndex": 2
  },
  {
    "definitionId": "bang_03",
    "typeId": "bang",
    "rank": 3,
    "suit": "DIAMONDS",
    "copyIndex": 3
  },
  {
    "definitionId": "bang_04",
    "typeId": "bang",
    "rank": 4,
    "suit": "DIAMONDS",
    "copyIndex": 4
  },
  {
    "definitionId": "bang_05",
    "typeId": "bang",
    "rank": 5,
    "suit": "DIAMONDS",
    "copyIndex": 5
  },
  {
    "definitionId": "bang_06",
    "typeId": "bang",
    "rank": 6,
    "suit": "DIAMONDS",
    "copyIndex": 6
  },
  {
    "definitionId": "bang_07",
    "typeId": "bang",
    "rank": 7,
    "suit": "DIAMONDS",
    "copyIndex": 7
  },
  {
    "definitionId": "bang_08",
    "typeId": "bang",
    "rank": 8,
    "suit": "DIAMONDS",
    "copyIndex": 8
  },
  {
    "definitionId": "bang_09",
    "typeId": "bang",
    "rank": 9,
    "suit": "DIAMONDS",
    "copyIndex": 9
  },
  {
    "definitionId": "bang_10",
    "typeId": "bang",
    "rank": 10,
    "suit": "DIAMONDS",
    "copyIndex": 10
  },
  {
    "definitionId": "bang_11",
    "typeId": "bang",
    "rank": "J",
    "suit": "DIAMONDS",
    "copyIndex": 11
  },
  {
    "definitionId": "bang_12",
    "typeId": "bang",
    "rank": "Q",
    "suit": "DIAMONDS",
    "copyIndex": 12
  },
  {
    "definitionId": "bang_13",
    "typeId": "bang",
    "rank": "K",
    "suit": "DIAMONDS",
    "copyIndex": 13
  },
  {
    "definitionId": "bang_14",
    "typeId": "bang",
    "rank": "A",
    "suit": "DIAMONDS",
    "copyIndex": 14
  },
  {
    "definitionId": "bang_15",
    "typeId": "bang",
    "rank": 2,
    "suit": "CLUBS",
    "copyIndex": 15
  },
  {
    "definitionId": "bang_16",
    "typeId": "bang",
    "rank": 3,
    "suit": "CLUBS",
    "copyIndex": 16
  },
  {
    "definitionId": "bang_17",
    "typeId": "bang",
    "rank": 4,
    "suit": "CLUBS",
    "copyIndex": 17
  },
  {
    "definitionId": "bang_18",
    "typeId": "bang",
    "rank": 5,
    "suit": "CLUBS",
    "copyIndex": 18
  },
  {
    "definitionId": "bang_19",
    "typeId": "bang",
    "rank": 6,
    "suit": "CLUBS",
    "copyIndex": 19
  },
  {
    "definitionId": "bang_20",
    "typeId": "bang",
    "rank": 7,
    "suit": "CLUBS",
    "copyIndex": 20
  },
  {
    "definitionId": "bang_21",
    "typeId": "bang",
    "rank": 8,
    "suit": "CLUBS",
    "copyIndex": 21
  },
  {
    "definitionId": "bang_22",
    "typeId": "bang",
    "rank": 9,
    "suit": "CLUBS",
    "copyIndex": 22
  },
  {
    "definitionId": "bang_23",
    "typeId": "bang",
    "rank": "Q",
    "suit": "HEARTS",
    "copyIndex": 23
  },
  {
    "definitionId": "bang_24",
    "typeId": "bang",
    "rank": "K",
    "suit": "HEARTS",
    "copyIndex": 24
  },
  {
    "definitionId": "bang_25",
    "typeId": "bang",
    "rank": "A",
    "suit": "HEARTS",
    "copyIndex": 25
  },
  {
    "definitionId": "beer_01",
    "typeId": "beer",
    "rank": 6,
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "beer_02",
    "typeId": "beer",
    "rank": 7,
    "suit": "HEARTS",
    "copyIndex": 2
  },
  {
    "definitionId": "beer_03",
    "typeId": "beer",
    "rank": 8,
    "suit": "HEARTS",
    "copyIndex": 3
  },
  {
    "definitionId": "beer_04",
    "typeId": "beer",
    "rank": 9,
    "suit": "HEARTS",
    "copyIndex": 4
  },
  {
    "definitionId": "beer_05",
    "typeId": "beer",
    "rank": 10,
    "suit": "HEARTS",
    "copyIndex": 5
  },
  {
    "definitionId": "beer_06",
    "typeId": "beer",
    "rank": "J",
    "suit": "HEARTS",
    "copyIndex": 6
  },
  {
    "definitionId": "cat_balou_01",
    "typeId": "cat_balou",
    "rank": "K",
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "cat_balou_02",
    "typeId": "cat_balou",
    "rank": 9,
    "suit": "DIAMONDS",
    "copyIndex": 2
  },
  {
    "definitionId": "cat_balou_03",
    "typeId": "cat_balou",
    "rank": 10,
    "suit": "DIAMONDS",
    "copyIndex": 3
  },
  {
    "definitionId": "cat_balou_04",
    "typeId": "cat_balou",
    "rank": "J",
    "suit": "DIAMONDS",
    "copyIndex": 4
  },
  {
    "definitionId": "duel_01",
    "typeId": "duel",
    "rank": "Q",
    "suit": "DIAMONDS",
    "copyIndex": 1
  },
  {
    "definitionId": "duel_02",
    "typeId": "duel",
    "rank": "J",
    "suit": "SPADES",
    "copyIndex": 2
  },
  {
    "definitionId": "duel_03",
    "typeId": "duel",
    "rank": 8,
    "suit": "CLUBS",
    "copyIndex": 3
  },
  {
    "definitionId": "gatling_01",
    "typeId": "gatling",
    "rank": 10,
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "general_store_01",
    "typeId": "general_store",
    "rank": 9,
    "suit": "CLUBS",
    "copyIndex": 1
  },
  {
    "definitionId": "general_store_02",
    "typeId": "general_store",
    "rank": "Q",
    "suit": "SPADES",
    "copyIndex": 2
  },
  {
    "definitionId": "indians_01",
    "typeId": "indians",
    "rank": "K",
    "suit": "DIAMONDS",
    "copyIndex": 1
  },
  {
    "definitionId": "indians_02",
    "typeId": "indians",
    "rank": "A",
    "suit": "DIAMONDS",
    "copyIndex": 2
  },
  {
    "definitionId": "missed_01",
    "typeId": "missed",
    "rank": 10,
    "suit": "CLUBS",
    "copyIndex": 1
  },
  {
    "definitionId": "missed_02",
    "typeId": "missed",
    "rank": "J",
    "suit": "CLUBS",
    "copyIndex": 2
  },
  {
    "definitionId": "missed_03",
    "typeId": "missed",
    "rank": "Q",
    "suit": "CLUBS",
    "copyIndex": 3
  },
  {
    "definitionId": "missed_04",
    "typeId": "missed",
    "rank": "K",
    "suit": "CLUBS",
    "copyIndex": 4
  },
  {
    "definitionId": "missed_05",
    "typeId": "missed",
    "rank": "A",
    "suit": "CLUBS",
    "copyIndex": 5
  },
  {
    "definitionId": "missed_06",
    "typeId": "missed",
    "rank": 2,
    "suit": "SPADES",
    "copyIndex": 6
  },
  {
    "definitionId": "missed_07",
    "typeId": "missed",
    "rank": 3,
    "suit": "SPADES",
    "copyIndex": 7
  },
  {
    "definitionId": "missed_08",
    "typeId": "missed",
    "rank": 4,
    "suit": "SPADES",
    "copyIndex": 8
  },
  {
    "definitionId": "missed_09",
    "typeId": "missed",
    "rank": 5,
    "suit": "SPADES",
    "copyIndex": 9
  },
  {
    "definitionId": "missed_10",
    "typeId": "missed",
    "rank": 6,
    "suit": "SPADES",
    "copyIndex": 10
  },
  {
    "definitionId": "missed_11",
    "typeId": "missed",
    "rank": 7,
    "suit": "SPADES",
    "copyIndex": 11
  },
  {
    "definitionId": "missed_12",
    "typeId": "missed",
    "rank": 8,
    "suit": "SPADES",
    "copyIndex": 12
  },
  {
    "definitionId": "panic_01",
    "typeId": "panic",
    "rank": "J",
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "panic_02",
    "typeId": "panic",
    "rank": "Q",
    "suit": "HEARTS",
    "copyIndex": 2
  },
  {
    "definitionId": "panic_03",
    "typeId": "panic",
    "rank": "A",
    "suit": "HEARTS",
    "copyIndex": 3
  },
  {
    "definitionId": "panic_04",
    "typeId": "panic",
    "rank": 8,
    "suit": "DIAMONDS",
    "copyIndex": 4
  },
  {
    "definitionId": "saloon_01",
    "typeId": "saloon",
    "rank": 5,
    "suit": "HEARTS",
    "copyIndex": 1
  },
  {
    "definitionId": "stagecoach_01",
    "typeId": "stagecoach",
    "rank": 9,
    "suit": "SPADES",
    "copyIndex": 1
  },
  {
    "definitionId": "stagecoach_02",
    "typeId": "stagecoach",
    "rank": 9,
    "suit": "SPADES",
    "copyIndex": 2
  },
  {
    "definitionId": "wells_fargo_01",
    "typeId": "wells_fargo",
    "rank": 3,
    "suit": "HEARTS",
    "copyIndex": 1
  }
];

/** Normalized asset keys relative to outputs/assets, for catalog validation. */
export const BASE_CARD_ASSET_PATHS = BASE_CARD_DEFINITIONS.map(({ assetPath }) => assetPath);

export const BASE_DECK_CATALOG = {
  rulesetVersion: BASE_DECK_RULESET_VERSION,
  cardDefinitions: BASE_CARD_DEFINITIONS,
  physicalCards: BASE_PHYSICAL_CARDS,
} satisfies Pick<Catalog, "rulesetVersion" | "cardDefinitions" | "physicalCards">;
