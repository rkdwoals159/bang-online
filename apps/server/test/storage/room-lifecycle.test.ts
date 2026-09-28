import assert from "node:assert/strict";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { applyStorageMigrations } from "../../src/storage/migrations.ts";
import {
  RoomAlreadyJoinedError,
  RoomClosedError,
  RoomCommandIdReusedError,
  RoomFullError,
  RoomInviteMismatchError,
  RoomLifecycleInvariantError,
  RoomLifecycleRepository,
  RoomLockedError,
  RoomMembershipRequiredError,
  RoomOwnerRequiredError,
  RoomStartNotReadyError,
  RoomVersionConflictError,
} from "../../src/storage/room-lifecycle.ts";
import { StorageRepository } from "../../src/storage/repository.ts";
import type { PgClientLike, PgPoolLike } from "../../src/storage/database.ts";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.ts";
import type { GameState } from "../../../../packages/engine/src/state/types.ts";
import { createDatabase } from "./pglite-pool.ts";

const playerIds = ["player-1", "player-2", "player-3", "player-4", "player-5"] as const;
const fixedNow = new Date("2026-09-27T00:00:00.000Z");

async function createFixture() {
  const { database, pool } = await createDatabase();
  await applyStorageMigrations(pool);
  const storage = new StorageRepository(pool);
  const lifecycle = new RoomLifecycleRepository(pool);
  for (const playerId of playerIds) {
    await storage.createGuestSession({
      id: playerId,
      tokenHash: `token-hash-${playerId}`,
      displayName: `Guest ${playerId.slice(-1)}`,
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  }
  return { database, lifecycle, storage };
}

async function createConcurrentFixture() {
  const database = new PGlite();
  await database.waitReady;
  const socketServer = new PGLiteSocketServer({ db: database, host: "127.0.0.1", port: 0, maxConnections: 2 });
  await socketServer.start();
  const port = Number(socketServer.getServerConn().split(":").at(-1));
  const driverPool = new Pool({
    connectionString: `postgresql://pglite:pglite@127.0.0.1:${port}/postgres`,
    max: 2,
  });
  const pool: PgPoolLike = {
    async connect(): Promise<PgClientLike> {
      return await driverPool.connect() as unknown as PgClientLike;
    },
  };
  try {
    await applyStorageMigrations(pool);
    const storage = new StorageRepository(pool);
    const lifecycle = new RoomLifecycleRepository(pool);
    for (const playerId of playerIds) {
      await storage.createGuestSession({
        id: playerId,
        tokenHash: `token-hash-${playerId}`,
        displayName: `Guest ${playerId.slice(-1)}`,
        expiresAt: new Date("2030-01-01T00:00:00.000Z"),
      });
    }
    return {
      database,
      lifecycle,
      storage,
      async close() {
        await driverPool.end();
        await socketServer.stop();
        await database.close();
      },
    };
  } catch (error) {
    await driverPool.end();
    await socketServer.stop();
    await database.close();
    throw error;
  }
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "room-1",
    ownerPlayerId: playerIds[0],
    inviteCodeHash: "invite-hash-room-1",
    capacity: 4 as const,
    actorPlayerId: playerIds[0],
    commandId: "command-create-room-1",
    requestHash: "request-create-room-1",
    outboxEventId: "outbox-create-room-1",
    ...overrides,
  };
}

function commandBase(
  roomId: string,
  actorPlayerId: string,
  expectedVersion: number,
  commandId: string,
  requestHash = `request-${commandId}`,
  outboxEventId = `outbox-${commandId}`,
) {
  return { roomId, actorPlayerId, expectedVersion, commandId, requestHash, outboxEventId };
}

function initialState(ids: readonly string[] = playerIds.slice(0, 4), sample = 0): GameState {
  return initializeGame({
    players: ids.map((playerId, index) => ({ playerId, displayName: `Guest ${index + 1}` })),
    random: { nextFloat: () => sample },
  });
}

async function markMatchCompleted(database: Awaited<ReturnType<typeof createDatabase>>["database"], matchId: string) {
  await database.query(
    `UPDATE matches
     SET status = 'completed', state_json = jsonb_set(state_json, '{status}', '"completed"'::jsonb), ended_at = now()
     WHERE id = $1`,
    [matchId],
  );
}

async function createReadyRoom(
  lifecycle: RoomLifecycleRepository,
  options: { readonly memberCount?: number; readonly ready?: boolean } = {},
): Promise<number> {
  const memberCount = options.memberCount ?? 4;
  const ready = options.ready ?? true;
  await lifecycle.createRoom(createInput({ capacity: 4 }));
  let version = 0;
  for (let index = 1; index < memberCount; index += 1) {
    const playerId = playerIds[index]!;
    await lifecycle.joinRoom({
      ...commandBase("room-1", playerId, version, `join-start-${index}`),
      inviteCodeHash: "invite-hash-room-1",
    });
    version += 1;
  }
  for (let index = 0; index < memberCount; index += 1) {
    if (!ready && index === memberCount - 1) continue;
    await lifecycle.setReady({
      ...commandBase("room-1", playerIds[index]!, version, `ready-start-${index}`),
      ready: true,
    });
    version += 1;
  }
  return version;
}

function startInput(expectedVersion: number, overrides: Record<string, unknown> = {}) {
  return {
    ...commandBase("room-1", playerIds[0], expectedVersion, "start-room-match"),
    matchId: "match-start-1",
    matchOutboxEventId: "outbox-match-start-1",
    state: initialState(),
    ...overrides,
  };
}

test("looks up only active hashed sessions and creates an idempotent room with a safe preview", async () => {
  const { database, lifecycle } = await createFixture();
  try {
    const active = await lifecycle.findActiveGuestSessionByTokenHash("token-hash-player-1", fixedNow);
    assert.deepEqual(active, {
      playerId: playerIds[0],
      displayName: "Guest 1",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
    assert.equal(await lifecycle.findActiveGuestSessionByTokenHash("missing-hash", fixedNow), null);

    await database.query("UPDATE guest_sessions SET expires_at = $2 WHERE id = $1", [
      playerIds[1],
      new Date("2025-01-01T00:00:00.000Z"),
    ]);
    await database.query("UPDATE guest_sessions SET revoked_at = $2 WHERE id = $1", [playerIds[2], fixedNow]);
    assert.equal(await lifecycle.findActiveGuestSessionByTokenHash("token-hash-player-2", fixedNow), null);
    assert.equal(await lifecycle.findActiveGuestSessionByTokenHash("token-hash-player-3", fixedNow), null);

    const created = await lifecycle.createRoom(createInput());
    assert.equal(created.status, "applied");
    if (created.status !== "applied") throw new Error("Expected first room creation to apply.");
    assert.deepEqual(created.outcome, {
      roomId: "room-1",
      version: 0,
      roomStatus: "waiting",
      ownerPlayerId: playerIds[0],
      occupancy: 1,
      changed: true,
      playerId: playerIds[0],
      seatIndex: 0,
    });

    const duplicate = await lifecycle.createRoom(
      createInput({
        id: "room-randomized-retry-id",
        inviteCodeHash: "different-invite-hash",
        outboxEventId: "outbox-randomized-retry",
      }),
    );
    assert.deepEqual(duplicate, { status: "duplicate", outcome: created.outcome });
    await assert.rejects(
      lifecycle.createRoom(createInput({ requestHash: "different-create-request-hash" })),
      RoomCommandIdReusedError,
    );
    assert.equal(await lifecycle.previewRoomByInviteHash("different-invite-hash"), null);

    const preview = await lifecycle.previewRoomByInviteHash("invite-hash-room-1");
    assert.deepEqual(preview, { roomId: "room-1", version: 0, occupancy: 1, status: "waiting" });
    assert.equal(await lifecycle.previewRoomByInviteHash("unknown-invite-hash"), null);

    const secrets = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM guest_sessions ORDER BY id",
    );
    assert.deepEqual(secrets.rows.map(({ token_hash }) => token_hash), playerIds.map((id) => `token-hash-${id}`));
    const room = await database.query<{ invite_code_hash: string }>(
      "SELECT invite_code_hash FROM rooms WHERE id = 'room-1'",
    );
    assert.equal(room.rows[0]?.invite_code_hash, "invite-hash-room-1");
    assert.equal(JSON.stringify(preview).includes("invite-hash"), false);
  } finally {
    await database.close();
  }
});

test("starts a room and persists the initialized match, receipt, and both allowlisted outboxes atomically", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const expectedVersion = await createReadyRoom(lifecycle);
    const input = startInput(expectedVersion);

    const started = await lifecycle.startRoomWithMatch(input);
    assert.equal(started.status, "applied");
    if (started.status !== "applied") throw new Error("Expected room start to apply.");
    assert.deepEqual(started.outcome, {
      roomId: "room-1",
      matchId: "match-start-1",
      version: expectedVersion + 1,
      roomStatus: "in_game",
      ownerPlayerId: playerIds[0],
      occupancy: 4,
      changed: true,
    });

    const room = await storage.getRoom("room-1");
    const match = await storage.getMatch("match-start-1");
    const receipt = await storage.findCommandReceipt(playerIds[0], "start-room-match");
    assert.equal(room?.status, "in_game");
    assert.equal(room?.version, expectedVersion + 1);
    assert.ok(match);
    assert.equal(match.roomId, "room-1");
    assert.deepEqual(match.state, input.state);
    assert.deepEqual(
      match.players.map(({ playerId, seatIndex, alive, connectionState }) => ({ playerId, seatIndex, alive, connectionState })),
      input.state.seats.map(({ public: seat }) => ({
        playerId: seat.playerId,
        seatIndex: seat.seatIndex,
        alive: true,
        connectionState: "disconnected",
      })),
    );
    assert.equal(receipt?.roomId, "room-1");
    assert.equal(receipt?.matchId, null, "room receipts must obey the mutually-exclusive aggregate columns");
    assert.deepEqual(receipt?.outcome, started.outcome);

    const outbox = await database.query<{
      event_id: string;
      aggregate_id: string;
      aggregate_version: string;
      event_seq: string;
      kind: string;
      payload_json: Record<string, unknown>;
    }>(
      "SELECT event_id, aggregate_id, aggregate_version::text, event_seq::text, kind, payload_json FROM outbox WHERE event_id IN ($1, $2) ORDER BY kind",
      [input.outboxEventId, input.matchOutboxEventId],
    );
    assert.equal(outbox.rows.length, 2);
    assert.deepEqual(outbox.rows.map(({ kind, payload_json }) => ({ kind, keys: Object.keys(payload_json).sort() })), [
      { kind: "match:changed", keys: ["eventSeq", "matchId", "version"] },
      { kind: "room:changed", keys: ["roomId", "version"] },
    ]);
    const roomSignal = outbox.rows.find(({ kind }) => kind === "room:changed");
    const matchSignal = outbox.rows.find(({ kind }) => kind === "match:changed");
    assert.equal(roomSignal?.aggregate_id, "room-1");
    assert.equal(roomSignal?.aggregate_version, String(expectedVersion + 1));
    assert.deepEqual(roomSignal?.payload_json, { roomId: "room-1", version: expectedVersion + 1 });
    assert.equal(matchSignal?.aggregate_id, "match-start-1");
    assert.equal(matchSignal?.aggregate_version, String(input.state.version));
    assert.equal(matchSignal?.event_seq, String(input.state.eventSeq));
    assert.deepEqual(matchSignal?.payload_json, {
      matchId: "match-start-1",
      version: input.state.version,
      eventSeq: input.state.eventSeq,
    });
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), "match-start-1");
  } finally {
    await database.close();
  }
});

