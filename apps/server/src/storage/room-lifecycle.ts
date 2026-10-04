import type { GameState, JsonValue } from "../../../../packages/engine/src/state/types.js";
import { withClient, withTransaction } from "./database-runtime.js";
import type { PgClientLike, PgPoolLike } from "./database.js";
import { insertMatchInTransaction, type MatchEventRecord, type NewRoom, type RoomRecord } from "./repository.js";

type RoomStatus = RoomRecord["status"];
type DatabaseInteger = number | string;
type DatabaseTimestamp = Date | string;

export interface GuestSessionLookup {
  playerId: string;
  displayName: string;
  expiresAt: Date;
}

export interface RoomPreviewRecord {
  roomId: string;
  version: number;
  occupancy: number;
  status: RoomStatus;
}

interface RoomCommandBase {
  actorPlayerId: string;
  commandId: string;
  requestHash: string;
  outboxEventId: string;
  roomId: string;
  expectedVersion: number;
}

export interface CreateRoomLifecycleInput
  extends Omit<NewRoom, "players">,
    Pick<RoomCommandBase, "actorPlayerId" | "commandId" | "requestHash" | "outboxEventId"> {}

export interface JoinRoomInput extends RoomCommandBase {
  inviteCodeHash: string;
}

export interface LeaveRoomInput extends RoomCommandBase {}

export interface SetReadyInput extends RoomCommandBase {
  ready: boolean;
}

export interface SetRoomStatusInput extends RoomCommandBase {
  status: RoomStatus;
}

export interface StartRoomWithMatchInput extends RoomCommandBase {
  events?: readonly MatchEventRecord[];
  matchId: string;
  matchOutboxEventId: string;
  state: GameState;
  startedAt?: Date | string;
}

export interface ReturnToLobbyInput extends RoomCommandBase {}

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
  capacity: 4 | 5 | 6 | 7;
  version: DatabaseInteger;
}

interface RoomPlayerRow {
  player_id: string;
  seat_index: number;
  ready: boolean;
}

interface LatestMatchRow {
  id: string;
  status: string;
}

interface MatchRosterRow {
  player_id: string;
  seat_index: number;
}

interface GuestSessionRow {
  id: string;
  display_name: string;
  expires_at: DatabaseTimestamp;
}

interface RoomPreviewRow {
  id: string;
  version: DatabaseInteger;
  occupancy: DatabaseInteger;
  status: RoomStatus;
}

interface ReceiptRow {
  actor_player_id: string;
  command_id: string;
  room_id: string | null;
  match_id: string | null;
  request_hash: string;
  outcome_json: JsonValue | string;
}

interface AppliedRoomChange {
  changed: boolean;
  roomStatus: RoomStatus;
  ownerPlayerId: string;
  occupancy: number;
  playerId?: string;
  seatIndex?: number;
  ready?: boolean;
}

export class RoomLifecycleError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RoomLifecycleError";
    this.code = code;
  }
}

export class RoomNotFoundError extends RoomLifecycleError {
  constructor(roomId: string) {
    super("ROOM_NOT_FOUND", `Room '${roomId}' does not exist.`);
    this.name = "RoomNotFoundError";
  }
}

export class RoomVersionConflictError extends RoomLifecycleError {
  readonly expectedVersion: number;
  readonly currentVersion: number;

  constructor(expectedVersion: number, currentVersion: number) {
    super("STALE_VERSION", `Room version is ${currentVersion}; expected ${expectedVersion}.`);
    this.name = "RoomVersionConflictError";
    this.expectedVersion = expectedVersion;
    this.currentVersion = currentVersion;
  }
}

export class RoomInviteMismatchError extends RoomLifecycleError {
  constructor() {
    super("INVALID_INVITE", "Invite code is invalid.");
    this.name = "RoomInviteMismatchError";
  }
}

export class RoomClosedError extends RoomLifecycleError {
  constructor() {
    super("ROOM_CLOSED", "Closed rooms cannot be changed or joined.");
    this.name = "RoomClosedError";
  }
}

export class RoomLockedError extends RoomLifecycleError {
  constructor(status: RoomStatus) {
    super("ROOM_LOCKED", `Room membership is locked while status is '${status}'.`);
    this.name = "RoomLockedError";
  }
}

export class RoomFullError extends RoomLifecycleError {
  constructor() {
    super("ROOM_FULL", "Room has no unoccupied seat.");
    this.name = "RoomFullError";
  }
}

