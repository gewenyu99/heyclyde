// Automatic cold-storage archival, superseded collapse/blame, cold entry open, and cold-shard search.
//
// Design invariants (audited against all 12 data-safety, security, backup, and concurrency failure modes):
// 1. Content-addressed Storage via memory.blob (media_type = COLD_ARCHIVE_MEDIA_TYPE):
//    - Zero user-controlled Storage paths (eliminates path traversal).
//    - Automatically exported by nightly GET /export?table=blob, restored by restore.py (/api/v1/import),
//      exported by user GET /me/export, metered per owner by sample_usage(), and deleted by DELETE /me & lapse.ts.
//    - Immutable write-once NDJSON batch blobs (<100 rows each): zero read-modify-write races and O(1) sweep writes.
//    - No entry_blob rows attach cold batches, so raw get_blob / GET /blobs/:sha treats them as private.
// 2. Zero data or metadata loss:
//    - Full lossless ColdRecord (all entry columns, private/confidential body & evidence, provenance, and links).
//    - Redaction (redact()) and R70 permissions (canReadEntry) are enforced strictly on every read path
//      (searchColdStorage, blameEntry, getColdEntry).
//    - Entries holding entry_blob attachments, quest references, qrel eval grades, unlearned retrievals, or <24h age
//      never leave memory.entry (their vectors are still evicted from entry_embedding by embed.ts).
// 3. Zero resurrection & zero TOCTOU loss:
//    - Non-superseded notes that actively supersede a live note are never deleted.
//    - Superseded chains bridge C -> A in memory.link before B is deleted, so A can never resurrect.
//    - Rows are re-locked with FOR UPDATE inside the delete transaction and skipped if modified or revived.
//    - Single-flight DB lease (cold_archive_lease) + backup window guard (skips 08:00 UTC & active /export).
import * as store from "./blobs.ts";
import { asTenant, root, type Row, type Sql, sql } from "./db.ts";
import { sha256 } from "./embed.ts";
import { accessDeniedReason, type AgentScope, canReadEntry, type EntryFilter } from "./permissions.ts";
import { provenanceLine, type Viewer } from "./provenance.ts";
import { clip, forgetGraph, redact, renderEntry } from "./search.ts";
import { Refused } from "./write.ts";

export const COLD_ARCHIVE_MEDIA_TYPE = "application/x-clyde-cold-archive";
export const ARCHIVE_DORMANT_FLOOR = 0.15;
export const ARCHIVE_RUN_STALE_DAYS = 14;
export const ARCHIVE_MISS_STREAK_MIN = 5;
export const ARCHIVE_MIN_AGE_HOURS = 24;
export const SWEEP_BATCH_LIMIT = 100;
export const MAX_COLD_BATCHES_SCANNED = 25;

const ENTRY_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;

export type ArchiveReason = "superseded" | "dormant" | "stale_run" | "miss_streak_orphan";

export type ColdLink = {
  dir: "to" | "from";
  type: string;
  other: string;
  weight: number;
};

export type ColdProvenance = {
  device: string | null;
  agent: string | null;
  agent_context: string | null;
  repo: string | null;
  cwd?: string | null;
  session?: string | null;
  run_scope?: string | null;
};

export type ColdRecord = {
  id: string;
  title: string;
  body: string;
  evidence: string | null;
  evidence_kind: string | null;
  evidence_sha256: string | null;
  pattern: string | null;
  kind: string | null;
  scope: string | null;
  authority: string | null;
  sensitivity: string | null;
  lang: string | null;
  valid_from: string | null;
  source_id: string | null;
  project: string | null;
  project_slug: string | null;
  category: string;
  context: string;
  transferability: string;
  computer: string | null;
  confidence: number;
  miss_streak: number;
  payload_sha256: string | null;
  created_at: string;
  archived_at: string;
  reason: ArchiveReason;
  superseded_by?: string | null;
  provenance?: ColdProvenance | null;
  links?: ColdLink[];
};

