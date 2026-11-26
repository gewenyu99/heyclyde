/**
 * Tier 3 real-Postgres & Storage integration test for cold-storage sweep, blame, get_entry fallback,
 * R70 permissions, private redaction, resurrection prevention, and /export backup coverage.
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
const COLD_ARCHIVE_MEDIA_TYPE = 'application/x-clyde-cold-archive'
import { bearer, bedFor, nonce, note, sha256, upload } from './bed.ts'
import { SKIP, sql, startStorageBed, type RealMemory } from './server.ts'

const BACKUP = `backup-cold-${randomBytes(6).toString('hex')}`
let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startStorageBed()
  sql(`insert into memory.setting (name, value) values ('backup_token_sha256', '${sha256(BACKUP)}')
    on conflict (name) do update set value = excluded.value`)
})

after(async () => {
  await memory?.close()
})

test('cold archive end-to-end: sweep, multi-hop blame, get_entry fallback, private redaction, blob/quest/recent guards, and /export backup', { skip: SKIP }, async () => {
  const mcp = await bedFor(memory).mcp()
  const tag = nonce()

  // 1. Multi-hop supersedes chain: v1 -> v2 -> v3
  const r1 = await mcp.tool('remember', note(`Cold chain v1 ${tag}`, { body: `First version body ${tag}`, category: 'architecture', context: 'work', transferability: 'project', project_slug: 'gewenyu99/heyclyde' }))
  const id1 = /^Remembered ([^\s.]+)\./m.exec(r1.text)![1]
  const r2 = await mcp.tool('remember', note(`Cold chain v2 ${tag}`, { body: `Second version body ${tag}`, supersedes: [id1], category: 'architecture', context: 'work', transferability: 'project', project_slug: 'gewenyu99/heyclyde' }))
  const id2 = /^Remembered ([^\s.]+)\./m.exec(r2.text)![1]
  const r3 = await mcp.tool('remember', note(`Cold chain v3 ${tag}`, { body: `Third active head ${tag}`, supersedes: [id2], category: 'architecture', context: 'work', transferability: 'project', project_slug: 'gewenyu99/heyclyde' }))
  const id3 = /^Remembered ([^\s.]+)\./m.exec(r3.text)![1]

  // 2. Private dormant entry (must retain full body in Storage backup while redacting on MCP reads!)
  const rPriv = await mcp.tool('remember', note(`Private dormant ${tag}`, { body: `SECRET_DORMANT_BODY_${tag}`, sensitivity: 'private', context: 'personal', transferability: 'context' }))
  const idPriv = /^Remembered ([^\s.]+)\./m.exec(rPriv.text)![1]

  // 3. Entry with attached Storage blob (must NEVER be deleted from memory.entry so get_blob stays readable!)
  const blobBytes = Buffer.from(`artifact-payload-${tag}`, 'utf8')
  const { sha: blobSha } = await upload(mcp.tool, blobBytes)
  const rBlobNote = await mcp.tool('remember', note(`Blob holder ${tag}`, { artifacts: [{ name: 'doc.txt', sha256: blobSha }] }))
  const idBlobNote = /^Remembered ([^\s.]+)\./m.exec(rBlobNote.text)![1]

  // 4. Recent (<24h) superseded entry (must stay in memory.entry during 24h grace window!)
  const rRecentOld = await mcp.tool('remember', note(`Recent old ${tag}`, { body: `Recent body ${tag}` }))
  const idRecentOld = /^Remembered ([^\s.]+)\./m.exec(rRecentOld.text)![1]
  await mcp.tool('remember', note(`Recent head ${tag}`, { body: `Recent head ${tag}`, supersedes: [idRecentOld] }))

  // Backdate id1, id2, idPriv, and idBlobNote > 48h, and mark idPriv & idBlobNote dormant (< 0.15).
  sql(`update memory.entry set created_at = now() - interval '3 days'
    where id in ('${id1}', '${id2}', '${id3}', '${idPriv}', '${idBlobNote}')`)
  sql(`update memory.entry set confidence = 0.08 where id in ('${idPriv}', '${idBlobNote}')`)

  // Run synchronous cold sweep via cron token:
  const sweepRes = await request('POST', `${memory.url}/blobs/sweep?sync=1`, { headers: bearer(memory.cronSecret), timeoutMs: 30_000 })
  assert.equal(sweepRes.status, 200, sweepRes.text)
  const sweepJson = JSON.parse(sweepRes.text)
  assert.ok(sweepJson.cold.archived >= 3, `expected >=3 archived rows, got ${sweepRes.text}`)

  // Verify id1, id2, idPriv left memory.entry, while id3, idBlobNote, and idRecentOld stayed!
  const remaining = sql(`select id from memory.entry where id in ('${id1}', '${id2}', '${id3}', '${idPriv}', '${idBlobNote}', '${idRecentOld}')`).map((r) => r.id)
  assert.equal(remaining.includes(id1), false, 'id1 should be archived out of memory.entry')
  assert.equal(remaining.includes(id2), false, 'id2 should be archived out of memory.entry')
  assert.equal(remaining.includes(idPriv), false, 'idPriv should be archived out of memory.entry')
  assert.equal(remaining.includes(id3), true, 'active head id3 must remain in memory.entry')
  assert.equal(remaining.includes(idBlobNote), true, 'blob-holding entry must remain in memory.entry')
  assert.equal(remaining.includes(idRecentOld), true, '<24h entry must remain in memory.entry')

  // Verify attached blob is still 100% readable through get_blob!
  const blobRead = await mcp.tool('get_blob', { sha256: blobSha })
  assert.match(blobRead.text, new RegExp(`artifact-payload-${tag}`))

  // Verify blame(id3) reconstructs BOTH collapsed cold ancestors id2 and id1!
  const blameOut = await mcp.tool('blame', { id: id3 })
  assert.match(blameOut.text, new RegExp(id2))
  assert.match(blameOut.text, new RegExp(id1))
  assert.match(blameOut.text, new RegExp(`Second version body ${tag}`))
  assert.match(blameOut.text, new RegExp(`First version body ${tag}`))

  // Verify get_entry(id1) opens cold-archived note in full!
  const open1 = await mcp.tool('get_entry', { id: id1 })
  assert.match(open1.text, /cold storage · archived \(superseded\)/)
  assert.match(open1.text, new RegExp(`First version body ${tag}`))

  // Verify get_entry(idPriv) redacts private body!
  const openPriv = await mcp.tool('get_entry', { id: idPriv })
  assert.match(openPriv.text, new RegExp(`Private dormant ${tag}`))
  assert.equal(openPriv.text.includes(`SECRET_DORMANT_BODY_${tag}`), false, 'private cold body must stay redacted on MCP get_entry')

  // Verify search_archive finds cold notes and redacts private body!
  const searchOut = await mcp.tool('search_archive', { query: `First version body ${tag}`, include: 'cold' })
  assert.match(searchOut.text, new RegExp(id1))
  const searchPrivBody = await mcp.tool('search_archive', { query: `SECRET_DORMANT_BODY_${tag}`, include: 'all' })
  assert.match(searchPrivBody.text, /No archive matches/)

  // Verify nightly GET /export?table=blob carries the lossless cold-archive blob (including private body for owner restore)!
  const exp = await request('GET', `${memory.url}/export?table=blob&offset=0`, { headers: bearer(BACKUP), timeoutMs: 30_000 })
  assert.equal(exp.status, 200, exp.text)
  const coldBlobs = exp.text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l).row)
    .filter((r) => r.media_type === COLD_ARCHIVE_MEDIA_TYPE && r.content?.base64)
  assert.ok(coldBlobs.length >= 1, 'nightly /export?table=blob must export cold-archive batch bytes')
  const allColdText = coldBlobs.map((b) => Buffer.from(b.content.base64, 'base64').toString('utf8')).join('\n')
  assert.ok(allColdText.includes(`SECRET_DORMANT_BODY_${tag}`), 'exported backup must preserve lossless private body')
})
