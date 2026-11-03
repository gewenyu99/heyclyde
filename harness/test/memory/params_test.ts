/**
 * Tier 3's unit tests of the learning loop's plumbing (R32, R34), run with `deno test`: parameter sets, which one a unit
 * is served, what a recall logs per candidate, and who may spend which OpenAI budget. No database.
 */
import assert from 'node:assert/strict'
import { assign, bucket, sessionSet, unitOf, type Slot } from '../../../memory/supabase/functions/memory/allocation.ts'
import { type Kind, verdict } from '../../../memory/supabase/functions/memory/budget.ts'
import { features } from '../../../memory/supabase/functions/memory/features.ts'
import { type Params, resolveParams } from '../../../memory/supabase/functions/memory/params.ts'

// Today's constants, typed out by hand so that a wrong seed can't pass by agreeing with itself.
const V1: Params = {
  candidates: 50, packetItems: 8, packetTokens: 1500, filterK: 12, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7,
  tiltWindow: 48, rowWindow: 24, dormant: 0.15, rrfK: 10, vecWeight: 1.5, indexDraftFactor: 0.5, scopeBoost: 3, restart: 0.5,
  iterations: 20, supersededFactor: 0.3, linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0,
}

const SALT = 'tier3-salt'
const slots = (live: number, control: number): Slot[] => [
  { param_set: 'hybrid.v1', role: 'default', weight: control },
  { param_set: 'hybrid.v2', role: 'live', weight: live },
  { param_set: 'index.v1', role: 'off', weight: 500 },
  { param_set: 'hybrid.shadow', role: 'shadow', weight: 900 },
]
const units = Array.from({ length: 200 }, (_, i) => `run:u-${i}`)

// R34 (#38): a live variant at 50% serves half the units, sticky per unit, and logs its propensity.
Deno.test('a 50/50 split puts 85 to 115 of 200 units on each side, the same side every time, with propensity 0.5', async () => {
  const first = await Promise.all(units.map((u) => assign(SALT, u, slots(500, 500))))
  const again = await Promise.all(units.map((u) => assign(SALT, u, slots(500, 500))))
  assert.deepEqual(again, first, 'the same unit lands on the same set')
  const live = first.filter((a) => a?.param_set === 'hybrid.v2').length, control = first.filter((a) => a?.param_set === 'hybrid.v1').length
  assert.equal(live + control, 200, 'off and shadow sets are never served')
  for (const n of [live, control]) assert.ok(n >= 85 && n <= 115, `${n} of 200 on one side`)
  for (const a of first) assert.equal(a?.propensity, 0.5)
})

Deno.test('weights scale the split and its propensity, and a salt change reshuffles', async () => {
  const quarter = await Promise.all(units.map((u) => assign(SALT, u, slots(250, 750))))
  const live = quarter.filter((a) => a?.param_set === 'hybrid.v2').length
  assert.ok(live >= 35 && live <= 65, `${live} of 200 at 25%`)
  assert.deepEqual([...new Set(quarter.map((a) => a?.propensity))].sort(), [0.25, 0.75])
  const other = await Promise.all(units.map((u) => assign('another-salt', u, slots(250, 750))))
  assert.ok(other.some((a, i) => a?.param_set !== quarter[i]?.param_set), 'a new salt moves some units')
  assert.equal(await assign(SALT, 'run:x', [{ param_set: 'hybrid.v1', role: 'off', weight: 1000 }]), null, 'nothing serves, nothing assigned')
  assert.equal(await assign(SALT, 'run:x', slots(0, 0)), null, 'serving sets with no weight serve nothing')
})

Deno.test('a bucket is a number from 0 to 999 that depends on the salt and the unit only', async () => {
  const seen = await Promise.all(units.map((u) => bucket(SALT, u)))
  for (const b of seen) assert.ok(Number.isInteger(b) && b >= 0 && b < 1000, String(b))
  assert.equal(await bucket(SALT, 'run:u-3'), seen[3])
  assert.ok(new Set(seen).size > 100, 'buckets spread out')
})