export class RoomAlreadyJoinedError extends RoomLifecycleError {
  constructor(playerId: string) {
    super("ALREADY_JOINED", `Player '${playerId}' already has a seat in this room.`);
    this.name = "RoomAlreadyJoinedError";
  }
}

export class RoomMembershipRequiredError extends RoomLifecycleError {
  constructor(playerId: string) {
    super("NOT_A_MEMBER", `Player '${playerId}' has no seat in this room.`);
    this.name = "RoomMembershipRequiredError";
  }
}

export class RoomOwnerRequiredError extends RoomLifecycleError {
  constructor() {
    super("NOT_ROOM_OWNER", "Only the room owner can perform this room command.");
    this.name = "RoomOwnerRequiredError";
  }
}

export class RoomStartNotReadyError extends RoomLifecycleError {
  constructor(message: string) {
    super("ROOM_NOT_READY", message);
    this.name = "RoomStartNotReadyError";
  }
}

export class RoomCommandIdReusedError extends RoomLifecycleError {
  constructor(actorPlayerId: string, commandId: string) {
    super("COMMAND_ID_REUSED", `Command '${commandId}' for player '${actorPlayerId}' was reused.`);
    this.name = "RoomCommandIdReusedError";
  }
}

export class RoomLifecycleInvariantError extends RoomLifecycleError {
  constructor(message: string) {
    super("STORAGE_INVARIANT", message);
    this.name = "RoomLifecycleInvariantError";
  }
}

function date(value: DatabaseTimestamp): Date {
  return value instanceof Date ? value : new Date(value);
}

function safeInteger(value: DatabaseInteger, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new RoomLifecycleInvariantError(`Stored ${field} is not a safe integer.`);
  }
  return parsed;
}

function encodeJson(value: JsonValue): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError("Room command outcome cannot be serialized as JSON.");
  return result;
}

function decodeOutcome(value: JsonValue | string): RoomMutationOutcome {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).roomId !== "string" ||
    typeof (parsed as Record<string, unknown>).version !== "number" ||
    typeof (parsed as Record<string, unknown>).roomStatus !== "string" ||
    typeof (parsed as Record<string, unknown>).ownerPlayerId !== "string" ||
    typeof (parsed as Record<string, unknown>).occupancy !== "number" ||
    typeof (parsed as Record<string, unknown>).changed !== "boolean"
  ) {
    throw new RoomLifecycleInvariantError("Stored room command receipt has an invalid outcome.");
  }
  return parsed as RoomMutationOutcome;
}

function validateCommand(input: RoomCommandBase): void {
  if (!input.actorPlayerId.trim() || !input.commandId.trim() || !input.requestHash.trim()) {
    throw new TypeError("Room command actor, command ID, and request hash are required.");
  }
  if (!input.outboxEventId.trim() || !input.roomId.trim()) {
    throw new TypeError("Room command room ID and outbox event ID are required.");
  }
  if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 0) {
    throw new TypeError("Room expectedVersion must be a non-negative safe integer.");
  }
}

async function findReceipt(
  client: PgClientLike,
  actorPlayerId: string,
  commandId: string,
): Promise<ReceiptRow | null> {
  const result = await client.query<ReceiptRow>(
    `SELECT actor_player_id, command_id, room_id, match_id, request_hash, outcome_json
     FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2`,
    [actorPlayerId, commandId],
  );
  return result.rows[0] ?? null;
}

function checkReceipt(
  row: ReceiptRow,
  input: Pick<RoomCommandBase, "actorPlayerId" | "commandId" | "requestHash" | "roomId">,
  allowDifferentRoom: boolean,
): RoomMutationResult {
  if (
    row.match_id !== null ||
    row.room_id === null ||
    (!allowDifferentRoom && row.room_id !== input.roomId) ||
    row.request_hash !== input.requestHash
  ) {
    throw new RoomCommandIdReusedError(input.actorPlayerId, input.commandId);
  }
  return { status: "duplicate", outcome: decodeOutcome(row.outcome_json) };
}

function decodeStartOutcome(value: JsonValue | string): StartRoomWithMatchOutcome {
  const parsed = (typeof value === "string" ? JSON.parse(value) : value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    typeof (parsed as Record<string, unknown>).roomId !== "string" ||
    typeof (parsed as Record<string, unknown>).matchId !== "string" ||
    typeof (parsed as Record<string, unknown>).version !== "number" ||
    (parsed as Record<string, unknown>).roomStatus !== "in_game" ||
    typeof (parsed as Record<string, unknown>).ownerPlayerId !== "string" ||
    typeof (parsed as Record<string, unknown>).occupancy !== "number" ||
    (parsed as Record<string, unknown>).changed !== true
  ) {
    throw new RoomLifecycleInvariantError("Stored room-start receipt has an invalid outcome.");
  }
  return parsed as StartRoomWithMatchOutcome;
}

