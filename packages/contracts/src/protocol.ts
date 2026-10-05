export const PROTOCOL_VERSION = 1 as const;

export type Suit = "SPADES" | "HEARTS" | "DIAMONDS" | "CLUBS";
export type RoleId = "sheriff" | "deputy" | "outlaw" | "renegade";
export type MatchStatus = "playing" | "paused" | "completed" | "recovery_required";
export type SeatMode = "active" | "eliminated_observer";
export type RoomStatus = "waiting" | "starting" | "in_game" | "paused" | "completed" | "closed";

export interface CommandBase {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  expectedVersion: number;
}

export interface MatchCommandBase extends CommandBase { matchId: string }
export type MatchCommand = MatchCommandBase & (
  | { type: "PLAY_CARD"; payload: PlayCardPayload }
  | { type: "RESPOND"; payload: RespondPayload }
  | { type: "USE_ABILITY"; payload: UseAbilityPayload }
  | { type: "END_TURN"; payload: Record<string, never> }
);

export interface PlayCardPayload {
  cardInstanceId: string;
  targetPlayerId?: string;
  targetZone?: "HAND" | "IN_PLAY";
  targetCardInstanceId?: string;
  asCardType?: string;
}

export type RespondPayload =
  | { interactionId: string; choice: "USE_MISSED" | "USE_BANG" | "PLAY_BANG" | "USE_BEER"; cardInstanceId: string }
  | { interactionId: string; choice: "USE_BARREL" | "USE_JOURDONNAIS" | "TAKE_HIT" | "YIELD" | "ACCEPT_ELIMINATION" | "DRAW_PILE" }
  | { interactionId: string; choice: "USE_SID"; cardInstanceIds: [string, string] }
  | { interactionId: string; choice: "ORDER_CARDS"; orderedCardInstanceIds: string[] }
  | { interactionId: string; choice: "TAKE_CARD" | "CHOOSE_CARD"; selectedCardInstanceId: string }
  | { interactionId: string; choice: "CHOOSE_CARDS"; selectedCardInstanceIds: [string, string] }
  | { interactionId: string; choice: "OPPONENT_HAND"; targetPlayerId: string }
  | { interactionId: string; choice: "CHOOSE_SOURCE" | "SELECT_SOURCE"; source: "DISCARD_TOP" | "DRAW_PILE_TOP" }
  | { interactionId: string; choice: "DRAW_FROM_PILE" }
  | { interactionId: string; choice: "TAKE_FROM_HAND"; sourcePlayerId: string }
  | { interactionId: string; choice: "SELECT_JUDGMENT"; selectedCardInstanceId: string; orderedCardInstanceIds: [string, string] };

/** Pending chooser template for a response whose final command payload is entered by its actor. */
export type PendingRespondOption = RespondPayload | {
  interactionId: string;
  choice: "ORDER_CARDS";
};

export interface UseAbilityPayload {
  abilityId: "sid-ketchum";
  cardInstanceIds: [string, string];
}

export type RoomCommand = CommandBase & (
  | { type: "CREATE_ROOM"; payload: CreateRoomPayload }
  | { type: "JOIN"; roomId: string; payload: { inviteCode: string } }
  | { type: "SET_READY"; roomId: string; payload: { ready: boolean } }
  | { type: "SET_RULESET"; roomId: string; payload: { rulesetVersion: string } }
  | { type: "START_MATCH"; roomId: string; payload: Record<string, never> }
  | { type: "RETURN_TO_LOBBY"; roomId: string; payload: Record<string, never> }
  | { type: "CLOSE_ROOM"; roomId: string; payload: Record<string, never> }
  | { type: "KICK_MEMBER"; roomId: string; payload: { targetPlayerId: string } }
);

export interface CreateRoomPayload {
  capacity: 4 | 5 | 6 | 7;
  rulesetVersion: "base4-ko-online-1.0";
  displayName: string;
}

export interface GuestSessionRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  displayName: string;
}
export interface GuestSessionResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  player: { playerId: string; displayName: string };
  sessionExpiresAt: string;
}

export interface CommandAccepted {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  status: "accepted";
  duplicate: boolean;
  aggregateVersion: number;
  eventSeq: number;
  /** Fresh match writes may return the committed viewer projection with their ACK. */
  matchProjection?: { snapshot: MatchSnapshotView; visibleEvents: readonly PublicMatchEvent[] };
}
export interface CommandRejected {
  protocolVersion: typeof PROTOCOL_VERSION;
  commandId: string;
  status: "rejected";
  error: { code: string; messageKey: string; retryable: boolean; currentVersion?: number; retryAfterMs?: number };
}
export type CommandAck = CommandAccepted | CommandRejected;

