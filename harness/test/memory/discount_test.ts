/**
 * Tier 3's unit test of the other-run discount (issue #18): otherRunFactor and globalAgentDraftFactor rank other runs'
 * notes and global drafts lower without hiding them. No database.
 */
import assert from 'node:assert/strict'
import { discount, type Scoped } from '../../../memory/supabase/functions/memory/search.ts'
import { type Params, resolveParams } from '../../../memory/supabase/functions/memory/params.ts'

const V1: Params = {
  candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
  tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
  iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0,
}
const info = new Map<string, Scoped>([
  ['other', { scope: 'run:old', authority: 'draft' }],
  ['global', { scope: 'global', authority: 'observed' }],
  ['gdraft', { scope: 'global', authority: 'draft' }],
  ['mine', { scope: 'run:me', authority: 'draft' }],
])
const rank = (factors: Partial<Params>, ids: string[], scope: string | null = null) =>
  discount(ids.map((id): [string, number, null] => [id, 1, null]), info, scope, { ...V1, ...factors }).map(([id]) => id)

Deno.test('with otherRunFactor 0.3 an other-run note ranks below an equal global note, and is still delivered alone', () => {
  assert.deepEqual(rank({ otherRunFactor: 0.3 }, ['other', 'global']), ['global', 'other'])
  assert.deepEqual(rank({ otherRunFactor: 0.3 }, ['other']), ['other'])
  const [[, score]] = discount([['other', 1, null]], info, null, { ...V1, otherRunFactor: 0.3 })
  assert.equal(score, 0.3)
})

Deno.test('with the factor at 1, or absent, ordering and scores are unchanged', () => {
  const same = [['other', 1, null], ['global', 1, null]] as [string, number, null][]
  assert.deepEqual(discount(same, info, null, { ...V1, otherRunFactor: 1 }), same)
  assert.deepEqual(discount(same, info, null, V1), same)
})

Deno.test("a recall's own run is not discounted, and globalAgentDraftFactor discounts drafts outside any run", () => {
  assert.deepEqual(rank({ otherRunFactor: 0.3 }, ['other', 'mine'], 'run:me'), ['mine', 'other'])
  assert.deepEqual(rank({ globalAgentDraftFactor: 0.3 }, ['gdraft', 'global']), ['global', 'gdraft'])
  assert.deepEqual(rank({ globalAgentDraftFactor: 0.3 }, ['mine', 'gdraft'], 'run:me'), ['mine', 'gdraft'])
})

Deno.test('the factors are optional, and must be in (0, 1]', () => {
  assert.equal(resolveParams(V1, { otherRunFactor: 0.3 }).otherRunFactor, 0.3)
  for (const bad of [0, 1.2, -1, 'x']) assert.throws(() => resolveParams(V1, { otherRunFactor: bad }), /otherRunFactor/)
  assert.throws(() => resolveParams(V1, { globalAgentDraftFactor: 0 }), /globalAgentDraftFactor/)
})
