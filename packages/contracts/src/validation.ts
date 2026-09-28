import type {
  CardFaceView,
  CommandAck,
  LegalActionProposal,
  MatchCommand,
  MatchOutcomeView,
  MatchSnapshotView,
  MatchStatus,
  MatchSyncRequest,
  MatchSyncResponse,
  PendingInteractionProgressView,
  PendingRespondOption,
  PendingInteractionResponderView,
  PendingInteractionView,
  PublicMatchEvent,
  PublicPlayerView,
  RoomCommand,
  RoomPreviewErrorCode,
  RoomPreviewRequest,
  RoomPreviewResponse,
  RoomSyncResponse,
  RoomStatus,
  RoomView,
  RoomSyncRequest,
  RespondPayload,
  SyncRejectedErrorCode,
  SyncRejectedResponse,
} from "./protocol.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; code: "BAD_REQUEST"; path: string };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 256;
const isVersion = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every(isText);
const exactKeys = (value: Record<string, unknown>, allowed: readonly string[]): boolean => Object.keys(value).every(k => allowed.includes(k));
const hasKeys = (value: Record<string, unknown>, required: readonly string[]): boolean => required.every(k => k in value);
const exactShape = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean => {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
};
const ROOM_STATUSES: readonly RoomStatus[] = ["waiting", "starting", "in_game", "paused", "completed", "closed"];
const MATCH_STATUSES: readonly MatchStatus[] = ["playing", "paused", "completed", "recovery_required"];
const ROLE_IDS = new Set(["sheriff", "deputy", "outlaw", "renegade"]);
const isRoomStatus = (value: unknown): value is RoomStatus => ROOM_STATUSES.includes(value as RoomStatus);
const isMatchStatus = (value: unknown): value is MatchStatus => MATCH_STATUSES.includes(value as MatchStatus);
const isRoomPreviewErrorCode = (value: unknown): value is RoomPreviewErrorCode => value === "BAD_REQUEST" || value === "INVITE_INVALID" || value === "RATE_LIMITED";
const isSyncRejectedErrorCode = (value: unknown): value is SyncRejectedErrorCode =>
  value === "BAD_REQUEST" || value === "NOT_FOUND_OR_FORBIDDEN" || value === "RECOVERY_REQUIRED";
const isCommandBase = (value: Record<string, unknown>): boolean => value.protocolVersion === 1 && typeof value.commandId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.commandId) && isVersion(value.expectedVersion);
const bad = <T>(path = "$"): ParseResult<T> => ({ ok: false, code: "BAD_REQUEST", path });
const good = <T>(value: unknown): ParseResult<T> => ({ ok: true, value: value as T });

function validRespondPayload(p: Record<string, unknown>): p is RespondPayload & Record<string, unknown> {
  if (!isText(p.interactionId) || !isText(p.choice)) return false;
  switch (p.choice) {
    case "USE_MISSED": case "USE_BANG": case "PLAY_BANG": case "USE_BEER":
      return exactKeys(p, ["interactionId", "choice", "cardInstanceId"]) && isText(p.cardInstanceId);
    case "USE_BARREL": case "USE_JOURDONNAIS": case "TAKE_HIT": case "YIELD": case "ACCEPT_ELIMINATION": case "DRAW_PILE": case "DRAW_FROM_PILE":
      return exactKeys(p, ["interactionId", "choice"]);
    case "TAKE_FROM_HAND":
      return exactKeys(p, ["interactionId", "choice", "sourcePlayerId"]) && isText(p.sourcePlayerId);
    case "USE_SID":
      return exactKeys(p, ["interactionId", "choice", "cardInstanceIds"]) && isStringList(p.cardInstanceIds) && p.cardInstanceIds.length === 2;
    case "ORDER_CARDS":
      return exactKeys(p, ["interactionId", "choice", "orderedCardInstanceIds"]) && isStringList(p.orderedCardInstanceIds);
    case "TAKE_CARD": case "CHOOSE_CARD":
      return exactKeys(p, ["interactionId", "choice", "selectedCardInstanceId"]) && isText(p.selectedCardInstanceId);
    case "CHOOSE_CARDS":
      return exactKeys(p, ["interactionId", "choice", "selectedCardInstanceIds"]) && isStringList(p.selectedCardInstanceIds) && p.selectedCardInstanceIds.length === 2;
    case "OPPONENT_HAND":
      return exactKeys(p, ["interactionId", "choice", "targetPlayerId"]) && isText(p.targetPlayerId);
    case "CHOOSE_SOURCE": case "SELECT_SOURCE":
      return exactKeys(p, ["interactionId", "choice", "source"]) && (p.source === "DISCARD_TOP" || p.source === "DRAW_PILE_TOP");
    case "SELECT_JUDGMENT":
      return exactKeys(p, ["interactionId", "choice", "selectedCardInstanceId", "orderedCardInstanceIds"]) &&
        isText(p.selectedCardInstanceId) && isStringList(p.orderedCardInstanceIds) && p.orderedCardInstanceIds.length === 2;
    default: return false;
  }
}

