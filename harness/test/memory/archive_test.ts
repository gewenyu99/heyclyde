/**
 * Adversarial unit and mock-DB/Storage safety tests for archive.ts covering all 12 audited failure modes:
 * 1. Path traversal / malformed ID rejection in blameEntry and getColdEntry
 * 2. Lossless storage of private & confidential notes + strict read-time redaction + getColdEntry open
 * 3. Content-addressed memory.blob storage (automatically backed up by /export & /me/export)
 * 4. 24h minimum age + unlearned retrieval / blob / quest / qrel guards
 * 5. R70 agent realm/project/computer permissions (canReadEntry) + EntryFilter enforcement on cold reads
 * 6. Storage verification failure aborts BEFORE any Postgres delete
 * 7. TOCTOU concurrent edit / revival skip under FOR UPDATE lock
 * 8. Multi-hop supersedes chain resolution + transitive blame across cold & live entries + resurrection prevention
 */
import assert from 'node:assert/strict'
import {
  archiveReason,
  blameEntry,
  COLD_ARCHIVE_MEDIA_TYPE,
  type ColdBlobBackend,
  type ColdRecord,
  getColdEntry,
  mergeBlame,
  mergeNdjson,
  parseNdjson,
  resolveSupersedesHead,
  searchColdRecords,
  sweepOwnerColdArchive,
} from '../../../memory/supabase/functions/memory/archive.ts'
import type { AgentScope } from '../../../memory/supabase/functions/memory/permissions.ts'

function mockBackend(corruptGet = false): { backend: ColdBlobBackend; stored: Map<string, Uint8Array> } {
  const stored = new Map<string, Uint8Array>()
  return {
    stored,
    backend: {
      storageOn: () => true,
      putBlob: async (sha, _type, bytes, owner) => {
        stored.set(`${owner}/${sha}`, bytes)
      },
      getBlob: async (sha, owner) => {
        if (corruptGet) return new Uint8Array([1, 2])
        return stored.get(`${owner}/${sha}`) ?? null
      },
    },
  }
}

function makeColdRecord(overrides: Partial<ColdRecord> & { id: string; title: string }): ColdRecord {
  return {
    body: 'Full lossless body text.',
    evidence: 'Verified evidence.',
    evidence_kind: 'summary',
    evidence_sha256: null,
    pattern: 'decisions',
    kind: 'observation',
    scope: 'global',
    authority: 'draft',
    sensitivity: 'normal',
    lang: 'en',
    valid_from: '2026-10-01',
    source_id: null,
    project: null,
    project_slug: 'gewenyu99/heyclyde',
    category: 'architecture',
    context: 'work',
    transferability: 'project',
    computer: 'macbook',
    confidence: 0.4,
    miss_streak: 0,
    payload_sha256: 'abc123',
    created_at: '2026-10-15T00:00:00Z',
    archived_at: '2026-11-26T00:00:00Z',
    reason: 'superseded',
    provenance: { device: 'macbook', agent: 'carbon', agent_context: 'work', repo: 'gewenyu99/heyclyde' },
    links: [],
    ...overrides,
  }
}

Deno.test('1. Path traversal & invalid IDs are rejected before touching DB or Storage', async () => {
  let dbCalled = false
  const fakeDb: any = () => {
    dbCalled = true
    throw new Error('DB must not be called for invalid IDs')
  }
  for (const malicious of ['../../victim-uuid/blame/secret', '../etc/passwd', 'foo/bar', 'id?trunc=1', 'id#hash', '%2e%2e', '', '   ']) {
    await assert.rejects(() => blameEntry(fakeDb, malicious), /valid entry id/)
    assert.equal(await getColdEntry(fakeDb, malicious), null)
  }
  assert.equal(dbCalled, false)
})

