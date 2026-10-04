import assert from "node:assert/strict";
import { test } from "node:test";
import type { MatchSyncReply, MatchSyncRequest } from "../../../../packages/contracts/src/protocol.ts";
import { BASE_DECK_RULESET_VERSION } from "../../../../packages/catalog/src/cards/index.ts";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.ts";
import type { GameState, PendingDeath, PendingInteraction, ResolutionFrame } from "../../../../packages/engine/src/state/types.ts";
import { processMatchCommand } from "../../src/commands/index.ts";
import { createSyncProjectionHandlers } from "../../src/projections/sync.ts";
import { projectOutboxNotification } from "../../src/projections/outbox.ts";
import { RecoveryService } from "../../src/recovery/index.ts";
import { RoomService } from "../../src/rooms/service.ts";
import { applyStorageMigrations } from "../../src/storage/migrations.ts";
import { RoomLifecycleRepository } from "../../src/storage/room-lifecycle.ts";
import { StorageRepository } from "../../src/storage/repository.ts";
import type { PgPoolLike } from "../../src/storage/database.ts";
import { createDatabase } from "../storage/pglite-pool.ts";

const FIXED_DATE = new Date("2026-09-28T00:00:00.000Z");
const MATCH_IDS = ["match-duel", "match-death", "match-discards", "match-multi", "match-receipt"] as const;

interface SessionFixture {
  playerId: string;
  credential: string;
  displayName: string;
}

function initialState(players: readonly SessionFixture[]): GameState {
  const state = initializeGame({
    players: players.slice(0, 4).map(({ playerId, displayName }) => ({ playerId, displayName })),
    random: { nextFloat: () => 0.25 },
  });
  state.turn.phase = "play";
  return state;
}

function pendingState(
  players: readonly SessionFixture[],
  matchKind: "duel" | "death" | "discards" | "multi",
): GameState {
  const state = initialState(players);
  const sourcePlayerId = players[0]!.playerId;
  const targetPlayerId = players[1]!.playerId;
  const frameId = `resume-${matchKind}`;
  const effectId = `effect-${matchKind}`;
  const kind = {
    duel: "DUEL_RESPONSE",
    death: "DEATH_RESCUE",
    discards: "DISCARDS_ORDER",
    multi: "GATLING_RESPONSE",
  }[matchKind];
  const frame: ResolutionFrame = {
    frameId,
    kind: `RESUME_${kind}`,
    sourcePlayerId,
    sourceCardInstanceId: null,
    payload: { cursor: 1, continuationSecret: `private-${matchKind}-continuation` },
  };
  const interaction: PendingInteraction = {
    interactionId: `interaction-${matchKind}`,
    kind,
    actorPlayerIds: [targetPlayerId],
    options: [{ choice: { duel: "YIELD", death: "ACCEPT_ELIMINATION", discards: "ORDER_CARDS", multi: "TAKE_HIT" }[matchKind], payload: {} }],
    context: {
      cursor: 1, marker: `private-${matchKind}-context`,
      ...(matchKind === "discards" ? { discardOrder: {
        allowedCardInstanceIds: [...state.seats.find((seat) => seat.public.playerId === targetPlayerId)!.private.handCardInstanceIds],
        requiredCount: 1,
      } } : {}),
    },
    resumeFrameId: frameId,
    createdAt: FIXED_DATE.toISOString(),
  };
  const effectQueue = matchKind === "multi"
    ? [targetPlayerId, players[2]!.playerId].map((target, index) => ({
      effectId: `${effectId}-${index}`,
      kind: "GATLING_TARGET",
      sourcePlayerId,
      targetPlayerId: target,
      sourceCardInstanceId: null,
      payload: { targetIndex: index, internalMarker: `private-multi-step-${index}` },
    }))
    : [{
      effectId,
      kind: kind,
      sourcePlayerId,
      targetPlayerId,
      sourceCardInstanceId: null,
      payload: { cursor: 1, internalMarker: `private-${matchKind}-step` },
    }];

  let pendingDeath: PendingDeath | null = null;
  if (matchKind === "death") {
    const victim = state.seats.find(({ public: player }) => player.playerId === targetPlayerId)!;
    victim.public.hp = 0;
    pendingDeath = {
      victimPlayerId: targetPlayerId,
      sourcePlayerId,
      rescueResponderIds: [targetPlayerId],
      rescueCursor: 0,
      consequenceStage: "rescue",
      resumeFrameId: frameId,
    };
  }

  state.resolution = {
    effectQueue,
    continuations: [frame],
    pendingInteraction: interaction,
    pendingDeath,
    victoryCheckDeferredByEffectId: matchKind === "multi" ? effectId : null,
  };
  state.version = 4;
  state.eventSeq = 2;
  return state;
}

