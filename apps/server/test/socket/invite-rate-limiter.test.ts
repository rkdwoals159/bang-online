import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InviteRateLimiter,
  INVITE_RATE_LIMIT_POLICY,
  type InviteRateLimitKey,
} from "../../src/socket/invite-rate-limiter.ts";

const key: InviteRateLimitKey = { peerAddress: "203.0.113.8", playerId: "player-1" };

function invalidLookup(limiter: InviteRateLimiter, lookupKey: InviteRateLimitKey = key): void {
  const reservation = limiter.reserve(lookupKey);
  assert.equal(reservation.allowed, true);
  if (reservation.allowed) reservation.complete("invalid");
}

test("allows five failed lookups in a rolling minute and rejects the sixth before lookup", () => {
  let now = 10_000;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  let lookups = 0;

  for (let index = 0; index < INVITE_RATE_LIMIT_POLICY.maxFailedLookups; index += 1) {
    const reservation = limiter.reserve(key);
    assert.equal(reservation.allowed, true);
    if (reservation.allowed) {
      lookups += 1;
      reservation.complete("invalid");
    }
  }

  const sixth = limiter.reserve(key);
  assert.deepEqual(sixth, { allowed: false, retryAfterMs: 1_000 });
  assert.equal(lookups, 5);
  limiter.close();
});

test("reserves in-flight lookup slots so concurrent preview and JOIN work cannot exceed five lookups", () => {
  const limiter = new InviteRateLimiter({ now: () => 1_000, cleanupIntervalMs: 0 });
  const reservations = Array.from({ length: 5 }, () => limiter.reserve(key));
  assert.ok(reservations.every((reservation) => reservation.allowed));
  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: 1_000 });
  for (const reservation of reservations) {
    if (reservation.allowed) reservation.complete("invalid");
  }
  limiter.close();
});

test("doubles early retry delay and caps it at fifteen minutes", () => {
  let now = 10_000;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  for (let index = 0; index < 5; index += 1) invalidLookup(limiter);

  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: 1_000 });
  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: 2_000 });
  let latestRetry = 2_000;
  while (latestRetry < INVITE_RATE_LIMIT_POLICY.maxRetryMs) {
    const decision = limiter.reserve(key);
    assert.equal(decision.allowed, false);
    if (decision.allowed) throw new Error("A rate limited invite lookup unexpectedly received a reservation.");
    latestRetry = decision.retryAfterMs;
    now += 1;
  }
  assert.equal(latestRetry, INVITE_RATE_LIMIT_POLICY.maxRetryMs);
  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: INVITE_RATE_LIMIT_POLICY.maxRetryMs });
  limiter.close();
});

test("continues to block after the initial retry delay until a rolling failure expires", () => {
  let now = 0;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  for (let index = 0; index < 5; index += 1) {
    invalidLookup(limiter);
    now += 1;
  }

  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: 1_000 });
  now += 1_000;
  const stillBlocked = limiter.reserve(key);
  assert.equal(stillBlocked.allowed, false);
  if (!stillBlocked.allowed) assert.equal(stillBlocked.retryAfterMs, 60_000 - now);

  now = 60_000;
  const afterOldestFailureExpires = limiter.reserve(key);
  assert.equal(afterOldestFailureExpires.allowed, true);
  if (afterOldestFailureExpires.allowed) afterOldestFailureExpires.complete("neutral");
  limiter.close();
});

test("a successful preview releases its reservation without clearing prior failed lookups", () => {
  let now = 1_000;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  for (let index = 0; index < 4; index += 1) invalidLookup(limiter);
  const validPreview = limiter.reserve(key);
  assert.equal(validPreview.allowed, true);
  if (validPreview.allowed) validPreview.complete("neutral");

  const fifthFailure = limiter.reserve(key);
  assert.equal(fifthFailure.allowed, true);
  if (fifthFailure.allowed) fifthFailure.complete("invalid");
  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: 1_000 });
  limiter.close();
});

test("successful JOIN clears failure history and backoff for that key", () => {
  let now = 5_000;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  for (let index = 0; index < 4; index += 1) invalidLookup(limiter);
  const joining = limiter.reserve(key);
  assert.equal(joining.allowed, true);
  if (joining.allowed) joining.complete("join-success");

  for (let index = 0; index < 4; index += 1) invalidLookup(limiter);
  const fifthAfterReset = limiter.reserve(key);
  assert.equal(fifthAfterReset.allowed, true);
  if (fifthAfterReset.allowed) fifthAfterReset.complete("invalid");
  assert.deepEqual(limiter.reserve(key), { allowed: false, retryAfterMs: 1_000 });
  limiter.close();
});

test("idle cleanup removes bucket state after fifteen minutes without invalid input", () => {
  let now = 10_000;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  for (let index = 0; index < 5; index += 1) invalidLookup(limiter);
  assert.equal(limiter.bucketCount, 1);

  now += INVITE_RATE_LIMIT_POLICY.idleResetMs;
  assert.equal(limiter.reserve({ peerAddress: "198.51.100.4", playerId: "other-player" }).allowed, true);
  assert.equal(limiter.bucketCount, 1, "the idle bucket is swept before a fresh bucket is created");
  limiter.close();
});

test("raw peer and authenticated player ID form isolated bucket keys", () => {
  let now = 2_000;
  const limiter = new InviteRateLimiter({ now: () => now, cleanupIntervalMs: 0 });
  for (let index = 0; index < 5; index += 1) invalidLookup(limiter);

  const differentAddress = limiter.reserve({ peerAddress: "203.0.113.9", playerId: key.playerId });
  const differentPlayer = limiter.reserve({ peerAddress: key.peerAddress, playerId: "player-2" });
  assert.equal(differentAddress.allowed, true);
  assert.equal(differentPlayer.allowed, true);
  if (differentAddress.allowed) differentAddress.complete("neutral");
  if (differentPlayer.allowed) differentPlayer.complete("neutral");
  limiter.close();
});
