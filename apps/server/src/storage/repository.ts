import type { GameState, JsonValue } from "../../../../packages/engine/src/state/types.js";
import { withClient, withTransaction } from "./database-runtime.js";
import type { PgClientLike, PgPoolLike } from "./database.js";

type DatabaseTimestamp = Date | string;
type DatabaseInteger = number | string;
type RoomStatus = "waiting" | "starting" | "in_game" | "paused" | "completed" | "closed";
type ConnectionState = "connected" | "disconnected";

export interface GuestSessionInput {
  id: string;
  tokenHash: string;
  displayName: string;
  expiresAt: Date | string;
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
  players: RoomPlayerRecord[];
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

export interface MatchCommandReceiptInput {
  actorPlayerId: string;
  commandId: string;
  requestHash: string;
  outcome: JsonValue;
}

export interface CommandReceiptRecord extends MatchCommandReceiptInput {
  matchId: string | null;
  roomId: string | null;
  createdAt: Date;
}

export interface MatchCommitInput {
  matchId: string;
  expectedVersion: number;
  state: GameState;
  events: readonly MatchEventWrite[];
  receipt: MatchCommandReceiptInput;
  outboxEventId: string;
}

/** A known-aggregate command rejection receipt with no aggregate state change. */
export interface MatchRejectionReceiptInput {
  matchId: string;
  /** Match version observed before the command was evaluated. */
  observedVersion: number;
  receipt: MatchCommandReceiptInput;
}

export type MatchRejectionReceiptResult =
  | { status: "recorded"; currentVersion: number }
  | { status: "duplicate"; outcome: JsonValue }
  | { status: "version_changed"; currentVersion: number };

export type MatchCommitResult =
  | { status: "committed"; version: number; eventSeq: number; outboxEventId: string }
  | { status: "duplicate"; outcome: JsonValue };

export interface OutboxRecord {
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

interface RoomRow {
  id: string;
  owner_player_id: string;
  invite_code_hash: string;
  status: RoomStatus;
  capacity: 4 | 5 | 6 | 7;
  version: DatabaseInteger;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
}

interface RoomPlayerRow {
  player_id: string;
  seat_index: number;
  ready: boolean;
  joined_at: DatabaseTimestamp;
  last_presence_at: DatabaseTimestamp | null;
}

interface MatchRow {
  id: string;
  room_id: string;
  status: GameState["status"];
  version: DatabaseInteger;
  event_seq: DatabaseInteger;
  ruleset_version: string;
  state_schema_version: number;
  state_json: GameState | string;
  created_at: DatabaseTimestamp;
  started_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  ended_at: DatabaseTimestamp | null;
}

interface MatchPlayerRow {
  player_id: string;
  seat_index: number;
  alive: boolean;
  eliminated_at: DatabaseTimestamp | null;
  connection_state: ConnectionState;
}

interface ReceiptRow {
  actor_player_id: string;
  command_id: string;
  match_id: string | null;
  room_id: string | null;
  request_hash: string;
  outcome_json: JsonValue | string;
  created_at: DatabaseTimestamp;
}

interface EventRow {
  event_id: string;
  event_seq: DatabaseInteger;
  version: DatabaseInteger;
  type: string;
  actor_player_id: string | null;
  payload_json: JsonValue | string;
  created_at: DatabaseTimestamp;
}

interface OutboxRow {
  event_id: string;
  aggregate_id: string;
  aggregate_version: DatabaseInteger;
  event_seq: DatabaseInteger;
  kind: "match:changed" | "room:changed";
  payload_json: JsonValue | string;
  created_at: DatabaseTimestamp;
  published_at: DatabaseTimestamp | null;
  retry_count: number;
}

interface LockedMatchRow {
  version: DatabaseInteger;
  event_seq: DatabaseInteger;
  ruleset_version: string;
  state_schema_version: number;
}

export class MatchNotFoundError extends Error {
  readonly matchId: string;

  constructor(matchId: string) {
    super(`Match '${matchId}' does not exist.`);
    this.name = "MatchNotFoundError";
    this.matchId = matchId;
  }
}

export class StaleMatchVersionError extends Error {
  readonly expectedVersion: number;
  readonly currentVersion: number;
  readonly proposedVersion: number | undefined;

