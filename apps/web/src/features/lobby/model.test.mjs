import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildRoomLobbyViewModel,
  makeKickMemberCommand,
  makeSetReadyCommand,
  makeStartMatchCommand,
} from "./model.ts";

function room({
  status = "waiting",
  capacity = 4,
  count = 4,
  ready = true,
  viewerIndex = 0,
  ownerIndex = 0,
} = {}) {
  const members = Array.from({ length: count }, (_, index) => ({
    playerId: `player-${index + 1}`,
    displayName: `Guest ${index + 1}`,
    seatIndex: index,
    ready: typeof ready === "boolean" ? ready : ready[index] ?? false,
  }));
  return {
    roomId: "room-123",
    status,
    ownerPlayerId: `player-${ownerIndex + 1}`,
    capacity,
    rulesetVersion: "base4-ko-online-1.0",
    members,
    viewer: {
      playerId: `player-${viewerIndex + 1}`,
      isOwner: viewerIndex === ownerIndex,
    },
  };
}

test("arrival is sufficient: legacy unready flags do not block the owner", () => {
  const state = buildRoomLobbyViewModel(room({ ready: [true, false, true, false] }));
  assert.equal(state.occupancy, 4);
  assert.deepEqual(state.seats.map(({ seatNumber, member }) => [seatNumber, member?.playerId]), [[1, "player-1"], [2, "player-2"], [3, "player-3"], [4, "player-4"]]);
  assert.equal(state.canStart, true);
  assert.equal(state.startBlockedReason, null);
  assert.doesNotMatch(state.statusMessage, /준비/);
});

test("leaves unoccupied room seats visible and blocks starting before four guests", () => {
  const state = buildRoomLobbyViewModel(room({ capacity: 7, count: 3, ready: true }));

  assert.equal(state.seats.length, 7);
  assert.equal(state.seats.filter(({ member }) => member === null).length, 4);
  assert.equal(state.canInvite, true);
  assert.equal(state.canStart, false);
  assert.match(state.startBlockedReason, /최소 4명/);
  assert.match(state.statusMessage, /현재 3\/7명/);
});

test("only the server-designated owner can start or remove another waiting guest", () => {
  const ownerState = buildRoomLobbyViewModel(room({ ready: true, ownerIndex: 0, viewerIndex: 0 }));
  const guestState = buildRoomLobbyViewModel(room({ ready: true, ownerIndex: 0, viewerIndex: 1 }));

  assert.equal(ownerState.canStart, true);
  assert.equal(ownerState.seats[1]?.canKick, true);
  assert.equal(ownerState.seats[0]?.canKick, false);
  assert.equal(guestState.canStart, false);
  assert.equal(guestState.seats.some(({ canKick }) => canKick), false);
  assert.equal(guestState.startBlockedReason, "게임 시작은 방장만 할 수 있어요.");
});

test("a full seven-seat room has no invitation capacity for an eighth guest", () => {
  const state = buildRoomLobbyViewModel(room({ capacity: 7, count: 7, ready: true }));

  assert.equal(state.seats.length, 7);
  assert.equal(state.occupancy, 7);
  assert.equal(state.canInvite, false);
  assert.equal(state.inviteMessage, "방 정원이 찼어요. 추가 참가를 받을 수 없어요.");
});

test("started rooms disable start, invitations and kick actions", () => {
  for (const status of ["starting", "in_game", "paused", "completed", "closed"]) {
    const state = buildRoomLobbyViewModel(room({ status, ready: true }));
    assert.equal(state.canStart, false, status);
    assert.equal(state.canInvite, false, status);
    assert.equal(state.seats.some(({ canKick }) => canKick), false, status);
    assert.match(state.statusMessage, /잠겨|시작되어|끝나|닫혀|일시 정지/);
  }
});

test("builds only the shared room command envelopes with the current version", () => {
  assert.deepEqual(makeSetReadyCommand("room-123", 8, true, "ready-1"), {
    protocolVersion: 1,
    commandId: "ready-1",
    expectedVersion: 8,
    type: "SET_READY",
    roomId: "room-123",
    payload: { ready: true },
  });
  assert.deepEqual(makeStartMatchCommand("room-123", 8, "start-1"), {
    protocolVersion: 1,
    commandId: "start-1",
    expectedVersion: 8,
    type: "START_MATCH",
    roomId: "room-123",
    payload: {},
  });
  assert.deepEqual(makeKickMemberCommand("room-123", 8, "player-2", "kick-1"), {
    protocolVersion: 1,
    commandId: "kick-1",
    expectedVersion: 8,
    type: "KICK_MEMBER",
    roomId: "room-123",
    payload: { targetPlayerId: "player-2" },
  });
});
