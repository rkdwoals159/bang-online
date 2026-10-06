import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLIENT_PROTOCOL_EVENT_NAMES,
  installSocketGateway,
  type AuthenticatedSocketContext,
  type GatewayAck,
  type GatewayHandlers,
  type GatewayIo,
  type GatewaySocket,
  type RoomServiceForGateway,
  type SocketGatewayOptions,
} from "../../src/socket/gateway.ts";
import { InviteRateLimiter } from "../../src/socket/invite-rate-limiter.ts";
import { parseMatchSyncRequest, parseRoomSyncRequest } from "../../../../packages/contracts/src/validation.ts";
import type { RoomView } from "../../../../packages/contracts/src/protocol.ts";

type EventListener = (...args: unknown[]) => void;
type AnyListener = (eventName: string, ...args: unknown[]) => void;
type Middleware = (socket: GatewaySocket, next: (error?: Error) => void) => void;
type ConnectionListener = (socket: GatewaySocket) => void;

class FakeSocket implements GatewaySocket {
  readonly handshake: GatewaySocket["handshake"];
  readonly data: Record<string, unknown> = {};
  readonly events = new Map<string, EventListener[]>();
  readonly anyListeners: AnyListener[] = [];
  readonly channels = new Set<string>();
  disconnected = false;

  constructor(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    address: string,
  ) {
    this.handshake = { headers, address };
  }

  on(event: string, listener: EventListener): this {
    const listeners = this.events.get(event) ?? [];
    listeners.push(listener);
    this.events.set(event, listeners);
    return this;
  }

  onAny(listener: AnyListener): this {
    this.anyListeners.push(listener);
    return this;
  }

  join(channel: string): void {
    this.channels.add(channel);
  }

  disconnect(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    for (const listener of this.events.get("disconnect") ?? []) listener("io server disconnect");
  }

  receive(eventName: string, ...args: unknown[]): void {
    for (const listener of this.anyListeners) listener(eventName, ...args);
    if (this.disconnected) return;
    for (const listener of this.events.get(eventName) ?? []) listener(...args);
  }
}

class FakeIo implements GatewayIo {
  middleware?: Middleware;
  connectionListener?: ConnectionListener;

  use(middleware: Middleware): this {
    this.middleware = middleware;
    return this;
  }

  on(event: "connection", listener: ConnectionListener): this {
    assert.equal(event, "connection");
    this.connectionListener = listener;
    return this;
  }

