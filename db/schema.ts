import { desc, sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const utcNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const guestSessions = sqliteTable("guest_sessions", {
  id: text("id").primaryKey().notNull(),
  tokenHash: text("token_hash").notNull(),
  displayName: text("display_name").notNull(),
  createdAt: text("created_at").notNull().default(utcNow),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
  lastSeenAt: text("last_seen_at"),
}, (table) => [
  uniqueIndex("guest_sessions_token_hash_unique").on(table.tokenHash),
  check("guest_sessions_display_name_length_check", sql`length(${table.displayName}) BETWEEN 1 AND 256`),
]);

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey().notNull(),
  ownerPlayerId: text("owner_player_id").notNull().references(() => guestSessions.id, { onDelete: "restrict" }),
  inviteCodeHash: text("invite_code_hash").notNull(),
  status: text("status").notNull().default("waiting"),
  capacity: integer("capacity").notNull(),
  version: integer("version").notNull().default(0),
  createdAt: text("created_at").notNull().default(utcNow),
  updatedAt: text("updated_at").notNull().default(utcNow),
}, (table) => [
  uniqueIndex("rooms_invite_code_hash_unique").on(table.inviteCodeHash),
  index("rooms_status_created_idx").on(table.status, table.createdAt),
  check("rooms_status_check", sql`${table.status} IN ('waiting', 'starting', 'in_game', 'paused', 'completed', 'closed')`),
  check("rooms_capacity_check", sql`${table.capacity} BETWEEN 4 AND 7`),
  check("rooms_version_check", sql`${table.version} >= 0`),
]);

export const roomPlayers = sqliteTable("room_players", {
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull().references(() => guestSessions.id, { onDelete: "restrict" }),
  seatIndex: integer("seat_index").notNull(),
  ready: integer("ready").notNull().default(0),
  joinedAt: text("joined_at").notNull().default(utcNow),
  lastPresenceAt: text("last_presence_at"),
}, (table) => [
  primaryKey({ columns: [table.roomId, table.playerId] }),
  uniqueIndex("room_players_room_seat_unique").on(table.roomId, table.seatIndex),
  index("room_players_player_idx").on(table.playerId, table.roomId),
  check("room_players_seat_index_check", sql`${table.seatIndex} BETWEEN 0 AND 6`),
  check("room_players_ready_check", sql`${table.ready} IN (0, 1)`),
]);

export const matches = sqliteTable("matches", {
  id: text("id").primaryKey().notNull(),
  roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "restrict" }),
  status: text("status").notNull(),
  version: integer("version").notNull(),
  eventSeq: integer("event_seq").notNull(),
  rulesetVersion: text("ruleset_version").notNull(),
  stateSchemaVersion: integer("state_schema_version").notNull(),
  stateJson: text("state_json").notNull(),
  roomVersion: integer("room_version"),
  createdAt: text("created_at").notNull().default(utcNow),
  startedAt: text("started_at").notNull().default(utcNow),
  updatedAt: text("updated_at").notNull().default(utcNow),
  endedAt: text("ended_at"),
}, (table) => [
  index("matches_status_updated_idx").on(table.status, table.updatedAt),
  index("matches_room_latest_idx").on(table.roomId, desc(table.roomVersion), desc(table.createdAt), desc(table.startedAt), desc(table.id)),
  check("matches_status_check", sql`${table.status} IN ('playing', 'paused', 'completed', 'recovery_required')`),
  check("matches_version_check", sql`${table.version} >= 0`),
  check("matches_event_seq_check", sql`${table.eventSeq} >= 0`),
  check("matches_ruleset_version_check", sql`length(${table.rulesetVersion}) > 0`),
  check("matches_state_schema_version_check", sql`${table.stateSchemaVersion} > 0`),
  check("matches_state_json_check", sql`json_valid(${table.stateJson}) AND json_type(${table.stateJson}) = 'object'`),
  check("matches_room_version_check", sql`${table.roomVersion} IS NULL OR ${table.roomVersion} >= 0`),
]);

export const matchPlayers = sqliteTable("match_players", {
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  playerId: text("player_id").notNull().references(() => guestSessions.id, { onDelete: "restrict" }),
  seatIndex: integer("seat_index").notNull(),
  alive: integer("alive").notNull(),
  eliminatedAt: text("eliminated_at"),
  connectionState: text("connection_state").notNull().default("disconnected"),
}, (table) => [
  primaryKey({ columns: [table.matchId, table.playerId] }),
  uniqueIndex("match_players_match_seat_unique").on(table.matchId, table.seatIndex),
  index("match_players_player_idx").on(table.playerId, table.matchId),
  check("match_players_seat_index_check", sql`${table.seatIndex} BETWEEN 0 AND 6`),
  check("match_players_alive_check", sql`${table.alive} IN (0, 1)`),
  check("match_players_connection_state_check", sql`${table.connectionState} IN ('connected', 'disconnected')`),
  check("match_players_eliminated_check", sql`(${table.alive} = 1 AND ${table.eliminatedAt} IS NULL) OR (${table.alive} = 0 AND ${table.eliminatedAt} IS NOT NULL)`),
]);

