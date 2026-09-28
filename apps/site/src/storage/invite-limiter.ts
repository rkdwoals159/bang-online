import { changes, type D1DatabaseLike, type D1PreparedStatement } from "./d1-types.js";
import { D1StorageInvariantError } from "./repository.js";

export const D1_INVITE_RATE_LIMIT_POLICY = Object.freeze({
  windowMs: 60_000,
  maxFailedLookups: 5,
  firstRetryMs: 1_000,
  maxRetryMs: 900_000,
  idleResetMs: 900_000,
  reservationLeaseMs: 60_000,
});

export type InviteLookupOutcome = "invalid" | "neutral" | "join-success";

export type InviteLookupReservation =
  | { readonly allowed: false; readonly retryAfterMs: number }
  | { readonly allowed: true; complete(outcome: InviteLookupOutcome, at?: number): Promise<boolean> };

interface InviteBucketRow {
  bucket_hash: string;
  failures_json: string;
  last_invalid_at: number | null;
  last_activity_at: number;
  retry_delay_ms: number;
  retry_at: number | null;
  version: number;
}

interface ReservationRow {
  reservation_id: string;
  bucket_hash: string;
  expires_at: number;
}

interface BucketState {
  failures: number[];
  lastInvalidAt: number | null;
  lastActivityAt: number;
  retryDelayMs: number;
  retryAt: number | null;
  version: number;
}

function validateBucketHash(bucketHash: string): void {
  if (!/^[a-f0-9]{64}$/i.test(bucketHash)) {
    throw new TypeError("Invite limiter key must be a SHA-256 hash of trusted IP and guest identity.");
  }
}

function parseFailures(json: string): number[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new D1StorageInvariantError("Stored invite limiter failure history is invalid JSON.");
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "number" || !Number.isSafeInteger(entry))) {
    throw new D1StorageInvariantError("Stored invite limiter failure history is invalid.");
  }
  return parsed as number[];
}

function mapBucket(row: InviteBucketRow): BucketState {
  if (!Number.isSafeInteger(row.version) || row.version < 0 || !Number.isSafeInteger(row.last_activity_at) ||
      !Number.isSafeInteger(row.retry_delay_ms) || row.retry_delay_ms < 0 ||
      (row.last_invalid_at !== null && !Number.isSafeInteger(row.last_invalid_at)) ||
      (row.retry_at !== null && !Number.isSafeInteger(row.retry_at))) {
    throw new D1StorageInvariantError("Stored invite limiter state has invalid numeric fields.");
  }
  return { failures: parseFailures(row.failures_json), lastInvalidAt: row.last_invalid_at,
    lastActivityAt: row.last_activity_at, retryDelayMs: row.retry_delay_ms, retryAt: row.retry_at,
    version: row.version };
}

function expireFailures(bucket: BucketState, now: number): void {
  bucket.failures = bucket.failures.filter((failedAt) => now - failedAt < D1_INVITE_RATE_LIMIT_POLICY.windowMs);
}

function reject(bucket: BucketState, now: number): number {
  const previousRetryAt = bucket.retryAt;
  const isEarlyRetry = previousRetryAt !== null && now < previousRetryAt;
  if (!isEarlyRetry && previousRetryAt !== null && bucket.failures.length >= D1_INVITE_RATE_LIMIT_POLICY.maxFailedLookups) {
    const nextFailureExpiry = bucket.failures[0]! + D1_INVITE_RATE_LIMIT_POLICY.windowMs;
    if (nextFailureExpiry > now) {
      bucket.retryAt = nextFailureExpiry;
      return nextFailureExpiry - now;
    }
  }
  if (bucket.retryDelayMs === 0) bucket.retryDelayMs = D1_INVITE_RATE_LIMIT_POLICY.firstRetryMs;
  else if (isEarlyRetry) {
    bucket.retryDelayMs = Math.min(bucket.retryDelayMs * 2, D1_INVITE_RATE_LIMIT_POLICY.maxRetryMs);
  }
  bucket.retryAt = now + bucket.retryDelayMs;
  return Math.max(1, bucket.retryAt - now);
}

/**
 * D1-backed invite abuse limiter. The caller supplies only a digest of the
 * trusted peer IP + authenticated guest ID; raw identifiers/invites are never stored.
 * Reservation and completion changes use versioned D1 batches so Workers share one cap.
 */
export class D1InviteRateLimiter {
  constructor(private readonly db: D1DatabaseLike, private readonly reservationLeaseMs = D1_INVITE_RATE_LIMIT_POLICY.reservationLeaseMs) {
    if (!Number.isSafeInteger(reservationLeaseMs) || reservationLeaseMs < 1000) {
      throw new RangeError("Invite reservation lease must be at least one second.");
    }
  }

