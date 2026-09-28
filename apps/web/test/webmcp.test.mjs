import assert from "node:assert/strict";
import { test } from "node:test";
import { createBangWebMcpTools, registerBangWebMcpTools } from "../src/app/webmcp.ts";

const room = {
  roomId: "room-1",
  status: "in_game",
  activeMatchId: "match-1",
  ownerPlayerId: "player-1",
  capacity: 4,
  rulesetVersion: "base4-ko-online-1.0",
  members: [{ playerId: "player-1", displayName: "A", seatIndex: 0, ready: true }],
  viewer: { playerId: "player-1", isOwner: true },
};

const snapshot = {
  status: "playing",
  viewer: { playerId: "player-1", seatIndex: 0, mode: "active" },
  publicTable: {
    players: [{
      playerId: "player-1", displayName: "A", seatIndex: 0, characterId: "bart-cassidy",
      hp: 4, maxHp: 4, eliminated: false, handCount: 1, role: null, inPlay: [],
    }],
    turn: { currentPlayerId: "player-1", phase: "play" },
    deckCount: 60,
    publicDiscard: { topCard: null, count: 0 },
  },
  selfPrivate: { role: "outlaw", hand: [{ cardInstanceId: "card-own", typeId: "bang", rank: "A", suit: "SPADES" }] },
  legalActions: [{ type: "END_TURN", payload: {} }],
  pendingInteraction: null,
};

function makeRuntime(overrides = {}) {
  const sentMatchCommands = [];
  const sentRoomCommands = [];
  const createdRoomCommands = [];
  const createdGuestRequests = [];
  const joins = [];
  const rememberedRooms = [];
  const navigations = [];
  let syncVersion = 4;
  const transport = {
    getSnapshot: () => ({ connection: "connected", rooms: {}, matches: {}, pendingCommandIds: [], lastError: null }),
    syncRoom: async (roomId) => ({ protocolVersion: 1, requestId: "request-1", roomId, version: 3, requiresFullSnapshot: false, room }),
    syncMatch: async (matchId) => ({ protocolVersion: 1, requestId: "request-2", matchId, version: syncVersion++, eventSeq: 2, requiresFullSnapshot: false, snapshot, visibleEvents: [] }),
    sendMatchCommand: async (command) => { sentMatchCommands.push(command); return { protocolVersion: 1, commandId: command.commandId, status: "accepted", duplicate: false, aggregateVersion: command.expectedVersion + 1, eventSeq: 3 }; },
    sendRoomCommand: async (command) => { sentRoomCommands.push(command); return { accepted: true, commandId: command.commandId }; },
  };
  const guest = { protocolVersion: 1, player: { playerId: "player-1", displayName: "A" }, sessionExpiresAt: "2099-01-01T00:00:00.000Z" };
  const runtime = {
    transport,
    roomEntryTransport: {
      createGuestSession: async (request) => { createdGuestRequests.push(request); return { ...guest, player: { ...guest.player, displayName: request.displayName } }; },
      restoreGuestSession: async () => guest,
      recoverAssignedSeats: async () => [room],
      createRoom: async (command) => { createdRoomCommands.push(command); return { roomId: "room-created", version: 1, inviteCode: "invite-abc", duplicate: false }; },
      previewInvite: async () => ({ roomId: "room-1", version: 3, occupancy: 1, status: "waiting" }),
      joinRoom: async (command) => { joins.push(command); return room; },
    },
    getSessionRecovery: () => ({ kind: "ready", guest, assignedRooms: [room] }),
    getTransportState: () => ({ connection: "connected", authenticated: true, rooms: {}, matches: {}, pendingCommandIds: [], lastError: null }),
    getInviteCode: () => null,
    rememberCreatedRoom: (result) => { rememberedRooms.push(result); },
    waitForConnection: async () => {},
    getLocation: () => ({ pathname: "/rooms/room-1/game", origin: "https://bang.example" }),
    navigate: (path) => { navigations.push(path); },
    sentMatchCommands,
    sentRoomCommands,
    createdRoomCommands,
    createdGuestRequests,
    joins,
    rememberedRooms,
    navigations,
    setVersion: (version) => { syncVersion = version; },
    ...overrides,
  };
  return runtime;
}

test("WebMCP registers the primary guest, room, current state and match action tools with lifecycle signal", async () => {
  const runtime = makeRuntime();
  const registrations = [];
  const controller = new AbortController();
  const report = await registerBangWebMcpTools({
    modelContext: { registerTool: async (tool, options) => registrations.push({ tool, options }) },
  }, runtime, controller.signal);

  assert.equal(report.supported, true);
  assert.deepEqual(report.registered, [
    "bang.get_current_state", "bang.create_guest_session", "bang.create_room", "bang.join_room",
    "bang.set_ready", "bang.start_match", "bang.perform_match_action",
  ]);
  assert.equal(report.failed.length, 0);
  assert.ok(registrations.every(({ options }) => options.signal === controller.signal));
  assert.equal(registrations[0].tool.inputSchema.additionalProperties, false);
  controller.abort();
  assert.equal(controller.signal.aborted, true);
});

test("unsupported and failing ModelContext registrations leave the game UI usable", async () => {
  const runtime = makeRuntime();
  const unsupported = await registerBangWebMcpTools({}, runtime, new AbortController().signal);
  assert.deepEqual(unsupported, { supported: false, registered: [], failed: [] });

  let attempted = 0;
  const failed = await registerBangWebMcpTools({
    modelContext: { registerTool: async () => { attempted += 1; throw new Error("WebMCP permission disabled"); } },
  }, runtime, new AbortController().signal);
  assert.equal(failed.supported, true);
  assert.equal(failed.registered.length, 0);
  assert.equal(failed.failed.length, 7);
  assert.equal(attempted, 7);
});

