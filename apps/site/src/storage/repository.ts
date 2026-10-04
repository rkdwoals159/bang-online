import type { GameState, JsonValue } from "../../../../packages/engine/src/state/types.js";
import { changes, type D1DatabaseLike, type D1PreparedStatement } from "./d1-types.js";
import { decodeJson, decodeMatchState, encodeJson, parseMatchState, StoredDataInvariantError } from "./state-schema.js";

export type RoomStatus = "waiting" | "starting" | "in_game" | "paused" | "completed" | "closed";
export type ConnectionState = "connected" | "disconnected";

export interface GuestSessionInput {
  id: string;
  tokenHash: string;
  displayName: string;
  expiresAt: Date | string;
}

export interface GuestSessionLookup {
  playerId: string;
  displayName: string;
  expiresAt: Date;
}

export interface NewRoomPlayer {
  playerId: string;
  seatIndex: number;
  ready?: boolean;
}

export interface NewRoom {
  id: string;
  ownerPlayerId: string;
  inviteCodeHash: string;
  capacity: 4 | 5 | 6 | 7;
  players: readonly NewRoomPlayer[];
}

export interface RoomPlayerRecord extends NewRoomPlayer {
  ready: boolean;
  joinedAt: Date;
  lastPresenceAt: Date | null;
  displayName: string;
}

export interface RoomRecord {
  id: string;
  ownerPlayerId: string;
  inviteCodeHash: string;
  status: RoomStatus;
  capacity: 4 | 5 | 6 | 7;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  latestMatchId: string | null;
  players: RoomPlayerRecord[];
}

export interface RoomPreviewRecord {
  roomId: string;
  version: number;
  occupancy: number;
  status: RoomStatus;
}

export interface NewMatchPlayer {
  playerId: string;
  seatIndex: number;
  alive: boolean;
  eliminatedAt: Date | null;
  connectionState: ConnectionState;
}

export interface NewMatch {
  id: string;
  roomId: string;
  state: GameState;
  players?: readonly Pick<NewMatchPlayer, "playerId" | "connectionState">[];
  startedAt?: Date | string;
}

export interface MatchRecord {
  id: string;
  roomId: string;
  status: GameState["status"];
  version: number;
  eventSeq: number;
  rulesetVersion: string;
  stateSchemaVersion: number;
  state: GameState;
  createdAt: Date;
  startedAt: Date;
  updatedAt: Date;
  endedAt: Date | null;
  players: NewMatchPlayer[];
}

export interface MatchEventWrite {
  eventId: string;
  eventSeq: number;
  version: number;
  type: string;
  actorPlayerId: string | null;
  payload: JsonValue;
  createdAt?: Date | string;
}

export interface MatchEventRecord extends MatchEventWrite {
  createdAt: Date;
}

export interface CommandReceiptInput {
  actorPlayerId: string;
  commandId: string;
  requestHash: string;
  outcome: JsonValue;
}

export interface CommandReceiptRecord extends CommandReceiptInput {
  matchId: string | null;
  roomId: string | null;
  createdAt: Date;
}

export interface MatchCommitInput {
  matchId: string;
  expectedVersion: number;
  expectedEventSeq: number;
  markerId: string;
  state: GameState;
  events: readonly MatchEventWrite[];
  receipt: CommandReceiptInput;
  outboxEventId: string;
}

export interface MatchRejectionReceiptInput {
  matchId: string;
  observedVersion: number;
  markerId: string;
  receipt: CommandReceiptInput;
}

export type MatchRejectionReceiptResult =
  | { status: "recorded"; currentVersion: number }
  | { status: "duplicate"; outcome: JsonValue }
  | { status: "version_changed"; currentVersion: number };

export type MatchCommitResult =
  | { status: "committed"; version: number; eventSeq: number; outboxEventId: string }
  | { status: "duplicate"; outcome: JsonValue };

export type MatchCommandContext =
  | { status: "not-member" }
  | { status: "receipt"; receipt: CommandReceiptRecord }
  | { status: "match"; match: MatchRecord };

export interface OutboxRecord {
  cursor: number;
  eventId: string;
  aggregateId: string;
  aggregateVersion: number;
  eventSeq: number;
  kind: "match:changed" | "room:changed";
  payload: JsonValue;
  createdAt: Date;
  publishedAt: Date | null;
  retryCount: number;
}

/** Minimal invalidation metadata for authorized SSE polling. */
export interface OutboxInvalidationRecord {
  cursor: number;
  eventId: string;
  aggregateId: string;
  aggregateVersion: number;
  eventSeq: number;
  kind: "match:changed" | "room:changed";
}

export type RoomPlayerWrite =
  | { operation: "insert"; playerId: string; seatIndex: number; ready?: boolean }
  | { operation: "delete"; playerId: string }
  | { operation: "set-ready"; playerId: string; ready: boolean };

export interface RoomCommandInput {
  roomId: string;
  actorPlayerId: string;
  commandId: string;
  requestHash: string;
  expectedVersion: number;
  markerId: string;
  status: RoomStatus;
  ownerPlayerId: string;
  changed: boolean;
  playerWrites?: readonly RoomPlayerWrite[];
  receiptOutcome: JsonValue;
  outboxEventId?: string;
}

export interface CreateRoomCommandInput extends Omit<NewRoom, "players"> {
  actorPlayerId: string;
  commandId: string;
  requestHash: string;
  outboxEventId: string;
}

export interface StartRoomWithMatchInput {
  /** Initial turn events are stored atomically with the new match. */
  events?: readonly MatchEventWrite[];
  roomId: string;
  actorPlayerId: string;
  commandId: string;
  requestHash: string;
  expectedVersion: number;
  markerId: string;
  matchId: string;
  matchOutboxEventId: string;
  roomOutboxEventId: string;
  state: GameState;
  startedAt?: Date | string;
}

export interface RoomMutationOutcome {
  roomId: string;
  version: number;
  roomStatus: RoomStatus;
  ownerPlayerId: string;
  occupancy: number;
  changed: boolean;
  playerId?: string;
  seatIndex?: number;
  ready?: boolean;
}

export type RoomMutationResult =
  | { status: "applied"; outcome: RoomMutationOutcome }
  | { status: "duplicate"; outcome: RoomMutationOutcome };

export interface StartRoomWithMatchOutcome {
  roomId: string;
  matchId: string;
  version: number;
  roomStatus: "in_game";
  ownerPlayerId: string;
  occupancy: number;
  changed: true;
}

export type StartRoomWithMatchResult =
  | { status: "applied"; outcome: StartRoomWithMatchOutcome }
  | { status: "duplicate"; outcome: StartRoomWithMatchOutcome };

interface RoomRow {
  id: string;
  owner_player_id: string;
  invite_code_hash: string;
  status: RoomStatus;
  capacity: number;
  version: number | string;
  created_at: string;
  updated_at: string;
  latest_match_id: string | null;
}

interface RoomPlayerRow {
  player_id: string;
  seat_index: number;
  ready: number | boolean;
  joined_at: string;
  last_presence_at: string | null;
  display_name: string | null;
}

