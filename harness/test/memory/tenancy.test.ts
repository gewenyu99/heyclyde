/**
 * Tier 3: R48 (#53), Clyde's tables get an owner, and Wen's notes become tenant one. Against schema memory rebuilt from the
 * migrations: 31 owned tables carry owner_id under forced row-level security for role memory_tenant, the 16 global ones
 * don't, and the tenancy migration gives every row that existed before it to Wen's Supabase Auth user.
 *
 * The backfill test rebuilds the schema up to the migration before tenancy, so it runs last.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { apply, asTenant, exec, resetDatabase, SKIP, sql } from './server.ts'
import { countsBy, GLOBAL_TABLES, OWNED_TABLES, seedEveryTable, VIEWS } from './tenants.ts'

const TENANCY = '20261116000000_tenancy.sql'
const A = randomUUID()
const B = randomUUID()

/** Runs statements as postgres with memory.owner set to owner for their transaction. */
const asOwner = (owner: string, statements: string) =>
  exec(`begin; select set_config('memory.owner', '${owner}', true); ${statements} commit;`)

before(() => {
  if (SKIP) return
  resetDatabase()
})

after(() => {
  if (SKIP) return
  sql(`drop schema if exists memory cascade`)
})

test('R48: two owners both keep proj-pkg', { skip: SKIP }, () => {
  asOwner(A, `insert into memory.entry (id, title) values ('proj-pkg', 'A''s package');`)
  asOwner(B, `insert into memory.entry (id, title) values ('proj-pkg', 'B''s package');`)
  const [row] = sql(`select count(*)::int as n, count(distinct owner_id)::int as owners from memory.entry where id = 'proj-pkg'`)
  assert.deepEqual(row, { n: 2, owners: 2 })
})

test('R48: every owned table has owner_id and forced RLS', { skip: SKIP }, () => {
  const tables = sql(`
    select c.relname as t, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
      exists (select 1 from information_schema.columns k where k.table_schema = 'memory' and k.table_name = c.relname
              and k.column_name = 'owner_id' and k.data_type = 'uuid' and k.is_nullable = 'NO') as owner_id,
      exists (select 1 from pg_policies p where p.schemaname = 'memory' and p.tablename = c.relname
              and 'memory_tenant' = any(p.roles)) as policy
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'memory' and c.relkind in ('r', 'p') order by 1`)
  const owned = tables.filter((r) => !GLOBAL_TABLES.includes(r.t))
  assert.deepEqual(owned.map((r) => r.t).sort(), [...OWNED_TABLES].sort(), 'the owned tables are exactly the 31')
  const lacking = owned.filter((r) => !(r.rls && r.forced && r.owner_id && r.policy))
  assert.deepEqual(lacking, [], 'every owned table has owner_id uuid not null, RLS, forced RLS and a memory_tenant policy')
  const views = sql(`select c.relname as v, coalesce(c.reloptions, '{}') as options from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'memory' and c.relkind = 'v' order by 1`)
  assert.deepEqual(views.map((r) => r.v).sort(), [...VIEWS].sort())
  assert.deepEqual(views.filter((r) => !String(r.options).includes('security_invoker=true')), [], 'every view runs as its caller')
  const [role] = sql(`select rolbypassrls from pg_roles where rolname = 'memory_tenant'`)
  assert.equal(role?.rolbypassrls, false)
})

test("R48: memory_tenant can't touch the allowlist, settings or entitlements", { skip: SKIP }, () => {
  const privs = sql(`select t, p, has_table_privilege('memory_tenant', 'memory.' || t, p) as has
    from unnest(array['allowed_email', 'setting', 'entitlement']) t, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p`)
  const held = privs.filter((r) => r.has).map((r) => `${r.t}:${r.p}`)
  assert.deepEqual(held, ['entitlement:SELECT'])
})

test('R48: memory_tenant sees only its owner', { skip: SKIP }, () => {
  asOwner(A, seedEveryTable('a'))
  asOwner(B, seedEveryTable('b'))
  const seen = asTenant(A, countsBy(A, B))
  assert.ok(Array.isArray(seen), JSON.stringify(seen))
  assert.deepEqual(seen.filter((r) => r.b !== 0), [], "no table shows A any of B's rows")
  assert.deepEqual(seen.filter((r) => r.a < 1), [], "every table shows A its own rows")
  const unset = asTenant('', countsBy(A, B))
  assert.ok(Array.isArray(unset), JSON.stringify(unset))
  assert.deepEqual(unset.filter((r) => r.n !== 0), [], 'with no owner set, every table is empty')
  const forged = asTenant(A, `insert into memory.entry (id, title, owner_id) values ('forged', 'Forged', '${B}')`)
  assert.equal((forged as { code: string }).code, '42501', JSON.stringify(forged))
})

test('R48: the backfill keeps every row and gives it to Wen', { skip: SKIP }, () => {
  const wen = randomUUID()
  resetDatabase(TENANCY)
  // Wen as Supabase Auth knows him: the owner-plan address on the allowlist.
  const [owner] = sql(`select email from memory.allowed_email where plan = 'owner'`)
  exec(`delete from auth.users where email = '${owner.email}';
    insert into auth.users (id, email) values ('${wen}', '${owner.email}');`)
  try {
    asOwner(wen, seedEveryTable('wen'))
    // A device from before R38, which no one claimed.
    exec(`insert into memory.device (name, token_sha256) values ('old-laptop', md5(random()::text));`)
    const before = new Map(sql(countsBy('', '', false)).map((r) => [r.t, r.n]))
    assert.deepEqual([...before].filter(([, n]) => n < 1), [], 'every owned table holds a row before the migration')
    apply(TENANCY)
    const afterRows = sql(countsBy(wen))
    assert.deepEqual(afterRows.filter((r) => r.n !== before.get(r.t)).map((r) => [r.t, before.get(r.t), r.n]), [], 'every count is unchanged')
    assert.deepEqual(afterRows.filter((r) => r.nulls !== 0).map((r) => r.t), [], 'no row lacks an owner')
    assert.deepEqual(afterRows.filter((r) => r.owners !== 1 || r.owner !== wen).map((r) => [r.t, r.owners, r.owner]), [], 'every row is Wen\'s')
    const [setting] = sql(`select value from memory.setting where name = 'owner_id'`)
    assert.equal(setting?.value, wen)
  } finally {
    exec(`delete from auth.users where id = '${wen}';`)
  }
})