  async reserve(bucketHash: string, reservationId: string, now = Date.now()): Promise<InviteLookupReservation> {
    validateBucketHash(bucketHash);
    if (!reservationId.trim()) throw new TypeError("Invite lookup reservation ID is required.");
    if (!Number.isSafeInteger(now)) throw new TypeError("Invite limiter time must be a safe integer.");
    await this.db.prepare(`
      INSERT INTO invite_attempts (bucket_hash, last_activity_at) VALUES (?, ?)
      ON CONFLICT (bucket_hash) DO NOTHING
    `).bind(bucketHash, now).run();

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const existingReservation = await this.db.prepare(`
        SELECT reservation_id, bucket_hash, expires_at FROM invite_lookup_reservations WHERE reservation_id = ?
      `).bind(reservationId).first<ReservationRow>();
      if (existingReservation && existingReservation.bucket_hash !== bucketHash) {
        throw new D1StorageInvariantError("Invite reservation ID was reused for another limiter bucket.");
      }
      if (existingReservation && existingReservation.expires_at > now) {
        return this.makeReservation(bucketHash, reservationId);
      }

      const row = await this.readBucket(bucketHash);
      const bucket = mapBucket(row);
      expireFailures(bucket, now);
      const pending = await this.countReservations(bucketHash, now);
      bucket.lastActivityAt = now;
      const retryAfter = bucket.failures.length + pending >= D1_INVITE_RATE_LIMIT_POLICY.maxFailedLookups
        ? reject(bucket, now)
        : null;
      if (retryAfter === null) bucket.retryAt = null;
      const markerId = globalThis.crypto.randomUUID();
      const statements: D1PreparedStatement[] = [this.guard(markerId, bucketHash, row.version),
        this.db.prepare(`
          UPDATE invite_attempts SET failures_json = ?, last_invalid_at = ?, last_activity_at = ?,
            retry_delay_ms = ?, retry_at = ?, version = version + 1
          WHERE bucket_hash = ? AND version = ? AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(JSON.stringify(bucket.failures), bucket.lastInvalidAt, bucket.lastActivityAt,
          bucket.retryDelayMs, bucket.retryAt, bucketHash, row.version, markerId),
        this.db.prepare(`
          DELETE FROM invite_lookup_reservations WHERE bucket_hash = ? AND expires_at <= ?
            AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(bucketHash, now, markerId)];
      if (retryAfter === null) {
        statements.push(this.db.prepare(`
          INSERT INTO invite_lookup_reservations (reservation_id, bucket_hash, reserved_at, expires_at)
          SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(reservationId, bucketHash, now, now + this.reservationLeaseMs, markerId));
      }
      statements.push(this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(markerId));
      try {
        const results = await this.db.batch(statements);
        if (changes(results[0]) !== 1) continue;
        if (retryAfter !== null) return { allowed: false, retryAfterMs: retryAfter };
        return this.makeReservation(bucketHash, reservationId);
      } catch (error) {
        const racedReservation = await this.db.prepare(`
          SELECT reservation_id, bucket_hash, expires_at FROM invite_lookup_reservations WHERE reservation_id = ?
        `).bind(reservationId).first<ReservationRow>();
        if (racedReservation?.bucket_hash === bucketHash && racedReservation.expires_at > now) {
          return this.makeReservation(bucketHash, reservationId);
        }
        if (attempt === 15) throw error;
      }
    }
    throw new D1StorageInvariantError("Invite limiter could not serialize a reservation after repeated CAS retries.");
  }

  private makeReservation(bucketHash: string, reservationId: string): InviteLookupReservation {
    let completed = false;
    return {
      allowed: true,
      complete: async (outcome, at = Date.now()) => {
        if (completed) return false;
        completed = true;
        return this.complete(bucketHash, reservationId, outcome, at);
      },
    };
  }

  private async complete(bucketHash: string, reservationId: string, outcome: InviteLookupOutcome, now: number): Promise<boolean> {
    if (!Number.isSafeInteger(now)) throw new TypeError("Invite limiter time must be a safe integer.");
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const reservation = await this.db.prepare(`
        SELECT reservation_id, bucket_hash, expires_at FROM invite_lookup_reservations WHERE reservation_id = ?
      `).bind(reservationId).first<ReservationRow>();
      if (!reservation || reservation.bucket_hash !== bucketHash || reservation.expires_at <= now) return false;
      const row = await this.readBucket(bucketHash);
      const bucket = mapBucket(row);
      expireFailures(bucket, now);
      bucket.lastActivityAt = now;
      if (outcome === "invalid") {
        bucket.failures.push(now);
        bucket.lastInvalidAt = now;
      } else if (outcome === "join-success") {
        bucket.failures = [];
        bucket.lastInvalidAt = null;
        bucket.retryDelayMs = 0;
        bucket.retryAt = null;
      }
      const markerId = globalThis.crypto.randomUUID();
      const statements: D1PreparedStatement[] = [this.guard(markerId, bucketHash, row.version),
        this.db.prepare(`
          UPDATE invite_attempts SET failures_json = ?, last_invalid_at = ?, last_activity_at = ?,
            retry_delay_ms = ?, retry_at = ?, version = version + 1
          WHERE bucket_hash = ? AND version = ? AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(JSON.stringify(bucket.failures), bucket.lastInvalidAt, bucket.lastActivityAt,
          bucket.retryDelayMs, bucket.retryAt, bucketHash, row.version, markerId),
        this.db.prepare(`
          DELETE FROM invite_lookup_reservations WHERE reservation_id = ? AND bucket_hash = ?
            AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)
        `).bind(reservationId, bucketHash, markerId),
        this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(markerId)];
      try {
        const results = await this.db.batch(statements);
        if (changes(results[0]) === 1) return changes(results[2]) === 1;
      } catch (error) {
        const stillExists = await this.db.prepare(
          "SELECT 1 AS found FROM invite_lookup_reservations WHERE reservation_id = ? AND bucket_hash = ?",
        ).bind(reservationId, bucketHash).first<{ found: number }>();
        if (!stillExists) return false;
        if (attempt === 15) throw error;
      }
    }
    throw new D1StorageInvariantError("Invite limiter could not serialize completion after repeated CAS retries.");
  }

  /** Removes expired reservations and idle buckets without crossing an active bucket update. */
  async cleanup(now = Date.now()): Promise<number> {
    if (!Number.isSafeInteger(now)) throw new TypeError("Invite limiter time must be a safe integer.");
    const rows = await this.db.prepare(`
      SELECT bucket_hash, failures_json, last_invalid_at, last_activity_at, retry_delay_ms, retry_at, version
      FROM invite_attempts ORDER BY bucket_hash
    `).all<InviteBucketRow>();
    let removed = 0;
    for (const row of rows.results ?? []) {
      const bucket = mapBucket(row);
      expireFailures(bucket, now);
      const markerId = globalThis.crypto.randomUUID();
      const idleSince = bucket.lastInvalidAt ?? bucket.lastActivityAt;
      const stale = now - idleSince >= D1_INVITE_RATE_LIMIT_POLICY.idleResetMs;
      const statements: D1PreparedStatement[] = [this.guard(markerId, row.bucket_hash, row.version),
        this.db.prepare(`DELETE FROM invite_lookup_reservations WHERE bucket_hash = ? AND expires_at <= ?
          AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`)
          .bind(row.bucket_hash, now, markerId)];
      if (stale) {
        statements.push(this.db.prepare(`DELETE FROM invite_attempts WHERE bucket_hash = ? AND version = ?
          AND NOT EXISTS (SELECT 1 FROM invite_lookup_reservations WHERE bucket_hash = ? AND expires_at > ?)
          AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`)
          .bind(row.bucket_hash, row.version, row.bucket_hash, now, markerId));
      } else {
        statements.push(this.db.prepare(`UPDATE invite_attempts SET failures_json = ?, version = version + 1
          WHERE bucket_hash = ? AND version = ? AND EXISTS (SELECT 1 FROM commit_guards WHERE marker_id = ?)`)
          .bind(JSON.stringify(bucket.failures), row.bucket_hash, row.version, markerId));
      }
      statements.push(this.db.prepare("DELETE FROM commit_guards WHERE marker_id = ?").bind(markerId));
      const result = await this.db.batch(statements);
      if (changes(result[0]) === 1 && stale && changes(result[2]) === 1) removed += 1;
    }
    return removed;
  }

  private async readBucket(bucketHash: string): Promise<InviteBucketRow> {
    const row = await this.db.prepare(`
      SELECT bucket_hash, failures_json, last_invalid_at, last_activity_at, retry_delay_ms, retry_at, version
      FROM invite_attempts WHERE bucket_hash = ?
    `).bind(bucketHash).first<InviteBucketRow>();
    if (!row) throw new D1StorageInvariantError("Invite bucket disappeared during a limiter operation.");
    return row;
  }

  private async countReservations(bucketHash: string, now: number): Promise<number> {
    const row = await this.db.prepare(`
      SELECT COUNT(*) AS count FROM invite_lookup_reservations WHERE bucket_hash = ? AND expires_at > ?
    `).bind(bucketHash, now).first<{ count: number | string }>();
    const count = Number(row?.count ?? 0);
    if (!Number.isSafeInteger(count) || count < 0) throw new D1StorageInvariantError("Invite reservation count is invalid.");
    return count;
  }

  private guard(markerId: string, bucketHash: string, expectedVersion: number): D1PreparedStatement {
    return this.db.prepare(`
      INSERT INTO commit_guards (marker_id, aggregate_id, expected_version)
      SELECT ?, ?, ? FROM invite_attempts WHERE bucket_hash = ? AND version = ?
    `).bind(markerId, bucketHash, expectedVersion, bucketHash, expectedVersion);
  }
}
