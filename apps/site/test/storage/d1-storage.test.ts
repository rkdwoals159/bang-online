import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffectRegistry } from "../../../../packages/engine/src/effects/registry.js";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";
import { executeTurnDraw, resolveTurnStart, withTurnStartEffects } from "../../../../packages/engine/src/turn/draw.js";
import { D1InviteRateLimiter } from "../../src/storage/invite-limiter.js";
import {
  CommandIdReusedError,
  D1StorageInvariantError,
  RoomVersionConflictError,
  StaleMatchVersionError,
  StoredDataInvariantError,
  UnsupportedMatchStateError,
  parseMatchState,
} from "../../src/storage/index.js";
import type { D1DatabaseLike } from "../../src/storage/d1-types.js";
import { D1StorageRepository, type MatchCommitInput, type NewMatch } from "../../src/storage/repository.js";
import { countRows, createIsolatedD1 } from "./d1-test-db.js";

const playerIds = ["player-1", "player-2", "player-3", "player-4"] as const;

function makeState(overrides: Partial<GameState> = {}): GameState {
  const roles = ["sheriff", "deputy", "outlaw", "renegade"] as const;
  return {
    schemaVersion: 1,
    rulesetVersion: "rules-2026-01",
    status: "playing",
    pauseReason: null,
    version: 0,
    eventSeq: 0,
    seats: playerIds.map((playerId, seatIndex) => ({
      public: {
        playerId,
        displayName: `Player ${seatIndex + 1}`,
        seatIndex,
        characterId: `character-${seatIndex + 1}`,
        hp: 4,
        maxHp: 4,
        eliminated: false,
        roleRevealed: seatIndex === 0,
        inPlayCardInstanceIds: [],
      },
      private: { roleId: roles[seatIndex]!, handCardInstanceIds: [] },
    })),
    zones: {
      cardsByInstanceId: {},
      drawPileCardInstanceIds: [],
      discardPileCardInstanceIds: [],
      revealedPoolCardInstanceIds: [],
    },
    turn: { currentPlayerId: playerIds[0], phase: "play", bangCardPlaysThisTurn: 0, turnNumber: 1 },
    resolution: {
      effectQueue: [],
      continuations: [],
      pendingInteraction: null,
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
  return next;
}

function makeMatch(matchId: string, roomId = "room-1", state = makeState()): NewMatch {
  return { id: matchId, roomId, state };
}

function makeStartInput(roomId: string, expectedVersion: number, commandId: string, matchId: string, state = makeState()) {
  return {
    roomId,
    actorPlayerId: playerIds[0],
    commandId,
    requestHash: `${commandId}-hash`,
    expectedVersion,
    markerId: `${commandId}-marker`,
    matchId,
    matchOutboxEventId: `${commandId}-match-outbox`,
    roomOutboxEventId: `${commandId}-room-outbox`,
    state,
  };
}

async function completeMatch(db: D1DatabaseLike, repository: D1StorageRepository, matchId: string): Promise<void> {
  const match = await repository.getMatch(matchId);
  assert.ok(match);
  const state: GameState = {
    ...match.state,
    status: "completed",
    version: match.version + 1,
    eventSeq: match.eventSeq + 1,
    outcome: { winningFaction: "sheriff_and_deputies", winningPlayerIds: [playerIds[0]] },
  };
  const now = "2026-02-03T04:05:06.000Z";
  await db.batch([
    db.prepare(`UPDATE matches SET status = 'completed', version = ?, event_seq = ?, state_json = ?,
      updated_at = ?, ended_at = ? WHERE id = ?`)
      .bind(state.version, state.eventSeq, JSON.stringify(state), now, now, matchId),
    db.prepare(`INSERT INTO match_events (match_id, event_seq, event_id, version, type, actor_player_id, payload_json)
      VALUES (?, ?, ?, ?, 'MATCH_FINISHED', ?, ?)`)
      .bind(matchId, state.eventSeq, `${matchId}-finished-event`, state.version, playerIds[0],
        JSON.stringify({ preserved: true })),
  ]);
}

async function seedReadyRoom(repository: D1StorageRepository, roomId: string): Promise<void> {
  for (const [index, playerId] of playerIds.entries()) {
    await repository.createGuestSession({ id: playerId, tokenHash: `${roomId}-${playerId}`,
      displayName: `Player ${index + 1}`, expiresAt: "2030-01-01T00:00:00.000Z" });
  }
  await repository.createRoom({ id: roomId, ownerPlayerId: playerIds[0], inviteCodeHash: `${roomId}-invite`,
    capacity: 4, players: playerIds.map((playerId, seatIndex) => ({ playerId, seatIndex, ready: true })) });
}

async function rotateMatchRosterOneSeatClockwise(
  db: D1DatabaseLike,
  repository: D1StorageRepository,
  matchId: string,
): Promise<void> {
  const match = await repository.getMatch(matchId);
  assert.ok(match);
  const state = structuredClone(match.state);
  const playerAt = (seatIndex: number) => match.players.find((player) => player.seatIndex === seatIndex)?.playerId;
  const playerAtZero = playerAt(0);
  const playerAtOne = playerAt(1);
  const playerAtTwo = playerAt(2);
  const playerAtThree = playerAt(3);
  assert.ok(playerAtZero && playerAtOne && playerAtTwo && playerAtThree);
  for (const seat of state.seats) {
    seat.public.seatIndex = (seat.public.seatIndex + 1) % state.seats.length;
  }
  await db.batch([
    db.prepare("UPDATE matches SET state_json = ? WHERE id = ?").bind(JSON.stringify(state), matchId),
    db.prepare("UPDATE match_players SET seat_index = 6 WHERE match_id = ? AND player_id = ?").bind(matchId, playerAtZero),
    db.prepare("UPDATE match_players SET seat_index = 0 WHERE match_id = ? AND player_id = ?").bind(matchId, playerAtThree),
    db.prepare("UPDATE match_players SET seat_index = 3 WHERE match_id = ? AND player_id = ?").bind(matchId, playerAtTwo),
    db.prepare("UPDATE match_players SET seat_index = 2 WHERE match_id = ? AND player_id = ?").bind(matchId, playerAtOne),
    db.prepare("UPDATE match_players SET seat_index = 1 WHERE match_id = ? AND player_id = ?").bind(matchId, playerAtZero),
  ]);
}

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

function makeEngineStartSnapshot(seed: number, matchId: string): GameState {
  const random = seededRandom(seed);
  let interactionCounter = 0;
  const nextInteractionIdentity = () => ({
    interactionId: `${matchId}-interaction-${++interactionCounter}`,
    createdAt: "2026-02-03T04:05:06.000Z",
  });
  const initial = initializeGame({
    players: playerIds.map((playerId, index) => ({ playerId, displayName: `Player ${index + 1}` })),
    random,
  });
  const runtimeOptions = withTurnStartEffects({
    registry: createEffectRegistry(),
    nextInteractionIdentity,
  });
  const actorPlayerId = initial.turn.currentPlayerId;
  const turnStart = resolveTurnStart({
    state: initial,
    actorPlayerId,
    random,
    nextInteractionIdentity,
    continuationFrameId: `${matchId}:initial-start`,
    runtimeOptions,
  });
  if (!turnStart.ok) throw new Error(turnStart.error.message);
  const initialDraw = executeTurnDraw({
    state: turnStart.output.state,
    actorPlayerId,
    random,
    nextInteractionIdentity,
    continuationFrameId: `${matchId}:initial-draw`,
  });
  if (!initialDraw.ok) throw new Error(initialDraw.error.message);
  return initialDraw.output.state;
}

function makeCommit(matchId: string, state: GameState, options: {
  actorPlayerId?: string;
  commandId?: string;
  requestHash?: string;
  eventId?: string;
  outboxEventId?: string;
  markerId?: string;
} = {}): MatchCommitInput {
  const actorPlayerId = options.actorPlayerId ?? playerIds[0];
  return {
    matchId,
    expectedVersion: state.version - 1,
    expectedEventSeq: state.eventSeq - 1,
    markerId: options.markerId ?? `guard-${matchId}-${state.version}-${actorPlayerId}`,
    state,
    events: [{
      eventId: options.eventId ?? `event-${matchId}-${state.version}-${actorPlayerId}`,
      eventSeq: state.eventSeq,
      version: state.version,
      type: "state.changed",
      actorPlayerId,
      payload: { version: state.version },
    }],
    receipt: {
      actorPlayerId,
      commandId: options.commandId ?? `command-${matchId}-${state.version}-${actorPlayerId}`,
      requestHash: options.requestHash ?? `hash-${matchId}-${state.version}-${actorPlayerId}`,
      outcome: { accepted: true, version: state.version },
    },
    outboxEventId: options.outboxEventId ?? `outbox-${matchId}-${state.version}-${actorPlayerId}`,
  };
}

async function seedMatch(repository: Awaited<ReturnType<typeof createIsolatedD1>>["repository"], matchId = "match-1") {
  for (const [index, playerId] of playerIds.entries()) {
    await repository.createGuestSession({
      id: playerId,
      tokenHash: `token-hash-${playerId}`,
      displayName: `Player ${index + 1}`,
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  }
  await repository.createRoom({
    id: "room-1",
    ownerPlayerId: playerIds[0],
    inviteCodeHash: "invite-hash-room-1",
    capacity: 4,
    players: playerIds.map((playerId, seatIndex) => ({ playerId, seatIndex, ready: true })),
  });
  await repository.createMatch(makeMatch(matchId));
}

test("room and match projections use consistent D1 batches and assigned-room recovery avoids N+1 reads", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    await repository.createRoom({ id: "room-2", ownerPlayerId: playerIds[0], inviteCodeHash: "invite-hash-room-2",
      capacity: 4, players: playerIds.map((playerId, seatIndex) => ({ playerId, seatIndex, ready: true })) });
    const stats = { prepareCalls: 0, batchCalls: 0, batchSizes: [] as number[] };
    const countedDb: D1DatabaseLike = {
      prepare(query) { stats.prepareCalls += 1; return db.prepare(query); },
      batch(statements) { stats.batchCalls += 1; stats.batchSizes.push(statements.length); return db.batch(statements); },
      exec(query) { return db.exec(query); },
    };
    const counted = new D1StorageRepository(countedDb);

    const room = await counted.getRoom("room-1");
    assert.equal(room?.players[0]?.displayName, "Player 1");
    assert.equal(stats.batchCalls, 1);
    assert.deepEqual(stats.batchSizes, [2], "header and player/profile rows share one snapshot");

    stats.prepareCalls = 0;
    const assignedRooms = await counted.listRoomsForPlayer(playerIds[0]);
    assert.equal(assignedRooms.length, 2);
    assert.equal(stats.prepareCalls, 1, "all assigned room projections are loaded with one joined query");

    stats.batchCalls = 0;
    stats.batchSizes.length = 0;
    const authorizedMatch = await counted.getMatchForPlayer("match-1", playerIds[0], { supportedSchemaVersion: 1 });
    assert.equal(authorizedMatch?.players.length, 4);
    assert.equal(stats.batchCalls, 1);
    assert.deepEqual(stats.batchSizes, [2], "match metadata and players share one snapshot");

    await db.prepare("UPDATE matches SET state_json = '{}' WHERE id = ?").bind("match-1").run();
    assert.equal(await counted.getMatchForPlayer("match-1", "outsider"), null,
      "unauthorized membership is rejected before malformed state JSON is decoded");
    await assert.rejects(counted.getMatchForPlayer("match-1", playerIds[0], { supportedSchemaVersion: 1 }));
  } finally {
    await runtime.dispose();
  }
});

test("D1 batch statement failure rolls back earlier writes", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    await assert.rejects(db.batch([
      db.prepare("INSERT INTO guest_sessions (id, token_hash, display_name, expires_at) VALUES (?, ?, ?, ?)")
        .bind("rolled-back", "hash-rollback", "Rollback", "2030-01-01T00:00:00.000Z"),
      db.prepare("INSERT INTO missing_table (id) VALUES (?)").bind("must-fail"),
    ]));
    assert.equal(await countRows(db, "guest_sessions"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("same-version concurrent match commits admit one writer and leave no guard marker", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    const [left, right] = await Promise.allSettled([
      repository.commitMatch(makeCommit("match-1", makeNextState(makeState()), { actorPlayerId: playerIds[0] })),
      repository.commitMatch(makeCommit("match-1", makeNextState(makeState()), { actorPlayerId: playerIds[1] })),
    ]);
    assert.equal([left, right].filter((result) => result.status === "fulfilled").length, 1);
    const rejected = [left, right].find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof StaleMatchVersionError);
    const match = await repository.getMatch("match-1");
    assert.equal(match?.version, 1);
    assert.equal(await countRows(db, "match_events"), 1);
    assert.equal(await countRows(db, "command_receipts"), 1);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("stale expectedVersion performs no state, event, receipt, or outbox writes", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    const stale = makeCommit("match-1", makeNextState(makeState(), 18), {
      commandId: "stale-command", requestHash: "stale-hash", outboxEventId: "stale-outbox", markerId: "stale-marker",
    });
    stale.expectedVersion = 17;
    await assert.rejects(repository.commitMatch(stale), StaleMatchVersionError);
    assert.equal((await repository.getMatch("match-1"))?.version, 0);
    assert.equal(await countRows(db, "match_events"), 0);
    assert.equal(await countRows(db, "command_receipts"), 0);
    assert.equal(await countRows(db, "outbox"), 0);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("match commit guards reject event-sequence, schema, and ruleset drift without writing", async () => {
  for (const drift of ["event-sequence", "schema", "ruleset"] as const) {
    const { runtime, db, repository } = await createIsolatedD1();
    try {
      await seedMatch(repository);
      if (drift === "event-sequence") {
        await db.prepare("UPDATE matches SET event_seq = 1 WHERE id = ?").bind("match-1").run();
      } else if (drift === "schema") {
        const unsupported = makeState({ schemaVersion: 2 });
        await db.prepare("UPDATE matches SET state_schema_version = 2, state_json = ? WHERE id = ?")
          .bind(JSON.stringify(unsupported), "match-1").run();
      } else {
        await db.prepare("UPDATE matches SET ruleset_version = ? WHERE id = ?")
          .bind("rules-2026-02", "match-1").run();
      }
      const before = await db.prepare(`
        SELECT status, version, event_seq, ruleset_version, state_schema_version, state_json, updated_at, ended_at
        FROM matches WHERE id = ?
      `).bind("match-1").first<Record<string, unknown>>();
      const input = makeCommit("match-1", makeNextState(makeState()), {
        commandId: `drift-${drift}`, requestHash: `drift-${drift}-hash`,
        eventId: `drift-${drift}-event`, outboxEventId: `drift-${drift}-outbox`, markerId: `drift-${drift}-guard`,
      });
      await assert.rejects(repository.commitMatch(input), D1StorageInvariantError);
      const after = await db.prepare(`
        SELECT status, version, event_seq, ruleset_version, state_schema_version, state_json, updated_at, ended_at
        FROM matches WHERE id = ?
      `).bind("match-1").first<Record<string, unknown>>();
      assert.deepEqual(after, before, `${drift} mismatch must not rewrite the authoritative row`);
      assert.equal(await countRows(db, "match_events"), 0);
      assert.equal(await countRows(db, "command_receipts"), 0);
      assert.equal(await countRows(db, "outbox"), 0);
      assert.equal(await countRows(db, "commit_guards"), 0);
    } finally {
      await runtime.dispose();
    }
  }
});

test("receipt replay returns the original outcome and a changed hash is rejected without writes", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    const input = makeCommit("match-1", makeNextState(makeState()), {
      commandId: "same-command", requestHash: "same-hash", outboxEventId: "same-outbox", markerId: "first-guard",
    });
    const first = await repository.commitMatch(input);
    assert.deepEqual(first, { status: "committed", version: 1, eventSeq: 1, outboxEventId: "same-outbox" });
    const replay = await repository.commitMatch({ ...input, markerId: "replay-guard" });
    assert.deepEqual(replay, { status: "duplicate", outcome: { accepted: true, version: 1 } });
    await assert.rejects(repository.commitMatch({ ...input, markerId: "mismatch-guard",
      receipt: { ...input.receipt, requestHash: "different-hash" } }), CommandIdReusedError);
    assert.equal((await repository.getMatch("match-1"))?.version, 1);
    assert.equal(await countRows(db, "match_events"), 1);
    assert.equal(await countRows(db, "command_receipts"), 1);
    assert.equal(await countRows(db, "outbox"), 1);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("event, state, receipt, and outbox writes roll back together on outbox conflict", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    await db.prepare(`INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
      VALUES (?, ?, 0, 0, 'room:changed', ?)`)
      .bind("conflicting-outbox", "room-1", JSON.stringify({ roomId: "room-1", version: 0 })).run();
    const input = makeCommit("match-1", makeNextState(makeState()), {
      commandId: "rollback-command", requestHash: "rollback-hash", outboxEventId: "conflicting-outbox",
      markerId: "rollback-guard",
    });
    await assert.rejects(repository.commitMatch(input));
    assert.equal((await repository.getMatch("match-1"))?.version, 0);
    assert.equal(await countRows(db, "match_events"), 0);
    assert.equal(await countRows(db, "command_receipts"), 0);
    assert.equal(await countRows(db, "outbox"), 1);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("outbox cursor queries are monotonic and can be restricted to allowed aggregates", async () => {
  const { runtime, repository } = await createIsolatedD1();
  try {
    await repository.createGuestSession({ id: "owner", tokenHash: "owner-hash", displayName: "Owner",
      expiresAt: "2030-01-01T00:00:00.000Z" });
    await repository.createRoomCommand({ id: "room-a", ownerPlayerId: "owner", inviteCodeHash: "invite-a",
      capacity: 4, actorPlayerId: "owner", commandId: "create-a", requestHash: "request-a", outboxEventId: "outbox-a" });
    await repository.createRoomCommand({ id: "room-b", ownerPlayerId: "owner", inviteCodeHash: "invite-b",
      capacity: 4, actorPlayerId: "owner", commandId: "create-b", requestHash: "request-b", outboxEventId: "outbox-b" });
    const all = await repository.listOutboxAfter(0);
    assert.deepEqual(all.map((entry) => entry.cursor), [1, 2]);
    assert.deepEqual((await repository.listOutboxAfter(1)).map((entry) => entry.aggregateId), ["room-b"]);
    assert.deepEqual((await repository.listOutboxAfter(0, ["room-b"])).map((entry) => entry.cursor), [2]);
    assert.deepEqual(await repository.listOutboxAfter(0, []), []);
  } finally {
    await runtime.dispose();
  }
});

test("parallel START_MATCH replay writes room, match, receipt and both outbox signals once", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    for (const [index, playerId] of playerIds.entries()) {
      await repository.createGuestSession({ id: playerId, tokenHash: `hash-${playerId}`, displayName: playerId,
        expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    await repository.createRoom({ id: "room-start", ownerPlayerId: playerIds[0], inviteCodeHash: "start-invite",
      capacity: 4, players: playerIds.map((playerId, seatIndex) => ({ playerId, seatIndex, ready: true })) });
    const input = {
      roomId: "room-start", actorPlayerId: playerIds[0], commandId: "start-command", requestHash: "start-hash",
      expectedVersion: 0, matchId: "match-start", matchOutboxEventId: "start-match-outbox",
      roomOutboxEventId: "start-room-outbox", state: makeState(),
    };
    const [first, second] = await Promise.all([
      repository.startRoomWithMatch({ ...input, markerId: "start-guard-one" }),
      repository.startRoomWithMatch({ ...input, markerId: "start-guard-two" }),
    ]);
    assert.deepEqual([first.status, second.status].sort(), ["applied", "duplicate"]);
    const replay = await repository.startRoomWithMatch({ ...input, markerId: "start-guard-replay" });
    assert.equal(replay.status, "duplicate");
    await assert.rejects(repository.startRoomWithMatch({ ...input, markerId: "start-guard-hash-mismatch",
      requestHash: "changed-start-hash" }), CommandIdReusedError);
    assert.equal((await repository.getRoom("room-start"))?.version, 1);
    assert.equal((await repository.getMatch("match-start"))?.players.length, 4);
    assert.equal(await countRows(db, "matches"), 1);
    assert.equal(await countRows(db, "match_players"), 4);
    assert.equal(await countRows(db, "command_receipts"), 1);
    assert.equal(await countRows(db, "outbox"), 2);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("START_MATCH restarts the latest completed match, preserves history, and resolves equal timestamps by room version", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedReadyRoom(repository, "room-restart");
    const tiedTimestamp = "2026-02-03T04:05:06.000Z";
    const firstInput = { ...makeStartInput("room-restart", 0, "first-start", "match-first"), startedAt: tiedTimestamp };
    const first = await repository.startRoomWithMatch(firstInput);
    assert.equal(first.status, "applied");
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart"), "match-first");

    await completeMatch(db, repository, "match-first");
    // Model a prior match whose starting seat rotated while preserving the same clockwise player order.
    await rotateMatchRosterOneSeatClockwise(db, repository, "match-first");
    await db.prepare("UPDATE matches SET created_at = ?, started_at = ? WHERE id = ?")
      .bind(tiedTimestamp, tiedTimestamp, "match-first").run();
    const priorBeforeRestart = await repository.getMatch("match-first");
    assert.ok(priorBeforeRestart);
    const priorEvents = await repository.listMatchEvents("match-first");
    assert.equal(priorBeforeRestart.status, "completed");
    assert.equal(priorEvents.length, 1);
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart"), "match-first");

    const freshState = makeState({ turn: { ...makeState().turn, turnNumber: 2 } });
    const restartInput = { ...makeStartInput("room-restart", 1, "restart-start", "match-second", freshState),
      startedAt: tiedTimestamp };
    const restarted = await repository.startRoomWithMatch(restartInput);
    assert.equal(restarted.status, "applied");
    assert.notEqual(restarted.outcome.matchId, "match-first");
    assert.equal(restarted.outcome.matchId, "match-second");
    assert.equal(restarted.outcome.version, 2);
    assert.deepEqual(await repository.getRoom("room-restart").then((room) => ({ status: room?.status, version: room?.version })),
      { status: "in_game", version: 2 });

    // Force created_at ties too; room_version is the stable start-order discriminator.
    await db.prepare("UPDATE matches SET created_at = ? WHERE id = ?").bind(tiedTimestamp, "match-second").run();
    const order = await db.prepare("SELECT id, room_version FROM matches WHERE room_id = ? ORDER BY created_at DESC, started_at DESC")
      .bind("room-restart").all<{ id: string; room_version: number }>();
    assert.deepEqual(order.results?.map(({ room_version }) => room_version).sort(), [1, 2]);
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart"), "match-second");

    const priorAfterRestart = await repository.getMatch("match-first");
    assert.deepEqual(priorAfterRestart, priorBeforeRestart);
    assert.deepEqual(await repository.listMatchEvents("match-first"), priorEvents);
    assert.deepEqual(priorAfterRestart?.players.map(({ playerId }) => playerId),
      [playerIds[3], playerIds[0], playerIds[1], playerIds[2]], "the prior cyclic seat assignment is retained");
    const freshMatch = await repository.getMatch("match-second");
    assert.ok(freshMatch);
    assert.equal(freshMatch.status, "playing");
    assert.deepEqual(freshMatch.state, freshState);
    assert.deepEqual(freshMatch.players.map(({ playerId, seatIndex }) => [playerId, seatIndex]),
      playerIds.map((playerId, seatIndex) => [playerId, seatIndex]));
    assert.equal(await countRows(db, "matches"), 2);
    assert.equal(await countRows(db, "match_players"), 8);
    assert.equal(await countRows(db, "match_events"), 1);
    assert.equal(await countRows(db, "command_receipts"), 2);
    assert.equal(await countRows(db, "outbox"), 4);
    assert.equal(await countRows(db, "commit_guards"), 0);

    const beforeReplay = {
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    };
    const replay = await repository.startRoomWithMatch({ ...restartInput, markerId: "restart-replay-marker" });
    assert.equal(replay.status, "duplicate");
    assert.deepEqual(replay.outcome, restarted.outcome);
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart"), "match-second");
    assert.deepEqual({
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
    }, beforeReplay);
  } finally {
    await runtime.dispose();
  }
});

test("START_MATCH persists the initialized turn-start/draw snapshot and restarts the completed match", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedReadyRoom(repository, "room-engine-rotation");
    const firstState = makeEngineStartSnapshot(1, "match-rotation-first");
    assert.ok(firstState.version > 0,
      "the persisted start snapshot includes the version increments from turn-start and initial draw resolution");
    assert.equal(firstState.eventSeq, 0);
    assert.equal(firstState.turn.phase, "play");
    assert.notEqual(firstState.seats[0]?.public.playerId, playerIds[0],
      "the fixture must exercise initializeGame rotating the Sheriff into match seat zero");
    const first = await repository.startRoomWithMatch(
      makeStartInput("room-engine-rotation", 0, "rotation-first", "match-rotation-first", firstState),
    );
    assert.equal(first.status, "applied");
    assert.equal(first.outcome.matchId, "match-rotation-first");
    const firstMatch = await repository.getMatch("match-rotation-first");
    assert.ok(firstMatch);
    assert.equal(firstMatch.state.version, firstState.version);
    assert.equal(firstMatch.state.eventSeq, firstState.eventSeq);
    assert.equal(firstMatch.state.turn.phase, "play");
    assert.deepEqual(firstMatch.players.map(({ playerId, seatIndex }) => [playerId, seatIndex]),
      firstState.seats.map(({ public: player }) => [player.playerId, player.seatIndex]));
    assert.deepEqual(firstMatch.players.map(({ playerId }) => playerId),
      [playerIds[3], playerIds[0], playerIds[1], playerIds[2]],
      "the persisted match roster follows the engine's cyclic Sheriff-first rotation");

    await completeMatch(db, repository, "match-rotation-first");
    const priorMatch = await repository.getMatch("match-rotation-first");
    const priorEvents = await repository.listMatchEvents("match-rotation-first");
    assert.equal(priorMatch?.status, "completed");
    assert.equal(priorEvents.length, 1);

    const freshState = makeEngineStartSnapshot(2, "match-rotation-second");
    assert.notDeepEqual(freshState.zones.drawPileCardInstanceIds, firstState.zones.drawPileCardInstanceIds,
      "restart must use a fresh initialization input");
    const restarted = await repository.startRoomWithMatch(
      makeStartInput("room-engine-rotation", 1, "rotation-restart", "match-rotation-second", freshState),
    );
    assert.equal(restarted.status, "applied");
    assert.equal(restarted.outcome.version, 2);
    assert.equal(await repository.getLatestMatchIdForRoom("room-engine-rotation"), "match-rotation-second");
    const secondMatch = await repository.getMatch("match-rotation-second");
    assert.ok(secondMatch);
    assert.deepEqual(secondMatch.players.map(({ playerId, seatIndex }) => [playerId, seatIndex]),
      freshState.seats.map(({ public: player }) => [player.playerId, player.seatIndex]));
    assert.deepEqual(await repository.getMatch("match-rotation-first"), priorMatch,
      "the completed match snapshot and player roster must remain unchanged");
    assert.deepEqual(await repository.listMatchEvents("match-rotation-first"), priorEvents,
      "the completed match event history must remain unchanged");
    assert.equal(await countRows(db, "matches"), 2);
    assert.equal(await countRows(db, "match_players"), 8);
    assert.equal(await countRows(db, "command_receipts"), 2);
    assert.equal(await countRows(db, "outbox"), 4);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("START_MATCH rejects an in-progress latest match and stale completed-match restart without writes", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedReadyRoom(repository, "room-restart-guards");
    await repository.startRoomWithMatch(makeStartInput("room-restart-guards", 0, "guard-first", "match-guard-first"));
    const beforePlayingRestart = {
      room: await repository.getRoom("room-restart-guards"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
      guards: await countRows(db, "commit_guards"),
    };
    await assert.rejects(repository.startRoomWithMatch(
      makeStartInput("room-restart-guards", 1, "reject-playing-restart", "match-must-not-start")),
      D1StorageInvariantError);
    assert.deepEqual({
      room: await repository.getRoom("room-restart-guards"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
      guards: await countRows(db, "commit_guards"),
    }, beforePlayingRestart);

    await completeMatch(db, repository, "match-guard-first");
    const beforeStaleRestart = {
      room: await repository.getRoom("room-restart-guards"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
      guards: await countRows(db, "commit_guards"),
    };
    await assert.rejects(repository.startRoomWithMatch(
      makeStartInput("room-restart-guards", 0, "reject-stale-restart", "match-stale-must-not-start")),
      RoomVersionConflictError);
    assert.deepEqual({
      room: await repository.getRoom("room-restart-guards"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
      guards: await countRows(db, "commit_guards"),
    }, beforeStaleRestart);
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart-guards"), "match-guard-first");
  } finally {
    await runtime.dispose();
  }
});

test("concurrent completed-match restarts admit one writer and reject the stale contender without writes", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedReadyRoom(repository, "room-restart-race");
    await repository.startRoomWithMatch(makeStartInput("room-restart-race", 0, "race-first", "match-race-first"));
    await completeMatch(db, repository, "match-race-first");
    const [left, right] = await Promise.allSettled([
      repository.startRoomWithMatch(makeStartInput("room-restart-race", 1, "race-left", "match-race-left")),
      repository.startRoomWithMatch(makeStartInput("room-restart-race", 1, "race-right", "match-race-right")),
    ]);
    const successes = [left, right].filter((result) => result.status === "fulfilled");
    const failures = [left, right].filter((result) => result.status === "rejected");
    assert.equal(successes.length, 1);
    assert.equal(failures.length, 1);
    assert.ok(failures[0]?.status === "rejected" && failures[0].reason instanceof RoomVersionConflictError);
    const success = successes[0];
    assert.ok(success?.status === "fulfilled");
    assert.equal(success.value.status, "applied");
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart-race"), success.value.outcome.matchId);
    assert.equal((await repository.getRoom("room-restart-race"))?.version, 2);
    assert.equal(await countRows(db, "matches"), 2);
    assert.equal(await countRows(db, "match_players"), 8);
    assert.equal(await countRows(db, "command_receipts"), 2);
    assert.equal(await countRows(db, "outbox"), 4);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("completed-match restart rolls room, match, receipt, players, and outbox back together", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    await seedReadyRoom(repository, "room-restart-rollback");
    await repository.startRoomWithMatch(makeStartInput("room-restart-rollback", 0, "rollback-first", "match-rollback-first"));
    await completeMatch(db, repository, "match-rollback-first");
    await db.prepare(`INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
      VALUES (?, ?, 1, 0, 'room:changed', ?)`)
      .bind("restart-outbox-conflict", "room-restart-rollback",
        JSON.stringify({ roomId: "room-restart-rollback", version: 1 })).run();
    const before = {
      room: await repository.getRoom("room-restart-rollback"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
      guards: await countRows(db, "commit_guards"),
      previous: await repository.getMatch("match-rollback-first"),
      events: await repository.listMatchEvents("match-rollback-first"),
    };
    await assert.rejects(repository.startRoomWithMatch({
      ...makeStartInput("room-restart-rollback", 1, "rollback-restart", "match-rollback-second"),
      roomOutboxEventId: "restart-outbox-conflict",
    }));
    assert.deepEqual({
      room: await repository.getRoom("room-restart-rollback"),
      matches: await countRows(db, "matches"),
      players: await countRows(db, "match_players"),
      receipts: await countRows(db, "command_receipts"),
      outbox: await countRows(db, "outbox"),
      guards: await countRows(db, "commit_guards"),
      previous: await repository.getMatch("match-rollback-first"),
      events: await repository.listMatchEvents("match-rollback-first"),
    }, before);
    assert.equal(await repository.getLatestMatchIdForRoom("room-restart-rollback"), "match-rollback-first");
  } finally {
    await runtime.dispose();
  }
});

test("fresh Miniflare D1 runtimes are isolated and persisted receipts survive repository recreation", async () => {
  const first = await createIsolatedD1();
  const second = await createIsolatedD1();
  try {
    await seedMatch(first.repository, "persist-match");
    const commit = makeCommit("persist-match", makeNextState(makeState()), {
      commandId: "persist-command", requestHash: "persist-hash", outboxEventId: "persist-outbox",
    });
    await first.repository.commitMatch(commit);
    const restored = new D1StorageRepository(first.db);
    const replay = await restored.commitMatch({ ...commit, markerId: "restore-guard" });
    assert.deepEqual(replay, { status: "duplicate", outcome: { accepted: true, version: 1 } });
    assert.equal(await countRows(second.db, "guest_sessions"), 0);
    assert.equal((await restored.getMatch("persist-match"))?.version, 1);
  } finally {
    await first.runtime.dispose();
    await second.runtime.dispose();
  }
});

test("unsupported state schema is returned as a safe recovery error", async () => {
  const { runtime, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    await assert.rejects(repository.getMatch("match-1", { supportedSchemaVersion: 99 }), UnsupportedMatchStateError);
    await assert.rejects(repository.getMatch("match-1", { supportedSchemaVersion: 2 }), UnsupportedMatchStateError);
  } finally {
    await runtime.dispose();
  }
});

test("D1 invite limiter persists reservations across limiter instances and admits at most five", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const now = 1_800_000_000_000;
    const bucketHash = "a".repeat(64);
    const limiterOne = new D1InviteRateLimiter(db);
    const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      limiterOne.reserve(bucketHash, `reservation-${index}`, now)));
    assert.equal(attempts.filter((result) => result.allowed).length, 5);
    const blocked = attempts.find((result) => !result.allowed);
    assert.ok(blocked && !blocked.allowed);
    assert.equal(blocked.retryAfterMs, 1_000);
    const otherWorker = new D1InviteRateLimiter(db);
    const denied = await otherWorker.reserve(bucketHash, "reservation-after-runtime-change", now + 10);
    assert.equal(denied.allowed, false);
    for (const reservation of attempts) if (reservation.allowed) await reservation.complete("invalid", now + 20);
    const resetReservation = await otherWorker.reserve(bucketHash, "reservation-join-success", now + 30);
    assert.equal(resetReservation.allowed, false, "five failed lookups still occupy the rolling window");
  } finally {
    await runtime.dispose();
  }
});

test("D1 invite limiter success JOIN reset clears prior failures and retry backoff", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const limiter = new D1InviteRateLimiter(db);
    const bucketHash = "b".repeat(64);
    const now = 1_800_000_100_000;
    for (let index = 0; index < 4; index += 1) {
      const reservation = await limiter.reserve(bucketHash, `failed-${index}`, now + index * 10);
      assert.equal(reservation.allowed, true);
      if (reservation.allowed) await reservation.complete("invalid", now + index * 10 + 1);
    }
    const success = await limiter.reserve(bucketHash, "success-join", now + 100);
    assert.equal(success.allowed, true);
    if (success.allowed) await success.complete("join-success", now + 101);
    for (let index = 0; index < 5; index += 1) {
      const reservation = await limiter.reserve(bucketHash, `after-reset-${index}`, now + 102 + index * 10);
      assert.equal(reservation.allowed, true, "JOIN success must reset the previous rolling failures");
      if (reservation.allowed) await reservation.complete("invalid", now + 103 + index * 10);
    }
    assert.equal((await limiter.reserve(bucketHash, "after-reset-blocked", now + 160)).allowed, false);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("same-version concurrent room mutations write one player row and one receipt", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    for (const [index, playerId] of playerIds.entries()) {
      await repository.createGuestSession({ id: playerId, tokenHash: `room-token-${playerId}`,
        displayName: playerId, expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    await repository.createRoom({ id: "room-race", ownerPlayerId: playerIds[0], inviteCodeHash: "race-invite",
      capacity: 5, players: [{ playerId: playerIds[0], seatIndex: 0, ready: false }] });
    const makeRoomCommand = (actorPlayerId: string, markerId: string) => ({
      roomId: "room-race", actorPlayerId, commandId: `join-${actorPlayerId}`, requestHash: `hash-${actorPlayerId}`,
      expectedVersion: 0, markerId, status: "waiting" as const, ownerPlayerId: playerIds[0], changed: true,
      playerWrites: [{ operation: "insert" as const, playerId: actorPlayerId, seatIndex: 1 }],
      receiptOutcome: { roomId: "room-race", version: 1, roomStatus: "waiting", ownerPlayerId: playerIds[0],
        occupancy: 2, changed: true, playerId: actorPlayerId, seatIndex: 1 },
      outboxEventId: `room-race-${actorPlayerId}`,
    });
    const results = await Promise.allSettled([
      repository.commitRoomCommand(makeRoomCommand(playerIds[1], "room-guard-one")),
      repository.commitRoomCommand(makeRoomCommand(playerIds[2], "room-guard-two")),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.ok(rejected.reason instanceof RoomVersionConflictError);
    const room = await repository.getRoom("room-race");
    assert.equal(room?.version, 1);
    assert.equal(room?.players.length, 2);
    assert.equal(await countRows(db, "command_receipts"), 1);
    assert.equal(await countRows(db, "outbox"), 1);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("room, player, receipt, and outbox writes roll back together on statement failure", async () => {
  const { runtime, db, repository } = await createIsolatedD1();
  try {
    for (const playerId of playerIds.slice(0, 2)) {
      await repository.createGuestSession({ id: playerId, tokenHash: `room-rollback-${playerId}`,
        displayName: playerId, expiresAt: "2030-01-01T00:00:00.000Z" });
    }
    await repository.createRoom({ id: "room-rollback", ownerPlayerId: playerIds[0], inviteCodeHash: "rollback-invite",
      capacity: 4, players: [{ playerId: playerIds[0], seatIndex: 0 }] });
    await db.prepare(`INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
      VALUES (?, ?, 0, 0, 'room:changed', ?)`)
      .bind("room-conflict-outbox", "room-rollback", JSON.stringify({ roomId: "room-rollback", version: 0 })).run();
    await assert.rejects(repository.commitRoomCommand({
      roomId: "room-rollback", actorPlayerId: playerIds[0], commandId: "join-rollback",
      requestHash: "join-rollback-hash", expectedVersion: 0, markerId: "room-rollback-guard",
      status: "waiting", ownerPlayerId: playerIds[0], changed: true,
      playerWrites: [{ operation: "insert", playerId: playerIds[1], seatIndex: 1 }],
      receiptOutcome: { roomId: "room-rollback", version: 1, roomStatus: "waiting",
        ownerPlayerId: playerIds[0], occupancy: 2, changed: true },
      outboxEventId: "room-conflict-outbox",
    }));
    const room = await repository.getRoom("room-rollback");
    assert.equal(room?.version, 0);
    assert.deepEqual(room?.players.map(({ playerId }) => playerId), [playerIds[0]]);
    assert.equal(await countRows(db, "command_receipts"), 0);
    assert.equal(await countRows(db, "outbox"), 1);
    assert.equal(await countRows(db, "commit_guards"), 0);
  } finally {
    await runtime.dispose();
  }
});

test("malformed state JSON fails schema validation before it can be written", async () => {
  const { runtime, repository } = await createIsolatedD1();
  try {
    await seedMatch(repository);
    const invalid = makeNextState(makeState());
    (invalid as unknown as { seats: unknown }).seats = "not-seats";
    await assert.rejects(repository.commitMatch(makeCommit("match-1", invalid)), StoredDataInvariantError);
    assert.equal((await repository.getMatch("match-1"))?.version, 0);
  } finally {
    await runtime.dispose();
  }
});

test("stored snapshot validation checks catalog enums and every resolution record shape", () => {
  const invalidSnapshots = [
    (() => { const state = makeState(); state.seats[0]!.private.roleId = "vice" as never; return state; })(),
    (() => {
      const state = makeState();
      state.zones.cardsByInstanceId.card = {
        cardInstanceId: "card", cardDefinitionId: "bang", rank: "TEN" as never, suit: "SPADES" as never,
      };
      return state;
    })(),
    (() => {
      const state = makeState();
      state.zones.cardsByInstanceId.card = {
        cardInstanceId: "card", cardDefinitionId: "bang", rank: 10, suit: "JOKERS" as never,
      };
      return state;
    })(),
    (() => {
      const state = makeState();
      state.resolution.effectQueue = [{
        effectId: "effect", kind: "damage", sourcePlayerId: null, targetPlayerId: playerIds[0],
        sourceCardInstanceId: null, payload: "invalid" as never,
      }];
      return state;
    })(),
    (() => {
      const state = makeState();
      state.resolution.continuations = [{
        frameId: "frame", kind: "resume", sourcePlayerId: null, sourceCardInstanceId: null,
        payload: [] as never,
      }];
      return state;
    })(),
    (() => {
      const state = makeState();
      state.resolution.pendingInteraction = {
        interactionId: "interaction", kind: "choice", actorPlayerIds: [playerIds[0]],
        options: [{ choice: "keep", payload: [] as never }], context: {}, resumeFrameId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      return state;
    })(),
    (() => {
      const state = makeState();
      state.resolution.pendingDeath = {
        victimPlayerId: playerIds[0], sourcePlayerId: null, rescueResponderIds: [playerIds[0]],
        rescueCursor: 0, consequenceStage: "rescue", resumeFrameId: null,
      };
      (state.resolution.pendingDeath as unknown as { consequenceStage: string }).consequenceStage = "done";
      return state;
    })(),
  ];
  invalidSnapshots.forEach((snapshot, index) => {
    assert.throws(() => parseMatchState(snapshot), StoredDataInvariantError, `invalid snapshot ${index + 1}`);
  });
});
