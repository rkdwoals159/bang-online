export const INVITE_RATE_LIMIT_POLICY = Object.freeze({
  windowMs: 60_000,
  maxFailedLookups: 5,
  firstRetryMs: 1_000,
  maxRetryMs: 900_000,
  idleResetMs: 900_000,
  cleanupIntervalMs: 60_000,
});

export interface InviteRateLimitKey {
  /** The direct Socket.IO handshake peer address. Forwarded headers are never used here. */
  peerAddress: string;
  /** Identity resolved from the authenticated guest cookie. */
  playerId: string;
}

export type InviteLookupOutcome = "invalid" | "neutral" | "join-success";

export type InviteLookupReservation =
  | { readonly allowed: false; readonly retryAfterMs: number }
  | { readonly allowed: true; complete(outcome: InviteLookupOutcome): void };

interface Bucket {
  failures: number[];
  pendingLookups: number;
  lastInvalidAt: number | null;
  lastActivityAt: number;
  retryDelayMs: number;
  retryAt: number | null;
}

export interface InviteRateLimiterOptions {
  now?: () => number;
  cleanupIntervalMs?: number;
}

/**
 * In-memory invite lookup limiter. A reservation occupies one of the five allowed
 * lookup slots until the preview or JOIN handler classifies its result.
 */
export class InviteRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly cleanupTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: InviteRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    const cleanupIntervalMs = options.cleanupIntervalMs ?? INVITE_RATE_LIMIT_POLICY.cleanupIntervalMs;
    this.cleanupTimer = cleanupIntervalMs > 0
      ? setInterval(() => this.removeIdleBuckets(this.now()), cleanupIntervalMs)
      : undefined;
    this.cleanupTimer?.unref?.();
  }

  reserve(key: InviteRateLimitKey): InviteLookupReservation {
    const now = this.now();
    this.removeIdleBuckets(now);
    const bucketKey = this.bucketKey(key);
    const bucket = this.buckets.get(bucketKey) ?? this.createBucket(now);
    this.expireFailures(bucket, now);
    this.buckets.set(bucketKey, bucket);
    bucket.lastActivityAt = now;

    if (bucket.failures.length + bucket.pendingLookups >= INVITE_RATE_LIMIT_POLICY.maxFailedLookups) {
      return { allowed: false, retryAfterMs: this.reject(bucket, now) };
    }

    // The rolling window has opened a lookup slot. Preserve the exponential
    // stage until its explicit idle/JOIN reset, but start any later block from
    // its own timestamp rather than an expired retry deadline.
    bucket.retryAt = null;
    bucket.pendingLookups += 1;
    let completed = false;
    return {
      allowed: true,
      complete: (outcome) => {
        if (completed) return;
        completed = true;
        this.complete(bucketKey, bucket, outcome, this.now());
      },
    };
  }

  /** Current bucket count, exposed to make cleanup behavior directly testable. */
  get bucketCount(): number {
    return this.buckets.size;
  }

  /** Stop the unreferenced housekeeping timer when a gateway is shut down. */
  close(): void {
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
  }

  private bucketKey(key: InviteRateLimitKey): string {
    return JSON.stringify([key.peerAddress, key.playerId]);
  }

  private createBucket(now: number): Bucket {
    return {
      failures: [],
      pendingLookups: 0,
      lastInvalidAt: null,
      lastActivityAt: now,
      retryDelayMs: 0,
      retryAt: null,
    };
  }

  private expireFailures(bucket: Bucket, now: number): void {
    bucket.failures = bucket.failures.filter((failedAt) => now - failedAt < INVITE_RATE_LIMIT_POLICY.windowMs);
  }

  private removeIdleBuckets(now: number): void {
    for (const [key, bucket] of this.buckets) {
      this.expireFailures(bucket, now);
      if (bucket.pendingLookups > 0) continue;
      const idleSince = bucket.lastInvalidAt ?? bucket.lastActivityAt;
      if (now - idleSince >= INVITE_RATE_LIMIT_POLICY.idleResetMs) this.buckets.delete(key);
    }
  }

  private reject(bucket: Bucket, now: number): number {
    const previousRetryAt = bucket.retryAt;
    const isEarlyRetry = previousRetryAt !== null && now < previousRetryAt;

    if (!isEarlyRetry && previousRetryAt !== null && bucket.failures.length >= INVITE_RATE_LIMIT_POLICY.maxFailedLookups) {
      const nextFailureExpiry = bucket.failures[0]! + INVITE_RATE_LIMIT_POLICY.windowMs;
      if (nextFailureExpiry > now) {
        bucket.retryAt = nextFailureExpiry;
        return nextFailureExpiry - now;
      }
    }

    if (bucket.retryDelayMs === 0) {
      bucket.retryDelayMs = INVITE_RATE_LIMIT_POLICY.firstRetryMs;
    } else if (isEarlyRetry) {
      bucket.retryDelayMs = Math.min(
        bucket.retryDelayMs * 2,
        INVITE_RATE_LIMIT_POLICY.maxRetryMs,
      );
    }

    const retryAt = now + bucket.retryDelayMs;
    bucket.retryAt = retryAt;
    return Math.max(1, retryAt - now);
  }

  private complete(bucketKey: string, bucket: Bucket, outcome: InviteLookupOutcome, now: number): void {
    // A 15-minute idle sweep can remove a bucket only when no lookup is pending,
    // so the captured bucket remains the map's current entry until this completes.
    if (this.buckets.get(bucketKey) !== bucket) return;
    bucket.pendingLookups = Math.max(0, bucket.pendingLookups - 1);
    bucket.lastActivityAt = now;

    if (outcome === "invalid") {
      bucket.failures.push(now);
      bucket.lastInvalidAt = now;
      return;
    }

    if (outcome === "join-success") {
      // Keep outstanding reservations so concurrent lookups still count toward the cap.
      bucket.failures = [];
      bucket.lastInvalidAt = null;
      bucket.retryDelayMs = 0;
      bucket.retryAt = null;
      return;
    }

    // A valid preview releases its lookup slot but deliberately preserves the
    // accumulated failure history and retry progression.
  }
}
