import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { afterEach, test } from "node:test";
import type { D1DatabaseLike } from "../../src/storage/d1-types.js";
import { applyD1Migrations, createD1MigrationBootstrap, splitMigrationSql } from "../../src/storage/migrations.js";

const migrationSql = await readFile(new URL("../../../../drizzle/0000_long_iron_man.sql", import.meta.url), "utf8");
const outboxIndexSql = await readFile(new URL("../../../../drizzle/0001_jazzy_enchantress.sql", import.meta.url), "utf8");
const migration = { version: 1, name: "0000_long_iron_man", sql: migrationSql } as const;
const outboxIndexMigration = { version: 2, name: "0001_jazzy_enchantress", sql: outboxIndexSql } as const;
const runtimes: Miniflare[] = [];

async function newD1() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response("ok"); } };',
    d1Databases: ["DB"],
  });
  runtimes.push(runtime);
  return runtime.getD1Database("DB") as Promise<D1DatabaseLike>;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

test("Drizzle SQL breakpoints split into idempotent D1 statements", () => {
  const statements = splitMigrationSql(migrationSql);
  assert.equal(statements.length, 25);
  assert.equal(statements.some((statement) => statement.includes("statement-breakpoint")), false);
  assert.match(statements[0]!, /^CREATE TABLE IF NOT EXISTS `command_receipts`/u);
  assert.ok(statements.every((statement) => !/^CREATE (?:UNIQUE )?(?:TABLE|INDEX) (?!IF NOT EXISTS)/iu.test(statement)));
  assert.ok(statements.some((statement) => statement.includes("published_at\" IS NULL")));
  assert.deepEqual(
    splitMigrationSql("CREATE TABLE `literal` (`value` text DEFAULT 'left;right');"),
    ["CREATE TABLE IF NOT EXISTS `literal` (`value` text DEFAULT 'left;right')"],
  );
});

test("fresh D1 bootstraps concurrently, records one checksummed migration and optimizes indexes", async () => {
  const actualDb = await newD1();
  let optimizeCalls = 0;
  const db: D1DatabaseLike = {
    prepare(query) {
      if (query.trim().toUpperCase() === "PRAGMA OPTIMIZE") optimizeCalls += 1;
      return actualDb.prepare(query);
    },
    batch: (statements) => actualDb.batch(statements),
    exec: (query) => actualDb.exec(query),
  };

  const inIsolateBootstrap = createD1MigrationBootstrap([migration]);
  const sameIsolateFirst = inIsolateBootstrap(db);
  assert.equal(inIsolateBootstrap(db), sameIsolateFirst);

  // Independent bootstrap instances model separate cold Worker isolates racing.
  await Promise.all([
    sameIsolateFirst,
    createD1MigrationBootstrap([migration])(db),
    createD1MigrationBootstrap([migration])(db),
  ]);

  const domains = await actualDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations', '_cf_METADATA') ORDER BY name",
  ).all<{ name: string }>();
  assert.equal(domains.results?.length, 11);
  assert.deepEqual(domains.results?.map(({ name }) => name), [
    "command_receipts", "commit_guards", "guest_sessions", "invite_attempts", "invite_lookup_reservations",
    "match_events", "match_players", "matches", "outbox", "room_players", "rooms",
  ]);

  const indexes = await actualDb.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all<{ name: string }>();
  assert.deepEqual(indexes.results?.map(({ name }) => name), [
    "guest_sessions_token_hash_unique", "invite_reservations_expiry_idx", "match_events_event_id_unique",
    "match_events_match_version_idx", "match_players_match_seat_unique", "match_players_player_idx",
    "matches_room_latest_idx", "matches_status_updated_idx", "outbox_event_id_unique",
    "outbox_unpublished_cursor_idx", "room_players_player_idx", "room_players_room_seat_unique",
    "rooms_invite_code_hash_unique", "rooms_status_created_idx",
  ]);

  const ledger = await actualDb.prepare("SELECT version, name, length(checksum) AS checksum_length FROM schema_migrations").all<{
    version: number; name: string; checksum_length: number;
  }>();
  assert.deepEqual(ledger.results, [{ version: 1, name: migration.name, checksum_length: 64 }]);
  assert.ok(optimizeCalls >= 1);

  await applyD1Migrations(actualDb, [migration]);
  assert.equal((await actualDb.prepare("SELECT COUNT(*) AS count FROM schema_migrations").first<{ count: number }>())?.count, 1);
});

test("Drizzle migration ledger rejects SQL edits after application", async () => {
  const db = await newD1();
  await applyD1Migrations(db, [migration]);
  await assert.rejects(
    applyD1Migrations(db, [{ ...migration, sql: `${migration.sql}\n-- changed` }]),
    /differs from the SQL already applied/u,
  );
});

test("outbox aggregate cursor index applies as a separate versioned migration", async () => {
  const db = await newD1();
  await applyD1Migrations(db, [migration, outboxIndexMigration]);

  const index = await db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'outbox_aggregate_cursor_idx'",
  ).first<{ sql: string }>();
  assert.equal(index?.sql, "CREATE INDEX `outbox_aggregate_cursor_idx` ON `outbox` (`aggregate_id`,`cursor`)");

  const ledger = await db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all<{
    version: number; name: string;
  }>();
  assert.deepEqual(ledger.results, [
    { version: 1, name: migration.name },
    { version: 2, name: outboxIndexMigration.name },
  ]);
});