const toIso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v ?? "");
const toDay = (v: unknown) => v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null;

/** Pure classification rule for whether a row qualifies to move from live Postgres to cold Storage.
 * Callers must also enforce SQL guards (no entry_blob, no qrel, no quest ref, no unlearned retrieval). */
export function archiveReason(row: Row, nowMs = Date.now()): ArchiveReason | null {
  if (row.origin === "seed" || row.pattern === "projects") return null;
  if (row.has_blobs || row.in_qrel || row.in_quest || row.in_unlearned) return null;
  const createdMs = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at ?? ""));
  if (!Number.isFinite(createdMs) || nowMs - createdMs < ARCHIVE_MIN_AGE_HOURS * 3_600_000) return null;

  if (row.superseded_by) return "superseded";
  // Never delete a non-superseded note that actively supersedes another note, or the older note would resurrect.
  if (row.supersedes_other) return null;
  if (row.authority === "approved") return null;

  const conf = Number(row.confidence ?? 0.5);
  if (conf < ARCHIVE_DORMANT_FLOOR) return "dormant";
  const scope = typeof row.scope === "string" ? row.scope : "";
  if (scope.startsWith("run:") && conf < 0.65 && nowMs - createdMs > ARCHIVE_RUN_STALE_DAYS * 86_400_000) {
    return "stale_run";
  }
  if (
    row.authority === "draft" &&
    Number(row.miss_streak ?? 0) >= ARCHIVE_MISS_STREAK_MIN &&
    Number(row.active_links ?? 0) === 0
  ) {
    return "miss_streak_orphan";
  }
  return null;
}

/** Follow a supersedes map (old -> newer) to the newest head, guarding against cycles. */
export function resolveSupersedesHead(id: string, supersedesMap: ReadonlyMap<string, string>): string {
  let cur = id;
  const seen = new Set<string>([cur]);
  while (supersedesMap.has(cur)) {
    const next = supersedesMap.get(cur)!;
    if (seen.has(next)) break;
    seen.add(next);
    cur = next;
  }
  return cur;
}

/** Parse an NDJSON batch safely, ignoring blank or malformed lines. */
export function parseNdjson(raw: string | null): ColdRecord[] {
  if (!raw) return [];
  const out: ColdRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ColdRecord);
    } catch {
      // Skip malformed line rather than failing cold reads.
    }
  }
  return out;
}

/** Serialize records as NDJSON, deduplicating by id (newest archived_at wins). */
export function mergeNdjson(existing: string | null, incoming: ColdRecord[]): string {
  const byId = new Map<string, ColdRecord>();
  for (const r of parseNdjson(existing)) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Merge blame history entries, deduplicating by id, newest first. */
export function mergeBlame(existing: ColdRecord[], incoming: ColdRecord[]): ColdRecord[] {
  const byId = new Map<string, ColdRecord>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (b.created_at || b.archived_at).localeCompare(a.created_at || a.archived_at));
}

export type ColdSearchFilter = {
  query: string;
  include?: "all" | "cold" | "dormant" | "superseded";
  scope?: string;
  before?: string;
  after?: string;
};

export type ScoredColdRecord = { record: ColdRecord; score: number };

