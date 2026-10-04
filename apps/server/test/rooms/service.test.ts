import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { applyStorageMigrations } from "../../src/storage/migrations.ts";
import {
  RoomAlreadyJoinedError,
  RoomClosedError,
  RoomFullError,
  RoomVersionConflictError,
  RoomLifecycleRepository,
} from "../../src/storage/room-lifecycle.ts";
import { StorageRepository } from "../../src/storage/repository.ts";
import { RoomAuthorizationError, RoomService } from "../../src/rooms/service.ts";
import { createDatabase } from "../storage/pglite-pool.ts";

const fixedNow = new Date("2026-09-27T12:00:00.000Z");
const BASE_DECK_RULESET_VERSION = "base4-ko-online-1.0";
const deterministicRandom = { nextFloat: () => 0.5 };

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return {
    nextFloat(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    },
  };
}

async function createFixture(options: ConstructorParameters<typeof RoomService>[0]["options"] = {}) {
  const { database, pool } = await createDatabase();
  await applyStorageMigrations(pool);
  const storage = new StorageRepository(pool);
  const lifecycle = new RoomLifecycleRepository(pool);
  const service = new RoomService({
    storage,
    lifecycle,
    pool,
    options: { now: () => fixedNow, random: deterministicRandom, ...options },
  });
  return { database, pool, storage, lifecycle, service };
}

async function guest(service: RoomService, displayName: string) {
  const issued = await service.createGuestSession(displayName);
  const authenticated = await service.authenticateGuestCredential(issued.credential);
  assert.ok(authenticated);
  return { issued, authenticated };
}

function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("trims display names and enforces 1–20 Unicode code points without controls", async () => {
  const { database, service } = await createFixture();
  try {
    await assert.rejects(service.createGuestSession(" \t\n "), RangeError);

    const exactly20CodePoints = "😀".repeat(20);
    assert.equal(Array.from(exactly20CodePoints).length, 20);
    assert.equal(exactly20CodePoints.length, 40, "supplementary characters use two UTF-16 code units each");
    const accepted = await service.createGuestSession(` \n${exactly20CodePoints}\t `);
    assert.equal(accepted.response.player.displayName, exactly20CodePoints);

    const exactly21CodePoints = `${exactly20CodePoints}a`;
    assert.equal(Array.from(exactly21CodePoints).length, 21);
    await assert.rejects(service.createGuestSession(exactly21CodePoints), RangeError);

    const controlCodePoints = [
      ...Array.from({ length: 0x20 }, (_, index) => index),
      ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
    ];
    for (const codePoint of controlCodePoints) {
      const control = String.fromCharCode(codePoint);
      await assert.rejects(
        service.createGuestSession(`River${control}Fox`),
        RangeError,
        `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")} must be rejected`,
      );
    }

    const sessions = await database.query<{ count: number | string }>(
      "SELECT count(*)::bigint AS count FROM guest_sessions",
    );
    assert.equal(Number(sessions.rows[0]?.count), 1, "rejected names must not create a session");
  } finally {
    await database.close();
  }
});

test("issues hashed credentials, validates expiry and revocation, and disables expiry by default", async () => {
  const { database, service } = await createFixture();
  try {
    const defaultSession = await service.createGuestSession("  River Fox  ");
    assert.equal(defaultSession.response.player.displayName, "River Fox");
    const duplicateName = await service.createGuestSession("River Fox");
    assert.equal(duplicateName.response.player.displayName, defaultSession.response.player.displayName);
    assert.notEqual(duplicateName.response.player.playerId, defaultSession.response.player.playerId);
    assert.equal("credential" in defaultSession.response, false);
    assert.equal(defaultSession.response.sessionExpiresAt, "9999-12-31T23:59:59.999Z");
    assert.deepEqual(await service.authenticateGuestCredential(defaultSession.credential), {
      playerId: defaultSession.response.player.playerId,
      displayName: "River Fox",
      expiresAt: new Date("9999-12-31T23:59:59.999Z"),
    });

    const expiring = await service.createGuestSession("Expires Soon");
    const ttlDb = await database.query<{ token_hash: string; expires_at: Date }>(
      "SELECT token_hash, expires_at FROM guest_sessions WHERE id = $1",
      [expiring.response.player.playerId],
    );
    assert.equal(ttlDb.rows[0]?.token_hash, hash(expiring.credential));
    assert.equal(ttlDb.rows[0]?.expires_at.toISOString(), "9999-12-31T23:59:59.999Z");
    assert.equal(JSON.stringify(ttlDb.rows).includes(expiring.credential), false);

    await database.query("UPDATE guest_sessions SET expires_at = $2 WHERE id = $1", [
      expiring.response.player.playerId,
      fixedNow,
    ]);
    assert.equal(await service.authenticateGuestCredential(expiring.credential), null);

    const revoked = await service.createGuestSession("Revoked");
    await database.query("UPDATE guest_sessions SET revoked_at = $2 WHERE id = $1", [
      revoked.response.player.playerId,
      fixedNow,
    ]);
    assert.equal(await service.authenticateGuestCredential(revoked.credential), null);
    assert.equal(await service.authenticateGuestCredential("unknown-credential"), null);
  } finally {
    await database.close();
  }
});

