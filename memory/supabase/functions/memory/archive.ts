// Automatic cold-storage archival, superseded collapse/blame, and cold-shard search on Supabase Storage.
// Superseded, dormant (<0.15), stale run:* (>14d, strength <0.65), and orphan miss_streak>=5 drafts are written to
// cheap Supabase Storage NDJSON shards + per-head blame files FIRST, then deleted from live Postgres tables so the
// hot database and vector table never bloat unboundedly.
import * as store from "./blobs.ts";
import { asTenant, currentOwner, root, type Row, type Sql, sql } from "./db.ts";
import { forgetGraph } from "./search.ts";

export type ArchiveReason = "superseded" | "dormant" | "stale_run" | "miss_streak_orphan";

export type ColdRecord = {
  id: string;
  title: string;
  body: string;
  evidence: string | null;
  pattern: string | null;
  kind: string | null;
  scope: string | null;
  authority: string | null;
  sensitivity: string | null;
  confidence: number;
  miss_streak: number;
  created_at: string;
  archived_at: string;
  reason: ArchiveReason;
  superseded_by?: string | null;
};

export const ARCHIVE_DORMANT_FLOOR = 0.15;
export const ARCHIVE_RUN_STALE_DAYS = 14;
export const ARCHIVE_MISS_STREAK_MIN = 5;
export const SWEEP_BATCH_LIMIT = 100;

/** Decide whether a live entry should move to cold Storage and leave Postgres. Project hubs, seed rows, and active
 * approved entries stay in Postgres. */
export function archiveReason(row: Row, nowMs = Date.now()): ArchiveReason | null {
  if (row.origin === "seed" || row.pattern === "projects") return null;
  if (row.superseded_by) return "superseded";
  if (row.authority === "approved") return null;
  const conf = Number(row.confidence ?? 0.5);
  if (conf < ARCHIVE_DORMANT_FLOOR) return "dormant";
  const scope = typeof row.scope === "string" ? row.scope : "";
  if (scope.startsWith("run:") && conf < 0.65 && row.created_at) {
    const createdMs = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
    if (Number.isFinite(createdMs) && nowMs - createdMs > ARCHIVE_RUN_STALE_DAYS * 86_400_000) return "stale_run";
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

/** Parse an NDJSON shard safely, ignoring blank or malformed lines. */
export function parseNdjson(raw: string | null): ColdRecord[] {
  if (!raw) return [];
  const out: ColdRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as ColdRecord);
    } catch {
      // Skip corrupted lines rather than failing archive search.
    }
  }
  return out;
}

/** Merge new cold records into an existing NDJSON shard, deduplicating by id (newer write wins). */
export function mergeNdjson(existing: string | null, incoming: ColdRecord[]): string {
  const byId = new Map<string, ColdRecord>();
  for (const r of parseNdjson(existing)) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].map((r) => JSON.stringify(r)).join("\n") + "\n";
}

/** Merge blame history entries for a head note, deduplicating by id, newest first. */
export function mergeBlame(existing: ColdRecord[], incoming: ColdRecord[]): ColdRecord[] {
  const byId = new Map<string, ColdRecord>();
  for (const r of existing) byId.set(r.id, r);
  for (const r of incoming) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => (b.archived_at || b.created_at).localeCompare(a.archived_at || a.created_at));
}

export type ColdSearchFilter = {
  query: string;
  include?: "all" | "cold" | "dormant" | "superseded";
  scope?: string;
  before?: string;
  after?: string;
};

/** Filter and rank cold records in memory against a text query and optional tier/scope/date filters. */
export function searchColdRecords(records: ColdRecord[], f: ColdSearchFilter): ColdRecord[] {
  const q = f.query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  const scored: { r: ColdRecord; score: number }[] = [];
  for (const r of records) {
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
    const priv = r.sensitivity === "private" || r.sensitivity === "confidential";
    const idL = r.id.toLowerCase();
    const titleL = (r.title ?? "").toLowerCase();
    const bodyL = priv ? "" : (r.body ?? "").toLowerCase();
    const evL = priv ? "" : (r.evidence ?? "").toLowerCase();
    let score = 0;
    if (idL.includes(q)) score += 3;
    if (titleL.includes(q)) score += 2;
    if (bodyL.includes(q) || evL.includes(q)) score += 1;
    if (score === 0 && words.length > 1) {
      let hits = 0;
      for (const w of words) {
        if (idL.includes(w) || titleL.includes(w) || bodyL.includes(w) || evL.includes(w)) hits++;
      }
      if (hits > 0) score = hits / words.length;
    }
    if (score > 0) scored.push({ r, score });
  }
  scored.sort((a, b) => b.score - a.score || (b.r.created_at || "").localeCompare(a.r.created_at || ""));
  return scored.map((s) => s.r);
}

export type ColdStorageIO = {
  storageOn: () => boolean;
  getColdText: (owner: string, relPath: string) => Promise<string | null>;
  putColdText: (owner: string, relPath: string, text: string, contentType?: string) => Promise<void>;
};

