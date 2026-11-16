// Shadow variants (R34). Up to MAX_SHADOWS parameter sets with role 'shadow' rank every real recall after its response is out,
// inside EdgeRuntime.waitUntil, as of the recall's own clock reading. Each logs one memory.shadow_retrieval row: its top
// SHADOW_RANKING ids and scores and what it would have delivered, or why it didn't rank. A shadow never ticks the clock,
// never writes a retrieval and never changes what was served, so the learner never hears of it.
//
// A shadow pays the judge only for pairs nobody has judged. memory.judge_cache keys an answer by the request's hash, the entry,
// the hash of the text the judge read and the judge's version. The served recall's own answers go in first, so a shadow that
// ranks what the served set ranked costs nothing. What it does spend is metered as kind 'shadow', inside the general budget
// and the research budget (setting research_budget_tokens).
import { assertBudget, OverBudget } from "./budget.ts";
import { sql } from "./db.ts";
import { sha256 } from "./embed.ts";
import { activeJudgeVersion, relevanceWithVersion } from "./judge.ts";
import { paramSet } from "./params.ts";
import type { Viewer } from "./provenance.ts";
import type { AgentScope, EntryFilter } from "./permissions.ts";
import { type Judge, rankAndPack } from "./service.ts";

export const MAX_SHADOWS = 2;
export const SHADOW_RANKING = 12;

declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void } | undefined;

/** Run work after the response, on the Supabase runtime's waitUntil. A failure is logged, never thrown at the caller. */
export function background(work: Promise<unknown>) {
  const run = work.catch((e) => console.error("background:", e));
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime) EdgeRuntime.waitUntil(run);
}

export type Judgment = { id: string; text: string; p: number };

/** What a shadow needs of the recall it shadows. `judgments` are the served judge's answers, for the cache, under `judgeVersion`. */
export type Served = {
  retrieval: string; query: string; task: string; scope: string | null; cNow: number | null; set: string;
  judgments: Judgment[]; judgeVersion?: string; viewer: Viewer; agentScope?: AgentScope; entryFilter?: EntryFilter;
};

/** The shadow sets, at most MAX_SHADOWS, in id order. */
export async function shadowSets(): Promise<string[]> {
  const rows = await sql`select param_set from memory.allocation where role = 'shadow' order by param_set limit ${MAX_SHADOWS}`;
  return rows.map((r) => r.param_set as string);
}

async function cache(querySha: string, items: Judgment[], judgeVersion: string) {
  if (!items.length) return;
  const shas = await Promise.all(items.map((i) => sha256(i.text)));
  await sql`insert into memory.judge_cache (query_sha, entry_id, content_sha, judge_version, p)
    select ${querySha}::text, t.e, t.c, ${judgeVersion}::text, t.p
    from unnest(${items.map((i) => i.id)}::text[], ${shas}::text[], ${items.map((i) => i.p)}::float8[]) as t(e, c, p)
    on conflict do nothing`;
}

/** A judge that answers from the cache and asks the shadow judge only about the rest, in one call. `calls` counts the calls. */
function cachedJudge(querySha: string, stats: { calls: number }): Judge {
  return async (request, items) => {
    const shas = await Promise.all(items.map((i) => sha256(i.text)));
    const key = (id: string, sha: string) => `${id}\0${sha}`;
    const judgeVersion = await activeJudgeVersion();
    const hits = items.length ? await sql`select entry_id, content_sha, p from memory.judge_cache
      where query_sha = ${querySha} and judge_version = ${judgeVersion} and entry_id = any(${items.map((i) => i.id)}::text[])` : [];
    const known = new Map(hits.map((h) => [key(h.entry_id, h.content_sha), h.p as number]));
    const missing = items.map((it, i) => ({ ...it, sha: shas[i] })).filter((it) => !known.has(key(it.id, it.sha)));
    if (missing.length) {
      stats.calls++;
      const { scores, judgeVersion: actualVersion } = await relevanceWithVersion(request, missing.map((m) => m.text), "shadow");
      missing.forEach((m, i) => known.set(key(m.id, m.sha), scores[i]));
      await cache(querySha, missing.map((m, i) => ({ id: m.id, text: m.text, p: scores[i] })), actualVersion);
    }
    return items.map((it, i) => known.get(key(it.id, shas[i]))!);
  };
}

/** Rank one recall under every shadow set and log a row for each. Never throws for a shadow's own failure. */
export async function runShadows(s: Served) {
  const ids = (await shadowSets()).filter((id) => id !== s.set);
  if (!ids.length) return;
  const request = s.task ? `${s.task}\n${s.query}`.trim() : s.query;
  const querySha = await sha256(request);
  await cache(querySha, s.judgments, s.judgeVersion ?? await activeJudgeVersion());
  let spent = false;
  try {
    await assertBudget("shadow");
  } catch (e) {
    if (!(e instanceof OverBudget)) throw e;
    spent = true;
  }
  for (const id of ids) {
    const started = performance.now(), stats = { calls: 0 };
    let status = spent ? "skipped:budget" : "ranked", ranking: { id: string; score: number }[] = [], delivered: string[] = [];
    if (!spent) {
      try {
        const set = await paramSet(sql, id);
        const r = await rankAndPack(sql, set, s.query, s.task, s.scope, true, false, s.viewer, {
          asOf: s.cNow, judge: cachedJudge(querySha, stats), agentScope: s.agentScope, entryFilter: s.entryFilter,
        });
        if (r.degraded) status = r.degraded.includes(OverBudget.name) ? "skipped:budget" : "skipped:error";
        else {
          ranking = r.ranked.slice(0, SHADOW_RANKING).map(([id, score]) => ({ id, score }));
          delivered = r.delivered;
        }
      } catch (e) {
        console.warn("shadow", id, "failed for", s.retrieval, e);
        status = e instanceof OverBudget ? "skipped:budget" : "skipped:error";
      }
    }
    await sql`insert into memory.shadow_retrieval (retrieval_id, param_set, status, ranking, delivered, judge_calls, latency_ms)
      values (${s.retrieval}, ${id}, ${status}, ${sql.json(ranking)}, ${sql.json(delivered)}, ${stats.calls},
        ${Math.round(performance.now() - started)})
      on conflict (retrieval_id, param_set) do nothing`;
  }
}
