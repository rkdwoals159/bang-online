import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, test } from "node:test";
import { Miniflare } from "miniflare";
import type { D1DatabaseLike } from "../../src/storage/d1-types.js";
import { applyD1Migrations } from "../../src/storage/migrations.js";
import { ensureSiteDatabase } from "../../src/storage/site-database.js";

const legacy = await readFile(new URL("../../../../db/legacy/0000_long_iron_man.sql", import.meta.url), "utf8");
const baseline = await readFile(new URL("../../../../drizzle/0000_long_iron_man.sql", import.meta.url), "utf8");
const delta = await readFile(new URL("../../../../drizzle/0001_jazzy_enchantress.sql", import.meta.url), "utf8");
const legacyHash = "fc1959a1d064d492efb9d501100b132b8342fd001536d34c90c13f9b32d80cce";
const runtimes: Miniflare[] = [];
async function newDb(): Promise<D1DatabaseLike> {
  const runtime = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } };", d1Databases: ["DB"] });
  runtimes.push(runtime);
  return runtime.getD1Database("DB");
}
afterEach(async () => { await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose())); });

// Feed raw files to D1 exactly as deployment does: no runtime idempotence rewriting.
async function platformApply(db: D1DatabaseLike, sql: string) {
  const statements = sql.split("--> statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
  const results = await db.batch(statements.map((statement) => db.prepare(statement)));
  assert.ok(results.every((result) => result.success));
}
test("failed platform baseline changes only CREATE idempotence; applied legacy bytes stay immutable", () => {
  assert.equal(createHash("sha256").update(legacy).digest("hex"), legacyHash);
  assert.equal(baseline.replace(/ IF NOT EXISTS/g, "").replace(/\r\n/g, "\n"), legacy.replace(/\r\n/g, "\n"));
  assert.equal((baseline.match(/IF NOT EXISTS/g) ?? []).length, 25);
});

test("existing application database can acquire the platform baseline without changing data or its legacy ledger", async () => {
  const db = await newDb();
  await applyD1Migrations(db, [{ version: 1, name: "0000_long_iron_man", sql: legacy }]);
  await db.prepare("INSERT INTO guest_sessions (id, token_hash, display_name, expires_at) VALUES (?, ?, ?, ?)").bind("guest", "hash", "기존 참가자", "2099-01-01T00:00:00Z").run();
  await db.prepare("INSERT INTO rooms (id, owner_player_id, invite_code_hash, capacity) VALUES (?, ?, ?, ?)").bind("room", "guest", "invite-hash", 4).run();
  await db.prepare("INSERT INTO room_players (room_id, player_id, seat_index, ready) VALUES (?, ?, ?, ?)").bind("room", "guest", 0, 1).run();
  await db.prepare("INSERT INTO command_receipts (actor_player_id, command_id, room_id, request_hash, outcome_json) VALUES (?, ?, ?, ?, ?)").bind("guest", "cmd", "room", "req", '{"accepted":true}').run();
  const queries = ["SELECT * FROM guest_sessions", "SELECT * FROM rooms", "SELECT * FROM room_players", "SELECT * FROM command_receipts", "SELECT * FROM schema_migrations"];
  const before = await Promise.all(queries.map((query) => db.prepare(query).all()));
  await platformApply(db, baseline);
  await platformApply(db, delta);
  await ensureSiteDatabase(db);
  const after = await Promise.all(queries.map((query) => db.prepare(query).all()));
  assert.deepEqual(after.map((result) => result.results), before.map((result) => result.results));
  assert.equal((after[4]!.results![0] as { checksum: string }).checksum, legacyHash);
  assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'outbox_aggregate_cursor_idx'").first());
});

test("fresh platform migrations suffice and runtime readiness performs no schema or ledger writes", async () => {
  const db = await newDb();
  await platformApply(db, baseline);
  await platformApply(db, delta);
  const queries: string[] = [];
  const readOnlyDb: D1DatabaseLike = {
    prepare(query) { queries.push(query); assert.match(query, /^SELECT /); return db.prepare(query); },
    batch() { throw new Error("Runtime must not write a migration batch"); },
    exec() { throw new Error("Runtime must not execute migration SQL"); },
  };
  const first = ensureSiteDatabase(readOnlyDb);
  assert.equal(ensureSiteDatabase(readOnlyDb), first);
  await first;
  await ensureSiteDatabase(readOnlyDb);
  assert.equal(queries.length, 1);
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").first(), null);
});

test("missing platform migration fails safely; a later completed migration can retry readiness", async () => {
  const db = await newDb();
  await assert.rejects(ensureSiteDatabase(db), /deployment migrations must complete/);
  await platformApply(db, baseline);
  await assert.rejects(ensureSiteDatabase(db), /deployment migrations must complete/);
  await platformApply(db, delta);
  await ensureSiteDatabase(db);
});
