/**
 * Tier 3 support: what memory's ranking does on the made-up tea vault, captured as plain data. golden-v1.json holds what
 * the code before the parameter sets (slice 1a) produced, from this same scenario, so a test can hold the v1 sets to
 * "ranks exactly like today": the same candidates with the same scores, the same delivered list, the same packet text.
 */
import { request } from '../../src/request.ts'
import { sql, startRealMemory, type RealMemory } from './server.ts'
import { waitFor } from '../helpers.ts'

export const ARMS = ['index', 'hybrid', 'spreading']
export const QUERIES = ['oolong water temperature', 'brew oolong at 90C', 'cold-brew tea suggestion', '乌龙茶', 'supplier of oolong', 'tea']
// The edge weights the ants would learn, set only in the second pass.
export const LINK_TYPE_WEIGHTS = [['decisions', 'supersedes', 'decisions', 2.5], ['preferences', 'relates', 'decisions', 0.5]] as const

type Captured = Record<string, any>

export async function call(m: RealMemory, method: string, path: string, token: string, body?: unknown) {
  const r = await request(method, `${m.url}${path}`, { headers: { authorization: `Bearer ${token}` }, body, timeoutMs: 30_000 })
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status}: ${r.text}`)
  return r.text
}

/** Confidence and link weights that make the tilt, the dormant cut and the graph walk matter. */
export function prepare(weights: boolean) {
  sql(`update memory.entry set confidence = case id when 'tea-oolong-temp' then 0.95 when 'tea-draft-cold' then 0.4
      when 'tea-oolong-old' then 0.1 when 'tea-zh' then 0.5 else confidence end`)
  sql(`update memory.link set weight = 3 where src = 'tea-zh' and dst = 'tea-oolong-temp'`)
  if (weights) {
    for (const [s, t, d, w] of LINK_TYPE_WEIGHTS) {
      sql(`insert into memory.link_type_weight (src_pattern, link_type, dst_pattern, n_links, weight) values ('${s}', '${t}', '${d}', 1, ${w})`)
    }
  }
}

/** The embedding sync, so the vector ranker has something to rank. */
export async function embedAll(m: RealMemory) {
  await call(m, 'POST', '/embeddings/sync', m.cronSecret)
  await waitFor(() => {
    const [s] = sql(`select value from memory.setting where name = 'embed_sync_status'`)
    const v = s && JSON.parse(s.value)
    return v && !v.running ? v : null
  }, 60_000, 'the embedding sync')
}

/**
 * Every query on every arm, as a real recall (its candidates with scores, packet and delivered list as stored) and as
 * the eval route ranks it, with and without the filter. `session` makes the session row a recall will find, which pins
 * its arm: the old code knows only the arm, the new code a parameter set too.
 */
export async function capture(m: RealMemory, arms: string[], session: (id: string, arm: string) => void, rankWith: Record<string, unknown> = {}): Promise<Captured> {
  const out: Captured = { recalls: {}, ranks: {} }
  for (const arm of arms) {
    for (const [i, query] of QUERIES.entries()) {
      const scope = `run:g-${arm}-${i}`
      session(`http-${scope}`, arm)
      await call(m, 'POST', '/recall', m.token, { query, scope })
      const [row] = sql(`select candidates, delivered, rejected, degraded, packet from memory.retrieval where mcp_session = 'http-${scope}'`)
      out.recalls[`${arm}/${i}`] = row
      for (const filter of [true, false]) {
        const r = JSON.parse(await call(m, 'POST', '/api/v1/eval/rank', m.adminToken, { query, arm, filter, ...rankWith }))
        // The five fields the route had before parameter sets, so later additions to its reply don't count as a change.
        out.ranks[`${arm}/${i}/${filter ? 'filter' : 'raw'}`] = Object.fromEntries(['candidates', 'delivered', 'rejected', 'degraded', 'parts'].map((k) => [k, r[k]]))
      }
    }
  }
  return out
}

/** The scenario on a fresh memory: the first pass with every link type at weight 1, the second with the ants' weights, which
 * only spreading reads. The second pass runs on a new function, since the graph is cached per isolate. `rankWith` adds fields
 * to the eval route's body, to name the set the eval ranks on. */
export async function scenario(session: (id: string, arm: string, pass: number) => void, between?: (m: RealMemory, pass: number) => Promise<void>,
  rankWith: (pass: number) => Record<string, unknown> = () => ({})) {
  const result: Captured = {}
  for (const pass of [1, 2]) {
    const m = await startRealMemory()
    try {
      prepare(pass === 2)
      await embedAll(m)
      await between?.(m, pass)
      result[`pass${pass}`] = await capture(m, pass === 1 ? ARMS : ['spreading'], (id, arm) => session(id, arm, pass), rankWith(pass))
    } finally {
      await m.close()
    }
  }
  return result
}
