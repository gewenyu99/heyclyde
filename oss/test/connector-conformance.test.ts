import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  createSqlConnector,
  loadConnector,
  migrate,
  MysqlConnector,
  ph,
  PostgresConnector,
  queryBuilder,
  SqliteConnector,
  tbl,
} from "../src/connectors/index.ts";
import type { SqlRow } from "../src/connectors/types.ts";
import { LocalFsBlobStore } from "../src/runtime/blobs.ts";
import { defaultConfig } from "../src/runtime/config.ts";
import { createLlmProvider } from "../src/runtime/llm.ts";
import { MemoryStore } from "../src/store/memory-store.ts";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeOfflineStore(connector: ReturnType<typeof createSqlConnector> | SqliteConnector, dir: string) {
  const cfg = defaultConfig();
  cfg.server.data_dir = dir;
  cfg.blobs.dir = join(dir, "blobs");
  cfg.embeddings.provider = "none";
  cfg.judge.provider = "none";
  const blobs = new LocalFsBlobStore({ dir: cfg.blobs.dir });
  const llm = createLlmProvider(cfg);
  return new MemoryStore(connector, blobs, llm, cfg);
}

test("SQLite in-memory migration seeds defaults and FTS5 handles English + CJK", async () => {
  const conn = new SqliteConnector({ path: ":memory:" });
  await migrate(conn);

  const params = await conn.query<{ id: string }>("SELECT id FROM param_set ORDER BY id");
  assert.deepEqual(
    params.map((r) => r.id),
    ["hybrid.v1", "index.v1", "spreading.v1"],
  );

  const clock = await conn.query<{ value: string }>("SELECT value FROM setting WHERE name = 'recall_clock_seq'");
  assert.equal(clock[0]?.value, "0");

  const dir = makeTempDir("clyde-sqlite-fts-");
  try {
    const store = makeOfflineStore(conn, dir);
    // Use runtime caller with explicit project and id to exercise privileged write path as well.
    await store.remember(
      {
        id: "fts-proj-1",
        pattern: "projects",
        authority: "approved",
        title: "SQLite FTS project",
        body: "Root project entry for SQLite FTS tests.",
        source: { kind: "doc", title: "Test setup", uri: "mem://setup" },
        evidence_kind: "quote",
        evidence: "Root project entry for SQLite FTS tests.",
      },
      "runtime",
      "runtime",
      "local",
    );
    await store.remember(
      {
        id: "fts-eng-1",
        pattern: "observations",
        kind: "observation",
        authority: "approved",
        project: "fts-proj-1",
        title: "Distributed cache eviction behavior",
        body: "Workers cached stale entries after TTL expiry unless explicitly invalidated.",
        source: { kind: "doc", title: "Test setup", uri: "mem://setup" },
        evidence_kind: "quote",
        evidence: "Workers cached stale entries after TTL expiry.",
      },
      "runtime",
      "runtime",
      "local",
    );
    await store.remember(
      {
        id: "fts-zh-1",
        pattern: "observations",
        kind: "observation",
        authority: "approved",
        project: "fts-proj-1",
        title: "本地记忆检索测试",
        body: "记忆检索系统支持中文双字索引和离线运行。",
        source: { kind: "doc", title: "Test setup", uri: "mem://setup" },
        evidence_kind: "quote",
        evidence: "记忆检索系统支持中文双字索引。",
      },
      "runtime",
      "runtime",
      "local",
    );

    const engHits = await conn.ftsSearchEnglish?.("caching stale", 10, "entry_fts");
    assert.ok(engHits && engHits.some((h) => h.id === "fts-eng-1"));

    const zhHits = await conn.ftsSearchChinese?.(["记忆", "忆检", "检索"], 10, "entry_fts_zh");
    assert.ok(zhHits && zhHits.some((h) => h.id === "fts-zh-1"));
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("File-backed SQLite enables WAL, busy_timeout, and serializes concurrent writes", async () => {
  const dir = makeTempDir("clyde-sqlite-wal-");
  const dbPath = join(dir, "memory.db");
  const conn = new SqliteConnector({ path: dbPath });
  try {
    await migrate(conn);
    const modeRow = await conn.query<{ journal_mode: string }>("PRAGMA journal_mode");
    assert.equal(String(modeRow[0]?.journal_mode).toLowerCase(), "wal");
    const busyRow = await conn.query<{ timeout: number }>("PRAGMA busy_timeout");
    assert.equal(Number(busyRow[0]?.timeout), 5000);

    await Promise.all(
      Array.from({ length: 10 }, (_, idx) =>
        conn.transaction(async (tx) => {
          const rows = await tx.query<{ value: string }>("SELECT value FROM setting WHERE name = 'recall_clock_seq'");
          const cur = Number(rows[0].value);
          await tx.execute("UPDATE setting SET value = ? WHERE name = 'recall_clock_seq'", [String(cur + 1)]);
          await tx.execute(
            "INSERT INTO agent (owner_id, name, context, surface, description, created_at, updated_at) VALUES (?, ?, 'work', 'cli', 'worker', ?, ?)",
            ["local", `worker-${idx}`, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
          );
        }),
      ),
    );

    const finalClock = await conn.query<{ value: string }>("SELECT value FROM setting WHERE name = 'recall_clock_seq'");
    assert.equal(finalClock[0]?.value, "10");
    const agents = await conn.query<{ c: number }>("SELECT COUNT(*) AS c FROM agent");
    assert.equal(Number(agents[0]?.c), 10);
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Generic non-FTS5 custom SqlConnector runs full CRUD, JS BM25 English+CJK, quests, messages, and export/import", async () => {
  const rawDb = new DatabaseSync(":memory:");
  const mapParams = (params: unknown[]) =>
    params.map((v) => {
      if (v === undefined) return null;
      if (typeof v === "boolean") return v ? 1 : 0;
      return v as string | number | Uint8Array | null;
    });

  const conn = createSqlConnector({
    dialect: "generic",
    name: "generic-mem",
    tablePrefix: "test_",
    supportsFts5: false,
    async query<T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> {
      const stmt = rawDb.prepare(sql);
      return stmt.all(...mapParams(params)).map((r) => ({ ...r })) as T[];
    },
    async execute(sql, params = []) {
      const res = rawDb.prepare(sql).run(...mapParams(params));
      return {
        rowsAffected: Number(res.changes ?? 0),
        lastInsertId: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
      };
    },
    async transaction(fn) {
      rawDb.exec("BEGIN IMMEDIATE");
      try {
        const out = await fn({
          query: async <T extends SqlRow = SqlRow>(sql: string, params: unknown[] = []): Promise<T[]> =>
            rawDb.prepare(sql).all(...mapParams(params)).map((r) => ({ ...r })) as T[],
          execute: async (sql, params = []) => {
            const res = rawDb.prepare(sql).run(...mapParams(params));
            return {
              rowsAffected: Number(res.changes ?? 0),
              lastInsertId: res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : undefined,
            };
          },
        });
        rawDb.exec("COMMIT");
        return out;
      } catch (e) {
        try {
          rawDb.exec("ROLLBACK");
        } catch {
          // ignore
        }
        throw e;
      }
    },
    async close() {
      rawDb.close();
    },
  });

  const dir = makeTempDir("clyde-generic-");
  try {
    await migrate(conn);
    const store = makeOfflineStore(conn, dir);
    await store.ensureSession("s1", "agent-a");
    await store.registerAgent("local", "agent-a", {
      name: "alpha",
      context: "work",
      surface: "cli",
      description: "Primary worker",
    });
    const whoA = await store.resolveAgent("local", "agent-a");

    const engSaved = await store.remember(
      {
        pattern: "decisions",
        kind: "observation",
        title: "Use connection pool limit 20 on read replicas",
        body: "Read replicas throttle above 25 concurrent connections during batch backfills.",
        evidence_kind: "assistant",
        evidence: "Read replicas throttle above 25 concurrent connections.",
      },
      "agent",
      "alpha",
      "local",
    );
    const zhSaved = await store.remember(
      {
        pattern: "observations",
        kind: "observation",
        title: "队列重试退避策略",
        body: "消息队列失败后采用指数退避重试，避免瞬时雪崩。",
        evidence_kind: "assistant",
        evidence: "消息队列失败后采用指数退避重试。",
      },
      "agent",
      "alpha",
      "local",
    );

    // JS BM25 English recall
    const recEng = await store.recall({
      session: "s1",
      query: "replica connection pool throttle",
      task: "tune pool",
      agent: "alpha",
      scope: null,
      principal: "local",
      surface: "mcp",
      depth: "packet",
      agentIdentity: whoA,
    });
    assert.ok(recEng.text.includes(engSaved.id), recEng.text);
    assert.equal(recEng.delivered.includes(engSaved.id) || recEng.onTrial.includes(engSaved.id), true);

    // JS BM25 Chinese recall
    const recZh = await store.recall({
      session: "s1",
      query: "指数退避重试",
      task: "queue retry",
      agent: "alpha",
      scope: null,
      principal: "local",
      surface: "mcp",
      depth: "packet",
      agentIdentity: whoA,
    });
    assert.ok(recZh.text.includes(zhSaved.id), recZh.text);

    // Optimistic quest claim and collision on generic connector
    const quest = await store.postQuest(whoA, {
      title: "Benchmark pool sizing",
      brief: "Measure latency under 15 vs 20 connections.",
      done_when: "Report p95 latency.",
      priority: "high",
    });
    const claimed = await store.claimQuest(whoA, quest.id, 30);
    assert.equal(claimed.status, "claimed");

    await assert.rejects(
      () =>
        store.claimQuest(
          { name: "beta", family: "beta", principal: "local", session: "s2", context: "work", profile: null },
          quest.id,
          30,
        ),
      /claimed|not open/i,
    );

    // Messages round-trip
    await store.postMessage("alpha", "alpha", "Check queue metrics");
    const msgs = await store.checkMessages("alpha");
    assert.equal(msgs.length, 1);
    assert.equal(await store.ackMessages("alpha", [msgs[0].id]), 1);
    assert.equal((await store.checkMessages("alpha")).length, 0);

    // Export -> stats (2 written entries + 1 auto-created notes-alpha project container)
    const st = await store.stats();
    assert.equal(st.counts.entries, 3);
    assert.equal(st.fts5, false);
    const ndjson = await store.exportNdjson();
    assert.ok(ndjson.includes(engSaved.id));
  } finally {
    await conn.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SQL query compiler & mock Postgres/MySQL connectors generate dialect-safe queries and transactions", async () => {
  assert.equal(tbl("entry", { dialect: "postgres", schema: "clyde_mem", tablePrefix: "app_" }), "clyde_mem.app_entry");
  assert.equal(tbl("entry", { dialect: "sqlite", tablePrefix: "app_" }), "app_entry");
  assert.throws(() => tbl("entry;DROP TABLE x", { dialect: "sqlite" }), /Invalid/);

  assert.equal(ph("postgres", 3), "$3");
  assert.equal(ph("sqlite", 3), "?");
  assert.equal(ph("mysql", 3), "?");

  const pgBuilt = queryBuilder("postgres")
    .raw("SELECT * FROM entry WHERE owner_id = ")
    .val("local")
    .raw(" AND id IN ")
    .inList(["a", "b"])
    .build();
  assert.equal(pgBuilt.sql, "SELECT * FROM entry WHERE owner_id = $1 AND id IN ($2, $3)");
  assert.deepEqual(pgBuilt.params, ["local", "a", "b"]);

  const myBuilt = queryBuilder("mysql")
    .raw("SELECT * FROM entry WHERE owner_id = ")
    .val("local")
    .raw(" AND id IN ")
    .inList(["a", "b"])
    .build();
  assert.equal(myBuilt.sql, "SELECT * FROM entry WHERE owner_id = ? AND id IN (?, ?)");
  assert.deepEqual(myBuilt.params, ["local", "a", "b"]);

  const pgCalls: { sql: string; params: unknown[] }[] = [];
  const pgConn = new PostgresConnector({
    schema: "clyde",
    tablePrefix: "m_",
    client: {
      async query(text, params = []) {
        pgCalls.push({ sql: text, params });
        return { rows: text.startsWith("SELECT") ? [{ ok: 1 }] : [], rowCount: 1 };
      },
      async connect() {
        return {
          async query(text, params = []) {
            pgCalls.push({ sql: text, params });
            return { rows: text.startsWith("SELECT") ? [{ id: 7 }] : [], rowCount: 1 };
          },
          release() {},
        };
      },
      async end() {},
    },
  });

  await pgConn.query("SELECT * FROM clyde.m_entry WHERE id = $1", ["e1"]);
  await assert.rejects(
    () =>
      pgConn.transaction(async (tx) => {
        await tx.execute("INSERT INTO x VALUES ($1)", [1]);
        throw new Error("boom");
      }),
    /boom/,
  );
  assert.ok(pgCalls.some((c) => c.sql === "BEGIN"));
  assert.ok(pgCalls.some((c) => c.sql === "ROLLBACK"));
  await pgConn.close();

  const myCalls: string[] = [];
  const myConn = new MysqlConnector({
    tablePrefix: "m_",
    client: {
      async query(sql) {
        return await this.execute(sql);
      },
      async execute(sql) {
        myCalls.push(sql);
        return [[], { affectedRows: 1, insertId: 42 }];
      },
      async getConnection() {
        return {
          async query(sql) {
            myCalls.push(sql);
            return [[{ id: 1 }], { affectedRows: 1 }];
          },
          async execute(sql) {
            myCalls.push(sql);
            return [[{ id: 1 }], { affectedRows: 1 }];
          },
          async beginTransaction() {
            myCalls.push("BEGIN");
          },
          async commit() {
            myCalls.push("COMMIT");
          },
          async rollback() {
            myCalls.push("ROLLBACK");
          },
          release() {},
        };
      },
      async end() {},
    },
  });
  const txOut = await myConn.transaction(async (tx) => {
    const r = await tx.query<{ id: number }>("SELECT id FROM m_entry");
    return r[0].id;
  });
  assert.equal(txOut, 1);
  assert.ok(myCalls.includes("BEGIN") && myCalls.includes("COMMIT"));
  await myConn.close();
});

test("loadConnector dynamically loads a custom connector .mjs file relative to config directory", async () => {
  const dir = makeTempDir("clyde-custom-loader-");
  try {
    const modPath = join(dir, "custom-conn.mjs");
    writeFileSync(
      modPath,
      [
        'import { DatabaseSync } from "node:sqlite";',
        "export function createConnector(dbConfig) {",
        '  const raw = new DatabaseSync(":memory:");',
        "  const map = (p) => p.map((v) => v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);",
        "  return {",
        '    dialect: "generic",',
        '    name: "dynamic-custom-sqlite",',
        "    tablePrefix: dbConfig.table_prefix,",
        "    supportsFts5: false,",
        "    async query(sql, params = []) { return raw.prepare(sql).all(...map(params)).map((r) => ({ ...r })); },",
        "    async execute(sql, params = []) {",
        "      const r = raw.prepare(sql).run(...map(params));",
        "      return { rowsAffected: Number(r.changes ?? 0), lastInsertId: r.lastInsertRowid !== undefined ? Number(r.lastInsertRowid) : undefined };",
        "    },",
        "    async transaction(fn) {",
        '      raw.exec("BEGIN");',
        "      try {",
        "        const out = await fn({ query: this.query.bind(this), execute: this.execute.bind(this) });",
        '        raw.exec("COMMIT");',
        "        return out;",
        '      } catch (e) { raw.exec("ROLLBACK"); throw e; }',
        "    },",
        "    async close() { raw.close(); },",
        "  };",
        "}",
      ].join("\n"),
    );

    const conn = await loadConnector({ connector: "./custom-conn.mjs", table_prefix: "dyn_" }, dir);
    assert.equal(conn.name, "dynamic-custom-sqlite");
    await migrate(conn);
    const store = makeOfflineStore(conn, dir);
    const saved = await store.remember(
      {
        pattern: "references",
        kind: "observation",
        title: "Custom connector verified",
        body: "Loaded dynamically from config path.",
        evidence_kind: "assistant",
        evidence: "Loaded dynamically from config path.",
      },
      "agent",
      "tester",
      "local",
    );
    const entryText = await store.getEntry(saved.id);
    assert.ok(entryText && entryText.includes("Custom connector verified"));
    await conn.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MySQL migration avoids IF NOT EXISTS on CREATE INDEX and Postgres importNdjson uses SAVEPOINT on duplicate keys", async () => {
  // MySQL mock captures DDL sent via query() vs execute() and simulates duplicate index errno 1061.
  const myQuerySqls: string[] = [];
  const myExecSqls: string[] = [];
  let failDupIndex = true;
  const myMigratorConn = new MysqlConnector({
    client: {
      async query(sql) {
        myQuerySqls.push(sql);
        if (sql.startsWith("CREATE") && sql.includes("INDEX")) {
          if (sql.includes("IF NOT EXISTS")) throw new Error("MySQL syntax error: IF NOT EXISTS on CREATE INDEX");
          if (failDupIndex) {
            failDupIndex = false;
            const err = new Error("Duplicate key name") as Error & { errno?: number };
            err.errno = 1061;
            throw err;
          }
        }
        return [[], { affectedRows: 0 }];
      },
      async execute(sql) {
        myExecSqls.push(sql);
        return [[], { affectedRows: 1 }];
      },
      async end() {},
    },
  });
  await migrate(myMigratorConn);
  assert.ok(myQuerySqls.some((s) => s.includes("CREATE TABLE IF NOT EXISTS")));
  assert.ok(myQuerySqls.some((s) => /^CREATE (UNIQUE )?INDEX /.test(s)));
  assert.equal(myExecSqls.some((s) => s.startsWith("CREATE TABLE")), false);
  await myMigratorConn.close();

  // Invalid Postgres schema name must throw before executing DDL.
  const badSchemaConn = createSqlConnector({
    dialect: "postgres",
    schema: "bad;DROP SCHEMA public",
    async query() {
      return [];
    },
    async execute() {
      return { rowsAffected: 0 };
    },
  });
  await assert.rejects(() => migrate(badSchemaConn), /Invalid/);

  // Postgres importNdjson wraps each INSERT in SAVEPOINT/RELEASE/ROLLBACK TO SAVEPOINT.
  const pgImportSqls: string[] = [];
  let rowCount = 0;
  const pgRunQuery = async (sql: string): Promise<{ rows: SqlRow[]; rowCount: number }> => {
    pgImportSqls.push(sql);
    if (sql.startsWith("SELECT")) return { rows: [{ version: 1 }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO entry")) {
      rowCount++;
      if (rowCount === 1) throw new Error("duplicate key value violates unique constraint");
    }
    return { rows: [], rowCount: 1 };
  };
  const pgMock = new PostgresConnector({
    client: {
      query: pgRunQuery,
      async connect() {
        return {
          query: pgRunQuery,
          release() {},
        };
      },
      async end() {},
    },
  });
  const tmpDir = makeTempDir("clyde-pg-imp-");
  try {
    const pgStore = makeOfflineStore(pgMock, tmpDir);
    const ndjson = [
      JSON.stringify({ table: "entry", row: { owner_id: "local", id: "dup-1", title: "A", body: "B", pattern: "observations", authority: "draft", scope: "global", valid_from: "2026-01-01", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } }),
      JSON.stringify({ table: "entry", row: { owner_id: "local", id: "ok-2", title: "C", body: "D", pattern: "observations", authority: "draft", scope: "global", valid_from: "2026-01-01", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" } }),
    ].join("\n");
    const res = await pgStore.importNdjson(ndjson);
    assert.equal(res.imported, 1);
    assert.ok(pgImportSqls.includes("SAVEPOINT clyde_imp"));
    assert.ok(pgImportSqls.includes("ROLLBACK TO SAVEPOINT clyde_imp"));
    assert.ok(pgImportSqls.includes("RELEASE SAVEPOINT clyde_imp"));
  } finally {
    await pgMock.close();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
