// Portable in-process BM25 and CJK bigram rankers for non-FTS5 SQL connectors (Postgres, MySQL, LibSQL, custom).
import { bigrams, tokens } from "../core/ranking.ts";

export type SearchableDoc = {
  id: string;
  searchText: string;
};

/** BM25 scoring over English/ASCII tokens (OR semantics matching FTS5 OR queries). */
export function bm25English(query: string, docs: SearchableDoc[], limit: number): Array<{ id: string; score: number }> {
  const qTerms = [...tokens(query)].filter((t) => /^[a-z0-9]/.test(t));
  if (!qTerms.length || !docs.length) return [];

  const tokenized = docs.map((d) => {
    const words = d.searchText.toLowerCase().match(/[a-z0-9][a-z0-9.+-]*/g) ?? [];
    const tf = new Map<string, number>();
    for (const w of words) {
      const clean = w.replace(/^[.+-]+|[.+-]+$/g, "");
      if (clean) tf.set(clean, (tf.get(clean) ?? 0) + 1);
    }
    return { id: d.id, len: words.length || 1, tf };
  });

  const N = tokenized.length;
  const avgLen = tokenized.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const term of qTerms) {
    let count = 0;
    for (const d of tokenized) if (d.tf.has(term)) count++;
    df.set(term, count);
  }

  const k1 = 1.2;
  const b = 0.75;
  const hits: Array<{ id: string; score: number }> = [];
  for (const d of tokenized) {
    let score = 0;
    for (const term of qTerms) {
      const freq = d.tf.get(term) ?? 0;
      if (!freq) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      const num = freq * (k1 + 1);
      const den = freq + k1 * (1 - b + (b * d.len) / avgLen);
      score += idf * (num / den);
    }
    if (score > 0) hits.push({ id: d.id, score });
  }
  hits.sort((a, b2) => b2.score - a.score || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
  return hits.slice(0, limit);
}

/** Portable CJK bigram BM25 ranker using the same bigrams() tokenizer as FTS5 indexing. */
export function bm25Chinese(query: string, docs: SearchableDoc[], limit: number): Array<{ id: string; score: number }> {
  const qTerms = [...new Set(bigrams(query))];
  if (!qTerms.length || !docs.length) return [];

  const tokenized = docs.map((d) => {
    const bg = bigrams(d.searchText);
    const tf = new Map<string, number>();
    for (const g of bg) tf.set(g, (tf.get(g) ?? 0) + 1);
    return { id: d.id, len: bg.length || 1, tf };
  });

  const N = tokenized.length;
  const avgLen = tokenized.reduce((s, d) => s + d.len, 0) / N || 1;
  const df = new Map<string, number>();
  for (const term of qTerms) {
    let count = 0;
    for (const d of tokenized) if (d.tf.has(term)) count++;
    df.set(term, count);
  }

  const k1 = 1.2;
  const b = 0.75;
  const hits: Array<{ id: string; score: number }> = [];
  for (const d of tokenized) {
    let score = 0;
    for (const term of qTerms) {
      const freq = d.tf.get(term) ?? 0;
      if (!freq) continue;
      const n = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5));
      score += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + (b * d.len) / avgLen)));
    }
    if (score > 0) hits.push({ id: d.id, score });
  }
  hits.sort((a, b2) => b2.score - a.score || (a.id < b2.id ? -1 : a.id > b2.id ? 1 : 0));
  return hits.slice(0, limit);
}
