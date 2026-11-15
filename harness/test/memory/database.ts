/**
 * Tier 3 support, run with deno: `reset` rebuilds schema memory from memory/supabase/migrations on SUPABASE_DB_URL, loads
 * the made-up tea vault, and stores the SHA-256 of MEMORY_TEST_TOKEN as a device, of MEMORY_TEST_RUNTIME_TOKEN as the
 * runtime token, of MEMORY_TEST_ADMIN_TOKEN as the admin token and of MEMORY_TEST_RESEARCH_TOKEN as the research token,
 * the way auth.ts reads them, with
 * MEMORY_TEST_CRON_SECRET in Vault. `drop` removes the schema again. `sql <statement>` prints its rows as JSON, for what
 * no route shows. `apply <migration file>` runs one migration file again, and `purge` runs memory.purge_messages() and prints
 * how long it took in ms. `until <migration file>` rebuilds schema memory from the migrations before that file and seeds
 * nothing, `exec <statements>` runs several statements in one round trip, and `tenant <owner> <statement>` runs one statement
 * as role memory_tenant with memory.owner set to owner ('' leaves it unset) and prints its rows, or {error, code}. Wen, the
 * tenant every seeded row belongs to (R48), is WEN_ID. pg_cron only lives in the postgres database, so the tests reset a schema rather than create a database.
 */
import postgres from 'npm:postgres@3.4.7'

const MIGRATIONS = new URL('../../../memory/supabase/migrations/', import.meta.url)
/** Wen's owner id in the tests: setting owner_id, which every row written as postgres with no memory.owner belongs to. */
export const WEN_ID = '7e570000-0000-4000-8000-00000000c1de'

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

// The migrations schedule these against the real project, with the cron secret. The tests never want them.
const CRONS = ['memory-embed-sync', 'memory-learn', 'memory-message-purge', 'memory-variant-retention', 'memory-variant-guard', 'memory-usage-report']

// memory-blob-sweep stays scheduled after a reset, since a test checks the migration made it. drop removes it.
async function unschedule(names = CRONS) {
  await sql`select cron.unschedule(jobname) from cron.job where jobname::text = any(${names}::text[])`
}

async function drop() {
  await unschedule([...CRONS, 'memory-blob-sweep']).catch(() => {})
  await sql`drop schema if exists memory cascade`
}

/** Vault lives outside schema memory, so a rerun updates the secret rather than adding a second. */
async function putSecret(name: string, value: string) {
  await sql`create extension if not exists supabase_vault cascade`.catch(() => {})
  const [old] = await sql`select id from vault.secrets where name = ${name}`
  if (old) await sql`select vault.update_secret(${old.id}::uuid, ${value})`
  else await sql`select vault.create_secret(${value}, ${name})`
}

/** Rebuilds schema memory from every migration whose file name sorts before `until`, or from all of them. */
async function migrate(until?: string) {
  await drop()
  const files = [...Deno.readDirSync(MIGRATIONS)].map((f) => f.name).filter((n) => n.endsWith('.sql') && (!until || n < until)).sort()
  for (const name of files) await sql.unsafe(await Deno.readTextFile(new URL(name, MIGRATIONS))).simple()
  await unschedule()
}

async function reset() {
  await migrate()
  // The tenancy migration takes Wen's owner from Supabase Auth, which the CI database has no user in, so the tests name him.
  if (await sql`select 1 from information_schema.columns where table_schema = 'memory' and table_name = 'entry' and column_name = 'owner_id'`.then((r) => r.length)) {
    await sql`insert into memory.setting (name, value) values ('owner_id', ${WEN_ID}) on conflict (name) do update set value = excluded.value`
    // His account, as production has it: the confirmed owner-plan address on the allowlist.
    await sql`insert into memory.account (owner_id, email, email_confirmed)
      select ${WEN_ID}, email, true from memory.allowed_email where plan = 'owner' order by added_at limit 1`
  }
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
  await sql`insert into memory.setting (name, value) values ('admin_token_sha256', ${await sha256(env('MEMORY_TEST_ADMIN_TOKEN'))})`
  await sql`insert into memory.setting (name, value) values ('research_token_sha256', ${await sha256(env('MEMORY_TEST_RESEARCH_TOKEN'))})`
  await sql`insert into memory.device (name, token_sha256) values ('clyde-test', ${await sha256(env('MEMORY_TEST_TOKEN'))})`
  await putSecret('cron_secret', env('MEMORY_TEST_CRON_SECRET'))
}

try {
  if (Deno.args[0] === 'reset') await reset()
  else if (Deno.args[0] === 'drop') await drop()
  else if (Deno.args[0] === 'sql') console.log(JSON.stringify(await sql.unsafe(Deno.args[1])))
  else if (Deno.args[0] === 'apply') await sql.unsafe(await Deno.readTextFile(new URL(Deno.args[1], MIGRATIONS))).simple()
  else if (Deno.args[0] === 'until') await migrate(Deno.args[1])
  else if (Deno.args[0] === 'exec') await sql.unsafe(Deno.args[1]).simple()
  else if (Deno.args[0] === 'tenant') {
    try {
      const rows = await sql.begin(async (tx) => {
        await tx.unsafe('set local role memory_tenant')
        if (Deno.args[1]) await tx`select set_config('memory.owner', ${Deno.args[1]}, true)`
        return await tx.unsafe(Deno.args[2])
      })
      console.log(JSON.stringify(rows))
    } catch (e) {
      console.log(JSON.stringify({ error: (e as Error).message, code: (e as { code?: string }).code ?? null }))
    }
  }
  else if (Deno.args[0] === 'purge') {
    const started = performance.now()
    const [row] = await sql`select memory.purge_messages() as result`
    console.log(JSON.stringify({ ms: performance.now() - started, result: row.result }))
  } else throw new Error('usage: database.ts reset|drop|sql <statement>|apply <file>|until <file>|exec <statements>|tenant <owner> <statement>|purge')
} finally {
  await sql.end()
}
