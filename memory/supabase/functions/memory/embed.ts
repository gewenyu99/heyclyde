// Embeddings from OpenAI's text-embedding-3-large, cut to 1024 dimensions. Private and confidential entries never reach a
// third-party model, so OpenAI only ever sees their title.
import { config } from "./config.ts";
import { assertBudget, meter } from "./budget.ts";
import { type Row, secret, type Sql, sql } from "./db.ts";

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

export function contentSha(text: string) {
  return sha256(`${config.embedModel}\n${text}`);
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

export async function embed(texts: string[]): Promise<number[][]> {
  await assertBudget("embed");
  const { url, key } = await openai();
  const r = await fetch(`${url}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: config.embedModel, input: texts, dimensions: config.embedDim }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) throw new Error(`OpenAI embeddings ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const body = await r.json();
  await meter("embed", body.usage.total_tokens);
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
  const rows = await db`select e.id, e.title, e.body, e.evidence, e.search_text, e.sensitivity, x.content_sha256 from memory.entry e
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
        on conflict (owner_id, entry_id) do update set model = excluded.model, content_sha256 = excluded.content_sha256,
          embedding = excluded.embedding, updated_at = now()`;
    }
  }
  return stale.length;
}