function stateWithUnsupportedSchema(players: readonly SessionFixture[]): GameState {
  const state = pendingState(players, "duel");
  state.schemaVersion = 77;
  return state;
}

function createRoomService(pool: PgPoolLike) {
  const storage = new StorageRepository(pool);
  const lifecycle = new RoomLifecycleRepository(pool);
  return new RoomService({ storage, lifecycle, pool, options: { now: () => FIXED_DATE } });
}

async function createSessions(service: RoomService): Promise<SessionFixture[]> {
  const sessions: SessionFixture[] = [];
  for (const displayName of ["One", "Two", "Three", "Four", "Outsider"]) {
    const issue = await service.createGuestSession(displayName);
    sessions.push({
      playerId: issue.response.player.playerId,
      credential: issue.credential,
      displayName,
    });
  }
  return sessions;
}

async function createInGameRoom(
  database: Awaited<ReturnType<typeof createDatabase>>["database"],
  storage: StorageRepository,
  roomId: string,
  players: readonly SessionFixture[],
): Promise<void> {
  await storage.createRoom({
    id: roomId,
    ownerPlayerId: players[0]!.playerId,
    inviteCodeHash: `invite-hash-${roomId}`,
    capacity: 4,
    players: players.slice(0, 4).map(({ playerId }, seatIndex) => ({ playerId, seatIndex, ready: true })),
  });
  await database.query("UPDATE rooms SET status = 'in_game' WHERE id = $1", [roomId]);
}

function matchCommand(matchId: string) {
  return {
    protocolVersion: 1 as const,
    commandId: "00000000-0000-4000-8000-000000000052",
    expectedVersion: 0,
    matchId,
    type: "END_TURN" as const,
    payload: {},
  };
}

function createMatchMembership(storage: StorageRepository, playerId: string) {
  return {
    playerId,
    roomMembership: async () => null,
    matchMembership: async (matchId: string) => {
      const match = await storage.getMatch(matchId);
      return match?.players.some((player) => player.playerId === playerId) ?? false;
    },
  };
}

async function matchSync(
  handlers: ReturnType<typeof createSyncProjectionHandlers>,
  context: ReturnType<typeof createMatchMembership>,
  request: MatchSyncRequest,
): Promise<MatchSyncReply> {
  let response: unknown;
  await handlers.matchSync(context, request, (value) => { response = value; });
  assert.ok(response);
  return response as MatchSyncReply;
}

