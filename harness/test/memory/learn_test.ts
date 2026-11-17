/**
 * Tier 3's unit tests of trials and feedback (R28 #32, R33 #37), run with `deno test`: the one step function, which
 * outcome an entry gets from a recall's signals, the feedback call's checks, the trial item's text, and the footer and
 * reminder lines. No database.
 */
import assert from 'node:assert/strict'
import { checkFeedback, feedbackFooter, reminderLine } from '../../../memory/supabase/functions/memory/feedback.ts'
import { outcomesOf, step } from '../../../memory/supabase/functions/memory/learn.ts'
import { resolveParams } from '../../../memory/supabase/functions/memory/params.ts'
import { renderTrialItem } from '../../../memory/supabase/functions/memory/trial.ts'

const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} is not ${b}`)
const trial = (confidence: number) => ({ confidence, trial: true })
const settled = (confidence: number) => ({ confidence, trial: false })

// R28 (#32): step() is the one place confidence moves by an outcome. 0.12 in trial, 0.02 settled.
Deno.test('step: used +1, irrelevant -0.3, wrong -1, opened +0.2 of the trial size of 0.12', () => {
  near(step(trial(0.5), 'used'), 0.62)
  near(step(trial(0.5), 'wrong'), 0.38)
  near(step(trial(0.5), 'irrelevant'), 0.5 - 0.036)
  near(step(trial(0.5), 'opened'), 0.5 + 0.024)
})

Deno.test('step: a settled entry moves by 0.02 of an outcome', () => {
  near(step(settled(0.7), 'used'), 0.72)
  near(step(settled(0.7), 'wrong'), 0.68)
  near(step(settled(0.7), 'irrelevant'), 0.7 - 0.006)
  near(step(settled(0.7), 'opened'), 0.7 + 0.004)
})

Deno.test('step: ignored is -0.05 in trial and -0.01 settled', () => {
  near(step(trial(0.5), 'ignored'), 0.45)
  near(step(settled(0.5), 'ignored'), 0.49)
})

Deno.test('step: clamped to 0.01 and 0.99', () => {
  assert.equal(step(trial(0.95), 'used'), 0.99)
  assert.equal(step(trial(0.05), 'wrong'), 0.01)
  assert.equal(step(settled(0.985), 'used'), 0.99)
  assert.equal(step(settled(0.015), 'wrong'), 0.01)
  assert.equal(step(settled(0.01), 'ignored'), 0.01)
})

Deno.test('step: the sizes are the served set\'s trialStep and settledStep', () => {
  near(step(trial(0.5), 'used', { trialStep: 0.2, settledStep: 0.05 }), 0.7)
  near(step(settled(0.5), 'used', { trialStep: 0.2, settledStep: 0.05 }), 0.55)
})

Deno.test('step: three used land near 0.86, three wrong land under the 0.15 dormant line, and wrong then used nets nothing', () => {
  let c = 0.5
  for (let i = 0; i < 3; i++) c = step(trial(c), 'used')
  near(c, 0.86)
  c = 0.5
  for (let i = 0; i < 3; i++) c = step(trial(c), 'wrong')
  assert.ok(c < 0.15, String(c))
  near(step(trial(step(trial(0.5), 'wrong')), 'used'), 0.5)
})

Deno.test('trialStep, settledStep, trialItems and trialFloor are optional knobs with ranges', () => {
  const base = { candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
    tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
    iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0 }
  assert.equal(resolveParams(null, base).trialItems, undefined, 'a set without the knob still resolves')
  const v3 = resolveParams(base as never, { trialItems: 3, trialFloor: 0.5, trialStep: 0.12, settledStep: 0.02 })
  assert.deepEqual([v3.trialItems, v3.trialFloor, v3.trialStep, v3.settledStep], [3, 0.5, 0.12, 0.02])
  for (const bad of [{ trialItems: -1 }, { trialItems: 1.5 }, { trialItems: 11 }, { trialFloor: 1.1 }, { trialStep: 0 }, { trialStep: 0.6 }, { settledStep: -0.1 }]) {
    assert.throws(() => resolveParams(base as never, bad), /must be/, JSON.stringify(bad))
  }
})

// R28 (#32): which outcome each shown entry gets from one recall's signals.
Deno.test('outcomesOf: the strongest signal per entry wins, ignored needs feedback that named other entries', () => {
  const shown = ['a', 'b', 'c', 'd', 'e']
  const got = outcomesOf({ shown, named: new Map([['a', 'used'], ['b', 'irrelevant']]), opened: new Set(['c']), blamed: null })
  assert.deepEqual([...got], [['a', 'used'], ['b', 'irrelevant'], ['c', 'opened'], ['d', 'ignored'], ['e', 'ignored']])
  // Opened and named: the bigger weight wins, and a tie goes to the negative one.
  assert.equal(outcomesOf({ shown, named: new Map([['a', 'irrelevant']]), opened: new Set(['a']), blamed: null }).get('a'), 'irrelevant')
  assert.equal(outcomesOf({ shown, named: new Map([['a', 'used']]), opened: new Set(), blamed: 'a' }).get('a'), 'wrong')
  assert.equal(outcomesOf({ shown, named: new Map([['a', 'wrong']]), opened: new Set(['a']), blamed: null }).get('a'), 'wrong')
  assert.equal(outcomesOf({ shown, named: new Map([['a', 'used']]), opened: new Set(['a']), blamed: null }).get('a'), 'used')
})

Deno.test('outcomesOf: with no feedback naming any entry nothing is ignored, and an opened entry is never ignored', () => {
  assert.deepEqual([...outcomesOf({ shown: ['a', 'b'], named: new Map(), opened: new Set(), blamed: null })], [])
  const got = outcomesOf({ shown: ['a', 'b', 'c'], named: new Map([['a', 'used']]), opened: new Set(['b']), blamed: null })
  assert.deepEqual([...got], [['a', 'used'], ['b', 'opened'], ['c', 'ignored']])
  assert.deepEqual([...outcomesOf({ shown: ['a', 'b'], named: new Map(), opened: new Set(), blamed: 'b' })], [['b', 'wrong']])
})

// R33 (#37): the feedback call's checks.
const SHOWN = ['e1', 'e2', 'e3']
const err = (args: Record<string, unknown>) => {
  const r = checkFeedback(args, SHOWN)
  assert.ok('error' in r, JSON.stringify(r))
  return r.error
}
const rows = (args: Record<string, unknown>) => {
  const r = checkFeedback(args, SHOWN)
  assert.ok('rows' in r, JSON.stringify(r))
  return r.rows
}

Deno.test('checkFeedback: entries, and items as an alias, give one row each', () => {
  const want = [{ entry_id: 'e1', verdict: 'used' }, { entry_id: 'e2', verdict: 'wrong' }]
  assert.deepEqual(rows({ entries: want }), want)
  assert.deepEqual(rows({ items: want }), want)
  assert.deepEqual(rows({ entries: [{ entry_id: 'e3', verdict: 'irrelevant' }] }), [{ entry_id: 'e3', verdict: 'irrelevant' }], 'a subset of the packet is fine')
})

Deno.test('checkFeedback: an overall verdict rides along as a row with no entry', () => {
  assert.deepEqual(rows({ entries: [{ entry_id: 'e1', verdict: 'used' }], verdict: 'helpful' }),
    [{ entry_id: 'e1', verdict: 'used' }, { entry_id: null, verdict: 'helpful' }])
})

Deno.test('checkFeedback: nothing_useful is one packet-level row, and the legacy forms still log', () => {
  assert.deepEqual(rows({ nothing_useful: true }), [{ entry_id: null, verdict: 'nothing_useful' }])
  assert.deepEqual(rows({ verdict: 'helpful' }), [{ entry_id: null, verdict: 'helpful' }])
  assert.deepEqual(rows({ verdict: 'wrong', entry_id: 'e2' }), [{ entry_id: 'e2', verdict: 'wrong' }])
})

Deno.test('checkFeedback: an empty call, a contradiction and a bad verdict are refused and name the problem', () => {
  for (const empty of [{}, { entries: [] }, { nothing_useful: false }]) assert.equal(err(empty), 'Not logged: give entries or nothing_useful.')
  assert.match(err({ nothing_useful: true, entries: [{ entry_id: 'e1', verdict: 'wrong' }] }), /^Not logged:.*nothing_useful/)
  assert.match(err({ entries: [{ entry_id: 'e1', verdict: 'used' }, { entry_id: 'e2', verdict: 'great' }] }), /^Not logged:.*great/)
  assert.equal(err({ verdict: 'great' }), 'Not logged: verdict must be helpful, used, irrelevant, wrong or nothing_useful.')
  assert.match(err({ entries: 'e1' }), /^Not logged:/)
  assert.match(err({ entries: [{ entry_id: 'e1' }] }), /^Not logged:/)
  assert.match(err({ entries: ['e1'] }), /^Not logged:/)
})

Deno.test('checkFeedback: an entry the recall did not show, a repeat, too many entries and a long note write nothing', () => {
  assert.match(err({ entries: [{ entry_id: 'e1', verdict: 'used' }, { entry_id: 'zz', verdict: 'wrong' }] }), /^Not logged:.*zz/)
  assert.match(err({ entries: [{ entry_id: 'e1', verdict: 'used' }, { entry_id: 'e1', verdict: 'wrong' }] }), /^Not logged:.*e1/)
  assert.match(err({ entries: Array.from({ length: 4 }, () => ({ entry_id: 'e1', verdict: 'used' })) }), /^Not logged:/)
  assert.match(err({ entries: Array.from({ length: 10_000 }, () => ({ entry_id: 'e1', verdict: 'used' })) }), /^Not logged:/)
  assert.match(err({ verdict: 'wrong', entry_id: 'zz' }), /^Not logged:.*zz/)
  const ok = checkFeedback({ entries: [{ entry_id: 'e1', verdict: 'used' }], note: 'x'.repeat(4000) }, SHOWN)
  assert.ok('rows' in ok)
  assert.match(err({ entries: [{ entry_id: 'e1', verdict: 'used' }], note: 'x'.repeat(4001) }), /^Not logged:.*note/)
})

Deno.test('the footer is one line of at most 200 characters naming the retrieval and every verdict word', () => {
  const rid = '12345678-1234-4234-8234-123456789abc'
  const line = feedbackFooter(rid)
  assert.ok(!line.includes('\n') && line.length <= 200, line)
  for (const word of ['feedback(', rid, 'used', 'irrelevant', 'wrong', 'nothing_useful']) assert.ok(line.includes(word), word)
})

Deno.test('the reminder is one line of at most 300 characters naming each retrieval and the word feedback', () => {
  const ids = ['a1111111-1234-4234-8234-123456789abc', 'b1111111-1234-4234-8234-123456789abc', 'c1111111-1234-4234-8234-123456789abc']
  const line = reminderLine(ids)
  assert.ok(!line.includes('\n') && line.length <= 300, line)
  for (const id of ids) assert.ok(line.includes(id))
  assert.ok(line.includes('feedback'))
})

// R28 (#32): a trial item is labelled and short.
Deno.test('renderTrialItem: labelled with its kind, confidence and chance, in at most 400 characters', () => {
  const row = { id: 'x1', title: 'A new note', body: 'b'.repeat(4000), kind: 'observation', confidence: 0.5, verified: null, sensitivity: 'normal' }
  const text = renderTrialItem(1, row, 2)
  assert.ok(text.length <= 400, String(text.length))
  assert.match(text, /new · observation · 0\.50 · chance 1 of 3/)
  assert.match(text, /^\[T1\] x1: A new note/)
  assert.match(renderTrialItem(2, row, 0), /chance 3 of 3/)
  const unverified = renderTrialItem(1, { ...row, verified: false }, 2)
  assert.match(unverified, /new · observation · unverified · 0\.50 · chance 1 of 3/)
  assert.ok(!renderTrialItem(1, { ...row, sensitivity: 'private', body: 'secret body' }, 2).includes('secret body'))
})
