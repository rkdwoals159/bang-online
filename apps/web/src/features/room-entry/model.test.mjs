import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONNECTION_ERROR_MESSAGE,
  INVALID_INVITE_MESSAGE,
  inviteErrorMessage,
  joinPreviewedInvite,
  makeCreateRoomCommand,
  makeGuestSessionRequest,
  makeInviteUrl,
  normalizeDisplayName,
  previewInvite,
  readInviteCode,
} from "./model.ts";

test("normalizes a guest name and uses the 1–20 Unicode code point rule", () => {
  assert.equal(normalizeDisplayName("  River Fox  "), "River Fox");
  assert.throws(() => normalizeDisplayName(" \t\n "), RangeError);
  assert.equal(Array.from(normalizeDisplayName("😀".repeat(20))).length, 20);
  assert.throws(() => normalizeDisplayName(`${"😀".repeat(20)}a`), RangeError);
  assert.equal(normalizeDisplayName("Same Name"), normalizeDisplayName("Same Name"));

  for (const codePoint of [
    ...Array.from({ length: 0x20 }, (_, index) => index),
    ...Array.from({ length: 0x21 }, (_, index) => 0x7f + index),
  ]) {
    const control = String.fromCharCode(codePoint);
    assert.throws(() => normalizeDisplayName(`River${control}Fox`), RangeError);
  }
});

test("builds guest and room commands from public DTOs without a credential field", () => {
  const request = makeGuestSessionRequest("  Prairie Star  ");
  assert.deepEqual(request, { protocolVersion: 1, displayName: "Prairie Star" });

  const command = makeCreateRoomCommand(
    { playerId: "p_cookie_session", displayName: request.displayName },
    6,
    "command-create-1",
  );
  assert.deepEqual(command, {
    protocolVersion: 1,
    commandId: "command-create-1",
    expectedVersion: 0,
    type: "CREATE_ROOM",
    payload: {
      capacity: 6,
      rulesetVersion: "base4-ko-online-1.0",
      displayName: "Prairie Star",
    },
  });
  assert.equal("credential" in request, false);
  assert.equal("credential" in command, false);
});

test("previews before join and sends the exact preview version with JOIN", async () => {
  const calls = [];
  const expectedRoom = {
    roomId: "room-123",
    version: 9,
    occupancy: 3,
    status: "waiting",
  };
  const transport = {
    async previewInvite(code) {
      calls.push({ action: "preview", code });
      return expectedRoom;
    },
    async joinRoom(command) {
      calls.push({ action: "join", command });
      return { roomId: command.roomId, status: "waiting" };
    },
  };

  const preview = await previewInvite(transport, "  secret-invite-code  ");
  const joined = await joinPreviewedInvite(transport, preview, " secret-invite-code ", "command-join-1");

  assert.deepEqual(calls[0], { action: "preview", code: "secret-invite-code" });
  assert.deepEqual(calls[1], {
    action: "join",
    command: {
      protocolVersion: 1,
      commandId: "command-join-1",
      expectedVersion: 9,
      type: "JOIN",
      roomId: "room-123",
      payload: { inviteCode: "secret-invite-code" },
    },
  });
  assert.equal(joined.roomId, "room-123");
});

test("invalid code preview and JOIN errors share one safe message", async () => {
  await assert.rejects(
    previewInvite({ previewInvite: async () => null }, "not-a-code"),
    { message: INVALID_INVITE_MESSAGE },
  );

  const preview = { roomId: "room-123", version: 1, occupancy: 4, status: "waiting" };
  const fullError = Object.assign(new Error("room is full"), { code: "ROOM_FULL" });
  await assert.rejects(
    joinPreviewedInvite({ joinRoom: async () => { throw fullError; } }, preview, "invite", "join-1"),
    { message: INVALID_INVITE_MESSAGE },
  );
  assert.equal(inviteErrorMessage(new Error("connection lost")), CONNECTION_ERROR_MESSAGE);
  assert.equal(inviteErrorMessage(Object.assign(new Error(), { code: "INVALID_INVITE" })), INVALID_INVITE_MESSAGE);
  assert.equal(inviteErrorMessage(Object.assign(new Error(), { code: "INTERNAL_ERROR" })), CONNECTION_ERROR_MESSAGE);
});

test("invite links contain only the invite code and can be read without session data", () => {
  const link = makeInviteUrl("invite-only-value", "https://game.example");
  const url = new URL(link);
  assert.equal(url.pathname, "/rooms/join");
  assert.deepEqual([...url.searchParams.entries()], [["code", "invite-only-value"]]);
  assert.equal(readInviteCode(url.search), "invite-only-value");
  assert.equal(url.searchParams.has("session"), false);
  assert.equal(url.searchParams.has("credential"), false);
});
