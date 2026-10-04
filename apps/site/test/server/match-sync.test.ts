import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE_PHYSICAL_CARDS } from "../../../../packages/catalog/src/cards/index.js";
import type { CommandAck, MatchSyncResponse, SyncRejectedResponse } from "../../../../packages/contracts/src/protocol.js";
import {
  parseCommandAck,
  parseMatchSyncResponse,
  parseRoomSyncResponse,
  parseSyncUnchangedResponse,
  parseSyncRejectedResponse,
} from "../../../../packages/contracts/src/validation.js";
import type { GameState } from "../../../../packages/engine/src/state/types.js";
import { buildLegalActionCandidates } from "../../../../packages/engine/src/actions/index.js";
import { handleNotificationsRoute } from "../../src/server/routes/notifications.js";
import { routeApiRequest } from "../../src/server/routes/index.js";
import type { D1DatabaseLike } from "../../src/storage/d1-types.js";
import { D1StorageRepository } from "../../src/storage/repository.js";
import { createIsolatedD1, countRows } from "../storage/d1-test-db.js";

const ORIGIN = "https://site.test";
let sequence = 1;

interface Guest {
  playerId: string;
  displayName: string;
  cookie: string;
}

interface StartedMatch {
  db: D1DatabaseLike;
  guests: Guest[];
  roomId: string;
  matchId: string;
}

function nextCommandId(): string {
  return `00000000-0000-4000-8000-${String(sequence++).padStart(12, "0")}`;
}

function request(path: string, options: {
  method?: string;
  body?: unknown;
  cookie?: string;
  headers?: Record<string, string>;
} = {}): Request {
  const method = options.method ?? "POST";
  const headers = new Headers(options.headers);
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET") headers.set("Origin", ORIGIN);
  if (options.cookie) headers.set("Cookie", options.cookie);
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

async function json(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>;
}

function assertAck(value: unknown): CommandAck {
  const parsed = parseCommandAck(value);
  assert.equal(parsed.ok, true, "command response must pass the shared CommandAck parser");
  if (!parsed.ok) throw new Error("Invalid CommandAck response.");
  return parsed.value;
}

function assertSyncRejected(value: unknown, code: SyncRejectedResponse["error"]["code"]): SyncRejectedResponse {
  const parsed = parseSyncRejectedResponse(value);
  assert.equal(parsed.ok, true, "sync rejection must pass the shared parser");
  if (!parsed.ok) throw new Error("Invalid sync rejection.");
  assert.equal(parsed.value.error.code, code);
  return parsed.value;
}

async function createGuest(db: D1DatabaseLike, displayName: string): Promise<Guest> {
  const response = await routeApiRequest(request("/api/guest-sessions", {
    body: { protocolVersion: 1, displayName },
  }), { DB: db });
  assert.equal(response.status, 201);
  const body = await json(response) as { player: { playerId: string; displayName: string } };
  const setCookie = response.headers.get("Set-Cookie");
  assert.ok(setCookie);
  return {
    playerId: body.player.playerId,
    displayName: body.player.displayName,
    cookie: setCookie.split(";", 1)[0]!,
  };
}

async function sendRoomCommand(
  db: D1DatabaseLike,
  guest: Guest,
  roomId: string,
  type: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const response = await routeApiRequest(request(`/api/rooms/${encodeURIComponent(roomId)}/commands`, {
    cookie: guest.cookie,
    body: { protocolVersion: 1, commandId: nextCommandId(), roomId, expectedVersion, type, payload },
  }), { DB: db });
  return json(response);
}

async function startedFourPlayerMatch(db: D1DatabaseLike): Promise<StartedMatch> {
  const guests: Guest[] = [];
  for (let index = 0; index < 4; index += 1) guests.push(await createGuest(db, `Guest ${index + 1}`));
  const owner = guests[0]!;
  const created = await routeApiRequest(request("/api/rooms", {
    cookie: owner.cookie,
    body: {
      protocolVersion: 1,
      commandId: nextCommandId(),
      expectedVersion: 0,
      type: "CREATE_ROOM",
      payload: { capacity: 4, rulesetVersion: "base4-ko-online-1.0", displayName: "Table" },
    },
  }), { DB: db });
  assert.equal(created.status, 200);
  const createdBody = await json(created) as { roomId: string; inviteCode: string };
  const repository = new D1StorageRepository(db);

  for (const guest of guests.slice(1)) {
    const room = await repository.getRoom(createdBody.roomId);
    assert.ok(room);
    const joined = await sendRoomCommand(db, guest, room.id, "JOIN", room.version, { inviteCode: createdBody.inviteCode });
    assert.equal(typeof joined, "object");
  }
  for (const guest of guests) {
    const room = await repository.getRoom(createdBody.roomId);
    assert.ok(room);
    const ready = await sendRoomCommand(db, guest, room.id, "SET_READY", room.version, { ready: true });
    assert.equal(typeof ready, "object");
  }
  const room = await repository.getRoom(createdBody.roomId);
  assert.ok(room);
  const started = await routeApiRequest(request(`/api/rooms/${encodeURIComponent(room.id)}/commands`, {
    cookie: owner.cookie,
    body: {
      protocolVersion: 1,
      commandId: nextCommandId(),
      roomId: room.id,
      expectedVersion: room.version,
      type: "START_MATCH",
      payload: {},
    },
  }), { DB: db });
  assert.equal(started.status, 200);
  const matchId = await repository.getLatestMatchIdForRoom(room.id);
  assert.ok(matchId);
  await completeTurnDrawIfNeeded(db, matchId, guests);
  return { db, guests, roomId: room.id, matchId };
}

async function matchCommand(
  db: D1DatabaseLike,
  guest: Guest,
  matchId: string,
  type: string,
  expectedVersion: number,
  payload: Record<string, unknown>,
  commandId = nextCommandId(),
): Promise<{ requestBody: Record<string, unknown>; ack: CommandAck }> {
  const requestBody = { protocolVersion: 1, commandId, matchId, expectedVersion, type, payload };
  const response = await routeApiRequest(request(`/api/matches/${encodeURIComponent(matchId)}/commands`, {
    cookie: guest.cookie,
    body: requestBody,
  }), { DB: db });
  return { requestBody, ack: assertAck(await json(response)) };
}

async function completeTurnDrawIfNeeded(db: D1DatabaseLike, matchId: string, guests: readonly Guest[]): Promise<void> {
  const repository = new D1StorageRepository(db);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const match = await repository.getMatch(matchId);
    assert.ok(match);
    if (match.state.turn.phase === "play") return;
    const pending = match.state.resolution.pendingInteraction;
    assert.ok(pending, `initial ${match.state.turn.phase} continuation must expose a canonical response`);
    const actorId = pending.actorPlayerIds[0] ?? match.state.turn.currentPlayerId;
    assert.ok(pending.actorPlayerIds.includes(actorId));
    const actor = guests.find((guest) => guest.playerId === actorId);
    assert.ok(actor);
    const option = pending.options[0];
    assert.ok(option, "canonical initial draw must provide at least one response option");
    const response = await matchCommand(db, actor, matchId, "RESPOND", match.version, {
      interactionId: pending.interactionId,
      choice: option.choice,
      ...option.payload,
    });
    assert.equal(response.ack.status, "accepted", JSON.stringify(response.ack));
  }
  const completed = await repository.getMatch(matchId);
  assert.ok(completed);
  assert.equal(completed.state.turn.phase, "play", "canonical turn draw continuation must reach the play phase");
}

