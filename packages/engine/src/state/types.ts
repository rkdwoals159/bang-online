import type { CardRank, RoleId, Suit } from "../../../catalog/src/schema.js";

/** State values are JSON-compatible and are persisted by the server as one snapshot. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type MatchStatus = "playing" | "paused" | "completed" | "recovery_required";
export type PauseReason = "RULE_RESOURCE_EXHAUSTED";
export type TurnPhase = "start" | "draw" | "play" | "discard";
export type WinningFaction = "sheriff_and_deputies" | "outlaws" | "renegade";

/**
 * A runtime card is distinct from its public catalog entry. Its opaque ID is
 * generated for one match; catalog data supplies the definition and printed face.
 */
export interface CardInstance {
  cardInstanceId: string;
  cardDefinitionId: string;
  rank: CardRank;
  suit: Suit;
}

/** A card's current zone is represented by membership in exactly one ID list. */
export interface CardZones {
  cardsByInstanceId: Record<string, CardInstance>;
  /** Index 0 is the next card drawn. */
  drawPileCardInstanceIds: string[];
  /** The last ID is the visible top card, matching the discard-order convention. */
  discardPileCardInstanceIds: string[];
  /** Temporary face-up cards that have not yet completed their resolution. */
  revealedPoolCardInstanceIds: string[];
}

/** Public fields are separated from each player's role and hand data in the internal state. */
export interface PlayerPublicState {
  playerId: string;
  displayName: string;
  seatIndex: number;
  characterId: string;
  hp: number;
  maxHp: number;
  eliminated: boolean;
  roleRevealed: boolean;
  inPlayCardInstanceIds: string[];
}

export interface PlayerPrivateState {
  roleId: RoleId;
  handCardInstanceIds: string[];
}

export interface SeatState {
  public: PlayerPublicState;
  private: PlayerPrivateState;
}

export interface TurnState {
  currentPlayerId: string;
  phase: TurnPhase;
  /** Number of BANG! cards played during this turn; response cards are excluded. */
  bangCardPlaysThisTurn: number;
  turnNumber: number;
}

/** A serializable step in the ordered effect queue; behavior is implemented by later tasks. */
export interface EffectStep {
  effectId: string;
  kind: string;
  sourcePlayerId: string | null;
  targetPlayerId: string | null;
  sourceCardInstanceId: string | null;
  payload: { [key: string]: JsonValue };
}

/** A saved execution frame for resuming a card after a player choice or death flow. */
export interface ResolutionFrame {
  frameId: string;
  kind: string;
  sourcePlayerId: string | null;
  sourceCardInstanceId: string | null;
  payload: { [key: string]: JsonValue };
}

export interface InteractionOption {
  choice: string;
  payload: { [key: string]: JsonValue };
}

/** Private engine continuation data; the client receives a separate projection DTO. */
export interface PendingInteraction {
  interactionId: string;
  kind: string;
  actorPlayerIds: string[];
  options: InteractionOption[];
  context: { [key: string]: JsonValue };
  resumeFrameId: string | null;
  createdAt: string;
}

export interface PendingDeath {
  victimPlayerId: string;
  sourcePlayerId: string | null;
  rescueResponderIds: string[];
  rescueCursor: number;
  consequenceStage: "rescue" | "elimination" | "cleanup" | "win_check";
  resumeFrameId: string | null;
}

export interface ResolutionState {
  effectQueue: EffectStep[];
  continuations: ResolutionFrame[];
  pendingInteraction: PendingInteraction | null;
  pendingDeath: PendingDeath | null;
  /** Defer victory evaluation until this card's full multi-target effect finishes. */
  victoryCheckDeferredByEffectId: string | null;
}

export interface MatchOutcome {
  winningFaction: WinningFaction;
  winningPlayerIds: string[];
}

/**
 * Full server-authoritative snapshot. Never serialize this type to a browser;
 * T07 builds the viewer-specific contracts projection from it.
 */
export interface GameState {
  schemaVersion: number;
  rulesetVersion: string;
  status: MatchStatus;
  pauseReason: PauseReason | null;
  version: number;
  eventSeq: number;
  seats: SeatState[];
  zones: CardZones;
  turn: TurnState;
  resolution: ResolutionState;
  outcome: MatchOutcome | null;
}

/** Architecture documents call the persisted snapshot a MatchState. */
export type MatchState = GameState;
