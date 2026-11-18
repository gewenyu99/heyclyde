/**
 * Tier 3: R66 (#71), Clyde slice C19 capacity guardrails. Verifies that the event-retention cron deletes memory.event rows
 * older than 180 days while keeping newer rows intact, and that memory.entry_embedding.embedding is halfvec(1024) inline.
 */
import assert from 'node:assert/strict'
import { before, test } from 'node:test'
import { apply, exec, resetDatabase, SKIP, sql } from './server.ts'
import { WEN_ID } from './tenants.ts'

before(() => {
  if (!SKIP) resetDatabase()
})

test('event retention', { skip: SKIP }, () => {
  apply('20261117010000_event_retention_r66.sql')
  try {
    const [job] = sql(`select schedule, command from cron.job where jobname = 'memory-event-retention'`)
    assert.ok(job, 'memory-event-retention cron job is scheduled')
    assert.equal(job.schedule, '29 4 * * *')

    exec(`
      insert into memory.event (owner_id, session_id, event, payload, received_at, agent)
      select '${WEN_ID}', 'r66-expired', 'UserPromptSubmit', '{}'::jsonb, now() - interval '181 days', 'claude'
      from generate_series(1, 3);
      insert into memory.event (owner_id, session_id, event, payload, received_at, agent)
      select '${WEN_ID}', 'r66-kept', 'UserPromptSubmit', '{}'::jsonb, now() - interval '179 days', 'claude'
      from generate_series(1, 4);
    `)

    exec(job.command)

    const [expired] = sql(`select count(*)::int as n from memory.event where session_id = 'r66-expired'`)
    const [kept] = sql(`select count(*)::int as n from memory.event where session_id = 'r66-kept'`)
    assert.equal(expired.n, 0, 'events created 181 days ago are deleted')
    assert.equal(kept.n, 4, 'events created 179 days ago stay intact')
  } finally {
    exec(`select cron.unschedule('memory-event-retention') where exists (select 1 from cron.job where jobname = 'memory-event-retention');`)
  }
})

test('halfvec', { skip: SKIP }, () => {
  const [col] = sql(`
    with s as materialized (select set_config('search_path', 'memory, extensions, public', true))
    select format_type(a.atttypid, a.atttypmod) as type, a.attstorage as storage
    from s, pg_attribute a
    where a.attrelid = 'memory.entry_embedding'::regclass and a.attname = 'embedding'
  `)
  assert.equal(col?.type, 'halfvec(1024)')
  assert.equal(col?.storage, 'p')
})
