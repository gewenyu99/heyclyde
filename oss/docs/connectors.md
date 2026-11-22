# SQL Connectors

Clyde routes all database calls through `SqlConnector` (`src/connectors/types.ts`).

Vector search runs over an in-process cosine cache loaded from `entry_embedding`. Keyword search uses SQLite `FTS5` when available and falls back to built-in BM25 and CJK bigram rankers (`src/store/bm25.ts`), so connectors need no custom search or vector extensions.

## Built-in Connectors

### SQLite (default)

Uses the built-in `node:sqlite` driver with `WAL` mode, `busy_timeout = 5000`, `FTS5` English and CJK bigram indexes, and a serialized write mutex.

```toml
[database]
connector = "sqlite"
path = "~/.local/share/clyde/clyde.db"
```

### PostgreSQL

Install `pg` or `postgres`, then configure `clyde.toml`:

```toml
[database]
connector = "postgres"
url = "${DATABASE_URL}"
schema = "clyde"
```

### MySQL and MariaDB

Install `mysql2`, then configure `clyde.toml`:

```toml
[database]
connector = "mysql"
url = "${DATABASE_URL}"
table_prefix = "clyde_"
```

### LibSQL and Turso

Install `@libsql/client`, then configure `clyde.toml`:

```toml
[database]
connector = "libsql"
url = "${LIBSQL_URL}"
auth_token = "${LIBSQL_AUTH_TOKEN}"
```

## Custom SQL Connectors

Point `database.connector` in `clyde.toml` to a local `.ts` or `.mjs` module or package exporting `createConnector(dbConfig)` or a default `SqlConnector` (or factory function):

```ts
import { createSqlConnector } from "./src/connectors/custom.ts";

export function createConnector(cfg) {
  return createSqlConnector({
    dialect: "generic", // uses `?` placeholders ("postgres" uses `$1, $2...`)
    name: "my-sql-driver",
    tablePrefix: cfg.table_prefix,
    async query(sql, params) {
      return await myDriver.all(sql, params);
    },
    async execute(sql, params) {
      const res = await myDriver.run(sql, params);
      return { rowsAffected: res.changes, lastInsertId: res.lastId };
    },
    async transaction(fn) {
      return await myDriver.tx((tx) => fn({
        query: (s, p) => tx.all(s, p),
        execute: (s, p) => tx.run(s, p),
      }));
    },
    async close() {
      await myDriver.close();
    },
  });
}
```
