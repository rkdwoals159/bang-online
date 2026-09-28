/** Structural subset implemented by a PostgreSQL pool client. */
export interface PgQueryResult<Row = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number | null;
  affectedRows?: number;
}

export interface PgClientLike {
  query<Row = Record<string, unknown>>(
    sql: string,
    parameters?: unknown[],
  ): Promise<PgQueryResult<Row>>;
  release(): void;
}

/**
 * Storage depends on this small pool boundary. A node-postgres Pool can be
 * adapted directly; PGlite tests provide a client backed by its SQL engine.
 */
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}