test("injects guest TTL and room retention without enabling default cleanup", async () => {
  const { database, service, storage } = await createFixture({ guestSessionTtlMs: 15_000, roomRetentionMs: 60_000 });
  try {
    const { issued } = await guest(service, "Retention Owner");
    assert.equal(issued.response.sessionExpiresAt, "2026-09-27T12:00:15.000Z");

    const created = await service.createPrivateRoom(issued.response.player.playerId, {
      commandId: "create-retention-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    const left = await service.leaveRoom(issued.response.player.playerId, {
      roomId: created.room.roomId,
      expectedVersion: created.version,
      commandId: "leave-retention-owner",
    });
    assert.equal(left.mutation.outcome.roomStatus, "closed");
    assert.equal(left.room, null);
    assert.ok(left.cleanupEligibleAt);
    assert.ok(await storage.getRoom(created.room.roomId), "retention is a deadline; this service does not delete records");
  } finally {
    await database.close();
  }
});

test("creates private rooms with one-time invite secrets and public allowlisted outbox", async () => {
  const { database, service } = await createFixture();
  try {
    const { issued, authenticated } = await guest(service, "Owner");
    await assert.rejects(
      service.createPrivateRoom(authenticated.playerId, {
        commandId: "too-small-capacity",
        capacity: 3,
        rulesetVersion: BASE_DECK_RULESET_VERSION,
      }),
      RangeError,
    );
    await assert.rejects(
      service.createPrivateRoom(authenticated.playerId, {
        commandId: "bad-capacity",
        capacity: 8,
        rulesetVersion: BASE_DECK_RULESET_VERSION,
      }),
      RangeError,
    );
    const created = await service.createPrivateRoom(authenticated.playerId, {
      commandId: "create-room-1",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.ok(created.inviteCode);
    assert.equal(created.duplicate, false);
    assert.equal(created.room.members[0]?.playerId, authenticated.playerId);
    assert.equal(created.room.members[0]?.displayName, "Owner");
    assert.equal(created.room.viewer.isOwner, true);
    assert.equal(created.room.capacity, 4);

    const duplicate = await service.createPrivateRoom(authenticated.playerId, {
      commandId: "create-room-1",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.inviteCode, null, "duplicate retries cannot reveal the raw invite twice");
    assert.equal(duplicate.room.roomId, created.room.roomId);

    const inviteCode = created.inviteCode!;
    const roomDb = await database.query<{ invite_code_hash: string }>(
      "SELECT invite_code_hash FROM rooms WHERE id = $1",
      [created.room.roomId],
    );
    assert.equal(roomDb.rows[0]?.invite_code_hash, hash(inviteCode));
    assert.equal(JSON.stringify(roomDb.rows).includes(inviteCode), false);

    assert.deepEqual(await service.previewInvite(inviteCode), {
      roomId: created.room.roomId,
      version: 0,
      occupancy: 1,
      status: "waiting",
    });
    assert.equal(await service.previewInvite("invalid-invite"), null);

    const outbox = await database.query<{ payload_json: Record<string, unknown> | string }>(
      "SELECT payload_json FROM outbox WHERE aggregate_id = $1 ORDER BY created_at",
      [created.room.roomId],
    );
    const signal = outbox.rows[0]?.payload_json;
    const payload = typeof signal === "string" ? JSON.parse(signal) : signal;
    assert.deepEqual(payload, { roomId: created.room.roomId, version: 0 });
    assert.equal(JSON.stringify(payload).includes(inviteCode), false);
    assert.equal(JSON.stringify(payload).includes(issued.credential), false);
  } finally {
    await database.close();
  }
});

test("joins from preview version, rejects stale/duplicate/full access, and recovers the assigned identity seat", async () => {
  const { database, service, storage } = await createFixture();
  try {
    const players = [];
    for (let index = 0; index < 8; index += 1) players.push(await guest(service, "Same Display Name"));
    const ownerId = players[0]!.authenticated.playerId;
    const created = await service.createPrivateRoom(ownerId, {
      commandId: "create-seven-seat-room",
      capacity: 7,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    const inviteCode = created.inviteCode!;

    for (let index = 1; index < 7; index += 1) {
      const preview = await service.previewInvite(inviteCode);
      assert.ok(preview);
      const joined = await service.joinPrivateRoom(players[index]!.authenticated.playerId, {
        roomId: preview.roomId,
        inviteCode,
        expectedVersion: preview.version,
        commandId: `join-player-${index}`,
      });
      assert.equal(joined.mutation.status, "applied");
      assert.equal(joined.room?.members.length, index + 1);
    }

    const fullPreview = await service.previewInvite(inviteCode);
    assert.ok(fullPreview);
    await assert.rejects(
      service.joinPrivateRoom(players[7]!.authenticated.playerId, {
        roomId: fullPreview.roomId,
        inviteCode,
        expectedVersion: fullPreview.version,
        commandId: "join-eighth-player",
      }),
      RoomFullError,
    );
    await assert.rejects(
      service.joinPrivateRoom(players[1]!.authenticated.playerId, {
        roomId: fullPreview.roomId,
        inviteCode,
        expectedVersion: fullPreview.version,
        commandId: "duplicate-player-entry",
      }),
      RoomAlreadyJoinedError,
    );
    await assert.rejects(
      service.joinPrivateRoom(players[7]!.authenticated.playerId, {
        roomId: fullPreview.roomId,
        inviteCode,
        expectedVersion: fullPreview.version - 1,
        commandId: "stale-join-version",
      }),
      RoomVersionConflictError,
    );

    const room = await storage.getRoom(created.room.roomId);
    assert.equal(room?.players.length, 7);
    assert.deepEqual(room?.players.map(({ seatIndex }) => seatIndex), [0, 1, 2, 3, 4, 5, 6]);
    const ownerRecovery = await service.recoverAssignedSeats(players[0]!.issued.credential);
    const firstJoinerRecovery = await service.recoverAssignedSeats(players[1]!.issued.credential);
    assert.equal(ownerRecovery?.[0]?.members[0]?.seatIndex, 0);
    assert.equal(firstJoinerRecovery?.[0]?.viewer.playerId, players[1]!.authenticated.playerId);
    assert.equal(firstJoinerRecovery?.[0]?.viewer.isOwner, false);
    assert.equal(await service.recoverAssignedSeats("credential-lost"), null);
    const sameDisplayButNoCredential = await service.authenticateGuestCredential("another-credential");
    assert.equal(sameDisplayButNoCredential, null);
  } finally {
    await database.close();
  }
});

test("readiness, owner transfer, voluntary closure and D10 retention preserve the room record", async () => {
  const { database, service, storage } = await createFixture();
  try {
    const owner = await guest(service, "Owner");
    const early = await guest(service, "Early Joiner");
    const late = await guest(service, "Late Joiner");
    const created = await service.createPrivateRoom(owner.authenticated.playerId, {
      commandId: "create-transfer-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    const inviteCode = created.inviteCode!;

    const firstPreview = await service.previewInvite(inviteCode);
    assert.ok(firstPreview);
    const firstJoin = await service.joinPrivateRoom(early.authenticated.playerId, {
      roomId: firstPreview.roomId,
      inviteCode,
      expectedVersion: firstPreview.version,
      commandId: "join-early",
    });
    const secondPreview = await service.previewInvite(inviteCode);
    assert.ok(secondPreview);
    const secondJoin = await service.joinPrivateRoom(late.authenticated.playerId, {
      roomId: secondPreview.roomId,
      inviteCode,
      expectedVersion: secondPreview.version,
      commandId: "join-late",
    });

    const ready = await service.setReady(early.authenticated.playerId, {
      roomId: created.room.roomId,
      expectedVersion: secondJoin.mutation.outcome.version,
      commandId: "ready-early",
      ready: true,
    });
    assert.equal(ready.room?.members.find(({ playerId }) => playerId === early.authenticated.playerId)?.ready, true);
    await assert.rejects(
      service.closeRoom(late.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: ready.mutation.outcome.version,
        commandId: "non-owner-close",
      }),
      RoomAuthorizationError,
    );

    const ownerLeave = await service.leaveRoom(owner.authenticated.playerId, {
      roomId: created.room.roomId,
      expectedVersion: ready.mutation.outcome.version,
      commandId: "owner-voluntary-leave",
    });
    assert.equal(ownerLeave.mutation.outcome.ownerPlayerId, early.authenticated.playerId);
    assert.equal(ownerLeave.room, null);
    const transferred = await storage.getRoom(created.room.roomId);
    assert.equal(transferred?.ownerPlayerId, early.authenticated.playerId);
    assert.deepEqual(transferred?.players.map(({ playerId }) => playerId), [early.authenticated.playerId, late.authenticated.playerId]);

    const lateLeave = await service.leaveRoom(late.authenticated.playerId, {
      roomId: created.room.roomId,
      expectedVersion: ownerLeave.mutation.outcome.version,
      commandId: "late-voluntary-leave",
    });
    assert.equal(lateLeave.mutation.outcome.roomStatus, "waiting");
    const finalLeave = await service.leaveRoom(early.authenticated.playerId, {
      roomId: created.room.roomId,
      expectedVersion: lateLeave.mutation.outcome.version,
      commandId: "last-voluntary-leave",
    });
    assert.equal(finalLeave.mutation.outcome.roomStatus, "closed");
    assert.equal(finalLeave.cleanupEligibleAt, null, "no retention configuration means no automatic deletion");
    assert.ok(await storage.getRoom(created.room.roomId));
    assert.equal((await service.previewInvite(inviteCode))?.status, "closed");

    await assert.rejects(
      service.joinPrivateRoom(late.authenticated.playerId, {
        roomId: created.room.roomId,
        inviteCode,
        expectedVersion: finalLeave.mutation.outcome.version,
        commandId: "join-closed-room",
      }),
      RoomClosedError,
    );
  } finally {
    await database.close();
  }
});

test("only the owner can voluntarily close a room through the service", async () => {
  const { database, service } = await createFixture();
  try {
    const owner = await guest(service, "Owner");
    const visitor = await guest(service, "Visitor");
    const created = await service.createPrivateRoom(owner.authenticated.playerId, {
      commandId: "create-close-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    const preview = await service.previewInvite(created.inviteCode!);
    assert.ok(preview);
    await service.joinPrivateRoom(visitor.authenticated.playerId, {
      roomId: preview.roomId,
      inviteCode: created.inviteCode!,
      expectedVersion: preview.version,
      commandId: "join-close-room",
    });
    const closed = await service.closeRoom(owner.authenticated.playerId, {
      roomId: created.room.roomId,
      expectedVersion: 1,
      commandId: "owner-close-room",
    });
    assert.equal(closed.mutation.outcome.roomStatus, "closed");
    assert.equal(closed.room?.status, "closed");
    assert.equal(closed.cleanupEligibleAt, null);
    const duplicateClose = await service.closeRoom(owner.authenticated.playerId, {
      roomId: created.room.roomId,
      expectedVersion: 1,
      commandId: "owner-close-room",
    });
    assert.equal(duplicateClose.mutation.status, "duplicate");
  } finally {
    await database.close();
  }
});

test("the service does not close a room after its lobby is locked", async () => {
  const { database, service, lifecycle } = await createFixture();
  try {
    const owner = await guest(service, "Owner");
    const created = await service.createPrivateRoom(owner.authenticated.playerId, {
      commandId: "create-locked-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    await lifecycle.setRoomStatus({
      roomId: created.room.roomId,
      actorPlayerId: owner.authenticated.playerId,
      expectedVersion: created.version,
      commandId: "start-locked-room",
      requestHash: "start-locked-room-hash",
      outboxEventId: "start-locked-room-event",
      status: "in_game",
    });
    await assert.rejects(
      service.closeRoom(owner.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: 1,
        commandId: "close-after-start",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROOM_LOCKED",
    );
  } finally {
    await database.close();
  }
});

test("starts an all-ready room once, returns the same match on retry, and projects its route", async () => {
  const { database, service, storage } = await createFixture();
  try {
    const players = [];
    for (let index = 0; index < 5; index += 1) players.push(await guest(service, `Start Player ${index}`));
    const ownerId = players[0]!.authenticated.playerId;
    const created = await service.createPrivateRoom(ownerId, {
      commandId: "create-start-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.ok(created.room);
    let roomVersion = created.version;

    for (let index = 1; index < 4; index += 1) {
      const joined = await service.joinPrivateRoom(players[index]!.authenticated.playerId, {
        roomId: created.room.roomId,
        inviteCode: created.inviteCode!,
        expectedVersion: roomVersion,
        commandId: `join-start-player-${index}`,
      });
      roomVersion = joined.mutation.outcome.version;
    }

    const rejectedCommandIds = [
      "start-not-ready",
      "start-not-owner",
      "start-not-member",
      "start-stale-version",
    ];
    await assert.rejects(
      service.startMatch(ownerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: rejectedCommandIds[0]!,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROOM_NOT_READY",
    );
    await assert.rejects(
      service.startMatch(players[1]!.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: rejectedCommandIds[1]!,
      }),
      RoomAuthorizationError,
    );
    await assert.rejects(
      service.startMatch(players[4]!.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: rejectedCommandIds[2]!,
      }),
      RoomAuthorizationError,
    );
    await assert.rejects(
      service.startMatch(ownerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion - 1,
        commandId: rejectedCommandIds[3]!,
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "STALE_VERSION",
    );

    const invalidReceipts = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE command_id = ANY($1::text[])",
      [rejectedCommandIds],
    );
    assert.equal(invalidReceipts.rows[0]?.count, "0");
    const noMatches = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM matches");
    assert.equal(noMatches.rows[0]?.count, "0");

    for (let index = 0; index < 4; index += 1) {
      const result = await service.setReady(players[index]!.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: `ready-start-player-${index}`,
        ready: true,
      });
      roomVersion = result.mutation.outcome.version;
    }

    const startInput = {
      roomId: created.room.roomId,
      expectedVersion: roomVersion,
      commandId: "start-all-ready-room",
    };
    const started = await service.startMatch(ownerId, startInput);
    assert.equal(started.mutation.status, "applied");
    assert.equal(started.room?.status, "in_game");
    assert.equal(started.room?.activeMatchId, started.matchId);
    assert.equal(await storage.getLatestMatchIdForRoom(created.room.roomId), started.matchId);

    const match = await storage.getMatch(started.matchId);
    assert.ok(match);
    assert.equal(match.roomId, created.room.roomId);
    assert.equal(match.status, "playing");
    assert.equal(match.state.turn.phase, "play", "the first turn's initial T67 draw is already stored");
    assert.equal(match.state.turn.currentPlayerId, match.state.seats[0]?.public.playerId);
    const sheriff = match.state.seats[0]!;
    assert.equal(sheriff.public.roleRevealed, true);
    assert.equal(sheriff.private.handCardInstanceIds.length, sheriff.public.maxHp + 2);
    assert.equal(match.players.length, 4);
    assert.deepEqual(
      [...match.players.map(({ playerId }) => playerId)].sort(),
      players.slice(0, 4).map(({ authenticated }) => authenticated.playerId).sort(),
    );

    const duplicate = await service.startMatch(ownerId, startInput);
    assert.equal(duplicate.mutation.status, "duplicate");
    assert.equal(duplicate.matchId, started.matchId);
    assert.equal(duplicate.room?.activeMatchId, started.matchId);
    await assert.rejects(
      service.startMatch(ownerId, { ...startInput, expectedVersion: startInput.expectedVersion - 1 }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "COMMAND_ID_REUSED",
    );
    const persistedMatchCount = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM matches");
    assert.equal(persistedMatchCount.rows[0]?.count, "1");
    const receiptCount = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [ownerId, startInput.commandId],
    );
    assert.equal(receiptCount.rows[0]?.count, "1");
    const matchOutboxCount = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = $1 AND kind = 'match:changed'",
      [started.matchId],
    );
    assert.equal(matchOutboxCount.rows[0]?.count, "1");
  } finally {
    await database.close();
  }
});

test("restarts a completed match with a fresh seeded setup and preserves the prior record", async () => {
  const { database, service, storage } = await createFixture({ random: seededRandom(0x91c0ffee) });
  try {
    const players = [];
    for (let index = 0; index < 4; index += 1) players.push(await guest(service, `Restart Player ${index}`));
    const ownerId = players[0]!.authenticated.playerId;
    const created = await service.createPrivateRoom(ownerId, {
      commandId: "create-direct-restart-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.ok(created.room);
    let roomVersion = created.version;
    for (let index = 1; index < 4; index += 1) {
      const joined = await service.joinPrivateRoom(players[index]!.authenticated.playerId, {
        roomId: created.room.roomId,
        inviteCode: created.inviteCode!,
        expectedVersion: roomVersion,
        commandId: `join-direct-restart-player-${index}`,
      });
      roomVersion = joined.mutation.outcome.version;
    }
    for (let index = 0; index < 4; index += 1) {
      const ready = await service.setReady(players[index]!.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: `ready-direct-restart-player-${index}`,
        ready: true,
      });
      roomVersion = ready.mutation.outcome.version;
    }

    const first = await service.startMatch(ownerId, {
      roomId: created.room.roomId,
      expectedVersion: roomVersion,
      commandId: "start-before-direct-restart",
    });
    const firstMatch = await storage.getMatch(first.matchId);
    assert.ok(firstMatch);
    await database.query(
      `UPDATE matches
       SET status = 'completed', state_json = jsonb_set(state_json, '{status}', '"completed"'::jsonb), ended_at = now()
       WHERE id = $1`,
      [first.matchId],
    );
    await database.query(
      `INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json)
       VALUES ($1, $3, 'event-preserved-before-restart', 1, 'MATCH_FINISHED', $2, '{"preserved":true}'::jsonb)`,
      [first.matchId, ownerId, firstMatch.eventSeq + 1],
    );
    const completedBeforeRestart = await storage.getMatch(first.matchId);
    assert.ok(completedBeforeRestart);
    assert.equal(completedBeforeRestart.status, "completed");
    const eventsBeforeRestart = await database.query(
      "SELECT event_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
      [first.matchId],
    );

    const restartCommand = {
      roomId: created.room.roomId,
      expectedVersion: first.mutation.outcome.version,
      commandId: "start-after-direct-restart",
    };
    const restarted = await service.startMatch(ownerId, restartCommand);
    assert.equal(restarted.mutation.status, "applied");
    assert.notEqual(restarted.matchId, first.matchId);
    assert.equal(restarted.mutation.outcome.version, first.mutation.outcome.version + 1);
    assert.equal(restarted.room?.status, "in_game");
    assert.equal(restarted.room?.activeMatchId, restarted.matchId);

    const newMatch = await storage.getMatch(restarted.matchId);
    assert.ok(newMatch);
    assert.equal(newMatch.status, "playing");
    assert.deepEqual(
      newMatch.players.map(({ playerId }) => playerId).sort(),
      completedBeforeRestart.players.map(({ playerId }) => playerId).sort(),
      "the direct restart must preserve the room roster",
    );
    const priorCardIds = new Set(Object.keys(completedBeforeRestart.state.zones.cardsByInstanceId));
    const newCardIds = Object.keys(newMatch.state.zones.cardsByInstanceId);
    assert.equal(newCardIds.length, 80);
    assert.equal(newCardIds.some((cardId) => priorCardIds.has(cardId)), false, "new match card identities are independent");
    assert.notDeepEqual(newMatch.state.zones.drawPileCardInstanceIds, completedBeforeRestart.state.zones.drawPileCardInstanceIds);
    const previousRoles = new Map(completedBeforeRestart.state.seats.map((seat) => [seat.public.playerId, seat.private.roleId]));
    assert.notDeepEqual(
      newMatch.state.seats.map((seat) => [seat.public.playerId, seat.private.roleId]).sort(),
      [...previousRoles.entries()].sort(),
      "the injected deterministic RNG produces a fresh role assignment",
    );
    assert.deepEqual(await storage.getMatch(first.matchId), completedBeforeRestart);
    const previousEvents = await database.query<{ event_id: string; payload_json: Record<string, unknown> }>(
      "SELECT event_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
      [first.matchId],
    );
    assert.deepEqual(previousEvents.rows, eventsBeforeRestart.rows);
    assert.deepEqual(previousEvents.rows.at(-1),
      { event_id: "event-preserved-before-restart", payload_json: { preserved: true } });

    const beforeRetry = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = $1)::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = $1)::text AS players,
         (SELECT count(*) FROM command_receipts WHERE room_id = $1)::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
      [created.room.roomId],
    );
    const duplicate = await service.startMatch(ownerId, restartCommand);
    assert.equal(duplicate.mutation.status, "duplicate");
    assert.equal(duplicate.matchId, restarted.matchId);
    const afterRetry = await database.query<{ matches: string; players: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = $1)::text AS matches,
         (SELECT count(*) FROM match_players mp JOIN matches m ON m.id = mp.match_id WHERE m.room_id = $1)::text AS players,
         (SELECT count(*) FROM command_receipts WHERE room_id = $1)::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
      [created.room.roomId],
    );
    assert.deepEqual(afterRetry.rows[0], beforeRetry.rows[0]);

    const beforeLockedRetry = await database.query<{ matches: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = $1)::text AS matches,
         (SELECT count(*) FROM command_receipts WHERE room_id = $1)::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
      [created.room.roomId],
    );
    await assert.rejects(
      service.startMatch(ownerId, {
        roomId: created.room.roomId,
        expectedVersion: restarted.mutation.outcome.version,
        commandId: "reject-restart-while-playing",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROOM_LOCKED",
    );
    const afterLockedRetry = await database.query<{ matches: string; receipts: string; outbox: string }>(
      `SELECT
         (SELECT count(*) FROM matches WHERE room_id = $1)::text AS matches,
         (SELECT count(*) FROM command_receipts WHERE room_id = $1)::text AS receipts,
         (SELECT count(*) FROM outbox)::text AS outbox`,
      [created.room.roomId],
    );
    assert.deepEqual(afterLockedRetry.rows[0], beforeLockedRetry.rows[0]);
  } finally {
    await database.close();
  }
});

test("requires at least four ready members and starts a seven-member room", async () => {
  const { database, service, storage } = await createFixture();
  try {
    const players = [];
    for (let index = 0; index < 7; index += 1) players.push(await guest(service, `Boundary Player ${index}`));
    const ownerId = players[0]!.authenticated.playerId;
    const undersized = await service.createPrivateRoom(ownerId, {
      commandId: "create-undersized-start-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.ok(undersized.room);
    let undersizedVersion = undersized.version;
    for (let index = 1; index < 3; index += 1) {
      const joined = await service.joinPrivateRoom(players[index]!.authenticated.playerId, {
        roomId: undersized.room.roomId,
        inviteCode: undersized.inviteCode!,
        expectedVersion: undersizedVersion,
        commandId: `join-undersized-player-${index}`,
      });
      undersizedVersion = joined.mutation.outcome.version;
    }
    for (let index = 0; index < 3; index += 1) {
      const ready = await service.setReady(players[index]!.authenticated.playerId, {
        roomId: undersized.room.roomId,
        expectedVersion: undersizedVersion,
        commandId: `ready-undersized-player-${index}`,
        ready: true,
      });
      undersizedVersion = ready.mutation.outcome.version;
    }
    await assert.rejects(
      service.startMatch(ownerId, {
        roomId: undersized.room.roomId,
        expectedVersion: undersizedVersion,
        commandId: "start-three-ready-members",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROOM_NOT_READY",
    );
    const undersizedReceipt = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE command_id = $1",
      ["start-three-ready-members"],
    );
    assert.equal(undersizedReceipt.rows[0]?.count, "0");
    assert.equal(await storage.getLatestMatchIdForRoom(undersized.room.roomId), null);

    const maximum = await service.createPrivateRoom(ownerId, {
      commandId: "create-seven-member-start-room",
      capacity: 7,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.ok(maximum.room);
    let maximumVersion = maximum.version;
    for (let index = 1; index < 7; index += 1) {
      const joined = await service.joinPrivateRoom(players[index]!.authenticated.playerId, {
        roomId: maximum.room.roomId,
        inviteCode: maximum.inviteCode!,
        expectedVersion: maximumVersion,
        commandId: `join-seven-player-${index}`,
      });
      maximumVersion = joined.mutation.outcome.version;
    }
    for (let index = 0; index < 7; index += 1) {
      const ready = await service.setReady(players[index]!.authenticated.playerId, {
        roomId: maximum.room.roomId,
        expectedVersion: maximumVersion,
        commandId: `ready-seven-player-${index}`,
        ready: true,
      });
      maximumVersion = ready.mutation.outcome.version;
    }

    const started = await service.startMatch(ownerId, {
      roomId: maximum.room.roomId,
      expectedVersion: maximumVersion,
      commandId: "start-seven-ready-members",
    });
    assert.equal(started.mutation.status, "applied");
    assert.equal(started.room?.activeMatchId, started.matchId);
    assert.equal((await storage.getMatch(started.matchId))?.players.length, 7);
  } finally {
    await database.close();
  }
});

test("returns a completed room to the same lobby and requires readiness before starting again", async () => {
  const { database, service, storage } = await createFixture({ random: seededRandom(0x92a110bb) });
  try {
    const players = [];
    for (let index = 0; index < 5; index += 1) players.push(await guest(service, `Return Player ${index}`));
    const ownerId = players[0]!.authenticated.playerId;
    const created = await service.createPrivateRoom(ownerId, {
      commandId: "create-return-to-lobby-room",
      capacity: 4,
      rulesetVersion: BASE_DECK_RULESET_VERSION,
    });
    assert.ok(created.room);
    let roomVersion = created.version;
    const roster = [ownerId];
    for (let index = 1; index < 4; index += 1) {
      const playerId = players[index]!.authenticated.playerId;
      roster.push(playerId);
      const joined = await service.joinPrivateRoom(playerId, {
        roomId: created.room.roomId,
        inviteCode: created.inviteCode!,
        expectedVersion: roomVersion,
        commandId: `join-return-player-${index}`,
      });
      roomVersion = joined.mutation.outcome.version;
    }
    for (let index = 0; index < 4; index += 1) {
      const ready = await service.setReady(players[index]!.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: `ready-return-player-${index}`,
        ready: true,
      });
      roomVersion = ready.mutation.outcome.version;
    }
    const started = await service.startMatch(ownerId, {
      roomId: created.room.roomId,
      expectedVersion: roomVersion,
      commandId: "start-before-return-to-lobby",
    });
    const completedBeforeReturn = await storage.getMatch(started.matchId);
    assert.ok(completedBeforeReturn);
    await database.query(
      `UPDATE matches
       SET status = 'completed', state_json = jsonb_set(state_json, '{status}', '"completed"'::jsonb), ended_at = now()
       WHERE id = $1`,
      [started.matchId],
    );
    await database.query(
      `INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json)
       VALUES ($1, $3, 'service-return-preserved-event', 1, 'MATCH_FINISHED', $2, '{"preserved":true}'::jsonb)`,
      [started.matchId, ownerId, completedBeforeReturn.eventSeq + 1],
    );
    const completedMatch = await storage.getMatch(started.matchId);
    const priorEvents = await database.query(
      "SELECT event_seq, event_id, version, type, actor_player_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
      [started.matchId],
    );
    assert.ok(completedMatch);
    assert.equal(completedMatch.status, "completed");

    const input = {
      roomId: created.room.roomId,
      expectedVersion: started.mutation.outcome.version,
      commandId: "return-completed-match-to-lobby",
    };
    await assert.rejects(
      service.returnToLobby(players[1]!.authenticated.playerId, {
        ...input,
        commandId: "return-by-non-owner",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "NOT_ROOM_OWNER",
    );
    await assert.rejects(
      service.returnToLobby(players[4]!.authenticated.playerId, {
        ...input,
        commandId: "return-by-non-member",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "NOT_A_MEMBER",
    );

    const returned = await service.returnToLobby(ownerId, input);
    assert.equal(returned.mutation.status, "applied");
    assert.equal(returned.mutation.outcome.version, started.mutation.outcome.version + 1);
    assert.equal(returned.mutation.outcome.roomStatus, "waiting");
    assert.equal(returned.room?.roomId, created.room.roomId);
    assert.equal(returned.room?.status, "waiting");
    assert.equal(returned.room?.activeMatchId, null);
    assert.equal(returned.room?.ownerPlayerId, ownerId);
    assert.deepEqual(returned.room?.members.map(({ playerId, seatIndex, ready }) => ({ playerId, seatIndex, ready })),
      roster.map((playerId, seatIndex) => ({ playerId, seatIndex, ready: false })));
    assert.deepEqual(await storage.getMatch(started.matchId), completedMatch);
    assert.deepEqual(
      (await database.query(
        "SELECT event_seq, event_id, version, type, actor_player_id, payload_json FROM match_events WHERE match_id = $1 ORDER BY event_seq",
        [started.matchId],
      )).rows,
      priorEvents.rows,
    );

    const duplicate = await service.returnToLobby(ownerId, input);
    assert.equal(duplicate.mutation.status, "duplicate");
    assert.deepEqual(duplicate.mutation.outcome, returned.mutation.outcome);
    assert.equal(duplicate.room?.activeMatchId, null);
    const matchCountBeforeReady = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM matches WHERE room_id = $1",
      [created.room.roomId],
    );
    await assert.rejects(
      service.startMatch(ownerId, {
        roomId: created.room.roomId,
        expectedVersion: returned.mutation.outcome.version,
        commandId: "start-after-return-before-ready",
      }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "ROOM_NOT_READY",
    );
    assert.equal((await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM matches WHERE room_id = $1",
      [created.room.roomId],
    )).rows[0]?.count, matchCountBeforeReady.rows[0]?.count);

    roomVersion = returned.mutation.outcome.version;
    for (let index = 0; index < 4; index += 1) {
      const ready = await service.setReady(players[index]!.authenticated.playerId, {
        roomId: created.room.roomId,
        expectedVersion: roomVersion,
        commandId: `ready-again-return-player-${index}`,
        ready: true,
      });
      roomVersion = ready.mutation.outcome.version;
    }
    const startedAgain = await service.startMatch(ownerId, {
      roomId: created.room.roomId,
      expectedVersion: roomVersion,
      commandId: "start-after-return-and-reready",
    });
    assert.equal(startedAgain.mutation.status, "applied");
    assert.notEqual(startedAgain.matchId, started.matchId);
    assert.equal(startedAgain.room?.status, "in_game");
    assert.equal(startedAgain.room?.activeMatchId, startedAgain.matchId);
    assert.deepEqual((await storage.getRoom(created.room.roomId))?.players.map(({ playerId, seatIndex }) => ({ playerId, seatIndex })),
      completedBeforeReturn.players.map(({ playerId, seatIndex }) => ({ playerId, seatIndex })));
  } finally {
    await database.close();
  }
});