/** Filter and score cold records in memory, enforcing R70 agent permissions, EntryFilter, and private body non-matching. */
export function searchColdRecords(
  records: ColdRecord[],
  f: ColdSearchFilter,
  agentScope: AgentScope = null,
  entryFilter?: EntryFilter,
): ScoredColdRecord[] {
  const q = f.query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  const byId = new Map<string, ScoredColdRecord>();
  for (const r of records) {
    if (byId.has(r.id)) continue;
    if (!canReadEntry(agentScope, r as unknown as Row, entryFilter)) continue;
    if (f.include === "dormant" && r.reason !== "dormant" && r.confidence >= ARCHIVE_DORMANT_FLOOR) continue;
    if (f.include === "superseded" && r.reason !== "superseded" && !r.superseded_by) continue;
    if (f.scope) {
      const sc = r.scope ?? "";
      if (f.scope === "run:*") {
        if (!sc.startsWith("run:")) continue;
      } else if (sc !== f.scope) continue;
    }
    const day = (r.created_at || "").slice(0, 10);
    if (f.after && day && day < f.after) continue;
    if (f.before && day && day > f.before) continue;
    // Private entries never match on body/evidence, matching Postgres searchArchive's sensitivity='normal' rule.
    // Confidential work entries match for permitted work agents (never sent to external LLMs here).
    const hideBodyFromSearch = r.sensitivity === "private";
    const idL = r.id.toLowerCase();
    const titleL = (r.title ?? "").toLowerCase();
    const bodyL = hideBodyFromSearch ? "" : (r.body ?? "").toLowerCase();
    const evL = hideBodyFromSearch ? "" : (r.evidence ?? "").toLowerCase();
    let score = 0;
    if (idL.includes(q)) score += 2.0;
    if (titleL.includes(q)) score += 1.0;
    if (bodyL.includes(q) || evL.includes(q)) score += 0.5;
    if (score === 0 && words.length > 1) {
      let hits = 0;
      for (const w of words) {
        if (idL.includes(w) || titleL.includes(w) || bodyL.includes(w) || evL.includes(w)) hits++;
      }
      if (hits > 0) score = (hits / words.length) * 0.4;
    }
    if (score > 0) byId.set(r.id, { record: r, score });
  }
  const scored = [...byId.values()];
  scored.sort((a, b) => b.score - a.score || (b.record.created_at || "").localeCompare(a.record.created_at || ""));
  return scored;
}

export type ColdBlobBackend = {
  storageOn: () => boolean;
  putBlob: (sha: string, mediaType: string, bytes: Uint8Array, owner: string | null) => Promise<void>;
  getBlob: (sha: string, owner: string | null) => Promise<Uint8Array | null>;
};

const defaultBackend: ColdBlobBackend = {
  storageOn: store.storageOn,
  putBlob: store.put,
  getBlob: store.get,
};

function toLosslessColdRecord(
  r: Row,
  reason: ArchiveReason,
  supersededBy: string | null,
  prov: ColdProvenance | null,
  links: ColdLink[],
  nowIso: string,
): ColdRecord {
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    body: String(r.body ?? ""),
    evidence: r.evidence !== null && r.evidence !== undefined ? String(r.evidence) : null,
    evidence_kind: r.evidence_kind ? String(r.evidence_kind) : null,
    evidence_sha256: r.evidence_sha256 ? String(r.evidence_sha256) : null,
    pattern: r.pattern ? String(r.pattern) : null,
    kind: r.kind ? String(r.kind) : null,
    scope: r.scope ? String(r.scope) : null,
    authority: r.authority ? String(r.authority) : null,
    sensitivity: r.sensitivity ? String(r.sensitivity) : null,
    lang: r.lang ? String(r.lang) : null,
    valid_from: toDay(r.valid_from),
    source_id: r.source_id ? String(r.source_id) : null,
    project: r.project ? String(r.project) : null,
    project_slug: r.project_slug ? String(r.project_slug) : null,
    category: r.category ? String(r.category) : "general",
    context: r.context ? String(r.context) : "general",
    transferability: r.transferability ? String(r.transferability) : "general",
    computer: r.computer ? String(r.computer) : null,
    confidence: Number(r.confidence ?? 0),
    miss_streak: Number(r.miss_streak ?? 0),
    payload_sha256: r.payload_sha256 ? String(r.payload_sha256) : null,
    created_at: toIso(r.created_at),
    archived_at: nowIso,
    reason,
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    provenance: prov,
    links,
  };
}