function validPendingRespondOption(p: Record<string, unknown>): p is PendingRespondOption & Record<string, unknown> {
  return validRespondPayload(p) || (
    isText(p.interactionId) && p.choice === "ORDER_CARDS" && exactKeys(p, ["interactionId", "choice"])
  );
}

const PENDING_CARD_SUITS = new Set(["SPADES", "HEARTS", "DIAMONDS", "CLUBS"]);

function validPendingCardFace(input: unknown): input is CardFaceView {
  return isRecord(input) && exactKeys(input, ["cardInstanceId", "typeId", "rank", "suit"]) &&
    isText(input.cardInstanceId) && isText(input.typeId) && typeof input.rank === "string" &&
    PENDING_CARD_SUITS.has(input.suit as string);
}

function validPendingDiscardOrder(input: unknown): boolean {
  if (!isRecord(input) || !exactKeys(input, ["requiredCount", "allowedCards"]) ||
      !Number.isSafeInteger(input.requiredCount) || (input.requiredCount as number) <= 0 ||
      !Array.isArray(input.allowedCards) || input.allowedCards.length === 0 ||
      !input.allowedCards.every(validPendingCardFace)) return false;
  const cardIds = input.allowedCards.map((card) => (card as CardFaceView).cardInstanceId);
  return new Set(cardIds).size === cardIds.length && (input.requiredCount as number) <= cardIds.length;
}

export function parseMatchCommand(input: unknown): ParseResult<MatchCommand> {
  if (!isRecord(input) || !isCommandBase(input) || !exactKeys(input, ["protocolVersion", "commandId", "expectedVersion", "matchId", "type", "payload"]) || !hasKeys(input, ["matchId", "type", "payload"]) || !isText(input.matchId) || !isRecord(input.payload)) return bad();
  const p = input.payload;
  switch (input.type) {
    case "PLAY_CARD": {
      const allowed = ["cardInstanceId", "targetPlayerId", "targetZone", "targetCardInstanceId", "asCardType"];
      return exactKeys(p, allowed) && hasKeys(p, ["cardInstanceId"]) && isText(p.cardInstanceId) && (p.targetPlayerId === undefined || isText(p.targetPlayerId)) && (p.targetZone === undefined || p.targetZone === "HAND" || p.targetZone === "IN_PLAY") && (p.targetCardInstanceId === undefined || isText(p.targetCardInstanceId)) && (p.asCardType === undefined || isText(p.asCardType)) ? good(input) : bad("$.payload");
    }
    case "RESPOND": return validRespondPayload(p) ? good(input) : bad("$.payload");
    case "USE_ABILITY": return exactKeys(p, ["abilityId", "cardInstanceIds"]) && p.abilityId === "sid-ketchum" && isStringList(p.cardInstanceIds) && p.cardInstanceIds.length === 2 ? good(input) : bad("$.payload");
    case "END_TURN": return exactKeys(p, []) ? good(input) : bad("$.payload");
    default: return bad("$.type");
  }
}