interface MatchRow {
  id: string;
  room_id: string;
  status: GameState["status"];
  version: number | string;
  event_seq: number | string;
  ruleset_version: string;
  state_schema_version: number;
  state_json: string;
  created_at: string;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface MatchPlayerRow {
  player_id: string;
  seat_index: number;
  alive: number | boolean;
  eliminated_at: string | null;
  connection_state: ConnectionState;
}

interface ReceiptRow {
  actor_player_id: string;
  command_id: string;
  match_id: string | null;
  room_id: string | null;
  request_hash: string;
  outcome_json: string;
  created_at: string;
}

interface EventRow {
  event_id: string;
  event_seq: number | string;
  version: number | string;
  type: string;
  actor_player_id: string | null;
  payload_json: string;
  created_at: string;
}

interface OutboxRow {
  cursor: number | string;
  event_id: string;
  aggregate_id: string;
  aggregate_version: number | string;
  event_seq: number | string;
  kind: "match:changed" | "room:changed";
  payload_json: string;
  created_at: string;
  published_at: string | null;
  retry_count: number;
}

interface OutboxInvalidationRow {
  cursor: number | string;
  event_id: string;
  aggregate_id: string;
  aggregate_version: number | string;
  event_seq: number | string;
  kind: "match:changed" | "room:changed";
}

interface MatchMetadataRow {
  version: number | string;
  event_seq: number | string;
  ruleset_version: string;
  state_schema_version: number;
}

interface GuestRow {
  id: string;
  display_name: string;
  expires_at: string;
}

export class MatchNotFoundError extends Error {
  constructor(readonly matchId: string) {
    super(`Match '${matchId}' does not exist.`);
    this.name = "MatchNotFoundError";
  }
}

export class RoomNotFoundError extends Error {
  constructor(readonly roomId: string) {
    super(`Room '${roomId}' does not exist.`);
    this.name = "RoomNotFoundError";
  }
}

export class StaleMatchVersionError extends Error {
  constructor(readonly expectedVersion: number, readonly currentVersion: number, readonly proposedVersion?: number) {
    super(`Stale match version: expected ${expectedVersion}, current ${currentVersion}.`);
    this.name = "StaleMatchVersionError";
  }
}

export class RoomVersionConflictError extends Error {
  constructor(readonly expectedVersion: number, readonly currentVersion: number) {
    super(`Stale room version: expected ${expectedVersion}, current ${currentVersion}.`);
    this.name = "RoomVersionConflictError";
  }
}

export class CommandIdReusedError extends Error {
  constructor(readonly actorPlayerId: string, readonly commandId: string) {
    super(`Command '${commandId}' for player '${actorPlayerId}' was already used with another request.`);
    this.name = "CommandIdReusedError";
  }
}

export class D1StorageInvariantError extends StoredDataInvariantError {
  constructor(message: string) {
    super(message);
    this.name = "D1StorageInvariantError";
  }
}

function date(value: string): Date {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new D1StorageInvariantError("Stored timestamp is invalid.");
  return result;
}

function timestamp(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const result = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(result.getTime())) throw new TypeError("Timestamp must be a valid date.");
  return result.toISOString();
}

function safeInteger(value: number | string, field: string, minimum = 0): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum) {
    throw new D1StorageInvariantError(`Stored ${field} is not a safe integer >= ${minimum}.`);
  }
  return result;
}

function requiredText(value: string, field: string): void {
  if (!value.trim()) throw new TypeError(`${field} is required.`);
}