Deno.test('the unit is the run scope, or else principal, client and UTC day, and never an MCP session', () => {
  const noon = new Date('2026-11-02T12:00:00Z'), late = new Date('2026-11-02T23:59:00Z'), next = new Date('2026-11-03T00:01:00Z')
  assert.equal(unitOf('run:abc', 'clyde-test', 'claude-code', noon), 'run:abc')
  const unit = unitOf(null, 'clyde-test', 'claude-code', noon)
  assert.equal(unit, unitOf(null, 'clyde-test', 'claude-code', late), 'the same UTC day')
  assert.notEqual(unit, unitOf(null, 'clyde-test', 'claude-code', next), 'the next day')
  assert.notEqual(unit, unitOf(null, 'other-box', 'claude-code', noon), 'another device')
  assert.notEqual(unit, unitOf(null, 'clyde-test', 'codex-mcp-client', noon), 'another client')
  assert.match(unit, /2026-11-02/)
})

// R32 (#36): a parameter set is complete and in range, or it isn't created.
Deno.test('resolveParams lays overrides over a parent, and refuses an unknown knob or a value out of range', () => {
  const next = resolveParams(V1, { tiltBase: 0.8, linkTypeWeights: { 'decisions|supersedes|decisions': 2.5 } })
  assert.deepEqual({ ...next, tiltBase: V1.tiltBase, linkTypeWeights: {} }, V1, 'only the named knobs move')
  assert.equal(next.tiltBase, 0.8)
  assert.deepEqual(resolveParams(null, V1), V1, 'with no parent, a set must say every knob')
  const bad: [unknown, RegExp][] = [
    [{ bogus: 1 }, /unknown knob bogus/], [{ tiltBase: 2 }, /tiltBase/], [{ candidates: 1.5 }, /candidates/], [{ candidates: 0 }, /candidates/],
    [{ packetItems: '8' }, /packetItems/], [{ restart: 0 }, /restart/], [{ wKind: Infinity }, /wKind/],
    [{ linkTypeWeights: { 'a|b|c': 9 } }, /linkTypeWeights/], [{ linkTypeWeights: { bad: 1 } }, /linkTypeWeights/], ['text', /object/],
  ]
  for (const [overrides, why] of bad) assert.throws(() => resolveParams(V1, overrides), why, JSON.stringify(overrides))
  const { rrfK: _, ...missing } = V1
  assert.throws(() => resolveParams(null, missing), /rrfK/)
})

// R32 (#36): each retrieval logs every candidate's feature values and final score, in at most 50 candidates.
Deno.test('a recall logs at most 50 candidates, each with its rank and score per arm, confidence, kind, judge and final score', () => {
  const ranked = Array.from({ length: 80 }, (_, i): [string, number, null] => [`e${i}`, 1 - i / 100, null])
  const trace = {
    hybrid: ranked.map(([id, s]): [string, number | null] => [id, s * 2]),
    vec: ranked.slice(10).map(([id]): [string, number | null] => [id, null]),
  }
  const logged = features(ranked, trace, new Map([['e0', 0.95]]), new Map([['e0', 0.9]]))
  assert.equal(logged.length, 50)
  for (const f of logged) assert.deepEqual(Object.keys(f).sort(), ['arms', 'confidence', 'id', 'judge', 'kind', 'score'])
  assert.deepEqual(logged[0], {
    id: 'e0', arms: { hybrid: { rank: 1, score: 2 } }, confidence: 0.95, kind: null, judge: 0.9, score: 1,
  })
  assert.deepEqual(logged[12].arms, { hybrid: { rank: 13, score: 1.76 }, vec: { rank: 3, score: null } })
  assert.equal(logged[12].confidence, null, 'a candidate whose confidence was not read has none logged')
  assert.equal(logged[12].judge, null)
  assert.equal(features([], {}, new Map(), new Map()).length, 0)
})

// R32 (#36), the OpenAI cap: the judge's write screening draws on a reserve that no other kind can spend.
const CAPS = { general: 1000, reserve: 100 }
const spent = (usage: Partial<Record<Kind, number>>) => ({ embed: 0, judge_write: 0, judge_recall: 0, shadow: 0, research: 0, ...usage })