/** Strict response parser for the existing room/match command acknowledgement DTO. */
export function parseCommandAck(input: unknown): ParseResult<CommandAck> {
  if (!isRecord(input) || input.protocolVersion !== 1 || !isText(input.commandId)) return bad();
  if (input.status === "accepted") {
    if (!exactShape(input, ["protocolVersion", "commandId", "status", "duplicate", "aggregateVersion", "eventSeq"]) ||
        typeof input.duplicate !== "boolean" || !isVersion(input.aggregateVersion) || !isVersion(input.eventSeq)) {
      return bad();
    }
    return good(input);
  }
  if (input.status === "rejected") {
    if (!exactShape(input, ["protocolVersion", "commandId", "status", "error"]) || !isRecord(input.error) ||
        !exactShape(input.error, ["code", "messageKey", "retryable"], ["currentVersion", "retryAfterMs"]) ||
        !isText(input.error.code) || !isText(input.error.messageKey) || typeof input.error.retryable !== "boolean" ||
        (Object.hasOwn(input.error, "currentVersion") && !isVersion(input.error.currentVersion)) ||
        (Object.hasOwn(input.error, "retryAfterMs") && !isVersion(input.error.retryAfterMs))) {
      return bad();
    }
    return good(input);
  }
  return bad("$.status");
}

export function parseRoomCommand(input: unknown): ParseResult<RoomCommand> {
  if (!isRecord(input) || !isCommandBase(input) || !isRecord(input.payload)) return bad();
  const roomRequired = input.type !== "CREATE_ROOM";
  if (!exactKeys(input, ["protocolVersion", "commandId", "expectedVersion", "type", "payload", ...(roomRequired ? ["roomId"] : [])]) || (roomRequired && !isText(input.roomId))) return bad();
  const p = input.payload;
  switch (input.type) {
    case "CREATE_ROOM": return exactKeys(p, ["capacity", "rulesetVersion", "displayName"]) && [4, 5, 6, 7].includes(p.capacity as number) && p.rulesetVersion === "base4-ko-online-1.0" && isText(p.displayName) ? good(input) : bad("$.payload");
    case "JOIN": return exactKeys(p, ["inviteCode"]) && isText(p.inviteCode) ? good(input) : bad("$.payload");
    case "SET_READY": return exactKeys(p, ["ready"]) && typeof p.ready === "boolean" ? good(input) : bad("$.payload");
    case "SET_RULESET": return exactKeys(p, ["rulesetVersion"]) && isText(p.rulesetVersion) ? good(input) : bad("$.payload");
    case "START_MATCH": case "RETURN_TO_LOBBY": case "CLOSE_ROOM": return exactKeys(p, []) ? good(input) : bad("$.payload");
    case "KICK_MEMBER": return exactKeys(p, ["targetPlayerId"]) && isText(p.targetPlayerId) ? good(input) : bad("$.payload");
    default: return bad("$.type");
  }
}

/** Strict client payload parser for the room:preview event. */
export function parseRoomPreviewRequest(input: unknown): ParseResult<RoomPreviewRequest> {
  if (!isRecord(input)) return bad();
  if (!exactKeys(input, ["protocolVersion", "requestId", "inviteCode"])) return bad();
  if (input.protocolVersion !== 1) return bad("$.protocolVersion");
  if (!isText(input.requestId)) return bad("$.requestId");
  if (!isText(input.inviteCode)) return bad("$.inviteCode");
  return good(input);
}

/** Strict client payload parser for the room:sync event. */
export function parseRoomSyncRequest(input: unknown): ParseResult<RoomSyncRequest> {
  if (!isRecord(input)) return bad();
  if (!exactKeys(input, ["protocolVersion", "requestId", "roomId", "knownVersion"])) return bad();
  if (input.protocolVersion !== 1) return bad("$.protocolVersion");
  if (!isText(input.requestId)) return bad("$.requestId");
  if (!isText(input.roomId)) return bad("$.roomId");
  if (!isVersion(input.knownVersion)) return bad("$.knownVersion");
  return good(input);
}