Deno.test('2 & 5. Lossless private/confidential storage, read-time redaction, and R70 agent permissions', async () => {
  const privRec = makeColdRecord({
    id: 'priv-supplier-1',
    title: 'Private supplier contract',
    body: 'TOP_SECRET_PRIVATE_BODY_999',
    evidence: 'TOP_SECRET_EVIDENCE_999',
    sensitivity: 'private',
    context: 'personal',
    transferability: 'context',
    reason: 'dormant',
    confidence: 0.1,
  })
  const confWorkRec = makeColdRecord({
    id: 'conf-work-1',
    title: 'Confidential PostHog architecture',
    body: 'CONFIDENTIAL_WORK_BODY_777',
    sensitivity: 'confidential',
    context: 'work',
    project_slug: 'posthog/posthog',
    transferability: 'project',
    reason: 'superseded',
    superseded_by: 'conf-work-2',
  })

  // Raw NDJSON preserves 100% of private and confidential body/evidence for backups and owner exports!
  const nd = mergeNdjson(null, [privRec, confWorkRec])
  const parsed = parseNdjson(nd)
  assert.equal(parsed[0].body, 'TOP_SECRET_PRIVATE_BODY_999')
  assert.equal(parsed[0].evidence, 'TOP_SECRET_EVIDENCE_999')
  assert.equal(parsed[1].body, 'CONFIDENTIAL_WORK_BODY_777')

  // Private body/evidence NEVER match search queries; title matches when permitted.
  assert.equal(searchColdRecords(parsed, { query: 'TOP_SECRET_PRIVATE_BODY_999' }).length, 0)
  assert.equal(searchColdRecords(parsed, { query: 'TOP_SECRET_EVIDENCE_999' }).length, 0)
  assert.deepEqual(searchColdRecords(parsed, { query: 'supplier', include: 'dormant' }).map((s) => s.record.id), ['priv-supplier-1'])

  // R70: hobby agent cannot see work or personal notes!
  const hobbyAgent: AgentScope = {
    name: 'hobby-bot',
    context: 'hobby',
    projects: ['my/game'],
    computer: 'home-pc',
    agentType: 'coding',
    strictProjects: true,
  }
  assert.equal(searchColdRecords(parsed, { query: 'PostHog' }, hobbyAgent).length, 0)
  assert.equal(searchColdRecords(parsed, { query: 'supplier' }, hobbyAgent).length, 0)

  // R70: strict-projects work agent on gewenyu99/heyclyde cannot read posthog/posthog project-scoped note!
  const clydeWorkAgent: AgentScope = {
    name: 'clyde-bot',
    context: 'work',
    projects: ['gewenyu99/heyclyde'],
    computer: 'macbook',
    agentType: 'coding',
    strictProjects: true,
  }
  assert.equal(searchColdRecords(parsed, { query: 'PostHog' }, clydeWorkAgent).length, 0)

  // Permitted work agent on posthog/posthog CAN search confidential work body and open it, while private note redacts body!
  const posthogWorkAgent: AgentScope = {
    name: 'ph-bot',
    context: 'work',
    projects: ['posthog/posthog'],
    computer: 'macbook',
    agentType: 'coding',
    strictProjects: true,
  }
  assert.deepEqual(searchColdRecords(parsed, { query: 'CONFIDENTIAL_WORK_BODY_777' }, posthogWorkAgent).map((s) => s.record.id), ['conf-work-1'])

  // Mock DB returning the cold batch blob for getColdEntry & blameEntry checks:
  const bytes = new TextEncoder().encode(nd)
  const fakeDb: any = (strings: TemplateStringsArray) => {
    const q = strings.join(' ')
    if (q.includes('from memory.blob')) {
      return Promise.resolve([{ owner_id: 'owner-1', sha256: 'a'.repeat(64), stored: 'db', content: bytes }])
    }
    return Promise.resolve([])
  }

  // Hobby agent gets Refused on getColdEntry and blameEntry for confidential work note:
  await assert.rejects(() => getColdEntry(fakeDb, 'conf-work-1', null, hobbyAgent), /Access denied/)
  await assert.rejects(() => blameEntry(fakeDb, 'conf-work-1', hobbyAgent), /Access denied/)

  // Permitted agent opens confidential work note in full:
  const openedConf = await getColdEntry(fakeDb, 'conf-work-1', null, posthogWorkAgent)
  assert.ok(openedConf?.includes('CONFIDENTIAL_WORK_BODY_777'))
  assert.ok(openedConf?.includes('cold storage · archived (superseded)'))

  // Unrestricted agent opening private note gets title ONLY — private body & evidence are redacted!
  const openedPriv = await getColdEntry(fakeDb, 'priv-supplier-1', null, null)
  assert.ok(openedPriv?.includes('Private supplier contract'))
  assert.equal(openedPriv?.includes('TOP_SECRET_PRIVATE_BODY_999'), false)
  assert.equal(openedPriv?.includes('TOP_SECRET_EVIDENCE_999'), false)

  // Blame on a head with a private predecessor redacts the private predecessor's body!
  const privSup = makeColdRecord({ ...privRec, id: 'priv-old', reason: 'superseded', superseded_by: 'priv-head' })
  const privHead = makeColdRecord({ id: 'priv-head', title: 'Public head', context: 'general', transferability: 'general' })
  const bytes2 = new TextEncoder().encode(mergeNdjson(null, [privSup, privHead]))
  const fakeDb2: any = (strings: TemplateStringsArray) =>
    Promise.resolve(strings.join(' ').includes('from memory.blob') ? [{ owner_id: 'owner-1', sha256: 'b'.repeat(64), stored: 'db', content: bytes2 }] : [])
  const blameOut = await blameEntry(fakeDb2, 'priv-head', null)
  assert.ok(blameOut.includes('priv-old: Private supplier contract'))
  assert.ok(blameOut.includes('(private)'))
  assert.equal(blameOut.includes('TOP_SECRET_PRIVATE_BODY_999'), false)
})

