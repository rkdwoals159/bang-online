import initialMigrationSql from "../../../../drizzle/0000_long_iron_man.sql?raw";
import outboxAggregateCursorSql from "../../../../drizzle/0001_jazzy_enchantress.sql?raw";
import type { D1DatabaseLike } from "./d1-types.js";
import { createD1MigrationBootstrap } from "./migrations.js";

const bootstrap = createD1MigrationBootstrap([
  { version: 1, name: "0000_long_iron_man", sql: initialMigrationSql },
  { version: 2, name: "0001_jazzy_enchantress", sql: outboxAggregateCursorSql },
]);

/** Initialize a fresh Sites D1 binding once before serving API requests. */
export function ensureSiteDatabase(db: D1DatabaseLike): Promise<void> {
  return bootstrap(db);
}