test("a duplicate room-start command returns the original match outcome without additional writes", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const expectedVersion = await createReadyRoom(lifecycle);
    const input = startInput(expectedVersion);
    const first = await lifecycle.startRoomWithMatch(input);
    assert.equal(first.status, "applied");
    if (first.status !== "applied") throw new Error("Expected initial start to apply.");
    const before = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
         (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
         (SELECT count(*) FROM outbox WHERE event_id IN ($3, $4))::text AS outbox`,
      [playerIds[0], input.commandId, input.outboxEventId, input.matchOutboxEventId],
    );

    const duplicate = await lifecycle.startRoomWithMatch({
      ...input,
      matchId: "match-randomized-retry",
      outboxEventId: "outbox-room-randomized-retry",
      matchOutboxEventId: "outbox-match-randomized-retry",
    });
    assert.deepEqual(duplicate, { status: "duplicate", outcome: first.outcome });
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), "match-start-1");
    const after = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
         (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
         (SELECT count(*) FROM outbox WHERE event_id IN ($3, $4, 'outbox-room-randomized-retry', 'outbox-match-randomized-retry'))::text AS outbox`,
      [playerIds[0], input.commandId, input.outboxEventId, input.matchOutboxEventId],
    );
    assert.deepEqual(after.rows[0], before.rows[0]);
    await assert.rejects(
      lifecycle.startRoomWithMatch({ ...input, requestHash: "different-start-request" }),
      RoomCommandIdReusedError,
    );
  } finally {
    await database.close();
  }
});