/** Read up to `maxBatches` newest cold-archive blobs for the active DB tenant. */
export async function loadRecentColdRecords(
  db: Sql,
  backend: ColdBlobBackend = defaultBackend,
  maxBatches = MAX_COLD_BATCHES_SCANNED,
): Promise<ColdRecord[]> {
  const blobs = await db`select owner_id::text as owner_id, sha256, stored, content
    from memory.blob
    where owner_id = memory.owner_default() and media_type = ${COLD_ARCHIVE_MEDIA_TYPE}
    order by created_at desc, sha256 asc
    limit ${maxBatches}`;
  const dec = new TextDecoder();
  const out: ColdRecord[] = [];
  for (const b of blobs) {
    let bytes: Uint8Array | null = b.content instanceof Uint8Array ? b.content : null;
    if (!bytes && b.stored === "storage" && backend.storageOn()) {
      bytes = await backend.getBlob(String(b.sha256), String(b.owner_id));
    }
    if (!bytes) continue;
    out.push(...parseNdjson(dec.decode(bytes)));
  }
  return out;
}

/** Sweep one owner's qualified cold entries into an immutable content-addressed memory.blob (in Supabase Storage when on,
 * or inline bytea in local CI), verify the write, re-lock live rows with FOR UPDATE, bridge supersedes chains so older
 * notes never resurrect, and delete only unchanged rows. */
export type TenantRunner = <T>(fn: (db: Sql) => Promise<T>) => Promise<T>;

