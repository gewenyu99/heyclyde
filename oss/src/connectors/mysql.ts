// MySQL / MariaDB connector supporting user-supplied pools/clients or lazy loading of `mysql2/promise`.
import type { SqlConnection, SqlConnector, SqlExecuteResult, SqlRow } from "./types.ts";

export interface MysqlConnectionLike {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  execute(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  beginTransaction?(): Promise<void>;
  commit?(): Promise<void>;
  rollback?(): Promise<void>;
  release?(): void;
}

export interface MysqlPoolLike extends MysqlConnectionLike {
  getConnection?(): Promise<MysqlConnectionLike>;
  end?(): Promise<void>;
}

export type MysqlOptions = {
  url?: string;
  tablePrefix?: string;
  client?: MysqlPoolLike;
};

function bindParams(params: unknown[]): unknown[] {
  return params.map((v) => {
    if (v === undefined) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v;
  });
}

function makeConn(c: MysqlConnectionLike): SqlConnection {
  return {
    async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const bound = bindParams(params);
      const [rows] = await c.query(sql, bound);
      return (Array.isArray(rows) ? rows : []) as T[];
    },
    async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
      const bound = bindParams(params);
      let out: [unknown, unknown];
      if (bound.length === 0) {
        // Use text protocol for parameterless statements such as DDL (CREATE TABLE/INDEX).
        out = await c.query(sql);
      } else {
        try {
          out = await c.execute(sql, bound);
        } catch (err) {
          const code = (err as { errno?: number; code?: string })?.errno;
          if (code === 1295 || (err as { code?: string })?.code === "ER_UNSUPPORTED_PS") {
            out = await c.query(sql, bound);
          } else {
            throw err;
          }
        }
      }
      const [res] = out;
      const header = (res && typeof res === "object" ? res : {}) as { affectedRows?: number; insertId?: number | string };
      return {
        rowsAffected: Number(header.affectedRows ?? 0),
        lastInsertId: header.insertId,
      };
    },
  };
}

export class MysqlConnector implements SqlConnector {
  readonly dialect = "mysql" as const;
  readonly name: string;
  readonly tablePrefix?: string;
  private readonly poolPromise: Promise<{ pool: MysqlPoolLike; owned: boolean }>;

  constructor(opts: MysqlOptions) {
    this.tablePrefix = opts.tablePrefix;
    this.name = opts.client ? "mysql(custom-client)" : "mysql";
    if (opts.client) {
      this.poolPromise = Promise.resolve({ pool: opts.client, owned: false });
    } else if (opts.url) {
      const pkg = "mysql2/promise";
      this.poolPromise = import(pkg).then((mod) => {
        const createPool = mod.createPool ?? mod.default?.createPool;
        if (!createPool) throw new Error("mysql2/promise createPool export not found");
        return { pool: createPool(opts.url) as MysqlPoolLike, owned: true };
      });
    } else {
      throw new Error("MysqlConnector requires either url or client");
    }
  }

  async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { pool } = await this.poolPromise;
    return await makeConn(pool).query<T>(sql, params);
  }

  async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
    const { pool } = await this.poolPromise;
    return await makeConn(pool).execute(sql, params);
  }

  async transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
    const { pool } = await this.poolPromise;
    const c = pool.getConnection ? await pool.getConnection() : pool;
    const conn = makeConn(c);
    try {
      if (c.beginTransaction) await c.beginTransaction();
      else await c.query("START TRANSACTION");
      const out = await fn(conn);
      if (c.commit) await c.commit();
      else await c.query("COMMIT");
      return out;
    } catch (err) {
      try {
        if (c.rollback) await c.rollback();
        else await c.query("ROLLBACK");
      } catch {
        // ignore rollback failure
      }
      throw err;
    } finally {
      c.release?.();
    }
  }

  async close(): Promise<void> {
    const { pool, owned } = await this.poolPromise;
    if (owned && pool.end) await pool.end();
  }
}