/** Strict parser for an authenticated room projection and its viewer identity. */
export function parseRoomView(input: unknown): ParseResult<RoomView> {
  if (!isRecord(input) ||
      !exactKeys(input, ["roomId", "status", "activeMatchId", "ownerPlayerId", "capacity", "rulesetVersion", "members", "viewer"]) ||
      !isText(input.roomId) || !isRoomStatus(input.status) || !isText(input.ownerPlayerId) ||
      ![4, 5, 6, 7].includes(input.capacity as number) || !isText(input.rulesetVersion) ||
      !Array.isArray(input.members) || !isRecord(input.viewer) ||
      !exactKeys(input.viewer, ["playerId", "isOwner"]) || !isText(input.viewer.playerId) ||
      typeof input.viewer.isOwner !== "boolean") return bad("$.room");

  const activeMatchExpected = input.status === "in_game" || input.status === "paused" || input.status === "completed";
  if (activeMatchExpected ? !isText(input.activeMatchId) : input.activeMatchId !== null) return bad("$.room.activeMatchId");

  const members = input.members as unknown[];
  if (members.length < 1 || members.length > (input.capacity as number)) return bad("$.room.members");
  const playerIds = new Set<string>();
  const seats = new Set<number>();
  for (const member of members) {
    if (!isRecord(member) || !exactKeys(member, ["playerId", "displayName", "seatIndex", "ready"]) ||
        !isText(member.playerId) || !isText(member.displayName) || !Number.isSafeInteger(member.seatIndex) ||
        (member.seatIndex as number) < 0 || (member.seatIndex as number) >= (input.capacity as number) ||
        typeof member.ready !== "boolean" || playerIds.has(member.playerId) || seats.has(member.seatIndex as number)) {
      return bad("$.room.members");
    }
    playerIds.add(member.playerId);
    seats.add(member.seatIndex as number);
  }
  if (!playerIds.has(input.viewer.playerId) || input.viewer.isOwner !== (input.viewer.playerId === input.ownerPlayerId)) {
    return bad("$.room.viewer");
  }
  return good(input);
}

/** Strict success parser for room:sync; the nested room ID must match the envelope. */
export function parseRoomSyncResponse(input: unknown): ParseResult<RoomSyncResponse> {
  if (!isRecord(input) || !exactKeys(input, ["protocolVersion", "requestId", "roomId", "version", "requiresFullSnapshot", "room"])) return bad();
  if (input.protocolVersion !== 1) return bad("$.protocolVersion");
  if (!isText(input.requestId)) return bad("$.requestId");
  if (!isText(input.roomId)) return bad("$.roomId");
  if (!isVersion(input.version)) return bad("$.version");
  if (typeof input.requiresFullSnapshot !== "boolean") return bad("$.requiresFullSnapshot");
  const room = parseRoomView(input.room);
  if (!room.ok || room.value.roomId !== input.roomId) return bad("$.room");
  return good(input);
}

/** Strict client payload parser for the match:sync event. */
export function parseMatchSyncRequest(input: unknown): ParseResult<MatchSyncRequest> {
  if (!isRecord(input)) return bad();
  if (!exactKeys(input, ["protocolVersion", "requestId", "matchId", "knownVersion", "afterEventSeq"])) return bad();
  if (input.protocolVersion !== 1) return bad("$.protocolVersion");
  if (!isText(input.requestId)) return bad("$.requestId");
  if (!isText(input.matchId)) return bad("$.matchId");
  if (!isVersion(input.knownVersion)) return bad("$.knownVersion");
  if (!isVersion(input.afterEventSeq)) return bad("$.afterEventSeq");
  return good(input);
}