test("tool input validation rejects unknown keys and only sends server-projected legal actions", async () => {
  const runtime = makeRuntime();
  const tools = new Map(createBangWebMcpTools(runtime).map((tool) => [tool.name, tool]));
  const createRoom = tools.get("bang.create_room");
  await assert.rejects(createRoom.execute({ capacity: 4, ownerPlayerId: "forged" }), /필드가 올바르지 않습니다/u);

  const perform = tools.get("bang.perform_match_action");
  await assert.rejects(perform.execute({ action: { mode: "LEGAL_ACTION", index: 1 } }), /최신 서버 선택지/u);
  assert.equal(runtime.sentMatchCommands.length, 0);
  runtime.setVersion(4);

  const result = await perform.execute({ action: { mode: "LEGAL_ACTION", index: 0 } });
  assert.equal(runtime.sentMatchCommands.length, 1);
  assert.equal(runtime.sentMatchCommands[0].type, "END_TURN");
  assert.equal(runtime.sentMatchCommands[0].matchId, "match-1");
  assert.equal(runtime.sentMatchCommands[0].expectedVersion, 4);
  assert.equal(result.version, 5);
});

test("guest and room entry tools reuse the existing normalized transport flow", async () => {
  const runtime = makeRuntime();
  const tools = new Map(createBangWebMcpTools(runtime).map((tool) => [tool.name, tool]));

  const guestResult = await tools.get("bang.create_guest_session").execute({ displayName: "  BANG 친구  " });
  assert.equal(guestResult.guest.player.displayName, "BANG 친구");
  assert.equal(runtime.createdGuestRequests[0].displayName, "BANG 친구");
  assert.equal(runtime.createdGuestRequests[0].protocolVersion, 1);

  const roomResult = await tools.get("bang.create_room").execute({ capacity: 5 });
  assert.equal(runtime.createdRoomCommands[0].type, "CREATE_ROOM");
  assert.equal(runtime.createdRoomCommands[0].payload.capacity, 5);
  assert.equal(roomResult.inviteCode, "invite-abc");
  assert.equal(runtime.rememberedRooms.length, 1);
  assert.equal(runtime.navigations.at(-1), "/rooms/room-created");

  const joinResult = await tools.get("bang.join_room").execute({ inviteCode: " invite-abc " });
  assert.equal(runtime.joins[0].type, "JOIN");
  assert.equal(runtime.joins[0].payload.inviteCode, "invite-abc");
  assert.equal(joinResult.room.roomId, "room-1");
  assert.equal(runtime.navigations.at(-1), "/rooms/room-1");
});

test("current state is viewer-scoped and room lobby tools use current versioned commands", async () => {
  const runtime = makeRuntime();
  const tools = new Map(createBangWebMcpTools(runtime).map((tool) => [tool.name, tool]));
  const state = await tools.get("bang.get_current_state").execute({});
  assert.equal(state.room.roomId, "room-1");
  assert.equal(state.match.snapshot.selfPrivate.role, "outlaw");
  assert.equal(JSON.stringify(state).includes("credential"), false);

  await tools.get("bang.set_ready").execute({ ready: true });
  assert.equal(runtime.sentRoomCommands[0].type, "SET_READY");
  assert.equal(runtime.sentRoomCommands[0].expectedVersion, 3);

  await tools.get("bang.start_match").execute({});
  assert.equal(runtime.sentRoomCommands[1].type, "START_MATCH");
  assert.equal(runtime.sentRoomCommands[1].expectedVersion, 3);
});

test("tool discards follow the responder's exact private candidate set and count", async () => {
  const responseSnapshot = {
    ...snapshot,
    pendingInteraction: {
      interactionId: "interaction-1",
      kind: "DISCARDS_ORDER",
      allowedChoices: ["ORDER_CARDS"],
      currentResponderPlayerId: "player-1",
      step: { current: 1, total: 1 },
      responseOptions: [{ interactionId: "interaction-1", choice: "ORDER_CARDS" }],
      discardOrder: {
        requiredCount: 1,
        allowedCards: [{ cardInstanceId: "card-own", typeId: "bang", rank: "A", suit: "SPADES" }],
      },
    },
  };
  const runtime = makeRuntime();
  runtime.transport.syncMatch = async (matchId) => ({
    protocolVersion: 1, requestId: "request-2", matchId, version: 4, eventSeq: 2,
    requiresFullSnapshot: false, snapshot: responseSnapshot, visibleEvents: [],
  });
  const tool = createBangWebMcpTools(runtime).find(({ name }) => name === "bang.perform_match_action");

  await assert.rejects(tool.execute({ action: { mode: "RESPOND", index: 0, orderedCardInstanceIds: ["opponent-card"] } }), /현재 서버가 제시한 카드/u);
  assert.equal(runtime.sentMatchCommands.length, 0);

  await tool.execute({ action: { mode: "RESPOND", index: 0, orderedCardInstanceIds: ["card-own"] } });
  assert.deepEqual(runtime.sentMatchCommands[0].payload, {
    interactionId: "interaction-1", choice: "ORDER_CARDS", orderedCardInstanceIds: ["card-own"],
  });
});
