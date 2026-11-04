/**
 * Tier 3's unit tests of best-first spreading (R44, #48), run with `deno test`. The ranking itself, the frontier a recall_more
 * resumes from, the phrase patterns seeds are matched with, and the knobs. No database. The recall that reads a real graph is
 * in bestfirst.test.ts.
 */
import assert from 'node:assert/strict'
import { bestFirst, bestFirstRanked, phrasePatterns, type Ranked } from '../../../memory/supabase/functions/memory/search.ts'
import { type Params, resolveParams, SPREAD } from '../../../memory/supabase/functions/memory/params.ts'

const V4: Params = {
  candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
  tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
  iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0, itemChars: 500,
}
const V5: Params = { ...V4, spreadMode: 'bestfirst', maxHops: 3, minPath: 0.05, wPath: 1 }

type Edges = Map<string, [string, number][]>
/** Undirected links with weights, the way edgesUnder lays out a graph without supersedes links. */
function edges(links: [string, string, number][]): Edges {
  const out: Edges = new Map()
  for (const [a, b, w] of links) {
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!out.has(x)) out.set(x, [])
      out.get(x)!.push([y, w])
    }
  }
  return out
}
const ids = (r: Ranked[]) => r.map(([id]) => id)

// S → A at 0.2 and S → B → C → D at 0.9 each: D's path is 0.729.
const GRAPH = edges([['S', 'A', 0.2], ['S', 'B', 0.9], ['B', 'C', 0.9], ['C', 'D', 0.9]])
const seed: Ranked[] = [['S', 0.2, null]]

Deno.test('bestfirst: strong far beats weak near', () => {
  const [ranked] = bestFirstRanked(GRAPH, seed, new Set(), V5)
  assert.ok(ids(ranked).indexOf('D') < ids(ranked).indexOf('A'), ids(ranked).join())
  const score = Object.fromEntries(ranked.map(([id, s]) => [id, s]))
  assert.ok(Math.abs(score.D - 0.729) < 1e-9 && Math.abs(score.A - 0.2) < 1e-9, JSON.stringify(score))
  assert.deepEqual(ids(ranked), ['S', 'B', 'C', 'D', 'A'])
})

Deno.test('bestfirst: maxHops 2 leaves D out, and resuming the frontier returns D', () => {
  const [ranked, frontier] = bestFirstRanked(GRAPH, seed, new Set(), { ...V5, maxHops: 2 })
  assert.ok(!ids(ranked).includes('D'))
  assert.ok(ids(ranked).includes('A') && ids(ranked).includes('C'))
  assert.deepEqual(frontier.map(([id]) => id), ['C'])
  assert.ok(Math.abs(frontier[0][1] - 0.81) < 1e-9)
  const more = bestFirst(GRAPH, new Map(frontier), 1, 0.05, SPREAD.frontierCap)
  assert.ok(Math.abs(more.best.get('D')! - 0.729) < 1e-9)
})

Deno.test('bestfirst: minPath stops the spread, and what it rejected is in the frontier to resume', () => {
  const [ranked, frontier] = bestFirstRanked(GRAPH, seed, new Set(), { ...V5, minPath: 0.75 })
  assert.deepEqual(ids(ranked).sort(), ['B', 'C', 'S'])
  assert.deepEqual(frontier.map(([id]) => id), ['D', 'A'])
  assert.ok(bestFirst(GRAPH, new Map(frontier), 3, 0.05, SPREAD.frontierCap).best.has('D'))
})

Deno.test('bestfirst: a replaced entry keeps supersededFactor of its score', () => {
  const [plain] = bestFirstRanked(GRAPH, seed, new Set(), V5)
  const [replaced] = bestFirstRanked(GRAPH, seed, new Set(['B']), V5)
  const b = (r: Ranked[]) => r.find(([id]) => id === 'B')![1]
  assert.ok(Math.abs(b(replaced) - b(plain) * V5.supersededFactor) < 1e-12)
})

Deno.test('bestfirst: the frontier holds at most 50 nodes, the strongest', () => {
  const star: [string, string, number][] = [['S', 'H', 1]]
  for (let i = 0; i < 120; i++) star.push(['H', `L${i}`, 0.5 + i / 1000], [`L${i}`, `M${i}`, 1])
  const [, frontier] = bestFirstRanked(edges(star), seed, new Set(), { ...V5, maxHops: 2 })
  assert.equal(frontier.length, SPREAD.frontierCap)
  assert.ok(frontier.every(([, s], i) => i === 0 || frontier[i - 1][1] >= s))
})

Deno.test('bestfirst: a 20,000-entry, 60,000-link graph spreads in 150 ms at p95', () => {
  let state = 12345
  const rand = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648
  const links: [string, string, number][] = []
  for (let i = 0; i < 60000; i++) links.push([`n${Math.floor(rand() * 20000)}`, `n${Math.floor(rand() * 20000)}`, 0.2 + rand() * 0.8])
  const out = edges(links)
  const times: number[] = []
  for (let run = 0; run < 40; run++) {
    const seeds: Ranked[] = Array.from({ length: 50 }, (_, i): Ranked => [`n${Math.floor(rand() * 20000)}`, 1 / (i + 1), null])
    const t = performance.now()
    bestFirstRanked(out, seeds, new Set(), V5)
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const p95 = times[Math.ceil(0.95 * times.length) - 1]
  assert.ok(p95 <= 150, `p95 ${p95.toFixed(1)} ms of ${times.map((t) => t.toFixed(0)).join(', ')}`)
})

Deno.test('phrases: the query\'s 2- and 3-word runs match whole words in order, and a run of stop words is no phrase', () => {
  const patterns = phrasePatterns('cheap bulk model calls', 100).map((p) => new RegExp(p, 'i'))
  assert.equal(patterns.length, 5)
  assert.ok(patterns.some((p) => p.test('Use the cheap bulk model calls for labelling')))
  assert.ok(patterns.some((p) => p.test('bulk model')))
  assert.ok(!patterns.some((p) => p.test('supermodel calls')))
  assert.ok(!patterns.some((p) => p.test('cheap and bulk')))
  assert.deepEqual(phrasePatterns('what is the', 100), [])
  assert.deepEqual(phrasePatterns('single', 100), [])
  assert.ok(phrasePatterns('c++ (v2.0) a.b', 100).every((p) => new RegExp(p)))
  assert.equal(phrasePatterns('a b c d e f', 3).length, 3)
})

Deno.test('the best-first knobs: optional, defaulting to ppr, and checked', () => {
  assert.equal(resolveParams(V4, {}).spreadMode, undefined)
  const v5 = resolveParams(V4, { spreadMode: 'bestfirst', maxHops: 3, minPath: 0.05, wPath: 1 })
  assert.equal(v5.spreadMode, 'bestfirst')
  for (const bad of [{ spreadMode: 'bfs' }, { maxHops: 0 }, { maxHops: 2.5 }, { maxHops: 11 }, { minPath: -0.1 }, { minPath: 1.1 }, { wPath: -1 }]) {
    assert.throws(() => resolveParams(V4, bad), /must be/, JSON.stringify(bad))
  }
})

Deno.test('ppr and bestfirst share one seed function', async () => {
  const src = await Deno.readTextFile(new URL('../../../memory/supabase/functions/memory/search.ts', import.meta.url))
  assert.equal(src.match(/await spreadSeeds\(/g)?.length, 1, 'spreadingSearch asks one function for seeds, whichever the mode')
  assert.equal(src.match(/function spreadSeeds\(/g)?.length, 1)
  assert.equal(src.match(/\bpackText\b|function pack\(/g)?.length, 1, 'one packer')
})