export async function sweepOwnerColdArchive(
  owner: string,
  db: Sql = sql,
  backend: ColdBlobBackend = defaultBackend,
  limit = SWEEP_BATCH_LIMIT,
  protectedIds: string[] = [],
  runPhase: TenantRunner = (fn) => fn(db),
): Promise<{ archived: number; byReason: Record<ArchiveReason, number> }> {
  const byReason: Record<ArchiveReason, number> = { superseded: 0, dormant: 0, stale_run: 0, miss_streak_orphan: 0 };
  const nowMs = Date.now();

  // Phase 1: Snapshot candidates inside a fast read transaction, then release the DB connection before Storage I/O.
  const snap = await runPhase(async (rdb) => {
    const candidates = await rdb`select e.*,
        false as has_blobs, false as in_qrel, false as in_quest, false as in_unlearned,
        sup.src as superseded_by,
        exists (select 1 from memory.link ls where ls.owner_id = e.owner_id and ls.src = e.id and ls.type = 'supersedes') as supersedes_other,
        (select count(*)::int from memory.link l
          where l.owner_id = e.owner_id and l.type not in ('supersedes', 'part_of') and (l.src = e.id or l.dst = e.id)) as active_links
      from memory.entry e
      left join lateral (
        select l.src from memory.link l
        join memory.entry se on se.owner_id = l.owner_id and se.id = l.src
        where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'
        order by se.created_at desc, l.src desc limit 1
      ) sup on true
      where e.origin <> 'seed'
        and coalesce(e.pattern, '') <> 'projects'
        and e.created_at <= now() - (${ARCHIVE_MIN_AGE_HOURS}::int * interval '1 hour')
        and not (e.id = any(${protectedIds}::text[]))
        and not exists (select 1 from memory.entry_blob xb where xb.owner_id = e.owner_id and xb.entry_id = e.id)
        and not exists (select 1 from memory.quest q where q.owner_id = e.owner_id and (q.result_entry = e.id or q.history_entry = e.id))
        and not exists (
          select 1 from memory.retrieval r
          where r.owner_id = e.owner_id and r.learned_at is null
            and (r.delivered ? e.id or r.candidates ? e.id or r.on_trial ? e.id)
        )
        and (
          sup.src is not null
          or (
            coalesce(e.authority, 'draft') <> 'approved'
            and not exists (select 1 from memory.link ls where ls.owner_id = e.owner_id and ls.src = e.id and ls.type = 'supersedes')
            and (
              e.confidence < ${ARCHIVE_DORMANT_FLOOR}
              or (e.scope like 'run:%' and e.confidence < 0.65 and e.created_at <= now() - (${ARCHIVE_RUN_STALE_DAYS}::int * interval '1 day'))
              or (coalesce(e.authority, 'draft') = 'draft' and e.miss_streak >= ${ARCHIVE_MISS_STREAK_MIN})
            )
          )
        )
      order by e.created_at asc, e.id asc
      limit ${limit}`;

    const qualified: { row: Row; reason: ArchiveReason }[] = [];
    for (const r of candidates) {
      const reason = archiveReason(r, nowMs);
      if (reason) qualified.push({ row: r, reason });
    }
    if (!qualified.length) return null;

    const pickedIds = qualified.map((q) => String(q.row.id));
    const allSup = await rdb`select l.dst as old_id, l.src as new_id
      from memory.link l join memory.entry se on se.owner_id = l.owner_id and se.id = l.src
      where l.type = 'supersedes'
      order by se.created_at asc, l.src asc`;
    const supMap = new Map<string, string>();
    for (const r of allSup) supMap.set(String(r.old_id), String(r.new_id));

    const provRows = await rdb`select entry_id, device, agent, agent_context, repo, cwd, session, run_scope
      from memory.entry_provenance where entry_id = any(${pickedIds}::text[])`;
    const provById = new Map<string, ColdProvenance>(
      provRows.map((p) => [String(p.entry_id), {
        device: p.device ? String(p.device) : null,
        agent: p.agent ? String(p.agent) : null,
        agent_context: p.agent_context ? String(p.agent_context) : null,
        repo: p.repo ? String(p.repo) : null,
        cwd: p.cwd ? String(p.cwd) : null,
        session: p.session ? String(p.session) : null,
        run_scope: p.run_scope ? String(p.run_scope) : null,
      }]),
    );

    const linkRows = await rdb`select src, dst, type, weight from memory.link
      where src = any(${pickedIds}::text[]) or dst = any(${pickedIds}::text[])`;
    const linksById = new Map<string, ColdLink[]>();
    for (const l of linkRows) {
      const src = String(l.src), dst = String(l.dst), type = String(l.type), weight = Number(l.weight ?? 1);
      if (pickedIds.includes(src)) linksById.set(src, [...(linksById.get(src) ?? []), { dir: "to", type, other: dst, weight }]);
      if (pickedIds.includes(dst)) linksById.set(dst, [...(linksById.get(dst) ?? []), { dir: "from", type, other: src, weight }]);
    }

    const nowIso = new Date(nowMs).toISOString();
    const records: ColdRecord[] = qualified.map(({ row, reason }) => {
      const id = String(row.id);
      const head = reason === "superseded" ? resolveSupersedesHead(id, supMap) : null;
      return toLosslessColdRecord(
        row,
        reason,
        head && head !== id ? head : (row.superseded_by ? String(row.superseded_by) : null),
        provById.get(id) ?? null,
        linksById.get(id) ?? [],
        nowIso,
      );
    });
    return { qualified, pickedIds, records };
  });

  if (!snap) return { archived: 0, byReason };
  const { qualified, pickedIds, records } = snap;

  const ndjson = mergeNdjson(null, records);
  const bytes = new TextEncoder().encode(ndjson);
  const digest = await sha256(bytes);

  // Phase 2: Write immutable batch bytes to Supabase Storage OUTSIDE any DB transaction and verify read-back.
  const useStorage = backend.storageOn();
  if (useStorage) {
    await backend.putBlob(digest, COLD_ARCHIVE_MEDIA_TYPE, bytes, owner);
    const verify = await backend.getBlob(digest, owner);
    if (!verify || verify.byteLength !== bytes.byteLength) {
      throw new Error(`Cold archive verification failed for batch ${digest}. Aborting delete.`);
    }
  }

  // Phase 3: Re-open fast write transaction, record memory.blob, lock rows FOR UPDATE to prevent TOCTOU clobbering,
  // bridge supersedes links so ancestors never resurrect, and delete only unchanged rows.
  const snapById = new Map(qualified.map((q) => [String(q.row.id), q]));
  const deletedIds = await runPhase((wdb) =>
    wdb.begin(async (tx) => {
      const [hasEntries] = await tx`select 1 from memory.entry limit 1`;
      if (!hasEntries) return [] as string[];

      await tx`insert into memory.blob (sha256, media_type, size, content, stored)
        values (${digest}, ${COLD_ARCHIVE_MEDIA_TYPE}, ${bytes.byteLength}, ${useStorage ? null : bytes}, ${useStorage ? "storage" : "db"})
        on conflict (owner_id, sha256) do nothing`;

      const locked = await tx`select e.id, e.origin, e.pattern, e.authority, e.confidence, e.miss_streak, e.scope,
          e.created_at, e.payload_sha256, e.title, e.body,
          exists (select 1 from memory.entry_blob xb where xb.owner_id = e.owner_id and xb.entry_id = e.id) as has_blobs,
          exists (select 1 from memory.quest q where q.owner_id = e.owner_id and (q.result_entry = e.id or q.history_entry = e.id)) as in_quest,
          (e.id = any(${protectedIds}::text[])) as in_qrel,
          exists (
            select 1 from memory.retrieval r
            where r.owner_id = e.owner_id and r.learned_at is null
              and (r.delivered ? e.id or r.candidates ? e.id or r.on_trial ? e.id)
          ) as in_unlearned,
          (
            select l.src from memory.link l
            where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'
            limit 1
          ) as superseded_by,
          exists (select 1 from memory.link ls where ls.owner_id = e.owner_id and ls.src = e.id and ls.type = 'supersedes') as supersedes_other,
          (select count(*)::int from memory.link l
            where l.owner_id = e.owner_id and l.type not in ('supersedes', 'part_of') and (l.src = e.id or l.dst = e.id)) as active_links
        from memory.entry e
        where e.id = any(${pickedIds}::text[])
        for update of e`;

      const safeIds: string[] = [];
      for (const live of locked) {
        const id = String(live.id);
        const s = snapById.get(id);
        if (!s) continue;
        if (String(live.title ?? "") !== String(s.row.title ?? "")) continue;
        if (String(live.body ?? "") !== String(s.row.body ?? "")) continue;
        if ((live.payload_sha256 ?? null) !== (s.row.payload_sha256 ?? null)) continue;
        const stillReason = archiveReason(live, nowMs);
        if (!stillReason) continue;
        safeIds.push(id);
        byReason[stillReason]++;
      }
      if (!safeIds.length) return [] as string[];

      // Bridge C -> A before deleting B so no superseded predecessor A ever resurrects as active!
      await tx`insert into memory.link (src, dst, type, weight)
        select distinct up.src, down.dst, 'supersedes', 1.0
        from memory.link down
        join memory.link up on up.owner_id = down.owner_id and up.dst = down.src and up.type = 'supersedes'
        where down.src = any(${safeIds}::text[])
          and down.type = 'supersedes'
          and up.src <> down.dst
          and not (up.src = any(${safeIds}::text[]))
        on conflict (owner_id, src, dst, type) do nothing`;

      await tx`delete from memory.co_use where src = any(${safeIds}::text[]) or dst = any(${safeIds}::text[])`;
      await tx`delete from memory.link where src = any(${safeIds}::text[]) or dst = any(${safeIds}::text[])`;
      await tx`update memory.entry set project = null where project = any(${safeIds}::text[]) and not (id = any(${safeIds}::text[]))`;
      await tx`delete from memory.entry where id = any(${safeIds}::text[])`;
      return safeIds;
    })
  );

  if (deletedIds.length) forgetGraph(owner);
  return { archived: deletedIds.length, byReason };
}

