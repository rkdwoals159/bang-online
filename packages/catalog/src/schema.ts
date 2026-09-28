export const PLAYER_COUNTS = [4, 5, 6, 7] as const;

export type PlayerCount = (typeof PLAYER_COUNTS)[number];
export type Suit = "SPADES" | "HEARTS" | "DIAMONDS" | "CLUBS";
export type CardColor = "blue" | "brown";
export type CardRank = number | "A" | "J" | "Q" | "K";
export type RoleId = "sheriff" | "deputy" | "outlaw" | "renegade";

/** Static face data shared by every physical copy of a playing-card type. */
export interface CardDefinition extends AssetReference {
  typeId: string;
  name: string;
  quantity: number;
  color: CardColor;
}

/** One physical card in the base deck, with its own stable source identifier. */
export interface PhysicalCard {
  definitionId: string;
  typeId: string;
  rank: CardRank;
  suit: Suit;
  copyIndex: number;
}

export interface RoleDefinition extends AssetReference {
  id: RoleId;
  name: string;
  countsByPlayerCount: Record<PlayerCount, number>;
}

export interface CharacterDefinition extends AssetReference {
  id: string;
  name: string;
  baseHealth: number;
  ruleId: string;
}

export interface Catalog {
  rulesetVersion: string;
  cardDefinitions: CardDefinition[];
  physicalCards: PhysicalCard[];
  roles: RoleDefinition[];
  characters: CharacterDefinition[];
}

/** An asset path is relative to the prepared asset root, never a URL. */
export interface AssetReference {
  assetPath: string;
}