  constructor(
    expectedVersion: number,
    currentVersion: number,
    proposedVersion?: number,
  ) {
    super(
      `Stale match version: expected ${expectedVersion}, current ${currentVersion}` +
        (proposedVersion === undefined ? "." : `, proposed ${proposedVersion}.`),
    );
    this.name = "StaleMatchVersionError";
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
    this.proposedVersion = proposedVersion;
  }
}

export class CommandIdReusedError extends Error {
  readonly actorPlayerId: string;
  readonly commandId: string;

  constructor(actorPlayerId: string, commandId: string) {
    super(`Command '${commandId}' for player '${actorPlayerId}' was already used with another request.`);
    this.name = "CommandIdReusedError";
    this.actorPlayerId = actorPlayerId;
    this.commandId = commandId;
  }
}

export class MatchStateInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchStateInvariantError";
  }
}

export class MatchMembershipRequiredError extends Error {
  readonly matchId: string;
  readonly actorPlayerId: string;

  constructor(matchId: string, actorPlayerId: string) {
    super("The command actor is not a registered player in this match.");
    this.name = "MatchMembershipRequiredError";
    this.matchId = matchId;
    this.actorPlayerId = actorPlayerId;
  }
}

function date(value: DatabaseTimestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function safeInteger(value: DatabaseInteger, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new MatchStateInvariantError(`Stored ${field} is not a safe integer.`);
  }
  return parsed;
}

function nullableDate(value: DatabaseTimestamp | null): Date | null {
  return value === null ? null : date(value);
}

function parseJson<T>(value: T | string): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

function encodeJson(value: JsonValue): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new TypeError("Storage JSON value cannot be serialized.");
  return encoded;
}

function assertStateMetadata(state: GameState): void {
  if (!Number.isSafeInteger(state.schemaVersion) || state.schemaVersion < 1) {
    throw new MatchStateInvariantError("Match state schemaVersion must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(state.version) || state.version < 0) {
    throw new MatchStateInvariantError("Match state version must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(state.eventSeq) || state.eventSeq < 0) {
    throw new MatchStateInvariantError("Match state eventSeq must be a non-negative safe integer.");
  }
  if (!state.rulesetVersion.trim()) {
    throw new MatchStateInvariantError("Match state rulesetVersion cannot be empty.");
  }
}

/** Inserts a match and its seat rows into the caller's existing transaction. */
export async function insertMatchInTransaction(client: PgClientLike, input: NewMatch): Promise<void> {
  const state = input.state;
  assertStateMetadata(state);
  if (new Set(state.seats.map(({ public: player }) => player.playerId)).size !== state.seats.length) {
    throw new MatchStateInvariantError("Match state contains duplicate player IDs.");
  }

  await client.query(
    `INSERT INTO matches (
       id, room_id, status, version, event_seq, ruleset_version,
       state_schema_version, state_json, started_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
    [
      input.id,
      input.roomId,
      state.status,
      state.version,
      state.eventSeq,
      state.rulesetVersion,
      state.schemaVersion,
      JSON.stringify(state),
      input.startedAt ?? new Date(),
    ],
  );

  const configuredPlayers = new Map(
    (input.players ?? []).map((player) => [player.playerId, player.connectionState] as const),
  );
  if (configuredPlayers.size !== (input.players ?? []).length) {
    throw new MatchStateInvariantError("Match player connection state contains duplicate player IDs.");
  }
  for (const seat of state.seats) {
    const player = seat.public;
    const eliminatedAt = player.eliminated ? new Date() : null;
    await client.query(
      `INSERT INTO match_players (
         match_id, player_id, seat_index, alive, eliminated_at, connection_state
       ) VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.id,
        player.playerId,
        player.seatIndex,
        !player.eliminated,
        eliminatedAt,
        configuredPlayers.get(player.playerId) ?? "disconnected",
      ],
    );
  }
  for (const configuredPlayerId of configuredPlayers.keys()) {
    if (!state.seats.some((seat) => seat.public.playerId === configuredPlayerId)) {
      throw new MatchStateInvariantError(`Configured match player '${configuredPlayerId}' has no state seat.`);
    }
  }
}

