/**
 * R74 (#79): Supabase Pro's included quotas and overage rates live once, as SUPABASE_PRO in billing/cost.ts. The cost guard
 * reads them there and holds no quota number of its own.
 */
import assert from 'node:assert/strict'
import * as cost from '../../../memory/supabase/functions/memory/billing/cost.ts'

const GUARD = new URL('../../../memory/supabase/functions/memory/billing/guard.ts', import.meta.url)

Deno.test('R74: one quota table', () => {
  const pro = (cost as Record<string, unknown>).SUPABASE_PRO as Record<string, { included: number; usd_per_unit: number }> | undefined
  assert.ok(pro, 'cost.ts exports SUPABASE_PRO')
  assert.deepEqual(Object.keys(pro).sort(), ['db_bytes', 'egress_bytes', 'invocations', 'mau', 'storage_bytes'])
  for (const [k, q] of Object.entries(pro)) assert.ok(q.included > 0 && q.usd_per_unit > 0, k)
  const src = Deno.readTextFileSync(GUARD)
  assert.match(src, /SUPABASE_PRO/)
  // A quota is a big number: any literal of 4 digits or more, or with an exponent, would be a second table.
  const literals = src.replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, '').match(/\b\d[\d_]{3,}\b|\b\d+e\d+\b/g) ?? []
  assert.deepEqual(literals, [])
})
