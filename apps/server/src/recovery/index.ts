import { randomBytes } from "node:crypto";
import { BASE_DECK_RULESET_VERSION } from "../../../../packages/catalog/src/cards/index.js";
import { withClient, withTransaction } from "../storage/database-runtime.js";
import type { PgPoolLike } from "../storage/database.js";
import type { RoomService } from "../rooms/service.js";

/** The schema emitted by the current engine initializer. */
export const CURRENT_MATCH_STATE_SCHEMA_VERSION = 1;

type ActiveMatchStatus = "playing" | "paused";

export type MatchRecoveryIssue =
  | "UNSUPPORTED_SCHEMA"
  | "UNSUPPORTED_RULESET"
  | "SNAPSHOT_METADATA_MISMATCH";

export type MatchRecoveryResult =
  | { matchId: string; status: "resumable" }
  | { matchId: string; status: "recovery_required"; issue: MatchRecoveryIssue };

export interface RecoveryServiceDependencies {
  readonly pool: PgPoolLike;
  /** Session recovery is delegated to T44's credential and membership checks. */
  readonly rooms: Pick<RoomService, "recoverAssignedSeats">;
  /** Injectable only so recovery notifications can be deterministic in tests. */
  readonly newOutboxEventId?: () => string;
}

interface ActiveMatchRow {
  id: string;
  status: ActiveMatchStatus;
  version: number | string;
  event_seq: number | string;
  ruleset_version: string;
  state_schema_version: number;
  state_json: unknown;
}

interface StateMetadata {
  schemaVersion: unknown;
  rulesetVersion: unknown;
  status: unknown;
  version: unknown;
  eventSeq: unknown;
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function stateRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === "string") {
    try {
      return objectRecord(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }
  return objectRecord(value);
}

function stateMetadata(value: unknown): StateMetadata | undefined {
  const state = stateRecord(value);
  if (!state) return undefined;
  return {
    schemaVersion: state.schemaVersion,
    rulesetVersion: state.rulesetVersion,
    status: state.status,
    version: state.version,
    eventSeq: state.eventSeq,
  };
}

function safeInteger(value: unknown): number | undefined {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim().length > 0
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function issueFor(row: ActiveMatchRow): MatchRecoveryIssue | undefined {
  const metadata = stateMetadata(row.state_json);
  if (
    row.state_schema_version !== CURRENT_MATCH_STATE_SCHEMA_VERSION ||
    metadata?.schemaVersion !== CURRENT_MATCH_STATE_SCHEMA_VERSION
  ) {
    return "UNSUPPORTED_SCHEMA";
  }
  if (
    row.ruleset_version !== BASE_DECK_RULESET_VERSION ||
    metadata?.rulesetVersion !== BASE_DECK_RULESET_VERSION
  ) {
    return "UNSUPPORTED_RULESET";
  }

  const rowVersion = safeInteger(row.version);
  const rowEventSeq = safeInteger(row.event_seq);
  if (
    !metadata || rowVersion === undefined || rowEventSeq === undefined ||
    metadata.status !== row.status || metadata.version !== rowVersion || metadata.eventSeq !== rowEventSeq
  ) {
    return "SNAPSHOT_METADATA_MISMATCH";
  }
  return undefined;
}

/**
 * Recovers persisted matches without replaying commands or advancing effects.
 * Supported snapshots remain byte-for-byte equivalent at the JSON value level;
 * unsupported/inconsistent active snapshots are marked recovery_required.
 */
export class RecoveryService {
  private readonly pool: PgPoolLike;
  private readonly rooms: RecoveryServiceDependencies["rooms"];
  private readonly newOutboxEventId: () => string;

  constructor(dependencies: RecoveryServiceDependencies) {
    this.pool = dependencies.pool;
    this.rooms = dependencies.rooms;
    this.newOutboxEventId = dependencies.newOutboxEventId ?? (() => `recovery_${randomBytes(18).toString("base64url")}`);
  }

  /** Resolve an existing session credential to its unchanged room seats. */
  recoverAssignedSeats(credential: string) {
    return this.rooms.recoverAssignedSeats(credential);
  }

  async recoverPersistedMatches(): Promise<MatchRecoveryResult[]> {
    const active = await withClient(this.pool, async (client) => {
      const result = await client.query<ActiveMatchRow>(
        `SELECT id, status, version, event_seq, ruleset_version, state_schema_version, state_json
         FROM matches WHERE status IN ('playing', 'paused') ORDER BY id`,
      );
      return result.rows;
    });

    const results: MatchRecoveryResult[] = [];
    for (const row of active) {
      const issue = issueFor(row);
      if (!issue) {
        results.push({ matchId: row.id, status: "resumable" });
        continue;
      }

      const rowVersion = safeInteger(row.version);
      const rowEventSeq = safeInteger(row.event_seq);
      if (rowVersion === undefined || rowEventSeq === undefined) {
        // The SQL schema constrains both columns; this protects non-PostgreSQL adapters.
        throw new Error(`Active match '${row.id}' has invalid recovery metadata.`);
      }

      const quarantineResult = await withTransaction(this.pool, async (client) => {
        const updated = await client.query<{ id: string }>(
          `UPDATE matches
           SET status = 'recovery_required',
               state_json = jsonb_set(state_json, '{status}', '"recovery_required"'::jsonb, true),
               updated_at = now()
           WHERE id = $1 AND status = $2 AND version = $3 AND event_seq = $4
             AND ruleset_version = $5 AND state_schema_version = $6
           RETURNING id`,
          [row.id, row.status, row.version, row.event_seq, row.ruleset_version, row.state_schema_version],
        );
        if (updated.rows.length === 1) {
          await client.query(
            `INSERT INTO outbox (event_id, aggregate_id, aggregate_version, event_seq, kind, payload_json)
             VALUES ($1, $2, $3, $4, 'match:changed', $5::jsonb)`,
            [
              this.newOutboxEventId(),
              row.id,
              rowVersion,
              rowEventSeq,
              JSON.stringify({ matchId: row.id, version: rowVersion, eventSeq: rowEventSeq }),
            ],
          );
          return "quarantined" as const;
        }

        const current = await client.query<{ status: string }>(
          "SELECT status FROM matches WHERE id = $1",
          [row.id],
        );
        if (current.rows[0]?.status === "recovery_required") return "already_quarantined" as const;
        throw new Error(`Active match '${row.id}' changed while recovery was validating it.`);
      });

      if (quarantineResult === "quarantined" || quarantineResult === "already_quarantined") {
        results.push({ matchId: row.id, status: "recovery_required", issue });
      }
    }
    return results;
  }
}
