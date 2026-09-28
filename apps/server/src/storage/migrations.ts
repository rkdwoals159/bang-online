import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { withClient, withTransaction } from "./database-runtime.js";
import type { PgPoolLike } from "./database.js";

export interface MigrationDefinition {
  version: number;
  name: string;
  sql: string;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
  checksum: string;
}

const migrationFiles = [{ version: 1, name: "initial", fileName: "001_initial.sql" }] as const;

export class MigrationChecksumMismatchError extends Error {
  readonly version: number;
  readonly expectedChecksum: string;
  readonly actualChecksum: string;

  constructor(version: number, expectedChecksum: string, actualChecksum: string) {
    super(`Migration ${version} checksum differs from the already applied SQL.`);
    this.name = "MigrationChecksumMismatchError";
    this.version = version;
    this.expectedChecksum = expectedChecksum;
    this.actualChecksum = actualChecksum;
  }
}

export class UnknownAppliedMigrationError extends Error {
  readonly version: number;

  constructor(version: number) {
    super(`Database has migration ${version}, but this application does not provide it.`);
    this.name = "UnknownAppliedMigrationError";
    this.version = version;
  }
}

function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

export async function loadStorageMigrations(): Promise<MigrationDefinition[]> {
  return Promise.all(
    migrationFiles.map(async ({ version, name, fileName }) => ({
      version,
      name,
      sql: await readFile(new URL(`../../migrations/${fileName}`, import.meta.url), "utf8"),
    })),
  );
}

function sortedMigrations(migrations: readonly MigrationDefinition[]): MigrationDefinition[] {
  const sorted = [...migrations].sort((left, right) => left.version - right.version);
  const seen = new Set<number>();
  for (const migration of sorted) {
    if (!Number.isSafeInteger(migration.version) || migration.version < 1) {
      throw new RangeError(`Migration version must be a positive safe integer: ${migration.version}`);
    }
    if (!migration.name.trim() || !migration.sql.trim()) {
      throw new TypeError(`Migration ${migration.version} must have a name and SQL.`);
    }
    if (seen.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}.`);
    }
    seen.add(migration.version);
  }
  return sorted;
}

export async function applyStorageMigrations(
  pool: PgPoolLike,
  suppliedMigrations?: readonly MigrationDefinition[],
): Promise<void> {
  const migrations = sortedMigrations(suppliedMigrations ?? (await loadStorageMigrations()));

  await withClient(pool, async (client) => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version integer PRIMARY KEY CHECK (version > 0),
        name text NOT NULL,
        checksum text NOT NULL CHECK (length(checksum) = 64),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
  });

  const appliedRows = await withClient(pool, async (client) => {
    const result = await client.query<AppliedMigrationRow>(
      "SELECT version, name, checksum FROM schema_migrations ORDER BY version",
    );
    return result.rows;
  });
  const suppliedVersions = new Set(migrations.map(({ version }) => version));
  for (const applied of appliedRows) {
    if (!suppliedVersions.has(applied.version)) throw new UnknownAppliedMigrationError(applied.version);
  }

  for (const migration of migrations) {
    const migrationChecksum = checksum(migration.sql);
    await withTransaction(pool, async (client) => {
      const existingResult = await client.query<AppliedMigrationRow>(
        "SELECT version, name, checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.name !== migration.name || existing.checksum !== migrationChecksum) {
          throw new MigrationChecksumMismatchError(migration.version, existing.checksum, migrationChecksum);
        }
        return;
      }

      await client.query(migration.sql);
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1, $2, $3)`,
        [migration.version, migration.name, migrationChecksum],
      );
    });
  }
}
