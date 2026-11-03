/**
 * Tier 3: R42 (#46), short memories with their details in linked artifacts, and the parts of R20 (#24) that need no Storage:
 * the 4 MiB limit in Postgres, kinds, and a restore from before kinds. Against the real memory function with Storage off.
 * The Storage tests are in storage.test.ts.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { bearer, bedFor, countOf, idOf, marker, nonce, note, sha256, words, type Answer } from './bed.ts'
import { apply, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory
let bed: ReturnType<typeof bedFor>
let tool: (name: string, args: Record<string, unknown>) => Promise<Answer>

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  bed = bedFor(memory)
  tool = (await bed.mcp()).tool
})

after(async () => {
  await memory?.close()
})

const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })
const word = () => 'zq' + nonce().replace(/[0-9]/g, 'k')
const entriesTitled = (t: string) => countOf('entry', `title = '${t}'`)
const shaIn = (reply: string) => /Blob \S+: ([0-9a-f]{64})/.exec(reply)![1]

/** Serves one parameter set to every new session. */
async function serve(id: string) {
  const rows = ['index.v1', 'hybrid.v1', 'spreading.v1', 'hybrid.v3', 'spreading.v3', 'hybrid.v4', 'spreading.v4', 'hybrid.v2', 'spreading.v2']
    .filter((p) => sql(`select 1 from memory.param_set where id = '${p}'`).length)
    .map((param_set) => param_set === id ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 })
  const r = await admin('PUT', '/allocation', { rows })
  assert.equal(r.status, 200, r.text)
}

// ---------------------------------------------------------------------------------------------------- R42
test('artifacts: a short entry with a linked document', { skip: SKIP }, async () => {
  const t = `plan ${nonce()}`, body = words(300), text = `${marker()} ` + words(5000)
  const r = await tool('remember', note(t, { body, artifacts: [{ name: 'plan.md', kind: 'document', text }] }))
  assert.equal(r.error, false, r.text)
  const id = idOf(r.text)
  assert.equal(countOf('entry_blob', `entry_id = '${id}'`), 1)
  assert.equal(sql(`select length(body)::int as n from memory.entry where id = '${id}'`)[0].n, 300)
  assert.deepEqual(sql(`select b.stored, x.kind from memory.entry_blob x join memory.blob b using (sha256) where x.entry_id = '${id}'`)[0],
    { stored: 'db', kind: 'document' })
})

test('artifacts: recall lists artifacts without their content', { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const w = word(), m = marker()
  const r = await tool('remember', note(`${w} runbook`, { body: `${w} how the deploy goes.`, artifacts: [{ name: 'plan.md', kind: 'document', text: `${m} ` + words(5000) }] }))
  assert.equal(r.error, false, r.text)
  const packet = (await tool('recall', { query: `${w} runbook` })).text
  assert.ok(packet.includes('plan.md (document'), packet)
  assert.ok(packet.includes('plan.md (document, 4.9 KB)'), packet)
  assert.ok(!packet.includes(m))
})

test('artifacts: long bodies need long:true', { skip: SKIP }, async () => {
  const t = `long ${nonce()}`, body = words(900)
  const refused = await tool('remember', note(t, { body }))
  assert.equal(refused.error, true)
  assert.ok(refused.text.includes('artifact'), refused.text)
  assert.equal(entriesTitled(t), 0)
  const allowed = await tool('remember', note(t, { body, long: true }))
  assert.match(allowed.text, /^Remembered/, allowed.text)
  assert.equal(entriesTitled(t), 1)
  const t2 = `longer ${nonce()}`
  const hard = await tool('remember', note(t2, { body: words(4001), long: true }))
  assert.equal(hard.error, true)
  assert.ok(hard.text.includes('The limit is 4000'), hard.text)
  assert.equal(entriesTitled(t2), 0)
  const exact = await tool('remember', note(`exact ${nonce()}`, { body: words(500) }))
  assert.match(exact.text, /^Remembered/, exact.text)
})