/** Single-flight sweep across owners, skipping the 08:00 UTC backup hour and any active /export lease. */
export async function sweepAllColdArchives(
  backend: ColdBlobBackend = defaultBackend,
  opts: { ignoreBackupWindow?: boolean } = {},
) {
  if (!opts.ignoreBackupWindow) {
    if (new Date().getUTCHours() === 8) return { owners: 0, archived: 0, skipped: "backup_hour" };
    const [expLease] = await root`select value from memory.setting where name = 'export_active_until'`;
    if (expLease?.value && Date.parse(String(expLease.value)) > Date.now()) {
      return { owners: 0, archived: 0, skipped: "export_active" };
    }
  }
  const lease = await root`insert into memory.setting (name, value)
    values ('cold_archive_lease', (now() + interval '5 minutes')::text)
    on conflict (name) do update set value = excluded.value
      where memory.setting.value::timestamptz < now()
    returning name`;
  if (!lease.length) return { owners: 0, archived: 0, skipped: "leased" };

  try {
    // qrel is a global eval table readable only by postgres (root), never memory_tenant.
    const qrelIds = (await root`select distinct entry_id::text as id from memory.qrel`).map((r) => String(r.id));
    const owners = await root`select distinct owner_id::text as owner_id from memory.entry`;
    let archived = 0;
    for (const { owner_id } of owners) {
      const res = await sweepOwnerColdArchive(
        owner_id,
        sql,
        backend,
        SWEEP_BATCH_LIMIT,
        qrelIds,
        (fn) => asTenant(owner_id, () => fn(sql)),
      );
      archived += res.archived;
    }
    return { owners: owners.length, archived };
  } finally {
    await root`update memory.setting set value = now()::text where name = 'cold_archive_lease'`.catch(() => {});
  }
}