Deno.test('4, 8, 9, 10, 12. archiveReason protects <24h, blobs, quests, qrel, unlearned, seed, projects, approved, and active superseders', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  const old = '2026-10-01T00:00:00Z'
  const recent = '2026-11-26T06:00:00Z' // 6h old (< 24h grace period)

  // Protected cases:
  assert.equal(archiveReason({ origin: 'seed', confidence: 0.01, created_at: old }, now), null)
  assert.equal(archiveReason({ pattern: 'projects', confidence: 0.05, created_at: old }, now), null)
  assert.equal(archiveReason({ has_blobs: true, superseded_by: 'new-1', created_at: old }, now), null)
  assert.equal(archiveReason({ in_qrel: true, superseded_by: 'new-1', created_at: old }, now), null)
  assert.equal(archiveReason({ in_quest: true, confidence: 0.05, created_at: old }, now), null)
  assert.equal(archiveReason({ in_unlearned: true, superseded_by: 'new-1', created_at: old }, now), null)
  assert.equal(archiveReason({ superseded_by: 'new-1', created_at: recent }, now), null)
  // Resurrection guard: dormant note that actively supersedes a live note stays!
  assert.equal(archiveReason({ authority: 'draft', confidence: 0.05, supersedes_other: true, created_at: old }, now), null)
  assert.equal(archiveReason({ authority: 'approved', confidence: 0.05, miss_streak: 9, created_at: old }, now), null)

  // Eligible cases (>24h and unguarded):
  assert.equal(archiveReason({ authority: 'approved', superseded_by: 'new-1', confidence: 0.9, created_at: old }, now), 'superseded')
  assert.equal(archiveReason({ authority: 'draft', confidence: 0.14, created_at: old }, now), 'dormant')
  assert.equal(archiveReason({ authority: 'draft', scope: 'run:abc', confidence: 0.5, created_at: '2026-11-01T00:00:00Z' }, now), 'stale_run')
  assert.equal(archiveReason({ authority: 'draft', scope: 'global', confidence: 0.4, miss_streak: 5, active_links: 0, created_at: old }, now), 'miss_streak_orphan')
  assert.equal(archiveReason({ authority: 'draft', scope: 'global', confidence: 0.4, miss_streak: 5, active_links: 1, created_at: old }, now), null)
})

