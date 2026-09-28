import type {
  CommandAck,
  LegalActionProposal,
  MatchCommand,
  MatchOutcomeView,
  MatchSnapshotView,
  MatchSyncRequest,
  MatchSyncReply,
  PendingInteractionProgressView,
  PendingDiscardOrderView,
  PendingRespondOption,
  PendingInteractionResponderView,
  PublicPlayerView,
  RoomCommand,
  RoomPreviewRequest,
  RoomPreviewResponse,
  RoomPreviewSuccess,
  RoomSyncRequest,
  RoomSyncReply,
  ServerEvent,
  RespondPayload,
  SyncRejectedResponse,
} from "../src/index.js";

const matchCommand: MatchCommand = {
  protocolVersion: 1, commandId: "018f8e3d-1234-4123-8123-123456789abc", matchId: "m1", expectedVersion: 0,
  type: "PLAY_CARD", payload: { cardInstanceId: "opaque-card-id", targetPlayerId: "p2" },
};
const roomCommand: RoomCommand = {
  protocolVersion: 1, commandId: "018f8e3d-1234-4123-8123-123456789abc", expectedVersion: 0,
  type: "CREATE_ROOM", payload: { capacity: 6, rulesetVersion: "base4-ko-online-1.0", displayName: "player" },
};
const returnToLobbyCommand: RoomCommand = {
  protocolVersion: 1, commandId: "018f8e3d-1234-4123-8123-123456789abc", roomId: "r1", expectedVersion: 9,
  type: "RETURN_TO_LOBBY", payload: {},
};
const acceptedAck: CommandAck = {
  protocolVersion: 1, commandId: "018f8e3d-1234-4123-8123-123456789abc", status: "accepted", duplicate: false, aggregateVersion: 1, eventSeq: 1,
};
const syncRequests: [MatchSyncRequest, RoomSyncRequest] = [
  { protocolVersion: 1, requestId: "sync1", matchId: "m1", knownVersion: 1, afterEventSeq: 2 },
  { protocolVersion: 1, requestId: "sync2", roomId: "r1", knownVersion: 1 },
];
const previewRequest: RoomPreviewRequest = {
  protocolVersion: 1,
  requestId: "preview1",
  inviteCode: "ABCD-EFGH",
};
const previewSuccess: RoomPreviewSuccess = {
  protocolVersion: 1,
  requestId: "preview1",
  roomId: "r1",
  version: 2,
  occupancy: 3,
  status: "waiting",
};
const previewResponses: readonly RoomPreviewResponse[] = [
  previewSuccess,
  { protocolVersion: 1, requestId: "preview2", status: "rejected", error: { code: "INVITE_INVALID" } },
  { protocolVersion: 1, requestId: "preview3", status: "rejected", error: { code: "BAD_REQUEST" } },
  { protocolVersion: 1, requestId: "preview4", status: "rejected", error: { code: "RATE_LIMITED", retryAfterMs: 1000 } },
];
const syncRejected: SyncRejectedResponse = {
  protocolVersion: 1,
  requestId: "sync3",
  status: "rejected",
  error: { code: "NOT_FOUND_OR_FORBIDDEN" },
};
const syncReplies: readonly (RoomSyncReply | MatchSyncReply)[] = [syncRejected];
const legalActions: readonly LegalActionProposal[] = [
  { type: "PLAY_CARD", payload: { cardInstanceId: "self-card", asCardType: "bang" } },
  { type: "USE_ABILITY", payload: { abilityId: "sid-ketchum", cardInstanceIds: ["self-a", "self-b"] } },
  { type: "END_TURN", payload: {} },
];
const progressView: PendingInteractionProgressView = {
  interactionId: "i1",
  kind: "DUEL_RESPONSE",
  allowedChoices: [],
  currentResponderPlayerId: "p2",
  step: { current: 1, total: 2 },
};
const responderView: PendingInteractionResponderView = {
  interactionId: "i1",
  kind: "BANG_RESPONSE",
  allowedChoices: ["USE_MISSED"],
  currentResponderPlayerId: "p2",
  step: { current: 1, total: 1 },
  responseOptions: [{ interactionId: "i1", choice: "USE_MISSED", cardInstanceId: "p2-card" }],
};
const discardOrder: PendingDiscardOrderView = {
  requiredCount: 1,
  allowedCards: [{ cardInstanceId: "p2-card", typeId: "bang", rank: "A", suit: "SPADES" }],
};
const discardOrderResponderView: PendingInteractionResponderView = {
  interactionId: "i2",
  kind: "DISCARDS_ORDER",
  allowedChoices: ["ORDER_CARDS"],
  currentResponderPlayerId: "p2",
  step: { current: 1, total: 1 },
  responseOptions: [{ interactionId: "i2", choice: "ORDER_CARDS" }],
  discardOrder,
};
const runtimeRespondPayloads: RespondPayload[] = [
  { interactionId: "i1", choice: "DRAW_FROM_PILE" },
  { interactionId: "i1", choice: "TAKE_FROM_HAND", sourcePlayerId: "p1" },
  { interactionId: "i1", choice: "SELECT_SOURCE", source: "DISCARD_TOP" },
  { interactionId: "i1", choice: "SELECT_JUDGMENT", selectedCardInstanceId: "c1", orderedCardInstanceIds: ["c1", "c2"] },
  { interactionId: "i1", choice: "ORDER_CARDS", orderedCardInstanceIds: ["c1"] },
];
const storedOrderTemplate: PendingRespondOption = { interactionId: "i1", choice: "ORDER_CARDS" };
void runtimeRespondPayloads;
void storedOrderTemplate;
const completedOutcome: MatchOutcomeView = {
  winningFaction: "outlaws",
  winningPlayerIds: ["p2", "p3"],
};
const activeSheriffView: MatchSnapshotView = {
  status: "playing",
  viewer: { playerId: "p1", seatIndex: 0, mode: "active" },
  publicTable: {
    players: [
      {
        playerId: "p1",
        displayName: "sheriff",
        seatIndex: 0,
        characterId: "bart_cassidy",
        hp: 5,
        maxHp: 5,
        eliminated: false,
        handCount: 1,
        role: "sheriff",
        inPlay: [],
      },
    ],
    turn: { currentPlayerId: "p1", phase: "draw" },
    deckCount: 55,
    publicDiscard: { topCard: null, count: 0 },
  },
  selfPrivate: {
    role: "sheriff",
    hand: [{ cardInstanceId: "opaque-private-card", typeId: "bang", rank: "A", suit: "SPADES" }],
  },
  legalActions,
  pendingInteraction: null,
};
const documentedServerEvents: readonly ServerEvent[] = [
  { event: "room:changed", payload: { roomId: "r1", version: 2 } },
  { event: "match:changed", payload: { matchId: "m1", version: 3, eventSeq: 8 } },
  { event: "match:presence", payload: { matchId: "m1", playerId: "p1", seatIndex: 0, connectionState: "connected", observedAt: "2026-09-27T00:00:00Z" } },
  { event: "session:expired", payload: { protocolVersion: 1 } },
  { event: "server:maintenance", payload: { protocolVersion: 1 } },
];

