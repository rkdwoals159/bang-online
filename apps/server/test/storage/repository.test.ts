import assert from "node:assert/strict";
import { test } from "node:test";
import { applyStorageMigrations, loadStorageMigrations, MigrationChecksumMismatchError } from "../../src/storage/migrations.ts";
import {
  CommandIdReusedError,
  MatchMembershipRequiredError,
  MatchStateInvariantError,
  StaleMatchVersionError,
  StorageRepository,
  type MatchCommitInput,
  type NewMatch,
} from "../../src/storage/repository.ts";
import type { GameState } from "../../../../packages/engine/src/state/types.ts";
import { createDatabase } from "./pglite-pool.ts";

const playerIds = ["player-1", "player-2"] as const;

function makeState(overrides: Partial<GameState> = {}): GameState {
  return {
    schemaVersion: 1,
    rulesetVersion: "rules-2026-01",
    status: "playing",
    pauseReason: null,
    version: 0,
    eventSeq: 0,
    seats: [
      {
        public: {
          playerId: playerIds[0],
          displayName: "One",
          seatIndex: 0,
          characterId: "character-one",
          hp: 4,
          maxHp: 4,
          eliminated: false,
          roleRevealed: false,
          inPlayCardInstanceIds: ["card-table"],
        },
        private: { roleId: "sheriff", handCardInstanceIds: ["card-private"] },
      },
      {
        public: {
          playerId: playerIds[1],
          displayName: "Two",
          seatIndex: 1,
          characterId: "character-two",
          hp: 3,
          maxHp: 4,
          eliminated: false,
          roleRevealed: true,
          inPlayCardInstanceIds: [],
        },
        private: { roleId: "outlaw", handCardInstanceIds: ["card-other-private"] },
      },
    ],
    zones: {
      cardsByInstanceId: {
        "card-private": {
          cardInstanceId: "card-private",
          cardDefinitionId: "card-type-a",
          rank: "A",
          suit: "SPADES",
        },
        "card-other-private": {
          cardInstanceId: "card-other-private",
          cardDefinitionId: "card-type-b",
          rank: 7,
          suit: "HEARTS",
        },
        "card-table": {
          cardInstanceId: "card-table",
          cardDefinitionId: "card-type-c",
          rank: "K",
          suit: "CLUBS",
        },
        "card-discard-1": {
          cardInstanceId: "card-discard-1",
          cardDefinitionId: "card-type-d",
          rank: 3,
          suit: "DIAMONDS",
        },
        "card-discard-2": {
          cardInstanceId: "card-discard-2",
          cardDefinitionId: "card-type-e",
          rank: "Q",
          suit: "HEARTS",
        },
        "card-draw": {
          cardInstanceId: "card-draw",
          cardDefinitionId: "card-type-f",
          rank: 2,
          suit: "CLUBS",
        },
      },
      drawPileCardInstanceIds: ["card-draw"],
      discardPileCardInstanceIds: ["card-discard-1", "card-discard-2"],
      revealedPoolCardInstanceIds: [],
    },
    turn: {
      currentPlayerId: playerIds[0],
      phase: "play",
      bangCardPlaysThisTurn: 0,
      turnNumber: 1,
    },
    resolution: {
      effectQueue: [],
      continuations: [],
      pendingInteraction: {
        interactionId: "interaction-secret",
        kind: "private_choice",
        actorPlayerIds: [playerIds[0]],
        options: [{ choice: "keep", payload: { privateCard: "card-private" } }],
        context: { hiddenContinuation: "must-round-trip" },
        resumeFrameId: "frame-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      pendingDeath: null,
      victoryCheckDeferredByEffectId: null,
    },
    outcome: null,
    ...overrides,
  };
}

function makeNextState(state: GameState, version = state.version + 1): GameState {
  const next = structuredClone(state);
  next.version = version;
  next.eventSeq = version;
  next.turn.turnNumber = version + 1;
  next.resolution.pendingInteraction!.context.privateContinuation = `snapshot-secret-${version}`;
  return next;
}

function makeMatch(matchId: string, roomId = "room-1", state = makeState()): NewMatch {
  return { id: matchId, roomId, state };
}

function makeCommit(
  matchId: string,
  state: GameState,
  options: { commandId?: string; outboxEventId?: string } = {},
): MatchCommitInput {
  return {
    matchId,
    expectedVersion: state.version - 1,
    state,
    events: [
      {
        eventId: `event-${matchId}-${state.version}`,
        eventSeq: state.eventSeq,
        version: state.version,
        type: "state.changed",
        actorPlayerId: playerIds[0],
        payload: { marker: `event-${state.version}` },
      },
    ],
    receipt: {
      actorPlayerId: playerIds[0],
      commandId: options.commandId ?? `command-${matchId}-${state.version}`,
      requestHash: `request-hash-${matchId}-${state.version}`,
      outcome: { accepted: true, version: state.version },
    },
    outboxEventId: options.outboxEventId ?? `outbox-${matchId}-${state.version}`,
  };
}

async function seedRoomAndPlayers(repository: StorageRepository): Promise<void> {
  for (const [index, playerId] of playerIds.entries()) {
    await repository.createGuestSession({
      id: playerId,
      tokenHash: `token-hash-${playerId}`,
      displayName: index === 0 ? "One" : "Two",
      expiresAt: new Date("2030-01-01T00:00:00.000Z"),
    });
  }
  await repository.createRoom({
    id: "room-1",
    ownerPlayerId: playerIds[0],
    inviteCodeHash: "invite-code-hash",
    capacity: 4,
    players: [
      { playerId: playerIds[0], seatIndex: 0, ready: true },
      { playerId: playerIds[1], seatIndex: 1, ready: true },
    ],
  });
}

test("applies the initial schema to an empty database, skips an identical migration, and rejects checksum changes", async () => {
  const { database, pool } = await createDatabase();
  try {
    const before = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public'",
    );
    assert.equal(before.rows[0]?.count, "0");

    await applyStorageMigrations(pool);
    await applyStorageMigrations(pool);
    const rows = await database.query<{ version: number; name: string; checksum: string }>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    assert.equal(rows.rows.length, 1);
    assert.equal(rows.rows[0]?.version, 1);
    assert.equal(rows.rows[0]?.name, "initial");
    assert.match(rows.rows[0]?.checksum ?? "", /^[0-9a-f]{64}$/);

    const [migration] = await loadStorageMigrations();
    assert.ok(migration);
    await assert.rejects(
      applyStorageMigrations(pool, [{ ...migration, sql: `${migration.sql}\n-- modified` }]),
      MigrationChecksumMismatchError,
    );
    const afterMismatch = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM schema_migrations",
    );
    assert.equal(afterMismatch.rows[0]?.count, "1");
  } finally {
    await database.close();
  }
});

