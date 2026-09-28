import {
  BASE_DECK_RULESET_VERSION,
  BASE_PHYSICAL_CARDS,
} from "../../../catalog/src/cards/index.js";
import { characters } from "../../../catalog/src/characters/index.js";
import { roles } from "../../../catalog/src/roles/index.js";
import type { PlayerCount, RoleId } from "../../../catalog/src/schema.js";
import { shuffle, type RandomSource } from "../random/shuffle.js";
import type { CardInstance, GameState, SeatState } from "../state/types.js";

const PLAYER_COUNTS = [4, 5, 6, 7] as const satisfies readonly PlayerCount[];
const BASE_DECK_CARD_COUNT = 80;

export interface SetupPlayer {
  /** Stable server-assigned player identity. Input order is clockwise seating. */
  playerId: string;
  displayName: string;
}

export interface InitializeGameOptions {
  /** Players in their room's clockwise seat order. */
  players: readonly SetupPlayer[];
  /** Caller-provided seeded randomness; setup does not use global randomness. */
  random: RandomSource;
}

function validatePlayers(players: readonly SetupPlayer[]): PlayerCount {
  if (!PLAYER_COUNTS.includes(players.length as PlayerCount)) {
    throw new RangeError("A base-game match requires 4 through 7 players.");
  }

  const playerIds = new Set<string>();
  for (const player of players) {
    if (typeof player.playerId !== "string" || player.playerId.trim().length === 0) {
      throw new TypeError("Each setup player requires a non-empty playerId.");
    }
    if (playerIds.has(player.playerId)) {
      throw new TypeError(`Duplicate setup playerId '${player.playerId}'.`);
    }
    playerIds.add(player.playerId);
  }

  return players.length as PlayerCount;
}

function expandedRoles(playerCount: PlayerCount): RoleId[] {
  const cardRoles: RoleId[] = [];
  for (const role of roles) {
    for (let copy = 0; copy < role.countsByPlayerCount[playerCount]; copy += 1) {
      cardRoles.push(role.id);
    }
  }
  if (cardRoles.length !== playerCount) {
    throw new Error(`Catalog role distribution for ${playerCount} players is inconsistent.`);
  }
  return cardRoles;
}

function randomHexWord(random: RandomSource): string {
  const sample = random.nextFloat();
  if (!Number.isFinite(sample) || sample < 0 || sample >= 1) {
    throw new RangeError("RandomSource.nextFloat() must return a finite value in [0, 1).");
  }
  return Math.floor(sample * 0x1_0000_0000).toString(16).padStart(8, "0");
}

function createCardInstanceId(index: number, random: RandomSource): string {
  const randomPart = Array.from({ length: 4 }, () => randomHexWord(random)).join("");
  // The per-match ordinal guarantees uniqueness even if a valid RNG repeats a sample.
  return `ci_${randomPart}_${index.toString(36)}`;
}

function createCardInstances(
  shuffledPhysicalCards: typeof BASE_PHYSICAL_CARDS,
  random: RandomSource,
): { cardsByInstanceId: Record<string, CardInstance>; shuffledCardIds: string[] } {
  if (
    shuffledPhysicalCards.length !== BASE_DECK_CARD_COUNT ||
    new Set(shuffledPhysicalCards.map((card) => card.definitionId)).size !== BASE_DECK_CARD_COUNT
  ) {
    throw new Error("The base-game physical card catalog must contain 80 unique cards.");
  }

  const cardsByInstanceId: Record<string, CardInstance> = {};
  const shuffledCardIds = shuffledPhysicalCards.map((card, index) => {
    const cardInstanceId = createCardInstanceId(index + 1, random);
    cardsByInstanceId[cardInstanceId] = {
      cardInstanceId,
      // definitionId identifies this exact printed physical card in the source catalog.
      cardDefinitionId: card.definitionId,
      rank: card.rank,
      suit: card.suit,
    };
    return cardInstanceId;
  });

  return { cardsByInstanceId, shuffledCardIds };
}

/**
 * Builds the initial base-game state from catalog data and caller-supplied RNG.
 * The input player order is clockwise; output seats are rotated so the Sheriff
 * is seat 0 while keeping the other players in the same clockwise order.
 */
export function initializeGame({ players, random }: InitializeGameOptions): GameState {
  const playerCount = validatePlayers(players);

  const assignedRoles = shuffle(expandedRoles(playerCount), random);
  const selectedCharacters = shuffle(characters, random).slice(0, playerCount);
  if (selectedCharacters.length !== playerCount) {
    throw new Error("The base-game character catalog does not contain enough characters.");
  }

  const shuffledPhysicalCards = shuffle(BASE_PHYSICAL_CARDS, random);
  const { cardsByInstanceId, shuffledCardIds } = createCardInstances(shuffledPhysicalCards, random);

  const sheriffInputIndex = assignedRoles.indexOf("sheriff");
  if (sheriffInputIndex < 0 || assignedRoles.lastIndexOf("sheriff") !== sheriffInputIndex) {
    throw new Error("The role distribution must contain exactly one Sheriff.");
  }

  const clockwiseAssignments = players.map((player, inputIndex) => ({
    player,
    roleId: assignedRoles[inputIndex]!,
    character: selectedCharacters[inputIndex]!,
  }));
  const sheriffFirstAssignments = [
    ...clockwiseAssignments.slice(sheriffInputIndex),
    ...clockwiseAssignments.slice(0, sheriffInputIndex),
  ];

  let nextCardIndex = 0;
  const seats: SeatState[] = sheriffFirstAssignments.map((assignment, seatIndex) => {
    const isSheriff = assignment.roleId === "sheriff";
    const maxHp = assignment.character.baseHealth + Number(isSheriff);
    const handCardInstanceIds = shuffledCardIds.slice(nextCardIndex, nextCardIndex + maxHp);
    nextCardIndex += maxHp;

    return {
      public: {
        playerId: assignment.player.playerId,
        displayName: assignment.player.displayName,
        seatIndex,
        characterId: assignment.character.id,
        hp: maxHp,
        maxHp,
        eliminated: false,
        roleRevealed: isSheriff,
        inPlayCardInstanceIds: [],
      },
      private: {
        roleId: assignment.roleId,
        handCardInstanceIds,
      },
    };
  });

  const sheriff = seats[0]!;
  return {
    schemaVersion: 1,
    rulesetVersion: BASE_DECK_RULESET_VERSION,
    status: "playing",
    pauseReason: null,
    version: 0,
    eventSeq: 0,
    seats,
    zones: {
      cardsByInstanceId,
      drawPileCardInstanceIds: shuffledCardIds.slice(nextCardIndex),
      discardPileCardInstanceIds: [],
      revealedPoolCardInstanceIds: [],
    },
    turn: {
      currentPlayerId: sheriff.public.playerId,
      phase: "start",
      bangCardPlaysThisTurn: 0,
      turnNumber: 1,
    },
    resolution: {
      effectQueue: [],
      continuations: [],
      pendingInteraction: null,
      pendingDeath: null,
      victoryCheckDeferredByEffectId: null,
    },
    outcome: null,
  };
}