function checkStartReceipt(
  row: ReceiptRow,
  input: Pick<StartRoomWithMatchInput, "actorPlayerId" | "commandId" | "requestHash" | "roomId">,
): StartRoomWithMatchResult {
  if (row.match_id !== null || row.room_id !== input.roomId || row.request_hash !== input.requestHash) {
    throw new RoomCommandIdReusedError(input.actorPlayerId, input.commandId);
  }
  const outcome = decodeStartOutcome(row.outcome_json);
  if (outcome.roomId !== input.roomId) {
    throw new RoomLifecycleInvariantError("Stored room-start receipt references a different room.");
  }
  return { status: "duplicate", outcome };
}

async function insertReceipt(
  client: PgClientLike,
  actorPlayerId: string,
  commandId: string,
  roomId: string,
  requestHash: string,
  outcome: RoomMutationOutcome | StartRoomWithMatchOutcome,
): Promise<boolean> {
  const result = await client.query<{ command_id: string }>(
    `INSERT INTO command_receipts (
       actor_player_id, command_id, room_id, request_hash, outcome_json
     ) VALUES ($1, $2, $3, $4, $5::jsonb)
     ON CONFLICT (actor_player_id, command_id) DO NOTHING
     RETURNING command_id`,
    [actorPlayerId, commandId, roomId, requestHash, encodeJson(outcome as unknown as JsonValue)],
  );
  return result.rows.length > 0;
}

async function insertRoomOutbox(
  client: PgClientLike,
  eventId: string,
  roomId: string,
  version: number,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (
       event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json
     ) VALUES ($1, $2, $3, 0, 'room:changed', $4::jsonb)`,
    [eventId, roomId, version, JSON.stringify({ roomId, version })],
  );
}

async function insertMatchOutbox(
  client: PgClientLike,
  eventId: string,
  matchId: string,
  version: number,
  eventSeq: number,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (
       event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json
     ) VALUES ($1, $2, $3, $4, 'match:changed', $5::jsonb)`,
    [eventId, matchId, version, eventSeq, JSON.stringify({ matchId, version, eventSeq })],
  );
}

function assertReadySnapshot(state: GameState, members: readonly RoomPlayerRow[]): void {
  if (members.length < 4 || members.length > 7) {
    throw new RoomStartNotReadyError("A match requires four through seven room members.");
  }
  if (members.some(({ ready }) => !ready)) {
    throw new RoomStartNotReadyError("Every room member must be ready before starting.");
  }

  const statePlayerIds = new Set<string>();
  const stateSeatIndices = new Set<number>();
  for (const seat of state.seats) {
    const { playerId, seatIndex } = seat.public;
    if (
      !playerId.trim() ||
      !Number.isSafeInteger(seatIndex) ||
      seatIndex < 0 ||
      seatIndex >= members.length ||
      statePlayerIds.has(playerId) ||
      stateSeatIndices.has(seatIndex)
    ) {
      throw new RoomLifecycleInvariantError("Initial match state has an invalid or duplicate player seat.");
    }
    statePlayerIds.add(playerId);
    stateSeatIndices.add(seatIndex);
  }
  if (statePlayerIds.size !== members.length) {
    throw new RoomLifecycleInvariantError("Initial match player set differs from the ready room snapshot.");
  }
  for (const member of members) {
    if (!statePlayerIds.has(member.player_id)) {
      throw new RoomLifecycleInvariantError("Initial match player set differs from the ready room snapshot.");
    }
  }
}

function assertUnchangedRoster(
  room: RoomRow,
  members: readonly RoomPlayerRow[],
  previousPlayers: readonly MatchRosterRow[],
): void {
  const roomPlayerIds = members.map(({ player_id }) => player_id);
  const previousPlayerIds = previousPlayers.map(({ player_id }) => player_id);
  const rotationStart = roomPlayerIds.indexOf(previousPlayerIds[0] ?? "");
  const isSameClockwiseRoster =
    previousPlayers.length === members.length &&
    previousPlayers.every(({ seat_index }, index) => seat_index === index) &&
    rotationStart >= 0 &&
    previousPlayers.every(({ player_id }, index) => player_id === roomPlayerIds[(rotationStart + index) % roomPlayerIds.length]);
  if (!isSameClockwiseRoster) {
    throw new RoomLockedError(room.status);
  }
}