test("creates and reads rooms and the complete internal match snapshot", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);

    await repository.createMatch(makeMatch("match-roundtrip"));
    const room = await repository.getRoom("room-1");
    const match = await repository.getMatch("match-roundtrip");
    assert.ok(room);
    assert.equal(room.ownerPlayerId, playerIds[0]);
    assert.deepEqual(room.players.map(({ playerId }) => playerId), [...playerIds]);
    assert.ok(match);
    assert.equal(match.status, "playing");
    assert.equal(match.version, 0);
    assert.equal(match.eventSeq, 0);
    assert.equal(match.rulesetVersion, "rules-2026-01");
    assert.equal(match.stateSchemaVersion, 1);
    assert.deepEqual(match.state, makeState());
    assert.deepEqual(match.state.seats.map(({ private: value }) => value.roleId), ["sheriff", "outlaw"]);
    assert.deepEqual(match.state.seats[0]?.private.handCardInstanceIds, ["card-private"]);
    assert.deepEqual(match.state.resolution.pendingInteraction?.context, { hiddenContinuation: "must-round-trip" });
    assert.deepEqual(match.state.zones.discardPileCardInstanceIds, ["card-discard-1", "card-discard-2"]);
    assert.deepEqual(match.players.map(({ playerId, seatIndex, alive }) => ({ playerId, seatIndex, alive })), [
      { playerId: playerIds[0], seatIndex: 0, alive: true },
      { playerId: playerIds[1], seatIndex: 1, alive: true },
    ]);
  } finally {
    await database.close();
  }
});

test("looks up the latest current-or-last match route for a room", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);

    assert.equal(await repository.getLatestMatchIdForRoom("room-1"), null);
    assert.equal(await repository.getLatestMatchIdForRoom("missing-room"), null);
    await repository.createMatch({
      ...makeMatch("match-route-old"),
      startedAt: "2026-01-01T00:00:00.000Z",
    });
    await repository.createMatch({
      ...makeMatch("match-route-new"),
      startedAt: "2026-02-01T00:00:00.000Z",
    });

    assert.equal(await repository.getLatestMatchIdForRoom("room-1"), "match-route-new");
    await database.query("UPDATE matches SET status = 'completed' WHERE id = 'match-route-new'");
    assert.equal(
      await repository.getLatestMatchIdForRoom("room-1"),
      "match-route-new",
      "completed rooms still route to their last match",
    );
  } finally {
    await database.close();
  }
});

