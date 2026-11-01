// Embeddings from OpenAI's text-embedding-3-large, cut to 1024 dimensions. Private entries are embedded too, since
// OpenAI's API doesn't train on what it's sent, but they never reach an agent unredacted.
import { config } from "./config.ts";
import { type Row, secret, setting, type Sql, sql } from "./db.ts";

export async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The same text keyword search reads: the entry plus its project's title (see search_text in the migration). */
export function entryText(row: Row): string {
  return row.search_text || [row.title, row.body, row.evidence].filter(Boolean).join("\n");
}

export function contentSha(text: string) {
  return sha256(`${config.embedModel}\n${text}`);
}

/** The month's embedding spend passed its cap. Recall serves keyword ranks until the month turns. */
export class OverBudget extends Error {
  override name = "OverBudget";
}

/** $5 a month at text-embedding-3-large's $0.13 per million tokens, unless the setting says otherwise. */
const DEFAULT_BUDGET_TOKENS = 38_000_000;

export async function budget() {
  const [row] = await sql`select coalesce((select tokens from memory.embed_usage
    where month = date_trunc('month', now())::date), 0) as used`;
  const cap = Number(await setting("embed_budget_tokens")) || DEFAULT_BUDGET_TOKENS;
  return { used: row.used as number, cap };
}

export async function embed(texts: string[]): Promise<number[][]> {
  const { used, cap } = await budget();
  if (used >= cap) throw new OverBudget(`${used} of ${cap} embedding tokens spent this month`);
  const key = await secret("openai_key");
  if (!key) throw new Error("no openai_key in Vault");
  const r = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, input: texts, dimensions: config.embedDim }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  await sql`insert into memory.embed_usage (month, tokens) values (date_trunc('month', now())::date, ${body.usage.total_tokens})
    on conflict (month) do update set tokens = memory.embed_usage.tokens + excluded.tokens`;
  const vecs = body.data.sort((a: Row, b: Row) => a.index - b.index).map((d: Row) => d.embedding);
  if (vecs.length !== texts.length || vecs.some((v: number[]) => v.length !== config.embedDim)) {
    throw new Error(`${config.embedModel} returned ${vecs.length} vectors, expected ${texts.length} of ${config.embedDim}`);
  }
  return vecs;
}

export function toPgvector(vec: number[]) {
  return "[" + vec.map((x) => x.toFixed(6)).join(",") + "]";
}

/** Embed every entry whose text changed since its last embedding. Returns the count embedded. */
export async function syncEmbeddings(db: Sql = sql, batch = 64): Promise<number> {
  const rows = await db`select e.id, e.title, e.body, e.evidence, e.search_text, x.content_sha256 from memory.entry e
    left join memory.entry_embedding x on x.entry_id = e.id`;
  const stale: [Row, string, string][] = [];
  for (const r of rows) {
    const text = entryText(r), sha = await contentSha(text);
    if (r.content_sha256 !== sha) stale.push([r, text, sha]);
  }
  for (let i = 0; i < stale.length; i += batch) {
    const chunk = stale.slice(i, i + batch);
    const vecs = await embed(chunk.map(([, t]) => t.slice(0, 8000)));
    for (const [[r, , sha], v] of chunk.map((c, j) => [c, vecs[j]] as const)) {
      await db`insert into memory.entry_embedding (entry_id, model, content_sha256, embedding)
        values (${r.id}, ${config.embedModel}, ${sha}, ${toPgvector(v)}::extensions.vector)
        on conflict (entry_id) do update set model = excluded.model, content_sha256 = excluded.content_sha256,
          embedding = excluded.embedding, updated_at = now()`;
    }
  }
  return stale.length;
}
