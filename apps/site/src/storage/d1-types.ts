/** Structural subset of the Worker D1 API used by storage. No Node adapter is imported. */
export type D1Bindable = string | number | boolean | null | ArrayBuffer;

export interface D1Result<T = unknown> {
  success: boolean;
  results?: T[];
  meta: { changes?: number; last_row_id?: number; [key: string]: unknown };
}

export interface D1PreparedStatement {
  bind(...values: D1Bindable[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(columnName?: string): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
  run<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatement;
  batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>;
  exec(query: string): Promise<{ count: number; duration: number }>;
}

export function changes(result: D1Result<unknown> | undefined): number {
  const value = result?.meta.changes ?? 0;
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