test("atomically commits snapshot, events, receipt, and a state-free outbox signal", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);
    await repository.createMatch(makeMatch("match-commit"));
    const nextState = makeNextState(makeState());

    const result = await repository.commitMatch(makeCommit("match-commit", nextState));
    assert.deepEqual(result, {
      status: "committed",
      version: 1,
      eventSeq: 1,
      outboxEventId: "outbox-match-commit-1",
    });

    const replay = await repository.commitMatch(makeCommit("match-commit", nextState));
    assert.deepEqual(replay, { status: "duplicate", outcome: { accepted: true, version: 1 } });
    const reusedCommand = makeCommit("match-commit", nextState);
    reusedCommand.receipt.requestHash = "different-request-hash";
    await assert.rejects(repository.commitMatch(reusedCommand), CommandIdReusedError);

    const match = await repository.getMatch("match-commit");
    const receipt = await repository.findCommandReceipt(playerIds[0], "command-match-commit-1");
    const events = await repository.listMatchEvents("match-commit");
    const outbox = await repository.listPendingOutbox();
    assert.equal(match?.version, 1);
    assert.deepEqual(match?.state, nextState);
    assert.deepEqual(receipt?.outcome, { accepted: true, version: 1 });
    assert.deepEqual(events.map(({ eventSeq, version, type, payload }) => ({ eventSeq, version, type, payload })), [
      { eventSeq: 1, version: 1, type: "state.changed", payload: { marker: "event-1" } },
    ]);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.kind, "match:changed");
    assert.equal(outbox[0]?.aggregateId, "match-commit");
    assert.deepEqual(outbox[0]?.payload, { matchId: "match-commit", version: 1, eventSeq: 1 });
    assert.equal(JSON.stringify(outbox[0]?.payload).includes("snapshot-secret"), false);
    assert.equal(JSON.stringify(outbox[0]?.payload).includes("roleId"), false);
    assert.equal((await repository.listMatchEvents("match-commit", 1)).length, 0);
  } finally {
    await database.close();
  }
});

test("records a rejected command receipt without changing snapshot, version, events, or outbox", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);
    await repository.createMatch(makeMatch("match-rejection"));
    const original = await repository.getMatch("match-rejection");
    assert.ok(original);

    const input = {
      matchId: "match-rejection",
      observedVersion: 0,
      receipt: {
        actorPlayerId: playerIds[0],
        commandId: "command-rejection",
        requestHash: "same-request-hash",
        outcome: {
          protocolVersion: 1,
          commandId: "command-rejection",
          status: "rejected",
          error: { code: "NOT_YOUR_TURN", messageKey: "match.notYourTurn", retryable: false },
        },
      },
    } as const;

    assert.deepEqual(await repository.recordMatchRejection(input), {
      status: "recorded",
      currentVersion: 0,
    });
    assert.deepEqual(await repository.recordMatchRejection(input), {
      status: "duplicate",
      outcome: input.receipt.outcome,
    });

    const reused = {
      ...input,
      receipt: { ...input.receipt, requestHash: "different-request-hash" },
    };
    await assert.rejects(repository.recordMatchRejection(reused), CommandIdReusedError);

    const after = await repository.getMatch("match-rejection");
    const receipt = await repository.findCommandReceipt(playerIds[0], "command-rejection");
    assert.deepEqual(after, original);
    assert.deepEqual(receipt?.outcome, input.receipt.outcome);
    assert.equal(receipt?.matchId, "match-rejection");
    assert.deepEqual(await repository.listMatchEvents("match-rejection"), []);
    assert.deepEqual(await repository.listPendingOutbox(), []);
    const receiptCount = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM command_receipts WHERE actor_player_id = $1 AND command_id = $2",
      [playerIds[0], "command-rejection"],
    );
    assert.equal(receiptCount.rows[0]?.count, "1");
  } finally {
    await database.close();
  }
});

test("does not record a rejection receipt for an actor without a match seat", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);
    await repository.createMatch(makeMatch("match-rejection-unauthorized"));

    await assert.rejects(
      repository.recordMatchRejection({
        matchId: "match-rejection-unauthorized",
        observedVersion: 0,
        receipt: {
          actorPlayerId: "outsider",
          commandId: "command-unauthorized-rejection",
          requestHash: "unauthorized-request-hash",
          outcome: { protocolVersion: 1, commandId: "command-unauthorized-rejection", status: "rejected" },
        },
      }),
      MatchMembershipRequiredError,
    );

    assert.equal(await repository.findCommandReceipt("outsider", "command-unauthorized-rejection"), null);
    assert.equal((await repository.getMatch("match-rejection-unauthorized"))?.version, 0);
    assert.deepEqual(await repository.listMatchEvents("match-rejection-unauthorized"), []);
    assert.deepEqual(await repository.listPendingOutbox(), []);
  } finally {
    await database.close();
  }
});

