/**
 * Tier 3: R48 (#53), Clyde's tables get an owner, and Wen's notes become tenant one. Against schema memory rebuilt from the
 * migrations: 31 owned tables carry owner_id under forced row-level security for role memory_tenant, the 16 global ones
 * don't, and the tenancy migration gives every row that existed before it to Wen's Supabase Auth user.
 *
 * R49 (#54): every request runs as its tenant, against the real memory function. Owners A and B each hold notes, a blob, a
 * recall, a message, an agent and a quest. A calls every tool, hook and HTTP route, with B's ids where a tool takes one, and
 * no answer carries anything of B's. Recall ranks only the owner's notes on every arm, the runtime token is Wen, and cron
 * learns and embeds each owner's rows inside that owner's tenant.
 *
 * The backfill test rebuilds the schema up to the migration before tenancy, so it runs last.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { waitFor } from '../helpers.ts'
import { bearer, bedFor, idOf, marker, nonce, sha256 } from './bed.ts'
import { apply, asTenant, exec, resetDatabase, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'
import { countsBy, GLOBAL_TABLES, OWNED_TABLES, seedEveryTable, VIEWS, WEN_ID } from './tenants.ts'

const TENANCY = '20261116000000_tenancy.sql'
const A = randomUUID()
const B = randomUUID()

/** Runs statements as postgres with memory.owner set to owner for their transaction. */
const asOwner = (owner: string, statements: string) =>
  exec(`begin; select set_config('memory.owner', '${owner}', true); ${statements} commit;`)

let memory: RealMemory
let bed: ReturnType<typeof bedFor>

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  bed = bedFor(memory)
})