function bool(value: number | boolean): boolean {
  return value === true || value === 1;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObjectJson(value: unknown, label: string): JsonValue {
  if (!isObject(value)) throw new TypeError(`${label} must be a JSON object.`);
  return decodeJson(encodeJson(value, label), label);
}

function mapRoomPlayer(row: RoomPlayerRow): RoomPlayerRecord {
  if (row.display_name === null) throw new D1StorageInvariantError("Room member profile is missing.");
  return {
    playerId: row.player_id,
    seatIndex: safeInteger(row.seat_index, "room seat index"),
    ready: bool(row.ready),
    joinedAt: date(row.joined_at),
    lastPresenceAt: row.last_presence_at === null ? null : date(row.last_presence_at),
    displayName: row.display_name,
  };
}

function mapRoom(row: RoomRow, players: RoomPlayerRow[]): RoomRecord {
  const capacity = safeInteger(row.capacity, "room capacity", 4);
  if (capacity > 7 || !["waiting", "starting", "in_game", "paused", "completed", "closed"].includes(row.status)) {
    throw new D1StorageInvariantError("Stored room metadata is invalid.");
  }
  return {
    id: row.id,
    ownerPlayerId: row.owner_player_id,
    inviteCodeHash: row.invite_code_hash,
    status: row.status,
    capacity: capacity as RoomRecord["capacity"],
    version: safeInteger(row.version, "room version"),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    latestMatchId: row.latest_match_id,
    players: players.map(mapRoomPlayer),
  };
}

function mapMatchPlayer(row: MatchPlayerRow): NewMatchPlayer {
  return {
    playerId: row.player_id,
    seatIndex: safeInteger(row.seat_index, "match seat index"),
    alive: bool(row.alive),
    eliminatedAt: row.eliminated_at === null ? null : date(row.eliminated_at),
    connectionState: row.connection_state,
  };
}

function mapMatch(row: MatchRow, players: MatchPlayerRow[], supportedSchemaVersion?: number): MatchRecord {
  const state = decodeMatchState(row.state_json);
  if (state.schemaVersion !== row.state_schema_version || state.version !== safeInteger(row.version, "match version") ||
      state.eventSeq !== safeInteger(row.event_seq, "match event sequence") || state.status !== row.status ||
      state.rulesetVersion !== row.ruleset_version) {
    throw new D1StorageInvariantError("Stored match columns do not match the state snapshot metadata.");
  }
  if (supportedSchemaVersion !== undefined) parseMatchState(state, supportedSchemaVersion);
  return {
    id: row.id,
    roomId: row.room_id,
    status: row.status,
    version: state.version,
    eventSeq: state.eventSeq,
    rulesetVersion: row.ruleset_version,
    stateSchemaVersion: row.state_schema_version,
    state,
    createdAt: date(row.created_at),
    startedAt: date(row.started_at),
    updatedAt: date(row.updated_at),
    endedAt: row.ended_at === null ? null : date(row.ended_at),
    players: players.map(mapMatchPlayer),
  };
}

function mapReceipt(row: ReceiptRow): CommandReceiptRecord {
  return {
    actorPlayerId: row.actor_player_id,
    commandId: row.command_id,
    matchId: row.match_id,
    roomId: row.room_id,
    requestHash: row.request_hash,
    outcome: decodeJson(row.outcome_json, "receipt outcome"),
    createdAt: date(row.created_at),
  };
}

function mapEvent(row: EventRow): MatchEventRecord {
  return {
    eventId: row.event_id,
    eventSeq: safeInteger(row.event_seq, "event sequence", 1),
    version: safeInteger(row.version, "event version", 1),
    type: row.type,
    actorPlayerId: row.actor_player_id,
    payload: decodeJson(row.payload_json, "event payload"),
    createdAt: date(row.created_at),
  };
}

function mapOutbox(row: OutboxRow): OutboxRecord {
  return {
    cursor: safeInteger(row.cursor, "outbox cursor", 1),
    eventId: row.event_id,
    aggregateId: row.aggregate_id,
    aggregateVersion: safeInteger(row.aggregate_version, "outbox aggregate version"),
    eventSeq: safeInteger(row.event_seq, "outbox event sequence"),
    kind: row.kind,
    payload: decodeJson(row.payload_json, "outbox payload"),
    createdAt: date(row.created_at),
    publishedAt: row.published_at === null ? null : date(row.published_at),
    retryCount: safeInteger(row.retry_count, "outbox retry count"),
  };
}

function receiptWrite(
  db: D1DatabaseLike,
  receipt: CommandReceiptInput,
  aggregate: { matchId: string | null; roomId: string | null },
  markerId?: string,
): D1PreparedStatement {
  const outcome = encodeJson(receipt.outcome, "receipt outcome");
  if (markerId) {
    return db.prepare(`
      INSERT INTO command_receipts (actor_player_id, command_id, match_id, room_id, request_hash, outcome_json)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
    `).bind(receipt.actorPlayerId, receipt.commandId, aggregate.matchId, aggregate.roomId,
      receipt.requestHash, outcome, markerId);
  }
  return db.prepare(`
    INSERT INTO command_receipts (actor_player_id, command_id, match_id, room_id, request_hash, outcome_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(receipt.actorPlayerId, receipt.commandId, aggregate.matchId, aggregate.roomId,
    receipt.requestHash, outcome);
}

function roomOutboxWrite(
  db: D1DatabaseLike,
  eventId: string,
  roomId: string,
  version: number,
  markerId?: string,
): D1PreparedStatement {
  const payload = JSON.stringify({ roomId, version });
  const query = markerId
    ? `INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
       SELECT ?, ?, ?, 0, 'room:changed', ? WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`
    : `INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
       VALUES (?, ?, ?, 0, 'room:changed', ?)`;
  return db.prepare(query).bind(...(markerId
    ? [eventId, roomId, version, payload, markerId]
    : [eventId, roomId, version, payload]));
}

function matchOutboxWrite(
  db: D1DatabaseLike,
  eventId: string,
  matchId: string,
  version: number,
  eventSeq: number,
  markerId?: string,
): D1PreparedStatement {
  const payload = JSON.stringify({ matchId, version, eventSeq });
  const query = markerId
    ? `INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
       SELECT ?, ?, ?, ?, 'match:changed', ? WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`
    : `INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
       VALUES (?, ?, ?, ?, 'match:changed', ?)`;
  return db.prepare(query).bind(...(markerId
    ? [eventId, matchId, version, eventSeq, payload, markerId]
    : [eventId, matchId, version, eventSeq, payload]));
}

function receiptReplay<T extends { outcome: JsonValue }>(
  receipt: CommandReceiptRecord,
  actorPlayerId: string,
  commandId: string,
  requestHash: string,
  aggregate: { matchId: string | null; roomId: string | null },
): { status: "duplicate"; outcome: JsonValue } {
  if (receipt.actorPlayerId !== actorPlayerId || receipt.commandId !== commandId ||
      receipt.requestHash !== requestHash || receipt.matchId !== aggregate.matchId || receipt.roomId !== aggregate.roomId) {
    throw new CommandIdReusedError(actorPlayerId, commandId);
  }
  return { status: "duplicate", outcome: receipt.outcome };
}

function validateReceipt(receipt: CommandReceiptInput): void {
  requiredText(receipt.actorPlayerId, "Receipt actor ID");
  requiredText(receipt.commandId, "Receipt command ID");
  requiredText(receipt.requestHash, "Receipt request hash");
  encodeJson(receipt.outcome, "receipt outcome");
}

function validateStateMetadata(state: GameState): void {
  parseMatchState(state);
}

function addMatchInsertStatements(
  db: D1DatabaseLike,
  input: NewMatch,
  markerId?: string,
  roomVersion?: number,
): D1PreparedStatement[] {
  validateStateMetadata(input.state);
  if (roomVersion !== undefined && (!Number.isSafeInteger(roomVersion) || roomVersion < 0)) {
    throw new TypeError("Match room version must be a non-negative safe integer.");
  }
  if (new Set(input.state.seats.map(({ public: player }) => player.playerId)).size !== input.state.seats.length) {
    throw new D1StorageInvariantError("Match state contains duplicate player IDs.");
  }
  const configuredPlayers = new Map((input.players ?? []).map((player) => [player.playerId, player.connectionState] as const));
  if (configuredPlayers.size !== (input.players ?? []).length) {
    throw new D1StorageInvariantError("Match player connection state contains duplicate player IDs.");
  }
  for (const configuredPlayerId of configuredPlayers.keys()) {
    if (!input.state.seats.some((seat) => seat.public.playerId === configuredPlayerId)) {
      throw new D1StorageInvariantError(`Configured player '${configuredPlayerId}' has no match state seat.`);
    }
  }
  const state = input.state;
  const startedAt = timestamp(input.startedAt);
  const matchSql = markerId
    ? `INSERT INTO matches (id, room_id, status, version, event_seq, ruleset_version, state_schema_version, state_json, room_version, started_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`
    : `INSERT INTO matches (id, room_id, status, version, event_seq, ruleset_version, state_schema_version, state_json, room_version, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) `;
  const matchValues: (string | number | null)[] = [input.id, input.roomId, state.status, state.version,
    state.eventSeq, state.rulesetVersion, state.schemaVersion, encodeJson(state, "match state"), roomVersion ?? null, startedAt];
  const statements: D1PreparedStatement[] = [db.prepare(matchSql).bind(...(markerId
    ? [...matchValues, markerId] : matchValues))];
  for (const seat of state.seats) {
    const player = seat.public;
    const playerSql = markerId
      ? `INSERT INTO match_players (match_id, player_id, seat_index, alive, eliminated_at, connection_state)
         SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`
      : `INSERT INTO match_players (match_id, player_id, seat_index, alive, eliminated_at, connection_state)
         VALUES (?, ?, ?, ?, ?, ?)`;
    const playerValues: (string | number | null)[] = [input.id, player.playerId, player.seatIndex,
      player.eliminated ? 0 : 1, player.eliminated ? new Date().toISOString() : null,
      configuredPlayers.get(player.playerId) ?? "disconnected"];
    statements.push(db.prepare(playerSql).bind(...(markerId ? [...playerValues, markerId] : playerValues)));
  }
  return statements;
}

function assertSameClockwiseRoster(room: RoomRecord, previousMatch: MatchRecord): void {
  const roomPlayers = [...room.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const previousPlayers = [...previousMatch.players].sort((a, b) => a.seatIndex - b.seatIndex);
  const rotationStart = roomPlayers.findIndex(({ playerId }) => playerId === previousPlayers[0]?.playerId);
  const unchanged = previousPlayers.length === roomPlayers.length
    && previousPlayers.every(({ seatIndex }, index) => seatIndex === index)
    && rotationStart >= 0
    && previousPlayers.every(({ playerId }, index) =>
      playerId === roomPlayers[(rotationStart + index) % roomPlayers.length]?.playerId);
  if (!unchanged) {
    throw new D1StorageInvariantError("Room roster differs from the latest completed match.");
  }
}

/** D1 repository. Mutating aggregates use D1 batch + conditional commit markers, never process-local locks. */
export class D1StorageRepository {
  constructor(private readonly db: D1DatabaseLike) {}

  async createGuestSession(input: GuestSessionInput): Promise<void> {
    requiredText(input.id, "Guest ID");
    requiredText(input.tokenHash, "Guest token hash");
    requiredText(input.displayName, "Display name");
    await this.db.prepare(`
      INSERT INTO guest_sessions (id, token_hash, display_name, expires_at)
      VALUES (?, ?, ?, ?)
    `).bind(input.id, input.tokenHash, input.displayName, timestamp(input.expiresAt)).run();
  }

  async findActiveGuestSessionByTokenHash(tokenHash: string, at = new Date()): Promise<GuestSessionLookup | null> {
    const row = await this.db.prepare(`
      SELECT id, display_name, expires_at FROM guest_sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
    `).bind(tokenHash, timestamp(at)).first<GuestRow>();
    return row ? { playerId: row.id, displayName: row.display_name, expiresAt: date(row.expires_at) } : null;
  }

  async revokeGuestSession(playerId: string, at = new Date()): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE guest_sessions SET revoked_at = COALESCE(revoked_at, ?)
      WHERE id = ? AND revoked_at IS NULL
    `).bind(timestamp(at), playerId).run();
    return changes(result) === 1;
  }

  async createRoom(input: NewRoom): Promise<void> {
    requiredText(input.id, "Room ID");
    requiredText(input.ownerPlayerId, "Room owner ID");
    requiredText(input.inviteCodeHash, "Invite code hash");
    this.validateNewRoomPlayers(input);
    const statements = [this.db.prepare(`
      INSERT INTO rooms (id, owner_player_id, invite_code_hash, capacity) VALUES (?, ?, ?, ?)
    `).bind(input.id, input.ownerPlayerId, input.inviteCodeHash, input.capacity),
    ...input.players.map((player) => this.db.prepare(`
      INSERT INTO room_players (room_id, player_id, seat_index, ready) VALUES (?, ?, ?, ?)
    `).bind(input.id, player.playerId, player.seatIndex, player.ready ? 1 : 0))];
    await this.db.batch(statements);
  }

  async createRoomCommand(input: CreateRoomCommandInput): Promise<RoomMutationResult> {
    requiredText(input.id, "Room ID");
    requiredText(input.ownerPlayerId, "Room owner ID");
    requiredText(input.inviteCodeHash, "Invite code hash");
    requiredText(input.actorPlayerId, "Room creator ID");
    requiredText(input.commandId, "Command ID");
    requiredText(input.requestHash, "Request hash");
    requiredText(input.outboxEventId, "Outbox event ID");
    if (input.actorPlayerId !== input.ownerPlayerId) throw new D1StorageInvariantError("Room creator must own the new room.");
    if (![4, 5, 6, 7].includes(input.capacity)) throw new TypeError("Room capacity must be 4 through 7.");
    const prior = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
    if (prior) {
      const replay = receiptReplay(prior, input.actorPlayerId, input.commandId, input.requestHash,
        { matchId: null, roomId: input.id });
      return { status: "duplicate", outcome: this.decodeRoomOutcome(replay.outcome) };
    }
    const outcome: RoomMutationOutcome = {
      roomId: input.id, version: 0, roomStatus: "waiting", ownerPlayerId: input.ownerPlayerId,
      occupancy: 1, changed: true, playerId: input.ownerPlayerId, seatIndex: 0,
    };
    try {
      await this.db.batch([
        this.db.prepare(`INSERT INTO rooms (id, owner_player_id, invite_code_hash, capacity) VALUES (?, ?, ?, ?)`)
          .bind(input.id, input.ownerPlayerId, input.inviteCodeHash, input.capacity),
        this.db.prepare(`INSERT INTO room_players (room_id, player_id, seat_index, ready) VALUES (?, ?, 0, 0)`)
          .bind(input.id, input.ownerPlayerId),
        receiptWrite(this.db, { actorPlayerId: input.actorPlayerId, commandId: input.commandId,
          requestHash: input.requestHash, outcome: outcome as unknown as JsonValue }, { matchId: null, roomId: input.id }),
        roomOutboxWrite(this.db, input.outboxEventId, input.id, 0),
      ]);
    } catch (error) {
      const raced = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
      if (raced) {
        const replay = receiptReplay(raced, input.actorPlayerId, input.commandId, input.requestHash,
          { matchId: null, roomId: input.id });
        return { status: "duplicate", outcome: this.decodeRoomOutcome(replay.outcome) };
      }
      throw error;
    }
    return { status: "applied", outcome };
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    requiredText(roomId, "Room ID");
    const results = await this.db.batch([
      this.db.prepare(`
        SELECT id, owner_player_id, invite_code_hash, status, capacity, version, created_at, updated_at,
          (SELECT id FROM matches WHERE room_id = rooms.id
           ORDER BY room_version DESC, created_at DESC, started_at DESC, id DESC LIMIT 1) AS latest_match_id
        FROM rooms WHERE id = ?
      `).bind(roomId),
      this.db.prepare(`
        SELECT rp.player_id, rp.seat_index, rp.ready, rp.joined_at, rp.last_presence_at, gs.display_name
        FROM room_players AS rp LEFT JOIN guest_sessions AS gs ON gs.id = rp.player_id
        WHERE rp.room_id = ? ORDER BY rp.seat_index
      `).bind(roomId),
    ]);
    const row = results[0]?.results?.[0] as RoomRow | undefined;
    if (!row) return null;
    return mapRoom(row, (results[1]?.results ?? []) as RoomPlayerRow[]);
  }

  async getRoomPreviewByInviteHash(inviteCodeHash: string): Promise<RoomPreviewRecord | null> {
    const row = await this.db.prepare(`
      SELECT r.id, r.version, r.status, COUNT(rp.player_id) AS occupancy
      FROM rooms r LEFT JOIN room_players rp ON rp.room_id = r.id
      WHERE r.invite_code_hash = ? GROUP BY r.id, r.version, r.status
    `).bind(inviteCodeHash).first<{ id: string; version: number | string; status: RoomStatus; occupancy: number | string }>();
    return row ? { roomId: row.id, version: safeInteger(row.version, "room version"),
      occupancy: safeInteger(row.occupancy, "room occupancy"), status: row.status } : null;
  }

  async listRoomsForPlayer(playerId: string): Promise<RoomRecord[]> {
    requiredText(playerId, "Player ID");
    const result = await this.db.prepare(`
      SELECT r.id, r.owner_player_id, r.invite_code_hash, r.status, r.capacity, r.version, r.created_at, r.updated_at,
        (SELECT id FROM matches WHERE room_id = r.id
         ORDER BY room_version DESC, created_at DESC, started_at DESC, id DESC LIMIT 1) AS latest_match_id,
        viewer.joined_at AS viewer_joined_at,
        members.player_id, members.seat_index, members.ready, members.joined_at, members.last_presence_at,
        gs.display_name
      FROM room_players AS viewer
      JOIN rooms AS r ON r.id = viewer.room_id
      JOIN room_players AS members ON members.room_id = r.id
      LEFT JOIN guest_sessions AS gs ON gs.id = members.player_id
      WHERE viewer.player_id = ?
      ORDER BY viewer.joined_at, r.id, members.seat_index
    `).bind(playerId).all<RoomRow & RoomPlayerRow & { viewer_joined_at: string }>();
    const groups = new Map<string, { room: RoomRow; players: RoomPlayerRow[] }>();
    for (const row of result.results ?? []) {
      let group = groups.get(row.id);
      if (!group) {
        const { viewer_joined_at: _viewerJoinedAt, ...room } = row;
        group = { room, players: [] };
        groups.set(row.id, group);
      }
      group.players.push(row);
    }
    return [...groups.values()].map(({ room, players }) => mapRoom(room, players));
  }

  async createMatch(input: NewMatch): Promise<void> {
    await this.db.batch(addMatchInsertStatements(this.db, input));
  }

  async getLatestMatchIdForRoom(roomId: string): Promise<string | null> {
    requiredText(roomId, "Room ID");
    const row = await this.db.prepare(`
      SELECT id FROM matches WHERE room_id = ?
      ORDER BY room_version DESC, created_at DESC, started_at DESC, id DESC LIMIT 1
    `).bind(roomId).first<{ id: string }>();
    return row?.id ?? null;
  }

  async getMatch(matchId: string, options: { supportedSchemaVersion?: number } = {}): Promise<MatchRecord | null> {
    return this.loadMatch(matchId, options);
  }

  /**
   * The first row is membership-scoped, and the player rows are gated by the same
   * membership predicate. State JSON is decoded only after that authorization row
   * exists, within one D1 batch snapshot.
   */
  async getMatchForPlayer(
    matchId: string,
    playerId: string,
    options: { supportedSchemaVersion?: number } = {},
  ): Promise<MatchRecord | null> {
    requiredText(playerId, "Player ID");
    return this.loadMatch(matchId, options, playerId);
  }

  /**
   * Load the command's authorization, idempotency receipt and current aggregate
   * from one D1 snapshot. Receipt decoding intentionally precedes state decoding:
   * a member's committed command remains replayable after a later snapshot needs
   * recovery, while outsiders never get to inspect either result.
   */
  async loadMatchCommandContext(
    matchId: string,
    actorPlayerId: string,
    commandId: string,
    options: { supportedSchemaVersion?: number } = {},
  ): Promise<MatchCommandContext> {
    requiredText(matchId, "Match ID");
    requiredText(actorPlayerId, "Match command actor");
    requiredText(commandId, "Command ID");
    const results = await this.db.batch([
      this.db.prepare(`
        SELECT id, room_id, status, version, event_seq, ruleset_version, state_schema_version, state_json,
               created_at, started_at, updated_at, ended_at
        FROM matches WHERE id = ?
          AND EXISTS (SELECT 1 FROM match_players WHERE match_id = matches.id AND player_id = ?)
      `).bind(matchId, actorPlayerId),
      this.db.prepare(`
        SELECT player_id, seat_index, alive, eliminated_at, connection_state
        FROM match_players WHERE match_id = ?
          AND EXISTS (SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?)
        ORDER BY seat_index
      `).bind(matchId, matchId, actorPlayerId),
      this.db.prepare(`
        SELECT actor_player_id, command_id, match_id, room_id, request_hash, outcome_json, created_at
        FROM command_receipts WHERE actor_player_id = ? AND command_id = ?
      `).bind(actorPlayerId, commandId),
    ]);
    const row = results[0]?.results?.[0] as MatchRow | undefined;
    if (!row) return { status: "not-member" };
    const receiptRow = results[2]?.results?.[0] as ReceiptRow | undefined;
    if (receiptRow) return { status: "receipt", receipt: mapReceipt(receiptRow) };
    const match = mapMatch(row, (results[1]?.results ?? []) as MatchPlayerRow[], options.supportedSchemaVersion);
    return { status: "match", match };
  }

  private async loadMatch(
    matchId: string,
    options: { supportedSchemaVersion?: number },
    playerId?: string,
  ): Promise<MatchRecord | null> {
    requiredText(matchId, "Match ID");
    const membershipClause = playerId === undefined ? "" :
      " AND EXISTS (SELECT 1 FROM match_players WHERE match_id = matches.id AND player_id = ?)";
    const headerStatement = this.db.prepare(`
      SELECT id, room_id, status, version, event_seq, ruleset_version, state_schema_version, state_json,
             created_at, started_at, updated_at, ended_at
      FROM matches WHERE id = ?${membershipClause}
    `).bind(...(playerId === undefined ? [matchId] : [matchId, playerId]));
    const playersStatement = this.db.prepare(`
      SELECT player_id, seat_index, alive, eliminated_at, connection_state
      FROM match_players WHERE match_id = ?${playerId === undefined ? "" : `
        AND EXISTS (SELECT 1 FROM match_players WHERE match_id = ? AND player_id = ?)`}
      ORDER BY seat_index
    `).bind(...(playerId === undefined ? [matchId] : [matchId, matchId, playerId]));
    const results = await this.db.batch([headerStatement, playersStatement]);
    const row = results[0]?.results?.[0] as MatchRow | undefined;
    if (!row) return null;
    return mapMatch(row, (results[1]?.results ?? []) as MatchPlayerRow[], options.supportedSchemaVersion);
  }

  async findCommandReceipt(actorPlayerId: string, commandId: string): Promise<CommandReceiptRecord | null> {
    const row = await this.db.prepare(`
      SELECT actor_player_id, command_id, match_id, room_id, request_hash, outcome_json, created_at
      FROM command_receipts WHERE actor_player_id = ? AND command_id = ?
    `).bind(actorPlayerId, commandId).first<ReceiptRow>();
    return row ? mapReceipt(row) : null;
  }

  async listMatchEvents(matchId: string, afterEventSeq = 0, limit = 100): Promise<MatchEventRecord[]> {
    safeInteger(afterEventSeq, "event cursor");
    this.validateLimit(limit, "event query limit");
    const result = await this.db.prepare(`
      SELECT event_id, event_seq, version, type, actor_player_id, payload_json, created_at
      FROM match_events WHERE match_id = ? AND event_seq > ? ORDER BY event_seq LIMIT ?
    `).bind(matchId, afterEventSeq, limit).all<EventRow>();
    return (result.results ?? []).map(mapEvent);
  }

  async listOutboxAfter(cursor: number, aggregateIds?: readonly string[], limit = 100): Promise<OutboxRecord[]> {
    safeInteger(cursor, "outbox cursor");
    this.validateLimit(limit, "outbox query limit");
    if (aggregateIds && aggregateIds.length === 0) return [];
    const membership = aggregateIds === undefined ? "" :
      ` AND aggregate_id IN (${aggregateIds.map(() => "?").join(", ")})`;
    const values: (string | number)[] = [cursor, ...(aggregateIds ?? []), limit];
    const result = await this.db.prepare(`
      SELECT cursor, event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json,
             created_at, published_at, retry_count
      FROM outbox WHERE cursor > ?${membership} ORDER BY cursor LIMIT ?
    `).bind(...values).all<OutboxRow>();
    return (result.results ?? []).map(mapOutbox);
  }

  async listOutboxInvalidationsAfter(
    cursor: number,
    aggregateIds: readonly string[],
    limit = 100,
  ): Promise<OutboxInvalidationRecord[]> {
    safeInteger(cursor, "outbox cursor");
    this.validateLimit(limit, "outbox query limit");
    if (aggregateIds.length === 0) return [];
    const membership = ` AND aggregate_id IN (${aggregateIds.map(() => "?").join(", ")})`;
    const result = await this.db.prepare(`
      SELECT cursor, event_id, aggregate_id, aggregate_version, event_seq, kind
      FROM outbox WHERE cursor > ?${membership} ORDER BY cursor LIMIT ?
    `).bind(cursor, ...aggregateIds, limit).all<OutboxInvalidationRow>();
    return (result.results ?? []).map((row) => ({
      cursor: safeInteger(row.cursor, "outbox cursor", 1),
      eventId: row.event_id,
      aggregateId: row.aggregate_id,
      aggregateVersion: safeInteger(row.aggregate_version, "outbox aggregate version"),
      eventSeq: safeInteger(row.event_seq, "outbox event sequence"),
      kind: row.kind,
    }));
  }

  /** Renew this player's observation without changing membership or game state. */
  async touchRoomPresence(playerId: string, observedAt = new Date(), roomIds?: readonly string[]): Promise<number> {
    requiredText(playerId, "Player ID");
    const observedAtText = timestamp(observedAt)!;
    if (roomIds?.length === 0) return 0;
    const scope = roomIds ? `AND room_id IN (${roomIds.map(() => "?").join(",")})` : "";
    const result = await this.db.prepare(`
      UPDATE room_players
      SET last_presence_at = CASE
        WHEN last_presence_at IS NULL OR last_presence_at < ? THEN ?
        ELSE last_presence_at
      END
      WHERE player_id = ?
        AND EXISTS (SELECT 1 FROM rooms WHERE rooms.id = room_players.room_id AND rooms.status <> 'closed')
        ${scope}
    `).bind(observedAtText, observedAtText, playerId, ...(roomIds ?? [])).run();
    return changes(result);
  }

  async listPendingOutbox(limit = 100): Promise<OutboxRecord[]> {
    this.validateLimit(limit, "outbox query limit", 1000);
    const result = await this.db.prepare(`
      SELECT cursor, event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json,
             created_at, published_at, retry_count
      FROM outbox WHERE published_at IS NULL ORDER BY cursor LIMIT ?
    `).bind(limit).all<OutboxRow>();
    return (result.results ?? []).map(mapOutbox);
  }

  async markOutboxPublished(eventId: string, publishedAt = new Date()): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE outbox SET published_at = COALESCE(published_at, ?)
      WHERE event_id = ? AND published_at IS NULL
    `).bind(timestamp(publishedAt), eventId).run();
    return changes(result) === 1;
  }

  async recordOutboxFailure(eventId: string): Promise<boolean> {
    const result = await this.db.prepare(`
      UPDATE outbox SET retry_count = retry_count + 1 WHERE event_id = ? AND published_at IS NULL
    `).bind(eventId).run();
    return changes(result) === 1;
  }

  async commitMatch(input: MatchCommitInput): Promise<MatchCommitResult> {
    this.validateAggregateCommand(input.matchId, input.expectedVersion, input.markerId);
    requiredText(input.outboxEventId, "Outbox event ID");
    validateReceipt(input.receipt);
    safeInteger(input.expectedEventSeq, "expected match event sequence");
    validateStateMetadata(input.state);
    if (!Number.isSafeInteger(input.expectedVersion + 1) || input.state.version !== input.expectedVersion + 1) {
      throw new D1StorageInvariantError("A committed match state must advance its version exactly once.");
    }
    if (input.state.eventSeq < input.expectedEventSeq) throw new D1StorageInvariantError("Match eventSeq cannot move backwards.");
    if (input.events.length !== input.state.eventSeq - input.expectedEventSeq) {
      throw new D1StorageInvariantError("Match event count must equal the eventSeq advance.");
    }
    input.events.forEach((event, index) => {
      if (event.eventSeq !== input.expectedEventSeq + index + 1 || event.version !== input.state.version) {
        throw new D1StorageInvariantError(`Event '${event.eventId}' has a non-contiguous sequence or version.`);
      }
      requiredText(event.eventId, "Event ID");
      requiredText(event.type, "Event type");
      assertObjectJson(event.payload, "event payload");
    });

    const stateJson = encodeJson(input.state, "match state");
    const statements: D1PreparedStatement[] = [this.db.prepare(`
      INSERT INTO commit_guards (marker_id, aggregate_id, expected_version)
      SELECT ?, ?, ? FROM matches
      WHERE id = ? AND version = ? AND event_seq = ? AND ruleset_version = ? AND state_schema_version = ?
        AND EXISTS (SELECT 1 FROM match_players WHERE match_id = matches.id AND player_id = ?)
    `).bind(input.markerId, input.matchId, input.expectedVersion, input.matchId, input.expectedVersion,
      input.expectedEventSeq, input.state.rulesetVersion, input.state.schemaVersion, input.receipt.actorPlayerId),
    this.db.prepare(`
      UPDATE matches SET status = ?, version = ?, event_seq = ?, ruleset_version = ?,
        state_schema_version = ?, state_json = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        ended_at = CASE WHEN ? = 'completed'
          THEN COALESCE(ended_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) ELSE ended_at END
      WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
    `).bind(input.state.status, input.state.version, input.state.eventSeq, input.state.rulesetVersion,
      input.state.schemaVersion, stateJson, input.state.status, input.matchId, input.expectedVersion, input.markerId)];

    for (const event of input.events) {
      statements.push(this.db.prepare(`
        INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
      `).bind(input.matchId, event.eventSeq, event.eventId, event.version, event.type, event.actorPlayerId,
        encodeJson(event.payload, "event payload"), timestamp(event.createdAt), input.markerId));
    }
    statements.push(receiptWrite(this.db, input.receipt, { matchId: input.matchId, roomId: null }, input.markerId));
    statements.push(matchOutboxWrite(this.db, input.outboxEventId, input.matchId, input.state.version,
      input.state.eventSeq, input.markerId));
    statements.push(this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(input.markerId));

    try {
      const results = await this.db.batch(statements);
      if (changes(results[0]) === 1) {
        return { status: "committed", version: input.state.version, eventSeq: input.state.eventSeq,
          outboxEventId: input.outboxEventId };
      }
    } catch (error) {
      const racedReceipt = await this.findCommandReceipt(input.receipt.actorPlayerId, input.receipt.commandId);
      if (racedReceipt) return receiptReplay(racedReceipt, input.receipt.actorPlayerId, input.receipt.commandId,
        input.receipt.requestHash, { matchId: input.matchId, roomId: null });
      throw error;
    }
    const late = await this.findCommandReceipt(input.receipt.actorPlayerId, input.receipt.commandId);
    if (late) return receiptReplay(late, input.receipt.actorPlayerId, input.receipt.commandId,
      input.receipt.requestHash, { matchId: input.matchId, roomId: null });
    const latest = await this.db.prepare(`
      SELECT version, event_seq, ruleset_version, state_schema_version,
        EXISTS (SELECT 1 FROM match_players WHERE match_id = matches.id AND player_id = ?) AS actor_is_member
      FROM matches WHERE id = ?
    `).bind(input.receipt.actorPlayerId, input.matchId).first<MatchMetadataRow & { actor_is_member: number | boolean }>();
    if (!latest) throw new MatchNotFoundError(input.matchId);
    if (!bool(latest.actor_is_member)) throw new MatchNotFoundError(input.matchId);
    const latestVersion = safeInteger(latest.version, "match version");
    if (latestVersion !== input.expectedVersion) {
      throw new StaleMatchVersionError(input.expectedVersion, latestVersion, input.state.version);
    }
    if (safeInteger(latest.event_seq, "match event sequence") !== input.expectedEventSeq) {
      throw new D1StorageInvariantError("Match eventSeq changed without a version change.");
    }
    if (latest.ruleset_version !== input.state.rulesetVersion || latest.state_schema_version !== input.state.schemaVersion) {
      throw new D1StorageInvariantError("A match command cannot change its ruleset or state schema version.");
    }
    throw new D1StorageInvariantError("Match commit guard failed although its version and metadata still match.");
  }

  async recordMatchRejection(input: MatchRejectionReceiptInput): Promise<MatchRejectionReceiptResult> {
    this.validateAggregateCommand(input.matchId, input.observedVersion, input.markerId);
    validateReceipt(input.receipt);
    const current = await this.db.prepare("SELECT version FROM matches WHERE id = ?")
      .bind(input.matchId).first<{ version: number | string }>();
    if (!current) throw new MatchNotFoundError(input.matchId);
    const currentVersion = safeInteger(current.version, "match version");
    const member = await this.db.prepare(
      "SELECT 1 AS found FROM match_players WHERE match_id = ? AND player_id = ?",
    ).bind(input.matchId, input.receipt.actorPlayerId).first<{ found: number }>();
    if (!member) throw new D1StorageInvariantError("Rejection actor is not a player in this match.");
    const existing = await this.findCommandReceipt(input.receipt.actorPlayerId, input.receipt.commandId);
    if (existing) return receiptReplay(existing, input.receipt.actorPlayerId, input.receipt.commandId,
      input.receipt.requestHash, { matchId: input.matchId, roomId: null });
    if (currentVersion !== input.observedVersion) return { status: "version_changed", currentVersion };

    try {
      const results = await this.db.batch([
        this.db.prepare(`
          INSERT INTO commit_guards (marker_id, aggregate_id, expected_version)
          SELECT ?, ?, ? FROM matches WHERE id = ? AND version = ?
        `).bind(input.markerId, input.matchId, input.observedVersion, input.matchId, input.observedVersion),
        receiptWrite(this.db, input.receipt, { matchId: input.matchId, roomId: null }, input.markerId),
        this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(input.markerId),
      ]);
      if (changes(results[0]) === 1) return { status: "recorded", currentVersion };
    } catch (error) {
      const raced = await this.findCommandReceipt(input.receipt.actorPlayerId, input.receipt.commandId);
      if (raced) return receiptReplay(raced, input.receipt.actorPlayerId, input.receipt.commandId,
        input.receipt.requestHash, { matchId: input.matchId, roomId: null });
      throw error;
    }
    const late = await this.findCommandReceipt(input.receipt.actorPlayerId, input.receipt.commandId);
    if (late) return receiptReplay(late, input.receipt.actorPlayerId, input.receipt.commandId,
      input.receipt.requestHash, { matchId: input.matchId, roomId: null });
    const latest = await this.db.prepare("SELECT version FROM matches WHERE id = ?")
      .bind(input.matchId).first<{ version: number | string }>();
    if (!latest) throw new MatchNotFoundError(input.matchId);
    return { status: "version_changed", currentVersion: safeInteger(latest.version, "match version") };
  }

  async commitRoomCommand(input: RoomCommandInput): Promise<RoomMutationResult> {
    this.validateAggregateCommand(input.roomId, input.expectedVersion, input.markerId);
    requiredText(input.actorPlayerId, "Room command actor");
    requiredText(input.commandId, "Command ID");
    requiredText(input.requestHash, "Request hash");
    validateReceipt({ actorPlayerId: input.actorPlayerId, commandId: input.commandId,
      requestHash: input.requestHash, outcome: input.receiptOutcome });
    if (input.changed && !input.outboxEventId) throw new TypeError("Changed room commands require an outbox event ID.");
    const prior = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
    if (prior) {
      const duplicate = receiptReplay(prior, input.actorPlayerId, input.commandId, input.requestHash,
        { matchId: null, roomId: input.roomId });
      return { status: "duplicate", outcome: this.decodeRoomOutcome(duplicate.outcome) };
    }
    const room = await this.getRoom(input.roomId);
    if (!room) throw new RoomNotFoundError(input.roomId);
    if (room.version !== input.expectedVersion) {
      const late = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
      if (late) {
        const replay = receiptReplay(late, input.actorPlayerId, input.commandId, input.requestHash,
          { matchId: null, roomId: input.roomId });
        return { status: "duplicate", outcome: this.decodeRoomOutcome(replay.outcome) };
      }
      throw new RoomVersionConflictError(input.expectedVersion, room.version);
    }
    if (!input.changed && (room.status !== input.status || room.ownerPlayerId !== input.ownerPlayerId)) {
      throw new D1StorageInvariantError("A no-op room command cannot change room metadata.");
    }
    if (!input.changed && (input.playerWrites?.length ?? 0) > 0) {
      throw new D1StorageInvariantError("A no-op room command cannot write room player rows.");
    }
    const version = input.expectedVersion + (input.changed ? 1 : 0);
    const roomOutcome = this.decodeRoomOutcome(input.receiptOutcome);
    if (roomOutcome.roomId !== input.roomId || roomOutcome.version !== version ||
        roomOutcome.roomStatus !== input.status || roomOutcome.ownerPlayerId !== input.ownerPlayerId ||
        roomOutcome.changed !== input.changed) {
      throw new D1StorageInvariantError("Room receipt outcome does not describe the proposed room commit.");
    }
    const receipt: CommandReceiptInput = { actorPlayerId: input.actorPlayerId, commandId: input.commandId,
      requestHash: input.requestHash, outcome: input.receiptOutcome };
    const statements: D1PreparedStatement[] = [this.db.prepare(`
      INSERT INTO commit_guards (marker_id, aggregate_id, expected_version)
      SELECT ?, ?, ? FROM rooms WHERE id = ? AND version = ?
    `).bind(input.markerId, input.roomId, input.expectedVersion, input.roomId, input.expectedVersion)];
    if (input.changed) {
      statements.push(this.db.prepare(`
        UPDATE rooms SET status = ?, owner_player_id = ?, version = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ? AND version = ? AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
      `).bind(input.status, input.ownerPlayerId, version, input.roomId, input.expectedVersion, input.markerId));
    }
    for (const write of input.playerWrites ?? []) {
      if (write.operation === "insert") {
        statements.push(this.db.prepare(`
          INSERT INTO room_players (room_id, player_id, seat_index, ready)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(input.roomId, write.playerId, write.seatIndex, write.ready ? 1 : 0, input.markerId));
      } else if (write.operation === "delete") {
        statements.push(this.db.prepare(`
          DELETE FROM room_players WHERE room_id = ? AND player_id = ?
            AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(input.roomId, write.playerId, input.markerId));
      } else {
        statements.push(this.db.prepare(`
          UPDATE room_players SET ready = ? WHERE room_id = ? AND player_id = ?
            AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(write.ready ? 1 : 0, input.roomId, write.playerId, input.markerId));
      }
    }
    statements.push(receiptWrite(this.db, receipt, { matchId: null, roomId: input.roomId }, input.markerId));
    if (input.changed) statements.push(roomOutboxWrite(this.db, input.outboxEventId!, input.roomId, version, input.markerId));
    statements.push(this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(input.markerId));
    try {
      const results = await this.db.batch(statements);
      if (changes(results[0]) === 1) return { status: "applied", outcome: this.decodeRoomOutcome(input.receiptOutcome) };
    } catch (error) {
      const raced = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
      if (raced) {
        const duplicate = receiptReplay(raced, input.actorPlayerId, input.commandId, input.requestHash,
          { matchId: null, roomId: input.roomId });
        return { status: "duplicate", outcome: this.decodeRoomOutcome(duplicate.outcome) };
      }
      throw error;
    }
    const late = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
    if (late) {
      const duplicate = receiptReplay(late, input.actorPlayerId, input.commandId, input.requestHash,
        { matchId: null, roomId: input.roomId });
      return { status: "duplicate", outcome: this.decodeRoomOutcome(duplicate.outcome) };
    }
    const latest = await this.db.prepare("SELECT version FROM rooms WHERE id = ?")
      .bind(input.roomId).first<{ version: number | string }>();
    if (!latest) throw new RoomNotFoundError(input.roomId);
    throw new RoomVersionConflictError(input.expectedVersion, safeInteger(latest.version, "room version"));
  }

  async startRoomWithMatch(input: StartRoomWithMatchInput): Promise<StartRoomWithMatchResult> {
    this.validateAggregateCommand(input.roomId, input.expectedVersion, input.markerId);
    requiredText(input.matchId, "Match ID");
    requiredText(input.matchOutboxEventId, "Match outbox event ID");
    requiredText(input.roomOutboxEventId, "Room outbox event ID");
    if (input.matchOutboxEventId === input.roomOutboxEventId) throw new TypeError("Room/match outbox IDs must differ.");
    validateReceipt({ actorPlayerId: input.actorPlayerId, commandId: input.commandId,
      requestHash: input.requestHash, outcome: { ok: true } });
    const existing = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
    if (existing) return { status: "duplicate", outcome: this.decodeStartOutcome(receiptReplay(existing,
      input.actorPlayerId, input.commandId, input.requestHash, { matchId: null, roomId: input.roomId }).outcome) };
    const room = await this.getRoom(input.roomId);
    if (!room) throw new RoomNotFoundError(input.roomId);
    if (room.version !== input.expectedVersion) {
      const late = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
      if (late) return { status: "duplicate", outcome: this.decodeStartOutcome(receiptReplay(late,
        input.actorPlayerId, input.commandId, input.requestHash, { matchId: null, roomId: input.roomId }).outcome) };
      throw new RoomVersionConflictError(input.expectedVersion, room.version);
    }
    if (room.status !== "waiting" && room.status !== "in_game") {
      throw new D1StorageInvariantError("Only a waiting room or a room with a completed latest match can be started.");
    }
    if (room.ownerPlayerId !== input.actorPlayerId) throw new D1StorageInvariantError("Only the room owner can start a match.");
    if (room.players.length < 4 || room.players.length > room.capacity || room.players.some((player) => !player.ready)) {
      throw new D1StorageInvariantError("Room roster is not ready for a match start.");
    }
    let completedMatch: MatchRecord | null = null;
    if (room.status === "in_game") {
      const latestMatchId = await this.getLatestMatchIdForRoom(room.id);
      completedMatch = latestMatchId ? await this.getMatch(latestMatchId) : null;
      if (!completedMatch || completedMatch.status !== "completed") {
        throw new D1StorageInvariantError("The latest match must be completed before the room can restart.");
      }
      assertSameClockwiseRoster(room, completedMatch);
    }
    const state = parseMatchState(input.state);
    if (input.events && (input.events.length !== state.eventSeq ||
        new Set(input.events.map(event => event.eventId)).size !== input.events.length ||
        input.events.some((event, index) => event.eventSeq !== index + 1 || event.version !== state.version))) {
      throw new D1StorageInvariantError("Initial events must cover the new match cursor exactly once.");
    }
    if (state.seats.length !== room.players.length) {
      throw new D1StorageInvariantError("Initial match state does not match the ready room roster.");
    }
    const roomRoster = [...room.players].sort((a, b) => a.seatIndex - b.seatIndex);
    const stateRoster = [...state.seats].sort((a, b) => a.public.seatIndex - b.public.seatIndex);
    const roomPlayerIds = new Set(roomRoster.map(({ playerId }) => playerId));
    const statePlayerIds = new Set(stateRoster.map(({ public: player }) => player.playerId));
    const stateSeatIndexes = new Set(stateRoster.map(({ public: player }) => player.seatIndex));
    if (roomPlayerIds.size !== roomRoster.length || statePlayerIds.size !== stateRoster.length ||
        stateSeatIndexes.size !== stateRoster.length ||
        stateRoster.some(({ public: player }, index) => player.seatIndex !== index || !roomPlayerIds.has(player.playerId)) ||
        [...roomPlayerIds].some((playerId) => !statePlayerIds.has(playerId))) {
      throw new D1StorageInvariantError("Initial match seats must cover the ready room player set exactly once.");
    }
    const version = room.version + 1;
    const outcome: StartRoomWithMatchOutcome = {
      roomId: room.id, matchId: input.matchId, version, roomStatus: "in_game",
      ownerPlayerId: room.ownerPlayerId, occupancy: room.players.length, changed: true,
    };
    const receipt: CommandReceiptInput = { actorPlayerId: input.actorPlayerId, commandId: input.commandId,
      requestHash: input.requestHash, outcome: outcome as unknown as JsonValue };
    const roomRosterGuard = roomRoster.map(() => "(rp.player_id = ? AND rp.seat_index = ?)").join(" OR ");
    const stateJson = encodeJson(state, "match state");
    const restartGuard = completedMatch
      ? `AND EXISTS (
           SELECT 1 FROM matches AS latest
           WHERE latest.id = ? AND latest.room_id = r.id AND latest.status = 'completed'
             AND latest.id = (
               SELECT id FROM matches WHERE room_id = r.id
               ORDER BY room_version DESC, created_at DESC, started_at DESC, id DESC LIMIT 1
             )
         )
         AND (SELECT COUNT(*) FROM match_players WHERE match_id = ?) = ?
         AND NOT EXISTS (
           SELECT 1 FROM match_players AS previous
           WHERE previous.match_id = ? AND NOT (${completedMatch.players
             .map(() => "(previous.player_id = ? AND previous.seat_index = ?)").join(" OR ")})
         )`
      : "";
    const startGuard = this.db.prepare(`
      INSERT INTO commit_guards (marker_id, aggregate_id, expected_version)
      SELECT ?, ?, ? FROM rooms AS r
      WHERE r.id = ? AND r.version = ? AND r.status = ? AND r.owner_player_id = ?
        AND EXISTS (SELECT 1 FROM room_players AS owner WHERE owner.room_id = r.id AND owner.player_id = ?)
        AND (SELECT COUNT(*) FROM room_players WHERE room_id = r.id) BETWEEN 4 AND r.capacity
        AND NOT EXISTS (SELECT 1 FROM room_players WHERE room_id = r.id AND ready <> 1)
        AND (SELECT COUNT(*) FROM room_players WHERE room_id = r.id) = ?
        AND NOT EXISTS (
          SELECT 1 FROM room_players AS rp WHERE rp.room_id = r.id AND NOT (${roomRosterGuard})
        )
        AND json_array_length(?, '$.seats') = (SELECT COUNT(*) FROM room_players WHERE room_id = r.id)
        AND (SELECT COUNT(DISTINCT json_extract(seat.value, '$.public.playerId'))
             FROM json_each(?, '$.seats') AS seat) = (SELECT COUNT(*) FROM room_players WHERE room_id = r.id)
        AND (SELECT COUNT(DISTINCT json_extract(seat.value, '$.public.seatIndex'))
             FROM json_each(?, '$.seats') AS seat) = (SELECT COUNT(*) FROM room_players WHERE room_id = r.id)
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?, '$.seats') AS seat
          WHERE CAST(json_extract(seat.value, '$.public.seatIndex') AS INTEGER) < 0
             OR CAST(json_extract(seat.value, '$.public.seatIndex') AS INTEGER) >=
                (SELECT COUNT(*) FROM room_players WHERE room_id = r.id)
             OR NOT EXISTS (
               SELECT 1 FROM room_players AS rp
               WHERE rp.room_id = r.id
                 AND rp.player_id = json_extract(seat.value, '$.public.playerId')
             )
        )
        ${restartGuard}
    `).bind(
      input.markerId, room.id, input.expectedVersion,
      room.id, input.expectedVersion, room.status, input.actorPlayerId, input.actorPlayerId,
      roomRoster.length, ...roomRoster.flatMap(({ playerId, seatIndex }) => [playerId, seatIndex]),
      stateJson, stateJson, stateJson, stateJson,
      ...(completedMatch ? [
        completedMatch.id,
        completedMatch.id, completedMatch.players.length,
        completedMatch.id,
        ...completedMatch.players.flatMap(({ playerId, seatIndex }) => [playerId, seatIndex]),
      ] : []),
    );
    const statements: D1PreparedStatement[] = [startGuard,
    this.db.prepare(`
      UPDATE rooms SET status = 'in_game', version = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND version = ? AND status = ?
        AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
    `).bind(version, room.id, input.expectedVersion, room.status, input.markerId),
    ...addMatchInsertStatements(this.db,
      { id: input.matchId, roomId: room.id, state, startedAt: input.startedAt }, input.markerId, version),
    ...(input.events ?? []).map(event => this.db.prepare(`
      INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
    `).bind(input.matchId, event.eventSeq, event.eventId, event.version, event.type, event.actorPlayerId,
      encodeJson(event.payload, "initial event payload"), timestamp(event.createdAt), input.markerId)),
    receiptWrite(this.db, receipt, { matchId: null, roomId: room.id }, input.markerId),
    roomOutboxWrite(this.db, input.roomOutboxEventId, room.id, version, input.markerId),
    matchOutboxWrite(this.db, input.matchOutboxEventId, input.matchId, state.version, state.eventSeq, input.markerId),
    this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(input.markerId)];
    try {
      const results = await this.db.batch(statements);
      if (changes(results[0]) === 1) return { status: "applied", outcome };
    } catch (error) {
      const raced = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
      if (raced) return { status: "duplicate", outcome: this.decodeStartOutcome(receiptReplay(raced,
        input.actorPlayerId, input.commandId, input.requestHash, { matchId: null, roomId: room.id }).outcome) };
      throw error;
    }
    const late = await this.findCommandReceipt(input.actorPlayerId, input.commandId);
    if (late) return { status: "duplicate", outcome: this.decodeStartOutcome(receiptReplay(late,
      input.actorPlayerId, input.commandId, input.requestHash, { matchId: null, roomId: room.id }).outcome) };
    const latest = await this.db.prepare("SELECT version FROM rooms WHERE id = ?")
      .bind(room.id).first<{ version: number | string }>();
    if (!latest) throw new RoomNotFoundError(room.id);
    const latestVersion = safeInteger(latest.version, "room version");
    if (latestVersion !== input.expectedVersion) {
      throw new RoomVersionConflictError(input.expectedVersion, latestVersion);
    }
    throw new D1StorageInvariantError("Room start preconditions changed before the conditional batch committed.");
  }

  private validateNewRoomPlayers(input: NewRoom): void {
    if (![4, 5, 6, 7].includes(input.capacity)) throw new TypeError("Room capacity must be 4 through 7.");
    if (input.players.length < 1 || input.players.length > input.capacity) {
      throw new TypeError("Room players must fit the configured room capacity.");
    }
    if (new Set(input.players.map((player) => player.playerId)).size !== input.players.length ||
        new Set(input.players.map((player) => player.seatIndex)).size !== input.players.length) {
      throw new TypeError("Room players must have unique IDs and seats.");
    }
    if (input.players.some((player) => player.seatIndex < 0 || player.seatIndex >= input.capacity)) {
      throw new TypeError("Room player seat index is outside room capacity.");
    }
  }

  private validateAggregateCommand(aggregateId: string, expectedVersion: number, markerId: string): void {
    requiredText(aggregateId, "Aggregate ID");
    requiredText(markerId, "Commit marker ID");
    safeInteger(expectedVersion, "expected version");
  }

  private validateLimit(limit: number, label: string, maximum = 1000): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
      throw new RangeError(`${label} must be an integer from 1 to ${maximum}.`);
    }
  }

  private decodeRoomOutcome(value: JsonValue): RoomMutationOutcome {
    const parsed = decodeJson(value, "room command outcome");
    if (!isObject(parsed) || typeof parsed.roomId !== "string" || typeof parsed.version !== "number" ||
        typeof parsed.roomStatus !== "string" || typeof parsed.ownerPlayerId !== "string" ||
        typeof parsed.occupancy !== "number" || typeof parsed.changed !== "boolean") {
      throw new D1StorageInvariantError("Stored room receipt has an invalid outcome.");
    }
    return parsed as unknown as RoomMutationOutcome;
  }

  private decodeStartOutcome(value: JsonValue): StartRoomWithMatchOutcome {
    const parsed = decodeJson(value, "start room outcome");
    if (!isObject(parsed) || typeof parsed.roomId !== "string" || typeof parsed.matchId !== "string" ||
        typeof parsed.version !== "number" || parsed.roomStatus !== "in_game" ||
        typeof parsed.ownerPlayerId !== "string" || typeof parsed.occupancy !== "number" || parsed.changed !== true) {
      throw new D1StorageInvariantError("Stored start receipt has an invalid outcome.");
    }
    return parsed as unknown as StartRoomWithMatchOutcome;
  }
}

