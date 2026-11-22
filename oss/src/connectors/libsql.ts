// LibSQL / Turso connector supporting user-supplied @libsql/client instances or lazy dynamic loading.
import type { SqlConnection, SqlConnector, SqlExecuteResult, SqlRow } from "./types.ts";

export interface LibsqlTxLike {
  execute(stmt: { sql: string; args?: unknown[] } | string): Promise<{
    rows: SqlRow[];
    rowsAffected: number;
    lastInsertRowid?: bigint | number;
  }>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface LibsqlClientLike {
  execute(stmt: { sql: string; args?: unknown[] } | string): Promise<{
    rows: SqlRow[];
    rowsAffected: number;
    lastInsertRowid?: bigint | number;
  }>;
  transaction?(mode?: "read" | "write" | "deferred"): Promise<LibsqlTxLike>;
  close?(): void;
}

export type LibsqlOptions = {
  url?: string;
  authToken?: string;
  tablePrefix?: string;
  client?: LibsqlClientLike;
};

function makeConn(c: Pick<LibsqlClientLike, "execute">): SqlConnection {
  return {
    async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const res = await c.execute({ sql, args: params });
      return (res.rows ?? []).map((r) => ({ ...r })) as T[];
    },
    async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
      const res = await c.execute({ sql, args: params });
      return {
        rowsAffected: Number(res.rowsAffected ?? 0),
        lastInsertId: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
      };
    },
  };
}

export class LibsqlConnector implements SqlConnector {
  readonly dialect = "sqlite" as const;
  readonly name: string;
  readonly tablePrefix?: string;
  readonly supportsFts5 = true;
  private readonly clientPromise: Promise<{ client: LibsqlClientLike; owned: boolean }>;

  constructor(opts: LibsqlOptions) {
    this.tablePrefix = opts.tablePrefix;
    this.name = opts.client ? "libsql(custom-client)" : `libsql(${opts.url ?? ""})`;
    if (opts.client) {
      this.clientPromise = Promise.resolve({ client: opts.client, owned: false });
    } else if (opts.url) {
      const pkg = "@libsql/client";
      this.clientPromise = import(pkg).then((mod) => {
        const createClient = mod.createClient ?? mod.default?.createClient;
        if (!createClient) throw new Error("@libsql/client createClient export not found");
        return {
          client: createClient({ url: opts.url, ...(opts.authToken ? { authToken: opts.authToken } : {}) }) as LibsqlClientLike,
          owned: true,
        };
      });
    } else {
      throw new Error("LibsqlConnector requires either url or client");
    }
  }

  async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const { client } = await this.clientPromise;
    return await makeConn(client).query<T>(sql, params);
  }

  async execute(sql: string, params: unknown[] = []): Promise<SqlExecuteResult> {
    const { client } = await this.clientPromise;
    return await makeConn(client).execute(sql, params);
  }

  async transaction<T>(fn: (tx: SqlConnection) => Promise<T>): Promise<T> {
    const { client } = await this.clientPromise;
    if (client.transaction) {
      const tx = await client.transaction("write");
      try {
        const out = await fn(makeConn(tx));
        await tx.commit();
        return out;
      } catch (err) {
        await tx.rollback().catch(() => {});
        throw err;
      }
    }
    return await fn(makeConn(client));
  }

  async close(): Promise<void> {
    const { client, owned } = await this.clientPromise;
    if (owned) client.close?.();
  }
}