function mapRoomPlayer(row: RoomPlayerRow): RoomPlayerRecord {
  return {
    playerId: row.player_id,
    seatIndex: row.seat_index,
    ready: row.ready,
    joinedAt: date(row.joined_at),
    lastPresenceAt: nullableDate(row.last_presence_at),
  };
}

function mapMatchPlayer(row: MatchPlayerRow): NewMatchPlayer {
  return {
    playerId: row.player_id,
    seatIndex: row.seat_index,
    alive: row.alive,
    eliminatedAt: nullableDate(row.eliminated_at),
    connectionState: row.connection_state,
  };
}

function mapReceipt(row: ReceiptRow): CommandReceiptRecord {
  return {
    actorPlayerId: row.actor_player_id,
    commandId: row.command_id,
    matchId: row.match_id,
    roomId: row.room_id,
    requestHash: row.request_hash,
    outcome: parseJson(row.outcome_json),
    createdAt: date(row.created_at),
  };
}

function mapMatch(row: MatchRow, players: MatchPlayerRow[]): MatchRecord {
  return {
    id: row.id,
    roomId: row.room_id,
    status: row.status,
    version: safeInteger(row.version, "match version"),
    eventSeq: safeInteger(row.event_seq, "match event sequence"),
    rulesetVersion: row.ruleset_version,
    stateSchemaVersion: row.state_schema_version,
    state: parseJson<GameState>(row.state_json),
    createdAt: date(row.created_at),
    startedAt: date(row.started_at),
    updatedAt: date(row.updated_at),
    endedAt: nullableDate(row.ended_at),
    players: players.map(mapMatchPlayer),
  };
}

function toRoomRecord(row: RoomRow, players: RoomPlayerRow[]): RoomRecord {
  return {
    id: row.id,
    ownerPlayerId: row.owner_player_id,
    inviteCodeHash: row.invite_code_hash,
    status: row.status,
    capacity: row.capacity,
    version: safeInteger(row.version, "room version"),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    players: players.map(mapRoomPlayer),
  };
}

async function findReceiptOnClient(
  client: PgClientLike,
  actorPlayerId: string,
  commandId: string,
): Promise<CommandReceiptRecord | null> {
  const result = await client.query<ReceiptRow>(
    `SELECT actor_player_id, command_id, match_id, room_id, request_hash, outcome_json, created_at
     FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2`,
    [actorPlayerId, commandId],
  );
  return result.rows[0] ? mapReceipt(result.rows[0]) : null;
}

function assertReceiptMatches(
  receipt: CommandReceiptRecord,
  input: MatchCommitInput,
): MatchCommitResult {
  if (receipt.matchId !== input.matchId || receipt.requestHash !== input.receipt.requestHash) {
    throw new CommandIdReusedError(input.receipt.actorPlayerId, input.receipt.commandId);
  }
  return { status: "duplicate", outcome: receipt.outcome };
}

function assertRejectionReceiptMatches(
  receipt: CommandReceiptRecord,
  input: MatchRejectionReceiptInput,
): MatchRejectionReceiptResult {
  if (receipt.matchId !== input.matchId || receipt.requestHash !== input.receipt.requestHash) {
    throw new CommandIdReusedError(input.receipt.actorPlayerId, input.receipt.commandId);
  }
  return { status: "duplicate", outcome: receipt.outcome };
}

export class StorageRepository {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async createGuestSession(input: GuestSessionInput): Promise<void> {
    await withClient(this.pool, async (client) => {
      await client.query(
        `INSERT INTO guest_sessions (id, token_hash, display_name, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [input.id, input.tokenHash, input.displayName, input.expiresAt],
      );
    });
  }

  async createRoom(input: NewRoom): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO rooms (id, owner_player_id, invite_code_hash, capacity)
         VALUES ($1, $2, $3, $4)`,
        [input.id, input.ownerPlayerId, input.inviteCodeHash, input.capacity],
      );
      for (const player of input.players) {
        await client.query(
          `INSERT INTO room_players (room_id, player_id, seat_index, ready)
           VALUES ($1, $2, $3, $4)`,
          [input.id, player.playerId, player.seatIndex, player.ready ?? false],
        );
      }
    });
  }