test("restarts directly from the latest completed match with atomic writes and preserved history", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const readyVersion = await createReadyRoom(lifecycle);
    const firstStart = await lifecycle.startRoomWithMatch(startInput(readyVersion, { matchId: "match-before-restart" }));
    assert.equal(firstStart.status, "applied");
    if (firstStart.status !== "applied") throw new Error("Expected initial room start to apply.");

    await markMatchCompleted(database, firstStart.outcome.matchId);
    await database.query(
      `INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json)
       VALUES ($1, 1, 'event-before-direct-restart', 1, 'MATCH_FINISHED', $2, '{"retained":true}'::jsonb)`,
      [firstStart.outcome.matchId, playerIds[0]],
    );
    const priorMatch = await storage.getMatch(firstStart.outcome.matchId);
    assert.ok(priorMatch);
    assert.equal(priorMatch.status, "completed");

    const restartInput = startInput(firstStart.outcome.version, {
      commandId: "start-after-completed-match",
      requestHash: "request-start-after-completed-match",
      matchId: "match-after-restart",
      outboxEventId: "outbox-room-after-restart",
      matchOutboxEventId: "outbox-match-after-restart",
      state: initialState(playerIds.slice(0, 4), 0.25),
      startedAt: fixedNow,
    });
    const restarted = await lifecycle.startRoomWithMatch(restartInput);
    assert.equal(restarted.status, "applied");
    if (restarted.status !== "applied") throw new Error("Expected completed-match restart to apply.");
    assert.deepEqual(restarted.outcome, {
      roomId: "room-1",
      matchId: "match-after-restart",
      version: firstStart.outcome.version + 1,
      roomStatus: "in_game",
      ownerPlayerId: playerIds[0],
      occupancy: 4,
      changed: true,
    });

    const room = await storage.getRoom("room-1");
    const restartedMatch = await storage.getMatch(restarted.outcome.matchId);
    assert.equal(room?.status, "in_game");
    assert.equal(room?.version, firstStart.outcome.version + 1);
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), restarted.outcome.matchId);
    assert.ok(restartedMatch);
    assert.equal(restartedMatch.status, "playing");
    assert.deepEqual(restartedMatch.state, restartInput.state);
    assert.deepEqual(
      restartedMatch.players.map(({ playerId }) => playerId).sort(),
      priorMatch.players.map(({ playerId }) => playerId).sort(),
    );
    assert.deepEqual(await storage.getMatch(priorMatch.id), priorMatch, "the completed snapshot and roster remain intact");
    const retainedEvents = await database.query<{ event_id: string; payload_json: Record<string, unknown> }>(
      "SELECT event_id, payload_json FROM match_events WHERE match_id = $1",
      [priorMatch.id],
    );
    assert.deepEqual(retainedEvents.rows, [
      { event_id: "event-before-direct-restart", payload_json: { retained: true } },
    ]);
    assert.equal((await storage.findCommandReceipt(playerIds[0], restartInput.commandId))?.outcome.matchId,
      restarted.outcome.matchId);
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE event_id IN ($1, $2)",
      [restartInput.outboxEventId, restartInput.matchOutboxEventId],
    )).rows[0]?.count, "2");

    const beforeRetry = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
         (SELECT count(*) FROM command_receipts WHERE room_id = 'room-1')::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
    );
    const duplicate = await lifecycle.startRoomWithMatch({
      ...restartInput,
      matchId: "match-retry-must-not-write",
      outboxEventId: "outbox-room-retry-must-not-write",
      matchOutboxEventId: "outbox-match-retry-must-not-write",
      state: initialState(playerIds.slice(0, 4), 0.75),
    });
    assert.deepEqual(duplicate, { status: "duplicate", outcome: restarted.outcome });
    const afterRetry = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
         (SELECT count(*) FROM command_receipts WHERE room_id = 'room-1')::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
    );
    assert.deepEqual(afterRetry.rows[0], beforeRetry.rows[0]);
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), restarted.outcome.matchId);
  } finally {
    await database.close();
  }
});

test("rejects in-game starts unless the latest same-room match is completed, with no writes", async () => {
  const scenarios = ["playing", "paused", "recovery_required", "none"] as const;
  for (const latestStatus of scenarios) {
    const { database, lifecycle, storage } = await createFixture();
    try {
      let roomVersion = await createReadyRoom(lifecycle);
      let activeMatchId: string | null = null;
      if (latestStatus === "none") {
        const locked = await lifecycle.setRoomStatus({
          ...commandBase("room-1", playerIds[0], roomVersion, "set-in-game-without-match"),
          status: "in_game",
        });
        roomVersion = locked.outcome.version;
      } else {
        const firstStart = await lifecycle.startRoomWithMatch(startInput(roomVersion, { matchId: `match-${latestStatus}` }));
        assert.equal(firstStart.status, "applied");
        if (firstStart.status !== "applied") throw new Error("Expected initial room start to apply.");
        roomVersion = firstStart.outcome.version;
        activeMatchId = firstStart.outcome.matchId;
        if (latestStatus !== "playing") {
          await database.query(
            `UPDATE matches
             SET status = $2, state_json = jsonb_set(state_json, '{status}', to_jsonb($2::text))
             WHERE id = $1`,
            [activeMatchId, latestStatus],
          );
        }
      }

      const command = startInput(roomVersion, {
        commandId: `reject-restart-${latestStatus}`,
        matchId: `match-rejected-${latestStatus}`,
        outboxEventId: `outbox-room-rejected-${latestStatus}`,
        matchOutboxEventId: `outbox-match-rejected-${latestStatus}`,
      });
      const beforeRoom = await storage.getRoom("room-1");
      const beforeCounts = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
           (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
           (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
           (SELECT count(*) FROM outbox)::text AS outbox`,
        [playerIds[0], command.commandId],
      );
      await assert.rejects(lifecycle.startRoomWithMatch(command), RoomLockedError, `latest status ${latestStatus}`);
      assert.deepEqual(await storage.getRoom("room-1"), beforeRoom, `${latestStatus}: room must remain unchanged`);
      assert.equal(await storage.getMatch(command.matchId), null, `${latestStatus}: no match may be written`);
      assert.equal(await storage.getLatestMatchIdForRoom("room-1"), activeMatchId);
      const afterCounts = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
           (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
           (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
           (SELECT count(*) FROM outbox)::text AS outbox`,
        [playerIds[0], command.commandId],
      );
      assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0], `${latestStatus}: receipt/outbox must not be added`);
    } finally {
      await database.close();
    }
  }
});