async function giveCardFromDeckToHand(db: D1DatabaseLike, matchId: string, playerId: string, typeId: string): Promise<void> {
  const repository = new D1StorageRepository(db);
  const match = await repository.getMatch(matchId);
  assert.ok(match);
  const state: GameState = structuredClone(match.state);
  const definitions = new Set(BASE_PHYSICAL_CARDS.filter((card) => card.typeId === typeId).map((card) => card.definitionId));
  const index = state.zones.drawPileCardInstanceIds.findIndex((id) => definitions.has(state.zones.cardsByInstanceId[id]!.cardDefinitionId));
  assert.notEqual(index, -1, `fixture deck must contain a ${typeId} card`);
  const [cardInstanceId] = state.zones.drawPileCardInstanceIds.splice(index, 1);
  const seat = state.seats.find((candidate) => candidate.public.playerId === playerId)!;
  seat.private.handCardInstanceIds.push(cardInstanceId!);
  await db.prepare("UPDATE matches SET state_json = ? WHERE id = ? AND version = ?")
    .bind(JSON.stringify(state), matchId, match.version).run();
  assert.ok(await repository.getMatch(matchId), "fixture state must pass the normal D1 schema validation");
}

async function insertOutbox(
  db: D1DatabaseLike,
  matchId: string,
  version: number,
  eventSeq: number,
  eventId: string,
  extra?: Record<string, unknown>,
): Promise<number> {
  const payload = { matchId, version, eventSeq, ...extra };
  await db.prepare(`
    INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
    VALUES (?, ?, ?, ?, 'match:changed', ?)
  `).bind(eventId, matchId, version, eventSeq, JSON.stringify(payload)).run();
  const row = await db.prepare("SELECT MAX(cursor) AS cursor FROM outbox").first<{ cursor: number | string }>();
  return Number(row?.cursor ?? 0);
}

function membershipOrderSpy(db: D1DatabaseLike): {
  db: D1DatabaseLike;
  stats: { membershipQueries: number; outboxQueries: number; cursorBeforeMembership: boolean };
} {
  const stats = { membershipQueries: 0, outboxQueries: 0, cursorBeforeMembership: false };
  const wrapped: D1DatabaseLike = {
    prepare(query) {
      if (/FROM\s+(?:room_players|match_players)/iu.test(query)) stats.membershipQueries += 1;
      if (/FROM\s+outbox/iu.test(query)) {
        stats.outboxQueries += 1;
        if (stats.membershipQueries === 0) stats.cursorBeforeMembership = true;
        stats.membershipQueries = 0;
      }
      return db.prepare(query);
    },
    batch(statements) { return db.batch(statements); },
    exec(query) { return db.exec(query); },
  };
  return { db: wrapped, stats };
}

function bindingCountSpy(db: D1DatabaseLike): {
  db: D1DatabaseLike;
  stats: { directCalls: number; batchCalls: number; batchSizes: number[] };
} {
  const stats = { directCalls: 0, batchCalls: 0, batchSizes: [] as number[] };
  const rawStatements = new WeakMap<object, ReturnType<D1DatabaseLike["prepare"]>>();
  const wrap = (statement: ReturnType<D1DatabaseLike["prepare"]>) => {
    const wrapped = {
      bind(...values: Parameters<typeof statement.bind>) {
        return wrap(statement.bind(...values));
      },
      first<T>(columnName?: string) {
        stats.directCalls += 1;
        return statement.first<T>(columnName);
      },
      all<T>() {
        stats.directCalls += 1;
        return statement.all<T>();
      },
      run<T>() {
        stats.directCalls += 1;
        return statement.run<T>();
      },
    };
    rawStatements.set(wrapped, statement);
    return wrapped;
  };
  const countedDb: D1DatabaseLike = {
    prepare(query) { return wrap(db.prepare(query)); },
    batch(statements) {
      stats.batchCalls += 1;
      stats.batchSizes.push(statements.length);
      return db.batch(statements.map((statement) => rawStatements.get(statement) ?? statement));
    },
    exec(query) { return db.exec(query); },
  };
  return { db: countedDb, stats };
}

async function readChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs = 1_500,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("SSE stream did not produce a chunk in time.")), timeoutMs);
    reader.read().then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

async function readSseEventNamed(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  eventName: string,
  timeoutMs = 1_500,
): Promise<Uint8Array> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const chunk = (await readChunkWithTimeout(reader, timeoutMs)).value;
    if (!chunk) throw new Error("SSE stream closed before the expected event.");
    const raw = new TextDecoder().decode(chunk);
    if (raw.includes(`event: ${eventName}\n`)) return chunk;
  }
  throw new Error(`SSE stream did not produce event '${eventName}'.`);
}

function parseSseEvent(chunk: Uint8Array): { id: number; data: Record<string, unknown>; raw: string } {
  const raw = new TextDecoder().decode(chunk);
  const idMatch = raw.match(/^id: (\d+)$/mu);
  const dataMatch = raw.match(/^data: (.+)$/mu);
  assert.ok(idMatch && dataMatch, `expected an SSE invalidation event, received ${raw}`);
  return { id: Number(idMatch[1]), data: JSON.parse(dataMatch[1]!) as Record<string, unknown>, raw };
}

