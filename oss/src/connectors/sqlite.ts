// Default zero-dependency SQLite connector backed by Node/Deno built-in node:sqlite + FTS5 + WAL mode.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { validIdent } from "./query.ts";
import type { FtsHit, SqlConnection, SqlConnector, SqlExecuteResult, SqlRow } from "./types.ts";

export type SqliteOptions = {
  path?: string;
  tablePrefix?: string;
  fts?: boolean;
};

function sanitizeFtsTokens(raw: string): string[] {
  return [...new Set(raw.toLowerCase().match(/[a-z0-9]+/g) ?? [])];
}

export class SqliteConnector implements SqlConnector {
  readonly dialect = "sqlite" as const;
  readonly name: string;
  readonly tablePrefix?: string;
  readonly supportsFts5: boolean;

  private readonly db: DatabaseSync;
  private txDepth = 0;
  private writeLock: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(opts: SqliteOptions = {}) {
    const path = opts.path ?? ":memory:";
    if (path !== ":memory:" && !path.startsWith("file:")) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(path);
    this.name = path === ":memory:" ? "sqlite(:memory:)" : `sqlite(${path})`;
    this.tablePrefix = opts.tablePrefix;
    this.supportsFts5 = opts.fts !== false;

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA synchronous = NORMAL");
  }

  private runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writeLock.then(fn, fn);
    this.writeLock = next.then(() => undefined, () => undefined);
    return next;
  }

  private bind(params: unknown[]): SQLInputValue[] {
    return params.map((v) => (v === undefined ? null : v)) as SQLInputValue[];
  }

  async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...this.bind(params));
    return rows.map((r) => ({ ...r })) as T[];
  }

  async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
    const stmt = this.db.prepare(sql);
    const res = stmt.run(...this.bind(params));
    return {
      rowsAffected: Number(res.changes ?? 0),
      lastInsertId: typeof res.lastInsertRowid === "bigint"
        ? Number(res.lastInsertRowid)
        : (res.lastInsertRowid as number | string | undefined),
    };
  }

  async transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
    if (this.txDepth > 0) {
      const sp = `sp_${this.txDepth}`;
      this.txDepth++;
      this.db.exec(`SAVEPOINT ${sp}`);
      try {
        const res = await fn(this);
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        return res;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        this.db.exec(`RELEASE SAVEPOINT ${sp}`);
        throw err;
      } finally {
        this.txDepth--;
      }
    }

    return await this.runSerialized(async () => {
      this.txDepth++;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const res = await fn(this);
        this.db.exec("COMMIT");
        return res;
      } catch (err) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore secondary rollback failure
        }
        throw err;
      } finally {
        this.txDepth--;
      }
    });
  }

  async ftsSearchEnglish(query: string, limit: number, tableName: string): Promise<FtsHit[]> {
    if (!this.supportsFts5) return [];
    const table = validIdent(tableName, "fts table");
    const words = sanitizeFtsTokens(query);
    if (!words.length) return [];
    const matchExpr = words.map((w) => `"${w}"`).join(" OR ");
    const rows = await this.query<{ entry_id: string; rank: number }>(
      `SELECT entry_id, -bm25(${table}) AS rank FROM ${table} WHERE ${table} MATCH ? ORDER BY rank DESC, entry_id LIMIT ?`,
      [matchExpr, limit],
    );
    return rows.map((r) => ({ id: r.entry_id, score: Number(r.rank ?? 0) }));
  }

  async ftsSearchChinese(terms: string[], limit: number, tableName: string): Promise<FtsHit[]> {
    if (!this.supportsFts5 || !terms.length) return [];
    const table = validIdent(tableName, "fts table");
    const clean = [...new Set(terms.map((t) => t.replace(/["\s]/g, "")).filter(Boolean))];
    if (!clean.length) return [];
    const matchExpr = clean.map((t) => `"${t}"`).join(" OR ");
    const rows = await this.query<{ entry_id: string; rank: number }>(
      `SELECT entry_id, -bm25(${table}) AS rank FROM ${table} WHERE ${table} MATCH ? ORDER BY rank DESC, entry_id LIMIT ?`,
      [matchExpr, limit],
    );
    return rows.map((r) => ({ id: r.entry_id, score: Number(r.rank ?? 0) }));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