export class RoomLifecycleRepository {
  private readonly pool: PgPoolLike;

  constructor(pool: PgPoolLike) {
    this.pool = pool;
  }

  async findActiveGuestSessionByTokenHash(
    tokenHash: string,
    at: Date = new Date(),
  ): Promise<GuestSessionLookup | null> {
    const result = await withClient(this.pool, (client) =>
      client.query<GuestSessionRow>(
        `SELECT id, display_name, expires_at
         FROM guest_sessions
         WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
        [tokenHash, at],
      ),
    );
    const row = result.rows[0];
    if (!row) return null;
    return { playerId: row.id, displayName: row.display_name, expiresAt: date(row.expires_at) };
  }

  async previewRoomByInviteHash(inviteCodeHash: string): Promise<RoomPreviewRecord | null> {
    const result = await withClient(this.pool, (client) =>
      client.query<RoomPreviewRow>(
        `SELECT r.id, r.version, r.status, count(rp.player_id)::bigint AS occupancy
         FROM rooms r
         LEFT JOIN room_players rp ON rp.room_id = r.id
         WHERE r.invite_code_hash = $1
         GROUP BY r.id, r.version, r.status`,
        [inviteCodeHash],
      ),
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      roomId: row.id,
      version: safeInteger(row.version, "room version"),
      occupancy: safeInteger(row.occupancy, "room occupancy"),
      status: row.status,
    };
  }

  async createRoom(input: CreateRoomLifecycleInput): Promise<RoomMutationResult> {
    if (!input.actorPlayerId.trim() || !input.commandId.trim() || !input.requestHash.trim()) {
      throw new TypeError("Room creator, command ID, and request hash are required.");
    }
    if (!input.id.trim() || !input.inviteCodeHash.trim() || !input.outboxEventId.trim()) {
      throw new TypeError("Room ID, invite hash, and outbox event ID are required.");
    }
    return withTransaction(this.pool, async (client) => {
      const existing = await findReceipt(client, input.actorPlayerId, input.commandId);
      if (existing) {
        return checkReceipt(existing, {
          actorPlayerId: input.actorPlayerId,
          commandId: input.commandId,
          requestHash: input.requestHash,
          roomId: input.id,
        }, true);
      }

      await client.query("SAVEPOINT room_create_writes");
      await client.query(
        `INSERT INTO rooms (id, owner_player_id, invite_code_hash, capacity)
         VALUES ($1, $2, $3, $4)`,
        [input.id, input.ownerPlayerId, input.inviteCodeHash, input.capacity],
      );
      await client.query(
        `INSERT INTO room_players (room_id, player_id, seat_index, ready)
         VALUES ($1, $2, 0, false)`,
        [input.id, input.ownerPlayerId],
      );

      const outcome: RoomMutationOutcome = {
        roomId: input.id,
        version: 0,
        roomStatus: "waiting",
        ownerPlayerId: input.ownerPlayerId,
        occupancy: 1,
        changed: true,
        playerId: input.ownerPlayerId,
        seatIndex: 0,
      };
      const inserted = await insertReceipt(
        client,
        input.actorPlayerId,
        input.commandId,
        input.id,
        input.requestHash,
        outcome,
      );
      if (!inserted) {
        await client.query("ROLLBACK TO SAVEPOINT room_create_writes");
        const conflicting = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (!conflicting) throw new RoomLifecycleInvariantError("Receipt conflict had no receipt row.");
        const duplicate = checkReceipt(conflicting, {
          actorPlayerId: input.actorPlayerId,
          commandId: input.commandId,
          requestHash: input.requestHash,
          roomId: input.id,
        }, true);
        await client.query("RELEASE SAVEPOINT room_create_writes");
        return duplicate;
      }

      await insertRoomOutbox(client, input.outboxEventId, input.id, 0);
      await client.query("RELEASE SAVEPOINT room_create_writes");
      return { status: "applied", outcome };
    });
  }

  async joinRoom(input: JoinRoomInput): Promise<RoomMutationResult> {
    validateCommand(input);
    if (!input.inviteCodeHash.trim()) throw new TypeError("Invite code hash is required.");
    return this.mutateRoom(input, async (client, room) => {
      if (room.invite_code_hash !== input.inviteCodeHash) throw new RoomInviteMismatchError();
      this.assertMembershipMutable(room.status);

      const members = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready FROM room_players WHERE room_id = $1 ORDER BY seat_index`,
        [room.id],
      );
      if (members.rows.some(({ player_id }) => player_id === input.actorPlayerId)) {
        throw new RoomAlreadyJoinedError(input.actorPlayerId);
      }
      if (members.rows.length >= room.capacity) throw new RoomFullError();

      const occupied = new Set(members.rows.map(({ seat_index }) => seat_index));
      let seatIndex = 0;
      while (seatIndex < room.capacity && occupied.has(seatIndex)) seatIndex += 1;
      if (seatIndex >= room.capacity) throw new RoomFullError();

      await client.query(
        `INSERT INTO room_players (room_id, player_id, seat_index, ready)
         VALUES ($1, $2, $3, false)`,
        [room.id, input.actorPlayerId, seatIndex],
      );
      return {
        changed: true,
        roomStatus: room.status,
        ownerPlayerId: room.owner_player_id,
        occupancy: members.rows.length + 1,
        playerId: input.actorPlayerId,
        seatIndex,
      };
    });
  }

  async leaveRoom(input: LeaveRoomInput): Promise<RoomMutationResult> {
    validateCommand(input);
    return this.mutateRoom(input, async (client, room) => {
      this.assertMembershipMutable(room.status);
      const member = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready
         FROM room_players WHERE room_id = $1 AND player_id = $2`,
        [room.id, input.actorPlayerId],
      );
      if (!member.rows[0]) throw new RoomMembershipRequiredError(input.actorPlayerId);

      await client.query("DELETE FROM room_players WHERE room_id = $1 AND player_id = $2", [
        room.id,
        input.actorPlayerId,
      ]);
      const remaining = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready
         FROM room_players WHERE room_id = $1
         ORDER BY joined_at ASC, seat_index ASC`,
        [room.id],
      );

      let ownerPlayerId = room.owner_player_id;
      let roomStatus = room.status;
      if (remaining.rows.length === 0) {
        roomStatus = "closed";
      } else if (input.actorPlayerId === room.owner_player_id) {
        ownerPlayerId = remaining.rows[0]!.player_id;
      }
      return {
        changed: true,
        roomStatus,
        ownerPlayerId,
        occupancy: remaining.rows.length,
        playerId: input.actorPlayerId,
        seatIndex: member.rows[0].seat_index,
        ready: member.rows[0].ready,
      };
    });
  }

  async setReady(input: SetReadyInput): Promise<RoomMutationResult> {
    validateCommand(input);
    return this.mutateRoom(input, async (client, room) => {
      this.assertMembershipMutable(room.status);
      const member = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready
         FROM room_players WHERE room_id = $1 AND player_id = $2`,
        [room.id, input.actorPlayerId],
      );
      const row = member.rows[0];
      if (!row) throw new RoomMembershipRequiredError(input.actorPlayerId);
      if (row.ready !== input.ready) {
        await client.query(
          "UPDATE room_players SET ready = $3 WHERE room_id = $1 AND player_id = $2",
          [room.id, input.actorPlayerId, input.ready],
        );
      }
      const occupancy = await this.countMembers(client, room.id);
      return {
        changed: row.ready !== input.ready,
        roomStatus: room.status,
        ownerPlayerId: room.owner_player_id,
        occupancy,
        playerId: input.actorPlayerId,
        seatIndex: row.seat_index,
        ready: input.ready,
      };
    });
  }

  async setRoomStatus(input: SetRoomStatusInput): Promise<RoomMutationResult> {
    validateCommand(input);
    return this.mutateRoom(input, async (client, room) => {
      if (room.status === "closed" && input.status !== "closed") throw new RoomClosedError();
      return {
        changed: room.status !== input.status,
        roomStatus: input.status,
        ownerPlayerId: room.owner_player_id,
        occupancy: await this.countMembers(client, room.id),
      };
    });
  }

  /** Atomically starts a match from the locked, ready room roster. */
  async startRoomWithMatch(input: StartRoomWithMatchInput): Promise<StartRoomWithMatchResult> {
    validateCommand(input);
    if (!input.matchId.trim() || !input.matchOutboxEventId.trim()) {
      throw new TypeError("Match ID and match outbox event ID are required.");
    }
    if (input.matchOutboxEventId === input.outboxEventId) {
      throw new TypeError("Room and match outbox event IDs must be distinct.");
    }

    return withTransaction(this.pool, async (client) => {
      const existingReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
      if (existingReceipt) return checkStartReceipt(existingReceipt, input);

      const roomResult = await client.query<RoomRow>(
        `SELECT id, owner_player_id, invite_code_hash, status, capacity, version
         FROM rooms WHERE id = $1 FOR UPDATE`,
        [input.roomId],
      );
      const room = roomResult.rows[0];
      if (!room) throw new RoomNotFoundError(input.roomId);
      const currentVersion = safeInteger(room.version, "room version");
      if (currentVersion !== input.expectedVersion) {
        const lateReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (lateReceipt) return checkStartReceipt(lateReceipt, input);
        throw new RoomVersionConflictError(input.expectedVersion, currentVersion);
      }
      if (room.status === "closed") throw new RoomClosedError();

      let completedMatchId: string | null = null;
      if (room.status === "in_game") {
        const latestMatchResult = await client.query<LatestMatchRow>(
          `SELECT id, status FROM matches WHERE room_id = $1
           ORDER BY created_at DESC, started_at DESC, id DESC LIMIT 1 FOR UPDATE`,
          [room.id],
        );
        const latestMatch = latestMatchResult.rows[0];
        if (!latestMatch || latestMatch.status !== "completed") {
          throw new RoomLockedError(room.status);
        }
        completedMatchId = latestMatch.id;
      } else if (room.status !== "waiting") {
        throw new RoomLockedError(room.status);
      }

      const membersResult = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready FROM room_players
         WHERE room_id = $1 ORDER BY seat_index FOR UPDATE`,
        [room.id],
      );
      const members = membersResult.rows;
      if (!members.some(({ player_id }) => player_id === input.actorPlayerId)) {
        throw new RoomMembershipRequiredError(input.actorPlayerId);
      }
      if (room.owner_player_id !== input.actorPlayerId) throw new RoomOwnerRequiredError();
      if (members.length > room.capacity) {
        throw new RoomLifecycleInvariantError("Room occupancy exceeds its configured capacity.");
      }
      if (completedMatchId !== null) {
        const previousRosterResult = await client.query<MatchRosterRow>(
          `SELECT player_id, seat_index FROM match_players WHERE match_id = $1 ORDER BY seat_index FOR UPDATE`,
          [completedMatchId],
        );
        assertUnchangedRoster(room, members, previousRosterResult.rows);
      }
      assertReadySnapshot(input.state, members);

      const nextVersion = currentVersion + 1;
      const outcome: StartRoomWithMatchOutcome = {
        roomId: room.id,
        matchId: input.matchId,
        version: nextVersion,
        roomStatus: "in_game",
        ownerPlayerId: room.owner_player_id,
        occupancy: members.length,
        changed: true,
      };

      await client.query("SAVEPOINT room_start_writes");
      await insertMatchInTransaction(client, {
        id: input.matchId,
        roomId: room.id,
        state: input.state,
        startedAt: input.startedAt,
      });
      const updatedRoom = await client.query<{ version: DatabaseInteger }>(
        `UPDATE rooms SET status = 'in_game', version = $3, updated_at = now()
         WHERE id = $1 AND status = $2 AND version = $4
         RETURNING version`,
        [room.id, room.status, nextVersion, input.expectedVersion],
      );
      if (!updatedRoom.rows[0]) {
        await client.query("ROLLBACK TO SAVEPOINT room_start_writes");
        const lateReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (lateReceipt) {
          const duplicate = checkStartReceipt(lateReceipt, input);
          await client.query("RELEASE SAVEPOINT room_start_writes");
          return duplicate;
        }
        const latestRoom = await client.query<{ version: DatabaseInteger }>(
          "SELECT version FROM rooms WHERE id = $1",
          [room.id],
        );
        const latestVersion = latestRoom.rows[0]
          ? safeInteger(latestRoom.rows[0].version, "room version")
          : currentVersion;
        throw new RoomVersionConflictError(input.expectedVersion, latestVersion);
      }

      const inserted = await insertReceipt(
        client,
        input.actorPlayerId,
        input.commandId,
        room.id,
        input.requestHash,
        outcome,
      );
      if (!inserted) {
        await client.query("ROLLBACK TO SAVEPOINT room_start_writes");
        const conflicting = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (!conflicting) throw new RoomLifecycleInvariantError("Receipt conflict had no receipt row.");
        const duplicate = checkStartReceipt(conflicting, input);
        await client.query("RELEASE SAVEPOINT room_start_writes");
        return duplicate;
      }

      await insertRoomOutbox(client, input.outboxEventId, room.id, nextVersion);
      await insertMatchOutbox(
        client,
        input.matchOutboxEventId,
        input.matchId,
        input.state.version,
        input.state.eventSeq,
      );
      const initialEvents = input.events ?? [];
      if (input.events && (initialEvents.length !== input.state.eventSeq ||
          new Set(initialEvents.map(event => event.eventId)).size !== initialEvents.length ||
          initialEvents.some((event, index) => event.eventSeq !== index + 1 || event.version !== input.state.version))) {
        throw new RoomLifecycleInvariantError("Initial event sequence must match its saved snapshot.");
      }
      for (const event of initialEvents) {
        await client.query(`INSERT INTO match_events
          (match_id, event_seq, event_id, version, type, actor_player_id, payload_json, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
        [input.matchId, event.eventSeq, event.eventId, event.version, event.type,
          event.actorPlayerId, JSON.stringify(event.payload), event.createdAt]);
      }
      await client.query("RELEASE SAVEPOINT room_start_writes");
      return { status: "applied", outcome };
    });
  }

  /** Returns the same completed match's room to the lobby without changing its history. */
  async returnToLobby(input: ReturnToLobbyInput): Promise<RoomMutationResult> {
    validateCommand(input);
    return withTransaction(this.pool, async (client) => {
      const existingReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
      if (existingReceipt) return checkReceipt(existingReceipt, input, false);

      const roomResult = await client.query<RoomRow>(
        `SELECT id, owner_player_id, invite_code_hash, status, capacity, version
         FROM rooms WHERE id = $1 FOR UPDATE`,
        [input.roomId],
      );
      const room = roomResult.rows[0];
      if (!room) throw new RoomNotFoundError(input.roomId);
      const currentVersion = safeInteger(room.version, "room version");
      if (currentVersion !== input.expectedVersion) {
        const lateReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (lateReceipt) return checkReceipt(lateReceipt, input, false);
        throw new RoomVersionConflictError(input.expectedVersion, currentVersion);
      }
      if (room.status === "closed") throw new RoomClosedError();
      if (room.status !== "in_game") throw new RoomLockedError(room.status);

      const latestMatchResult = await client.query<LatestMatchRow>(
        `SELECT id, status FROM matches WHERE room_id = $1
         ORDER BY created_at DESC, started_at DESC, id DESC LIMIT 1 FOR UPDATE`,
        [room.id],
      );
      const latestMatch = latestMatchResult.rows[0];
      if (!latestMatch || latestMatch.status !== "completed") {
        throw new RoomLockedError(room.status);
      }

      const membersResult = await client.query<RoomPlayerRow>(
        `SELECT player_id, seat_index, ready FROM room_players
         WHERE room_id = $1 ORDER BY seat_index FOR UPDATE`,
        [room.id],
      );
      const members = membersResult.rows;
      if (!members.some(({ player_id }) => player_id === input.actorPlayerId)) {
        throw new RoomMembershipRequiredError(input.actorPlayerId);
      }
      if (room.owner_player_id !== input.actorPlayerId) throw new RoomOwnerRequiredError();

      const nextVersion = currentVersion + 1;
      const outcome: RoomMutationOutcome = {
        roomId: room.id,
        version: nextVersion,
        roomStatus: "waiting",
        ownerPlayerId: room.owner_player_id,
        occupancy: members.length,
        changed: true,
      };

      await client.query("SAVEPOINT room_return_to_lobby_writes");
      await client.query("UPDATE room_players SET ready = false WHERE room_id = $1", [room.id]);
      const updatedRoom = await client.query<{ version: DatabaseInteger }>(
        `UPDATE rooms SET status = 'waiting', version = $3, updated_at = now()
         WHERE id = $1 AND status = $2 AND version = $4
         RETURNING version`,
        [room.id, room.status, nextVersion, input.expectedVersion],
      );
      if (!updatedRoom.rows[0]) {
        await client.query("ROLLBACK TO SAVEPOINT room_return_to_lobby_writes");
        const lateReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (lateReceipt) {
          const duplicate = checkReceipt(lateReceipt, input, false);
          await client.query("RELEASE SAVEPOINT room_return_to_lobby_writes");
          return duplicate;
        }
        const latestRoom = await client.query<{ version: DatabaseInteger }>(
          "SELECT version FROM rooms WHERE id = $1",
          [room.id],
        );
        const latestVersion = latestRoom.rows[0]
          ? safeInteger(latestRoom.rows[0].version, "room version")
          : currentVersion;
        throw new RoomVersionConflictError(input.expectedVersion, latestVersion);
      }

      const inserted = await insertReceipt(
        client,
        input.actorPlayerId,
        input.commandId,
        room.id,
        input.requestHash,
        outcome,
      );
      if (!inserted) {
        await client.query("ROLLBACK TO SAVEPOINT room_return_to_lobby_writes");
        const conflicting = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (!conflicting) throw new RoomLifecycleInvariantError("Receipt conflict had no receipt row.");
        const duplicate = checkReceipt(conflicting, input, false);
        await client.query("RELEASE SAVEPOINT room_return_to_lobby_writes");
        return duplicate;
      }

      await insertRoomOutbox(client, input.outboxEventId, room.id, nextVersion);
      await client.query("RELEASE SAVEPOINT room_return_to_lobby_writes");
      return { status: "applied", outcome };
    });
  }

  private assertMembershipMutable(status: RoomStatus): void {
    if (status === "closed") throw new RoomClosedError();
    if (status !== "waiting") throw new RoomLockedError(status);
  }

  private async countMembers(client: PgClientLike, roomId: string): Promise<number> {
    const result = await client.query<{ occupancy: DatabaseInteger }>(
      "SELECT count(*)::bigint AS occupancy FROM room_players WHERE room_id = $1",
      [roomId],
    );
    return safeInteger(result.rows[0]!.occupancy, "room occupancy");
  }

  private async mutateRoom(
    input: RoomCommandBase,
    mutate: (client: PgClientLike, room: RoomRow) => Promise<AppliedRoomChange>,
  ): Promise<RoomMutationResult> {
    return withTransaction(this.pool, async (client) => {
      const existingReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
      if (existingReceipt) {
        return checkReceipt(existingReceipt, input, false);
      }

      const roomResult = await client.query<RoomRow>(
        `SELECT id, owner_player_id, invite_code_hash, status, capacity, version
         FROM rooms WHERE id = $1 FOR UPDATE`,
        [input.roomId],
      );
      const room = roomResult.rows[0];
      if (!room) throw new RoomNotFoundError(input.roomId);
      const currentVersion = safeInteger(room.version, "room version");
      if (currentVersion !== input.expectedVersion) {
        const lateReceipt = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (lateReceipt) return checkReceipt(lateReceipt, input, false);
        throw new RoomVersionConflictError(input.expectedVersion, currentVersion);
      }

      await client.query("SAVEPOINT room_mutation_writes");
      const change = await mutate(client, room);
      const version = currentVersion + (change.changed ? 1 : 0);
      if (change.changed) {
        const updated = await client.query<{ version: DatabaseInteger }>(
          `UPDATE rooms SET status = $2, owner_player_id = $3, version = $4, updated_at = now()
           WHERE id = $1 AND version = $5
           RETURNING version`,
          [room.id, change.roomStatus, change.ownerPlayerId, version, input.expectedVersion],
        );
        if (!updated.rows[0]) throw new RoomVersionConflictError(input.expectedVersion, currentVersion);
      }

      const outcome: RoomMutationOutcome = {
        roomId: room.id,
        version,
        roomStatus: change.roomStatus,
        ownerPlayerId: change.ownerPlayerId,
        occupancy: change.occupancy,
        changed: change.changed,
        ...(change.playerId === undefined ? {} : { playerId: change.playerId }),
        ...(change.seatIndex === undefined ? {} : { seatIndex: change.seatIndex }),
        ...(change.ready === undefined ? {} : { ready: change.ready }),
      };
      const inserted = await insertReceipt(
        client,
        input.actorPlayerId,
        input.commandId,
        room.id,
        input.requestHash,
        outcome,
      );
      if (!inserted) {
        await client.query("ROLLBACK TO SAVEPOINT room_mutation_writes");
        const conflicting = await findReceipt(client, input.actorPlayerId, input.commandId);
        if (!conflicting) throw new RoomLifecycleInvariantError("Receipt conflict had no receipt row.");
        const duplicate = checkReceipt(conflicting, input, false);
        await client.query("RELEASE SAVEPOINT room_mutation_writes");
        return duplicate;
      }

      if (change.changed) await insertRoomOutbox(client, input.outboxEventId, room.id, version);
      await client.query("RELEASE SAVEPOINT room_mutation_writes");
      return { status: "applied", outcome };
    });
  }
}
