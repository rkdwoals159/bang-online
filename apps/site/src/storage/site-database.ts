import type { D1DatabaseLike } from "./d1-types.js";

const requiredTables = [
  "command_receipts", "commit_guards", "guest_sessions", "invite_attempts",
  "invite_lookup_reservations", "match_events", "match_players", "matches",
  "outbox", "room_players", "rooms",
] as const;
const initialized = new WeakMap<D1DatabaseLike, Promise<void>>();

/** Sites applies Drizzle migrations before upload. Runtime only checks readiness. */
export function ensureSiteDatabase(db: D1DatabaseLike): Promise<void> {
  const existing = initialized.get(db);
  if (existing) return existing;
  const pending = verifySchema(db).catch((error: unknown) => {
    initialized.delete(db);
    throw error;
  });
  initialized.set(db, pending);
  return pending;
}

async function verifySchema(db: D1DatabaseLike): Promise<void> {
  const result = await db.prepare(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'index')",
  ).all<{ name: string; type: string }>();
  if (!result.success) throw new Error("Sites D1 schema verification failed.");
  const tables = new Set((result.results ?? []).filter((row) => row.type === "table").map((row) => row.name));
  const indexes = new Set((result.results ?? []).filter((row) => row.type === "index").map((row) => row.name));
  if (requiredTables.some((table) => !tables.has(table)) || !indexes.has("outbox_aggregate_cursor_idx")) {
    throw new Error("Sites D1 deployment migrations must complete before API requests.");
  }
}
