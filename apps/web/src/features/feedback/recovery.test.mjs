import assert from "node:assert/strict";
import { test } from "node:test";
import { observeCommandRecovery, startConnectionNoticeTimer } from "./recovery.ts";

const command = { matchId: "match-1", commandId: "command-1" };
const accepted = { status: "accepted", commandId: "command-1", aggregateVersion: 2 };
const projection = version => ({ matchId: "match-1", version, eventSeq: version, snapshot: {}, visibleEvents: [] });
const flush = () => new Promise(resolve => setImmediate(resolve));

test("connection notice waits ten seconds and disappears before a short failure becomes visible", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let shown = 0;
  const cancel = startConnectionNoticeTimer(() => shown++);
  t.mock.timers.tick(9999); assert.equal(shown, 0);
  cancel(); t.mock.timers.tick(1); assert.equal(shown, 0);
  startConnectionNoticeTimer(() => shown++);
  t.mock.timers.tick(9999); assert.equal(shown, 0);
  t.mock.timers.tick(1); assert.equal(shown, 1);
  t.mock.timers.tick(10000); assert.equal(shown, 1);
});

test("a newer game version without this command's receipt never releases its lock", async () => {
  let reads = 0, releases = 0, notify;
  const stop = observeCommandRecovery({ getSnapshot: () => ({ matches: { "match-1": projection(99) } }),
    getCommandAcknowledgement: () => undefined, subscribe: listener => { notify = listener; return () => {}; },
    syncMatch: async () => { reads++; return projection(99); } }, command, () => releases++);
  notify(); await flush(); stop(); assert.equal(reads, 0); assert.equal(releases, 0);
});

test("a recovered receipt and current cached projection release once without another read", async () => {
  let ack, reads = 0, releases = 0, notify, unsubscribed = false;
  const stop = observeCommandRecovery({ getSnapshot: () => ({ matches: { "match-1": projection(3) } }),
    getCommandAcknowledgement: () => ack, subscribe: listener => { notify = listener; return () => { unsubscribed = true; }; },
    syncMatch: async () => { reads++; return projection(3); } }, command, (value, result) => {
      releases++; assert.equal(value, accepted); assert.equal(result.version, 3);
    });
  ack = accepted; notify(); notify(); await flush();
  assert.equal(releases, 1); assert.equal(reads, 0); stop(); assert.equal(unsubscribed, true);
});

test("accepted receipt waits for its version and retries a failed read on store recovery", async () => {
  let version = 1, reads = 0, releases = 0, notify;
  const stop = observeCommandRecovery({ getSnapshot: () => ({ matches: { "match-1": projection(version) } }),
    getCommandAcknowledgement: () => accepted, subscribe: listener => { notify = listener; return () => {}; },
    syncMatch: async () => { reads++; throw new Error("temporary"); } }, command, () => releases++);
  await flush(); assert.equal(reads, 1); assert.equal(releases, 0);
  version = 2; notify(); await flush(); assert.equal(releases, 1); assert.equal(reads, 1); stop();
});

test("a rejected command refreshes its choices and retains the rejection reason", async () => {
  const ack = { status: "rejected", error: { code: "STALE_VERSION" } };
  let reads = 0, delivered;
  const stop = observeCommandRecovery({ getCommandAcknowledgement: () => ack,
    syncMatch: async () => { reads++; return projection(3); } }, command, value => { delivered = value; });
  await flush(); assert.equal(reads, 1); assert.equal(delivered, ack); stop();
});

test("unmount or route change cancels an in-flight recovery callback", async () => {
  let finish, releases = 0;
  const stop = observeCommandRecovery({ getCommandAcknowledgement: () => accepted,
    syncMatch: () => new Promise(resolve => { finish = resolve; }) }, command, () => releases++);
  stop(); finish(projection(2)); await flush(); assert.equal(releases, 0);
});
