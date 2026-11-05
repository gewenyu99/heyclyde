/**
 * Tier 3's unit tests of R32's score forms (#36), run with `deno test`: how a candidate's final score is made from its features
 * under the tilt and logodds forms, the knobs that pick them, and the research budget shadows answer to. No database.
 */
import assert from 'node:assert/strict'
import { type Kind, verdict } from '../../../memory/supabase/functions/memory/budget.ts'
import { finalScore, logit, relevanceOf, scoreForm, type Signals, temperatureKnobs, TEMPERATURE } from '../../../memory/supabase/functions/memory/features.ts'
import { type Params, resolveParams } from '../../../memory/supabase/functions/memory/params.ts'

const V1: Params = {
  candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
  tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
  iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0,
}
const LOGODDS: Params = resolveParams(V1, {
  scoreForm: 'logodds', wRelevance: 4, wConfidence: 0.25, wTemperature: 0.15, wAge: -0.5,
  tempDecay: 0.5, tempFloor: -3, tempWindow: 1000, tempAgentUsed: 3, tempWenConfirm: 3, tempOpened: 1,
})
const s = (o: Partial<Signals>): Signals => ({ armScore: 0.2, relevance: 0.8, confidence: 0.7, temperature: 1.5, age: 9, ...o })

// R32 (#36): on tilt sets, final_score = relevance × (tilt_base + (1 − tilt_base) × confidence), exactly v1's expression.
Deno.test('tilt: the arm score tilted by confidence, bit for bit as v1, and blind to the R32 weights and temperature knobs', () => {
  assert.equal(scoreForm(V1), 'tilt')
  assert.equal(finalScore(s({}), V1), 0.2 * (0.9 + (1 - 0.9) * 0.7))
  assert.equal(finalScore(s({ confidence: null }), V1), 0.2 * (0.9 + (1 - 0.9) * 0.7), 'an unread confidence is tiltUnknownConfidence')
  const tuned = resolveParams(V1, { wTemperature: 5, wAge: -3, wRelevance: 7, wConfidence: 2, tempDecay: 1, tempFloor: -1 })
  for (const sig of [s({}), s({ temperature: 0, age: 0 }), s({ temperature: null, age: null })]) {
    assert.equal(finalScore(sig, tuned), finalScore(sig, V1), 'weights and temperature knobs change 0 tilt scores')
  }
})

// R32 (#36): on logodds sets, final_score = w_rel·r + w_temp·h + w_age·ln(1 + age) + w_conf·logit(clamp(c, 0.01, 0.99)).
Deno.test('logodds: the weighted sum of relevance, temperature, ln(1 + age) and logit(confidence)', () => {
  const want = 4 * 0.8 + 0.15 * 1.5 + -0.5 * Math.log(1 + 9) + 0.25 * Math.log(0.7 / 0.3)
  assert.ok(Math.abs(finalScore(s({}), LOGODDS) - want) <= 1e-12)
  // Confidence 0 and 1 give finite scores, their term w_conf × ∓4.59512.
  const term = (c: number) => finalScore(s({ confidence: c }), LOGODDS) - finalScore(s({ confidence: 0.5 }), LOGODDS)
  assert.ok(Math.abs(term(0) - 0.25 * -4.59512) <= 1e-5, String(term(0)))
  assert.ok(Math.abs(term(1) - 0.25 * 4.59512) <= 1e-5, String(term(1)))
  assert.ok(Math.abs(logit(0.5)) <= 1e-15)
  // A failed feature query logs null, and those terms are 0.
  const blind = finalScore(s({ temperature: null, age: null }), LOGODDS)
  assert.ok(Math.abs(blind - (4 * 0.8 + 0.25 * Math.log(0.7 / 0.3))) <= 1e-12)
})

Deno.test('logodds: raising one weight moves only its own term', () => {
  const base = finalScore(s({}), LOGODDS)
  const up = (knob: string, v: number) => finalScore(s({}), resolveParams(LOGODDS, { [knob]: v })) - base
  assert.ok(Math.abs(up('wTemperature', 1.15) - 1.5) <= 1e-12)
  assert.ok(Math.abs(up('wAge', 0.5) - Math.log(10)) <= 1e-12)
  assert.ok(Math.abs(up('wRelevance', 5) - 0.8) <= 1e-12)
  assert.ok(Math.abs(up('wConfidence', 1.25) - Math.log(0.7 / 0.3)) <= 1e-12)
})

Deno.test('relevance is the arm score over the recall\'s top score, and 0 when nothing scored', () => {
  assert.deepEqual([...relevanceOf([['a', 0.4, null], ['b', 0.1, null], ['c', 0, null]])], [['a', 1], ['b', 0.25], ['c', 0]])
  assert.deepEqual([...relevanceOf([['a', 0, null]])], [['a', 0]])
})

Deno.test('the temperature knobs default to LEARNING-PLAN.md\'s: decay 0.5, floor -3, used and confirmation 3, open 1', () => {
  assert.deepEqual(temperatureKnobs(V1), { ...TEMPERATURE })
  assert.deepEqual(TEMPERATURE, { decay: 0.5, floor: -3, window: 1000, agentUsed: 3, wenConfirm: 3, opened: 1 })
  assert.equal(temperatureKnobs(LOGODDS).window, 1000)
})

// R32 (#36): out-of-range, non-integer or non-numeric knobs are refused, naming the knob.
Deno.test('the R32 knobs are optional, ranged, and a bad one is refused by name', () => {
  for (const [knob, bad] of [
    ['scoreForm', 'sum'], ['tempDecay', 0], ['tempDecay', 5.01], ['tempFloor', 0.1], ['tempFloor', -10.1], ['tempWindow', 0],
    ['tempWindow', 1.5], ['tempWindow', 10001], ['tempAgentUsed', -1], ['tempWenConfirm', 101], ['tempOpened', '1'], ['wRelevance', 11],
    ['wConfidence', Number.NaN],
  ] as [string, unknown][]) {
    assert.throws(() => resolveParams(V1, { [knob]: bad }), new RegExp(knob), `${knob} = ${String(bad)}`)
  }
  assert.doesNotThrow(() => resolveParams(V1, { scoreForm: 'tilt' }))
  assert.doesNotThrow(() => resolveParams(null, { ...V1 }), 'a set without the R32 knobs is still whole')
})

// R34 (#38): shadow judging answers to the research budget, which never stops the served recall or the write judge.
const spent = (usage: Partial<Record<Kind, number>>) => ({ embed: 0, judge_write: 0, judge_recall: 0, shadow: 0, research: 0, ...usage })
Deno.test('the research budget stops shadows and research only', () => {
  const caps = { general: 1000, reserve: 100, research: 50 }
  const full = spent({ shadow: 30, research: 20 })
  assert.match(verdict('shadow', full, caps) ?? '', /research budget is spent \(50 of 50/)
  assert.match(verdict('research', full, caps) ?? '', /research budget/)
  for (const kind of ['embed', 'judge_recall', 'judge_write'] as Kind[]) assert.equal(verdict(kind, full, caps), null, kind)
  assert.equal(verdict('shadow', spent({ shadow: 49 }), caps), null)
  assert.equal(verdict('shadow', full, { general: 1000, reserve: 100 }), null, 'no research cap: only the general one')
})