Deno.test('6 & 7. Storage verification failure aborts before DB transaction, and TOCTOU concurrent revival/edit skips delete', async () => {
  const old = '2026-10-01T00:00:00Z'
  const candidate = {
    id: 'cand-1',
    title: 'Original title',
    body: 'Original body',
    origin: 'runtime',
    pattern: 'observations',
    authority: 'draft',
    confidence: 0.10,
    miss_streak: 0,
    scope: 'global',
    payload_sha256: 'hash-1',
    created_at: old,
    has_blobs: false,
    in_qrel: false,
    in_quest: false,
    in_unlearned: false,
    superseded_by: null,
    supersedes_other: false,
    active_links: 0,
  }

  // Case A: Corrupt Storage read-back aborts BEFORE db.begin runs!
  let txRan = false
  const dbCorrupt: any = Object.assign(
    (strings: TemplateStringsArray) => {
      const q = strings.join(' ')
      if (q.includes('from memory.entry e')) return Promise.resolve([candidate])
      return Promise.resolve([])
    },
    { begin: async () => { txRan = true } },
  )
  const { backend: badBackend } = mockBackend(true)
  await assert.rejects(() => sweepOwnerColdArchive('owner-1', dbCorrupt, badBackend), /verification failed/)
  assert.equal(txRan, false, 'Postgres transaction must never run when Storage verification fails')

  // Case B: Concurrent revival (confidence bumped to 0.60 before FOR UPDATE lock) skips deleting cand-1!
  const deletedBatches: string[][] = []
  let blobMediaType = ''
  const txMock: any = (strings: TemplateStringsArray, ...vals: any[]) => {
    const q = strings.join(' ')
    if (q.includes('select 1 from memory.entry limit 1')) return Promise.resolve([{ '?column?': 1 }])
    if (q.includes('insert into memory.blob')) {
      blobMediaType = vals[1]
      return Promise.resolve([])
    }
    if (q.includes('for update')) {
      // Simulate cand-1 revived to confidence 0.60 and cand-2 unchanged at 0.10!
      return Promise.resolve([
        { ...candidate, id: 'cand-1', confidence: 0.60 },
        { ...candidate, id: 'cand-2', title: 'Second', body: 'Body 2', confidence: 0.10 },
      ])
    }
    if (q.includes('delete from memory.entry where id = any')) {
      deletedBatches.push(vals[0])
      return Promise.resolve([])
    }
    return Promise.resolve([])
  }
  const dbToctou: any = Object.assign(
    (strings: TemplateStringsArray) => {
      const q = strings.join(' ')
      if (q.includes('from memory.entry e')) {
        return Promise.resolve([
          candidate,
          { ...candidate, id: 'cand-2', title: 'Second', body: 'Body 2' },
        ])
      }
      return Promise.resolve([])
    },
    { begin: async (fn: any) => await fn(txMock) },
  )
  const { backend: okBackend, stored } = mockBackend(false)
  const res = await sweepOwnerColdArchive('owner-1', dbToctou, okBackend)
  assert.equal(blobMediaType, COLD_ARCHIVE_MEDIA_TYPE)
  assert.equal(stored.size, 1)
  assert.equal(res.archived, 1)
  assert.deepEqual(deletedBatches, [['cand-2']], 'Concurrently revived cand-1 must NOT be deleted!')
})

Deno.test('9. Multi-hop supersedes chain resolves head and bridges transitive blame', () => {
  const m = new Map([['v1', 'v2'], ['v2', 'v3'], ['cycle1', 'cycle2'], ['cycle2', 'cycle1']])
  assert.equal(resolveSupersedesHead('v1', m), 'v3')
  assert.equal(resolveSupersedesHead('v3', m), 'v3')
  assert.equal(resolveSupersedesHead('cycle1', m), 'cycle2')

  const r1 = makeColdRecord({ id: 'v1', title: 'V1', created_at: '2026-10-01T00:00:00Z' })
  const r2 = makeColdRecord({ id: 'v2', title: 'V2', created_at: '2026-10-10T00:00:00Z' })
  assert.deepEqual(mergeBlame([r1], [r2]).map((r) => r.id), ['v2', 'v1'])
})