test("Worker match commands resolve effects and turn continuations with atomic receipts and stale no-write behavior", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    let match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const actorId = match.state.turn.currentPlayerId;
    const actor = fixture.guests.find((guest) => guest.playerId === actorId)!;
    await giveCardFromDeckToHand(db, fixture.matchId, actorId, "bang");
    match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const bangCard = match.state.seats.find((seat) => seat.public.playerId === actorId)!.private.handCardInstanceIds.at(-1)!;
    const legalBang = buildLegalActionCandidates(match.state, actorId).find((candidate) =>
      candidate.type === "PLAY_CARD" && candidate.payload.cardInstanceId === bangCard && candidate.payload.targetPlayerId,
    );
    assert.ok(legalBang?.type === "PLAY_CARD" && legalBang.payload.targetPlayerId,
      `canonical legal-action generation must find a legal target for the fixture BANG! card: ${JSON.stringify({ turn: match.state.turn, status: match.state.status, actor: match.state.seats.find((seat) => seat.public.playerId === actorId), proposals: buildLegalActionCandidates(match.state, actorId) })}`);
    const target = fixture.guests.find((guest) => guest.playerId === legalBang.payload.targetPlayerId)!;
    const startingTargetHp = match.state.seats.find((seat) => seat.public.playerId === target.playerId)!.public.hp;

    const attacked = await matchCommand(db, actor, fixture.matchId, "PLAY_CARD", match.version, {
      ...legalBang.payload,
    });
    assert.equal(attacked.ack.status, "accepted", JSON.stringify(attacked.ack));
    const afterAttack = await repository.getMatch(fixture.matchId);
    assert.ok(afterAttack);
    assert.equal(afterAttack.state.resolution.pendingInteraction?.kind, "BANG_RESPONSE");
    const pendingId = afterAttack.state.resolution.pendingInteraction!.interactionId;

    const defended = await matchCommand(db, target, fixture.matchId, "RESPOND", afterAttack.version, {
      interactionId: pendingId,
      choice: "TAKE_HIT",
    });
    assert.equal(defended.ack.status, "accepted");
    let afterResponse = await repository.getMatch(fixture.matchId);
    assert.ok(afterResponse);
    assert.equal(afterResponse.state.resolution.pendingInteraction, null);
    assert.equal(afterResponse.state.seats.find((seat) => seat.public.playerId === target.playerId)!.public.hp, startingTargetHp - 1);

    const turnBeforeEnd = afterResponse.state.turn;
    const handCountsBeforeEnd = new Map(afterResponse.state.seats.map((seat) =>
      [seat.public.playerId, seat.private.handCardInstanceIds.length] as const));
    const endTurn = await matchCommand(db, actor, fixture.matchId, "END_TURN", afterResponse.version, {});
    assert.equal(endTurn.ack.status, "accepted");
    const afterEndTurn = await repository.getMatch(fixture.matchId);
    assert.ok(afterEndTurn);
    assert.equal(afterEndTurn.state.turn.phase, "discard", "the added card should open the canonical hand-limit interaction");
    const discardPrompt = afterEndTurn.state.resolution.pendingInteraction;
    assert.equal(discardPrompt?.kind, "DISCARDS_ORDER");
    assert.ok(discardPrompt);
    const rawDiscardOrder = discardPrompt.context.discardOrder;
    assert.ok(rawDiscardOrder && typeof rawDiscardOrder === "object" && !Array.isArray(rawDiscardOrder));
    const requiredCountValue = rawDiscardOrder.requiredCount;
    assert.equal(typeof requiredCountValue, "number");
    const requiredCount = requiredCountValue as number;
    const allowedCardInstanceIdsValue = rawDiscardOrder.allowedCardInstanceIds;
    assert.ok(Array.isArray(allowedCardInstanceIdsValue));
    const orderedCardInstanceIds = allowedCardInstanceIdsValue.filter((id): id is string => typeof id === "string").slice(0, requiredCount);
    assert.equal(orderedCardInstanceIds.length, requiredCount);
    const discarded = await matchCommand(db, actor, fixture.matchId, "RESPOND", afterEndTurn.version, {
      interactionId: discardPrompt.interactionId,
      choice: "ORDER_CARDS",
      orderedCardInstanceIds,
    });
    assert.equal(discarded.ack.status, "accepted");
    await completeTurnDrawIfNeeded(db, fixture.matchId, fixture.guests);
    const afterDiscard = await repository.getMatch(fixture.matchId);
    assert.ok(afterDiscard);
    assert.ok(afterDiscard.state.turn.turnNumber > turnBeforeEnd.turnNumber,
      "completing the canonical discard order must advance the turn number");
    assert.equal(afterDiscard.state.turn.phase, "play", "turn start/draw continuation should finish before the discard response is acknowledged");
    const nextActor = afterDiscard.state.seats.find((seat) => seat.public.playerId === afterDiscard.state.turn.currentPlayerId)!;
    const discardedForNextActor = nextActor.public.playerId === actorId ? requiredCount : 0;
    assert.ok(nextActor.private.handCardInstanceIds.length >= handCountsBeforeEnd.get(nextActor.public.playerId)! - discardedForNextActor + 2,
      "turn-start draw continuation should draw two cards before acknowledging END_TURN");

    const eventCountBeforeReplay = await countRows(db, "match_events");
    const outboxCountBeforeReplay = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ? AND kind = 'match:changed'")
      .bind(fixture.matchId).first<{ count: number | string }>();
    const replayResponse = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: actor.cookie,
      body: endTurn.requestBody,
    }), { DB: db });
    const replayAck = assertAck(await json(replayResponse));
    assert.equal(replayAck.status, "accepted");
    if (replayAck.status === "accepted") assert.equal(replayAck.duplicate, true);
    const reused = await matchCommand(db, actor, fixture.matchId, "END_TURN", (endTurn.requestBody.expectedVersion as number) + 1, {}, endTurn.requestBody.commandId as string);
    assert.equal(reused.ack.status, "rejected");
    if (reused.ack.status === "rejected") assert.equal(reused.ack.error.code, "COMMAND_ID_REUSED");
    assert.equal(await countRows(db, "match_events"), eventCountBeforeReplay);
    const outboxCountAfterReplay = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ? AND kind = 'match:changed'")
      .bind(fixture.matchId).first<{ count: number | string }>();
    assert.equal(Number(outboxCountAfterReplay?.count), Number(outboxCountBeforeReplay?.count));

    const current = await repository.getMatch(fixture.matchId);
    assert.ok(current);
    const matchOutboxBeforeStale = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ? AND kind = 'match:changed'")
      .bind(fixture.matchId).first<{ count: number | string }>();
    const eventCountBeforeStale = await countRows(db, "match_events");
    const stale = await matchCommand(db, actor, fixture.matchId, "END_TURN", current.version - 1, {});
    assert.equal(stale.ack.status, "rejected");
    if (stale.ack.status === "rejected") {
      assert.equal(stale.ack.error.code, "STALE_VERSION");
      assert.equal(stale.ack.error.currentVersion, current.version);
    }
    const afterStale = await repository.getMatch(fixture.matchId);
    assert.ok(afterStale);
    assert.equal(afterStale.version, current.version);
    assert.equal(afterStale.eventSeq, current.eventSeq);
    assert.equal(await countRows(db, "match_events"), eventCountBeforeStale);
    const matchOutboxAfterStale = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ? AND kind = 'match:changed'")
      .bind(fixture.matchId).first<{ count: number | string }>();
    assert.equal(Number(matchOutboxAfterStale?.count), Number(matchOutboxBeforeStale?.count));
  } finally {
    await runtime.dispose();
  }
});

