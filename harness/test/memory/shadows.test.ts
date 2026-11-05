/**
 * Tier 3: R34 (#38), shadow variants, against the real memory function. Up to 2 parameter sets with role 'shadow' rank every
 * real recall inside EdgeRuntime.waitUntil, after the response is out, and log one memory.shadow_retrieval row each. A judge
 * cache keyed by (query hash, entry id, content sha, judge version) means they pay only for pairs nobody judged, and what
 * they pay is metered as kind 'shadow'. They never tick the recall clock, never change the served packet and never reach the
 * learner. GET /api/v1/variants/compare sets each served and shadow set's outcomes side by side.
 */
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { Memory } from '../../src/memory.ts'
import { request } from '../../src/request.ts'
import { FAKE_DOWN } from './openai.ts'
import { SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory
const WORD = 'zqshadow'
// 24 entries the query word matches alike, so the keyword ranker orders them by id and the judge reads the top filterK.
const ENTRIES = Array.from({ length: 24 }, (_, i) => `sh-${String(i + 1).padStart(2, '0')}`)

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({ MEMORY_ARMS: 'hybrid' })
  for (const id of ENTRIES) seed(id, `${WORD} note ${id.replace('-', ' ')}`)
  // t1 ranks as v1 does. t2 and t4 judge 20 where v1 judges 12, so they need the judge for 8 pairs the served recall didn't
  // judge. t3 is the third shadow the API refuses. one serves a single item, so its shadows deliver entries it never shows.
  await set('hybrid.t1', {})
  await set('hybrid.t2', { filterK: 20 })
  await set('hybrid.t3', { filterK: 16 })
  await set('hybrid.t4', { filterK: 20, tiltBase: 0.8 })
  await set('hybrid.one', { packetItems: 1 })
  await allocate({})
})

after(async () => {
  await memory?.close()
})

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const json = (r: { status: number; text: string }, status = 200) => {
  assert.equal(r.status, status, r.text)
  return JSON.parse(r.text)
}
const recall = (query: string, scope?: string) =>
  request('POST', `${memory.url}/recall`, { headers: bearer(memory.token), body: { query, ...(scope ? { scope } : {}) }, timeoutMs: 30_000 })
const rid = (text: string) => /^retrieval (\S+)/.exec(text)![1]
const afterFirstLine = (text: string) => text.slice(text.indexOf('\n') + 1)
const clock = () => Number(sql('select memory.recall_clock() as c')[0].c)
const shadowCalls = (from: number) => memory.openai.calls.slice(from).filter((c) => c.path === '/decisions' && c.headers['x-memory-purpose'] === 'shadow')
const list = (ids: string[]) => ids.map((i) => `'${i}'`).join(', ')

