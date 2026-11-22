// SDK helpers for wrapping any custom SQL driver/connector module and resolving `database.connector` config.
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { LibsqlConnector } from "./libsql.ts";
import { MysqlConnector } from "./mysql.ts";
import { PostgresConnector } from "./postgres.ts";
import { SqliteConnector } from "./sqlite.ts";
import type { DatabaseConfig, SqlConnection, SqlConnector, SqlDialect, SqlExecuteResult, SqlRow } from "./types.ts";

export type CustomConnectorSpec = {
  dialect: SqlDialect;
  name?: string;
  schema?: string;
  tablePrefix?: string;
  supportsFts5?: boolean;
  query<T extends SqlRow = SqlRow>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<SqlExecuteResult>;
  transaction?<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T>;
  close?(): Promise<void>;
};

/** Wraps minimal SQL query/execute functions into a full `SqlConnector`. */
export function createSqlConnector(spec: CustomConnectorSpec): SqlConnector {
  const conn: SqlConnection = {
    query: (sql, params = []) => spec.query(sql, params),
    execute: (sql, params = []) => spec.execute(sql, params),
  };
  return {
    dialect: spec.dialect,
    name: spec.name ?? `custom(${spec.dialect})`,
    schema: spec.schema,
    tablePrefix: spec.tablePrefix,
    supportsFts5: spec.supportsFts5 ?? false,
    query: conn.query,
    execute: conn.execute,
    transaction: spec.transaction
      ? (fn) => spec.transaction!(fn)
      : async (fn) => await fn(conn),
    close: spec.close ?? (async () => {}),
  };
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolves either a built-in SQL connector or a custom connector module path/package. */
export async function loadConnector(db: DatabaseConfig, baseDir = process.cwd()): Promise<SqlConnector> {
  const kind = (db.connector || "sqlite").trim();
  const low = kind.toLowerCase();

  if (low === "sqlite") {
    const rawPath = db.path ?? "~/.local/share/clyde/clyde.db";
    return new SqliteConnector({
      path: rawPath === ":memory:" ? ":memory:" : expandHome(rawPath),
      tablePrefix: db.table_prefix,
      fts: db.fts_backend !== "js-bm25",
    });
  }
  if (low === "postgres" || low === "postgresql" || low === "pg") {
    return new PostgresConnector({
      url: db.url,
      schema: db.schema,
      tablePrefix: db.table_prefix,
    });
  }
  if (low === "mysql" || low === "mariadb") {
    return new MysqlConnector({
      url: db.url,
      tablePrefix: db.table_prefix,
    });
  }
  if (low === "libsql" || low === "turso") {
    return new LibsqlConnector({
      url: db.url,
      authToken: db.auth_token,
      tablePrefix: db.table_prefix,
    });
  }

  // Custom connector module: relative/absolute file path or package specifier exporting createConnector(db) or default.
  const specifier = kind.startsWith(".") || kind.startsWith("/")
    ? pathToFileURL(isAbsolute(kind) ? kind : resolve(baseDir, kind)).href
    : kind;
  const mod = await import(specifier);
  const factory = mod.createConnector ?? mod.default;
  if (typeof factory === "function") {
    return await factory(db);
  }
  if (factory && typeof factory.query === "function" && typeof factory.execute === "function") {
    return factory as SqlConnector;
  }
  throw new Error(`Custom connector "${kind}" must export a SqlConnector or createConnector(config) factory.`);
}
