import type { PgClientLike, PgPoolLike } from "./database.js";

export declare function withClient<T>(
  pool: PgPoolLike,
  run: (client: PgClientLike) => Promise<T>,
): Promise<T>;

export declare function withTransaction<T>(
  pool: PgPoolLike,
  run: (client: PgClientLike) => Promise<T>,
): Promise<T>;