function seed(id: string, title: string, o: { sensitivity?: string; body?: string } = {}) {
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${id}', 'observations', '${title}', '${o.body ?? 'A short body.'}', 'observed', 'global', '${o.sensitivity ?? 'normal'}', 'en',
      '2026-11-01', 'src-a', 'assistant', 'seen', 'x', 'proj-tea', 'wen', 0.80, 0)`)
}

async function set(id: string, params: Record<string, unknown>) {
  const r = await admin('POST', '/param-sets', { id, parent: 'hybrid.v1', params, note: 'tier 3 R34' })
  assert.ok([201, 409].includes(r.status), r.text)
}

/** hybrid.v1 (or `serve`) as the default and the named shadows, every other set off. */
async function allocate(o: { serve?: string; shadows?: string[] }) {
  const serve = o.serve ?? 'hybrid.v1', shadows = o.shadows ?? []
  const all = sql('select id from memory.param_set').map((r) => r.id as string)
  json(await admin('PUT', '/allocation', {
    rows: all.map((param_set) => param_set === serve ? { param_set, role: 'default', weight: 1000 }
      : shadows.includes(param_set) ? { param_set, role: 'shadow', weight: 0 } : { param_set, role: 'off', weight: 0 }),
  }))
}

async function until(ok: () => boolean, ms = 15_000, what = 'the shadow rows') {
  const deadline = Date.now() + ms
  while (!ok()) {
    if (Date.now() > deadline) assert.fail(`${what} never appeared within ${ms} ms`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const rowsFor = (ids: string[]) =>
  ids.length ? sql(`select retrieval_id::text as retrieval_id, param_set, status, ranking, delivered, judge_calls from memory.shadow_retrieval
    where retrieval_id in (${list(ids)}) order by retrieval_id, param_set`) : []
async function shadowed(ids: string[], per: number) {
  await until(() => rowsFor(ids).length === ids.length * per)
  return rowsFor(ids)
}

// R34 (#38): "variants: an off variant ranks and serves nothing".
test('R34: an off variant ranks and serves nothing', { skip: SKIP }, async () => {
  await allocate({})
  const ids: string[] = []
  for (let i = 0; i < 20; i++) ids.push(rid((await recall(`${WORD} off ${i}`)).text))
  await new Promise((r) => setTimeout(r, 1000))
  assert.equal(sql(`select count(*)::int as n from memory.retrieval where param_set = 'hybrid.t1'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.shadow_retrieval where param_set = 'hybrid.t1'`)[0].n, 0)
})

// R34 (#38): "variants: a shadow ranks and logs every recall on its arm".
test('R34: a shadow ranks every recall and logs one ranked row of 1 to 12 ids and scores per recall', { skip: SKIP }, async () => {
  await allocate({ shadows: ['hybrid.t1'] })
  const ids: string[] = []
  for (let i = 0; i < 20; i++) ids.push(rid((await recall(`${WORD} shadow ${i}`)).text))
  const rows = await shadowed(ids, 1)
  assert.deepEqual(rows.map((r) => r.retrieval_id).sort(), [...ids].sort())
  for (const r of rows) {
    assert.equal(r.param_set, 'hybrid.t1')
    assert.equal(r.status, 'ranked')
    assert.ok(r.ranking.length >= 1 && r.ranking.length <= 12, JSON.stringify(r.ranking))
    for (const item of r.ranking) assert.deepEqual(Object.keys(item).sort(), ['id', 'score'])
    assert.equal(sql(`select param_set from memory.retrieval where id = '${r.retrieval_id}'`)[0].param_set, 'hybrid.v1', 'v1 served it')
  }
})

// R34 (#38): "variants: degraded and scoped recalls still log a row per shadow".
test('R34: a degraded recall logs skipped:error for each of 2 shadows, and a scoped one logs ranked', { skip: SKIP }, async () => {
  await allocate({ shadows: ['hybrid.t1', 'hybrid.t2'] })
  const down = rid((await recall(`${WORD} degraded ${FAKE_DOWN}`)).text)
  const scoped = rid((await recall(`${WORD} scoped`, 'run:r1')).text)
  const rows = await shadowed([down, scoped], 2)
  assert.deepEqual(rows.filter((r) => r.retrieval_id === down).map((r) => r.status), ['skipped:error', 'skipped:error'])
  assert.deepEqual(rows.filter((r) => r.retrieval_id === scoped).map((r) => r.status), ['ranked', 'ranked'])
})

// R34 (#38): "variants: shadows never change the served packet".
test('R34: the served packet and delivered list are the same with 0 shadows and with 2', { skip: SKIP }, async () => {
  const q = `${WORD} same packet`
  await allocate({})
  const a = await recall(q)
  await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
  const b = await recall(q)
  await shadowed([rid(b.text)], 2)
  assert.equal(afterFirstLine(b.text), afterFirstLine(a.text))
  const [ra, rb] = [a, b].map((r) => sql(`select param_set, delivered from memory.retrieval where id = '${rid(r.text)}'`)[0])
  assert.deepEqual(rb.delivered, ra.delivered)
  assert.equal(ra.param_set, 'hybrid.v1')
  assert.equal(rb.param_set, 'hybrid.v1')
})

// R34 (#38): "variants: shadows tick no recall clock and teach the learner nothing".
test('R34: shadows tick no clock, and the learner moves nothing only a shadow would have delivered', { skip: SKIP }, async () => {
  const snapshot = () => Object.fromEntries(sql(`select id, confidence::float as c, miss_streak as m from memory.entry where id like 'sh-%'`)
    .map((r) => [r.id, [r.c, r.m]]))
  const before = snapshot(), logs = sql('select max(id) as id from memory.confidence_log')[0].id ?? 0, start = clock()
  await allocate({ serve: 'hybrid.one', shadows: ['hybrid.t1', 'hybrid.t2'] })
  const ids: string[] = []
  for (let i = 0; i < 10; i++) ids.push(rid((await recall(`${WORD} learner ${i}`)).text))
  const rows = await shadowed(ids, 2)
  assert.equal(clock(), start + 10, 'only the 10 served recalls ticked')
  const served = new Set(sql(`select delivered from memory.retrieval where id in (${list(ids)})`).flatMap((r) => r.delivered as string[]))
  const onlyShadow = [...new Set(rows.flatMap((r) => r.delivered as string[]))].filter((id) => !served.has(id))
  assert.ok(onlyShadow.length >= 1, 'the shadows delivered entries the served set did not')
  sql(`update memory.retrieval set created_at = created_at - interval '31 minutes' where learned_at is null`)
  for (let pass = 0; pass < 20; pass++) {
    const done = json(await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 }))
    if (!done.learned && !done.failed) break
  }
  assert.equal(sql(`select count(*)::int as n from memory.confidence_log where id > ${logs} and entry_id in (${list(onlyShadow)})`)[0].n, 0)
  const now = snapshot()
  for (const id of onlyShadow) assert.deepEqual(now[id], before[id], id)
  await allocate({})
})

// R34 (#38): "variants: a third shadow on one arm is refused with 422".
test('R34: a third shadow is refused with 422 by the API and by the database, and changes nothing', { skip: SKIP }, async () => {
  await allocate({ shadows: ['hybrid.t1', 'hybrid.t2'] })
  const alloc = () => JSON.stringify(sql('select param_set, role, weight from memory.allocation order by param_set'))
  const audits = () => sql('select count(*)::int as n from memory.admin_audit')[0].n
  const [a, n] = [alloc(), audits()]
  const r = await admin('PUT', '/allocation', { rows: [{ param_set: 'hybrid.t3', role: 'shadow', weight: 0 }] })
  assert.equal(r.status, 422, r.text)
  assert.match(r.text, /3 shadow sets/)
  assert.equal(alloc(), a)
  assert.equal(audits(), n)
  assert.throws(() => sql(`insert into memory.allocation (param_set, role, weight) values ('hybrid.t3', 'shadow', 0)
    on conflict (param_set) do update set role = 'shadow'`), /at most 2 shadow sets/)
  assert.equal(alloc(), a)
})

// R34 (#38): "variants: shadows run after the response is sent".
test('R34: with the judge 500 ms slow, 2 shadows add at most 250 ms to the median recall', { skip: SKIP }, async () => {
  memory.openai.options.delayMs = 500
  try {
    const timed = async (q: string) => {
      const t = performance.now()
      const r = await recall(q)
      assert.equal(r.status, 200, r.text)
      return { ms: performance.now() - t, id: rid(r.text) }
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
    await allocate({})
    const plain: number[] = []
    for (let i = 0; i < 5; i++) plain.push((await timed(`${WORD} latency plain ${i}`)).ms)
    await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
    const withShadows = []
    for (let i = 0; i < 5; i++) withShadows.push(await timed(`${WORD} latency shadow ${i}`))
    assert.ok(median(withShadows.map((x) => x.ms)) <= median(plain) + 250, `${median(withShadows.map((x) => x.ms))} vs ${median(plain)}`)
    await shadowed(withShadows.map((x) => x.id), 2)
  } finally {
    memory.openai.options.delayMs = 0
  }
})

// R34 (#38): "variants: a failing shadow never fails or changes a recall".
test('R34: a shadow whose judge answers 500 logs skipped:error and the recall answers 200 with the same packet', { skip: SKIP }, async () => {
  memory.openai.options.failShadow = true
  try {
    const ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const q = `${WORD} failing ${i}`
      await allocate({})
      const a = await recall(q)
      await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
      const b = await recall(q)
      assert.equal(b.status, 200, b.text)
      assert.equal(afterFirstLine(b.text), afterFirstLine(a.text))
      ids.push(rid(b.text))
    }
    const rows = await shadowed(ids, 2)
    assert.deepEqual([...new Set(rows.map((r) => r.status))], ['skipped:error'])
  } finally {
    memory.openai.options.failShadow = false
    await allocate({})
  }
})

// R34 (#38): "variants: shadows stop at the research budget, recall and write screening go on".
test('R34: with the research budget spent, shadows log skipped:budget and call no judge, and recall and remember go on', { skip: SKIP }, async () => {
  sql(`insert into memory.setting (name, value) values ('research_budget_tokens', '1') on conflict (name) do update set value = '1'`)
  sql(`insert into memory.openai_usage (month, kind, tokens) values (date_trunc('month', now())::date, 'shadow', 1)
    on conflict (month, kind) do update set tokens = greatest(memory.openai_usage.tokens, 1)`)
  try {
    const from = memory.openai.calls.length, ids: string[] = []
    for (let i = 0; i < 5; i++) {
      const q = `${WORD} budget ${i}`
      await allocate({})
      const a = await recall(q)
      await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
      const b = await recall(q)
      assert.equal(afterFirstLine(b.text), afterFirstLine(a.text))
      ids.push(rid(b.text))
    }
    const rows = await shadowed(ids, 2)
    assert.deepEqual([...new Set(rows.map((r) => r.status))], ['skipped:budget'])
    assert.equal(shadowCalls(from).length, 0)
    const entries = () => sql('select count(*)::int as n from memory.entry')[0].n
    const n = entries()
    const rt = new Memory(memory.url, memory.runtimeToken)
    await rt.remember({ id: 'run-shadow-budget', pattern: 'projects', title: 'Shadow budget run', body: 'A clean note.', authority: 'observed',
      scope: 'run:shadow-budget', evidence_kind: 'summary', evidence: 'Tier 3 made it.', source: { kind: 'run', title: 'clyde run sb', uri: 'clyde://runs/sb' } })
    assert.equal(entries(), n + 1)
  } finally {
    sql(`delete from memory.setting where name = 'research_budget_tokens'`)
    sql(`delete from memory.openai_usage where kind = 'shadow'`)
    await allocate({})
  }
})

// R34 (#38): "variants: shadow judging is charged to the research budget only".
test('R34: shadow judging is metered as kind shadow, to the token, and every other kind meters only the served calls', { skip: SKIP }, async () => {
  await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
  sql('delete from memory.openai_usage')
  const from = memory.openai.calls.length, ids: string[] = []
  for (let i = 0; i < 5; i++) ids.push(rid((await recall(`${WORD} metering ${i}`)).text))
  await shadowed(ids, 2)
  await new Promise((r) => setTimeout(r, 500))
  const calls = memory.openai.calls.slice(from)
  const used = Object.fromEntries(sql(`select kind, tokens::int as tokens from memory.openai_usage`).map((r) => [r.kind, r.tokens]))
  const sum = (cs: typeof calls) => cs.reduce((s, c) => s + c.tokens, 0)
  const shadow = calls.filter((c) => c.headers['x-memory-purpose'] === 'shadow')
  assert.ok(shadow.length >= 1, 'the shadows judged pairs the served recall had not')
  assert.equal(used.shadow, sum(shadow))
  assert.equal(used.judge_recall, sum(calls.filter((c) => c.path === '/decisions' && !c.headers['x-memory-purpose'])))
  assert.equal(used.embed, sum(calls.filter((c) => c.path === '/embeddings')))
  await allocate({})
})

// R34 (#38): "variants: a repeated recall costs its shadows 0 judge calls".
test('R34: a repeated recall costs its shadows 0 judge calls, and editing an entry only a shadow judged costs >= 1', { skip: SKIP }, async () => {
  await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
  const q = `${WORD} cached`
  const first = rid((await recall(q)).text)
  await shadowed([first], 2)
  let from = memory.openai.calls.length
  const second = rid((await recall(q)).text)
  await shadowed([second], 2)
  assert.equal(shadowCalls(from).length, 0, 'every pair was in the cache')
  // The served set judges its top 12. The entry at 17 only the shadows (filterK 20) judged, so only they pay for its new text.
  const candidates: string[] = sql(`select candidates from memory.retrieval where id = '${second}'`)[0].candidates.map((c: any) => c.id)
  const edited = candidates.filter((id) => id.startsWith('sh-'))[16]
  assert.ok(edited, JSON.stringify(candidates))
  json(await admin('PATCH', `/entries/${edited}`, { body: 'A short body, edited.' }))
  from = memory.openai.calls.length
  const third = rid((await recall(q)).text)
  await shadowed([third], 2)
  assert.ok(shadowCalls(from).length >= 1, 'the edited entry\'s new text was judged')
  await allocate({})
})

// R34 (#38): "variants: shadow judging sends private and confidential entries by title only and never the raw query".
test('R34: shadow judging sends private and confidential entries by title only, and never a key in the query', { skip: SKIP }, async () => {
  const m1 = `marker${randomBytes(6).toString('hex')}`, m2 = `marker${randomBytes(6).toString('hex')}`
  seed('sh-00-private', `${WORD} private note`, { sensitivity: 'private', body: `Private ${m1}.` })
  seed('sh-00-secret', `${WORD} confidential note`, { sensitivity: 'confidential', body: `Confidential ${m2}.` })
  const key = `sk-proj-${randomBytes(20).toString('hex')}`
  await allocate({ shadows: ['hybrid.t2', 'hybrid.t4'] })
  const from = memory.openai.calls.length, ids: string[] = []
  for (let i = 0; i < 5; i++) ids.push(rid((await recall(`${WORD} note ${key} ${i}`)).text))
  const rows = await shadowed(ids, 2)
  assert.ok(rows.some((r) => r.ranking.some((x: any) => x.id === 'sh-00-private')), 'a shadow ranked the private entry')
  const sent = memory.openai.calls.slice(from).map((c) => JSON.stringify(c.body)).join('\n')
  const logged = sql(`select string_agg(s::text, '') as t from memory.shadow_retrieval s`)[0].t
  for (const secret of [m1, m2, key]) {
    assert.ok(!sent.includes(secret), `${secret} reached OpenAI`)
    assert.ok(!logged.includes(secret), `${secret} is in shadow_retrieval`)
  }
  sql(`delete from memory.entry where id in ('sh-00-private', 'sh-00-secret')`)
  await allocate({})
})

// R34 (#38): "variants: state changes take effect on the next recall with no restart".
test('R34: setting a shadow on and off takes effect on the next recall, with no restart', { skip: SKIP }, async () => {
  await allocate({ shadows: ['hybrid.t1'] })
  const on = rid((await recall(`${WORD} switch on`)).text)
  await shadowed([on], 1)
  await allocate({})
  const off = rid((await recall(`${WORD} switch off`)).text)
  await new Promise((r) => setTimeout(r, 2000))
  assert.equal(rowsFor([off]).length, 0)
})

// R34 (#38): "variants: agents never see which variant served them".
test('R34: no packet names a shadow set', { skip: SKIP }, async () => {
  const shadows = ['hybrid.t1', 'hybrid.t2', 'hybrid.t3', 'hybrid.t4']
  const packets = sql(`select packet from memory.retrieval where packet is not null`).map((r) => r.packet as string)
  assert.ok(packets.length >= 20)
  for (const p of packets) for (const s of shadows) assert.ok(!p.includes(s), `a packet names ${s}`)
})

// R34 (#38): "variants: shadow rows stay small and expire after 180 days".
test('R34: a shadow row is at most 1024 bytes, and rows older than 180 days expire', { skip: SKIP }, async () => {
  const [{ avg }] = sql(`select avg(pg_column_size(s.*))::float as avg from memory.shadow_retrieval s`)
  assert.ok(avg > 0 && avg <= 1024, String(avg))
  const r = sql(`select id from memory.retrieval order by created_at limit 1`)[0].id
  for (const [p, days] of [['hybrid.t3', 179], ['hybrid.one', 181]] as const) {
    sql(`insert into memory.shadow_retrieval (retrieval_id, param_set, status, created_at) values ('${r}', '${p}', 'ranked', now() - interval '${days} days')`)
  }
  sql('select memory.variant_retention()')
  assert.deepEqual(sql(`select param_set from memory.shadow_retrieval where retrieval_id = '${r}' and param_set in ('hybrid.t3', 'hybrid.one')`)
    .map((x) => x.param_set), ['hybrid.t3'])
})

// R34 (#38): the comparison: each set's recalls, used rate of what it delivered, irrelevant and wrong rates and leaks, a shadow's
// from the outcomes where its deliveries overlap the served ones.
test('R34: GET /variants/compare gives each served and shadow set its recalls, outcome rates and leaks', { skip: SKIP }, async () => {
  await set('hybrid.cmp', { tiltBase: 0.85 })
  await set('hybrid.cmps', { tiltBase: 0.75 })
  await allocate({})
  const served = (delivered: string[], reaction: unknown = null) => {
    const id = randomUUID()
    sql(`insert into memory.retrieval (id, arm, query, param_set, delivered, reaction) values ('${id}', 'hybrid', 'compare', 'hybrid.cmp',
      '${JSON.stringify(delivered)}', ${reaction ? `'${JSON.stringify(reaction)}'` : 'null'})`)
    return id
  }
  const fb = (r: string, entry: string, verdict: string) =>
    sql(`insert into memory.feedback (retrieval_id, source, verdict, entry_id) values ('${r}', 'agent', '${verdict}', '${entry}')`)
  const shadow = (r: string, delivered: string[], status = 'ranked') =>
    sql(`insert into memory.shadow_retrieval (retrieval_id, param_set, status, delivered) values ('${r}', 'hybrid.cmps', '${status}', '${JSON.stringify(delivered)}')`)
  const r1 = served(['ca', 'cb']), r2 = served(['cc', 'cd'], { pushback: true, p: 0.9, cause: 'cd' }), r3 = served([])
  fb(r1, 'ca', 'used')
  fb(r1, 'cb', 'wrong')
  fb(r2, 'cc', 'irrelevant')
  shadow(r1, ['ca', 'cx'])
  shadow(r2, ['cc', 'cd'])
  shadow(r3, [], 'skipped:error')
  const r = json(await admin('GET', '/variants/compare?days=7'))
  assert.equal(r.days, 7)
  const row = (source: string, p: string) => r.sets.find((s: any) => s.source === source && s.param_set === p)
  assert.deepEqual(row('served', 'hybrid.cmp'), {
    param_set: 'hybrid.cmp', source: 'served', role: 'off', recalls: 3, delivered: 4, judged: 4,
    used_rate: 0.25, irrelevant_rate: 0.25, wrong_rate: 0.25, leaks: 2,
  })
  assert.deepEqual(row('shadow', 'hybrid.cmps'), {
    param_set: 'hybrid.cmps', source: 'shadow', role: 'off', recalls: 2, skipped: 1, overlap: 0.75, delivered: 4, judged: 3,
    used_rate: 1 / 3, irrelevant_rate: 1 / 3, wrong_rate: 0, leaks: 1,
  })
  assert.ok(row('served', 'hybrid.v1').recalls >= 20)
  assert.equal((await request('GET', `${memory.url}/api/v1/variants/compare`, { headers: bearer(memory.token), timeoutMs: 10_000 })).status, 401)
})
