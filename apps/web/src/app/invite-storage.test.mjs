import assert from "node:assert/strict";
import { test } from "node:test";
import { loadRoomInvites, saveRoomInvites } from "./invite-storage.ts";

test("A03 invite storage survives reloading and is scoped to the authenticated guest", () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  saveRoomInvites("owner", { "room-1": "private-code" }, storage);
  assert.deepEqual(loadRoomInvites("owner", storage), { "room-1": "private-code" });
  assert.deepEqual(loadRoomInvites("other-guest", storage), {});
  saveRoomInvites("owner", { "room-1": "replacement" }, storage);
  assert.deepEqual(loadRoomInvites("owner", storage), { "room-1": "replacement" });
});

test("A03 corrupt or unavailable storage cannot block the game", () => {
  assert.deepEqual(loadRoomInvites("owner", { getItem: () => "not-json" }), {});
  const unavailable = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("full"); } };
  assert.deepEqual(loadRoomInvites("owner", unavailable), {});
  assert.doesNotThrow(() => saveRoomInvites("owner", { room: "code" }, unavailable));
  assert.deepEqual(loadRoomInvites("owner", { getItem: () => JSON.stringify({ playerId: "owner", invites: { room: 42, valid: "code", bad: "" } }) }), { valid: "code" });
});
