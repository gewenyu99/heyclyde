/**
 * Tier 3: R20 (#24), backups and restores of blobs. /export carries Storage blobs up to 4 MiB, a missing object doesn't fail it,
 * one export has a byte total, /import puts Storage blobs back, and the backup script finishes in few requests. Each test
 * starts its own memory, since a restore needs a fresh one, so there is no shared bed.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { request } from '../../src/request.ts'
import { bearer, bedFor, countOf, nonce, note, sha256, upload } from './bed.ts'
import { SKIP, sql, startRealMemory, startStorageBed, type RealMemory } from './server.ts'

const BACKUP = `backup-${randomBytes(6).toString('hex')}`

/** Every row of one table through /export with the backup token: the rows, and the headers of each page. */
async function exported(memory: RealMemory, table: string) {
  const rows: any[] = [], pages: Record<string, string | string[] | undefined>[] = []
  for (let offset = 0;;) {
    const r = await request('GET', `${memory.url}/export?table=${table}&offset=${offset}`, { headers: bearer(BACKUP), timeoutMs: 120_000 })
    assert.equal(r.status, 200, r.text)
    const n = Number(r.headers['x-rows'])
    pages.push(r.headers)
    rows.push(...r.text.split('\n').filter(Boolean).map((l) => JSON.parse(l).row))
    offset += n
    if (n === 0 || (n < (table === 'blob' ? 500 : 2000) && !r.headers['x-truncated'])) return { rows, pages }
  }
}

async function bedWithBackupToken(env: Record<string, string> = {}) {
  const memory = await startStorageBed(env)
  sql(`insert into memory.setting (name, value) values ('backup_token_sha256', '${sha256(BACKUP)}') on conflict (name) do update set value = excluded.value`)
  return memory
}

/** A blob of this many random bytes, sent with upload_blob and cited by a note. Returns its sha256. */
async function stored(memory: RealMemory, size: number) {
  const tool = (await bedFor(memory).mcp()).tool
  const bytes = randomBytes(size)
  const { sha } = await upload(tool, bytes)
  const r = await tool('remember', note(`export ${nonce()}`, { artifacts: [{ name: 'f.bin', sha256: sha }] }))
  assert.match(r.text, /^Remembered/, r.text)
  return { sha, bytes }
}

test('R20 storage: /export carries Storage blobs up to 4 MiB and leaves bigger ones out', { skip: SKIP }, async () => {
  const memory = await bedWithBackupToken()
  try {
    const small = await stored(memory, 4_194_304), big = await stored(memory, 4_194_305)
    const { rows } = await exported(memory, 'blob')
    const a = rows.find((r) => r.sha256 === small.sha), b = rows.find((r) => r.sha256 === big.sha)
    assert.equal(sha256(Buffer.from(a.content.base64, 'base64')), a.sha256)
    assert.equal(b.content, null)
  } finally {
    await memory.close()
  }
})

test('R20 storage: a missing Storage object doesn\'t fail the export', { skip: SKIP }, async () => {
  const memory = await bedWithBackupToken()
  try {
    const sha = sha256(`gone ${nonce()}`)
    sql(`insert into memory.blob (sha256, media_type, size, content, stored) values ('${sha}', 'application/octet-stream', 1000, null, 'storage')`)
    const { rows, pages } = await exported(memory, 'blob')
    assert.equal(rows.find((r) => r.sha256 === sha).content, null)
    const missing = pages.map((p) => Number(p['x-missing-blobs'] ?? 0))
    assert.equal(missing.filter((n) => n > 0).length, 1)
    assert.equal(missing.reduce((a, b) => a + b, 0), 1)
  } finally {
    await memory.close()
  }
})

test('R20 storage: one export carries at most MEMORY_EXPORT_STORED_TOTAL bytes of Storage blobs', { skip: SKIP }, async () => {
  const memory = await bedWithBackupToken({ MEMORY_EXPORT_STORED_TOTAL: '10485760' })
  try {
    const shas: string[] = []
    for (let i = 0; i < 3; i++) shas.push((await stored(memory, 4_194_304)).sha)
    const { rows, pages } = await exported(memory, 'blob')
    const inOrder = rows.filter((r) => shas.includes(r.sha256)).sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1))
    assert.deepEqual(inOrder.map((r) => r.content !== null), [true, true, false])
    assert.equal(pages.reduce((n, p) => n + Number(p['x-missing-blobs'] ?? 0), 0), 1)
  } finally {
    await memory.close()
  }
})

