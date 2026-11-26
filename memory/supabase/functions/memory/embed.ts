// Embeddings: Gemini's gemini-embedding-001 (1024 dims via MRL) when gemini_key is configured, falling back seamlessly to
// OpenAI's text-embedding-3-large (1024 dims) otherwise. Private and confidential entries never reach a third-party model,
// so the provider only ever sees their title.
import { config } from "./config.ts";
import { assertBudget, type Kind, meter } from "./budget.ts";
import { type Row, secret, type Sql, sql } from "./db.ts";

export const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta";
export const VECTOR_DORMANT_FLOOR = 0.15;
export const VECTOR_RUN_STALE_DAYS = 14;
export const VECTOR_MISS_STREAK_COLD = 5;

/** Whether an entry belongs in cold storage (kept permanently in memory.entry, evicted from memory.entry_embedding).
 * Superseded entries, dormant entries (<0.15), stale run:* scratch notes (>14d and strength <0.65), and repeatedly-missed
 * weak drafts stay searchable via search_archive without bloating vector scans or embedding spend. */
export function isColdForVector(row: Row, nowMs = Date.now()): boolean {
  if (row.superseded) return true;
  if (row.origin === "seed" || row.pattern === "projects" || row.authority === "approved") return false;
  const conf = Number(row.confidence ?? 0.5);
  if (conf < VECTOR_DORMANT_FLOOR) return true;
  const scope = typeof row.scope === "string" ? row.scope : "";
  if (scope.startsWith("run:") && conf < 0.65 && row.created_at) {
    const createdMs = row.created_at instanceof Date ? row.created_at.getTime() : Date.parse(String(row.created_at));
    if (Number.isFinite(createdMs) && nowMs - createdMs > VECTOR_RUN_STALE_DAYS * 86_400_000) return true;
  }
  if (row.authority === "draft" && Number(row.miss_streak ?? 0) >= VECTOR_MISS_STREAK_COLD && conf < 0.45) {
    return true;
  }
  return false;
}

export type EmbedDeps = {
  assertBudget?: (kind: Kind) => Promise<void>;
  meter?: (kind: Kind, tokens: number, model?: string) => Promise<void>;
  readSecret?: (name: string) => Promise<string>;
};

export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same text keyword search reads: the entry plus its project's title (see search_text in the migration). */
export function entryText(row: Row): string {
  if (row.sensitivity === "private" || row.sensitivity === "confidential") return row.title ?? "";
  return row.search_text || [row.title, row.body, row.evidence].filter(Boolean).join("\n");
}

async function geminiEmbedConfig(readSecret: (name: string) => Promise<string> = secret): Promise<{ url: string; key: string } | null> {
  const key = (Deno.env.get("MEMORY_GEMINI_KEY") || await readSecret("gemini_key")).trim();
  if (!key) return null;
  const url = (Deno.env.get("MEMORY_GEMINI_URL") || DEFAULT_GEMINI_URL).replace(/\/+$/, "");
  return { url, key };
}

/** The active embedding model: Gemini when gemini_key is configured, else OpenAI fallback. */
export async function activeEmbedModel(deps?: Pick<EmbedDeps, "readSecret">): Promise<string> {
  return (await geminiEmbedConfig(deps?.readSecret ?? secret)) ? GEMINI_EMBED_MODEL : config.embedModel;
}

export async function contentSha(text: string, model?: string) {
  return sha256(`${model ?? await activeEmbedModel()}\n${text}`);
}

/** Where OpenAI calls go, and with which key. Tier 3 sets MEMORY_OPENAI_URL to a local fake, which takes no real key,
 * so CI never reaches OpenAI. */
export async function openai(): Promise<{ url: string; key: string }> {
  const fake = Deno.env.get("MEMORY_OPENAI_URL");
  if (fake) return { url: fake, key: "fake" };
  const key = await secret("openai_key");
  if (!key) throw new Error("no openai_key in Vault");
  return { url: "https://api.openai.com/v1", key };
}

function normalize(vec: number[]): number[] {
  const norm = Math.hypot(...vec);
  return norm > 0 ? vec.map((x) => x / norm) : vec;
}