test("restart recovery restores pending cursors, same credential seat, private sync, public history, and one command receipt", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const beforeRestartStorage = new StorageRepository(pool);
    const beforeRestartRooms = createRoomService(pool);
    const sessions = await createSessions(beforeRestartRooms);
    const players = sessions.slice(0, 4);
    const expectedStates = new Map<string, GameState>();

    const stateFactories: readonly [string, GameState][] = [
      ["duel", pendingState(players, "duel")],
      ["death", pendingState(players, "death")],
      ["discards", pendingState(players, "discards")],
      ["multi", pendingState(players, "multi")],
    ];
    for (const [index, [label, state]] of stateFactories.entries()) {
      const roomId = `room-${label}`;
      const matchId = MATCH_IDS[index]!;
      await createInGameRoom(database, beforeRestartStorage, roomId, sessions);
      await beforeRestartStorage.createMatch({ id: matchId, roomId, state });
      expectedStates.set(matchId, structuredClone(state));
    }

    const receiptRoomId = "room-receipt";
    await createInGameRoom(database, beforeRestartStorage, receiptRoomId, sessions);
    const receiptState = initialState(players);
    await beforeRestartStorage.createMatch({ id: MATCH_IDS[4], roomId: receiptRoomId, state: receiptState });
    const receiptActorPlayerId = receiptState.turn.currentPlayerId;

    await database.query(
      `INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json, created_at)
       VALUES
         ($1, 1, 'event-hidden-draw', 3, 'CARD_DRAWN', $2, $3::jsonb, $4),
         ($1, 2, 'event-visible-attack', 4, 'BANG_ATTACKED', $5, $6::jsonb, $4)`,
      [
        MATCH_IDS[0],
        players[2]!.playerId,
        JSON.stringify({ playerId: players[2]!.playerId, cardInstanceId: "hidden-event-card" }),
        FIXED_DATE,
        players[0]!.playerId,
        JSON.stringify({ targetPlayerId: players[1]!.playerId, handCardInstanceIds: ["hidden-public-payload"] }),
      ],
    );

    let prepareCount = 0;
    const firstRelayDependencies = {
      storage: beforeRestartStorage,
      prepareEngineContext: () => {
        prepareCount += 1;
        return { random: { nextFloat: () => 0.5 } };
      },
      newEventId: (() => {
        let id = 0;
        return () => `receipt-event-${++id}`;
      })(),
    };
    const command = matchCommand(MATCH_IDS[4]);
    const firstAck = await processMatchCommand(
      createMatchMembership(beforeRestartStorage, receiptActorPlayerId),
      command,
      firstRelayDependencies,
    );
    assert.ok(firstAck && firstAck.status === "accepted", JSON.stringify(firstAck));
    assert.equal(prepareCount, 1);

    // A new service/repository instance models the app process coming back on the same DB.
    const afterRestartStorage = new StorageRepository(pool);
    const afterRestartRooms = createRoomService(pool);
    const recovery = new RecoveryService({ pool, rooms: afterRestartRooms, newOutboxEventId: () => "recovery-outbox" });
    const report = await recovery.recoverPersistedMatches();
    assert.deepEqual(report, MATCH_IDS.map((matchId) => ({ matchId, status: "resumable" }))
      .sort((left, right) => left.matchId.localeCompare(right.matchId)));

    for (const matchId of MATCH_IDS.slice(0, 4)) {
      const restored = await afterRestartStorage.getMatch(matchId);
      assert.ok(restored);
      assert.deepEqual(restored.state, expectedStates.get(matchId));
    }

    const [firstConnectionRooms, secondConnectionRooms] = await Promise.all([
      recovery.recoverAssignedSeats(sessions[1]!.credential),
      recovery.recoverAssignedSeats(sessions[1]!.credential),
    ]);
    assert.ok(firstConnectionRooms);
    assert.ok(secondConnectionRooms);
    for (const roomId of ["room-duel", "room-death", "room-discards", "room-multi"]) {
      const firstSeat = firstConnectionRooms.find((room) => room.roomId === roomId)?.members
        .find(({ playerId }) => playerId === players[1]!.playerId);
      const secondSeat = secondConnectionRooms.find((room) => room.roomId === roomId)?.members
        .find(({ playerId }) => playerId === players[1]!.playerId);
      assert.deepEqual(firstSeat, secondSeat);
      assert.equal(firstSeat?.seatIndex, 1);
    }

    const handlers = createSyncProjectionHandlers({ storage: afterRestartStorage });
    const [firstSync, secondSync] = await Promise.all([
      matchSync(handlers, createMatchMembership(afterRestartStorage, players[1]!.playerId), {
        protocolVersion: 1, requestId: "reconnect-one", matchId: MATCH_IDS[0], knownVersion: 0, afterEventSeq: 0,
      }),
      matchSync(handlers, createMatchMembership(afterRestartStorage, players[1]!.playerId), {
        protocolVersion: 1, requestId: "reconnect-two", matchId: MATCH_IDS[0], knownVersion: 0, afterEventSeq: 0,
      }),
    ]);
    assert.equal("error" in firstSync, false);
    assert.equal("error" in secondSync, false);
    if ("error" in firstSync || "error" in secondSync) assert.fail("authenticated member should sync");
    assert.equal(firstSync.snapshot.viewer.playerId, players[1]!.playerId);
    assert.equal(firstSync.snapshot.viewer.seatIndex,
      expectedStates.get(MATCH_IDS[0])!.seats.find(({ public: player }) => player.playerId === players[1]!.playerId)?.public.seatIndex);
    assert.equal(firstSync.snapshot.pendingInteraction?.kind, "DUEL_RESPONSE");
    assert.deepEqual(firstSync.visibleEvents.map(({ type }) => type), ["BANG_ATTACKED"]);
    assert.deepEqual(firstSync.visibleEvents[0]?.payload, {
      actorPlayerId: players[0]!.playerId,
      targetPlayerId: players[1]!.playerId,
    });
    assert.deepEqual(secondSync.snapshot, firstSync.snapshot);

    const encodedSync = JSON.stringify(firstSync);
    for (const secret of [
      "private-duel-continuation",
      "private-duel-context",
      "private-duel-step",
      "hidden-event-card",
      "hidden-public-payload",
      "effectQueue",
      "resume-duel",
    ]) assert.equal(encodedSync.includes(secret), false, `sync leaked ${secret}`);

    const outsiderReply = await matchSync(handlers, createMatchMembership(afterRestartStorage, sessions[4]!.playerId), {
      protocolVersion: 1, requestId: "outsider", matchId: MATCH_IDS[0], knownVersion: 0, afterEventSeq: 0,
    });
    assert.ok("error" in outsiderReply, "a non-member must not receive any snapshot or events");

    const replayDependencies = {
      ...firstRelayDependencies,
      storage: afterRestartStorage,
      prepareEngineContext: () => {
        prepareCount += 1;
        return { random: { nextFloat: () => 0.5 } };
      },
    };
    const replayAck = await processMatchCommand(
      createMatchMembership(afterRestartStorage, receiptActorPlayerId),
      command,
      replayDependencies,
    );
    assert.deepEqual(replayAck, { ...firstAck, duplicate: true });
    assert.equal(prepareCount, 1, "the saved receipt prevents a second engine application after restart");
    assert.equal((await afterRestartStorage.getMatch(MATCH_IDS[4]))?.version, 1);

    const outbox = await afterRestartStorage.listPendingOutbox();
    const encodedOutbox = JSON.stringify(outbox.map(projectOutboxNotification));
    assert.equal(outbox.length, 1);
    for (const secret of ["private-duel", "hidden-event-card", "hidden-public-payload", "handCardInstanceIds"])
      assert.equal(encodedOutbox.includes(secret), false, `outbox leaked ${secret}`);
    assert.deepEqual(projectOutboxNotification(outbox[0]!), {
      event: "match:changed",
      payload: { matchId: MATCH_IDS[4], version: 1, eventSeq: 0 },
    });
  } finally {
    await database.close();
  }
});