function validPublicPlayer(input: unknown): input is PublicPlayerView {
  if (!isRecord(input) || !exactShape(input, [
    "playerId", "displayName", "seatIndex", "characterId", "hp", "maxHp", "eliminated", "handCount", "role", "inPlay",
  ])) return false;
  return isText(input.playerId) && isText(input.displayName) && isVersion(input.seatIndex) &&
    isText(input.characterId) && Number.isSafeInteger(input.hp) && Number.isSafeInteger(input.maxHp) &&
    typeof input.eliminated === "boolean" && isVersion(input.handCount) &&
    (input.role === null || ROLE_IDS.has(input.role as string)) &&
    Array.isArray(input.inPlay) && input.inPlay.every(validPendingCardFace);
}

function validMatchSnapshot(input: unknown): input is MatchSnapshotView {
  if (!isRecord(input) || !exactShape(input,
    ["status", "viewer", "publicTable", "selfPrivate", "pendingInteraction"], ["legalActions", "outcome"],
  )) return false;
  if (!isMatchStatus(input.status) || !isRecord(input.viewer) ||
      !exactShape(input.viewer, ["playerId", "seatIndex", "mode"]) || !isText(input.viewer.playerId) ||
      !isVersion(input.viewer.seatIndex) || (input.viewer.mode !== "active" && input.viewer.mode !== "eliminated_observer")) return false;

  const table = input.publicTable;
  if (!isRecord(table) || !exactShape(table, ["players", "turn", "deckCount", "publicDiscard"]) ||
      !Array.isArray(table.players) || !table.players.every(validPublicPlayer) || !isRecord(table.turn) ||
      !exactShape(table.turn, ["currentPlayerId", "phase"]) || !isText(table.turn.currentPlayerId) ||
      !isText(table.turn.phase) || !isVersion(table.deckCount) || !isRecord(table.publicDiscard) ||
      !exactShape(table.publicDiscard, ["topCard", "count"]) ||
      (table.publicDiscard.topCard !== null && !validPendingCardFace(table.publicDiscard.topCard)) ||
      !isVersion(table.publicDiscard.count)) return false;

  if (input.selfPrivate !== null) {
    if (!isRecord(input.selfPrivate) || !exactShape(input.selfPrivate, ["role", "hand"]) ||
        !ROLE_IDS.has(input.selfPrivate.role as string) || !Array.isArray(input.selfPrivate.hand) ||
        !input.selfPrivate.hand.every(validPendingCardFace)) return false;
  }
  if (Object.hasOwn(input, "legalActions") && (!Array.isArray(input.legalActions) ||
      !input.legalActions.every((action) => parseLegalActionProposal(action).ok))) return false;
  if (input.pendingInteraction !== null &&
      !parsePendingInteractionView(input.pendingInteraction, input.viewer.playerId).ok) return false;
  return parseMatchOutcomeForStatus(input.status, input.outcome).ok;
}

function validPublicMatchEvent(input: unknown): input is PublicMatchEvent {
  return isRecord(input) && exactShape(input, ["eventSeq", "type", "occurredAt", "payload"]) &&
    isVersion(input.eventSeq) && input.eventSeq > 0 && isText(input.type) &&
    typeof input.occurredAt === "string" && Number.isFinite(Date.parse(input.occurredAt)) && isRecord(input.payload);
}

/** Strict success parser for match:sync, including viewer-scoped snapshot and ordered visible events. */
export function parseMatchSyncResponse(input: unknown): ParseResult<MatchSyncResponse> {
  if (!isRecord(input) || !exactShape(input, [
    "protocolVersion", "requestId", "matchId", "version", "eventSeq", "requiresFullSnapshot", "snapshot", "visibleEvents",
  ])) return bad();
  if (input.protocolVersion !== 1 || !isText(input.requestId) || !isText(input.matchId) ||
      !isVersion(input.version) || !isVersion(input.eventSeq) || typeof input.requiresFullSnapshot !== "boolean" ||
      !validMatchSnapshot(input.snapshot) || !Array.isArray(input.visibleEvents) ||
      !input.visibleEvents.every(validPublicMatchEvent)) return bad();
  const events = input.visibleEvents as PublicMatchEvent[];
  if (!events.every((event, index) => event.eventSeq <= (input.eventSeq as number) &&
      (index === 0 || event.eventSeq > events[index - 1]!.eventSeq))) return bad("$.visibleEvents");
  return good(input);
}