export interface MatchSyncRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  matchId: string;
  knownVersion: number;
  afterEventSeq: number;
  /** Opt in only when the client retains the matching canonical projection. */
  acceptUnchanged?: true;
}
export interface RoomSyncRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  roomId: string;
  knownVersion: number;
  acceptUnchanged?: true;
}
export interface RoomPreviewRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  inviteCode: string;
}

export type RoomPreviewErrorCode = "BAD_REQUEST" | "INVITE_INVALID" | "RATE_LIMITED";
export type SyncRejectedErrorCode = "BAD_REQUEST" | "NOT_FOUND_OR_FORBIDDEN" | "RECOVERY_REQUIRED";

/** A preview response intentionally contains neither the raw invite code nor a session credential. */
export interface RoomPreviewSuccess {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  roomId: string;
  version: number;
  occupancy: number;
  status: RoomStatus;
}
export interface RoomPreviewRejected {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  status: "rejected";
  error:
    | { code: "BAD_REQUEST" | "INVITE_INVALID" }
    | { code: "RATE_LIMITED"; retryAfterMs: number };
}
export type RoomPreviewResponse = RoomPreviewSuccess | RoomPreviewRejected;

/** Shared room/match sync rejection; resource IDs are omitted to avoid existence disclosure. */
export interface SyncRejectedResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  status: "rejected";
  error: { code: SyncRejectedErrorCode };
}

export interface CardFaceView { cardInstanceId: string; typeId: string; rank: string; suit: Suit }
export interface PublicPlayerView {
  playerId: string;
  displayName: string;
  seatIndex: number;
  characterId: string;
  hp: number;
  maxHp: number;
  eliminated: boolean;
  handCount: number;
  /** Null for a role that remains secret to this viewer. */
  role: RoleId | null;
  inPlay: readonly CardFaceView[];
}

/** A viewer-scoped legal proposal contains only a canonical command type and payload. */
export type LegalActionProposal =
  | Pick<Extract<MatchCommand, { type: "PLAY_CARD" }>, "type" | "payload">
  | (Pick<Extract<MatchCommand, { type: "USE_ABILITY" }>, "type" | "payload"> & {
      /** Any distinct pair from this server-validated set is an allowed Sid cost. */
      costSelection?: { requiredCount: 2; allowedCardInstanceIds: readonly string[] };
    })
  | Pick<Extract<MatchCommand, { type: "END_TURN" }>, "type" | "payload">;

export interface InteractionProgressStepView {
  /** One-based current step in the public interaction sequence. */
  current: number;
  total: number;
}

/** Legacy v1 shape retained for current consumers during the additive projection rollout. */
export interface LegacyPendingInteractionView {
  interactionId: string;
  kind: string;
  allowedChoices: readonly string[];
}

/** Non-responders see progress only; legacy allowedChoices is present but empty. */
export interface PendingInteractionProgressView {
  interactionId: string;
  kind: string;
  allowedChoices: readonly [];
  currentResponderPlayerId: string;
  step: InteractionProgressStepView;
}

/** Exact server-saved discard candidates and count, visible only to the responder. */
export interface PendingDiscardOrderView {
  requiredCount: number;
  allowedCards: readonly CardFaceView[];
}

/** Only the current responder receives saved response choices/options. */
export interface PendingInteractionResponderView {
  interactionId: string;
  kind: string;
  allowedChoices: readonly string[];
  currentResponderPlayerId: string;
  step: InteractionProgressStepView;
  responseOptions: readonly PendingRespondOption[];
  /** Present only for DISCARDS_ORDER; never sent to other viewers. */
  discardOrder?: PendingDiscardOrderView;
  /** Kit's three candidates, visible only to the current responder. */
  choiceCards?: readonly CardFaceView[];
}

export type PendingInteractionView =
  | LegacyPendingInteractionView
  | PendingInteractionProgressView
  | PendingInteractionResponderView;

export type WinningFaction = "sheriff_and_deputies" | "outlaws" | "renegade";

/** Public result summary; this is added to a snapshot only after match completion. */
export interface MatchOutcomeView {
  winningFaction: WinningFaction;
  winningPlayerIds: readonly string[];
}