test("accepted match commands use one authorization context batch and one atomic commit batch", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    const match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const actor = fixture.guests.find((guest) => guest.playerId === match.state.turn.currentPlayerId)!;
    const commandBody = {
      protocolVersion: 1,
      commandId: nextCommandId(),
      matchId: fixture.matchId,
      expectedVersion: match.version,
      type: "END_TURN",
      payload: {},
    };
    const spy = bindingCountSpy(db);
    const first = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: actor.cookie,
      body: commandBody,
    }), { DB: spy.db });
    assert.equal(first.status, 200);
    const firstAck = assertAck(await json(first));
    assert.equal(firstAck.status, "accepted");
    assert.deepEqual({ directCalls: spy.stats.directCalls, batchCalls: spy.stats.batchCalls },
      { directCalls: 1, batchCalls: 2 }, "session auth + one 3-query auth/receipt/state snapshot + one atomic write batch");
    assert.equal(spy.stats.batchSizes[0], 3);
    assert.ok((spy.stats.batchSizes[1] ?? 0) >= 5, "commit batch contains guard, state, receipt, outbox and cleanup");

    spy.stats.directCalls = 0;
    spy.stats.batchCalls = 0;
    spy.stats.batchSizes.length = 0;
    const replay = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: actor.cookie,
      body: commandBody,
    }), { DB: spy.db });
    assert.equal(replay.status, 200);
    const replayAck = assertAck(await json(replay));
    assert.equal(replayAck.status, "accepted");
    if (replayAck.status === "accepted") assert.equal(replayAck.duplicate, true);
    assert.deepEqual({ directCalls: spy.stats.directCalls, batchCalls: spy.stats.batchCalls },
      { directCalls: 1, batchCalls: 1 }, "receipt replay still authenticates membership before decoding the receipt");
    assert.deepEqual(spy.stats.batchSizes, [3]);
  } finally {
    await runtime.dispose();
  }
});

test("match membership revoked after command load prevents the atomic commit", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    const before = await repository.getMatch(fixture.matchId);
    assert.ok(before);
    const actor = fixture.guests.find((guest) => guest.playerId === before.state.turn.currentPlayerId)!;
    const eventCount = await countRows(db, "match_events");
    const receiptCount = await countRows(db, "command_receipts");
    const outboxCount = await countRows(db, "outbox");
    let batchCalls = 0;
    const revokeBetweenReadAndCommit: D1DatabaseLike = {
      prepare(query) { return db.prepare(query); },
      async batch(statements) {
        batchCalls += 1;
        if (batchCalls === 2) {
          await db.prepare("DELETE FROM match_players WHERE match_id = ? AND player_id = ?")
            .bind(fixture.matchId, actor.playerId).run();
        }
        return db.batch(statements);
      },
      exec(query) { return db.exec(query); },
    };
    const response = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: actor.cookie,
      body: {
        protocolVersion: 1,
        commandId: nextCommandId(),
        matchId: fixture.matchId,
        expectedVersion: before.version,
        type: "END_TURN",
        payload: {},
      },
    }), { DB: revokeBetweenReadAndCommit });
    const ack = assertAck(await json(response));
    assert.equal(ack.status, "rejected");
    if (ack.status === "rejected") assert.equal(ack.error.code, "NOT_A_PLAYER");
    assert.equal(batchCalls, 2, "the test revokes membership after the batched read and immediately before the commit CAS");
    const after = await repository.getMatch(fixture.matchId);
    assert.ok(after);
    assert.equal(after.version, before.version);
    assert.equal(after.eventSeq, before.eventSeq);
    assert.equal(await countRows(db, "match_events"), eventCount);
    assert.equal(await countRows(db, "command_receipts"), receiptCount);
    assert.equal(await countRows(db, "outbox"), outboxCount);
  } finally {
    await runtime.dispose();
  }
});

test("a command receipt cannot be reused across two authorized matches", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    const original = await repository.getMatch(fixture.matchId);
    assert.ok(original);
    await repository.createMatch({
      id: "match-receipt-reuse-target",
      roomId: fixture.roomId,
      state: original.state,
      players: original.players.map(({ playerId, connectionState }) => ({ playerId, connectionState })),
    });
    const actor = fixture.guests.find((guest) => guest.playerId === original.state.turn.currentPlayerId)!;
    const sharedCommandId = nextCommandId();
    const first = await matchCommand(db, actor, fixture.matchId, "END_TURN", original.version, {}, sharedCommandId);
    assert.equal(first.ack.status, "accepted");

    const otherMatch = await repository.getMatch("match-receipt-reuse-target");
    assert.ok(otherMatch);
    const eventCount = await countRows(db, "match_events");
    const receiptCount = await countRows(db, "command_receipts");
    const outboxCount = await countRows(db, "outbox");
    const reused = await matchCommand(db, actor, "match-receipt-reuse-target", "END_TURN", otherMatch.version, {}, sharedCommandId);
    assert.equal(reused.ack.status, "rejected");
    if (reused.ack.status === "rejected") assert.equal(reused.ack.error.code, "COMMAND_ID_REUSED");
    const after = await repository.getMatch("match-receipt-reuse-target");
    assert.ok(after);
    assert.equal(after.version, otherMatch.version);
    assert.equal(await countRows(db, "match_events"), eventCount);
    assert.equal(await countRows(db, "command_receipts"), receiptCount);
    assert.equal(await countRows(db, "outbox"), outboxCount);
  } finally {
    await runtime.dispose();
  }
});

test("D1 expected-version CAS allows one writer for concurrent match commands", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    const before = await repository.getMatch(fixture.matchId);
    assert.ok(before);
    const actor = fixture.guests.find((guest) => guest.playerId === before.state.turn.currentPlayerId)!;
    const matchOutboxBefore = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ? AND kind = 'match:changed'")
      .bind(fixture.matchId).first<{ count: number | string }>();
    const eventCountBefore = await countRows(db, "match_events");

    const commands = [
      matchCommand(db, actor, fixture.matchId, "END_TURN", before.version, {}),
      matchCommand(db, actor, fixture.matchId, "END_TURN", before.version, {}),
    ];
    const results = await Promise.all(commands);
    assert.equal(results.filter(({ ack }) => ack.status === "accepted").length, 1, JSON.stringify(results.map(({ ack }) => ack)));
    assert.equal(results.filter(({ ack }) => ack.status === "rejected" && ack.error.code === "STALE_VERSION").length, 1, JSON.stringify(results.map(({ ack }) => ack)));

    const after = await repository.getMatch(fixture.matchId);
    assert.ok(after);
    assert.equal(after.version, before.version + 1);
    assert.equal(await countRows(db, "match_events") - eventCountBefore, after.eventSeq - before.eventSeq);
    const matchOutboxAfter = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ? AND kind = 'match:changed'")
      .bind(fixture.matchId).first<{ count: number | string }>();
    assert.equal(Number(matchOutboxAfter?.count) - Number(matchOutboxBefore?.count), 1);
  } finally {
    await runtime.dispose();
  }
});