test("returns the current version without recording a rejection receipt after an observed-version race", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);
    await repository.createMatch(makeMatch("match-rejection-race"));

    const committedState = makeNextState(makeState());
    await repository.commitMatch(makeCommit("match-rejection-race", committedState));
    const before = await repository.getMatch("match-rejection-race");
    const eventsBefore = await repository.listMatchEvents("match-rejection-race");
    const outboxBefore = await repository.listPendingOutbox();
    assert.ok(before);

    assert.deepEqual(
      await repository.recordMatchRejection({
        matchId: "match-rejection-race",
        observedVersion: 0,
        receipt: {
          actorPlayerId: playerIds[0],
          commandId: "command-raced-rejection",
          requestHash: "raced-request-hash",
          outcome: { protocolVersion: 1, commandId: "command-raced-rejection", status: "rejected" },
        },
      }),
      { status: "version_changed", currentVersion: 1 },
    );

    assert.equal(await repository.findCommandReceipt(playerIds[0], "command-raced-rejection"), null);
    assert.deepEqual(await repository.getMatch("match-rejection-race"), before);
    assert.deepEqual(await repository.listMatchEvents("match-rejection-race"), eventsBefore);
    assert.deepEqual(await repository.listPendingOutbox(), outboxBefore);
  } finally {
    await database.close();
  }
});

test("rejects stale and lower-version commits without writing any associated records", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);
    await repository.createMatch(makeMatch("match-stale"));

    const committedState = makeNextState(makeState());
    await repository.commitMatch(makeCommit("match-stale", committedState));
    const lowerState = structuredClone(committedState);
    lowerState.version = 0;
    lowerState.eventSeq = 0;
    const stale = makeCommit("match-stale", lowerState, { commandId: "command-stale-lower" });
    stale.expectedVersion = 0;
    stale.events = [];
    await assert.rejects(repository.commitMatch(stale), StaleMatchVersionError);

    const match = await repository.getMatch("match-stale");
    assert.equal(match?.version, 1);
    assert.equal((await repository.findCommandReceipt(playerIds[0], "command-stale-lower")), null);
    assert.equal((await repository.listMatchEvents("match-stale")).length, 1);
    assert.equal((await repository.listPendingOutbox()).length, 1);

    const malformed = structuredClone(committedState);
    malformed.version = 2;
    malformed.eventSeq = 2;
    await assert.rejects(
      repository.commitMatch({
        ...makeCommit("match-stale", malformed, { commandId: "command-event-gap" }),
        events: [],
      }),
      MatchStateInvariantError,
    );
    assert.equal((await repository.getMatch("match-stale"))?.version, 1);
  } finally {
    await database.close();
  }
});

test("rolls back the snapshot, event, and receipt when the outbox insert fails", async () => {
  const { database, pool } = await createDatabase();
  try {
    await applyStorageMigrations(pool);
    const repository = new StorageRepository(pool);
    await seedRoomAndPlayers(repository);
    await repository.createMatch(makeMatch("match-source"));
    await repository.createMatch(makeMatch("match-target"));

    await repository.commitMatch(
      makeCommit("match-source", makeNextState(makeState()), {
        commandId: "command-source",
        outboxEventId: "outbox-conflict",
      }),
    );

    const targetState = makeNextState(makeState());
    await assert.rejects(
      repository.commitMatch(
        makeCommit("match-target", targetState, {
          commandId: "command-target-rollback",
          outboxEventId: "outbox-conflict",
        }),
      ),
    );

    assert.equal((await repository.getMatch("match-target"))?.version, 0);
    assert.deepEqual((await repository.getMatch("match-target"))?.state, makeState());
    assert.deepEqual(await repository.listMatchEvents("match-target"), []);
    assert.equal(await repository.findCommandReceipt(playerIds[0], "command-target-rollback"), null);
    const outbox = await repository.listPendingOutbox();
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0]?.aggregateId, "match-source");
    const row = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM outbox WHERE aggregate_id = 'match-target'",
    );
    assert.equal(row.rows[0]?.count, "0");
  } finally {
    await database.close();
  }
});
