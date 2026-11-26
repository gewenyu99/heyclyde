/**
 * Tier 3 unit tests for cold-storage cleanup, superseded blame chains, and cold-shard search (no database or network).
 */
import assert from 'node:assert/strict'
import {
  archiveReason,
  type ColdRecord,
  type ColdStorageIO,
  mergeBlame,
  mergeNdjson,
  parseNdjson,
  resolveSupersedesHead,
  searchColdRecords,
  searchColdStorage,
} from '../../../memory/supabase/functions/memory/archive.ts'

function memoryStorage(): { io: ColdStorageIO; files: Map<string, string> } {
  const files = new Map<string, string>()
  return {
    files,
    io: {
      storageOn: () => true,
      getColdText: async (owner, rel) => files.get(`${owner}/${rel}`) ?? null,
      putColdText: async (owner, rel, text) => {
        files.set(`${owner}/${rel}`, text)
      },
    },
  }
}

Deno.test('archiveReason classifies superseded, dormant, stale run:*, and orphan miss_streak>=5 while protecting hubs and approved notes', () => {
  const now = Date.parse('2026-11-26T12:00:00Z')
  assert.equal(archiveReason({ origin: 'seed', confidence: 0.01 }, now), null)
  assert.equal(archiveReason({ pattern: 'projects', confidence: 0.05 }, now), null)
  assert.equal(archiveReason({ authority: 'approved', confidence: 0.10, miss_streak: 9 }, now), null)
  assert.equal(archiveReason({ authority: 'approved', superseded_by: 'new-1', confidence: 0.9 }, now), 'superseded')
  assert.equal(archiveReason({ authority: 'draft', confidence: 0.14 }, now), 'dormant')
  assert.equal(archiveReason({ authority: 'draft', scope: 'run:abc', confidence: 0.5, created_at: '2026-11-01T00:00:00Z' }, now), 'stale_run')
  assert.equal(archiveReason({ authority: 'draft', scope: 'run:abc', confidence: 0.5, created_at: '2026-11-20T00:00:00Z' }, now), null)
  assert.equal(archiveReason({ authority: 'draft', scope: 'global', confidence: 0.4, miss_streak: 5, active_links: 0 }, now), 'miss_streak_orphan')
  assert.equal(archiveReason({ authority: 'draft', scope: 'global', confidence: 0.4, miss_streak: 5, active_links: 2 }, now), null)
})

Deno.test('resolveSupersedesHead follows multi-hop chains and stops on cycles', () => {
  const m = new Map([['a', 'b'], ['b', 'c'], ['x', 'y'], ['y', 'x']])
  assert.equal(resolveSupersedesHead('a', m), 'c')
  assert.equal(resolveSupersedesHead('c', m), 'c')
  assert.equal(resolveSupersedesHead('x', m), 'y')
})

Deno.test('mergeNdjson, mergeBlame, and searchColdStorage handle shards, date bounds, and private redaction', async () => {
  const { io } = memoryStorage()
  const recs: ColdRecord[] = [
    {
      id: 'old-decision-1',
      title: 'Old OpenAI embedding budget',
      body: 'Used 38M tokens on OpenAI.',
      evidence: 'budget.ts',
      pattern: 'decisions',
      kind: 'observation',
      scope: 'global',
      authority: 'draft',
      sensitivity: 'normal',
      confidence: 0.5,
      miss_streak: 0,
      created_at: '2026-10-15T00:00:00Z',
      archived_at: '2026-11-26T00:00:00Z',
      reason: 'superseded',
      superseded_by: 'new-decision-2',
    },
    {
      id: 'secret-note-1',
      title: 'Private supplier note',
      body: 'top-secret-password-body',
      evidence: null,
      pattern: 'observations',
      kind: 'observation',
      scope: 'run:r-1',
      authority: 'draft',
      sensitivity: 'private',
      confidence: 0.1,
      miss_streak: 6,
      created_at: '2026-11-05T00:00:00Z',
      archived_at: '2026-11-26T00:00:00Z',
      reason: 'dormant',
    },
  ]

  const nd = mergeNdjson(null, [recs[0]])
  const nd2 = mergeNdjson(nd, [recs[0], recs[1]])
  assert.equal(parseNdjson(nd2).length, 2)

  await io.putColdText('owner-1', 'index.json', JSON.stringify({ shards: ['2026-10', '2026-11'] }), 'application/json')
  await io.putColdText('owner-1', 'shards/2026-10.ndjson', mergeNdjson(null, [recs[0]]))
  await io.putColdText('owner-1', 'shards/2026-11.ndjson', mergeNdjson(null, [recs[1]]))

  const sup = await searchColdStorage('owner-1', { query: 'OpenAI', include: 'superseded' }, io)
  assert.deepEqual(sup.map((r) => r.id), ['old-decision-1'])

  // Private body must never match a cold search; title still matches.
  assert.equal((await searchColdStorage('owner-1', { query: 'top-secret-password-body', include: 'all' }, io)).length, 0)
  assert.deepEqual((await searchColdStorage('owner-1', { query: 'supplier', include: 'dormant' }, io)).map((r) => r.id), ['secret-note-1'])

  // Date bounds skip shards outside range.
  assert.equal((await searchColdStorage('owner-1', { query: 'OpenAI', after: '2026-11-01' }, io)).length, 0)

  // Blame merges and orders newest first.
  const blame = mergeBlame([recs[0]], [{ ...recs[0], id: 'older-0', archived_at: '2026-11-20T00:00:00Z' }])
  assert.deepEqual(blame.map((r) => r.id), ['old-decision-1', 'older-0'])

  // Word-level search fallback.
  assert.deepEqual(searchColdRecords(recs, { query: '38M budget' }).map((r) => r.id), ['old-decision-1'])
})