  async getRoom(roomId: string): Promise<RoomRecord | null> {
    return withClient(this.pool, async (client) => {
      const roomResult = await client.query<RoomRow>(
        `SELECT id, owner_player_id, invite_code_hash, status, capacity, version, created_at, updated_at
         FROM rooms WHERE id = $1`,
        [roomId],
      );
      const room = roomResult.rows[0];
      if (!room) return null;
      const playerResult = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready, joined_at, last_presence_at
         FROM room_players WHERE room_id = $1 ORDER BY seat_index`,
        [roomId],
      );
      return toRoomRecord(room, playerResult.rows);
    });
  }

  async createMatch(input: NewMatch): Promise<void> {
    await withTransaction(this.pool, (client) => insertMatchInTransaction(client, input));
  }

  /** Returns the latest match route for a room, including its last completed match. */
  async getLatestMatchIdForRoom(roomId: string): Promise<string | null> {
    if (!roomId.trim()) throw new TypeError("Room ID is required.");
    return withClient(this.pool, async (client) => {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM matches WHERE room_id = $1
         ORDER BY created_at DESC, started_at DESC, id DESC LIMIT 1`,
        [roomId],
      );
      return result.rows[0]?.id ?? null;
    });
  }

  async getMatch(matchId: string): Promise<MatchRecord | null> {
    return withClient(this.pool, async (client) => {
      const matchResult = await client.query<MatchRow>(
        `SELECT id, room_id, status, version, event_seq, ruleset_version,
                state_schema_version, state_json, created_at, started_at, updated_at, ended_at
         FROM matches WHERE id = $1`,
        [matchId],
      );
      const match = matchResult.rows[0];
      if (!match) return null;
      const playersResult = await client.query<MatchPlayerRow>(
        `SELECT player_id, seat_index, alive, eliminated_at, connection_state
         FROM match_players WHERE match_id = $1 ORDER BY seat_index`,
        [matchId],
      );
      return mapMatch(match, playersResult.rows);
    });
  }

  async commitMatch(input: MatchCommitInput): Promise<MatchCommitResult> {
    return withTransaction(this.pool, async (client) => {
      const existingReceipt = await findReceiptOnClient(
        client,
        input.receipt.actorPlayerId,
        input.receipt.commandId,
      );
      if (existingReceipt) return assertReceiptMatches(existingReceipt, input);

      const matchResult = await client.query<LockedMatchRow>(
        `SELECT version, event_seq, ruleset_version, state_schema_version
         FROM matches WHERE id = $1 FOR UPDATE`,
        [input.matchId],
      );
      const current = matchResult.rows[0];
      if (!current) throw new MatchNotFoundError(input.matchId);

      const currentVersion = safeInteger(current.version, "match version");
      const currentEventSeq = safeInteger(current.event_seq, "match event sequence");

      if (currentVersion !== input.expectedVersion) {
        const lateReceipt = await findReceiptOnClient(
          client,
          input.receipt.actorPlayerId,
          input.receipt.commandId,
        );
        if (lateReceipt) return assertReceiptMatches(lateReceipt, input);
        throw new StaleMatchVersionError(input.expectedVersion, currentVersion, input.state.version);
      }

      assertStateMetadata(input.state);
      if (input.state.version !== input.expectedVersion + 1 || input.state.version <= currentVersion) {
        throw new StaleMatchVersionError(input.expectedVersion, currentVersion, input.state.version);
      }
      if (input.state.eventSeq < currentEventSeq) {
        throw new MatchStateInvariantError("Match eventSeq cannot move backwards.");
      }
      if (input.state.rulesetVersion !== current.ruleset_version) {
        throw new MatchStateInvariantError("A match commit cannot change its ruleset version.");
      }
      if (input.state.schemaVersion !== current.state_schema_version) {
        throw new MatchStateInvariantError("A match commit cannot change its state schema version.");
      }

      const expectedNewEvents = input.state.eventSeq - currentEventSeq;
      if (input.events.length !== expectedNewEvents) {
        throw new MatchStateInvariantError(
          `Commit has ${input.events.length} event(s), but eventSeq advances by ${expectedNewEvents}.`,
        );
      }
      input.events.forEach((event, index) => {
        const expectedEventSeq = currentEventSeq + index + 1;
        if (event.eventSeq !== expectedEventSeq || event.version !== input.state.version) {
          throw new MatchStateInvariantError(
            `Event '${event.eventId}' must use sequence ${expectedEventSeq} and version ${input.state.version}.`,
          );
        }
        if (!event.type.trim()) throw new MatchStateInvariantError("Match event type cannot be empty.");
      });

      const membership = await client.query<{ player_id: string }>(
        "SELECT player_id FROM match_players WHERE match_id = $1 AND player_id = $2",
        [input.matchId, input.receipt.actorPlayerId],
      );
      if (!membership.rows[0]) {
        throw new MatchStateInvariantError("Command receipt actor is not a player in this match.");
      }

      await client.query("SAVEPOINT match_commit_writes");
      const encodedState = JSON.stringify(input.state);
      if (encodedState === undefined) throw new TypeError("Match state cannot be serialized as JSON.");
      await client.query(
        `UPDATE matches
         SET status = $2, version = $3, event_seq = $4, ruleset_version = $5,
             state_schema_version = $6, state_json = $7::jsonb,
             updated_at = now(),
             ended_at = CASE WHEN $2 = 'completed' THEN COALESCE(ended_at, now()) ELSE ended_at END
         WHERE id = $1 AND version = $8`,
        [
          input.matchId,
          input.state.status,
          input.state.version,
          input.state.eventSeq,
          input.state.rulesetVersion,
          input.state.schemaVersion,
          encodedState,
          input.expectedVersion,
        ],
      );

      for (const event of input.events) {
        await client.query(
          `INSERT INTO match_events (
             match_id, event_seq, event_id, version, type, actor_player_id, payload_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, COALESCE($8::timestamptz, now()))`,
          [
            input.matchId,
            event.eventSeq,
            event.eventId,
            event.version,
            event.type,
            event.actorPlayerId,
            encodeJson(event.payload),
            event.createdAt ?? null,
          ],
        );
      }

      const receiptInsert = await client.query<{ command_id: string }>(
        `INSERT INTO command_receipts (
           actor_player_id, command_id, match_id, request_hash, outcome_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (actor_player_id, command_id) DO NOTHING
         RETURNING command_id`,
        [
          input.receipt.actorPlayerId,
          input.receipt.commandId,
          input.matchId,
          input.receipt.requestHash,
          encodeJson(input.receipt.outcome),
        ],
      );
      if (!receiptInsert.rows[0]) {
        await client.query("ROLLBACK TO SAVEPOINT match_commit_writes");
        const concurrentReceipt = await findReceiptOnClient(
          client,
          input.receipt.actorPlayerId,
          input.receipt.commandId,
        );
        if (!concurrentReceipt) {
          throw new MatchStateInvariantError("Receipt conflict had no committed receipt row.");
        }
        return assertReceiptMatches(concurrentReceipt, input);
      }

      const outboxPayload = JSON.stringify({
        matchId: input.matchId,
        version: input.state.version,
        eventSeq: input.state.eventSeq,
      });
      await client.query(
        `INSERT INTO outbox (
           event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json
         ) VALUES ($1, $2, $3, $4, 'match:changed', $5::jsonb)`,
        [input.outboxEventId, input.matchId, input.state.version, input.state.eventSeq, outboxPayload],
      );
      await client.query("RELEASE SAVEPOINT match_commit_writes");

      return {
        status: "committed",
        version: input.state.version,
        eventSeq: input.state.eventSeq,
        outboxEventId: input.outboxEventId,
      };
    });
  }

  /**
   * Persist an authenticated, known-match rejection without changing the
   * snapshot, aggregate version, event log, or outbox. The match row lock
   * serializes this receipt decision against commits and other rejections.
   */
  async recordMatchRejection(
    input: MatchRejectionReceiptInput,
  ): Promise<MatchRejectionReceiptResult> {
    if (!input.matchId.trim() || !input.receipt.actorPlayerId.trim() ||
        !input.receipt.commandId.trim() || !input.receipt.requestHash.trim()) {
      throw new TypeError("Match rejection receipt identifiers and request hash are required.");
    }
    if (!Number.isSafeInteger(input.observedVersion) || input.observedVersion < 0) {
      throw new TypeError("Observed match version must be a non-negative safe integer.");
    }

    const outcomeJson = encodeJson(input.receipt.outcome);
    return withTransaction(this.pool, async (client) => {
      const matchResult = await client.query<Pick<LockedMatchRow, "version">>(
        "SELECT version FROM matches WHERE id = $1 FOR UPDATE",
        [input.matchId],
      );
      const match = matchResult.rows[0];
      if (!match) throw new MatchNotFoundError(input.matchId);
      const currentVersion = safeInteger(match.version, "match version");

      const membership = await client.query<{ player_id: string }>(
        "SELECT player_id FROM match_players WHERE match_id = $1 AND player_id = $2",
        [input.matchId, input.receipt.actorPlayerId],
      );
      if (!membership.rows[0]) {
        throw new MatchMembershipRequiredError(input.matchId, input.receipt.actorPlayerId);
      }

      // Recheck only after serializing on the aggregate row. A previous
      // accepted or rejected outcome always wins over a later version check.
      const existingReceipt = await findReceiptOnClient(
        client,
        input.receipt.actorPlayerId,
        input.receipt.commandId,
      );
      if (existingReceipt) return assertRejectionReceiptMatches(existingReceipt, input);

      if (currentVersion !== input.observedVersion) {
        return { status: "version_changed", currentVersion };
      }

      const inserted = await client.query<{ command_id: string }>(
        `INSERT INTO command_receipts (
           actor_player_id, command_id, match_id, request_hash, outcome_json
         ) VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT (actor_player_id, command_id) DO NOTHING
         RETURNING command_id`,
        [
          input.receipt.actorPlayerId,
          input.receipt.commandId,
          input.matchId,
          input.receipt.requestHash,
          outcomeJson,
        ],
      );
      if (inserted.rows[0]) return { status: "recorded", currentVersion };

      // The primary key also serializes reuse across different aggregates.
      const concurrentReceipt = await findReceiptOnClient(
        client,
        input.receipt.actorPlayerId,
        input.receipt.commandId,
      );
      if (!concurrentReceipt) {
        throw new MatchStateInvariantError("Receipt conflict had no committed receipt row.");
      }
      return assertRejectionReceiptMatches(concurrentReceipt, input);
    });
  }

  async findCommandReceipt(actorPlayerId: string, commandId: string): Promise<CommandReceiptRecord | null> {
    return withClient(this.pool, (client) => findReceiptOnClient(client, actorPlayerId, commandId));
  }

  async listMatchEvents(matchId: string, afterEventSeq = 0): Promise<MatchEventRecord[]> {
    return withClient(this.pool, async (client) => {
      const result = await client.query<EventRow>(
        `SELECT event_id, event_seq, version, type, actor_player_id, payload_json, created_at
         FROM match_events WHERE match_id = $1 AND event_seq > $2 ORDER BY event_seq`,
        [matchId, afterEventSeq],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        eventSeq: safeInteger(row.event_seq, "event sequence"),
        version: safeInteger(row.version, "event version"),
        type: row.type,
        actorPlayerId: row.actor_player_id,
        payload: parseJson(row.payload_json),
        createdAt: date(row.created_at),
      }));
    });
  }

  async listPendingOutbox(limit = 100): Promise<OutboxRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new RangeError("Outbox query limit must be an integer from 1 to 1000.");
    }
    return withClient(this.pool, async (client) => {
      const result = await client.query<OutboxRow>(
        `SELECT event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json,
                created_at, published_at, retry_count
         FROM outbox WHERE published_at IS NULL ORDER BY created_at, event_id LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => ({
        eventId: row.event_id,
        aggregateId: row.aggregate_id,
        aggregateVersion: safeInteger(row.aggregate_version, "outbox aggregate version"),
        eventSeq: safeInteger(row.event_seq, "outbox event sequence"),
        kind: row.kind,
        payload: parseJson(row.payload_json),
        createdAt: date(row.created_at),
        publishedAt: nullableDate(row.published_at),
        retryCount: row.retry_count,
      }));
    });
  }
}
