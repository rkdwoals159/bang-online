import assert from "node:assert/strict";
import { test } from "node:test";
import type { OutboxRecord } from "../../src/storage/repository.ts";
import { projectOutboxNotification } from "../../src/projections/outbox.ts";

const createdAt = new Date("2026-09-28T00:00:00.000Z");

function outboxRecord(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    eventId: "outbox-row-id",
    aggregateId: "aggregate-1",
    aggregateVersion: 12,
    eventSeq: 41,
    kind: "match:changed",
    payload: {
      matchId: "aggregate-1",
      version: 12,
      eventSeq: 41,
      snapshot: { selfPrivate: { hand: ["private-card-secret"] } },
      effectQueue: [{ payload: { inviteCode: "invite-secret" } }],
    },
    createdAt,
    publishedAt: null,
    retryCount: 0,
    ...overrides,
  };
}

test("match outbox projection emits only aggregate ID, version, and event sequence", () => {
  const projected = projectOutboxNotification(outboxRecord());
  assert.deepEqual(projected, {
    event: "match:changed",
    payload: { matchId: "aggregate-1", version: 12, eventSeq: 41 },
  });
  const encoded = JSON.stringify(projected);
  assert.equal(encoded.includes("private-card-secret"), false);
  assert.equal(encoded.includes("invite-secret"), false);
  assert.equal(encoded.includes("snapshot"), false);
  assert.equal(encoded.includes("effectQueue"), false);
});

test("room outbox projection follows the protocol room:changed shape", () => {
  const projected = projectOutboxNotification(outboxRecord({
    aggregateId: "room-7",
    aggregateVersion: 3,
    eventSeq: 0,
    kind: "room:changed",
  }));
  assert.deepEqual(projected, {
    event: "room:changed",
    payload: { roomId: "room-7", version: 3 },
  });
});

test("outbox projection rejects malformed aggregate cursors", () => {
  assert.throws(() => projectOutboxNotification(outboxRecord({ aggregateVersion: -1 })), TypeError);
  assert.throws(() => projectOutboxNotification(outboxRecord({ eventSeq: Number.NaN })), TypeError);
  assert.throws(() => projectOutboxNotification(outboxRecord({ aggregateId: " " })), TypeError);
});