const defaultIO: ColdStorageIO = {
  storageOn: store.storageOn,
  getColdText: store.getColdText,
  putColdText: store.putColdText,
};

const toIso = (v: unknown) => v instanceof Date ? v.toISOString() : String(v ?? "");
const monthOf = (iso: string) => /^\d{4}-\d{2}/.test(iso) ? iso.slice(0, 7) : "unknown";

function toColdRecord(r: Row, reason: ArchiveReason, supersededBy: string | null, nowIso: string): ColdRecord {
  const priv = r.sensitivity === "private" || r.sensitivity === "confidential";
  return {
    id: String(r.id),
    title: String(r.title ?? ""),
    body: priv ? "(private)" : String(r.body ?? ""),
    evidence: priv ? null : (r.evidence ? String(r.evidence) : null),
    pattern: r.pattern ? String(r.pattern) : null,
    kind: r.kind ? String(r.kind) : null,
    scope: r.scope ? String(r.scope) : null,
    authority: r.authority ? String(r.authority) : null,
    sensitivity: r.sensitivity ? String(r.sensitivity) : null,
    confidence: Number(r.confidence ?? 0),
    miss_streak: Number(r.miss_streak ?? 0),
    created_at: toIso(r.created_at),
    archived_at: nowIso,
    reason,
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
  };
}

/** Sweep one owner's dead/superseded/stale/orphan memories into cheap Supabase Storage shards + blame files, then delete
 * those rows from Postgres. Writes to Storage FIRST so nothing is ever lost if Storage fails. */