test('artifacts: blobs still works as an alias', { skip: SKIP }, async () => {
  const a = await tool('remember', note(`alias a ${nonce()}`, { artifacts: [{ name: 'a.txt', text: 'alpha text' }] }))
  const b = await tool('remember', note(`alias b ${nonce()}`, { blobs: [{ name: 'a.txt', text: 'alpha text' }] }))
  for (const r of [a, b]) assert.equal(r.error, false, r.text)
  const line = (r: Answer) => r.text.split('\n').find((l) => l.startsWith('Blob a.txt'))
  assert.equal(line(a), line(b))
  assert.match(line(a)!, /\(document, 10 bytes\)$/)
  assert.deepEqual(sql(`select kind from memory.entry_blob where entry_id = '${idOf(b.text)}'`), [{ kind: 'document' }])
})

test('artifacts: the instructions and the remember description say artifact and 500', { skip: SKIP }, async () => {
  const { session, init } = await bed.mcp()
  assert.match(init.instructions, /artifact/)
  assert.match(init.instructions, /500/)
  const listed = await bed.call('POST', '/mcp', { ...bearer(memory.token), 'mcp-session-id': session }, { jsonrpc: '2.0', id: 3, method: 'tools/list' })
  const remember = JSON.parse(listed.text).result.tools.find((t: any) => t.name === 'remember')
  assert.match(remember.description, /artifact/)
  assert.match(remember.description, /500/)
})

test('artifacts: a recall packet with artifacts listed stays at 2400 characters at p95', { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const w = word()
  for (let i = 0; i < 12; i++) {
    const r = await tool('remember', note(`${w} t${i}`, {
      body: `topic ${i}: ` + words(40, 'a short note about the deploy '),
      artifacts: [{ name: `plan-${i}.md`, kind: 'document', text: words(3000) }],
    }))
    assert.equal(r.error, false, r.text)
  }
  const sizes: number[] = []
  for (let i = 0; i < 20; i++) sizes.push((await (await bed.mcp()).tool('recall', { query: `${w} t${i % 12}` })).text.length)
  sizes.sort((a, b) => a - b)
  const p95 = sizes[Math.ceil(0.95 * sizes.length) - 1]
  assert.ok(p95 <= 2400, `p95 ${p95} of ${sizes.join(', ')}`)
  assert.ok(sizes.some((n) => n > 0))
})