test("unsupported active snapshots are quarantined without changing cursor, pending state, receipt, or history", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const storage = new StorageRepository(pool);
    const rooms = createRoomService(pool);
    const sessions = await createSessions(rooms);
    const players = sessions.slice(0, 4);
    const candidates = [
      { matchId: "match-unknown-schema", roomId: "room-unknown-schema", state: stateWithUnsupportedSchema(players) },
      {
        matchId: "match-unknown-ruleset",
        roomId: "room-unknown-ruleset",
        state: { ...pendingState(players, "death"), rulesetVersion: "future-ruleset" },
      },
      { matchId: "match-inconsistent", roomId: "room-inconsistent", state: pendingState(players, "discards") },
    ] as const;
    for (const candidate of candidates) {
      await createInGameRoom(database, storage, candidate.roomId, sessions);
      await storage.createMatch({ id: candidate.matchId, roomId: candidate.roomId, state: candidate.state });
      await database.query(
        `INSERT INTO command_receipts (actor_player_id, command_id, match_id, request_hash, outcome_json)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          players[0]!.playerId,
          `quarantine-receipt-${candidate.matchId}`,
          candidate.matchId,
          `request-${candidate.matchId}`,
          JSON.stringify({ marker: `receipt-${candidate.matchId}` }),
        ],
      );
    }
    await database.query("UPDATE matches SET event_seq = 1 WHERE id = $1", ["match-inconsistent"]);

    const beforeHistory = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM match_events");
    const beforeReceipts = await database.query<{ count: string }>("SELECT count(*)::text AS count FROM command_receipts");
    const beforeOutbox = await storage.listPendingOutbox();
    let recoveryEventId = 0;
    const recovery = new RecoveryService({
      pool,
      rooms,
      newOutboxEventId: () => `recovery-notification-${++recoveryEventId}`,
    });
    const report = await recovery.recoverPersistedMatches();

    assert.deepEqual(report, [
      { matchId: "match-inconsistent", status: "recovery_required", issue: "SNAPSHOT_METADATA_MISMATCH" },
      { matchId: "match-unknown-ruleset", status: "recovery_required", issue: "UNSUPPORTED_RULESET" },
      { matchId: "match-unknown-schema", status: "recovery_required", issue: "UNSUPPORTED_SCHEMA" },
    ]);

    for (const candidate of candidates) {
      const restored = await storage.getMatch(candidate.matchId);
      assert.equal(restored?.status, "recovery_required");
      assert.equal(restored?.state.status, "recovery_required");
      assert.equal(restored?.version, candidate.state.version);
      assert.equal(restored?.eventSeq, candidate.matchId === "match-inconsistent" ? 1 : candidate.state.eventSeq);
      const expectedState = structuredClone(candidate.state);
      expectedState.status = "recovery_required";
      assert.deepEqual(restored?.state, expectedState);
      const receipt = await storage.findCommandReceipt(
        players[0]!.playerId,
        `quarantine-receipt-${candidate.matchId}`,
      );
      assert.ok(receipt);
      assert.deepEqual(
        {
          actorPlayerId: receipt.actorPlayerId,
          commandId: receipt.commandId,
          matchId: receipt.matchId,
          roomId: receipt.roomId,
          requestHash: receipt.requestHash,
          outcome: receipt.outcome,
        },
        {
          actorPlayerId: players[0]!.playerId,
          commandId: `quarantine-receipt-${candidate.matchId}`,
          matchId: candidate.matchId,
          roomId: null,
          requestHash: `request-${candidate.matchId}`,
          outcome: { marker: `receipt-${candidate.matchId}` },
        },
      );
    }
    assert.equal((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM match_events")).rows[0]?.count,
      beforeHistory.rows[0]?.count);
    assert.equal((await database.query<{ count: string }>("SELECT count(*)::text AS count FROM command_receipts")).rows[0]?.count,
      beforeReceipts.rows[0]?.count);
    const outbox = await storage.listPendingOutbox();
    assert.equal(outbox.length, beforeOutbox.length + 3);
    for (const record of outbox) {
      const payload = projectOutboxNotification(record);
      assert.deepEqual(Object.keys(payload.payload).sort(), ["eventSeq", "matchId", "version"]);
      assert.equal(JSON.stringify(payload).includes("private-"), false);
    }
    assert.deepEqual(await recovery.recoverPersistedMatches(), [], "recovery-required matches are not auto-processed again");
  } finally {
    await database.close();
  }
});
