import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MatchSyncReply,
  MatchSyncRequest,
  RoomSyncReply,
  RoomSyncRequest,
} from "../../../../packages/contracts/src/protocol.ts";
import { initializeGame } from "../../../../packages/engine/src/setup/initialize.ts";
import type { GameState } from "../../../../packages/engine/src/state/types.ts";
import type { AuthenticatedSocketContext, GatewayAck } from "../../src/socket/gateway.ts";
import type {
  MatchEventRecord,
  MatchRecord,
  RoomRecord,
  StorageRepository,
} from "../../src/storage/repository.ts";
import { createSyncProjectionHandlers, syncProjectionInternals } from "../../src/projections/sync.ts";

const FIXED_DATE = new Date("2026-09-28T00:00:00.000Z");

function makeState(): GameState {
  const state = initializeGame({
    players: [
      { playerId: "player-a", displayName: "A" },
      { playerId: "player-b", displayName: "B" },
      { playerId: "player-c", displayName: "C" },
      { playerId: "player-d", displayName: "D" },
    ],
    random: { nextFloat: () => 0 },
  });
  const opponent = state.seats.find(({ public: player }) => player.playerId === "player-b");
  assert.ok(opponent);
  opponent.private.roleId = "renegade";
  opponent.public.roleRevealed = false;

  state.resolution.effectQueue = [{
    effectId: "effect-secret",
    kind: "PRIVATE_EFFECT",
    sourcePlayerId: "player-a",
    targetPlayerId: "player-b",
    sourceCardInstanceId: null,
    payload: { inviteCode: "effect-invite-secret", cardId: "effect-hidden-card-secret" },
  }];
  state.resolution.continuations = [{
    frameId: "frame-secret",
    kind: "PRIVATE_FRAME",
    sourcePlayerId: "player-a",
    sourceCardInstanceId: null,
    payload: { marker: "continuation-secret" },
  }];
  state.resolution.pendingInteraction = {
    interactionId: "interaction-visible-id",
    kind: "DUEL_RESPONSE",
    // Player A is a non-responder, so this private option must not enter their sync view.
    actorPlayerIds: ["player-b"],
    options: [{ choice: "PLAY_BANG", payload: { cardInstanceId: "pending-hidden-card-secret" } }],
    context: { internalMarker: "interaction-secret" },
    resumeFrameId: "frame-secret",
    createdAt: FIXED_DATE.toISOString(),
  };
  return state;
}

function makeMatch(state = makeState(), eventSeq = 3): MatchRecord {
  return {
    id: "match-1",
    roomId: "room-1",
    status: state.status,
    version: 8,
    eventSeq,
    rulesetVersion: state.rulesetVersion,
    stateSchemaVersion: state.schemaVersion,
    state,
    createdAt: FIXED_DATE,
    startedAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    endedAt: null,
    players: state.seats.map(({ public: player }) => ({
      playerId: player.playerId,
      seatIndex: player.seatIndex,
      alive: !player.eliminated,
      eliminatedAt: null,
      connectionState: "connected",
    })),
  };
}

function makeEvents(): MatchEventRecord[] {
  return [
    {
      eventId: "event-private",
      eventSeq: 1,
      version: 7,
      type: "CARD_DRAWN",
      actorPlayerId: "player-b",
      payload: { cardInstanceId: "hidden-opponent-card-secret", playerId: "player-b" },
      createdAt: FIXED_DATE,
    },
    {
      eventId: "event-public",
      eventSeq: 2,
      version: 8,
      type: "BANG_ATTACKED",
      actorPlayerId: "player-a",
      payload: {
        sourceCardInstanceId: "source-card-secret",
        targetPlayerId: "player-b",
        handCardInstanceIds: ["event-private-card-secret"],
        roleId: "renegade",
      },
      createdAt: FIXED_DATE,
    },
    {
      eventId: "event-unknown",
      eventSeq: 3,
      version: 8,
      type: "INTERNAL_RESOLUTION_SNAPSHOT",
      actorPlayerId: null,
      payload: { effectQueue: [{ secret: "event-resolution-secret" }], inviteCode: "event-invite-secret" },
      createdAt: FIXED_DATE,
    },
  ];
}