  async connect(
    headers: Readonly<Record<string, string | readonly string[] | undefined>>,
    address = "203.0.113.10",
  ): Promise<{
    socket: FakeSocket;
    error?: Error;
  }> {
    const socket = new FakeSocket(headers, address);
    let error: Error | undefined;
    await new Promise<void>((resolve) => {
      this.middleware!(socket, (middlewareError) => {
        error = middlewareError;
        if (!middlewareError) this.connectionListener!(socket);
        resolve();
      });
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return { socket, error };
  }
}

function roomView(roomId: string, playerId: string, status: RoomView["status"] = "waiting"): RoomView {
  return {
    roomId,
    status,
    activeMatchId: status === "in_game" || status === "paused" || status === "completed" ? "match-1" : null,
    ownerPlayerId: playerId,
    capacity: 4,
    rulesetVersion: "base4-ko-online-1.0",
    members: [{ playerId, displayName: "Guest", seatIndex: 0, ready: false }],
    viewer: { playerId, isOwner: true },
  };
}

function acceptedAck(commandId = "00000000-0000-4000-8000-000000000001"): Record<string, unknown> {
  return {
    protocolVersion: 1,
    commandId,
    status: "accepted",
    duplicate: false,
    aggregateVersion: 1,
    eventSeq: 1,
  };
}

function createHarness(overrides: {
  credential?: string | null;
  playerIdsByCredential?: Readonly<Record<string, string>>;
  room?: RoomView | null;
  matchMember?: boolean;
  handlers?: Partial<GatewayHandlers>;
  inviteRateLimiter?: InviteRateLimiter;
} = {}) {
  const calls: Array<{ name: string; value?: unknown }> = [];
  let currentRoom = overrides.room === undefined ? roomView("room-1", "player-1") : overrides.room;
  let matchMember = overrides.matchMember ?? true;
  const roomService: RoomServiceForGateway = {
    authenticateGuestCredential: async (credential) => {
      calls.push({ name: "authenticate", value: credential });
      const playerId = overrides.playerIdsByCredential?.[credential] ?? (
        overrides.credential !== null && credential === (overrides.credential ?? "secret-token")
          ? "player-1"
          : undefined
      );
      if (!playerId) return null;
      return { playerId, displayName: "Guest", expiresAt: new Date("2026-09-27T00:00:00.000Z") };
    },
    roomViewForMember: async (roomId, playerId) => {
      calls.push({ name: "roomMembership", value: { roomId, playerId } });
      return currentRoom?.roomId === roomId && currentRoom.members.some((member) => member.playerId === playerId)
        ? currentRoom
        : null;
    },
    previewInvite: async (inviteCode) => {
      calls.push({ name: "previewInvite", value: inviteCode });
      return inviteCode === "valid-invite"
        ? { roomId: "room-preview", version: 3, occupancy: 2, status: "waiting" }
        : null;
    },
  };

  const handlers: GatewayHandlers = {
    roomCreate(context, command, ack) {
      calls.push({ name: "roomCreate", value: { playerId: context.playerId, command } });
      ack(acceptedAck(command.commandId));
    },
    roomCommand(context, command, ack) {
      calls.push({ name: "roomCommand", value: { playerId: context.playerId, command } });
      ack(acceptedAck(command.commandId));
    },
    matchCommand(context, command, ack) {
      calls.push({ name: "matchCommand", value: { playerId: context.playerId, command } });
      ack(acceptedAck(command.commandId));
    },
    roomSync(context, request, ack) {
      calls.push({ name: "roomSync", value: { playerId: context.playerId, request } });
      ack({ protocolVersion: 1, requestId: request.requestId, roomId: request.roomId });
    },
    matchSync(context, request, ack) {
      calls.push({ name: "matchSync", value: { playerId: context.playerId, request } });
      ack({ protocolVersion: 1, requestId: request.requestId, matchId: request.matchId });
    },
    disconnected(playerId, reason) {
      calls.push({ name: "disconnected", value: { playerId, reason } });
    },
    ...overrides.handlers,
  };

  const io = new FakeIo();
  const options: SocketGatewayOptions = {
    roomService,
    authorizeMatchMember: async (playerId, matchId) => {
      calls.push({ name: "matchMembership", value: { playerId, matchId } });
      return matchMember;
    },
    handlers,
    ...(overrides.inviteRateLimiter === undefined ? {} : { inviteRateLimiter: overrides.inviteRateLimiter }),
    sessionCookieName: "guest_session",
  };
  installSocketGateway(io, options);
  return {
    io,
    calls,
    roomService,
    handlers,
    setRoom(room: RoomView | null) { currentRoom = room; },
    setMatchMember(value: boolean) { matchMember = value; },
  };
}

function ackCapture(): { ack: GatewayAck; values: unknown[] } {
  const values: unknown[] = [];
  return { ack: (value) => values.push(value), values };
}

const commandId = "00000000-0000-4000-8000-000000000001";

test("history checks current membership and strict input before invoking its read handler", async () => {
  let historyCalls = 0;
  const harness = createHarness({ handlers: { matchHistory(context, request, ack) {
    historyCalls += 1;
    assert.equal(context.playerId, "player-1");
    ack({ ...request, events: [], nextBeforeEventSeq: null });
  } } });
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const request = { protocolVersion: 1, requestId: "history-1", matchId: "match-1", beforeEventSeq: 120 };
  const received = ackCapture(); socket.receive("match:history", request, received.ack);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal(historyCalls, 1); assert.equal(received.values.length, 1);
  assert.deepEqual(received.values[0], { ...request, events: [], nextBeforeEventSeq: null });
  harness.setMatchMember(false);
  const denied = ackCapture(); socket.receive("match:history", request, denied.ack);
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  assert.equal((denied.values[0] as { error: { code: string } }).error.code, "NOT_FOUND_OR_FORBIDDEN");
  const invalid = ackCapture(); socket.receive("match:history", { ...request, playerId: "spoofed" }, invalid.ack);
  assert.equal((invalid.values[0] as { error: { code: string } }).error.code, "BAD_REQUEST");
  assert.equal(historyCalls, 1);
});

test("handshake authenticates the configured cookie and sets only the server-resolved identity", async () => {
  const harness = createHarness();
  const { socket, error } = await harness.io.connect({ cookie: "other=x; guest_session=secret-token" });

  assert.equal(error, undefined);
  assert.equal(socket.data.playerId, "player-1");
  assert.deepEqual(Object.keys(socket.data), ["playerId"]);
  assert.ok(socket.channels.has("player:player-1"));
  assert.deepEqual(harness.calls[0], { name: "authenticate", value: "secret-token" });
});

test("missing, invalid, expired, and duplicate session cookies fail the handshake", async () => {
  const invalidHarness = createHarness({ credential: null });
  for (const headers of [
    {},
    { cookie: "guest_session=" },
    { cookie: "guest_session=secret-token; guest_session=second-token" },
    { cookie: "guest_session=expired-token" },
    { cookie: "guest_session=%E0%A4%A" },
  ]) {
    const result = await invalidHarness.io.connect(headers);
    assert.equal(result.error?.message, "UNAUTHENTICATED");
    assert.equal(result.socket.data.playerId, undefined);
  }
});

test("room commands are strictly parsed and membership is rechecked before dispatch", async () => {
  const harness = createHarness();
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const accepted = ackCapture();
  const payload = {
    protocolVersion: 1,
    commandId,
    expectedVersion: 0,
    type: "SET_READY",
    roomId: "room-1",
    payload: { ready: true },
  };
  socket.receive("room:command", payload, accepted.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.calls.filter(({ name }) => name === "roomMembership").length, 1);
  assert.equal(harness.calls.filter(({ name }) => name === "roomCommand").length, 1);
  assert.equal((accepted.values[0] as { status: string }).status, "accepted");

  const start = ackCapture();
  socket.receive("room:command", {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000002",
    expectedVersion: 0,
    type: "START_MATCH",
    roomId: "room-1",
    payload: {},
  }, start.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal((start.values[0] as { status: string }).status, "accepted");
  assert.equal(harness.calls.filter(({ name }) => name === "roomCommand").length, 2);
  assert.equal(
    (harness.calls.findLast(({ name }) => name === "roomCommand")?.value as { command: { type: string } }).command.type,
    "START_MATCH",
  );

  harness.setRoom(null);
  const denied = ackCapture();
  socket.receive("room:command", payload, denied.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal((denied.values[0] as { error: { code: string } }).error.code, "NOT_FOUND_OR_FORBIDDEN");
  assert.equal(harness.calls.filter(({ name }) => name === "roomCommand").length, 2);

  const malformed = ackCapture();
  socket.receive("room:command", { ...payload, injected: true }, malformed.ack);
  assert.equal((malformed.values[0] as { error: { code: string } }).error.code, "BAD_REQUEST");
  assert.equal(harness.calls.filter(({ name }) => name === "roomCommand").length, 2);
});

test("JOIN bypasses pre-membership but its handler can join only after T44 confirms membership", async () => {
  const harness = createHarness({ room: roomView("room-1", "player-1", "waiting") });
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const joinCommand = {
    protocolVersion: 1,
    commandId,
    expectedVersion: 1,
    type: "JOIN",
    roomId: "room-1",
    payload: { inviteCode: "invite" },
  };
  let joinAuthorized = false;
  let dispatchedContext: AuthenticatedSocketContext | undefined;
  harness.handlers.roomCommand = async (context, _command, ack) => {
    dispatchedContext = context;
    joinAuthorized = await context.joinLobbyChannel("room-1");
    ack(acceptedAck());
  };
  const ack = ackCapture();
  socket.receive("room:command", joinCommand, ack.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(harness.calls.filter(({ name }) => name === "roomMembership").length, 1);
  assert.equal(joinAuthorized, true);
  assert.ok(socket.channels.has("lobby:room-1"));
  assert.equal((ack.values[0] as { status: string }).status, "accepted");

  harness.setRoom(roomView("room-1", "player-1", "in_game"));
  const rejectedLobbyJoin = await dispatchedContext!.joinLobbyChannel("room-1");
  assert.equal(rejectedLobbyJoin, false, "in-game rooms cannot be joined as lobby channels");
});

test("authenticated room preview needs no membership and returns only the shared success DTO", async () => {
  const harness = createHarness({ room: null });
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const previewAck = ackCapture();
  socket.receive("room:preview", {
    protocolVersion: 1,
    requestId: "preview-1",
    inviteCode: "valid-invite",
  }, previewAck.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));

  assert.equal(socket.disconnected, false);
  assert.deepEqual(previewAck.values[0], {
    protocolVersion: 1,
    requestId: "preview-1",
    roomId: "room-preview",
    version: 3,
    occupancy: 2,
    status: "waiting",
  });
  assert.deepEqual(Object.keys(previewAck.values[0] as object).sort(), [
    "occupancy", "protocolVersion", "requestId", "roomId", "status", "version",
  ]);
  assert.equal("inviteCode" in (previewAck.values[0] as object), false);
  assert.equal("sessionSecret" in (previewAck.values[0] as object), false);
  assert.deepEqual(harness.calls.filter(({ name }) => name === "roomMembership"), []);
  assert.deepEqual(harness.calls.find(({ name }) => name === "previewInvite"), {
    name: "previewInvite",
    value: "valid-invite",
  });
});

test("invalid and unknown preview invites share INVITE_INVALID; malformed preview ACKs BAD_REQUEST without echoing secrets", async () => {
  const harness = createHarness();
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const preview = (inviteCode: string) => {
    const captured = ackCapture();
    socket.receive("room:preview", { protocolVersion: 1, requestId: "preview-same", inviteCode }, captured.ack);
    return captured;
  };
  const invalidCode = preview("wrong-invite");
  const unknownCode = preview("unknown-invite");
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(invalidCode.values[0], {
    protocolVersion: 1,
    requestId: "preview-same",
    status: "rejected",
    error: { code: "INVITE_INVALID" },
  });
  assert.deepEqual(unknownCode.values[0], invalidCode.values[0]);

  const malformed = ackCapture();
  socket.receive("room:preview", {
    protocolVersion: 1,
    requestId: "preview-malformed",
    inviteCode: "raw-invite-must-not-be-echoed",
    sessionSecret: "secret-must-not-be-echoed",
  }, malformed.ack);
  assert.deepEqual(malformed.values[0], {
    protocolVersion: 1,
    requestId: "preview-malformed",
    status: "rejected",
    error: { code: "BAD_REQUEST" },
  });
  assert.equal("inviteCode" in (malformed.values[0] as object), false);
  assert.equal("sessionSecret" in (malformed.values[0] as object), false);
  assert.equal(harness.calls.filter(({ name }) => name === "previewInvite").length, 2,
    "malformed preview payloads must not reach the invite lookup");
});

test("preview failures and invalid JOIN failures share one bucket; the sixth lookup is blocked before dispatch", async () => {
  const harness = createHarness();
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" }, "203.0.113.10");
  let joinLookups = 0;
  harness.handlers.roomCommand = (_context, command, ack) => {
    assert.equal(command.type, "JOIN");
    joinLookups += 1;
    ack({
      protocolVersion: 1,
      commandId: command.commandId,
      status: "rejected",
      error: { code: "INVALID_INVITE", messageKey: "server.invalid_invite", retryable: false },
    });
  };

  for (let index = 0; index < 4; index += 1) {
    const preview = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: `combined-preview-${index}`,
      inviteCode: `wrong-${index}`,
    }, preview.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((preview.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
  }

  const invalidJoin = ackCapture();
  socket.receive("room:command", {
    protocolVersion: 1,
    commandId,
    expectedVersion: 0,
    type: "JOIN",
    roomId: "room-1",
    payload: { inviteCode: "wrong-join-code" },
  }, invalidJoin.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(invalidJoin.values[0], {
    protocolVersion: 1,
    commandId,
    status: "rejected",
    error: { code: "INVITE_INVALID", messageKey: "server.invalid_invite", retryable: false },
  });
  assert.equal(joinLookups, 1);

  const limitedPreview = ackCapture();
  socket.receive("room:preview", {
    protocolVersion: 1,
    requestId: "sixth-preview",
    inviteCode: "must-not-be-looked-up",
  }, limitedPreview.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(limitedPreview.values[0], {
    protocolVersion: 1,
    requestId: "sixth-preview",
    status: "rejected",
    error: { code: "RATE_LIMITED", retryAfterMs: 1_000 },
  });
  assert.equal(harness.calls.filter(({ name }) => name === "previewInvite").length, 4);

  const limitedJoin = ackCapture();
  socket.receive("room:command", {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000002",
    expectedVersion: 0,
    type: "JOIN",
    roomId: "room-1",
    payload: { inviteCode: "also-not-looked-up" },
  }, limitedJoin.ack);
  assert.deepEqual(limitedJoin.values[0], {
    protocolVersion: 1,
    commandId: "00000000-0000-4000-8000-000000000002",
    status: "rejected",
    error: {
      code: "RATE_LIMITED",
      messageKey: "server.rate_limited",
      retryable: true,
      retryAfterMs: 2_000,
    },
  });
  assert.equal(joinLookups, 1, "a limited JOIN does not reach the room command handler");
});

test("malformed JOIN payloads do not consume failed-invite allowance", async () => {
  const harness = createHarness();
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const malformedJoin = ackCapture();
  socket.receive("room:command", {
    protocolVersion: 1,
    commandId,
    expectedVersion: 0,
    type: "JOIN",
    roomId: "room-1",
    payload: { inviteCode: "not-looked-up" },
    unexpected: true,
  }, malformedJoin.ack);
  assert.equal((malformedJoin.values[0] as { error: { code: string } }).error.code, "BAD_REQUEST");

  for (let index = 0; index < 5; index += 1) {
    const preview = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: `valid-state-boundary-${index}`,
      inviteCode: `wrong-${index}`,
    }, preview.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((preview.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
  }
  const sixth = ackCapture();
  socket.receive("room:preview", {
    protocolVersion: 1,
    requestId: "after-malformed-join-sixth",
    inviteCode: "must-be-rate-limited",
  }, sixth.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal((sixth.values[0] as { error: { code: string } }).error.code, "RATE_LIMITED");
  assert.equal(harness.calls.filter(({ name }) => name === "previewInvite").length, 5);
});

test("valid invite JOIN state errors never count as guessing failures", async () => {
  for (const code of ["ROOM_FULL", "ROOM_CLOSED", "STALE_VERSION", "ALREADY_JOINED"]) {
    const harness = createHarness();
    const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
    for (let index = 0; index < 4; index += 1) {
      const priorFailure = ackCapture();
      socket.receive("room:preview", {
        protocolVersion: 1,
        requestId: `${code}-prior-${index}`,
        inviteCode: `wrong-${index}`,
      }, priorFailure.ack);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal((priorFailure.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
    }

    harness.handlers.roomCommand = (_context, command, ack) => {
      assert.equal(command.type, "JOIN");
      ack({
        protocolVersion: 1,
        commandId: command.commandId,
        status: "rejected",
        error: { code, messageKey: `server.${code.toLowerCase()}`, retryable: code === "STALE_VERSION" },
      });
    };
    const stateError = ackCapture();
    socket.receive("room:command", {
      protocolVersion: 1,
      commandId,
      expectedVersion: 0,
      type: "JOIN",
      roomId: "room-1",
      payload: { inviteCode: "valid-invite" },
    }, stateError.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((stateError.values[0] as { error: { code: string } }).error.code, code);

    const fifthFailure = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: `${code}-fifth-failure`,
      inviteCode: "wrong-fifth",
    }, fifthFailure.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((fifthFailure.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
    assert.equal(harness.calls.filter(({ name }) => name === "previewInvite").length, 5);

    const sixthFailure = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: `${code}-sixth-failure`,
      inviteCode: "must-not-be-looked-up",
    }, sixthFailure.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((sixthFailure.values[0] as { error: { code: string } }).error.code, "RATE_LIMITED");
  }
});

test("a successful JOIN clears prior preview failures for its IP and player key", async () => {
  const harness = createHarness();
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  for (let index = 0; index < 4; index += 1) {
    const preview = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: `before-successful-join-${index}`,
      inviteCode: `wrong-${index}`,
    }, preview.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((preview.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
  }

  harness.handlers.roomCommand = (_context, command, ack) => ack(acceptedAck(command.commandId));
  const joined = ackCapture();
  socket.receive("room:command", {
    protocolVersion: 1,
    commandId,
    expectedVersion: 0,
    type: "JOIN",
    roomId: "room-1",
    payload: { inviteCode: "valid-invite" },
  }, joined.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal((joined.values[0] as { status: string }).status, "accepted");

  for (let index = 0; index < 5; index += 1) {
    const afterJoin = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: `after-successful-join-${index}`,
      inviteCode: `wrong-after-${index}`,
    }, afterJoin.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((afterJoin.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
  }
});

test("undefined and unknown JOIN ACKs do not clear prior invite failures", async () => {
  for (const unexpectedAck of [undefined, { result: "joined?" }]) {
    const harness = createHarness();
    const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
    for (let index = 0; index < 4; index += 1) {
      const preview = ackCapture();
      socket.receive("room:preview", {
        protocolVersion: 1,
        requestId: `before-unknown-ack-${index}`,
        inviteCode: `wrong-${index}`,
      }, preview.ack);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal((preview.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");
    }

    harness.handlers.roomCommand = (_context, command, ack) => ack(unexpectedAck);
    const join = ackCapture();
    socket.receive("room:command", {
      protocolVersion: 1,
      commandId,
      expectedVersion: 0,
      type: "JOIN",
      roomId: "room-1",
      payload: { inviteCode: "uncertain-join-result" },
    }, join.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.deepEqual(join.values[0], unexpectedAck);

    const fifthFailure = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: "after-unknown-ack-fifth",
      inviteCode: "wrong-fifth",
    }, fifthFailure.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((fifthFailure.values[0] as { error: { code: string } }).error.code, "INVITE_INVALID");

    const sixthFailure = ackCapture();
    socket.receive("room:preview", {
      protocolVersion: 1,
      requestId: "after-unknown-ack-sixth",
      inviteCode: "must-remain-limited",
    }, sixthFailure.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    assert.equal((sixthFailure.values[0] as { error: { code: string } }).error.code, "RATE_LIMITED");
  }
});

test("limiter keys use raw peer address and authenticated player ID, ignoring forwarded headers", async () => {
  const harness = createHarness({
    playerIdsByCredential: { "secret-token": "player-1", "second-token": "player-2" },
  });
  const first = await harness.io.connect({
    cookie: "guest_session=secret-token",
    "x-forwarded-for": "198.51.100.1",
  }, "203.0.113.10");
  const preview = async (socket: FakeSocket, requestId: string) => {
    const captured = ackCapture();
    socket.receive("room:preview", { protocolVersion: 1, requestId, inviteCode: `wrong-${requestId}` }, captured.ack);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    return captured.values[0] as { error?: { code: string } };
  };

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await preview(first.socket, `same-peer-${index}`)).error?.code, "INVITE_INVALID");
  }
  const spoofedForwardedPeer = await harness.io.connect({
    cookie: "guest_session=secret-token",
    "x-forwarded-for": "192.0.2.250",
  }, "203.0.113.10");
  assert.equal((await preview(spoofedForwardedPeer.socket, "spoofed-forwarded-peer")).error?.code, "RATE_LIMITED");

  const differentRawPeer = await harness.io.connect({
    cookie: "guest_session=secret-token",
    "x-forwarded-for": "198.51.100.1",
  }, "203.0.113.11");
  assert.equal((await preview(differentRawPeer.socket, "different-raw-peer")).error?.code, "INVITE_INVALID");

  const differentPlayer = await harness.io.connect({
    cookie: "guest_session=second-token",
    "x-forwarded-for": "198.51.100.1",
  }, "203.0.113.10");
  assert.equal((await preview(differentPlayer.socket, "different-player")).error?.code, "INVITE_INVALID");
  assert.equal(harness.calls.filter(({ name }) => name === "previewInvite").length, 7,
    "the forwarded-header spoof was blocked while the distinct raw-IP and player buckets were queried");
});

test("match commands fail closed without fresh membership; match channel joins recheck too", async () => {
  const harness = createHarness({ matchMember: false });
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const command = {
    protocolVersion: 1,
    commandId,
    expectedVersion: 0,
    matchId: "match-1",
    type: "END_TURN",
    payload: {},
  };
  const denied = ackCapture();
  socket.receive("match:command", command, denied.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal((denied.values[0] as { error: { code: string } }).error.code, "NOT_A_PLAYER");
  assert.equal(harness.calls.filter(({ name }) => name === "matchCommand").length, 0);

  harness.setMatchMember(true);
  let joined = false;
  harness.handlers.matchCommand = async (context, _validated, ack) => {
    joined = await context.joinMatchChannel("match-1");
    ack(acceptedAck());
  };
  const accepted = ackCapture();
  socket.receive("match:command", command, accepted.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(joined, true);
  assert.ok(socket.channels.has("match:match-1"));
});

test("sync envelopes are exact and room/match membership is checked before sync handlers", async () => {
  assert.equal(parseRoomSyncRequest({ protocolVersion: 1, requestId: "req-1", roomId: "room-1", knownVersion: 0 }).ok, true);
  assert.equal(parseRoomSyncRequest({ protocolVersion: 1, requestId: "req-1", roomId: "room-1", knownVersion: 0, actorId: "p" }).ok, false);
  assert.equal(parseMatchSyncRequest({ protocolVersion: 1, requestId: "req-1", matchId: "match-1", knownVersion: 0, afterEventSeq: 0 }).ok, true);
  assert.equal(parseMatchSyncRequest({ protocolVersion: 1, requestId: "req-1", matchId: "match-1", knownVersion: -1, afterEventSeq: 0 }).ok, false);

  const harness = createHarness({ matchMember: false });
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  const roomRequest = { protocolVersion: 1, requestId: "req-1", roomId: "room-1", knownVersion: 0 };
  const roomAck = ackCapture();
  socket.receive("room:sync", roomRequest, roomAck.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.calls.filter(({ name }) => name === "roomSync").length, 1);
  assert.ok(socket.channels.has("lobby:room-1"), "a waiting-room sync authorizes its server-side lobby join");

  harness.setRoom(null);
  const missingRoomAck = ackCapture();
  socket.receive("room:sync", { ...roomRequest, requestId: "req-room-missing" }, missingRoomAck.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(missingRoomAck.values[0], {
    protocolVersion: 1,
    requestId: "req-room-missing",
    status: "rejected",
    error: { code: "NOT_FOUND_OR_FORBIDDEN" },
  });
  harness.setRoom(roomView("room-1", "player-1"));

  const matchRequest = { protocolVersion: 1, requestId: "req-2", matchId: "match-1", knownVersion: 0, afterEventSeq: 0 };
  const matchAck = ackCapture();
  socket.receive("match:sync", matchRequest, matchAck.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(matchAck.values[0], {
    protocolVersion: 1,
    requestId: "req-2",
    status: "rejected",
    error: { code: "NOT_FOUND_OR_FORBIDDEN" },
  });
  assert.equal(harness.calls.filter(({ name }) => name === "matchSync").length, 0);

  harness.setMatchMember(true);
  const authorizedMatchAck = ackCapture();
  socket.receive("match:sync", matchRequest, authorizedMatchAck.ack);
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.calls.filter(({ name }) => name === "matchSync").length, 1);
  assert.ok(socket.channels.has("match:match-1"), "a match sync joins only after the fresh membership lookup");

  const malformedAck = ackCapture();
  socket.receive("room:sync", { ...roomRequest, unexpected: 1 }, malformedAck.ack);
  assert.deepEqual(malformedAck.values[0], {
    protocolVersion: 1,
    requestId: "req-1",
    status: "rejected",
    error: { code: "BAD_REQUEST" },
  });
});

test("the accepted client event list is exact and unknown/server-only events are rejected", async () => {
  assert.deepEqual([...CLIENT_PROTOCOL_EVENT_NAMES], [
    "room:create",
    "room:command",
    "match:command",
    "room:sync",
    "match:sync",
    "match:history",
    "room:preview",
  ]);
  for (const eventName of ["lobby:join", "match:changed", "room:changed", "join"]) {
    const harness = createHarness();
    const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
    socket.receive(eventName, { roomId: "room-1" }, () => undefined);
    assert.equal(socket.disconnected, true, `${eventName} must not be accepted without a fixed inbound contract`);
  }
});

test("disconnect maps only to presence callback and never invokes seat removal", async () => {
  const harness = createHarness();
  const { socket } = await harness.io.connect({ cookie: "guest_session=secret-token" });
  socket.disconnect();
  assert.deepEqual(harness.calls.at(-1), {
    name: "disconnected",
    value: { playerId: "player-1", reason: "io server disconnect" },
  });
  assert.equal(harness.calls.some(({ name }) => name === "leaveRoom" || name === "eliminatePlayer"), false);
});