test("stale match cursors receive the recent event tail and an explicit full snapshot", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const match = await new D1StorageRepository(db).getMatch(fixture.matchId);
    assert.ok(match);
    const end = match.eventSeq + 210;
    const statements = Array.from({ length: 210 }, (_, index) => db.prepare(
      "INSERT INTO match_events (event_id, match_id, event_seq, version, type, actor_player_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(`recent-tail-${index}`, match.id, match.eventSeq + index + 1, match.version,
      "BEER_USED", fixture.guests[0]!.playerId, JSON.stringify({ mode: "normal", healed: 0, privateSecret: "omit-this" })));
    await db.batch(statements);
    await db.prepare("UPDATE matches SET event_seq = ?, state_json = ? WHERE id = ?")
      .bind(end, JSON.stringify({ ...match.state, eventSeq: end }), match.id).run();
    for (const cursor of [0, end - 150, end - 2, end + 1]) {
      const response = await routeApiRequest(request(`/api/matches/${match.id}/sync`, {
        cookie: fixture.guests[0]!.cookie,
        body: { protocolVersion: 1, requestId: `tail-${cursor}`, matchId: match.id,
          knownVersion: match.version, afterEventSeq: cursor },
      }), { DB: db });
      const value = await json(response);
      const parsed = parseMatchSyncResponse(value);
      assert.equal(parsed.ok, true);
      if (!parsed.ok) throw new Error("Invalid recent-tail sync.");
      assert.equal(parsed.value.eventSeq, end);
      assert.equal(parsed.value.requiresFullSnapshot, cursor < end - 100 || cursor > end);
      const expected = cursor > end ? [] : Array.from({ length: end - Math.max(cursor, end - 100) },
        (_, i) => Math.max(cursor, end - 100) + i + 1);
      assert.deepEqual(parsed.value.visibleEvents.map(event => event.eventSeq), expected);
      assert.equal(JSON.stringify(value).includes("omit-this"), false);
    }
  } finally {
    await runtime.dispose();
  }
});

test("room and match sync use strict canonical parsers and viewer-scoped private projections", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const outsider = await createGuest(db, "Outside");
    const repository = new D1StorageRepository(db);
    const match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const viewer = fixture.guests[0]!;

    const syncResponse = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
      cookie: viewer.cookie,
      body: { protocolVersion: 1, requestId: "match-view", matchId: fixture.matchId, knownVersion: 0, afterEventSeq: 0 },
    }), { DB: db });
    assert.equal(syncResponse.status, 200);
    const rawMatchSync = await json(syncResponse);
    const matchSyncParse = parseMatchSyncResponse(rawMatchSync);
    assert.equal(matchSyncParse.ok, true);
    if (!matchSyncParse.ok) throw new Error("MatchSyncResponse did not pass its shared parser.");
    const matchSync: MatchSyncResponse = matchSyncParse.value;
    assert.equal(matchSync.snapshot.viewer.playerId, viewer.playerId);
    const matchJson = JSON.stringify(rawMatchSync);
    const hiddenHands = match.state.seats.filter((seat) => seat.public.playerId !== viewer.playerId)
      .flatMap((seat) => seat.private.handCardInstanceIds);
    for (const hiddenId of hiddenHands) assert.equal(matchJson.includes(hiddenId), false);
    const hiddenPlayers = match.state.seats.filter((seat) => seat.public.playerId !== viewer.playerId && !seat.public.roleRevealed);
    for (const seat of hiddenPlayers) {
      assert.equal(matchSync.snapshot.publicTable.players.find((player) => player.playerId === seat.public.playerId)?.role, null);
    }
    assert.equal(matchJson.includes("cardsByInstanceId"), false);
    assert.equal(matchJson.includes("drawPileCardInstanceIds"), false);
    assert.equal(matchJson.includes("resolution"), false);

    const roomSyncResponse = await routeApiRequest(request(`/api/rooms/${encodeURIComponent(fixture.roomId)}/sync`, {
      cookie: viewer.cookie,
      body: { protocolVersion: 1, requestId: "room-view", roomId: fixture.roomId, knownVersion: 0 },
    }), { DB: db });
    const roomSync = await json(roomSyncResponse);
    const roomSyncParsed = parseRoomSyncResponse(roomSync);
    assert.equal(roomSyncParsed.ok, true);
    if (roomSyncParsed.ok) assert.equal(roomSyncParsed.value.room.version, roomSyncParsed.value.version);

    const roomUnchangedResponse = await routeApiRequest(request(`/api/rooms/${encodeURIComponent(fixture.roomId)}/sync`, {
      cookie: viewer.cookie,
      body: {
        protocolVersion: 1, requestId: "room-unchanged", roomId: fixture.roomId,
        knownVersion: roomSyncParsed.ok ? roomSyncParsed.value.version : 0, acceptUnchanged: true,
      },
    }), { DB: db });
    const roomUnchanged = await json(roomUnchangedResponse);
    assert.equal(parseSyncUnchangedResponse(roomUnchanged).ok, true);
    assert.equal(Object.hasOwn(roomUnchanged as object, "room"), false);

    const matchUnchangedResponse = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
      cookie: viewer.cookie,
      body: {
        protocolVersion: 1, requestId: "match-unchanged", matchId: fixture.matchId,
        knownVersion: match.version, afterEventSeq: match.eventSeq, acceptUnchanged: true,
      },
    }), { DB: db });
    const matchUnchanged = await json(matchUnchangedResponse);
    assert.equal(parseSyncUnchangedResponse(matchUnchanged).ok, true);
    assert.equal(Object.hasOwn(matchUnchanged as object, "snapshot"), false);

    const legacyFullResponse = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
      cookie: viewer.cookie,
      body: {
        protocolVersion: 1, requestId: "match-legacy-full", matchId: fixture.matchId,
        knownVersion: match.version, afterEventSeq: match.eventSeq,
      },
    }), { DB: db });
    assert.equal(parseMatchSyncResponse(await json(legacyFullResponse)).ok, true,
      "legacy callers still receive a complete canonical snapshot");

    const unauthorizedMatch = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
      cookie: outsider.cookie,
      body: { protocolVersion: 1, requestId: "outside-match", matchId: fixture.matchId, knownVersion: 0, afterEventSeq: 0 },
    }), { DB: db });
    const matchDenied = assertSyncRejected(await json(unauthorizedMatch), "NOT_FOUND_OR_FORBIDDEN");
    assert.equal(Object.hasOwn(matchDenied, "matchId"), false);
    const unauthorizedRoom = await routeApiRequest(request(`/api/rooms/${encodeURIComponent(fixture.roomId)}/sync`, {
      cookie: outsider.cookie,
      body: { protocolVersion: 1, requestId: "outside-room", roomId: fixture.roomId, knownVersion: 0 },
    }), { DB: db });
    const roomDenied = assertSyncRejected(await json(unauthorizedRoom), "NOT_FOUND_OR_FORBIDDEN");
    assert.equal(Object.hasOwn(roomDenied, "roomId"), false);

    const mismatch = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
      cookie: viewer.cookie,
      body: { protocolVersion: 1, requestId: "path-mismatch", matchId: "different", knownVersion: 0, afterEventSeq: 0 },
    }), { DB: db });
    assertSyncRejected(await json(mismatch), "BAD_REQUEST");
  } finally {
    await runtime.dispose();
  }
});

