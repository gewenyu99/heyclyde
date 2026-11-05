/**
 * Unit tests of R43 (#47) and R29 (#33), run with `deno test`: which pairs one recall's co-use links, how far a co-use and a
 * fade move a link, how a set's linkTypeWeights weigh a co_used link, and the state label recall_more prints. No database.
 */
import assert from 'node:assert/strict'
import { CO_USE, coPairs, coUsed, faded } from '../../../memory/supabase/functions/memory/learn.ts'
import { resolveParams } from '../../../memory/supabase/functions/memory/params.ts'
import { linkTypeWeight } from '../../../memory/supabase/functions/memory/search.ts'
import { deepLabel } from '../../../memory/supabase/functions/memory/deep.ts'

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`)

Deno.test('coPairs: every pair of the top 4 used entries, so at most 6, each in src < dst order', () => {
  assert.deepEqual(coPairs([]), [])
  assert.deepEqual(coPairs(['a']), [])
  assert.deepEqual(coPairs(['b', 'a']), [['a', 'b']])
  const ten = 'jihgfedcba'.split('')
  const pairs = coPairs(ten)
  assert.equal(pairs.length, 6)
  for (const [s, d] of pairs) assert.ok(s < d && ten.slice(0, 4).includes(s) && ten.slice(0, 4).includes(d))
  assert.deepEqual(coPairs(['a', 'a', 'b']), [['a', 'b']], 'an entry named twice is one entry')
  assert.equal(CO_USE.maxPairs, 6)
})

Deno.test('a co-use adds 0.1 up to 1, and a fade takes 0.05 down to 0', () => {
  near(coUsed(0), 0.1)
  near(coUsed(0.1), 0.2)
  near(coUsed(0.95), 1)
  near(coUsed(1), 1)
  near(faded(0.2), 0.15)
  near(faded(0.04), 0)
  assert.equal(CO_USE.fadeEvery, 200)
  assert.equal(CO_USE.sessions, 2)
})

Deno.test('linkTypeWeight: an exact key wins, then a "*|type|*" key, then 1, except co_used, which is 0 unless a set names it', () => {
  const v6 = { '*|co_used|*': 1, 'decisions|relates|decisions': 2 }
  assert.equal(linkTypeWeight(v6, 'decisions', 'co_used', 'projects'), 1)
  assert.equal(linkTypeWeight({}, 'decisions', 'co_used', 'projects'), 0)
  assert.equal(linkTypeWeight({ 'decisions|co_used|projects': 3, '*|co_used|*': 1 }, 'decisions', 'co_used', 'projects'), 3)
  assert.equal(linkTypeWeight(v6, 'decisions', 'relates', 'decisions'), 2)
  assert.equal(linkTypeWeight(v6, 'decisions', 'relates', 'projects'), 1)
})

Deno.test('resolveParams takes a "*|co_used|*" linkTypeWeights key and refuses a malformed one', () => {
  const base = resolveParams(null, {
    candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
    tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
    iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0,
  })
  assert.equal(resolveParams(base, { linkTypeWeights: { '*|co_used|*': 1 } }).linkTypeWeights['*|co_used|*'], 1)
  assert.throws(() => resolveParams(base, { linkTypeWeights: { '**|co_used|*': 1 } }), /must look like/)
})

Deno.test('deepLabel: superseded, then dormant, then on trial, then settled, with the strength to 2 places', () => {
  const row = (o: Record<string, unknown>) => ({ kind: 'observation', confidence: 0.7, chances_left: 0, superseded_by: null, ...o })
  assert.equal(deepLabel(row({}), 0.15), '    kind observation · strength 0.70 · settled')
  assert.equal(deepLabel(row({ chances_left: 2, confidence: 0.5 }), 0.15), '    kind observation · strength 0.50 · on trial, 2 left')
  assert.equal(deepLabel(row({ chances_left: 2, confidence: 0.1 }), 0.15), '    kind observation · strength 0.10 · dormant')
  assert.equal(deepLabel(row({ confidence: 0.1, superseded_by: 'n1, n2' }), 0.15), '    kind observation · strength 0.10 · superseded by n1, n2')
  assert.equal(deepLabel(row({ kind: null, confidence: 0.14 }), 0.15), '    kind observation · strength 0.14 · dormant')
})
