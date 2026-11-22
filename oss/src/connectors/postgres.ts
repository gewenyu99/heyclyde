// PostgreSQL connector supporting user-supplied pools/clients or lazy dynamic loading of `pg` / `postgres`.
import type { SqlConnection, SqlConnector, SqlExecuteResult, SqlRow } from "./types.ts";

export interface PgQueryable {
  query(text: string, params?: unknown[]): Promise<{ rows: SqlRow[]; rowCount?: number | null }>;
  release?(): void;
  end?(): Promise<void>;
}

export interface PgPoolLike extends PgQueryable {
  connect?(): Promise<PgQueryable>;
}

export type PostgresOptions = {
  url?: string;
  schema?: string;
  tablePrefix?: string;
  client?: PgPoolLike;
  driver?: "pg" | "postgres";
};

function bindParams(params: unknown[]): unknown[] {
  return params.map((v) => (v === undefined ? null : v));
}

function makeConn(q: PgQueryable): SqlConnection {
  return {
    async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await q.query(sql, bindParams(params));
      return (res.rows ?? []) as T[];
    },
    async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
      const res = await q.query(sql, bindParams(params));
      const first = res.rows?.[0];
      return {
        rowsAffected: Number(res.rowCount ?? res.rows?.length ?? 0),
        lastInsertId: first && "id" in first ? (first.id as number | string) : undefined,
      };
    },
  };
}

export class PostgresConnector implements SqlConnector {
  readonly dialect = "postgres" as const;
  readonly name: string;
  readonly schema?: string;
  readonly tablePrefix?: string;
  private readonly poolPromise: Promise<{ pool: PgPoolLike; owned: boolean }>;

  constructor(opts: PostgresOptions) {
    this.schema = opts.schema;
    this.tablePrefix = opts.tablePrefix;
    this.name = opts.client ? "postgres(custom-client)" : `postgres(${opts.schema ?? "public"})`;
    if (opts.client) {
      this.poolPromise = Promise.resolve({ pool: opts.client, owned: false });
    } else if (opts.url) {
      this.poolPromise = this.connectFromUrl(opts.url, opts.driver);
    } else {
      throw new Error("PostgresConnector requires either url or client");
    }
  }

  private async connectFromUrl(url: string, driver?: "pg" | "postgres"): Promise<{ pool: PgPoolLike; owned: boolean }> {
    const pgPkg = "pg";
    const postgresJsPkg = "postgres";
    if (driver !== "postgres") {
      try {
        const mod = await import(pgPkg);
        const Pool = mod.Pool ?? mod.default?.Pool;
        if (Pool) return { pool: new Pool({ connectionString: url }), owned: true };
      } catch (e) {
        if (driver === "pg") {
          throw new Error(`Install "pg" to use the Postgres connector (${(e as Error).message})`);
        }
      }
    }
    try {
      const mod = await import(postgresJsPkg);
      const factory = mod.default ?? mod;
      const sqlFn = factory(url);
      const adapter: PgPoolLike = {
        async query(text: string, params: unknown[] = []) {
          const rows = await sqlFn.unsafe(text, bindParams(params));
          return { rows: [...rows], rowCount: Number(rows.count ?? rows.length) };
        },
        async connect() {
          if (typeof sqlFn.reserve === "function") {
            const reserved = await sqlFn.reserve();
            return {
              async query(text: string, params: unknown[] = []) {
                const rows = await reserved.unsafe(text, bindParams(params));
                return { rows: [...rows], rowCount: Number(rows.count ?? rows.length) };
              },
              release() {
                reserved.release();
              },
            };
          }
          throw new Error("postgres driver version lacks reserve(); upgrade postgres package or pass an explicit client.");
        },
        async end() {
          await sqlFn.end({ timeout: 5 });
        },
      };
      return { pool: adapter, owned: true };
    } catch (e) {
      throw new Error(`PostgresConnector requires either "pg" or "postgres" installed: ${(e as Error).message}`);
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
    const connObj = pool.connect ? await pool.connect() : pool;
    const conn = makeConn(connObj);
    try {
      await connObj.query("BEGIN");
      const out = await fn(conn);
      await connObj.query("COMMIT");
      return out;
    } catch (err) {
      await connObj.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      connObj.release?.();
    }
  }

  async close(): Promise<void> {
    const { pool, owned } = await this.poolPromise;
    if (owned && pool.end) await pool.end();
  }
}