export const matchEvents = sqliteTable("match_events", {
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  eventSeq: integer("event_seq").notNull(),
  eventId: text("event_id").notNull(),
  version: integer("version").notNull(),
  type: text("type").notNull(),
  actorPlayerId: text("actor_player_id").references(() => guestSessions.id, { onDelete: "set null" }),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull().default(utcNow),
}, (table) => [
  primaryKey({ columns: [table.matchId, table.eventSeq] }),
  uniqueIndex("match_events_event_id_unique").on(table.eventId),
  index("match_events_match_version_idx").on(table.matchId, table.version),
  check("match_events_event_seq_check", sql`${table.eventSeq} > 0`),
  check("match_events_version_check", sql`${table.version} > 0`),
  check("match_events_type_check", sql`length(${table.type}) > 0`),
  check("match_events_payload_json_check", sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`),
]);

export const commandReceipts = sqliteTable("command_receipts", {
  actorPlayerId: text("actor_player_id").notNull().references(() => guestSessions.id, { onDelete: "restrict" }),
  commandId: text("command_id").notNull(),
  matchId: text("match_id").references(() => matches.id, { onDelete: "restrict" }),
  roomId: text("room_id").references(() => rooms.id, { onDelete: "restrict" }),
  requestHash: text("request_hash").notNull(),
  outcomeJson: text("outcome_json").notNull(),
  createdAt: text("created_at").notNull().default(utcNow),
}, (table) => [
  primaryKey({ columns: [table.actorPlayerId, table.commandId] }),
  check("command_receipts_request_hash_check", sql`length(${table.requestHash}) > 0`),
  check("command_receipts_outcome_json_check", sql`json_valid(${table.outcomeJson})`),
  check("command_receipts_single_aggregate_check", sql`${table.matchId} IS NULL OR ${table.roomId} IS NULL`),
]);

export const outbox = sqliteTable("outbox", {
  cursor: integer("cursor").primaryKey({ autoIncrement: true }),
  eventId: text("event_id").notNull(),
  aggregateId: text("aggregate_id").notNull(),
  aggregateVersion: integer("aggregate_version").notNull(),
  eventSeq: integer("event_seq").notNull(),
  kind: text("kind").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAt: text("created_at").notNull().default(utcNow),
  publishedAt: text("published_at"),
  retryCount: integer("retry_count").notNull().default(0),
}, (table) => [
  uniqueIndex("outbox_event_id_unique").on(table.eventId),
  index("outbox_unpublished_cursor_idx").on(table.cursor).where(sql`${table.publishedAt} IS NULL`),
  index("outbox_aggregate_cursor_idx").on(table.aggregateId, table.cursor),
  check("outbox_aggregate_version_check", sql`${table.aggregateVersion} >= 0`),
  check("outbox_event_seq_check", sql`${table.eventSeq} >= 0`),
  check("outbox_kind_check", sql`${table.kind} IN ('match:changed', 'room:changed')`),
  check("outbox_payload_json_check", sql`json_valid(${table.payloadJson}) AND json_type(${table.payloadJson}) = 'object'`),
  check("outbox_retry_count_check", sql`${table.retryCount} >= 0`),
  check("outbox_payload_kind_check", sql`(
    (${table.kind} = 'match:changed'
      AND json_type(${table.payloadJson}, '$.matchId') = 'text'
      AND json_type(${table.payloadJson}, '$.version') = 'integer'
      AND json_type(${table.payloadJson}, '$.eventSeq') = 'integer')
    OR
    (${table.kind} = 'room:changed'
      AND json_type(${table.payloadJson}, '$.roomId') = 'text'
      AND json_type(${table.payloadJson}, '$.version') = 'integer')
  )`),
]);

export const commitGuards = sqliteTable("commit_guards", {
  markerId: text("marker_id").primaryKey().notNull(),
  aggregateId: text("aggregate_id").notNull(),
  expectedVersion: integer("expected_version").notNull(),
  createdAt: text("created_at").notNull().default(utcNow),
}, (table) => [
  check("commit_guards_expected_version_check", sql`${table.expectedVersion} >= 0`),
]);

export const inviteAttempts = sqliteTable("invite_attempts", {
  bucketHash: text("bucket_hash").primaryKey().notNull(),
  failuresJson: text("failures_json").notNull().default("[]"),
  lastInvalidAt: integer("last_invalid_at"),
  lastActivityAt: integer("last_activity_at").notNull(),
  retryDelayMs: integer("retry_delay_ms").notNull().default(0),
  retryAt: integer("retry_at"),
  version: integer("version").notNull().default(0),
}, (table) => [
  check("invite_attempts_failures_json_check", sql`json_valid(${table.failuresJson}) AND json_type(${table.failuresJson}) = 'array'`),
  check("invite_attempts_retry_delay_ms_check", sql`${table.retryDelayMs} >= 0`),
  check("invite_attempts_version_check", sql`${table.version} >= 0`),
]);

export const inviteLookupReservations = sqliteTable("invite_lookup_reservations", {
  reservationId: text("reservation_id").primaryKey().notNull(),
  bucketHash: text("bucket_hash").notNull().references(() => inviteAttempts.bucketHash, { onDelete: "cascade" }),
  reservedAt: integer("reserved_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  index("invite_reservations_expiry_idx").on(table.expiresAt),
  check("invite_reservations_expiry_check", sql`${table.expiresAt} > ${table.reservedAt}`),
]);