test('R20 storage: a restore puts exported Storage blobs back, and says which ones weren\'t in the backup', { skip: SKIP }, async () => {
  let ndjson = ''
  const first = await bedWithBackupToken()
  let small = '', big = ''
  try {
    const tool = (await bedFor(first).mcp()).tool
    const a = randomBytes(4_194_304), b = randomBytes(4_194_305)
    small = (await upload(tool, a)).sha
    big = (await upload(tool, b)).sha
    const r = await tool('remember', note(`restore ${nonce()}`, { artifacts: [{ name: 'a.bin', sha256: small }, { name: 'b.bin', sha256: big }] }))
    assert.match(r.text, /^Remembered/, r.text)
    for (const table of ['source', 'entry', 'link', 'blob', 'entry_blob']) {
      for (const row of (await exported(first, table)).rows) ndjson += JSON.stringify({ table, row }) + '\n'
    }
  } finally {
    await first.close()
  }
  const restore = async (memory: RealMemory) => {
    const r = await request('POST', `${memory.url}/api/v1/import`, { headers: { ...bearer(memory.adminToken), 'content-type': 'application/x-ndjson' }, body: ndjson, timeoutMs: 120_000 })
    assert.equal(r.status, 200, r.text)
    const tool = (await bedFor(memory).mcp()).tool
    assert.equal((await tool('get_blob', { sha256: big })).text, `Blob ${big} wasn't in the backup.`)
    assert.equal((await request('GET', `${memory.url}/blobs/${big}`, { headers: bearer(memory.token), timeoutMs: 30_000 })).status, 404)
  }
  const withStorage = await startStorageBed()
  try {
    await restore(withStorage)
    assert.deepEqual(sql(`select stored, content is null as gone from memory.blob where sha256 = '${small}'`)[0], { stored: 'storage', gone: true })
    assert.equal(sha256(withStorage.storage!.objects.get(small)!.bytes), small)
  } finally {
    await withStorage.close()
  }
  const without = await startRealMemory()
  try {
    await restore(without)
    assert.deepEqual(sql(`select stored, octet_length(content) as n from memory.blob where sha256 = '${small}'`)[0], { stored: 'db', n: 4_194_304 })
  } finally {
    await without.close()
  }
})

test('R20 storage: exporting 19,100 blob rows takes 100 requests or fewer', { skip: SKIP }, async () => {
  const memory = await bedWithBackupToken()
  const counted: string[] = []
  const target = new URL(memory.url)
  const proxy = http.createServer((req, res) => {
    if ((req.url ?? '').includes('table=blob')) counted.push(req.url!)
    const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers)
      r.pipe(res)
    })
    req.pipe(up)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  try {
    sql(`insert into memory.blob (sha256, media_type, size, content, stored)
      select encode(sha256(c), 'hex'), 'text/plain', octet_length(c), c, 'db'
      from (select convert_to(i::text || repeat('x', 996), 'UTF8') as c from generate_series(1, 19000) i) t`)
    const rows: string[] = []
    for (let i = 1; i <= 100; i++) {
      const bytes = Buffer.alloc(1_048_576, i)
      const sha = sha256(bytes)
      memory.storage!.put(sha, bytes)
      rows.push(`('${sha}', 'application/octet-stream', 1048576, null, 'storage')`)
    }
    sql(`insert into memory.blob (sha256, media_type, size, content, stored) values ${rows.join(', ')}`)
    const base = `http://127.0.0.1:${(proxy.address() as { port: number }).port}${target.pathname}`
    const started = Date.now()
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn('python3', [join(repoRoot(), 'memory', 'backup', 'export.py')], {
        env: { ...process.env, MEMORY_URL: base, MEMORY_BACKUP_TOKEN: BACKUP }, stdio: ['ignore', 'ignore', 'inherit'],
      })
      child.on('close', resolve)
    })
    assert.equal(code, 0, memory.log!().slice(-3000))
    assert.ok(counted.length <= 100, `${counted.length} requests`)
    assert.ok(Date.now() - started <= 120_000)
    assert.ok(countOf('blob', 'true') >= 19_100)
  } finally {
    proxy.closeAllConnections()
    proxy.close()
    await memory.close()
  }
})