export async function sweepOwnerColdArchive(
  owner: string,
  db: Sql = sql,
  io: ColdStorageIO = defaultIO,
  limit = SWEEP_BATCH_LIMIT,
): Promise<{ archived: number; byReason: Record<ArchiveReason, number> }> {
  const byReason: Record<ArchiveReason, number> = { superseded: 0, dormant: 0, stale_run: 0, miss_streak_orphan: 0 };
  if (!io.storageOn()) return { archived: 0, byReason };

  const rows = await db`select e.id, e.title, e.body, e.evidence, e.pattern, e.kind, e.scope,
      e.authority, e.sensitivity, e.confidence, e.miss_streak, e.origin, e.created_at,
      sup.src as superseded_by,
      (select count(*)::int from memory.link l
        where l.owner_id = e.owner_id and l.type <> 'supersedes' and (l.src = e.id or l.dst = e.id)) as active_links
    from memory.entry e
    left join lateral (
      select l.src from memory.link l
      where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes'
      order by l.src desc limit 1
    ) sup on true`;

  const supersedesMap = new Map<string, string>();
  for (const r of rows) {
    if (r.superseded_by) supersedesMap.set(String(r.id), String(r.superseded_by));
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const picked: { row: Row; reason: ArchiveReason; head: string | null }[] = [];
  for (const r of rows) {
    if (picked.length >= limit) break;
    const reason = archiveReason(r, nowMs);
    if (!reason) continue;
    const head = reason === "superseded" ? resolveSupersedesHead(String(r.id), supersedesMap) : null;
    picked.push({ row: r, reason, head });
  }
  if (!picked.length) return { archived: 0, byReason };

  // Group into monthly NDJSON shards and per-head blame files.
  const shards = new Map<string, ColdRecord[]>();
  const blames = new Map<string, ColdRecord[]>();
  for (const { row, reason, head } of picked) {
    const rec = toColdRecord(row, reason, head, nowIso);
    const m = monthOf(rec.created_at);
    shards.set(m, [...(shards.get(m) ?? []), rec]);
    if (reason === "superseded" && head && head !== rec.id) {
      blames.set(head, [...(blames.get(head) ?? []), rec]);
    }
    byReason[reason]++;
  }

  // 1. Write monthly shards and update index.json in Supabase Storage FIRST.
  const idxRaw = await io.getColdText(owner, "index.json");
  const idx = new Set<string>(idxRaw ? (JSON.parse(idxRaw).shards ?? []) : []);
  for (const [month, recs] of shards) {
    const path = `shards/${month}.ndjson`;
    const prev = await io.getColdText(owner, path);
    await io.putColdText(owner, path, mergeNdjson(prev, recs), "application/x-ndjson");
    idx.add(month);
  }
  await io.putColdText(owner, "index.json", JSON.stringify({ shards: [...idx].sort(), updated_at: nowIso }), "application/json");

  // 2. Write per-head blame files (preserving any transitive blame already recorded on an older id).
  for (const [head, recs] of blames) {
    const transitive: ColdRecord[] = [];
    for (const r of recs) {
      const oldBlame = await io.getColdText(owner, `blame/${r.id}.json`);
      if (oldBlame) {
        try {
          transitive.push(...(JSON.parse(oldBlame) as ColdRecord[]));
        } catch {
          // Ignore malformed legacy blame.
        }
      }
    }
    const prevHeadRaw = await io.getColdText(owner, `blame/${head}.json`);
    const prevHead: ColdRecord[] = prevHeadRaw ? JSON.parse(prevHeadRaw) : [];
    const merged = mergeBlame(prevHead, [...recs, ...transitive]);
    await io.putColdText(owner, `blame/${head}.json`, JSON.stringify(merged), "application/json");
  }

  // 3. Only after Storage writes succeed, delete archived rows from live Postgres.
  const ids = picked.map((p) => String(p.row.id));
  await db.begin(async (tx) => {
    await tx`delete from memory.co_use where src = any(${ids}::text[]) or dst = any(${ids}::text[])`;
    await tx`delete from memory.link where src = any(${ids}::text[]) or dst = any(${ids}::text[])`;
    await tx`update memory.entry set project = null where project = any(${ids}::text[])`;
    await tx`delete from memory.entry where id = any(${ids}::text[])`;
  });
  forgetGraph(owner);
  return { archived: ids.length, byReason };
}

/** Sweep every owner with live entries. Called hourly by POST /blobs/sweep (memory-blob-sweep pg_cron). */
export async function sweepAllColdArchives(io: ColdStorageIO = defaultIO) {
  if (!io.storageOn()) return { owners: 0, archived: 0 };
  const owners = await root`select distinct owner_id::text as owner_id from memory.entry`;
  let archived = 0;
  for (const { owner_id } of owners) {
    const res = await asTenant(owner_id, () => sweepOwnerColdArchive(owner_id, sql, io));
    archived += res.archived;
  }
  return { owners: owners.length, archived };
}

/** Search an owner's cold Supabase Storage shards, skipping months outside optional date bounds. */
export async function searchColdStorage(
  owner: string | null,
  filter: ColdSearchFilter,
  io: ColdStorageIO = defaultIO,
): Promise<ColdRecord[]> {
  if (!owner || !io.storageOn()) return [];
  const idxRaw = await io.getColdText(owner, "index.json");
  if (!idxRaw) return [];
  let shardNames: string[] = [];
  try {
    shardNames = JSON.parse(idxRaw).shards ?? [];
  } catch {
    return [];
  }
  const afterMonth = filter.after ? filter.after.slice(0, 7) : null;
  const beforeMonth = filter.before ? filter.before.slice(0, 7) : null;
  const wanted = shardNames.filter((m) => (!afterMonth || m >= afterMonth) && (!beforeMonth || m <= beforeMonth));
  const all: ColdRecord[] = [];
  for (const m of wanted) {
    const raw = await io.getColdText(owner, `shards/${m}.ndjson`);
    if (raw) all.push(...parseNdjson(raw));
  }
  return searchColdRecords(all, filter);
}

/** Show the blame / revision history of a note: live supersedes predecessors plus collapsed cold blame history in Storage. */
export async function blameEntry(
  db: Sql,
  id: string,
  owner: string | null = currentOwner(),
  io: ColdStorageIO = defaultIO,
): Promise<string> {
  const [cur] = await db`select id, title, confidence, created_at from memory.entry where id = ${id}`;
  // Live supersedes chain (not yet swept to cold storage).
  const livePrev = await db`select e.id, e.title, e.body, e.evidence, e.pattern, e.kind, e.scope,
      e.authority, e.sensitivity, e.confidence, e.miss_streak, e.created_at
    from memory.link l join memory.entry e on e.owner_id = l.owner_id and e.id = l.dst
    where l.src = ${id} and l.type = 'supersedes'
    order by e.created_at desc`;
  const liveRecords: ColdRecord[] = livePrev.map((r) => toColdRecord(r, "superseded", id, toIso(r.created_at)));

  let coldRecords: ColdRecord[] = [];
  if (owner && io.storageOn()) {
    const raw = await io.getColdText(owner, `blame/${id}.json`);
    if (raw) {
      try {
        coldRecords = JSON.parse(raw) as ColdRecord[];
      } catch {
        coldRecords = [];
      }
    }
  }
  const history = mergeBlame(coldRecords, liveRecords);
  if (!cur && !history.length) return `No entry or blame history found for ${id}.`;
  const head = cur
    ? `Blame for ${cur.id}: ${cur.title} (strength ${Number(cur.confidence ?? 0).toFixed(2)}, ${toIso(cur.created_at).slice(0, 10)})`
    : `Blame for ${id} (archived or deleted):`;
  if (!history.length) return `${head}\n\nNo prior superseded versions recorded.`;
  const lines = history.map((r, i) => {
    const snippet = r.body.replace(/\s+/g, " ").trim().slice(0, 260);
    return [
      `[${i + 1}] ${r.id}: ${r.title}`,
      `    superseded · strength ${r.confidence.toFixed(2)} · created ${r.created_at.slice(0, 10)} · archived ${r.archived_at.slice(0, 10)}`,
      `    ${snippet}`,
    ].join("\n");
  });
  return [head, "", ...lines].join("\n");
}