function makeRoomRecord(playerIds = ["player-a", "player-b", "player-c", "player-d"]): RoomRecord {
  return {
    id: "room-1",
    ownerPlayerId: "player-a",
    inviteCodeHash: "invite-original-secret-hash",
    status: "waiting",
    capacity: 4,
    version: 5,
    createdAt: FIXED_DATE,
    updatedAt: FIXED_DATE,
    players: playerIds.map((playerId, seatIndex) => ({
      playerId,
      seatIndex,
      ready: true,
      joinedAt: FIXED_DATE,
      lastPresenceAt: null,
    })),
  };
}

function makeRoomView(): NonNullable<Awaited<ReturnType<AuthenticatedSocketContext["roomMembership"]>>> {
  return {
    roomId: "room-1",
    status: "waiting",
    activeMatchId: null,
    ownerPlayerId: "player-a",
    capacity: 4,
    rulesetVersion: "base4-ko-online-1.0",
    members: ["player-a", "player-b", "player-c", "player-d"].map((playerId, seatIndex) => ({
      playerId,
      displayName: playerId,
      seatIndex,
      ready: true,
    })),
    viewer: { playerId: "player-a", isOwner: true },
  };
}

function makeContext(options: {
  playerId?: string;
  roomView?: ReturnType<typeof makeRoomView> | null;
  matchMember?: boolean;
} = {}): AuthenticatedSocketContext {
  const playerId = options.playerId ?? "player-a";
  return {
    playerId,
    socket: {} as AuthenticatedSocketContext["socket"],
    roomMembership: async () => options.roomView === undefined ? makeRoomView() : options.roomView,
    matchMembership: async () => options.matchMember ?? true,
    joinLobbyChannel: async () => true,
    joinMatchChannel: async () => true,
  };
}

function captureAck<T>(): { ack: GatewayAck; value: () => T } {
  let response: unknown;
  return {
    ack: (value) => { response = value; },
    value: () => response as T,
  };
}

function matchRequest(overrides: Partial<MatchSyncRequest> = {}): MatchSyncRequest {
  return {
    protocolVersion: 1,
    requestId: "request-match-1",
    matchId: "match-1",
    knownVersion: 7,
    afterEventSeq: 0,
    ...overrides,
  };
}

function roomRequest(overrides: Partial<RoomSyncRequest> = {}): RoomSyncRequest {
  return {
    protocolVersion: 1,
    requestId: "request-room-1",
    roomId: "room-1",
    knownVersion: 4,
    ...overrides,
  };
}