export interface MatchSnapshotView {
  status: MatchStatus;
  viewer: { playerId: string; seatIndex: number; mode: SeatMode };
  publicTable: {
    players: readonly PublicPlayerView[];
    turn: { currentPlayerId: string; phase: string };
    /** Remaining draw-pile size only; card identities and order stay private. */
    deckCount: number;
    publicDiscard: { topCard: CardFaceView | null; count: number };
    /** Remaining public pool only while GENERAL_STORE_PICK is pending. */
    generalStoreCards?: readonly CardFaceView[];
    /** Shared status only; another player's hand options and reserved choice remain private. */
    tablewideAttack?: TablewideAttackView;
    /** C08: both judgment candidates are public before Lucky chooses. */
    luckyJudgment?: { sourceKind: "jail" | "dynamite" | "barrel" | "jourdonnais_virtual_barrel"; cards: readonly CardFaceView[] };
  };
  /** Present only to the authenticated active viewer; their own hand stays private even when their role is public. */
  selfPrivate: { role: RoleId; hand: readonly CardFaceView[] } | null;
  /** Additive v1 field. T69 producers provide only this viewer's command proposals. */
  legalActions?: readonly LegalActionProposal[];
  /** Present only when `status` is `completed`; never expose a pending winner. */
  outcome?: MatchOutcomeView;
  pendingInteraction: PendingInteractionView | null;
}
export interface TablewideAttackView {
  attackId: string;
  kind: "gatling" | "indians";
  sourcePlayerId: string;
  targets: readonly { playerId: string; status: "waiting" | "submitted" | "responding" | "resolved" | "eliminated" }[];
}
export interface PublicMatchEvent {
  eventSeq: number;
  type: string;
  occurredAt: string;
  payload: Readonly<Record<string, unknown>>;
}
export interface MatchSyncResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  matchId: string;
  version: number;
  eventSeq: number;
  requiresFullSnapshot: boolean;
  snapshot: MatchSnapshotView;
  visibleEvents: readonly PublicMatchEvent[];
}
export type MatchSyncReply = MatchSyncResponse | SyncRejectedResponse | SyncUnchangedResponse;
/** A lightweight, authorized response; never usable without a matching local projection. */
export type SyncUnchangedResponse =
  | { protocolVersion: typeof PROTOCOL_VERSION; requestId: string; status: "unchanged"; roomId: string; version: number }
  | { protocolVersion: typeof PROTOCOL_VERSION; requestId: string; status: "unchanged"; matchId: string; version: number; eventSeq: number };
export type RoomConnectionState = "connected" | "disconnected" | "unknown";
/** Membership-scoped SSE observation, separate from authoritative game versions. */
export interface RoomPresenceView {
  protocolVersion: typeof PROTOCOL_VERSION;
  roomId: string;
  observedAt: string;
  members: readonly { playerId: string; connectionState: RoomConnectionState }[];
}
export interface RoomView {
  roomId: string;
  status: RoomStatus;
  /** The room's current/last match route; null until a match has started. */
  activeMatchId: string | null;
  ownerPlayerId: string;
  capacity: 4 | 5 | 6 | 7;
  rulesetVersion: string;
  /** Additive canonical projection version, including room-command responses. */
  version?: number;
  members: readonly { playerId: string; displayName: string; seatIndex: number; ready: boolean; connectionState?: RoomConnectionState }[];
  viewer: { playerId: string; isOwner: boolean };
}
export interface RoomSyncResponse {
  protocolVersion: typeof PROTOCOL_VERSION;
  requestId: string;
  roomId: string;
  version: number;
  requiresFullSnapshot: boolean;
  room: RoomView;
}
export type RoomSyncReply = RoomSyncResponse | SyncRejectedResponse | SyncUnchangedResponse;

export type ServerEvent =
  | { event: "room:changed"; payload: { roomId: string; version: number } }
  | { event: "match:changed"; payload: { matchId: string; version: number; eventSeq: number } }
  | { event: "match:presence"; payload: { matchId: string; playerId: string; seatIndex: number; connectionState: "connected" | "disconnected"; observedAt: string } }
  | { event: "session:expired"; payload: { protocolVersion: typeof PROTOCOL_VERSION } }
  | { event: "server:maintenance"; payload: { protocolVersion: typeof PROTOCOL_VERSION } };
