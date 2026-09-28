import { PGlite } from "@electric-sql/pglite";
import type { PgClientLike, PgPoolLike, PgQueryResult } from "../../src/storage/database.js";

/** Adapts PGlite's single connection to the structural pool used by storage. */
export function createPGlitePool(database: PGlite): PgPoolLike {
  return {
    async connect(): Promise<PgClientLike> {
      return {
        async query<Row = Record<string, unknown>>(
          sql: string,
          parameters: unknown[] = [],
        ): Promise<PgQueryResult<Row>> {
          const results =
            parameters.length > 0
              ? [await database.query<Row>(sql, parameters)]
              : await database.exec(sql);
          const result = results.at(-1);
          return {
            rows: (result?.rows ?? []) as Row[],
            rowCount: result?.rowCount,
            affectedRows: result?.affectedRows,
          };
        },
        release() {},
      };
    },
  };
}

export async function createDatabase(): Promise<{ database: PGlite; pool: PgPoolLike }> {
  const database = new PGlite();
  await database.waitReady;
  return { database, pool: createPGlitePool(database) };
}