test("unsupported match schema and ruleset disclose recovery only to members and never mutate state", async () => {
  for (const unsupportedKind of ["schema", "ruleset"] as const) {
    const { runtime, db } = await createIsolatedD1();
    try {
      const fixture = await startedFourPlayerMatch(db);
      const member = fixture.guests[0]!;
      const outsider = await createGuest(db, `Outside ${unsupportedKind}`);
      const repository = new D1StorageRepository(db);
      const match = await repository.getMatch(fixture.matchId);
      assert.ok(match);
      const unsupportedState: GameState = structuredClone(match.state);
      let stateSchemaVersion = unsupportedState.schemaVersion;
      let rulesetVersion = unsupportedState.rulesetVersion;
      if (unsupportedKind === "schema") {
        stateSchemaVersion = 2;
        unsupportedState.schemaVersion = stateSchemaVersion;
      } else {
        rulesetVersion = "base4-ko-online-2.0";
        unsupportedState.rulesetVersion = rulesetVersion;
      }
      await db.prepare(`
        UPDATE matches SET state_schema_version = ?, ruleset_version = ?, state_json = ? WHERE id = ? AND version = ?
      `).bind(stateSchemaVersion, rulesetVersion, JSON.stringify(unsupportedState), fixture.matchId, match.version).run();

      const fingerprint = async () => {
        const row = await db.prepare(`
          SELECT status, version, event_seq, state_schema_version, ruleset_version, state_json, updated_at
          FROM matches WHERE id = ?
        `).bind(fixture.matchId).first<Record<string, unknown>>();
        const events = await db.prepare("SELECT COUNT(*) AS count FROM match_events WHERE match_id = ?")
          .bind(fixture.matchId).first<{ count: number | string }>();
        const outbox = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ?")
          .bind(fixture.matchId).first<{ count: number | string }>();
        const receipts = await db.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE match_id = ?")
          .bind(fixture.matchId).first<{ count: number | string }>();
        return { row, events: Number(events?.count), outbox: Number(outbox?.count), receipts: Number(receipts?.count) };
      };
      const beforeRequests = await fingerprint();

      const memberCommand = await matchCommand(db, member, fixture.matchId, "END_TURN", match.version, {});
      assert.equal(memberCommand.ack.status, "rejected");
      if (memberCommand.ack.status === "rejected") assert.equal(memberCommand.ack.error.code, "RECOVERY_REQUIRED");
      const outsiderCommand = await matchCommand(db, outsider, fixture.matchId, "END_TURN", match.version, {});
      assert.equal(outsiderCommand.ack.status, "rejected");
      if (outsiderCommand.ack.status === "rejected") assert.equal(outsiderCommand.ack.error.code, "NOT_A_PLAYER");

      const memberSync = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
        cookie: member.cookie,
        body: { protocolVersion: 1, requestId: `recovery-member-${unsupportedKind}`, matchId: fixture.matchId, knownVersion: match.version, afterEventSeq: match.eventSeq, acceptUnchanged: true },
      }), { DB: db });
      assert.equal(memberSync.status, 200);
      const memberSyncParsed = parseSyncRejectedResponse(await json(memberSync));
      assert.equal(memberSyncParsed.ok, true);
      if (memberSyncParsed.ok) assert.equal(memberSyncParsed.value.error.code, "RECOVERY_REQUIRED");

      const outsiderSync = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/sync`, {
        cookie: outsider.cookie,
        body: { protocolVersion: 1, requestId: `recovery-outsider-${unsupportedKind}`, matchId: fixture.matchId, knownVersion: match.version, afterEventSeq: match.eventSeq },
      }), { DB: db });
      assert.equal(outsiderSync.status, 200);
      const outsiderSyncParsed = parseSyncRejectedResponse(await json(outsiderSync));
      assert.equal(outsiderSyncParsed.ok, true);
      if (outsiderSyncParsed.ok) assert.equal(outsiderSyncParsed.value.error.code, "NOT_FOUND_OR_FORBIDDEN");

      assert.deepEqual(await fingerprint(), beforeRequests, `${unsupportedKind} recovery paths must not mutate match, events, receipts, or outbox`);
    } finally {
      await runtime.dispose();
    }
  }
});

test("existing successful receipts replay before unsupported snapshot decoding without exposing recovery to outsiders", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    const match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const actor = fixture.guests.find((guest) => guest.playerId === match.state.turn.currentPlayerId)!;
    const outsider = await createGuest(db, "Retry outsider");
    const committed = await matchCommand(db, actor, fixture.matchId, "END_TURN", match.version, {});
    assert.equal(committed.ack.status, "accepted");
    if (committed.ack.status !== "accepted") throw new Error("Initial command must commit before receipt replay is tested.");
    assert.equal(committed.ack.duplicate, false);

    const committedMatch = await repository.getMatch(fixture.matchId);
    assert.ok(committedMatch);
    const unsupportedState: GameState = { ...structuredClone(committedMatch.state), schemaVersion: 2 };
    await db.prepare("UPDATE matches SET state_schema_version = ?, state_json = ? WHERE id = ? AND version = ?")
      .bind(2, JSON.stringify(unsupportedState), fixture.matchId, committedMatch.version).run();

    const fingerprint = async () => {
      const row = await db.prepare(`
        SELECT status, version, event_seq, state_schema_version, ruleset_version, state_json, updated_at
        FROM matches WHERE id = ?
      `).bind(fixture.matchId).first<Record<string, unknown>>();
      const events = await db.prepare("SELECT COUNT(*) AS count FROM match_events WHERE match_id = ?")
        .bind(fixture.matchId).first<{ count: number | string }>();
      const outbox = await db.prepare("SELECT COUNT(*) AS count FROM outbox WHERE aggregate_id = ?")
        .bind(fixture.matchId).first<{ count: number | string }>();
      const receipts = await db.prepare("SELECT COUNT(*) AS count FROM command_receipts WHERE match_id = ?")
        .bind(fixture.matchId).first<{ count: number | string }>();
      return { row, events: Number(events?.count), outbox: Number(outbox?.count), receipts: Number(receipts?.count) };
    };
    const beforeRetries = await fingerprint();

    const replayResponse = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: actor.cookie,
      body: committed.requestBody,
    }), { DB: db });
    const replayAck = assertAck(await json(replayResponse));
    assert.equal(replayAck.status, "accepted");
    if (replayAck.status === "accepted") {
      assert.equal(replayAck.duplicate, true);
      assert.equal(replayAck.aggregateVersion, committed.ack.aggregateVersion);
      assert.equal(replayAck.eventSeq, committed.ack.eventSeq);
    }

    const outsiderReplay = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: outsider.cookie,
      body: committed.requestBody,
    }), { DB: db });
    const outsiderReplayAck = assertAck(await json(outsiderReplay));
    assert.equal(outsiderReplayAck.status, "rejected");
    if (outsiderReplayAck.status === "rejected") assert.equal(outsiderReplayAck.error.code, "NOT_A_PLAYER");

    const newCommand = await matchCommand(db, actor, fixture.matchId, "END_TURN", committed.ack.aggregateVersion, {});
    assert.equal(newCommand.ack.status, "rejected");
    if (newCommand.ack.status === "rejected") assert.equal(newCommand.ack.error.code, "RECOVERY_REQUIRED");
    assert.deepEqual(await fingerprint(), beforeRetries, "retry/recovery checks must not mutate match, events, receipts, or outbox");
  } finally {
    await runtime.dispose();
  }
});

test("receipt replay survives malformed match snapshots, while fresh commands fail without writes", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const repository = new D1StorageRepository(db);
    const match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const actor = fixture.guests.find((guest) => guest.playerId === match.state.turn.currentPlayerId)!;
    const outsider = await createGuest(db, "Outsider");
    const committed = await matchCommand(db, actor, fixture.matchId, "END_TURN", match.version, {});
    assert.equal(committed.ack.status, "accepted");
    if (committed.ack.status !== "accepted") throw new Error("Initial command must be accepted before replay is tested.");
    await db.prepare("UPDATE matches SET state_json = ? WHERE id = ? AND version = ?")
      .bind("{}", fixture.matchId, committed.ack.aggregateVersion).run();

    const fingerprint = async () => {
      const row = await db.prepare(`
        SELECT status, version, event_seq, state_schema_version, ruleset_version, state_json, updated_at
        FROM matches WHERE id = ?
      `).bind(fixture.matchId).first<Record<string, unknown>>();
      return {
        row,
        events: await countRows(db, "match_events"),
        outbox: await countRows(db, "outbox"),
        receipts: await countRows(db, "command_receipts"),
      };
    };
    const before = await fingerprint();

    const replay = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: actor.cookie,
      body: committed.requestBody,
    }), { DB: db });
    const replayAck = assertAck(await json(replay));
    assert.equal(replayAck.status, "accepted");
    if (replayAck.status === "accepted") assert.equal(replayAck.duplicate, true);

    const outsiderReplay = await routeApiRequest(request(`/api/matches/${encodeURIComponent(fixture.matchId)}/commands`, {
      cookie: outsider.cookie,
      body: committed.requestBody,
    }), { DB: db });
    const outsiderAck = assertAck(await json(outsiderReplay));
    assert.equal(outsiderAck.status, "rejected");
    if (outsiderAck.status === "rejected") assert.equal(outsiderAck.error.code, "NOT_A_PLAYER");

    const freshCommand = await matchCommand(db, actor, fixture.matchId, "END_TURN", committed.ack.aggregateVersion, {});
    assert.equal(freshCommand.ack.status, "rejected");
    if (freshCommand.ack.status === "rejected") assert.equal(freshCommand.ack.error.code, "INTERNAL_ERROR");
    assert.deepEqual(await fingerprint(), before, "replay, denial and malformed-snapshot failure must not mutate stored data");
  } finally {
    await runtime.dispose();
  }
});

test("SSE refreshes membership before cursor reads, emits only allowlisted data, and resumes after cancellation", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    const outsider = await createGuest(db, "Outside");
    const repository = new D1StorageRepository(db);
    const match = await repository.getMatch(fixture.matchId);
    assert.ok(match);
    const cursorRow = await db.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM outbox")
      .first<{ cursor: number | string }>();
    const beforeCursor = Number(cursorRow?.cursor ?? 0);
    const firstCursor = await insertOutbox(db, fixture.matchId, match.version, match.eventSeq, "test-sse-first", {
      hiddenRole: "outlaw",
      hand: [{ cardInstanceId: "private-card" }],
      internalContext: { turn: 999 },
    });
    const spy = membershipOrderSpy(db);
    const env = { DB: spy.db };
    const intervals = { pollIntervalMs: 5, heartbeatIntervalMs: 20 };
    const path = `/api/notifications/events?after=${beforeCursor}`;

    const denied = await handleNotificationsRoute(request(`/api/notifications/events?after=${firstCursor}`, {
      method: "GET",
      cookie: outsider.cookie,
    }), env, intervals);
    assert.ok(denied);
    assert.equal(denied.status, 404);
    assert.deepEqual(await json(denied), { error: { code: "NOT_FOUND_OR_FORBIDDEN" } });
    assert.equal(spy.stats.outboxQueries, 0, "an unauthorized cursor must not read outbox rows");

    const invalidCursor = await handleNotificationsRoute(request("/api/notifications/events?after=-1", {
      method: "GET",
      cookie: fixture.guests[0]!.cookie,
    }), env, intervals);
    assert.ok(invalidCursor);
    assert.equal(invalidCursor.status, 400);

    const opened = await handleNotificationsRoute(request(path, {
      method: "GET",
      cookie: fixture.guests[0]!.cookie,
    }), env, intervals);
    assert.ok(opened);
    assert.equal(opened.headers.get("Content-Type"), "text/event-stream; charset=utf-8");
    assert.equal(opened.headers.get("Cache-Control"), "no-store");
    const reader = opened.body!.getReader();
    const presenceChunk = (await readChunkWithTimeout(reader)).value!;
    const presenceRaw = new TextDecoder().decode(presenceChunk);
    assert.match(presenceRaw, /^event: presence\n/u);
    const presence = JSON.parse(presenceRaw.match(/^data: (.+)$/mu)![1]!) as {
      protocolVersion: number; roomId: string; members: { playerId: string; connectionState: string }[];
    };
    assert.equal(presence.protocolVersion, 1);
    assert.equal(presence.roomId, fixture.roomId);
    assert.deepEqual(presence.members.map(({ connectionState }) => connectionState), [
      "connected", "unknown", "unknown", "unknown",
    ]);
    const first = parseSseEvent(await readSseEventNamed(reader, "invalidation"));
    assert.equal(first.id, firstCursor);
    assert.deepEqual(Object.keys(first.data).sort(), ["aggregateId", "eventSeq", "kind", "version"]);
    assert.deepEqual(first.data, {
      kind: "match",
      aggregateId: fixture.matchId,
      version: match.version,
      eventSeq: match.eventSeq,
    });
    assert.equal(first.raw.includes("private-card"), false);
    assert.equal(first.raw.includes("outlaw"), false);
    assert.equal(spy.stats.cursorBeforeMembership, false);
    const readsAtCancel = spy.stats.outboxQueries;
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(spy.stats.outboxQueries, readsAtCancel, "cancel must stop future polling");

    const secondCursor = await insertOutbox(db, fixture.matchId, match.version + 1, match.eventSeq + 1, "test-sse-second");
    const reconnected = await handleNotificationsRoute(request("/api/notifications/events?after=0", {
      method: "GET",
      cookie: fixture.guests[0]!.cookie,
      headers: { "Last-Event-ID": String(firstCursor) },
    }), env, intervals);
    assert.ok(reconnected);
    assert.equal(reconnected.status, 200);
    const reconnectedReader = reconnected.body!.getReader();
    const resumed = parseSseEvent(await readSseEventNamed(reconnectedReader, "invalidation"));
    assert.equal(resumed.id, secondCursor);
    assert.equal(resumed.data.aggregateId, fixture.matchId);
    await reconnectedReader.cancel();
    assert.equal(spy.stats.cursorBeforeMembership, false);

    await db.batch([
      db.prepare("DELETE FROM match_players WHERE match_id = ? AND player_id = ?").bind(fixture.matchId, fixture.guests[0]!.playerId),
      db.prepare("DELETE FROM room_players WHERE room_id = ? AND player_id = ?").bind(fixture.roomId, fixture.guests[0]!.playerId),
    ]);
    const queriesBeforeRevokedReconnect = spy.stats.outboxQueries;
    const revoked = await handleNotificationsRoute(request("/api/notifications/events", {
      method: "GET",
      cookie: fixture.guests[0]!.cookie,
      headers: { "Last-Event-ID": String(secondCursor) },
    }), env, intervals);
    assert.ok(revoked);
    assert.equal(revoked.status, 404);
    assert.equal(spy.stats.outboxQueries, queriesBeforeRevokedReconnect, "removed membership cannot use a saved cursor");
  } finally {
    await runtime.dispose();
  }
});

test("SSE renews only the viewer lease and reports presence lease expiry without disconnect writes", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    let observedAt = Date.now();
    await db.batch([
      db.prepare("UPDATE room_players SET last_presence_at = ? WHERE room_id = ? AND player_id = ?")
        .bind(new Date(observedAt - 44_000).toISOString(), fixture.roomId, fixture.guests[1]!.playerId),
      db.prepare("UPDATE room_players SET last_presence_at = ? WHERE room_id = ? AND player_id = ?")
        .bind(new Date(observedAt - 46_000).toISOString(), fixture.roomId, fixture.guests[2]!.playerId),
    ]);
    const maxCursor = await db.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM outbox")
      .first<{ cursor: number | string }>();
    const opened = await handleNotificationsRoute(request("/api/notifications/events", {
      method: "GET",
      cookie: fixture.guests[0]!.cookie,
      headers: { "Last-Event-ID": String(maxCursor?.cursor ?? 0) },
    }), { DB: db }, { now: () => new Date(observedAt), pollIntervalMs: 10, heartbeatIntervalMs: 20 });
    assert.ok(opened);
    assert.equal(opened.status, 200);
    const reader = opened.body!.getReader();
    const initialRaw = new TextDecoder().decode(await readSseEventNamed(reader, "presence"));
    const initial = JSON.parse(initialRaw.match(/^data: (.+)$/mu)![1]!) as {
      observedAt: string; members: { playerId: string; connectionState: string }[];
    };
    assert.equal(initial.observedAt, new Date(observedAt).toISOString());
    assert.deepEqual(initial.members.map(({ connectionState }) => connectionState), [
      "connected", "connected", "disconnected", "unknown",
    ]);
    assert.deepEqual(new Set(initial.members.map(({ playerId }) => playerId)), new Set(fixture.guests.map(({ playerId }) => playerId)));

    const firstLease = await db.prepare("SELECT last_presence_at FROM room_players WHERE room_id = ? AND player_id = ?")
      .bind(fixture.roomId, fixture.guests[0]!.playerId).first<{ last_presence_at: string | null }>();
    assert.equal(firstLease?.last_presence_at, new Date(observedAt).toISOString());

    observedAt += 2_000;
    const updatedRaw = new TextDecoder().decode(await readSseEventNamed(reader, "presence"));
    const updated = JSON.parse(updatedRaw.match(/^data: (.+)$/mu)![1]!) as {
      members: { playerId: string; connectionState: string }[];
    };
    assert.equal(updated.members.find(({ playerId }) => playerId === fixture.guests[1]!.playerId)?.connectionState, "disconnected");
    const renewedLease = await db.prepare("SELECT last_presence_at FROM room_players WHERE room_id = ? AND player_id = ?")
      .bind(fixture.roomId, fixture.guests[0]!.playerId).first<{ last_presence_at: string | null }>();
    assert.equal(renewedLease?.last_presence_at, firstLease?.last_presence_at, "short polls do not write the lease repeatedly");

    await reader.cancel();
    const leaseAfterCancel = await db.prepare("SELECT last_presence_at FROM room_players WHERE room_id = ? AND player_id = ?")
      .bind(fixture.roomId, fixture.guests[0]!.playerId).first<{ last_presence_at: string | null }>();
    assert.equal(leaseAfterCancel?.last_presence_at, firstLease?.last_presence_at, "closing a stream does not mark another tab disconnected");
  } finally {
    await runtime.dispose();
  }
});

test("SSE keeps active matches on the fast poll after the activity warm window expires", async () => {
  const { runtime, db } = await createIsolatedD1();
  try {
    const fixture = await startedFourPlayerMatch(db);
    let observedAt = Date.now();
    const maxCursor = await db.prepare("SELECT COALESCE(MAX(cursor), 0) AS cursor FROM outbox")
      .first<{ cursor: number | string }>();
    const opened = await handleNotificationsRoute(request("/api/notifications/events", {
      method: "GET",
      cookie: fixture.guests[0]!.cookie,
      headers: { "Last-Event-ID": String(maxCursor?.cursor ?? 0) },
    }), { DB: db }, {
      now: () => new Date(observedAt), pollIntervalMs: 10, idlePollIntervalMs: 500, heartbeatIntervalMs: 2_000,
    });
    assert.ok(opened);
    const reader = opened.body!.getReader();
    await readSseEventNamed(reader, "presence");
    await new Promise((resolve) => setTimeout(resolve, 30));

    observedAt += 16_000;
    const current = await new D1StorageRepository(db).getMatch(fixture.matchId);
    assert.ok(current);
    const cursor = await insertOutbox(db, fixture.matchId, current.version, current.eventSeq, "active-after-warm-window");
    const startedAt = performance.now();
    const invalidation = parseSseEvent(await readSseEventNamed(reader, "invalidation"));
    const delayMs = performance.now() - startedAt;
    assert.equal(invalidation.id, cursor);
    assert.ok(delayMs < 300, `playing match should keep the 10ms test poll after 15s of inactivity; observed ${delayMs.toFixed(1)}ms`);
    await reader.cancel();
  } finally {
    await runtime.dispose();
  }
});
