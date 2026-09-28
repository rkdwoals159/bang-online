import type { D1DatabaseLike, D1PreparedStatement } from "./d1-types.js";

export interface D1Migration {
  version: number;
  name: string;
  sql: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

export class D1MigrationChecksumMismatchError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`D1 migration ${version} differs from the SQL already applied.`);
    this.name = "D1MigrationChecksumMismatchError";
    this.version = version;
  }
}

export class D1UnknownAppliedMigrationError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`D1 contains migration ${version}, which this application does not provide.`);
    this.name = "D1UnknownAppliedMigrationError";
    this.version = version;
  }
}

async function checksum(sql: string): Promise<string> {
  const bytes = new TextEncoder().encode(sql);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Split Drizzle's SQLite migration format into D1 statements. Drizzle writes
 * `--> statement-breakpoint` markers between statements; D1 receives each
 * statement separately. Idempotent DDL lets overlapping cold starts race
 * safely before the checksummed migration row is visible.
 */
export function splitMigrationSql(sql: string): string[] {
  const source = sql.replace(/--> statement-breakpoint\s*/gu, "");
  const statements: string[] = [];
  let start = 0;
  let quote: "'" | '"' | "`" | null = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < source.length; index += 1) {
    const current = source[index]!;
    const next = source[index + 1];
    if (lineComment) {
      if (current === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === quote && next === quote) {
        index += 1;
      } else if (current === quote) {
        quote = null;
      }
      continue;
    }
    if (current === "-" && next === "-") {
      lineComment = true;
      index += 1;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      index += 1;
    } else if (current === "'" || current === '"' || current === "`") {
      quote = current;
    } else if (current === ";") {
      const statement = source.slice(start, index).trim();
      if (statement) statements.push(statement);
      start = index + 1;
    }
  }
  const finalStatement = source.slice(start).trim();
  if (finalStatement) statements.push(finalStatement);

  return statements.map((statement) => statement.replace(
      /^(CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX))\s+(?!IF\s+NOT\s+EXISTS\b)/iu,
      "$1 IF NOT EXISTS ",
    ));
}

function sortedMigrations(migrations: readonly D1Migration[]): D1Migration[] {
  const sorted = [...migrations].sort((a, b) => a.version - b.version);
  const versions = new Set<number>();
  for (const migration of sorted) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new RangeError(`D1 migration version must be a positive safe integer: ${migration.version}`);
    }
    if (!migration.name.trim() || !migration.sql.trim()) {
      throw new TypeError(`D1 migration ${migration.version} must include a name and SQL.`);
    }
    if (versions.has(migration.version)) throw new Error(`Duplicate D1 migration version ${migration.version}.`);
    versions.add(migration.version);
  }
  return sorted;
}

/** Apply checksummed migrations. Each migration and its ledger row share one D1 batch. */
export async function applyD1Migrations(
  db: D1DatabaseLike,
  definitions: readonly D1Migration[],
): Promise<void> {
  const migrations = sortedMigrations(definitions);
  let attemptedMigration = false;
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK (version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `).run();

  const appliedResult = await db.prepare(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
  ).all<AppliedMigrationRow>();
  const suppliedVersions = new Set(migrations.map(({ version }) => version));
  for (const applied of appliedResult.results ?? []) {
    if (!suppliedVersions.has(applied.version)) throw new D1UnknownAppliedMigrationError(applied.version);
  }

  for (const migration of migrations) {
    const migrationChecksum = await checksum(migration.sql);
    const existing = await db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
    ).bind(migration.version).first<AppliedMigrationRow>();
    if (existing) {
      if (existing.name !== migration.name || existing.checksum !== migrationChecksum) {
        throw new D1MigrationChecksumMismatchError(migration.version);
      }
      continue;
    }

    attemptedMigration = true;
    const statements = splitMigrationSql(migration.sql);
    if (statements.length === 0) throw new TypeError(`D1 migration ${migration.version} has no SQL statements.`);
    const batch: D1PreparedStatement[] = statements.map((statement) => db.prepare(statement));
    batch.push(db.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)",
    ).bind(migration.version, migration.name, migrationChecksum));
    const results = await db.batch(batch);
    if (results.some((result) => !result.success)) {
      throw new Error(`D1 migration ${migration.version} did not complete successfully.`);
    }
    const applied = await db.prepare(
      "SELECT version, name, checksum FROM schema_migrations WHERE version = ?",
    ).bind(migration.version).first<AppliedMigrationRow>();
    if (!applied || applied.name !== migration.name || applied.checksum !== migrationChecksum) {
      throw new Error(`D1 migration ${migration.version} ledger row was not recorded correctly.`);
    }
  }

  if (attemptedMigration) await db.prepare("PRAGMA optimize").run();
}

/** Cache successful initialization by D1 binding for this Worker isolate. */
export function createD1MigrationBootstrap(
  definitions: readonly D1Migration[],
): (db: D1DatabaseLike) => Promise<void> {
  const initialized = new WeakMap<D1DatabaseLike, Promise<void>>();
  return (db) => {
    const existing = initialized.get(db);
    if (existing) return existing;

    const pending = applyD1Migrations(db, definitions).catch((error: unknown) => {
      initialized.delete(db);
      throw error;
    });
    initialized.set(db, pending);
    return pending;
  };
}