/** Strict response parser for room:preview; response keys never echo invite/session secrets. */
export function parseRoomPreviewResponse(input: unknown): ParseResult<RoomPreviewResponse> {
  if (!isRecord(input)) return bad();
  if (input.protocolVersion !== 1) return bad("$.protocolVersion");
  if (!isText(input.requestId)) return bad("$.requestId");

  if (input.status === "rejected") {
    if (!exactKeys(input, ["protocolVersion", "requestId", "status", "error"])) return bad();
    if (!isRecord(input.error)) return bad("$.error");
    if (!isRoomPreviewErrorCode(input.error.code)) return bad("$.error.code");
    if (input.error.code === "RATE_LIMITED") {
      if (!exactKeys(input.error, ["code", "retryAfterMs"]) ||
          !Number.isSafeInteger(input.error.retryAfterMs) || (input.error.retryAfterMs as number) <= 0) {
        return bad("$.error.retryAfterMs");
      }
    } else if (!exactKeys(input.error, ["code"])) {
      return bad("$.error");
    }
    return good(input);
  }

  if (!exactKeys(input, ["protocolVersion", "requestId", "roomId", "version", "occupancy", "status"])) return bad();
  if (!isText(input.roomId)) return bad("$.roomId");
  if (!isVersion(input.version)) return bad("$.version");
  if (!isVersion(input.occupancy)) return bad("$.occupancy");
  if (!isRoomStatus(input.status)) return bad("$.status");
  return good(input);
}

/** Strict room:sync/match:sync rejection parser; no resource ID or nested detail is accepted. */
export function parseSyncRejectedResponse(input: unknown): ParseResult<SyncRejectedResponse> {
  if (!isRecord(input)) return bad();
  if (!exactKeys(input, ["protocolVersion", "requestId", "status", "error"])) return bad();
  if (input.protocolVersion !== 1) return bad("$.protocolVersion");
  if (!isText(input.requestId)) return bad("$.requestId");
  if (input.status !== "rejected") return bad("$.status");
  if (!isRecord(input.error)) return bad("$.error");
  if (!exactKeys(input.error, ["code"])) return bad("$.error");
  if (!isSyncRejectedErrorCode(input.error.code)) return bad("$.error.code");
  return good(input);
}

/** Strict payload-only parser for server-proposed viewer legal actions. */
export function parseLegalActionProposal(input: unknown): ParseResult<LegalActionProposal> {
  if (!isRecord(input) || !exactKeys(input, ["type", "payload"]) || !isRecord(input.payload)) return bad();
  const payload = input.payload;
  if (input.type === "PLAY_CARD") {
    const allowed = ["cardInstanceId", "targetPlayerId", "targetZone", "targetCardInstanceId", "asCardType"];
    return exactKeys(payload, allowed) && hasKeys(payload, ["cardInstanceId"]) && isText(payload.cardInstanceId) &&
      (payload.targetPlayerId === undefined || isText(payload.targetPlayerId)) &&
      (payload.targetZone === undefined || payload.targetZone === "HAND" || payload.targetZone === "IN_PLAY") &&
      (payload.targetCardInstanceId === undefined || isText(payload.targetCardInstanceId)) &&
      (payload.asCardType === undefined || isText(payload.asCardType))
      ? good(input)
      : bad("$.payload");
  }
  if (input.type === "USE_ABILITY") {
    return exactKeys(payload, ["abilityId", "cardInstanceIds"]) && payload.abilityId === "sid-ketchum" &&
      isStringList(payload.cardInstanceIds) && payload.cardInstanceIds.length === 2
      ? good(input)
      : bad("$.payload");
  }
  if (input.type === "END_TURN") {
    return exactKeys(payload, []) ? good(input) : bad("$.payload");
  }
  return bad("$.type");
}