/** Search cold-archived records for the current DB tenant, enforcing R70 agent permissions and EntryFilter. */
export async function searchColdStorage(
  db: Sql,
  filter: ColdSearchFilter,
  agentScope: AgentScope = null,
  entryFilter?: EntryFilter,
  backend: ColdBlobBackend = defaultBackend,
): Promise<ScoredColdRecord[]> {
  const records = await loadRecentColdRecords(db, backend);
  return searchColdRecords(records, filter, agentScope, entryFilter);
}

/** Open a single cold-archived note by id when get_entry misses live memory.entry, enforcing R70 permissions & redaction. */
export async function getColdEntry(
  db: Sql,
  id: string,
  viewer: Viewer = null,
  agentScope: AgentScope = null,
  backend: ColdBlobBackend = defaultBackend,
): Promise<string | null> {
  if (!ENTRY_ID_RE.test(id)) return null;
  const records = await loadRecentColdRecords(db, backend);
  const found = records.find((r) => r.id === id);
  if (!found) return null;
  const asRow: Row = { ...found };
  if (!canReadEntry(agentScope, asRow)) throw new Refused(accessDeniedReason(agentScope, asRow));
  if (found.provenance && found.provenance.agent) {
    asRow.provenance = provenanceLine({
      device: found.provenance.device ?? "unknown",
      agent: found.provenance.agent,
      agent_context: found.provenance.agent_context,
      repo: found.provenance.repo,
    }, viewer);
  }
  const links = (found.links ?? []).map((l) => ({
    dir: l.dir,
    type: l.type,
    other: l.other,
    title: "(archived link)",
  }));
  const rendered = renderEntry(asRow, links, []);
  return `[cold storage · archived (${found.reason}) on ${found.archived_at.slice(0, 10)}${found.superseded_by ? ` · superseded by ${found.superseded_by}` : ""}]\n${rendered}`;
}

