// Dialect-neutral SQL connector interface and query types for pluggable storage backends.

export type SqlDialect = "sqlite" | "postgres" | "mysql" | "generic";
// deno-lint-ignore no-explicit-any
export type SqlRow = Record<string, any>;

export interface SqlExecuteResult {
  rowsAffected: number;
  lastInsertId?: number | string;
}

export interface SqlConnection {
  query<T extends SqlRow = SqlRow>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<SqlExecuteResult>;
}

export interface FtsHit {
  id: string;
  score: number;
}

export interface SqlConnector extends SqlConnection {
  readonly dialect: SqlDialect;
  readonly name: string;
  readonly tablePrefix?: string;
  readonly schema?: string;
  readonly supportsFts5?: boolean;
  ftsSearchEnglish?(query: string, limit: number, tableName: string): Promise<FtsHit[]>;
  ftsSearchChinese?(terms: string[], limit: number, tableName: string): Promise<FtsHit[]>;
  transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export type DatabaseConfig = {
  connector: string;
  path?: string;
  url?: string;
  auth_token?: string;
  schema?: string;
  table_prefix?: string;
  fts_backend?: "auto" | "fts5" | "js-bm25";
  vector_backend?: "memory";
  options?: Record<string, unknown>;
};
