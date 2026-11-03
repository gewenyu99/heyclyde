/**
 * Tier 3: R20 (#24), blobs in Supabase Storage, against the real memory function with a fake Storage mounted under
 * /storage/v1 (storage.ts) and a service role key, so the function's Storage is on. One bed for the whole file. Each test
 * starts with no uploads waiting. The register_agent step in the issue's bed doesn't apply: main has no agent registry.
 * The tests with no Storage, the restore and the export are in artifacts.test.ts and storage-export.test.ts.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, beforeEach, test } from 'node:test'
import { FAKE_REFUSE } from './openai.ts'
import { bearer, bedFor, countOf, idOf, marker, nonce, note, raw, sha256, upload, uploadUrl, words, type Answer } from './bed.ts'
import { SKIP, sql, startStorageBed, type RealMemory } from './server.ts'

let memory: RealMemory
let bed: ReturnType<typeof bedFor>
let tool: (name: string, args: Record<string, unknown>) => Promise<Answer>
const PRIVATE_BLOB = '[private blob: ask Wen]'

before(async () => {
  if (SKIP) return
  memory = await startStorageBed()
  bed = bedFor(memory)
  tool = (await bed.mcp()).tool
})

// R20: no reply carries the service role key, and every blob row is in exactly one place (checked at the end of the file).
after(async () => {
  if (SKIP) return
  try {
    assert.ok(bed.recorded.length >= 1)
    const leaked = bed.recorded.filter((r) => r.text.includes(memory.serviceKey!) || r.location.includes(memory.serviceKey!)).length
    assert.equal(leaked, 0, 'a reply carried SUPABASE_SERVICE_ROLE_KEY')
    assert.equal(countOf('blob', `(stored = 'storage') <> (content is null)`), 0)
    assert.equal(countOf('blob', `stored = 'db' and encode(sha256(content), 'hex') <> sha256`), 0)
    const rows = sql(`select sha256, stored from memory.blob`)
    const storedRows = rows.filter((r) => r.stored === 'storage').map((r) => r.sha256 as string)
    assert.deepEqual(storedRows.filter((s) => !memory.storage!.objects.has(s)), [], 'a storage row has no object')
    assert.deepEqual(memory.storage!.settled().filter((n) => !storedRows.includes(n)), [], 'an object has no blob row')
  } finally {
    await memory.close()
  }
})

beforeEach(() => {
  if (SKIP) return
  sql(`delete from memory.upload`)
  sql(`delete from memory.setting where name = 'blob_quota_bytes'`)
  memory.storage!.mode = {}
})

const used = () => Number(sql(`select coalesce(sum(size), 0)::bigint as u from memory.blob`)[0].u)
const setQuota = (v: string | number) =>
  sql(`insert into memory.setting (name, value) values ('blob_quota_bytes', '${v}') on conflict (name) do update set value = excluded.value`)
const entriesTitled = (t: string) => countOf('entry', `title = '${t}'`)
const blobsOf = (sha: string) => countOf('blob', `sha256 = '${sha}'`)
const shaIn = (reply: string) => /Blob \S+: ([0-9a-f]{64})/.exec(reply)![1]
const named = (...names: string[]) => names.filter((n) => memory.storage!.objects.has(n)).length
const signs = () => memory.storage!.count('/sign/', ['POST'])
const link = (reply: string) => /Download it within 10 minutes: (\S+)/.exec(reply)![1]

test('R20 storage: a 5 MiB PNG sent with upload_blob and cited in remember comes back through get_blob\'s link with the same sha256', { skip: SKIP }, async () => {
  const png = randomBytes(5_242_880)
  const { sha, reply } = await upload(tool, png, 'image/png')
  assert.match(reply, /PUT the file within two hours/)
  const r = await tool('remember', note(`png ${nonce()}`, { artifacts: [{ name: 'shot.png', sha256: sha, kind: 'image' }] }))
  assert.equal(r.error, false, r.text)
  assert.ok(r.text.includes(`Blob shot.png: ${sha} (image, 5242880 bytes)`), r.text)
  const g = await tool('get_blob', { sha256: sha })
  assert.ok(g.text.includes('Download it within 10 minutes: '), g.text)
  const got = await raw('GET', link(g.text))
  assert.equal(got.status, 200)
  assert.equal(sha256(got.body), sha)
  assert.equal(named(sha), 1)
  assert.equal(named(`incoming/${sha}`), 0)
})

test('R20 storage: an upload whose bytes don\'t match the cited sha256 is refused and deleted from incoming/', { skip: SKIP }, async () => {
  const a = randomBytes(1024), b = randomBytes(1024), sha = sha256(a), t = `mismatch ${nonce()}`
  const up = await tool('upload_blob', { sha256: sha, size: 1024, media_type: 'application/octet-stream' })
  await raw('PUT', uploadUrl(up.text), b)
  const r = await tool('remember', note(t, { artifacts: [{ name: 'a.bin', sha256: sha }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('has a different sha256, so memory deleted it'), r.text)
  assert.equal(named(sha, `incoming/${sha}`), 0)
  assert.equal(blobsOf(sha), 0)
  assert.equal(entriesTitled(t), 0)
})

test('R20 storage: citing a sha256 nobody uploaded is refused and writes nothing', { skip: SKIP }, async () => {
  const sha = sha256(randomBytes(64)), t = `nobody ${nonce()}`
  const r = await tool('remember', note(t, { artifacts: [{ name: 'x.bin', sha256: sha }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes(`memory has no blob ${sha}`), r.text)
  assert.equal(entriesTitled(t), 0)
})

test('R20 storage: a private blob\'s sha256 can\'t be probed or cited', { skip: SKIP }, async () => {
  const bytes = randomBytes(1000), p = sha256(bytes), u = sha256(randomBytes(1000))
  const made = await tool('remember', note(`private ${nonce()}`, { sensitivity: 'private', artifacts: [{ name: 'p.bin', base64: bytes.toString('base64') }] }))
  assert.equal(made.error, false, made.text)
  assert.equal(countOf('blob', `sha256 = '${p}' and stored = 'storage'`), 1)
  for (const sha of [p, u]) {
    const up = await tool('upload_blob', { sha256: sha, size: 1000, media_type: 'text/plain' })
    assert.ok(up.text.includes('PUT the file within two hours'), up.text)
    assert.ok(!up.text.includes('memory already has'))
  }
  for (const sha of [p, u]) {
    const r = await tool('remember', note(`cite ${nonce()}`, { artifacts: [{ name: 'x.bin', sha256: sha }] }))
    assert.equal(r.error, true)
    assert.ok(r.text.includes(`memory has no blob ${sha}`), r.text)
  }
  assert.equal(countOf('entry_blob', `sha256 = '${p}'`), 1)
  assert.equal((await tool('get_blob', { sha256: p })).text, PRIVATE_BLOB)
})

test('R20 storage: nothing over 524288000 bytes is accepted or left in Storage', { skip: SKIP }, async () => {
  const before = memory.storage!.requests.length
  const over = await tool('upload_blob', { sha256: sha256('over'), size: 524_288_001, media_type: 'video/mp4' })
  assert.equal(over.error, true)
  assert.ok(over.text.includes('size must be 1 to 524288000 bytes'), over.text)
  assert.equal(memory.storage!.count('/object/upload/sign/', ['POST'], before), 0)
  const edge = await tool('upload_blob', { sha256: sha256('edge'), size: 524_288_000, media_type: 'video/mp4' })
  assert.ok(edge.text.includes('PUT the file within two hours'), edge.text)
  // An object bigger than the limit that was declared small: its info says so, and nothing is read.
  const sha = sha256(randomBytes(32)), t = `huge ${nonce()}`
  await tool('upload_blob', { sha256: sha, size: 1000, media_type: 'video/mp4' })
  memory.storage!.put(`incoming/${sha}`, Buffer.from('tiny'), { size: 524_288_001 })
  const r = await tool('remember', note(t, { artifacts: [{ name: 'huge.mp4', sha256: sha }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('The limit is 524288000'), r.text)
  assert.equal(blobsOf(sha), 0)
  assert.equal(named(sha, `incoming/${sha}`), 0)
})

test('R20 storage: an upload bigger or smaller than upload_blob declared is refused before it is read', { skip: SKIP }, async () => {
  const sha = sha256(randomBytes(32)), t = `size ${nonce()}`
  const up = await tool('upload_blob', { sha256: sha, size: 1000, media_type: 'application/octet-stream' })
  await raw('PUT', uploadUrl(up.text), randomBytes(2000))
  const r = await tool('remember', note(t, { artifacts: [{ name: 'x.bin', sha256: sha }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('but upload_blob was told 1000'), r.text)
  assert.equal(named(sha, `incoming/${sha}`), 0)
  assert.equal(memory.storage!.count(`/object/memory-blobs/incoming/${sha}`, ['GET']), 0)
  assert.equal(entriesTitled(t), 0)
})

test('R20 storage: a refusal for the note leaves the upload in incoming/ for a retry and nothing at <sha256>', { skip: SKIP }, async () => {
  const u = used(), bytes = randomBytes(1000), t = `retry ${nonce()}`
  setQuota(u + 5000)
  const { sha } = await upload(tool, bytes)
  setQuota(u + 500)
  const args = note(t, { artifacts: [{ name: 'x.bin', sha256: sha }] })
  const refused = await tool('remember', args)
  assert.equal(refused.error, true)
  assert.ok(refused.text.includes(`These blobs need 1000 bytes, and memory holds ${u} of its ${u + 500}.`), refused.text)
  assert.equal(named(sha), 0)
  assert.equal(named(`incoming/${sha}`), 1)
  setQuota(u + 5000)
  assert.match((await tool('remember', args)).text, /^Remembered/)
  // The same for a link to an entry that isn't there.
  const second = randomBytes(1000)
  const { sha: sha2 } = await upload(tool, second)
  const t2 = `retry link ${nonce()}`
  const bad = await tool('remember', note(t2, { artifacts: [{ name: 'y.bin', sha256: sha2 }], links: [{ type: 'supports', to: 'no-such-entry' }] }))
  assert.equal(bad.error, true)
  assert.equal(named(sha2), 0)
  assert.equal(named(`incoming/${sha2}`), 1)
  assert.match((await tool('remember', note(t2, { artifacts: [{ name: 'y.bin', sha256: sha2 }] }))).text, /^Remembered/)
})

test('R20 storage: with no blob_quota_bytes the cap is 10737418240 bytes', { skip: SKIP }, async () => {
  const u = used()
  assert.ok(u <= 2_147_483_628)
  const shas = [0, 1, 2, 3, 4].map((i) => sha256(`seed ${i} ${nonce()}`))
  const sizes = [2_147_483_628, 2_147_483_628, 2_147_483_628, 2_147_483_628, 2_147_483_628 - u]
  try {
    sql(`insert into memory.blob (sha256, media_type, size, content, stored) values ${shas.map((s, i) => `('${s}', 'application/octet-stream', ${sizes[i]}, null, 'storage')`).join(', ')}`)
    assert.equal(used(), 10_737_418_140)
    const fits = await tool('upload_blob', { sha256: sha256(`fits ${nonce()}`), size: 100, media_type: 'text/plain' })
    assert.ok(fits.text.includes('PUT the file within two hours'), fits.text)
    const over = await tool('upload_blob', { sha256: sha256(`over ${nonce()}`), size: 101, media_type: 'text/plain' })
    assert.equal(over.error, true)
    assert.ok(over.text.includes('That needs 101 bytes, and memory holds 10737418140 of its 10737418240.'), over.text)
  } finally {
    sql(`delete from memory.blob where sha256 in (${shas.map((s) => `'${s}'`).join(', ')})`)
  }
})

test('R20 storage: blob_quota_bytes caps Postgres and Storage blobs together and refuses with the numbers', { skip: SKIP }, async () => {
  const u = used(), before = countOf('blob', 'true')
  setQuota(u + 1000)
  const ok = await tool('upload_blob', { sha256: sha256(`a ${nonce()}`), size: 1000, media_type: 'text/plain' })
  assert.ok(ok.text.includes('PUT the file within two hours'), ok.text)
  const no = await tool('upload_blob', { sha256: sha256(`b ${nonce()}`), size: 1001, media_type: 'text/plain' })
  assert.equal(no.error, true)
  assert.ok(no.text.includes(`That needs 1001 bytes, and memory holds ${u} of its ${u + 1000}.`), no.text)
  const inline = [{ name: 'r.bin', base64: randomBytes(1001).toString('base64') }, { name: 't.txt', text: randomBytes(501).toString('hex').slice(0, 1001) }]
  for (const artifact of inline) {
    const r = await tool('remember', note(`quota ${nonce()}`, { artifacts: [artifact] }))
    assert.equal(r.error, true)
    assert.ok(r.text.includes(`These blobs need 1001 bytes, and memory holds ${u} of its ${u + 1000}. Free some space or raise blob_quota_bytes.`), r.text)
  }
  assert.equal(countOf('blob', 'true'), before)
})

test('R20 storage: blob_quota_bytes 0 refuses every new blob, and a malformed value falls back to the default', { skip: SKIP }, async () => {
  const u = used()
  setQuota('0')
  const zero = await tool('upload_blob', { sha256: sha256(`z ${nonce()}`), size: 1, media_type: 'text/plain' })
  assert.equal(zero.error, true)
  assert.ok(zero.text.includes(`That needs 1 bytes, and memory holds ${u} of its 0.`), zero.text)
  for (const bad of ['abc', '-1']) {
    setQuota(bad)
    const r = await tool('upload_blob', { sha256: sha256(`m ${bad} ${nonce()}`), size: 1, media_type: 'text/plain' })
    assert.ok(r.text.includes('PUT the file within two hours'), r.text)
  }
})

test('R20 storage: citing a blob memory already has costs no quota', { skip: SKIP }, async () => {
  const bytes = randomBytes(1000), s = sha256(bytes)
  assert.equal((await tool('remember', note(`held ${nonce()}`, { artifacts: [{ name: 's.bin', base64: bytes.toString('base64') }] }))).error, false)
  setQuota(used())
  const before = countOf('blob', 'true'), links = countOf('entry_blob', `sha256 = '${s}'`)
  const r = await tool('remember', note(`again ${nonce()}`, { artifacts: [{ name: 'again.bin', sha256: s }] }))
  assert.match(r.text, /^Remembered/)
  assert.equal(countOf('blob', 'true'), before)
  assert.equal(countOf('entry_blob', `sha256 = '${s}'`), links + 1)
})

test('R20 storage: blob_quota_bytes is one cap shared by every device', { skip: SKIP }, async () => {
  const tokenB = `device-${randomBytes(8).toString('hex')}`
  sql(`insert into memory.device (name, token_sha256) values ('clyde-b', '${sha256(tokenB)}') on conflict do nothing`)
  const u = used()
  setQuota(u + 1000)
  const a = await tool('remember', note(`devA ${nonce()}`, { artifacts: [{ name: 'a.bin', base64: randomBytes(1000).toString('base64') }] }))
  assert.match(a.text, /^Remembered/)
  const b = await (await bed.mcp(tokenB)).tool('upload_blob', { sha256: sha256(`b ${nonce()}`), size: 1, media_type: 'text/plain' })
  assert.equal(b.error, true)
  assert.ok(b.text.includes(`That needs 1 bytes, and memory holds ${u + 1000} of its ${u + 1000}.`), b.text)
})

test('R20 storage: concurrent writes respect the quota', { skip: SKIP }, async () => {
  const u = used()
  setQuota(u + 5000)
  const replies = await Promise.all(Array.from({ length: 10 }, (_, i) =>
    tool('remember', note(`race ${i} ${nonce()}`, { artifacts: [{ name: 'r.bin', base64: randomBytes(1000).toString('base64') }] }))))
  assert.equal(replies.filter((r) => !r.error && r.text.startsWith('Remembered')).length, 5, replies.map((r) => r.text).join('\n'))
  assert.equal(replies.filter((r) => r.error && r.text.includes('These blobs need 1000 bytes')).length, 5)
  assert.equal(used(), u + 5000)
})

test('R20 storage: concurrent cites of one upload both land', { skip: SKIP }, async () => {
  const { sha } = await upload(tool, randomBytes(1000))
  const replies = await Promise.all([1, 2].map((i) => tool('remember', note(`both ${i} ${nonce()}`, { artifacts: [{ name: 'x.bin', sha256: sha }] }))))
  for (const r of replies) assert.match(r.text, /^Remembered/, r.text)
  assert.equal(blobsOf(sha), 1)
  assert.equal(countOf('entry_blob', `sha256 = '${sha}'`), 2)
  assert.equal(named(sha), 1)
  assert.equal(named(`incoming/${sha}`), 0)
})

test('R20 storage: uploads nobody cites are swept after 7200 seconds, and one device can have at most 10 waiting', { skip: SKIP }, async () => {
  const x = sha256(`x${nonce()}`), y = sha256(`y${nonce()}`)
  memory.storage!.put(`incoming/${x}`, Buffer.from('old'), { createdAt: Date.now() - 7201_000 })
  memory.storage!.put(`incoming/${y}`, Buffer.from('new'), { createdAt: Date.now() - 60_000 })
  const swept = await bed.call('POST', '/blobs/sweep', bearer(memory.cronSecret), {})
  assert.equal(swept.status, 200, swept.text)
  assert.equal(named(`incoming/${x}`), 0)
  assert.equal(named(`incoming/${y}`), 1)
  assert.equal((await bed.call('POST', '/blobs/sweep', {}, {})).status, 401)
  assert.equal(Number(sql(`select count(*)::int as n from cron.job where jobname = 'memory-blob-sweep'`)[0].n), 1)
  const replies: Answer[] = []
  for (let i = 0; i < 11; i++) replies.push(await tool('upload_blob', { sha256: sha256(`w${i}${nonce()}`), size: 1000, media_type: 'text/plain' }))
  for (const r of replies.slice(0, 10)) assert.ok(r.text.includes('PUT the file within two hours'), r.text)
  assert.equal(replies[10].error, true)
  assert.ok(replies[10].text.includes('10 uploads waiting'), replies[10].text)
  const tokenB = `device-${randomBytes(8).toString('hex')}`
  sql(`insert into memory.device (name, token_sha256) values ('clyde-c', '${sha256(tokenB)}') on conflict do nothing`)
  const other = await (await bed.mcp(tokenB)).tool('upload_blob', { sha256: sha256(`n${nonce()}`), size: 1000, media_type: 'text/plain' })
  assert.ok(other.text.includes('PUT the file within two hours'), other.text)
})

test('R20 storage: each of the 8 kinds is stored as given and shown by get_entry', { skip: SKIP }, async () => {
  const kinds = ['image', 'video', 'audio', 'document', 'skill', 'artifact', 'data', 'other']
  const r = await tool('remember', note(`kinds ${nonce()}`, { artifacts: kinds.map((kind, i) => ({ name: `${kind}.txt`, kind, text: `${kind} number ${i}`.padEnd(10, '.') })) }))
  assert.equal(r.error, false, r.text)
  const id = idOf(r.text)
  assert.deepEqual(sql(`select array_agg(kind order by kind) as k from memory.entry_blob where entry_id = '${id}'`)[0].k,
    ['artifact', 'audio', 'data', 'document', 'image', 'other', 'skill', 'video'])
  const entry = (await tool('get_entry', { id })).text
  const lines = entry.split('\n').filter((l) => l.startsWith('- ') && l.includes('.txt:'))
  assert.equal(lines.length, 8)
  for (const kind of kinds) assert.ok(lines.some((l) => l.includes(`· ${kind} · `)), kind)
})

test('R20 storage: a 300 KB markdown skill sent inline lands in Storage with kind skill, and get_blob pages its text', { skip: SKIP }, async () => {
  const text = words(307_200)
  const r = await tool('remember', note(`skill ${nonce()}`, { artifacts: [{ name: 'SKILL.md', media_type: 'text/markdown', text }] }))
  assert.equal(r.error, false, r.text)
  const sha = shaIn(r.text)
  assert.deepEqual(sql(`select b.stored, b.content is null as gone, x.kind from memory.blob b join memory.entry_blob x using (sha256) where sha256 = '${sha}'`)[0],
    { stored: 'storage', gone: true, kind: 'skill' })
  const first = (await tool('get_blob', { sha256: sha, offset: 0, limit: 20000 })).text
  assert.ok(first.startsWith(`Blob ${sha}: text/markdown, characters 0 to 20000 of 307200.`), first.slice(0, 120))
  assert.ok(first.includes(`Next page: get_blob("${sha}", offset=20000)`))
  let joined = ''
  for (const offset of [0, 100000, 200000, 300000]) {
    const page = (await tool('get_blob', { sha256: sha, offset, limit: 100000 })).text
    joined += page.slice(page.indexOf('\n\n') + 2)
    if (offset < 300000) assert.ok(page.includes('Next page'))
  }
  assert.equal(joined.length, 307_200)
  assert.equal(joined, text)
})

test('R20 storage: text up to 262144 bytes stays in Postgres, longer text and any binary go to Storage', { skip: SKIP }, async () => {
  const writes = () => memory.storage!.count('/object/memory-blobs/', ['POST', 'PUT'])
  const before = writes()
  const small = 'x'.repeat(262_144), big = 'y'.repeat(262_145), bin = randomBytes(1024)
  const a = await tool('remember', note(`inline a ${nonce()}`, { artifacts: [{ name: 'a.txt', text: small }] }))
  assert.equal(writes(), before)
  const b = await tool('remember', note(`inline b ${nonce()}`, { artifacts: [{ name: 'b.txt', text: big }] }))
  const c = await tool('remember', note(`inline c ${nonce()}`, { artifacts: [{ name: 'c.bin', base64: bin.toString('base64') }] }))
  for (const r of [a, b, c]) assert.equal(r.error, false, r.text)
  const row = (sha: string) => sql(`select stored, content is null as gone, octet_length(content) as n from memory.blob where sha256 = '${sha}'`)[0]
  assert.deepEqual(row(shaIn(a.text)), { stored: 'db', gone: false, n: 262_144 })
  assert.deepEqual(row(shaIn(b.text)), { stored: 'storage', gone: true, n: null })
  assert.deepEqual(row(shaIn(c.text)), { stored: 'storage', gone: true, n: null })
  assert.equal(writes() - before, 2)
})

test('R20 storage: an uploaded text file with a secret is refused and removed from Storage', { skip: SKIP }, async () => {
  const key = 'sk-proj-' + 'abcdefghijklmnopqrstuvwx'
  const bytes = Buffer.from(`api_key = ${key}\n` + words(1900))
  const { sha } = await upload(tool, bytes, 'text/plain')
  const r = await tool('remember', note(`secret ${nonce()}`, { artifacts: [{ name: 'notes.txt', sha256: sha }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('has secrets or identifiers in it'), r.text)
  assert.equal(blobsOf(sha), 0)
  assert.equal(named(sha, `incoming/${sha}`), 0)
  assert.equal(memory.openai.calls.filter((c) => JSON.stringify(c.body).includes(key)).length, 0)
})

test('R20 storage: a long inline text blob with a key lands in Storage redacted', { skip: SKIP }, async () => {
  const key = 'sk-proj-' + randomBytes(20).toString('hex')
  const text = words(150_000) + ` key ${key} ` + words(150_000, 'dolor sit amet lorem')
  const r = await tool('remember', note(`redacted ${nonce()}`, { artifacts: [{ name: 'long.txt', text }] }))
  assert.equal(r.error, false, r.text)
  const sha = shaIn(r.text)
  const stored = memory.storage!.objects.get(sha)!.bytes
  const body = stored.toString('utf8')
  assert.equal(body.split('[redacted:api-key]').length - 1, 1)
  assert.equal(body.split(key).length - 1, 0)
  assert.equal(sha256(stored), sha)
})

test('R20 storage: the judge reads a cited text upload, and a refusal removes it from Storage', { skip: SKIP }, async () => {
  const text = (FAKE_REFUSE + ' ' + words(4100)).slice(0, 5000)
  const { sha } = await upload(tool, Buffer.from(text), 'text/plain')
  const from = memory.openai.calls.length
  const r = await tool('remember', note(`judged ${nonce()}`, { artifacts: [{ name: 'notes.txt', sha256: sha }] }))
  assert.equal(r.error, true)
  const asked = memory.openai.calls.slice(from).filter((c) => c.path === '/decisions').map((c) => String(c.body.input))
  assert.ok(asked.some((input) => input.includes(text.slice(0, 4000))))
  assert.equal(blobsOf(sha), 0)
  assert.equal(named(sha, `incoming/${sha}`), 0)
})

test('R20 storage: a private or confidential entry\'s blob text never reaches the judge', { skip: SKIP }, async () => {
  const m1 = marker(), m2 = marker()
  const { sha } = await upload(tool, Buffer.from(`${m1} ${words(1960)}`), 'text/plain')
  const priv = await tool('remember', note(`private ${nonce()}`, { sensitivity: 'private', artifacts: [{ name: 'p.txt', sha256: sha }] }))
  assert.match(priv.text, /^Remembered/, priv.text)
  const conf = await tool('remember', note(`conf ${nonce()}`, { sensitivity: 'confidential', artifacts: [{ name: 'c.txt', text: `${m2} ${words(960)}` }] }))
  assert.match(conf.text, /^Remembered/, conf.text)
  const sentAll = JSON.stringify(memory.openai.calls)
  assert.equal(sentAll.split(m1).length - 1, 0)
  assert.equal(sentAll.split(m2).length - 1, 0)
})

test('R20 storage: a private entry\'s Storage blob gets no signed link', { skip: SKIP }, async () => {
  const pBytes = randomBytes(1000), qBytes = randomBytes(1000)
  await tool('remember', note(`p ${nonce()}`, { sensitivity: 'private', artifacts: [{ name: 'p.bin', base64: pBytes.toString('base64') }] }))
  await tool('remember', note(`q ${nonce()}`, { artifacts: [{ name: 'q.png', media_type: 'image/png', base64: qBytes.toString('base64') }] }))
  const p = sha256(pBytes), q = sha256(qBytes)
  const before = signs()
  const g = await tool('get_blob', { sha256: p })
  assert.equal(g.text, PRIVATE_BLOB)
  assert.ok(!g.text.includes('/object/sign/'))
  assert.equal(signs(), before)
  assert.equal((await bed.call('GET', `/blobs/${p}`, bearer(memory.token))).status, 403)
  const open = await bed.call('GET', `/blobs/${q}`, bearer(memory.token))
  assert.equal(open.status, 302)
  assert.ok(String(open.headers.location).includes(`/storage/v1/object/sign/memory-blobs/${q}`), String(open.headers.location))
})

test('R20 storage: media links are signed for 600 seconds', { skip: SKIP }, async () => {
  const bytes = randomBytes(1000), q = sha256(bytes), from = memory.storage!.requests.length
  await tool('remember', note(`sign ${nonce()}`, { artifacts: [{ name: 'q.png', media_type: 'image/png', base64: bytes.toString('base64') }] }))
  const g = await tool('get_blob', { sha256: q })
  assert.ok(g.text.includes('Download it within 10 minutes: '))
  assert.equal((await bed.call('GET', `/blobs/${q}`, bearer(memory.token))).status, 302)
  const signed = memory.storage!.requests.slice(from).filter((r) => r.method === 'POST' && r.path.includes('/object/sign/'))
  assert.equal(signed.length, 2)
  for (const r of signed) assert.equal(JSON.parse(r.body.toString('utf8')).expiresIn, 600)
})

test('R20 storage: a malformed sha256 never reaches Storage', { skip: SKIP }, async () => {
  const before = memory.storage!.requests.length
  for (const sha of ['../../incoming/x', 'a'.repeat(63)]) {
    const r = await tool('upload_blob', { sha256: sha, size: 1000, media_type: 'image/png' })
    assert.equal(r.error, true)
    assert.ok(r.text.includes('sha256 must be 64 hex digits.'), r.text)
  }
  const t = `bad sha ${nonce()}`
  const c = await tool('remember', note(t, { artifacts: [{ name: 'z.bin', sha256: 'ZZ' + 'a'.repeat(62) }] }))
  assert.equal(c.error, true)
  assert.ok(c.text.includes("has a sha256 that isn't 64 hex digits"), c.text)
  assert.equal(memory.storage!.requests.length, before)
})

test('R20 storage: upload_blob needs a token', { skip: SKIP }, async () => {
  const before = signs()
  const r = await bed.call('POST', '/mcp', {}, {
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'upload_blob', arguments: { sha256: sha256('x'), size: 1000, media_type: 'image/png' } },
  })
  assert.equal(r.status, 401)
  assert.equal(signs(), before)
})

test('R20 storage: /mcp refuses a body over 12582912 bytes with 413', { skip: SKIP }, async () => {
  const base = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'remember', arguments: { ...note(`big ${nonce()}`), pad: '' } } }
  const body = (total: number) => {
    const empty = Buffer.byteLength(JSON.stringify(base))
    return JSON.stringify({ ...base, params: { ...base.params, arguments: { ...base.params.arguments, pad: 'x'.repeat(total - empty) } } })
  }
  const entries = countOf('entry', 'true'), blobs = countOf('blob', 'true')
  const over = body(12_582_913)
  assert.equal(Buffer.byteLength(over), 12_582_913)
  const refused = await bed.call('POST', '/mcp', bearer(memory.token), over)
  assert.equal(refused.status, 413)
  assert.equal(countOf('entry', 'true'), entries)
  assert.equal(countOf('blob', 'true'), blobs)
  const exact = body(12_582_912)
  assert.equal(Buffer.byteLength(exact), 12_582_912)
  assert.notEqual((await bed.call('POST', '/mcp', bearer(memory.token), exact)).status, 413)
})

test('R20 storage: with Storage down, a binary blob writes nothing while small text still lands', { skip: SKIP }, async () => {
  memory.storage!.mode = { status: 503 }
  const bytes = randomBytes(1024), t = `down ${nonce()}`, before = memory.storage!.requests.length
  const r = await tool('remember', note(t, { artifacts: [{ name: 'd.bin', base64: bytes.toString('base64') }] }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('Storage refused blob'), r.text)
  assert.ok(memory.storage!.requests.length > before)
  assert.equal(entriesTitled(t), 0)
  assert.equal(blobsOf(sha256(bytes)), 0)
  const ok = await tool('remember', note(`down text ${nonce()}`, { artifacts: [{ name: 't.txt', text: 'still lands in postgres' }] }))
  assert.match(ok.text, /^Remembered/, ok.text)
  const got = await tool('get_blob', { sha256: shaIn(ok.text) })
  assert.ok(got.text.endsWith('still lands in postgres'), got.text)
})

test('R20 storage: a Storage that never answers fails the write within the timeout', { skip: SKIP }, async () => {
  memory.storage!.mode = { hang: true }
  const t = `hang ${nonce()}`, started = Date.now()
  const r = await tool('remember', note(t, { artifacts: [{ name: 'h.bin', base64: randomBytes(1024).toString('base64') }] }))
  assert.equal(r.error, true)
  assert.ok(Date.now() - started < 5000, `${Date.now() - started} ms`)
  assert.equal(entriesTitled(t), 0)
})

test('R20 storage: a second note citing the same file reuses it, and a resend writes nothing new', { skip: SKIP }, async () => {
  const { sha } = await upload(tool, randomBytes(1000))
  const one = note(`first ${nonce()}`, { artifacts: [{ name: 'x.bin', sha256: sha }] })
  const first = await tool('remember', one)
  assert.match(first.text, /^Remembered/, first.text)
  const writes = () => memory.storage!.requests.filter((r) => r.path.includes(sha) && r.method !== 'GET').length
  const before = writes()
  const second = await tool('remember', note(`second ${nonce()}`, { artifacts: [{ name: 'x.bin', sha256: sha }] }))
  assert.match(second.text, /^Remembered/, second.text)
  const resend = await tool('remember', one)
  assert.equal(idOf(resend.text), idOf(first.text))
  assert.equal(blobsOf(sha), 1)
  assert.equal(countOf('entry_blob', `sha256 = '${sha}'`), 2)
  assert.equal(writes(), before)
})

test('R20 storage: /entries with a Storage blob past the write deadline ends with one entry and one object', { skip: SKIP }, async () => {
  // The issue's bed delays each write 2000 ms with a 2000 ms timeout. A 1600 ms delay is past the 1500 ms deadline and inside the timeout.
  memory.storage!.mode = { writeDelayMs: 1600 }
  const source = { kind: 'run', title: 'clyde run r55', uri: 'clyde://runs/r55' }
  const runtime = bearer(memory.runtimeToken)
  const project = { id: 'run-r55', pattern: 'projects', title: 'Run r55', body: 'The r55 run.', authority: 'observed', scope: 'run:r55', evidence_kind: 'summary', evidence: 'Tier 3 made it.', source }
  assert.equal((await bed.call('POST', '/entries', runtime, project)).status, 200)
  const bytes = randomBytes(4_194_305), title = `late ${nonce()}`, sha = sha256(bytes)
  const entry = { pattern: 'observations', title, body: 'A body.', authority: 'observed', scope: 'run:r55', evidence_kind: 'summary', evidence: 'Tier 3 made it.', project: 'run-r55', source, artifacts: [{ name: 'big.bin', base64: bytes.toString('base64') }] }
  const started = Date.now()
  const late = await bed.call('POST', '/entries', runtime, entry)
  assert.equal(late.status, 503, late.text)
  await new Promise((r) => setTimeout(r, Math.max(0, 5000 - (Date.now() - started))))
  const again = await bed.call('POST', '/entries', runtime, entry)
  assert.equal(again.status, 200, again.text)
  assert.equal(entriesTitled(title), 1)
  assert.equal(blobsOf(sha), 1)
  assert.equal(named(sha), 1)
  assert.equal(JSON.parse(again.text).id, sql(`select id from memory.entry where title = '${title}'`)[0].id)
})

test('R20 storage: recall, get_entry and blobless writes make no Storage requests', { skip: SKIP }, async () => {
  const made = await tool('remember', note(`has blob ${nonce()}`, { artifacts: [{ name: 'e.bin', base64: randomBytes(500).toString('base64') }] }))
  const id = idOf(made.text), before = memory.storage!.requests.length
  assert.match((await tool('remember', note(`no blob ${nonce()}`))).text, /^Remembered/)
  assert.match((await tool('recall', { query: 'oolong temperature' })).text, /retrieval/)
  assert.match((await tool('get_entry', { id })).text, /e\.bin/)
  assert.equal(memory.storage!.requests.length, before)
})

test('R20 storage: one entry\'s new blobs are capped at 1073741824 bytes before any upload is read', { skip: SKIP }, async () => {
  const shas = Array.from({ length: 16 }, (_, i) => sha256(`cap ${i} ${nonce()}`))
  sql(`insert into memory.upload (sha256, principal, size, media_type) values ${shas.map((s) => `('${s}', 'clyde-test', 524288000, 'video/mp4')`).join(', ')}`)
  const before = memory.storage!.requests.length
  const r = await tool('remember', note(`cap ${nonce()}`, { artifacts: shas.map((sha256, i) => ({ name: `v${i}.mp4`, sha256 })) }))
  assert.equal(r.error, true)
  assert.ok(r.text.includes('These blobs add up to 8388608000 bytes. The limit for one entry is 1073741824.'), r.text)
  assert.equal(memory.storage!.count('/object/memory-blobs/incoming/', ['GET'], before), 0)
})

test('R20 storage: blob bytes are never sent for embedding', { skip: SKIP }, async () => {
  const m = marker()
  const text = words(150_000) + ` ${m} ` + words(150_000)
  assert.match((await tool('remember', note(`embed ${nonce()}`, { artifacts: [{ name: 'SKILL.md', media_type: 'text/markdown', text }] }))).text, /^Remembered/)
  const from = memory.openai.calls.length
  assert.equal((await bed.call('POST', '/embeddings/sync', bearer(memory.cronSecret), {})).status, 202)
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline && !memory.openai.calls.slice(from).some((c) => c.path === '/embeddings')) await new Promise((r) => setTimeout(r, 200))
  const sent = memory.openai.calls.slice(from).filter((c) => c.path === '/embeddings')
  assert.ok(sent.length >= 1, 'the sync embedded the new entry')
  assert.equal(JSON.stringify(sent).split(m).length - 1, 0)
})

test('R20 storage: with 20,000 blobs the quota check runs in 50 ms or less', { skip: SKIP }, async () => {
  try {
    sql(`insert into memory.blob (sha256, media_type, size, content, stored)
      select encode(sha256(('q' || i)::bytea), 'hex'), 'application/octet-stream', 1000, null, 'storage' from generate_series(1, 20000) i`)
    const plan = sql(`explain (analyze, format json) select coalesce(sum(size), 0) from memory.blob`)[0]['QUERY PLAN'][0]
    assert.ok(plan['Execution Time'] <= 50, `${plan['Execution Time']} ms`)
    const started = Date.now()
    const r = await tool('upload_blob', { sha256: sha256(`speed ${nonce()}`), size: 1000, media_type: 'text/plain' })
    assert.ok(r.text.includes('PUT the file within two hours'), r.text)
    assert.ok(Date.now() - started <= 1000, `${Date.now() - started} ms`)
  } finally {
    sql(`delete from memory.blob where sha256 in (select encode(sha256(('q' || i)::bytea), 'hex') from generate_series(1, 20000) i)`)
  }
})
