// Portable consolidated schema migration and seed setup across SQLite, Postgres, MySQL, and generic SQL connectors.
import { DEFAULT_PARAM_SETS } from "../core/params.ts";
import { nowIso, tbl, toJson, validIdent } from "./query.ts";
import type { SqlConnector, SqlDialect } from "./types.ts";

type DialectTypes = {
  idPk: string;
  key: string;
  shortText: string;
  longText: string;
  intCol: string;
  bigIntCol: string;
  floatCol: string;
  boolInt: string;
  blobCol: string;
};

function typesFor(dialect: SqlDialect): DialectTypes {
  switch (dialect) {
    case "postgres":
      return {
        idPk: "BIGSERIAL PRIMARY KEY",
        key: "VARCHAR(191)",
        shortText: "TEXT",
        longText: "TEXT",
        intCol: "INTEGER",
        bigIntCol: "BIGINT",
        floatCol: "DOUBLE PRECISION",
        boolInt: "SMALLINT",
        blobCol: "BYTEA",
      };
    case "mysql":
      return {
        idPk: "BIGINT AUTO_INCREMENT PRIMARY KEY",
        key: "VARCHAR(191)",
        shortText: "VARCHAR(512)",
        longText: "LONGTEXT",
        intCol: "INT",
        bigIntCol: "BIGINT",
        floatCol: "DOUBLE",
        boolInt: "SMALLINT",
        blobCol: "LONGBLOB",
      };
    default:
      return {
        idPk: "INTEGER PRIMARY KEY AUTOINCREMENT",
        key: "VARCHAR(191)",
        shortText: "TEXT",
        longText: "TEXT",
        intCol: "INTEGER",
        bigIntCol: "INTEGER",
        floatCol: "REAL",
        boolInt: "INTEGER",
        blobCol: "BLOB",
      };
  }
}

