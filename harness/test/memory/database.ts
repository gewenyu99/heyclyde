/**
 * Tier 3 support, run with deno: `reset` rebuilds schema memory from memory/supabase/migrations on SUPABASE_DB_URL, loads
 * the made-up tea vault, and stores the SHA-256 of MEMORY_TEST_TOKEN as a device and of MEMORY_TEST_RUNTIME_TOKEN as the
 * runtime token, the way auth.ts reads them. `drop` removes the schema again. pg_cron only lives in the postgres
 * database, so the tests reset a schema rather than create a database.
 */
import postgres from 'npm:postgres@3.4.7'

const MIGRATIONS = new URL('../../../memory/supabase/migrations/', import.meta.url)

const SOURCES = [
  ['src-a', 'claude_chat', 'Test chat', 'https://example.com/a', '2026-09-01'],
  ['src-b', 'claude_session', 'Later session', 'https://example.com/b', '2026-10-02'],
]
// id, pattern, title, authority, evidence kind, evidence, sensitivity, body. Every entry but the project is part of proj-tea.
const ENTRIES = [
  ['proj-tea', 'projects', 'Tea brewing', 'approved', 'quote', 'i brew tea every morning', 'normal', 'Daily tea brewing.'],
  ['tea-oolong-temp', 'decisions', 'Brew oolong at 90C', 'approved', 'quote', 'oolong at 90 from now on', 'normal', 'Oolong water temperature is 90C.'],
  ['tea-oolong-old', 'decisions', 'Brew oolong at 100C', 'approved', 'quote', 'boiling water for oolong', 'normal', 'Oolong water temperature was 100C.'],
  ['tea-draft-cold', 'recommendations', 'Try cold-brew oolong', 'draft', 'assistant', 'You could cold-brew it', 'normal', 'Claude suggested cold brew; never confirmed.'],
  ['tea-supplier', 'observations', 'Buys oolong from a private supplier', 'observed', 'quote', 'my supplier is secret co', 'private', 'Supplier name and pricing.'],
  ['tea-zh', 'preferences', '喜欢乌龙茶', 'approved', 'quote', '我最喜欢乌龙茶', 'normal', '偏好乌龙茶，不加糖。'],
]
const LINKS = [['tea-oolong-temp', 'tea-oolong-old', 'supersedes'], ['tea-zh', 'tea-oolong-temp', 'relates']]

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const env = (name: string) => Deno.env.get(name) ?? ''
const sql = postgres(env('SUPABASE_DB_URL'), { max: 1, onnotice: () => {} })

async function drop() {
  await sql`select cron.unschedule(jobname) from cron.job where jobname = 'memory-embed-sync'`.catch(() => {})
  await sql`drop schema if exists memory cascade`
}

async function reset() {
  await drop()
  const files = [...Deno.readDirSync(MIGRATIONS)].map((f) => f.name).filter((n) => n.endsWith('.sql')).sort()
  for (const name of files) await sql.unsafe(await Deno.readTextFile(new URL(name, MIGRATIONS))).simple()
  // The migration schedules an embed sync against the real project. The tests never want it.
  await sql`select cron.unschedule('memory-embed-sync')`
  for (const [id, kind, title, uri, date] of SOURCES) {
    await sql`insert into memory.source (id, kind, title, uri, date) values (${id}, ${kind}, ${title}, ${uri}, ${date})`
  }
  for (const [id, pattern, title, authority, kind, evidence, sensitivity, body] of ENTRIES) {
    await sql`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id,
        evidence_kind, evidence, evidence_sha256, project)
      values (${id}, ${pattern}, ${title}, ${body}, ${authority}, 'domain:tea', ${sensitivity}, 'en', '2026-09-01',
        ${id === 'tea-oolong-temp' ? 'src-b' : 'src-a'}, ${kind}, ${evidence}, ${await sha256(evidence)}, 'proj-tea')`
    if (id !== 'proj-tea') await sql`insert into memory.link (src, dst, type) values (${id}, 'proj-tea', 'part_of')`
  }
  for (const [src, dst, type] of LINKS) await sql`insert into memory.link (src, dst, type) values (${src}, ${dst}, ${type})`
  await sql`insert into memory.setting (name, value) values ('runtime_token_sha256', ${await sha256(env('MEMORY_TEST_RUNTIME_TOKEN'))})`
  await sql`insert into memory.device (name, token_sha256) values ('clyde-test', ${await sha256(env('MEMORY_TEST_TOKEN'))})`
}

try {
  if (Deno.args[0] === 'reset') await reset()
  else if (Deno.args[0] === 'drop') await drop()
  else throw new Error('usage: database.ts reset|drop')
} finally {
  await sql.end()
}