test("serializes concurrent direct restarts so only one new match becomes active", async () => {
  const { database, lifecycle, storage, close } = await createConcurrentFixture();
  try {
    const readyVersion = await createReadyRoom(lifecycle);
    const first = await lifecycle.startRoomWithMatch(startInput(readyVersion, { matchId: "match-concurrent-prior" }));
    assert.equal(first.status, "applied");
    if (first.status !== "applied") throw new Error("Expected initial room start to apply.");
    await markMatchCompleted(database, first.outcome.matchId);

    const expectedVersion = first.outcome.version;
    const attempts = [
      startInput(expectedVersion, {
        commandId: "concurrent-direct-restart-a",
        matchId: "match-concurrent-restart-a",
        outboxEventId: "outbox-room-concurrent-restart-a",
        matchOutboxEventId: "outbox-match-concurrent-restart-a",
        state: initialState(playerIds.slice(0, 4), 0.25),
      }),
      startInput(expectedVersion, {
        commandId: "concurrent-direct-restart-b",
        matchId: "match-concurrent-restart-b",
        outboxEventId: "outbox-room-concurrent-restart-b",
        matchOutboxEventId: "outbox-match-concurrent-restart-b",
        state: initialState(playerIds.slice(0, 4), 0.75),
      }),
    ];
    const results = await Promise.allSettled(attempts.map((input) => lifecycle.startRoomWithMatch(input)));
    const applied = results.filter((result) => result.status === "fulfilled" && result.value.status === "applied");
    const rejected = results.filter((result) => result.status === "rejected");
    assert.equal(applied.length, 1);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0]?.status === "rejected" && rejected[0].reason instanceof RoomVersionConflictError);
    if (applied[0]?.status !== "fulfilled") throw new Error("Expected a single direct restart to apply.");
    const winningMatchId = applied[0].value.outcome.matchId;
    assert.ok(attempts.some(({ matchId }) => matchId === winningMatchId));
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), winningMatchId);
    assert.equal((await storage.getMatch(winningMatchId))?.status, "playing");

    const counts = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
         (SELECT count(*) FROM command_receipts WHERE actor_player_id = $5 AND command_id = ANY($6::text[]))::text AS receipts,
         (SELECT count(*) FROM outbox WHERE event_id IN ($1, $2, $3, $4))::text AS outbox`,
      [
        attempts[0]!.outboxEventId,
        attempts[0]!.matchOutboxEventId,
        attempts[1]!.outboxEventId,
        attempts[1]!.matchOutboxEventId,
        playerIds[0],
        ["start-room-match", attempts[0]!.commandId, attempts[1]!.commandId],
      ],
    );
    assert.deepEqual(counts.rows[0], { matches: "2", players: "8", receipts: "2", outbox: "2" });
    const room = await storage.getRoom("room-1");
    assert.equal(room?.version, expectedVersion + 1);
    assert.equal(room?.status, "in_game");
  } finally {
    await close();
  }
});

test("direct restart rechecks unchanged membership and readiness before writing", async () => {
  const scenarios = ["changed roster", "reordered seats", "not all ready"] as const;
  for (const scenario of scenarios) {
    const { database, lifecycle, storage } = await createFixture();
    try {
      const readyVersion = await createReadyRoom(lifecycle);
      const first = await lifecycle.startRoomWithMatch(startInput(readyVersion, { matchId: `match-prior-${scenario}` }));
      assert.equal(first.status, "applied");
      if (first.status !== "applied") throw new Error("Expected initial room start to apply.");
      await markMatchCompleted(database, first.outcome.matchId);

      let nextState = initialState();
      if (scenario === "changed roster") {
        await database.query("DELETE FROM room_players WHERE room_id = 'room-1' AND player_id = $1", [playerIds[3]]);
        await database.query(
          "INSERT INTO room_players (room_id, player_id, seat_index, ready) VALUES ('room-1', $1, 3, true)",
          [playerIds[4]],
        );
        nextState = initialState(playerIds.slice(0, 3).concat(playerIds[4]));
      } else if (scenario === "reordered seats") {
        await database.query("UPDATE room_players SET seat_index = 4 WHERE room_id = 'room-1' AND player_id = $1", [playerIds[2]]);
        await database.query("UPDATE room_players SET seat_index = 2 WHERE room_id = 'room-1' AND player_id = $1", [playerIds[3]]);
        await database.query("UPDATE room_players SET seat_index = 3 WHERE room_id = 'room-1' AND player_id = $1", [playerIds[2]]);
      } else {
        await database.query("UPDATE room_players SET ready = false WHERE room_id = 'room-1' AND player_id = $1", [playerIds[3]]);
      }

      const command = startInput(first.outcome.version, {
        commandId: `restart-guard-${scenario.replaceAll(" ", "-")}`,
        matchId: `match-guard-${scenario.replaceAll(" ", "-")}`,
        state: nextState,
      });
      const beforeRoom = await storage.getRoom("room-1");
      const beforeCounts = await database.query<{ matches: string; receipts: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
           (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
           (SELECT count(*) FROM outbox)::text AS outbox`,
        [playerIds[0], command.commandId],
      );
      const error = scenario === "not all ready" ? RoomStartNotReadyError : RoomLockedError;
      await assert.rejects(lifecycle.startRoomWithMatch(command), error, scenario);
      assert.deepEqual(await storage.getRoom("room-1"), beforeRoom);
      assert.equal(await storage.getMatch(command.matchId), null);
      const afterCounts = await database.query<{ matches: string; receipts: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
           (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
           (SELECT count(*) FROM outbox)::text AS outbox`,
        [playerIds[0], command.commandId],
      );
      assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0]);
    } finally {
      await database.close();
    }
  }
});

test("start rejects unauthorized, stale, incomplete, locked, and mismatched snapshots without side effects", async () => {
  const scenarios: Array<{
    readonly name: string;
    readonly setup: (lifecycle: RoomLifecycleRepository) => Promise<number>;
    readonly command: (version: number) => ReturnType<typeof startInput>;
    readonly error: new (...args: never[]) => Error;
  }> = [
    {
      name: "non-member",
      setup: (lifecycle) => createReadyRoom(lifecycle),
      command: (version) => startInput(version, { actorPlayerId: playerIds[4], commandId: "start-nonmember" }),
      error: RoomMembershipRequiredError,
    },
    {
      name: "non-owner member",
      setup: (lifecycle) => createReadyRoom(lifecycle),
      command: (version) => startInput(version, { actorPlayerId: playerIds[1], commandId: "start-nonowner" }),
      error: RoomOwnerRequiredError,
    },
    {
      name: "stale expected version",
      setup: (lifecycle) => createReadyRoom(lifecycle),
      command: (version) => startInput(version - 1, { commandId: "start-stale" }),
      error: RoomVersionConflictError,
    },
    {
      name: "fewer than four members",
      setup: (lifecycle) => createReadyRoom(lifecycle, { memberCount: 3 }),
      command: (version) => startInput(version, { commandId: "start-underfilled" }),
      error: RoomStartNotReadyError,
    },
    {
      name: "a member is not ready",
      setup: (lifecycle) => createReadyRoom(lifecycle, { ready: false }),
      command: (version) => startInput(version, { commandId: "start-not-ready" }),
      error: RoomStartNotReadyError,
    },
    {
      name: "state player set differs from room members",
      setup: (lifecycle) => createReadyRoom(lifecycle),
      command: (version) => {
        const state = initialState();
        const lastSeat = state.seats.at(-1);
        assert.ok(lastSeat);
        lastSeat.public.playerId = "outsider";
        return startInput(version, { commandId: "start-mismatched-state", state });
      },
      error: RoomLifecycleInvariantError,
    },
    {
      name: "room is no longer waiting",
      setup: async (lifecycle) => {
        const version = await createReadyRoom(lifecycle);
        await lifecycle.setRoomStatus({
          ...commandBase("room-1", playerIds[0], version, "mark-room-starting"),
          status: "starting",
        });
        return version + 1;
      },
      command: (version) => startInput(version, { commandId: "start-locked-room" }),
      error: RoomLockedError,
    },
  ];

  for (const scenario of scenarios) {
    const { database, lifecycle, storage } = await createFixture();
    try {
      const version = await scenario.setup(lifecycle);
      const beforeRoom = await storage.getRoom("room-1");
      const beforeCounts = await database.query<{ matches: string; receipts: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
           (SELECT count(*) FROM command_receipts WHERE command_id = $1)::text AS receipts,
           (SELECT count(*) FROM outbox)::text AS outbox`,
        [scenario.command(version).commandId],
      );
      const command = scenario.command(version);
      await assert.rejects(lifecycle.startRoomWithMatch(command), scenario.error, scenario.name);

      assert.deepEqual(await storage.getRoom("room-1"), beforeRoom, `${scenario.name}: room must remain unchanged`);
      assert.equal(await storage.getMatch(command.matchId), null, `${scenario.name}: no match may be written`);
      const afterCounts = await database.query<{ matches: string; receipts: string; outbox: string }>(
        `SELECT
           (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
           (SELECT count(*) FROM command_receipts WHERE command_id = $1)::text AS receipts,
           (SELECT count(*) FROM outbox)::text AS outbox`,
        [command.commandId],
      );
      assert.deepEqual(afterCounts.rows[0], beforeCounts.rows[0], `${scenario.name}: no receipt or outbox may be added`);
    } finally {
      await database.close();
    }
  }
});