test("match sync rechecks membership and returns only the viewer snapshot plus allowlisted public events", async () => {
  const state = makeState();
  const match = makeMatch(state);
  const events = makeEvents();
  const storage = {
    getRoom: async () => makeRoomRecord(),
    getMatch: async () => match,
    listMatchEvents: async () => events,
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const handlers = createSyncProjectionHandlers({ storage });
  const ack = captureAck<MatchSyncReply>();

  await handlers.matchSync(makeContext(), matchRequest(), ack.ack);

  const response = ack.value();
  assert.equal(response.status, undefined);
  if ("status" in response) assert.fail("authorized sync should succeed");
  assert.equal(response.matchId, "match-1");
  assert.equal(response.version, 8);
  assert.equal(response.eventSeq, 3);
  assert.equal(response.requiresFullSnapshot, true);
  assert.equal(response.snapshot.viewer.playerId, "player-a");
  const viewerSeat = state.seats.find(({ public: player }) => player.playerId === "player-a");
  assert.ok(viewerSeat);
  assert.equal(response.snapshot.selfPrivate?.role, viewerSeat.private.roleId);
  assert.equal(response.snapshot.publicTable.players[1]?.role, null);
  assert.equal(response.snapshot.publicTable.players[1]?.handCount, state.seats[1]?.private.handCardInstanceIds.length);
  assert.equal(response.snapshot.pendingInteraction?.interactionId, "interaction-visible-id");
  assert.deepEqual(response.snapshot.pendingInteraction?.allowedChoices, []);
  assert.deepEqual(response.visibleEvents.map(({ type }) => type), ["BANG_ATTACKED"]);
  assert.deepEqual(response.visibleEvents[0]?.payload, {
    actorPlayerId: "player-a",
    targetPlayerId: "player-b",
  });

  const encoded = JSON.stringify(response);
  for (const secret of [
    "renegade",
    "hidden-opponent-card-secret",
    "source-card-secret",
    "event-private-card-secret",
    "effect-invite-secret",
    "effect-hidden-card-secret",
    "continuation-secret",
    "pending-hidden-card-secret",
    "interaction-secret",
    "event-resolution-secret",
    "event-invite-secret",
    "effectQueue",
    "continuations",
  ]) assert.equal(encoded.includes(secret), false, `response leaked ${secret}`);
});

test("match sync rejects an actor when membership is absent or the saved roster no longer contains them", async () => {
  const match = makeMatch();
  let matchLoads = 0;
  const storage = {
    getRoom: async () => makeRoomRecord(),
    getMatch: async () => { matchLoads += 1; return match; },
    listMatchEvents: async () => makeEvents(),
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const handlers = createSyncProjectionHandlers({ storage });

  const membershipRejected = captureAck<MatchSyncReply>();
  await handlers.matchSync(makeContext({ matchMember: false }), matchRequest(), membershipRejected.ack);
  assert.equal(membershipRejected.value().status, "rejected");
  assert.equal(matchLoads, 0, "unauthorized sync does not load aggregate state");

  const rosterMissingMatch = {
    ...match,
    players: match.players.filter(({ playerId }) => playerId !== "player-a"),
  };
  const rosterStorage = {
    getRoom: async () => makeRoomRecord(),
    getMatch: async () => rosterMissingMatch,
    listMatchEvents: async () => makeEvents(),
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const rosterHandler = createSyncProjectionHandlers({ storage: rosterStorage });
  const rosterRejected = captureAck<MatchSyncReply>();
  await rosterHandler.matchSync(makeContext(), matchRequest(), rosterRejected.ack);
  assert.equal(rosterRejected.value().status, "rejected");
  assert.deepEqual(Object.keys(rosterRejected.value() as object).sort(), ["error", "protocolVersion", "requestId", "status"]);
});

test("match sync flags a truncated or future event cursor for a full snapshot", async () => {
  const match = makeMatch(makeState(), 3);
  const handlers = createSyncProjectionHandlers({
    storage: {
      getRoom: async () => makeRoomRecord(),
      getMatch: async () => match,
      listMatchEvents: async (_matchId: string, afterEventSeq = 0) =>
        makeEvents().filter((event) => event.eventSeq > afterEventSeq).slice(1),
    } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">,
  });

  const truncated = captureAck<MatchSyncReply>();
  await handlers.matchSync(makeContext(), matchRequest({ knownVersion: 8, afterEventSeq: 0 }), truncated.ack);
  assert.equal((truncated.value() as Extract<MatchSyncReply, { matchId: string }>).requiresFullSnapshot, true);

  const future = captureAck<MatchSyncReply>();
  await handlers.matchSync(makeContext(), matchRequest({ knownVersion: 8, afterEventSeq: 9 }), future.ack);
  assert.equal((future.value() as Extract<MatchSyncReply, { matchId: string }>).requiresFullSnapshot, true);
  assert.deepEqual((future.value() as Extract<MatchSyncReply, { matchId: string }>).visibleEvents, []);

  assert.equal(syncProjectionInternals.cursorIsReplayable(0, 3, makeEvents()), true);
  assert.equal(syncProjectionInternals.cursorIsReplayable(1, 3, makeEvents().slice(1)), true);
  assert.equal(syncProjectionInternals.cursorIsReplayable(0, 3, makeEvents().slice(1)), false);
  assert.equal(syncProjectionInternals.cursorIsReplayable(4, 3, []), false);
});

test("room sync rechecks both authenticated view and persisted membership without returning invite material", async () => {
  const storage = {
    getRoom: async () => makeRoomRecord(),
    getMatch: async () => makeMatch(),
    listMatchEvents: async () => [],
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const handlers = createSyncProjectionHandlers({ storage });
  const ack = captureAck<RoomSyncReply>();

  await handlers.roomSync(makeContext(), roomRequest(), ack.ack);

  const response = ack.value();
  assert.equal(response.status, undefined);
  if ("status" in response) assert.fail("authorized room sync should succeed");
  assert.equal(response.version, 5);
  assert.equal(response.requiresFullSnapshot, true);
  assert.equal(response.room.viewer.playerId, "player-a");
  assert.equal(response.room.activeMatchId, null);
  const encoded = JSON.stringify(response);
  assert.equal(encoded.includes("invite-original-secret-hash"), false);
  assert.equal(encoded.includes("inviteCode"), false);

  const unchanged = captureAck<RoomSyncReply>();
  await handlers.roomSync(makeContext(), roomRequest({ knownVersion: 5 }), unchanged.ack);
  assert.equal((unchanged.value() as Extract<RoomSyncReply, { roomId: string }>).requiresFullSnapshot, false);
});

test("room sync carries the persisted active match route after START_MATCH", async () => {
  const roomView = {
    ...makeRoomView(),
    status: "in_game" as const,
    activeMatchId: "match-started-exactly-once",
  };
  const storage = {
    getRoom: async () => ({ ...makeRoomRecord(), status: "in_game" as const }),
    getMatch: async () => makeMatch(),
    listMatchEvents: async () => [],
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const handlers = createSyncProjectionHandlers({ storage });
  const ack = captureAck<RoomSyncReply>();

  await handlers.roomSync(makeContext({ roomView }), roomRequest(), ack.ack);

  const response = ack.value();
  assert.equal("status" in response, false);
  if ("status" in response) assert.fail("authorized room sync should succeed");
  assert.equal(response.room.status, "in_game");
  assert.equal(response.room.activeMatchId, "match-started-exactly-once");
});

test("room sync rejects a missing membership without disclosing the room ID", async () => {
  const storage = {
    getRoom: async () => makeRoomRecord(),
    getMatch: async () => makeMatch(),
    listMatchEvents: async () => [],
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const handlers = createSyncProjectionHandlers({ storage });
  const ack = captureAck<RoomSyncReply>();

  await handlers.roomSync(makeContext({ roomView: null }), roomRequest(), ack.ack);

  const response = ack.value();
  assert.equal(response.status, "rejected");
  assert.deepEqual(Object.keys(response as object).sort(), ["error", "protocolVersion", "requestId", "status"]);
});

test("room sync rejects when persisted membership has expired after an earlier member view", async () => {
  const storage = {
    getRoom: async () => makeRoomRecord(["player-b", "player-c", "player-d"]),
    getMatch: async () => makeMatch(),
    listMatchEvents: async () => [],
  } as unknown as Pick<StorageRepository, "getRoom" | "getMatch" | "listMatchEvents">;
  const handlers = createSyncProjectionHandlers({ storage });
  const ack = captureAck<RoomSyncReply>();

  await handlers.roomSync(makeContext(), roomRequest(), ack.ack);

  const response = ack.value();
  assert.equal(response.status, "rejected");
  assert.deepEqual(Object.keys(response as object).sort(), ["error", "protocolVersion", "requestId", "status"]);
});