function isInteractionProgressStep(input: unknown): boolean {
  return isRecord(input) && exactKeys(input, ["current", "total"]) &&
    Number.isSafeInteger(input.current) && (input.current as number) >= 1 &&
    Number.isSafeInteger(input.total) && (input.total as number) >= (input.current as number);
}

/**
 * Validates the viewer-aware pending DTO. Responders get only options whose
 * exact payloads are valid RESPOND payloads for this interaction; other
 * viewers must receive an empty legacy allowedChoices list and no options.
 */
export function parsePendingInteractionView(
  input: unknown,
  viewerPlayerId: string,
): ParseResult<PendingInteractionView> {
  if (!isText(viewerPlayerId) || !isRecord(input)) return bad();
  if (!isText(input.interactionId)) return bad("$.interactionId");
  if (!isText(input.kind)) return bad("$.kind");
  if (!isStringList(input.allowedChoices)) return bad("$.allowedChoices");
  if (!isText(input.currentResponderPlayerId)) return bad("$.currentResponderPlayerId");
  if (!isInteractionProgressStep(input.step)) return bad("$.step");

  const isResponder = input.currentResponderPlayerId === viewerPlayerId;
  if (isResponder) {
    const isDiscardOrder = input.kind === "DISCARDS_ORDER";
    const responderKeys = ["interactionId", "kind", "allowedChoices", "currentResponderPlayerId", "step", "responseOptions"];
    if (isDiscardOrder) responderKeys.push("discardOrder");
    if (!exactKeys(input, responderKeys)) {
      return bad();
    }
    if (!Array.isArray(input.responseOptions) || !input.responseOptions.every((option) =>
      isRecord(option) && validPendingRespondOption(option) && option.interactionId === input.interactionId)) {
      return bad("$.responseOptions");
    }
    const expectedChoices = [...new Set((input.responseOptions as PendingRespondOption[]).map((option) => option.choice))];
    if (JSON.stringify(input.allowedChoices) !== JSON.stringify(expectedChoices)) return bad("$.allowedChoices");
    if (isDiscardOrder) {
      if (expectedChoices.length !== 1 || expectedChoices[0] !== "ORDER_CARDS" ||
          !validPendingDiscardOrder(input.discardOrder)) return bad("$.discardOrder");
    } else if (Object.hasOwn(input, "discardOrder")) {
      return bad("$.discardOrder");
    }
    return good(input as unknown as PendingInteractionResponderView);
  }

  if (!exactKeys(input, ["interactionId", "kind", "allowedChoices", "currentResponderPlayerId", "step"])) return bad();
  if (input.allowedChoices.length !== 0) return bad("$.allowedChoices");
  return good(input as unknown as PendingInteractionProgressView);
}

/** Strict public outcome summary; it has no cards, roles, or internal match state. */
export function parseMatchOutcomeSummary(input: unknown): ParseResult<MatchOutcomeView> {
  if (!isRecord(input) || !exactKeys(input, ["winningFaction", "winningPlayerIds"])) return bad();
  const factions = ["sheriff_and_deputies", "outlaws", "renegade"] as const;
  if (!factions.includes(input.winningFaction as typeof factions[number])) return bad("$.winningFaction");
  if (!isStringList(input.winningPlayerIds) || input.winningPlayerIds.length === 0 ||
      new Set(input.winningPlayerIds).size !== input.winningPlayerIds.length) return bad("$.winningPlayerIds");
  return good(input);
}

/** Enforces the snapshot rule that the winner summary is absent until completion. */
export function parseMatchOutcomeForStatus(
  status: MatchStatus,
  input: unknown,
): ParseResult<MatchOutcomeView | undefined> {
  if (!isMatchStatus(status)) return bad("$.status");
  if (status === "completed") return parseMatchOutcomeSummary(input);
  return input === undefined ? good(undefined) : bad("$.outcome");
}

export function hasProtocolVersion(input: unknown): input is { protocolVersion: 1 } {
  return isRecord(input) && input.protocolVersion === 1;
}