test("outbox failure rolls back the room, match, players, receipt, and preceding signal", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const expectedVersion = await createReadyRoom(lifecycle);
    const beforeRoom = await storage.getRoom("room-1");
    const command = startInput(expectedVersion, {
      matchOutboxEventId: "outbox-create-room-1",
      commandId: "start-outbox-rollback",
    });

    await assert.rejects(lifecycle.startRoomWithMatch(command));

    assert.deepEqual(await storage.getRoom("room-1"), beforeRoom);
    assert.equal(await storage.getMatch(command.matchId), null);
    assert.equal(await storage.findCommandReceipt(playerIds[0], command.commandId), null);
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE event_id = $1",
      [command.outboxEventId],
    )).rows[0]?.count, "0");
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM matches WHERE room_id = 'room-1'",
    )).rows[0]?.count, "0");
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE event_id = 'outbox-create-room-1'",
    )).rows[0]?.count, "1", "the pre-existing conflicting outbox row remains intact");
  } finally {
    await database.close();
  }
});

test("concurrent retries of one room-start command commit one match and return its original ID", async () => {
  const { database, lifecycle, storage, close } = await createConcurrentFixture();
  try {
    const expectedVersion = await createReadyRoom(lifecycle);
    const firstAttempt = startInput(expectedVersion, { matchId: "match-race-a" });
    const secondAttempt = startInput(expectedVersion, {
      matchId: "match-race-b",
      outboxEventId: "outbox-room-race-b",
      matchOutboxEventId: "outbox-match-race-b",
    });

    const results = await Promise.all([
      lifecycle.startRoomWithMatch(firstAttempt),
      lifecycle.startRoomWithMatch(secondAttempt),
    ]);
    const applied = results.filter((result) => result.status === "applied");
    const duplicates = results.filter((result) => result.status === "duplicate");
    assert.equal(applied.length, 1);
    assert.equal(duplicates.length, 1);
    assert.deepEqual(duplicates[0]?.outcome, applied[0]?.outcome);
    assert.ok(["match-race-a", "match-race-b"].includes(applied[0]!.outcome.matchId));

    const room = await storage.getRoom("room-1");
    assert.equal(room?.status, "in_game");
    assert.equal(room?.version, expectedVersion + 1);
    const rows = await database.query<{ matches: string; players: string; receipts: string; start_outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = 'room-1')::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = 'room-1')::text AS players,
         (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
         (SELECT count(*) FROM outbox WHERE event_id IN ($3, $4, $5, $6))::text AS start_outbox`,
      [
        playerIds[0],
        firstAttempt.commandId,
        firstAttempt.outboxEventId,
        firstAttempt.matchOutboxEventId,
        secondAttempt.outboxEventId,
        secondAttempt.matchOutboxEventId,
      ],
    );
    assert.deepEqual(rows.rows[0], { matches: "1", players: "4", receipts: "1", start_outbox: "2" });
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), applied[0]?.outcome.matchId);
  } finally {
    await close();
  }
});

test("serializes join, readiness, owner transfer, and D10 closure with room receipts and allowlisted signals", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    await lifecycle.createRoom(createInput());
    const preview = await lifecycle.previewRoomByInviteHash("invite-hash-room-1");
    assert.deepEqual(preview, { roomId: "room-1", version: 0, occupancy: 1, status: "waiting" });

    const invalidInvite = {
      ...commandBase("room-1", playerIds[1], 0, "join-invalid-invite"),
      inviteCodeHash: "wrong-hash",
    };
    await assert.rejects(lifecycle.joinRoom(invalidInvite), RoomInviteMismatchError);

    const joinTwo = {
      ...commandBase("room-1", playerIds[1], 0, "join-player-2"),
      inviteCodeHash: "invite-hash-room-1",
    };
    const joinedTwo = await lifecycle.joinRoom(joinTwo);
    assert.equal(joinedTwo.status, "applied");
    if (joinedTwo.status !== "applied") throw new Error("Expected join to apply.");
    assert.equal(joinedTwo.outcome.version, 1);
    assert.equal(joinedTwo.outcome.seatIndex, 1);
    assert.deepEqual(await lifecycle.joinRoom(joinTwo), { status: "duplicate", outcome: joinedTwo.outcome });
    await assert.rejects(
      lifecycle.joinRoom({ ...joinTwo, requestHash: "different-join-request-hash" }),
      RoomCommandIdReusedError,
    );

    await assert.rejects(
      lifecycle.joinRoom({
        ...commandBase("room-1", playerIds[1], 1, "join-player-2-again"),
        inviteCodeHash: "invite-hash-room-1",
      }),
      RoomAlreadyJoinedError,
    );
    await assert.rejects(
      lifecycle.joinRoom({
        ...commandBase("room-1", playerIds[3], 0, "join-stale-version"),
        inviteCodeHash: "invite-hash-room-1",
      }),
      RoomVersionConflictError,
    );

    const joinThree = {
      ...commandBase("room-1", playerIds[2], 1, "join-player-3"),
      inviteCodeHash: "invite-hash-room-1",
    };
    await lifecycle.joinRoom(joinThree);
    const joinFour = {
      ...commandBase("room-1", playerIds[3], 2, "join-player-4"),
      inviteCodeHash: "invite-hash-room-1",
    };
    await lifecycle.joinRoom(joinFour);
    await assert.rejects(
      lifecycle.joinRoom({
        ...commandBase("room-1", playerIds[4], 3, "join-full-room"),
        inviteCodeHash: "invite-hash-room-1",
      }),
      RoomFullError,
    );

    const ready = { ...commandBase("room-1", playerIds[1], 3, "ready-player-2"), ready: true };
    const readyResult = await lifecycle.setReady(ready);
    assert.equal(readyResult.status, "applied");
    if (readyResult.status !== "applied") throw new Error("Expected readiness update to apply.");
    assert.equal(readyResult.outcome.version, 4);
    assert.equal(readyResult.outcome.ready, true);
    assert.deepEqual(await lifecycle.setReady(ready), { status: "duplicate", outcome: readyResult.outcome });

    const noOpReady = {
      ...commandBase("room-1", playerIds[1], 4, "ready-player-2-noop"),
      ready: true,
    };
    const noOp = await lifecycle.setReady(noOpReady);
    assert.equal(noOp.status, "applied");
    if (noOp.status !== "applied") throw new Error("Expected no-op readiness to be recorded.");
    assert.equal(noOp.outcome.changed, false);
    assert.equal(noOp.outcome.version, 4);

    const leaveOwner = commandBase("room-1", playerIds[0], 4, "leave-owner");
    const ownerLeft = await lifecycle.leaveRoom(leaveOwner);
    assert.equal(ownerLeft.status, "applied");
    let room = await storage.getRoom("room-1");
    assert.equal(room?.version, 5);
    assert.equal(room?.ownerPlayerId, playerIds[1]);
    assert.deepEqual(room?.players.map(({ playerId }) => playerId), [playerIds[1], playerIds[2], playerIds[3]]);

    await lifecycle.leaveRoom(commandBase("room-1", playerIds[1], 5, "leave-owner-two"));
    room = await storage.getRoom("room-1");
    assert.equal(room?.ownerPlayerId, playerIds[2]);
    await lifecycle.leaveRoom(commandBase("room-1", playerIds[2], 6, "leave-owner-three"));
    room = await storage.getRoom("room-1");
    assert.equal(room?.ownerPlayerId, playerIds[3]);
    const lastLeave = await lifecycle.leaveRoom(commandBase("room-1", playerIds[3], 7, "leave-last"));
    assert.equal(lastLeave.status, "applied");
    if (lastLeave.status !== "applied") throw new Error("Expected final leave to apply.");
    assert.equal(lastLeave.outcome.roomStatus, "closed");
    assert.equal(lastLeave.outcome.occupancy, 0);
    assert.deepEqual(await lifecycle.previewRoomByInviteHash("invite-hash-room-1"), {
      roomId: "room-1",
      version: 8,
      occupancy: 0,
      status: "closed",
    });
    await assert.rejects(
      lifecycle.joinRoom({
        ...commandBase("room-1", playerIds[4], 8, "join-closed-room"),
        inviteCodeHash: "invite-hash-room-1",
      }),
      RoomClosedError,
    );
    await assert.rejects(
      lifecycle.leaveRoom(commandBase("room-1", playerIds[4], 8, "leave-nonmember")),
      RoomClosedError,
    );
    await assert.rejects(
      lifecycle.leaveRoom(commandBase("room-1", playerIds[4], 7, "leave-stale")),
      RoomVersionConflictError,
    );
    const receipt = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE room_id = 'room-1'",
    );
    assert.equal(receipt.rows[0]?.count, "10");
    const outbox = await database.query<{ aggregate_version: string; payload_json: { roomId: string; version: number }; kind: string }>(
      "SELECT aggregate_version::text, payload_json, kind FROM outbox WHERE aggregate_id = 'room-1' ORDER BY aggregate_version",
    );
    assert.equal(outbox.rows.length, 9);
    assert.equal(outbox.rows.every(({ kind }) => kind === "room:changed"), true);
    assert.deepEqual(
      outbox.rows.map(({ payload_json }) => Object.keys(payload_json).sort()),
      Array.from({ length: 9 }, () => ["roomId", "version"]),
    );
    assert.deepEqual(outbox.rows.map(({ payload_json }) => payload_json.version), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  } finally {
    await database.close();
  }
});

test("persists room status changes and locks lobby membership outside WAITING", async () => {
  const { database, lifecycle } = await createFixture();
  try {
    await lifecycle.createRoom(createInput());
    const starting = await lifecycle.setRoomStatus({
      ...commandBase("room-1", playerIds[0], 0, "room-starting"),
      status: "starting",
    });
    assert.equal(starting.status, "applied");
    if (starting.status !== "applied") throw new Error("Expected status change to apply.");
    assert.equal(starting.outcome.roomStatus, "starting");
    assert.equal(starting.outcome.version, 1);

    await assert.rejects(
      lifecycle.setReady({
        ...commandBase("room-1", playerIds[0], 1, "ready-after-start"),
        ready: true,
      }),
      RoomLockedError,
    );
    const inGame = await lifecycle.setRoomStatus({
      ...commandBase("room-1", playerIds[0], 1, "room-in-game"),
      status: "in_game",
    });
    assert.equal(inGame.status, "applied");
    if (inGame.status !== "applied") throw new Error("Expected in-game status change to apply.");
    assert.equal(inGame.outcome.version, 2);

    await assert.rejects(
      lifecycle.leaveRoom(commandBase("room-1", playerIds[0], 2, "leave-in-game")),
      RoomLockedError,
    );
    await assert.rejects(
      lifecycle.joinRoom({
        ...commandBase("room-1", playerIds[1], 2, "join-in-game"),
        inviteCodeHash: "invite-hash-room-1",
      }),
      RoomLockedError,
    );
    await assert.rejects(
      lifecycle.setRoomStatus({
        ...commandBase("room-1", playerIds[0], 0, "stale-room-status"),
        status: "closed",
      }),
      RoomVersionConflictError,
    );
    const closed = await lifecycle.setRoomStatus({
      ...commandBase("room-1", playerIds[0], 2, "room-closed"),
      status: "closed",
    });
    assert.equal(closed.status, "applied");
    await assert.rejects(
      lifecycle.setRoomStatus({
        ...commandBase("room-1", playerIds[0], 3, "reopen-room"),
        status: "waiting",
      }),
      RoomClosedError,
    );
  } finally {
    await database.close();
  }
});

test("rolls back member, room version, receipt, and outbox when an outbox ID conflicts", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    await lifecycle.createRoom(createInput({ outboxEventId: "shared-outbox-id" }));
    await lifecycle.createRoom(
      createInput({
        id: "room-2",
        inviteCodeHash: "invite-hash-room-2",
        commandId: "command-create-room-2",
        requestHash: "request-create-room-2",
        outboxEventId: "outbox-create-room-2",
      }),
    );

    await assert.rejects(
      lifecycle.createRoom(
        createInput({
          id: "room-3",
          inviteCodeHash: "invite-hash-room-3",
          commandId: "command-create-room-3",
          requestHash: "request-create-room-3",
          outboxEventId: "shared-outbox-id",
        }),
      ),
    );
    assert.equal(await lifecycle.previewRoomByInviteHash("invite-hash-room-3"), null);
    const createReceipt = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [playerIds[0], "command-create-room-3"],
    );
    assert.equal(createReceipt.rows[0]?.count, "0");

    await assert.rejects(
      lifecycle.joinRoom({
        ...commandBase("room-2", playerIds[1], 0, "join-rollback", "request-join-rollback", "shared-outbox-id"),
        inviteCodeHash: "invite-hash-room-2",
      }),
    );

    const room = await storage.getRoom("room-2");
    assert.equal(room?.version, 0);
    assert.deepEqual(room?.players.map(({ playerId }) => playerId), [playerIds[0]]);
    assert.equal(
      await lifecycle.findActiveGuestSessionByTokenHash("token-hash-player-2", fixedNow).then((session) => session?.playerId),
      playerIds[1],
    );
    const receipt = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [playerIds[1], "join-rollback"],
    );
    assert.equal(receipt.rows[0]?.count, "0");
    const outbox = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = 'room-2'",
    );
    assert.equal(outbox.rows[0]?.count, "1");
    const changedSignals = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = 'room-2' AND aggregate_version > 0",
    );
    assert.equal(changedSignals.rows[0]?.count, "0");
  } finally {
    await database.close();
  }
});

test("rejects leave by a non-member without changing the room", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    await lifecycle.createRoom(createInput());
    await assert.rejects(
      lifecycle.leaveRoom(commandBase("room-1", playerIds[1], 0, "leave-nonmember")),
      RoomMembershipRequiredError,
    );
    const room = await storage.getRoom("room-1");
    assert.equal(room?.version, 0);
    assert.deepEqual(room?.players.map(({ playerId }) => playerId), [playerIds[0]]);
  } finally {
    await database.close();
  }
});

test("returns a completed match room to the lobby atomically and replays the original receipt", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const readyVersion = await createReadyRoom(lifecycle);
    const started = await lifecycle.startRoomWithMatch(startInput(readyVersion, { matchId: "match-return-to-lobby" }));
    assert.equal(started.status, "applied");
    if (started.status !== "applied") throw new Error("Expected initial room start to apply.");
    await markMatchCompleted(database, started.outcome.matchId);
    await database.query(
      `INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json)
       VALUES ($1, 1, 'event-preserved-on-return', 1, 'MATCH_FINISHED', $2, '{"preserved":true}'::jsonb)`,
      [started.outcome.matchId, playerIds[0]],
    );
    const completedMatch = await storage.getMatch(started.outcome.matchId);
    const beforeRoom = await storage.getRoom("room-1");
    assert.ok(completedMatch);
    assert.ok(beforeRoom);
    const beforeEvents = await database.query(
      "SELECT event_seq, event_id, version, type, actor_player_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
      [started.outcome.matchId],
    );
    const beforeOutbox = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox");

    const input = {
      ...commandBase("room-1", playerIds[0], started.outcome.version, "return-completed-room"),
      outboxEventId: "outbox-return-completed-room",
    };
    const returned = await lifecycle.returnToLobby(input);
    assert.deepEqual(returned, {
      status: "applied",
      outcome: {
        roomId: "room-1",
        version: started.outcome.version + 1,
        roomStatus: "waiting",
        ownerPlayerId: playerIds[0],
        occupancy: 4,
        changed: true,
      },
    });

    const afterRoom = await storage.getRoom("room-1");
    assert.equal(afterRoom?.status, "waiting");
    assert.equal(afterRoom?.version, started.outcome.version + 1);
    assert.equal(afterRoom?.ownerPlayerId, beforeRoom.ownerPlayerId);
    assert.deepEqual(afterRoom?.players.map(({ playerId, seatIndex }) => ({ playerId, seatIndex })),
      beforeRoom.players.map(({ playerId, seatIndex }) => ({ playerId, seatIndex })));
    assert.deepEqual(afterRoom?.players.map(({ ready }) => ready), [false, false, false, false]);
    assert.equal(await storage.getLatestMatchIdForRoom("room-1"), started.outcome.matchId);
    assert.deepEqual(await storage.getMatch(started.outcome.matchId), completedMatch);
    assert.deepEqual(
      (await database.query(
        "SELECT event_seq, event_id, version, type, actor_player_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
        [started.outcome.matchId],
      )).rows,
      beforeEvents.rows,
    );
    const returnOutbox = await database.query<{
      aggregate_id: string;
      aggregate_version: string;
      event_seq: number;
      kind: string;
      payload_json: Record<string, unknown>;
    }>(
      "SELECT aggregate_id, aggregate_version::text, event_seq, kind, payload_json FROM outbox WHERE event_id = $1",
      [input.outboxEventId],
    );
    assert.deepEqual(returnOutbox.rows, [{
      aggregate_id: "room-1",
      aggregate_version: String(started.outcome.version + 1),
      event_seq: 0,
      kind: "room:changed",
      payload_json: { roomId: "room-1", version: started.outcome.version + 1 },
    }]);
    assert.equal((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM outbox")).rows[0]?.count,
      String(Number(beforeOutbox.rows[0]?.count) + 1));

    const duplicate = await lifecycle.returnToLobby(input);
    assert.deepEqual(duplicate, { status: "duplicate", outcome: returned.outcome });
    assert.deepEqual(await storage.getRoom("room-1"), afterRoom);
    assert.deepEqual(await storage.getMatch(started.outcome.matchId), completedMatch);
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = 'room-1' AND aggregate_version = $1",
      [started.outcome.version + 1],
    )).rows[0]?.count, "1");
    await assert.rejects(
      lifecycle.returnToLobby({ ...input, requestHash: "different-return-request" }),
      RoomCommandIdReusedError,
    );
  } finally {
    await database.close();
  }
});

test("rejects return-to-lobby authorization, stale versions, and incomplete latest matches without writes", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const readyVersion = await createReadyRoom(lifecycle);
    const started = await lifecycle.startRoomWithMatch(startInput(readyVersion, { matchId: "match-return-denials" }));
    assert.equal(started.status, "applied");
    if (started.status !== "applied") throw new Error("Expected initial room start to apply.");
    await markMatchCompleted(database, started.outcome.matchId);

    const beforeRoom = await storage.getRoom("room-1");
    const beforeMatch = await storage.getMatch(started.outcome.matchId);
    const beforeCounts = await database.query<{ receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM command_receipts WHERE room_id = 'room-1')::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
    );
    const attempts = [
      { actorPlayerId: playerIds[4], expectedVersion: started.outcome.version, commandId: "return-non-member", error: RoomMembershipRequiredError },
      { actorPlayerId: playerIds[1], expectedVersion: started.outcome.version, commandId: "return-non-owner", error: RoomOwnerRequiredError },
      { actorPlayerId: playerIds[0], expectedVersion: started.outcome.version - 1, commandId: "return-stale", error: RoomVersionConflictError },
    ] as const;
    for (const attempt of attempts) {
      await assert.rejects(
        lifecycle.returnToLobby({
          ...commandBase("room-1", attempt.actorPlayerId, attempt.expectedVersion, attempt.commandId),
          outboxEventId: `outbox-${attempt.commandId}`,
        }),
        attempt.error,
      );
    }
    assert.deepEqual(await storage.getRoom("room-1"), beforeRoom);
    assert.deepEqual(await storage.getMatch(started.outcome.matchId), beforeMatch);
    const afterDenialCounts = await database.query<{ receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM command_receipts WHERE room_id = 'room-1')::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
    );
    assert.deepEqual(afterDenialCounts.rows, beforeCounts.rows);

    for (const latestStatus of ["playing", "paused", "recovery_required", "none"] as const) {
      const { database: statusDb, lifecycle: statusLifecycle, storage: statusStorage } = await createFixture();
      try {
        let version = await createReadyRoom(statusLifecycle);
        let latestMatchId: string | null = null;
        if (latestStatus === "none") {
          const locked = await statusLifecycle.setRoomStatus({
            ...commandBase("room-1", playerIds[0], version, "set-in-game-for-return-without-match"),
            status: "in_game",
          });
          version = locked.outcome.version;
        } else {
          const match = await statusLifecycle.startRoomWithMatch(startInput(version, { matchId: `match-return-${latestStatus}` }));
          assert.equal(match.status, "applied");
          if (match.status !== "applied") throw new Error("Expected initial room start to apply.");
          latestMatchId = match.outcome.matchId;
          version = match.outcome.version;
          if (latestStatus !== "playing") {
            await statusDb.query(
              `UPDATE matches SET status = $2, state_json = jsonb_set(state_json, '{status}', to_jsonb($2::text)) WHERE id = $1`,
              [latestMatchId, latestStatus],
            );
          }
        }
        const roomBefore = await statusStorage.getRoom("room-1");
        const countsBefore = await statusDb.query<{ receipts: string; outbox: string }>(
          `SELECT
             (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
             (SELECT count(*) FROM outbox WHERE aggregate_id = 'room-1')::text AS outbox`,
          [playerIds[0], `return-denied-${latestStatus}`],
        );
        await assert.rejects(
          statusLifecycle.returnToLobby({
            ...commandBase("room-1", playerIds[0], version, `return-denied-${latestStatus}`),
            outboxEventId: `outbox-return-denied-${latestStatus}`,
          }),
          RoomLockedError,
          latestStatus,
        );
        assert.deepEqual(await statusStorage.getRoom("room-1"), roomBefore, `${latestStatus}: room is unchanged`);
        assert.equal(await statusStorage.getLatestMatchIdForRoom("room-1"), latestMatchId);
        const countsAfter = await statusDb.query<{ receipts: string; outbox: string }>(
          `SELECT
             (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipts,
             (SELECT count(*) FROM outbox WHERE aggregate_id = 'room-1')::text AS outbox`,
          [playerIds[0], `return-denied-${latestStatus}`],
        );
        assert.deepEqual(countsAfter.rows, countsBefore.rows, `${latestStatus}: no receipt or outbox`);
      } finally {
        await statusDb.close();
      }
    }
  } finally {
    await database.close();
  }
});

test("rolls back readiness reset, room version, receipt, and outbox when return-to-lobby outbox insertion fails", async () => {
  const { database, lifecycle, storage } = await createFixture();
  try {
    const readyVersion = await createReadyRoom(lifecycle);
    const started = await lifecycle.startRoomWithMatch(startInput(readyVersion, { matchId: "match-return-outbox-rollback" }));
    assert.equal(started.status, "applied");
    if (started.status !== "applied") throw new Error("Expected initial room start to apply.");
    await markMatchCompleted(database, started.outcome.matchId);
    const beforeRoom = await storage.getRoom("room-1");
    const beforeMatch = await storage.getMatch(started.outcome.matchId);
    const beforeCounts = await database.query<{ receipt: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipt,
         (SELECT count(*) FROM outbox)::text AS outbox`,
      [playerIds[0], "return-outbox-conflict"],
    );
    assert.ok(beforeRoom?.players.every(({ ready }) => ready));

    await assert.rejects(lifecycle.returnToLobby({
      ...commandBase("room-1", playerIds[0], started.outcome.version, "return-outbox-conflict"),
      // The room creation already used this global event ID, forcing the transactional insert to fail.
      outboxEventId: "outbox-create-room-1",
    }));

    assert.deepEqual(await storage.getRoom("room-1"), beforeRoom);
    assert.deepEqual(await storage.getMatch(started.outcome.matchId), beforeMatch);
    const afterCounts = await database.query<{ receipt: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2)::text AS receipt,
         (SELECT count(*) FROM outbox)::text AS outbox`,
      [playerIds[0], "return-outbox-conflict"],
    );
    assert.deepEqual(afterCounts.rows, beforeCounts.rows);
  } finally {
    await database.close();
  }
});