after(async () => {
  await memory?.close()
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

// ----------------------------------------------------------------------------------------------------- R49

type Owner = { id: string; token: string; email: string }

/** An owner with a confirmed account on the owner plan and one computer's device token. */
function owner(tag: string): Owner {
  const id = randomUUID(), email = `${tag}-${nonce()}@example.com`, token = `device-${tag}-${nonce()}${nonce()}`
  exec(`insert into memory.allowed_email (email, plan) values ('${email}', 'owner');
    insert into memory.account (owner_id, email, email_confirmed) values ('${id}', '${email}', true);
    insert into memory.device (name, token_sha256, owner_id) values ('${tag}-box', '${sha256(token)}', '${id}');`)
  return { id, token, email }
}

const http = (method: string, path: string, token: string, body?: unknown) =>
  request(method, `${memory.url}${path}`, { headers: bearer(token), body, timeoutMs: 120_000 })

/** Learn now: the learner waits 30 minutes for the prompt after a recall, so the recalls and events are moved back. */
async function learnNow() {
  sql(`update memory.retrieval set created_at = created_at - interval '31 minutes' where learned_at is null`)
  sql(`update memory.event set received_at = received_at - interval '31 minutes'`)
  for (let pass = 0; pass < 20; pass++) {
    const r = await request('POST', `${memory.url}/learn`, { headers: bearer(memory.cronSecret), timeoutMs: 120_000 })
    assert.equal(r.status, 200, r.text)
    const done = JSON.parse(r.text)
    if (!done.learned && !done.failed) break
  }
}

test("R49: no route returns another owner's rows", { skip: SKIP }, async () => {
  const A = owner('ra'), B = owner('rb')
  const MB = marker(), MA = marker()
  // B's rows, written through the function as B.
  const b = await bed.mcp(B.token)
  assert.ok(!(await b.tool('register_agent', { name: `rb-${nonce()}`, context: 'both', surface: 'test', description: 'B.' })).error)
  const b1 = idOf((await b.tool('remember', { pattern: 'observations', title: `B first ${MB}`, body: `B body ${MB}`, evidence: 'Tier 3.' })).text)
  const b2 = idOf((await b.tool('remember', { pattern: 'observations', title: `B second ${MB}`, body: `B again ${MB}`, evidence: 'Tier 3.' })).text)
  const withBlob = await b.tool('remember', {
    pattern: 'observations', title: `B artifact ${MB}`, body: `B file ${MB}`, evidence: 'Tier 3.',
    artifacts: [{ name: 'b.txt', kind: 'document', text: `B's file ${MB}` }],
  })
  const b3 = idOf(withBlob.text)
  const bSha = sha256(`B's file ${MB}`)
  const bRecall = (await b.tool('recall', { query: `B ${MB}` })).text
  const bRid = /^retrieval (\S+)/.exec(bRecall)![1]
  assert.ok(!(await b.tool('post_message', { to: 'claude', body: `B message ${MB}` })).error)
  const bQuest = (await b.tool('post_quest', { title: `B quest ${MB}`, brief: `B brief ${MB}`, done_when: 'Never.' })).text
  const bQid = /#(\d+)/.exec(bQuest)![1]
  const [bMsg] = sql(`select id from memory.message where owner_id = '${B.id}' and body like '%${MB}%'`)
  // One id both hold.
  exec(`insert into memory.entry (owner_id, id, title, body) values ('${A.id}', 'shared-note', 'Shared note', 'A holds ${MA}'),
    ('${B.id}', 'shared-note', 'Shared note', 'B holds ${MB}');`)
  const bIds = [b1, b2, b3]
  const before = sql(countsBy(A.id, B.id)).map((r) => [r.t, r.b])

  // A, with B's ids wherever a tool takes one.
  const a = await bed.mcp(A.token)
  assert.ok(!(await a.tool('register_agent', { name: `ra-${nonce()}`, context: 'both', surface: 'test', description: 'A.' })).error)
  const aId = idOf((await a.tool('remember', { pattern: 'observations', title: `A note ${MA}`, body: `A body ${MA}`, evidence: 'Tier 3.' })).text)
  const ARGS: Record<string, Record<string, unknown>> = {
    recall: { query: `${MB} B first second artifact` },
    recall_more: { retrieval_id: bRid },
    get_entry: { id: b1 },
    get_blob: { sha256: bSha },
    upload_blob: { sha256: bSha, size: 10 },
    remember: { pattern: 'observations', title: `A links ${MA}`, body: 'A link.', evidence: 'Tier 3.', links: [{ type: 'relates', to: b1 }], supersedes: [b2] },
    feedback: { retrieval_id: bRid, entries: [{ entry_id: b1, verdict: 'used' }] },
    post_message: { to: 'claude', body: `A message ${MA}` },
    check_messages: {},
    ack_messages: { ids: [Number(bMsg.id)] },
    dismiss_messages: { ids: [Number(bMsg.id)] },
    register_agent: { name: `ra-${nonce()}`, context: 'both', surface: 'test', description: 'A again.' },
    post_quest: { title: `A quest ${MA}`, brief: 'A brief.', done_when: 'Never.' },
    list_quests: {},
    claim_quest: { id: Number(bQid) },
    update_quest: { id: Number(bQid), note: 'A was here.' },
    complete_quest: { id: Number(bQid), evidence: 'A says so.', entry_id: aId },
    abandon_quest: { id: Number(bQid), reason: 'A gives up.' },
    dispatch_quest: { action: 'peek', areas: ['none'] },
  }
  const list = JSON.parse((await bed.call('POST', '/mcp', bearer(A.token), { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })).text)
  const tools: string[] = list.result.tools.map((t: { name: string }) => t.name)
  // Each answer, with what A itself sent: an answer may name an id A asked about ("No entry <id>"), never one it didn't.
  const texts: { text: string; sent: string }[] = []
  for (const name of tools) texts.push({ text: `${name}: ${(await a.tool(name, ARGS[name] ?? {})).text}`, sent: JSON.stringify(ARGS[name] ?? {}) })
  texts.push({ text: (await a.tool('get_entry', { id: 'shared-note' })).text, sent: '' })
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PostToolUse']) {
    texts.push({ text: (await http('POST', `/hooks/${event}?agent=claude`, A.token, { session_id: `ra-${nonce()}`, prompt: 'hello', tool_name: 'Read' })).text, sent: '' })
  }
  texts.push({ text: (await http('GET', '/messages/claude', A.token)).text, sent: '' })
  texts.push({ text: (await http('POST', '/recall', A.token, { query: `${MB} B first` })).text, sent: MB })
  const entryAnswer = await http('GET', `/entries/${b1}`, A.token)
  const blobAnswer = await http('GET', `/blobs/${bSha}`, A.token)
  texts.push({ text: entryAnswer.text, sent: b1 }, { text: blobAnswer.text, sent: bSha })

  assert.deepEqual(tools.filter((t) => !(t in ARGS)), [], 'every tool in tools/list was called with arguments')
  for (const leak of [...bIds, MB, bSha, bRid]) {
    const seen = texts.find((t) => t.text.includes(leak) && !t.sent.includes(leak))
    assert.ok(!seen, `A saw ${leak}:\n${seen?.text}`)
  }
  // B's text never comes back, even to a call that searched for its marker.
  assert.ok(!texts.some((t) => t.text.includes(`B body ${MB}`) || t.text.includes(`B quest ${MB}`) || t.text.includes(`B message ${MB}`)))
  assert.ok(texts.some((t) => t.text.includes(`A holds ${MA}`)), 'A reads its own shared-note')
  assert.equal(entryAnswer.status, 404)
  assert.equal(blobAnswer.status, 404)
  assert.deepEqual(sql(countsBy(A.id, B.id)).map((r) => [r.t, r.b]), before, "B's rows are as they were")
  assert.equal(sql(`select count(*)::int as n from memory.message_delivery where owner_id = '${B.id}' and acked_at is not null`)[0].n, 0)
  assert.equal(sql(`select state from memory.quest where owner_id = '${B.id}' and id = ${bQid}`)[0].state, 'open')
})

test("R49: recall ranks only the owner's notes", { skip: SKIP }, async () => {
  const A = owner('qa'), B = owner('qb')
  const word = marker(), aId = `qa-oolong-${word}`, bId = `qb-oolong-${word}`
  // Straight into the tables, so each owner holds exactly this one note and no notes project.
  for (const [o, id, temp] of [[A, aId, '85C'], [B, bId, '95C']] as const) {
    exec(`begin; select set_config('memory.owner', '${o.id}', true);
      insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind, confidence)
      values ('${id}', 'decisions', 'oolong temperature ${word}', 'Brew oolong ${word} at ${temp}.', 'approved', 'global', 'normal', 'en',
        'quote', 'oolong at ${temp}', 'wen', 0.95);
      commit;`)
  }
  assert.equal((await request('POST', `${memory.url}/embeddings/sync`, { headers: bearer(memory.cronSecret), timeoutMs: 30_000 })).status, 202)
  await waitFor(() => sql(`select count(*)::int as n from memory.entry_embedding where entry_id in ('${aId}', '${bId}')`)[0].n === 2 || null, 60_000, 'both embedded')
  for (const arm of ['index', 'hybrid', 'spreading']) {
    const scope = `run:q-${arm}-${nonce()}`
    exec(`insert into memory.mcp_session (owner_id, id, arm, param_set, unit) values ('${A.id}', 'http-${scope}', '${arm}', '${arm}.v1', '${scope}')
      on conflict (owner_id, id) do update set arm = excluded.arm, param_set = excluded.param_set, unit = excluded.unit;`)
    const r = await http('POST', '/recall', A.token, { query: `oolong temperature ${word}`, scope })
    assert.equal(r.status, 200, r.text)
    // A holds one note, so its first result is A's exactly when A's note is in the packet at all.
    assert.equal(sql(`select count(*)::int as n from memory.entry where owner_id = '${A.id}'`)[0].n, 1)
    assert.ok(r.text.includes(aId), `${arm}: A's entry is its first result:\n${r.text}`)
    assert.ok(!r.text.includes(bId) && !r.text.includes('95C'), `${arm}: B's entry is not there:\n${r.text}`)
  }
})

test('R49: the runtime token is Wen', { skip: SKIP }, async () => {
  const A = owner('wa')
  const word = marker()
  const a = await bed.mcp(A.token)
  const aId = idOf((await a.tool('remember', { pattern: 'observations', title: `A runtime probe ${word}`, body: `Only A ${word}.`, evidence: 'Tier 3.' })).text)
  const recall = await http('POST', '/recall', memory.runtimeToken, { query: `runtime probe ${word}` })
  assert.equal(recall.status, 200, recall.text)
  assert.ok(!recall.text.includes(aId) && !recall.text.includes(word), recall.text)
  assert.equal((await http('GET', `/entries/${aId}`, memory.runtimeToken)).status, 404)
  const wrote = await http('POST', '/entries', memory.runtimeToken, {
    id: `runtime-${word}`, pattern: 'projects', title: `Runtime note ${word}`, body: 'From clyde-flow.', authority: 'observed', scope: 'global',
    evidence_kind: 'summary', evidence: 'Tier 3 made it.', source: { kind: 'run', title: 'clyde run r49', uri: `clyde://runs/${word}` },
  })
  assert.equal(wrote.status, 200, wrote.text)
  const [row] = sql(`select owner_id from memory.entry where title = 'Runtime note ${word}'`)
  assert.equal(row?.owner_id, WEN_ID)
})

test("R49: cron works each owner's rows as that owner", { skip: SKIP }, async () => {
  const A = owner('ca'), B = owner('cb')
  const seeded: Record<string, string[]> = {}
  for (const o of [A, B]) {
    const word = marker()
    seeded[o.id] = [1, 2, 3].map((n) => `${o === A ? 'ca' : 'cb'}-${word}-${n}`)
    exec(`begin; select set_config('memory.owner', '${o.id}', true);
      insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, evidence_kind, evidence, kind, confidence)
      select id, 'observations', 'Cron note ${word} ' || n, 'About ${word}.', 'observed', 'global', 'normal', 'en', 'assistant', 'seen', 'wen', 0.8
      from unnest(array['${seeded[o.id].join("','")}']) with ordinality as x(id, n);
      commit;`)
  }
  const ids = Object.values(seeded).flat()
  const sync = await request('POST', `${memory.url}/embeddings/sync`, { headers: bearer(memory.cronSecret), timeoutMs: 30_000 })
  assert.equal(sync.status, 202, sync.text)
  await waitFor(() => sql(`select count(*)::int as n from memory.entry_embedding where entry_id = any(array['${ids.join("','")}'])`)[0].n === 6 || null, 60_000, 'six embeddings')
  const wrongEmbed = sql(`select count(*)::int as n from memory.entry_embedding x join memory.entry e on e.id = x.entry_id
    where x.entry_id = any(array['${ids.join("','")}']) and e.owner_id <> x.owner_id and not exists (
      select 1 from memory.entry e2 where e2.owner_id = x.owner_id and e2.id = x.entry_id)`)[0].n
  assert.equal(wrongEmbed, 0)
  for (const o of [A, B]) {
    const own = seeded[o.id]
    assert.equal(sql(`select count(*)::int as n from memory.entry_embedding where owner_id = '${o.id}' and entry_id = any(array['${own.join("','")}'])`)[0].n, 3)
    const s = await bed.mcp(o.token)
    const text = (await s.tool('recall', { query: `Cron note ${own[0].split('-')[1]}` })).text
    const rid = /^retrieval (\S+)/.exec(text)![1]
    const delivered: string[] = sql(`select delivered from memory.retrieval where id = '${rid}'`)[0].delivered
    const used = delivered.filter((d) => own.includes(d)).slice(0, 2)
    assert.equal(used.length, 2, `two of the owner's notes were delivered: ${delivered}`)
    assert.ok(!(await s.tool('feedback', { retrieval_id: rid, entries: delivered.map((entry_id) => ({ entry_id, verdict: used.includes(entry_id) ? 'used' : 'irrelevant' })) })).error)
  }
  await learnNow()
  for (const o of [A, B]) {
    const links = sql(`select owner_id from memory.link where type = 'co_used' and src = any(array['${seeded[o.id].join("','")}'])`)
    assert.ok(links.length >= 1, 'the learner linked the co-used pair')
    assert.deepEqual([...new Set(links.map((l) => l.owner_id))], [o.id])
    const uses = sql(`select owner_id from memory.co_use where src = any(array['${seeded[o.id].join("','")}'])`)
    assert.deepEqual([...new Set(uses.map((l) => l.owner_id))], [o.id])
  }
  // Every foreign key between owned tables carries owner_id first, so no row can point into another owner's.
  const fks = sql(`select c.conname, c.conrelid::regclass::text as t, a.attname as first
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.connamespace = 'memory'::regnamespace
      and c.conrelid::regclass::text = any(array[${OWNED_TABLES.map((t) => `'memory.${t}'`).join(',')}])
      and c.confrelid::regclass::text = any(array[${OWNED_TABLES.map((t) => `'memory.${t}'`).join(',')}])`)
  assert.ok(fks.length >= 20, `${fks.length} foreign keys between owned tables`)
  assert.deepEqual(fks.filter((f) => f.first !== 'owner_id'), [])
})

test('R49: vectors are halfvec and scanned per owner', { skip: SKIP }, () => {
  const [col] = sql(`select format_type(a.atttypid, a.atttypmod) as type from pg_attribute a
    where a.attrelid = 'memory.entry_embedding'::regclass and a.attname = 'embedding'`)
  assert.match(col.type, /halfvec\(1024\)$/)
  const idx = sql(`select am.amname as am, a.attname as first from pg_index i join pg_class c on c.oid = i.indexrelid
    join pg_am am on am.oid = c.relam join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
    where i.indrelid = 'memory.entry_embedding'::regclass`)
  assert.equal(idx.filter((r) => r.am === 'hnsw').length, 0)
  assert.ok(idx.some((r) => r.am === 'btree' && r.first === 'owner_id'), JSON.stringify(idx))
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