Deno.test('the general cap stops embeds, recall judging, shadows and research, and never the write judge', () => {
  const full = spent({ embed: 600, judge_recall: 300, research: 100 })
  for (const kind of ['embed', 'judge_recall', 'shadow', 'research'] as Kind[]) {
    assert.match(verdict(kind, full, CAPS) ?? '', /1000 of 1000/, kind)
  }
  assert.equal(verdict('judge_write', full, CAPS), null)
  assert.equal(verdict('judge_write', spent({ embed: 5000, judge_write: 99 }), CAPS), null)
  assert.equal(verdict('embed', spent({ embed: 999 }), CAPS), null)
})

Deno.test('the reserve stops the write judge alone, and the write judge never eats the general budget', () => {
  const empty = spent({ judge_write: 100 })
  assert.match(verdict('judge_write', empty, CAPS) ?? '', /reserve for screening writes is spent.*100 of 100/)
  for (const kind of ['embed', 'judge_recall', 'shadow', 'research'] as Kind[]) assert.equal(verdict(kind, empty, CAPS), null, kind)
})

// R34 (#38), R36 (#40): the unit, not the session row, is the sticky key. A stand-in for the database that answers the four
// reads and the one write sessionSet makes.
function fakeDb(slots: Slot[], stored: Record<string, unknown> | null) {
  const writes: unknown[][] = []
  const db: any = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = strings.join('?')
    if (q.includes('from memory.allocation')) return Promise.resolve(slots)
    if (q.includes('from memory.setting')) return Promise.resolve([{ value: SALT }])
    if (q.includes('from memory.mcp_session')) return Promise.resolve(stored ? [stored] : [])
    if (q.includes('from memory.param_set')) return Promise.resolve([{ id: values[0], arm: String(values[0]).split('.')[0], params: V1 }])
    if (q.includes('insert into memory.mcp_session')) {
      writes.push(values)
      return Promise.resolve([])
    }
    throw new Error(`the fake database has no answer for: ${q}`)
  }
  return { db, writes }
}

Deno.test('a stored session set serves only the unit it was drawn for: a new day or a session from before units redraws', async () => {
  const days = [new Date('2026-11-02T12:00:00Z'), new Date('2026-11-03T12:00:00Z')]
  const control = slots(500, 500)
  // A device whose two days hash to different sets, so the test can tell a redraw from a kept row.
  let device = ''
  for (let i = 0; !device; i++) {
    const [a, b] = await Promise.all(days.map((d) => assign(SALT, unitOf(null, `box-${i}`, 'http', d), control)))
    if (a?.param_set !== b?.param_set) device = `box-${i}`
  }
  const [unit1, unit2] = days.map((d) => unitOf(null, device, 'http', d))
  const [draw1, draw2] = await Promise.all([unit1, unit2].map((u) => assign(SALT, u, control)))
  const stored = { arm: 'hybrid', param_set: draw1!.param_set, propensity: 0.5, unit: unit1 }

  const same = fakeDb(control, stored)
  assert.equal((await sessionSet(same.db, 'http-global', unit1, 'http')).set.id, draw1!.param_set)
  assert.equal(same.writes.length, 0, 'the same unit keeps its row')

  const next = fakeDb(control, stored)
  const day2 = await sessionSet(next.db, 'http-global', unit2, 'http')
  assert.equal(day2.set.id, draw2!.param_set, 'the next day is drawn from its own bucket')
  assert.equal(next.writes.length, 1)
  assert.ok(next.writes[0].includes(unit2), 'and the row now says whose draw it holds')

  // The row production already has: no unit, so it pins nothing.
  const old = fakeDb(control, { arm: 'index', param_set: null, propensity: null })
  const drawn = await sessionSet(old.db, 'http-global', unit1, 'http')
  assert.equal(drawn.set.id, draw1!.param_set)
  assert.equal(drawn.set.arm, 'hybrid')
})

Deno.test('the propensity a session logs is the share of the set it was actually drawn', async () => {
  const quarter = slots(250, 750)
  for (let i = 0; i < 40; i++) {
    const unit = unitOf(null, `box-${i}`, 'http', new Date('2026-11-02T12:00:00Z'))
    const { set, propensity } = await sessionSet(fakeDb(quarter, null).db, 'http-global', unit, 'http')
    assert.equal(propensity, set.id === 'hybrid.v1' ? 0.75 : 0.25, unit)
  }
})