/** Show the blame / revision history of a note across both live Postgres and cold Storage, enforcing R70 & redaction. */
export async function blameEntry(
  db: Sql,
  id: string,
  agentScope: AgentScope = null,
  backend: ColdBlobBackend = defaultBackend,
): Promise<string> {
  if (!ENTRY_ID_RE.test(id)) throw new Refused("That isn't a valid entry id.");
  const [cur] = await db`select id, title, confidence, created_at, sensitivity, category, context,
      transferability, project_slug, computer, pattern, scope
    from memory.entry where id = ${id}`;
  if (cur && !canReadEntry(agentScope, cur)) throw new Refused(accessDeniedReason(agentScope, cur));

  // Walk live supersedes chain (up to 20 hops).
  const liveRecords: ColdRecord[] = [];
  let frontier = [id];
  const visited = new Set<string>([id]);
  for (let depth = 0; depth < 20 && frontier.length; depth++) {
    const prev = await db`select e.*, l.src as sup_by
      from memory.link l join memory.entry e on e.owner_id = l.owner_id and e.id = l.dst
      where l.src = any(${frontier}::text[]) and l.type = 'supersedes'
      order by e.created_at desc, e.id desc`;
    frontier = [];
    for (const r of prev) {
      const pid = String(r.id);
      if (visited.has(pid)) continue;
      visited.add(pid);
      frontier.push(pid);
      if (canReadEntry(agentScope, r)) {
        liveRecords.push(toLosslessColdRecord(r, "superseded", String(r.sup_by), null, [], toIso(r.created_at)));
      }
    }
  }

  // Also walk cold records whose superseded_by points to `id` or any transitive predecessor.
  const allCold = await loadRecentColdRecords(db, backend);
  const coldHeadNote = !cur ? allCold.find((r) => r.id === id) : null;
  if (coldHeadNote && !canReadEntry(agentScope, coldHeadNote as unknown as Row)) {
    throw new Refused(accessDeniedReason(agentScope, coldHeadNote as unknown as Row));
  }
  const chainIds = new Set<string>(visited);
  let added = true;
  const coldMatches: ColdRecord[] = [];
  while (added) {
    added = false;
    for (const r of allCold) {
      if (chainIds.has(r.id)) continue;
      const targetsHead = r.superseded_by && chainIds.has(r.superseded_by);
      const linkedToHead = (r.links ?? []).some((l) => l.dir === "from" && l.type === "supersedes" && chainIds.has(l.other));
      if (targetsHead || linkedToHead) {
        chainIds.add(r.id);
        added = true;
        if (canReadEntry(agentScope, r as unknown as Row)) coldMatches.push(r);
      }
    }
  }

  const history = mergeBlame(coldMatches, liveRecords);
  if (!cur && !coldHeadNote && !history.length) return `No entry or blame history found for ${id}.`;

  const headRow = cur ? redact(cur) : coldHeadNote ? redact(coldHeadNote as unknown as Row) : null;
  const head = headRow
    ? `Blame for ${headRow.id}: ${headRow.title} (strength ${Number(headRow.confidence ?? 0).toFixed(2)}, ${toIso(headRow.created_at).slice(0, 10)}${!cur ? ", in cold storage" : ""})`
    : `Blame for ${id}:`;
  if (!history.length) return `${head}\n\nNo prior superseded versions recorded.`;

  const lines = history.map((raw, i) => {
    const r = redact(raw as unknown as Row);
    const snippet = r.sensitivity === "private"
      ? "(private)"
      : clip(String(r.body ?? "").replace(/\s+/g, " ").trim(), 260);
    return [
      `[${i + 1}] ${r.id}: ${r.title}`,
      `    superseded · strength ${Number(r.confidence ?? 0).toFixed(2)} · created ${String(raw.created_at).slice(0, 10)}`,
      `    ${snippet}`,
    ].join("\n");
  });
  return [head, "", ...lines].join("\n");
}
