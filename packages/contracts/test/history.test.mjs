import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMatchHistoryRequest, parseMatchHistoryResponse } from "../src/validation.ts";

const request = { protocolVersion: 1, requestId: "history-1", matchId: "match-1", beforeEventSeq: 250 };
const event = eventSeq => ({ eventSeq, type: "BEER_USED", occurredAt: "2026-10-06T00:00:00Z", payload: { actorPlayerId: "a" } });
test("history request accepts an exclusive safe cursor and rejects fabricated identity or limits", () => {
  assert.equal(parseMatchHistoryRequest(request).ok, true);
  for (const value of [0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "200"]) assert.equal(parseMatchHistoryRequest({ ...request, beforeEventSeq: value }).ok, false);
  assert.equal(parseMatchHistoryRequest({ ...request, playerId: "other" }).ok, false);
  assert.equal(parseMatchHistoryRequest({ ...request, limit: 100000 }).ok, false);
});
test("history response accepts public gaps and an empty private page that still advances", () => {
  assert.equal(parseMatchHistoryResponse({ ...request, events: [event(155), event(249)], nextBeforeEventSeq: 150 }).ok, true);
  assert.equal(parseMatchHistoryResponse({ ...request, events: [], nextBeforeEventSeq: 150 }).ok, true);
  assert.equal(parseMatchHistoryResponse({ ...request, events: [], nextBeforeEventSeq: null }).ok, true);
});
test("history response rejects invalid order, cursor, oversized pages and unexpected snapshots", () => {
  const response = { ...request, events: [event(155), event(249)], nextBeforeEventSeq: 150 };
  for (const change of [{ nextBeforeEventSeq: 250 }, { nextBeforeEventSeq: 0 }, { nextBeforeEventSeq: 200 },
    { events: [event(250)] }, { events: [event(249), event(155)] }, { events: [event(155), event(155)] },
    { events: Array.from({ length: 101 }, (_, index) => event(index + 150)) }, { snapshot: {} }]) {
    assert.equal(parseMatchHistoryResponse({ ...response, ...change }).ok, false);
  }
});
