import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleRootUnmount } from "../../src/ui/GameAppMount.js";

test("browser root cleanup runs after the parent lifecycle and tolerates cancelled loading", async () => {
  const events: string[] = [];
  scheduleRootUnmount(undefined);
  scheduleRootUnmount({ unmount: () => { events.push("child disposed"); } });
  events.push("parent cleanup finished");
  assert.deepEqual(events, ["parent cleanup finished"]);
  await Promise.resolve();
  assert.deepEqual(events, ["parent cleanup finished", "child disposed"]);
});
