import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import type { D1DatabaseLike } from "../../src/storage/d1-types.js";
import { applyD1Migrations } from "../../src/storage/migrations.js";
import { D1StorageRepository } from "../../src/storage/repository.js";

const initialMigration = await readFile(new URL("../../../../drizzle/0000_long_iron_man.sql", import.meta.url), "utf8");

export async function createIsolatedD1() {
  const runtime = new Miniflare({
    modules: true,
    script: 'export default { async fetch() { return new Response("ok"); } };',
    d1Databases: ["DB"],
  });
  const db: D1DatabaseLike = await runtime.getD1Database("DB");
  await applyD1Migrations(db, [{ version: 1, name: "0000_long_iron_man", sql: initialMigration }]);
  return { runtime, db, repository: new D1StorageRepository(db) };
}

export async function countRows(db: D1DatabaseLike, table: string): Promise<number> {
  if (!/^[a-z_]+$/.test(table)) throw new TypeError("Test table name is not a SQL identifier.");
  const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number | string }>();
  const count = Number(row?.count ?? -1);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error(`Could not count rows in ${table}.`);
  return count;
}