export async function migrate(connector: SqlConnector): Promise<void> {
  const t = typesFor(connector.dialect);
  const T = (name: string) => tbl(name, connector);

  if (connector.dialect === "postgres" && connector.schema) {
    const schemaName = validIdent(connector.schema, "schema");
    await connector.execute(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`);
  }

  await connector.execute(`
    CREATE TABLE IF NOT EXISTS ${T("schema_migrations")} (
      version ${t.intCol} PRIMARY KEY,
      applied_at ${t.key} NOT NULL
    )
  `);

  const applied = await connector.query<{ version: number }>(
    `SELECT version FROM ${T("schema_migrations")} WHERE version = ${connector.dialect === "postgres" ? "$1" : "?"}`,
    [1],
  );
  if (applied.length > 0) {
    await seedDefaults(connector);
    return;
  }

  const statements: string[] = [
    `CREATE TABLE IF NOT EXISTS ${T("source")} (
      owner_id ${t.key} NOT NULL,
      id ${t.key} NOT NULL,
      kind ${t.key},
      title ${t.shortText},
      uri ${t.longText},
      date ${t.key},
      PRIMARY KEY (owner_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("entry")} (
      owner_id ${t.key} NOT NULL,
      id ${t.key} NOT NULL,
      pattern ${t.key} NOT NULL,
      title ${t.shortText} NOT NULL,
      body ${t.longText} NOT NULL,
      authority ${t.key} NOT NULL,
      scope ${t.key} NOT NULL,
      sensitivity ${t.key} NOT NULL DEFAULT 'normal',
      lang ${t.key} NOT NULL DEFAULT 'en',
      valid_from ${t.key} NOT NULL,
      source_id ${t.key},
      evidence_kind ${t.key},
      evidence ${t.longText},
      evidence_sha256 ${t.key},
      project ${t.key},
      origin ${t.key} NOT NULL DEFAULT 'runtime',
      payload_sha256 ${t.key},
      kind ${t.key} NOT NULL DEFAULT 'observation',
      confidence ${t.floatCol} NOT NULL DEFAULT 0.5,
      chances_left ${t.intCol} NOT NULL DEFAULT 0,
      miss_streak ${t.intCol} NOT NULL DEFAULT 0,
      evidence_event ${t.key},
      verified ${t.boolInt},
      category ${t.key} NOT NULL DEFAULT 'general',
      context ${t.key} NOT NULL DEFAULT 'general',
      transferability ${t.key} NOT NULL DEFAULT 'general',
      project_slug ${t.key},
      computer ${t.key},
      search_text ${t.longText} NOT NULL DEFAULT '',
      written_seq ${t.bigIntCol} NOT NULL DEFAULT 0,
      created_at ${t.key} NOT NULL,
      updated_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("link")} (
      owner_id ${t.key} NOT NULL,
      src ${t.key} NOT NULL,
      dst ${t.key} NOT NULL,
      type ${t.key} NOT NULL,
      weight ${t.floatCol} NOT NULL DEFAULT 1.0,
      PRIMARY KEY (owner_id, src, dst, type)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("co_use")} (
      owner_id ${t.key} NOT NULL,
      src ${t.key} NOT NULL,
      dst ${t.key} NOT NULL,
      sessions_json ${t.longText} NOT NULL DEFAULT '[]',
      uses ${t.intCol} NOT NULL DEFAULT 1,
      misses ${t.intCol} NOT NULL DEFAULT 0,
      updated_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, src, dst)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("blob")} (
      owner_id ${t.key} NOT NULL,
      sha256 ${t.key} NOT NULL,
      media_type ${t.key} NOT NULL,
      size ${t.bigIntCol} NOT NULL,
      content ${t.blobCol},
      stored ${t.key} NOT NULL DEFAULT 'db',
      created_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, sha256)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("entry_blob")} (
      owner_id ${t.key} NOT NULL,
      entry_id ${t.key} NOT NULL,
      name ${t.key} NOT NULL,
      sha256 ${t.key} NOT NULL,
      kind ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, entry_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("entry_provenance")} (
      owner_id ${t.key} NOT NULL,
      entry_id ${t.key} NOT NULL,
      device ${t.key},
      agent ${t.key},
      agent_context ${t.key},
      repo ${t.key},
      cwd ${t.shortText},
      session ${t.key},
      run_scope ${t.key},
      created_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, entry_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("entry_embedding")} (
      owner_id ${t.key} NOT NULL,
      entry_id ${t.key} NOT NULL,
      model ${t.key} NOT NULL,
      dimensions ${t.intCol} NOT NULL,
      content_sha256 ${t.key} NOT NULL,
      embedding ${t.blobCol} NOT NULL,
      updated_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, entry_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("upload")} (
      owner_id ${t.key} NOT NULL,
      principal ${t.key} NOT NULL,
      sha256 ${t.key} NOT NULL,
      size ${t.bigIntCol} NOT NULL,
      media_type ${t.key} NOT NULL,
      created_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, principal, sha256)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("agent")} (
      owner_id ${t.key} NOT NULL,
      name ${t.key} NOT NULL,
      nickname ${t.key},
      context ${t.key} NOT NULL,
      surface ${t.key} NOT NULL,
      description ${t.shortText} NOT NULL,
      projects_json ${t.longText} NOT NULL DEFAULT '[]',
      repos_json ${t.longText} NOT NULL DEFAULT '[]',
      computer ${t.key},
      agent_type ${t.key} NOT NULL DEFAULT 'other',
      harness ${t.key},
      strict_projects ${t.boolInt} NOT NULL DEFAULT 0,
      created_at ${t.key} NOT NULL,
      updated_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("agent_binding")} (
      owner_id ${t.key} NOT NULL,
      principal ${t.key} NOT NULL,
      client ${t.key} NOT NULL,
      agent_name ${t.key} NOT NULL,
      updated_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, principal, client)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("device")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      name ${t.key} NOT NULL,
      token_sha256 ${t.key} NOT NULL,
      hooks ${t.key} NOT NULL DEFAULT 'full',
      created_at ${t.key} NOT NULL,
      last_seen ${t.key},
      revoked_at ${t.key}
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("mcp_session")} (
      owner_id ${t.key} NOT NULL,
      id ${t.key} NOT NULL,
      client ${t.key},
      agent ${t.key},
      cwd ${t.shortText},
      repo ${t.key},
      harness_session_id ${t.key},
      param_set ${t.key},
      unit_hash ${t.key},
      propensity ${t.floatCol},
      created_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("mcp_client")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      session_id ${t.key} NOT NULL,
      name ${t.key},
      version ${t.key},
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("param_set")} (
      id ${t.key} PRIMARY KEY,
      arm ${t.key} NOT NULL,
      params_json ${t.longText} NOT NULL,
      parent ${t.key},
      note ${t.shortText},
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("allocation")} (
      param_set ${t.key} PRIMARY KEY,
      role ${t.key} NOT NULL,
      weight ${t.intCol} NOT NULL DEFAULT 0,
      updated_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("retrieval")} (
      id ${t.key} PRIMARY KEY,
      owner_id ${t.key} NOT NULL,
      mcp_session ${t.key},
      agent ${t.key},
      surface ${t.key},
      scope ${t.key},
      query ${t.longText} NOT NULL,
      task ${t.shortText},
      arm ${t.key} NOT NULL,
      param_set ${t.key} NOT NULL,
      candidates_json ${t.longText} NOT NULL DEFAULT '[]',
      delivered_json ${t.longText} NOT NULL DEFAULT '[]',
      on_trial_json ${t.longText} NOT NULL DEFAULT '[]',
      rejected_json ${t.longText} NOT NULL DEFAULT '[]',
      context_json ${t.longText} NOT NULL DEFAULT '{}',
      frontier_json ${t.longText},
      degraded ${t.shortText},
      latency_ms ${t.intCol},
      llm_tokens ${t.intCol} NOT NULL DEFAULT 0,
      seq ${t.bigIntCol} NOT NULL,
      learned_at ${t.key},
      reaction_json ${t.longText},
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("event")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      event ${t.key} NOT NULL,
      session_id ${t.key},
      agent ${t.key},
      device ${t.key},
      cwd ${t.shortText},
      git_remote ${t.shortText},
      tool_name ${t.key},
      payload_json ${t.longText} NOT NULL DEFAULT '{}',
      seq ${t.bigIntCol} NOT NULL DEFAULT 0,
      received_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("feedback")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      retrieval_id ${t.key} NOT NULL,
      entry_id ${t.key},
      source ${t.key} NOT NULL,
      verdict ${t.key} NOT NULL,
      note ${t.longText},
      seq ${t.bigIntCol} NOT NULL DEFAULT 0,
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("confidence_log")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      target ${t.key} NOT NULL,
      before_val ${t.floatCol},
      after_val ${t.floatCol} NOT NULL,
      reason ${t.shortText} NOT NULL,
      retrieval_id ${t.key},
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("message")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      sender ${t.key} NOT NULL,
      recipient ${t.key} NOT NULL,
      body ${t.longText} NOT NULL,
      target_context ${t.key},
      target_project ${t.key},
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("message_delivery")} (
      owner_id ${t.key} NOT NULL,
      message_id ${t.bigIntCol} NOT NULL,
      agent_name ${t.key} NOT NULL,
      delivered_at ${t.key},
      acked_at ${t.key},
      dismissed_at ${t.key},
      attempts ${t.intCol} NOT NULL DEFAULT 0,
      PRIMARY KEY (owner_id, message_id, agent_name)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("quest")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      title ${t.shortText} NOT NULL,
      brief ${t.longText} NOT NULL,
      done_when ${t.shortText} NOT NULL,
      priority ${t.key} NOT NULL DEFAULT 'normal',
      context ${t.key} NOT NULL DEFAULT 'both',
      project ${t.key},
      computer ${t.key},
      agent_type ${t.key},
      assignee ${t.key} NOT NULL DEFAULT 'any',
      target_json ${t.longText} NOT NULL DEFAULT '{}',
      tags_json ${t.longText} NOT NULL DEFAULT '[]',
      status ${t.key} NOT NULL DEFAULT 'open',
      poster ${t.key} NOT NULL,
      claimed_by ${t.key},
      claimed_at ${t.key},
      lease_until ${t.key},
      evidence ${t.longText},
      entry_id ${t.key},
      close_reason ${t.shortText},
      created_at ${t.key} NOT NULL,
      updated_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("quest_note")} (
      id ${t.idPk},
      owner_id ${t.key} NOT NULL,
      quest_id ${t.bigIntCol} NOT NULL,
      author ${t.key} NOT NULL,
      note ${t.longText} NOT NULL,
      created_at ${t.key} NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("quest_blob")} (
      owner_id ${t.key} NOT NULL,
      quest_id ${t.bigIntCol} NOT NULL,
      name ${t.key} NOT NULL,
      sha256 ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, quest_id, name)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("board_seen")} (
      owner_id ${t.key} NOT NULL,
      principal ${t.key} NOT NULL,
      agent ${t.key} NOT NULL,
      seen_at ${t.key} NOT NULL,
      PRIMARY KEY (owner_id, principal, agent)
    )`,
    `CREATE TABLE IF NOT EXISTS ${T("setting")} (
      name ${t.key} PRIMARY KEY,
      value ${t.longText} NOT NULL
    )`,
  ];

  const indexes: { unique?: boolean; name: string; table: string; cols: string }[] = [
    { name: "entry_scope_idx", table: "entry", cols: "owner_id, pattern, authority, context" },
    { name: "link_dst_idx", table: "link", cols: "owner_id, dst, type" },
    { unique: true, name: "device_hash_idx", table: "device", cols: "token_sha256" },
    { name: "retrieval_seq_idx", table: "retrieval", cols: "owner_id, seq" },
    { name: "event_session_idx", table: "event", cols: "owner_id, session_id, received_at" },
    { name: "feedback_heat_idx", table: "feedback", cols: "owner_id, entry_id, seq" },
    { name: "quest_status_idx", table: "quest", cols: "owner_id, status, priority, created_at" },
  ];

  if (connector.supportsFts5 && connector.dialect === "sqlite") {
    statements.push(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${T("entry_fts")} USING fts5(entry_id UNINDEXED, text, tokenize='porter unicode61')`,
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${T("entry_fts_zh")} USING fts5(entry_id UNINDEXED, bigrams, tokenize='unicode61')`,
    );
  }

  for (const stmt of statements) {
    await connector.execute(stmt);
  }

  for (const idx of indexes) {
    const idxName = tbl(idx.name, { dialect: connector.dialect, tablePrefix: connector.tablePrefix });
    const kind = idx.unique ? "UNIQUE INDEX" : "INDEX";
    if (connector.dialect === "mysql") {
      try {
        await connector.execute(`CREATE ${kind} ${idxName} ON ${T(idx.table)} (${idx.cols})`);
      } catch (err) {
        const errno = (err as { errno?: number })?.errno;
        const msg = err instanceof Error ? err.message : String(err);
        if (errno !== 1061 && errno !== 1831 && !/Duplicate key name|already exists/i.test(msg)) {
          throw err;
        }
      }
    } else {
      await connector.execute(`CREATE ${kind} IF NOT EXISTS ${idxName} ON ${T(idx.table)} (${idx.cols})`);
    }
  }

  const p1 = connector.dialect === "postgres" ? "$1, $2" : "?, ?";
  await connector.execute(`INSERT INTO ${T("schema_migrations")} (version, applied_at) VALUES (${p1})`, [1, nowIso()]);
  await seedDefaults(connector);
}

async function seedDefaults(connector: SqlConnector): Promise<void> {
  const T = (name: string) => tbl(name, connector);
  const p = (i: number) => (connector.dialect === "postgres" ? `$${i}` : "?");
  const now = nowIso();

  for (const s of DEFAULT_PARAM_SETS) {
    const existing = await connector.query<{ id: string }>(
      `SELECT id FROM ${T("param_set")} WHERE id = ${p(1)}`,
      [s.id],
    );
    if (!existing.length) {
      await connector.execute(
        `INSERT INTO ${T("param_set")} (id, arm, params_json, parent, note, created_at) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)})`,
        [s.id, s.arm, toJson(s.params), null, "Default parameter set", now],
      );
    }
  }

  const allocSeed: [string, string, number][] = [
    ["index.v1", "off", 0],
    ["hybrid.v1", "off", 0],
    ["spreading.v1", "default", 1000],
  ];
  for (const [paramSet, role, weight] of allocSeed) {
    const existing = await connector.query<{ param_set: string }>(
      `SELECT param_set FROM ${T("allocation")} WHERE param_set = ${p(1)}`,
      [paramSet],
    );
    if (!existing.length) {
      await connector.execute(
        `INSERT INTO ${T("allocation")} (param_set, role, weight, updated_at) VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)})`,
        [paramSet, role, weight, now],
      );
    }
  }

  const clockRow = await connector.query<{ name: string }>(
    `SELECT name FROM ${T("setting")} WHERE name = ${p(1)}`,
    ["recall_clock_seq"],
  );
  if (!clockRow.length) {
    await connector.execute(
      `INSERT INTO ${T("setting")} (name, value) VALUES (${p(1)}, ${p(2)})`,
      ["recall_clock_seq", "0"],
    );
  }
}