type Assert<T extends true> = T;
type AssertFalse<T extends false> = T;
type Has<K extends PropertyKey, T> = K extends keyof T ? true : false;
type PublicCannotContainHand = AssertFalse<Has<"hand", PublicPlayerView>>;
type PublicCannotContainDeckOrder = AssertFalse<Has<"deckOrder", MatchSnapshotView["publicTable"]>>;
type PublicCannotContainDrawPileIDs = AssertFalse<Has<"drawPileCardInstanceIds", MatchSnapshotView["publicTable"]>>;
type MatchCannotAcceptActorId = AssertFalse<Has<"actorId", MatchCommand>>;
type PreviewCannotEchoInviteCode = AssertFalse<Has<"inviteCode", RoomPreviewSuccess>>;
type PreviewCannotEchoSessionSecret = AssertFalse<Has<"sessionSecret", RoomPreviewSuccess>>;
type SyncRejectDoesNotIdentifyRoom = AssertFalse<Has<"roomId", SyncRejectedResponse>>;
type SyncRejectDoesNotIdentifyMatch = AssertFalse<Has<"matchId", SyncRejectedResponse>>;
type LegalActionHasNoCommandId = AssertFalse<Has<"commandId", LegalActionProposal>>;
type LegalActionHasNoExpectedVersion = AssertFalse<Has<"expectedVersion", LegalActionProposal>>;
type LegalActionHasNoMatchId = AssertFalse<Has<"matchId", LegalActionProposal>>;
type LegalActionCannotBeResponse = AssertFalse<"RESPOND" extends LegalActionProposal["type"] ? true : false>;
type ProgressHasNoResponseOptions = AssertFalse<Has<"responseOptions", PendingInteractionProgressView>>;
type OutcomeHasNoDeckOrder = AssertFalse<Has<"deckOrder", MatchOutcomeView>>;
type _CompileTimeContractChecks = [
  PublicCannotContainHand,
  PublicCannotContainDeckOrder,
  PublicCannotContainDrawPileIDs,
  MatchCannotAcceptActorId,
  PreviewCannotEchoInviteCode,
  PreviewCannotEchoSessionSecret,
  SyncRejectDoesNotIdentifyRoom,
  SyncRejectDoesNotIdentifyMatch,
  LegalActionHasNoCommandId,
  LegalActionHasNoExpectedVersion,
  LegalActionHasNoMatchId,
  LegalActionCannotBeResponse,
  ProgressHasNoResponseOptions,
  OutcomeHasNoDeckOrder,
];
void [matchCommand, roomCommand, returnToLobbyCommand, acceptedAck, syncRequests, previewRequest, previewResponses, syncReplies, legalActions, progressView, responderView, discardOrderResponderView, completedOutcome, activeSheriffView, documentedServerEvents];