export async function embed(texts: string[], deps?: EmbedDeps): Promise<number[][]> {
  const checkBudget = deps?.assertBudget ?? assertBudget;
  const record = deps?.meter ?? meter;
  const readSecret = deps?.readSecret ?? secret;
  await checkBudget("embed");
  const gem = await geminiEmbedConfig(readSecret);
  if (gem) {
    const r = await fetch(`${gem.url}/models/${GEMINI_EMBED_MODEL}:batchEmbedContents`, {
      method: "POST",
      headers: { "x-goog-api-key": gem.key, "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${GEMINI_EMBED_MODEL}`,
          content: { parts: [{ text }] },
          outputDimensionality: config.embedDim,
        })),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!r.ok) throw new Error(`Gemini embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const body = await r.json();
    const tokens = Number(body.usageMetadata?.totalTokenCount ?? body.usageMetadata?.promptTokenCount ?? 0)
      || Math.max(1, Math.ceil(texts.reduce((sum, t) => sum + t.length, 0) / 4));
    await record("embed", tokens, GEMINI_EMBED_MODEL);
    const vecs: number[][] = (body.embeddings ?? []).map((e: Row) => normalize(e.values as number[]));
    if (vecs.length !== texts.length || vecs.some((v) => v.length !== config.embedDim)) {
      throw new Error(`${GEMINI_EMBED_MODEL} returned ${vecs.length} vectors, expected ${texts.length} of ${config.embedDim}`);
    }
    return vecs;
  }
  const { url, key } = await openai();
  const r = await fetch(`${url}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, input: texts, dimensions: config.embedDim }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  await record("embed", body.usage.total_tokens, config.embedModel);
  const vecs = body.data.sort((a: Row, b: Row) => a.index - b.index).map((d: Row) => d.embedding);
  if (vecs.length !== texts.length || vecs.some((v: number[]) => v.length !== config.embedDim)) {
    throw new Error(`${config.embedModel} returned ${vecs.length} vectors, expected ${texts.length} of ${config.embedDim}`);
  }
  return vecs;
}

export function toPgvector(vec: number[]) {
  return "[" + vec.map((x) => x.toFixed(6)).join(",") + "]";
}

/** Embed every hot entry whose text or model changed, and evict vectors for cold entries (superseded, dormant, stale run
 * scratch, or repeatedly-missed weak drafts). Evicted entries remain permanently in memory.entry and searchable via
 * search_archive. Returns the count embedded. */
export async function syncEmbeddings(db: Sql = sql, batch = 64): Promise<number> {
  const model = await activeEmbedModel();
  const rows = await db`select e.id, e.title, e.body, e.evidence, e.search_text, e.sensitivity,
      e.origin, e.pattern, e.confidence, e.scope, e.authority, e.miss_streak, e.created_at,
      exists (select 1 from memory.link l where l.owner_id = e.owner_id and l.dst = e.id and l.type = 'supersedes') as superseded,
      x.entry_id is not null as has_embedding, x.content_sha256, x.model
    from memory.entry e
    left join memory.entry_embedding x on x.owner_id = e.owner_id and x.entry_id = e.id`;
  const evict: string[] = [];
  const stale: [Row, string, string][] = [];
  const nowMs = Date.now();
  for (const r of rows) {
    if (isColdForVector(r, nowMs)) {
      if (r.has_embedding) evict.push(String(r.id));
      continue;
    }
    const text = entryText(r), sha = await contentSha(text, model);
    if (r.content_sha256 !== sha || r.model !== model) stale.push([r, text, sha]);
  }
  if (evict.length) {
    await db`delete from memory.entry_embedding where entry_id = any(${evict}::text[])`;
  }
  for (let i = 0; i < stale.length; i += batch) {
    const chunk = stale.slice(i, i + batch);
    const vecs = await embed(chunk.map(([, t]) => t.slice(0, 8000)));
    for (const [[r, , sha], v] of chunk.map((c, j) => [c, vecs[j]] as const)) {
      await db`insert into memory.entry_embedding (entry_id, model, content_sha256, embedding)
        values (${r.id}, ${model}, ${sha}, ${toPgvector(v)}::extensions.halfvec)
        on conflict (owner_id, entry_id) do update set model = excluded.model, content_sha256 = excluded.content_sha256,
          embedding = excluded.embedding, updated_at = now()`;
    }
  }
  return stale.length;
}