test('artifacts: hybrid.v4 and spreading.v4 cut each item to 500 characters, and v1 to v3 are unchanged', { skip: SKIP }, async () => {
  for (const arm of ['hybrid', 'spreading']) {
    if (!sql(`select 1 from memory.param_set where id = '${arm}.v2'`).length) {
      const r = await admin('POST', '/param-sets', { id: `${arm}.v2`, parent: `${arm}.v1`, params: { otherRunFactor: 0.9 }, note: 'tier 3 stand-in for production\'s v2' })
      assert.equal(r.status, 201, r.text)
    }
  }
  apply('20261103020000_trials_feedback.sql')
  apply('20261103030000_artifacts_storage.sql')
  for (const arm of ['hybrid', 'spreading']) {
    const [v3, v4] = ['v3', 'v4'].map((v) => sql(`select parent, params from memory.param_set where id = '${arm}.${v}'`)[0])
    assert.equal(v4.parent, `${arm}.v3`)
    assert.equal(v4.params.itemChars, 500)
    assert.deepEqual({ ...v4.params, itemChars: undefined }, { ...v3.params, itemChars: undefined })
    for (const v of ['v1', 'v2', 'v3']) assert.equal(sql(`select params->'itemChars' as c from memory.param_set where id = '${arm}.${v}'`)[0].c, null)
  }
  await serve('hybrid.v4')
  const w = word(), body = `${w} ` + 'alpha beta gamma '.repeat(120)
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence,
      evidence_sha256, project, kind, confidence, chances_left)
    values ('${w}-long', 'observations', '${w} long note', '${body}', 'observed', 'global', 'normal', 'en', '2026-11-01', 'src-a',
      'assistant', 'seen', 'x', 'proj-tea', 'wen', 0.8, 0)`)
  const packet = (await tool('recall', { query: `${w} long note` })).text
  const item = packet.slice(packet.indexOf(`${w}-long`))
  assert.ok(item.includes(`${body.slice(0, 500)}… more in get_entry`), item.slice(0, 900))
  assert.ok(!item.includes(body.slice(0, 560)))
  await serve('hybrid.v1')
})

// ---------------------------------------------------------------------------------------------------- R20 without Storage
test('R20: a blob kind outside the 8 is refused', { skip: SKIP }, async () => {
  const t = `kind ${nonce()}`
  const r = await tool('remember', note(t, { artifacts: [{ name: 'sheet.xlsx', kind: 'spreadsheet', text: 'a,b' }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('Use one of image, video, audio, document, skill, artifact, data, other'), r.text)
  assert.equal(entriesTitled(t), 0)
})

test('R20: a pre-R20 restore fills kind', { skip: SKIP }, async () => {
  const content = Buffer.from('a,b,c\n1,2,3\n4,5,6\n')
  const sha = sha256(content)
  const lines = [
    { table: 'blob', row: { sha256: sha, media_type: 'text/csv', size: content.length, content: { base64: content.toString('base64') }, created_at: '2026-11-01T00:00:00Z' } },
    { table: 'entry_blob', row: { entry_id: 'tea-zh', name: 'data.csv', sha256: sha } },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n'
  assert.equal(content.length, 18)
  const r = await request('POST', `${memory.url}/api/v1/import`, { headers: { ...bearer(memory.adminToken), 'content-type': 'application/x-ndjson' }, body: lines, timeoutMs: 30_000 })
  assert.equal(r.status, 200, r.text)
  assert.deepEqual(sql(`select kind from memory.entry_blob where name = 'data.csv'`), [{ kind: 'data' }])
})

test('R20: the migration makes kind required and one of the 8', { skip: SKIP }, () => {
  assert.equal(sql(`select is_nullable from information_schema.columns where table_schema = 'memory' and table_name = 'entry_blob' and column_name = 'kind'`)[0].is_nullable, 'NO')
  assert.equal(Number(sql(`select count(*)::int as n from pg_constraint where conrelid = 'memory.entry_blob'::regclass and contype = 'c' and pg_get_constraintdef(oid) like '%kind%'`)[0].n), 1)
  assert.equal(Number(sql(`select count(*)::int as n from memory.entry_blob where kind is null`)[0].n), 0)
})

test('R20 no Storage: blobs stay in Postgres under the 4 MiB limit', { skip: SKIP }, async () => {
  const big = randomBytes(4_194_304), over = randomBytes(4_194_305)
  const first = await tool('remember', note(`db ${nonce()}`, { artifacts: [{ name: 'big.bin', base64: big.toString('base64') }] }))
  assert.equal(first.error, false, first.text)
  assert.deepEqual(sql(`select stored, octet_length(content) as n from memory.blob where sha256 = '${shaIn(first.text)}'`)[0], { stored: 'db', n: 4_194_304 })
  const second = await tool('remember', note(`db ${nonce()}`, { artifacts: [{ name: 'over.bin', base64: over.toString('base64') }] }))
  assert.equal(second.error, true)
  assert.ok(second.text.includes('is 4194305 bytes. The limit is 4194304.'), second.text)
  const third = await tool('remember', note(`db ${nonce()}`, { artifacts: [{ name: 'a.bin', base64: big.toString('base64') }, { name: 'b.bin', base64: over.toString('base64') }] }))
  assert.equal(third.error, true)
  assert.ok(third.text.includes('The blobs add up to 8388609 bytes. The limit for one entry is 8388608.'), third.text)
  const up = await tool('upload_blob', { sha256: sha256(over), size: over.length, media_type: 'application/octet-stream' })
  assert.equal(up.error, true)
  assert.ok(up.text.includes('This memory has no file storage. Send the file inline as base64.'), up.text)
  const text = 'a hundred bytes of plain text kept in postgres, the way a small note is. It is exactly one hundred bytes.'
  const small = await tool('remember', note(`db ${nonce()}`, { artifacts: [{ name: 'n.txt', text }] }))
  assert.ok((await tool('get_blob', { sha256: shaIn(small.text) })).text.includes(text))
})
