/**
 * Tier 3: owner /me endpoints (R51 #56, R61 #66). Every /me route accepts only a Supabase Auth sign-in JWT
 * (no client_id) and runs inside that owner's tenant.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, idOf, marker, nonce } from './bed.ts'
import { exec, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  exec(`update memory.allocation set param_set = 'hybrid.v1' where param_set <> 'index.v1'`)
})

after(async () => {
  await memory?.close()
})

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function createOwner(tag: string) {
  const id = randomUUID()
  const email = `me-${tag}-${nonce()}@example.com`
  const deviceName = `me-${tag}-dev-${nonce()}`
  const deviceToken = `tok-${tag}-${randomBytes(10).toString('hex')}`
  exec(`insert into memory.allowed_email (email, plan) values ('${email}', 'owner');
    insert into memory.account (owner_id, email, email_confirmed) values ('${id}', '${email}', true);
    insert into memory.device (name, token_sha256, owner_id) values ('${deviceName}', '${sha256(deviceToken)}', '${id}');`)
  const [dev] = sql(`select id from memory.device where owner_id = '${id}' and name = '${deviceName}'`)
  const signInJwt = () => jwt({ sub: id, email, jti: randomUUID() })
  const oauthJwt = () => jwt({ sub: id, email, client_id: `oauth-${tag}`, jti: randomUUID() })
  return { id, email, deviceId: Number(dev.id), deviceName, deviceToken, signInJwt, oauthJwt }
}

test('/me takes only a sign-in JWT and returns only its owner', { skip: SKIP }, async () => {
  const A = createOwner('a')
  const B = createOwner('b')
  const markA = marker()
  const markB = marker()

  const init = async (tok: string, name: string) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(tok),
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } },
      timeoutMs: 30_000,
    })
    assert.equal(r.status, 200, r.text)
    const sid = String(r.headers['mcp-session-id'])
    const call = (tool: string, args: Record<string, unknown>) =>
      request('POST', `${memory.url}/mcp`, {
        headers: { ...bearer(tok), 'mcp-session-id': sid },
        body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
        timeoutMs: 30_000,
      })
    await call('register_agent', { name, nickname: `${name}-nick`, type: 'coding', context: 'work', surface: 'claude-code', description: 'Owner isolation test.' })
    const rem = await call('remember', { pattern: 'observations', title: `Note ${markA} ${name}`, body: `Body ${name === 'agent-b' ? markB : markA}.`, evidence: 'Test.' })
    return idOf(JSON.parse(rem.text).result.content[0].text)
  }

  const aId = await init(A.deviceToken, `agent-a-${nonce()}`)
  const bId = await init(B.deviceToken, `agent-b-${nonce()}`)

  for (const path of ['/me/entries', '/me/agents', '/me/devices']) {
    const noTok = await request('GET', `${memory.url}${path}`, { timeoutMs: 30_000 })
    assert.equal(noTok.status, 401, `${path} no token`)

    const oauth = await request('GET', `${memory.url}${path}`, { headers: bearer(A.oauthJwt()), timeoutMs: 30_000 })
    assert.equal(oauth.status, 401, `${path} oauth token`)

    const dev = await request('GET', `${memory.url}${path}`, { headers: bearer(A.deviceToken), timeoutMs: 30_000 })
    assert.equal(dev.status, 401, `${path} device token`)
  }

  const entries = await request('GET', `${memory.url}/me/entries`, { headers: bearer(A.signInJwt()), timeoutMs: 30_000 })
  assert.equal(entries.status, 200, entries.text)
  const parsed = JSON.parse(entries.text) as { entries: { id: string }[] }
  const ids = parsed.entries.map((e) => e.id)
  assert.ok(ids.includes(aId))
  assert.ok(!ids.includes(bId))
  assert.ok(!entries.text.includes(markB))
})

test('revoking a device', { skip: SKIP }, async () => {
  const owner = createOwner('revoke')

  const before = await request('POST', `${memory.url}/hooks/UserPromptSubmit?agent=claude`, {
    headers: bearer(owner.deviceToken),
    body: { session_id: 's1', prompt: 'hello' },
    timeoutMs: 30_000,
  })
  assert.equal(before.status, 200, before.text)

  const listBefore = await request('GET', `${memory.url}/me/devices`, { headers: bearer(owner.signInJwt()), timeoutMs: 30_000 })
  assert.equal(listBefore.status, 200, listBefore.text)
  const devsBefore = JSON.parse(listBefore.text).devices as { id: number; name: string; revoked_at: string | null }[]
  assert.ok(devsBefore.some((d) => Number(d.id) === owner.deviceId && d.revoked_at === null))

  const del = await request('DELETE', `${memory.url}/me/devices/${owner.deviceId}`, {
    headers: bearer(owner.signInJwt()),
    timeoutMs: 30_000,
  })
  assert.equal(del.status, 200, del.text)
  assert.equal(Number(JSON.parse(del.text).revoked), owner.deviceId)

  const afterHook = await request('POST', `${memory.url}/hooks/UserPromptSubmit?agent=claude`, {
    headers: bearer(owner.deviceToken),
    body: { session_id: 's1', prompt: 'hello again' },
    timeoutMs: 30_000,
  })
  assert.equal(afterHook.status, 401, afterHook.text)
})

// ----------------------------------------------------------------------------------------------------- R60 (#65)

function createPaidOwner(tag: string) {
  const o = createOwner(tag)
  exec(`insert into memory.entitlement (owner_id, provider, customer_id, subscription_id, plan, state, event_at)
    values ('${o.id}', 'polar', 'cus-${tag}', 'sub-${tag}', 'clyde', 'paid', now())
    on conflict (owner_id) do update set plan = 'clyde', state = 'paid', updated_at = now();`)
  return o
}

test('usage meters', { skip: SKIP }, async () => {
  const o = createPaidOwner('usage')
  const seeded: [string, number, number][] = [
    ['ai', 300_000, 39_000],
    ['storage_gb_hours', 24, 700],
    ['egress_bytes', 500_000_000, 45_000],
    ['requests', 12_345, 24_690],
    ['db_bytes', 120_000_000, 15_000],
  ]
  for (const [kind, qty, cost] of seeded) {
    exec(`insert into memory.usage (owner_id, period, kind, amount, quantity, cost_micro_usd)
      values ('${o.id}', date_trunc('month', now() at time zone 'utc')::date, '${kind}', ${qty}, ${qty}, ${cost})
      on conflict (owner_id, period, kind) do update set amount = excluded.amount, quantity = excluded.quantity, cost_micro_usd = excluded.cost_micro_usd;`)
  }
  const r = await request('GET', `${memory.url}/me/usage`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(r.status, 200, r.text)
  const body = JSON.parse(r.text) as { meters: { kind: string; included: number | null; used: number; overage_cents: number }[] }
  assert.equal(body.meters.length, 5)
  for (const [kind, qty] of seeded) {
    const m = body.meters.find((x) => x.kind === kind)
    assert.ok(m, `missing meter ${kind}`)
    assert.equal(typeof m.overage_cents, 'number')
    assert.ok('included' in m)
    assert.equal(m.used, qty, `${kind}: used mismatch`)
  }
})

test('spend limit bounds', { skip: SKIP }, async () => {
  const o = createPaidOwner('spend')
  const tooHigh = await request('PATCH', `${memory.url}/me/billing`, {
    headers: bearer(o.signInJwt()),
    body: { spend_limit_cents: 60_000 },
    timeoutMs: 30_000,
  })
  assert.equal(tooHigh.status, 400, tooHigh.text)

  const ok = await request('PATCH', `${memory.url}/me/billing`, {
    headers: bearer(o.signInJwt()),
    body: { spend_limit_cents: 2000 },
    timeoutMs: 30_000,
  })
  assert.equal(ok.status, 200, ok.text)
  const [row] = sql(`select spend_limit_cents from memory.entitlement where owner_id = '${o.id}'`)
  assert.equal(Number(row?.spend_limit_cents), 2000)
})

// ----------------------------------------------------------------------------------------------------- R51 (#56), R52 (#57), R63 (#68)

test('filters by kind and project', { skip: SKIP }, async () => {
  const o = createOwner('filter')
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(o.deviceToken),
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } },
    timeoutMs: 30_000,
  })
  const sid = String(init.headers['mcp-session-id'])
  const mcpCall = async (tool: string, args: Record<string, unknown>) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(o.deviceToken), 'mcp-session-id': sid },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } },
      timeoutMs: 30_000,
    })
    assert.equal(r.status, 200, r.text)
    return JSON.parse(r.text).result
  }
  await mcpCall('register_agent', { name: `filt-${nonce()}`, type: 'coding', context: 'work', surface: 'claude-code', description: 'Filter test.' })

  exec(`insert into memory.entry (owner_id, id, pattern, kind, project, project_slug, title, body, authority, scope, evidence)
    select '${o.id}', 'f-match-' || g, 'decisions', 'observation', 'p1', 'p1', 'Match ' || g, 'Body ' || g, 'observed', 'global', 'Test.'
    from generate_series(1, 4) g;
    insert into memory.entry (owner_id, id, pattern, kind, project, project_slug, title, body, authority, scope, evidence)
    select '${o.id}', 'f-other-' || g, case when g <= 10 then 'decisions' else 'observations' end, 'observation', 'p2', 'p2', 'Other ' || g, 'Body ' || g, 'observed', 'global', 'Test.'
    from generate_series(1, 26) g;`)

  const r = await request('GET', `${memory.url}/me/entries?kind=decision&project=p1`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(r.status, 200, r.text)
  const data = JSON.parse(r.text) as { entries: { id: string; pattern: string; project: string }[] }
  assert.equal(data.entries.length, 4)
  for (const e of data.entries) {
    assert.equal(e.pattern, 'decisions')
    assert.equal(e.project, 'p1')
  }
})

test('edit an entry', { skip: SKIP }, async () => {
  const o = createOwner('edit')
  const eid = `ed-${nonce()}`
  exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence)
    values ('${o.id}', '${eid}', 'observations', 'observation', 'Before edit', 'old body', 'observed', 'global', 'Test.');`)

  const patch = await request('PATCH', `${memory.url}/me/entries/${eid}`, {
    headers: bearer(o.signInJwt()),
    body: { body: 'new body' },
    timeoutMs: 30_000,
  })
  assert.equal(patch.status, 200, patch.text)

  const got = await request('GET', `${memory.url}/me/entries/${eid}`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(got.status, 200, got.text)
  assert.equal(JSON.parse(got.text).body, 'new body')

  const [audit] = sql(`select count(*)::int as n from memory.admin_audit
    where owner_id = '${o.id}' and action = 'entry_edit' and target = 'entry:${eid}' and after->>'entry_id' = '${eid}'`)
  assert.equal(audit.n, 1)
})

test('prune hides a note from recall', { skip: SKIP }, async () => {
  const o = createOwner('prune')
  const eid = `pr-${nonce()}`
  exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence, confidence)
    values ('${o.id}', '${eid}', 'observations', 'observation', 'tea kettle limit', 'Keep kettle below 100C.', 'approved', 'global', 'Test.', 0.9);`)

  const pr = await request('POST', `${memory.url}/me/entries/${eid}/prune`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(pr.status, 200, pr.text)

  const rec = await request('POST', `${memory.url}/recall`, { headers: bearer(o.deviceToken), body: { query: 'tea kettle limit' }, timeoutMs: 30_000 })
  assert.equal(rec.status, 200, rec.text)
  assert.ok(!rec.text.includes(eid), rec.text)

  const prunedList = await request('GET', `${memory.url}/me/entries?state=pruned`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(prunedList.status, 200, prunedList.text)
  const prunedIds = (JSON.parse(prunedList.text).entries as { id: string }[]).map((e) => e.id)
  assert.equal(prunedIds.filter((x) => x === eid).length, 1)
})

test('supersede keeps links', { skip: SKIP }, async () => {
  const o = createOwner('super')
  const e = `sup-e-${nonce()}`, f = `sup-f-${nonce()}`, x1 = `sup-x1-${nonce()}`, x2 = `sup-x2-${nonce()}`
  const uniq = `kettlezap${nonce()}`
  exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence, confidence) values
    ('${o.id}', '${e}', 'decisions', 'observation', 'Old ${uniq}', 'Old ${uniq} rule.', 'observed', 'global', 'Test.', 0.9),
    ('${o.id}', '${f}', 'decisions', 'observation', 'New ${uniq}', 'New ${uniq} rule.', 'approved', 'global', 'Test.', 0.95),
    ('${o.id}', '${x1}', 'observations', 'observation', 'Rel 1', 'Rel 1.', 'observed', 'global', 'Test.', 0.8),
    ('${o.id}', '${x2}', 'observations', 'observation', 'Rel 2', 'Rel 2.', 'observed', 'global', 'Test.', 0.8);
    insert into memory.link (owner_id, src, dst, type) values
    ('${o.id}', '${e}', '${x1}', 'relates'),
    ('${o.id}', '${e}', '${x2}', 'relates');`)

  const sup = await request('POST', `${memory.url}/me/entries/${e}/supersede`, {
    headers: bearer(o.signInJwt()),
    body: { replacement: f },
    timeoutMs: 30_000,
  })
  assert.equal(sup.status, 200, sup.text)

  const detail = await request('GET', `${memory.url}/me/entries/${e}`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(detail.status, 200, detail.text)
  assert.equal(JSON.parse(detail.text).superseded_by, f)

  const [{ n: linkCount }] = sql(`select count(*)::int as n from memory.link where owner_id = '${o.id}' and src = '${e}'`)
  assert.equal(linkCount, 2)

  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(o.deviceToken),
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } },
    timeoutMs: 30_000,
  })
  const sid = String(init.headers['mcp-session-id'])
  const rec = await request('POST', `${memory.url}/mcp`, {
    headers: { ...bearer(o.deviceToken), 'mcp-session-id': sid },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: uniq } } },
    timeoutMs: 30_000,
  })
  const recText = JSON.parse(rec.text).result.content[0].text as string
  const rid = /^retrieval ([0-9a-f-]{36})/.exec(recText)![1]
  const more = await request('POST', `${memory.url}/mcp`, {
    headers: { ...bearer(o.deviceToken), 'mcp-session-id': sid },
    body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall_more', arguments: { retrieval_id: rid } } },
    timeoutMs: 30_000,
  })
  const moreText = JSON.parse(more.text).result.content[0].text as string
  assert.ok(moreText.includes(e) && moreText.includes(`superseded by ${f}`), moreText)
})

test('delete removes the note and keeps shared blobs', { skip: SKIP }, async () => {
  const o = createOwner('del')
  const e = `del-e-${nonce()}`, g = `del-g-${nonce()}`
  const data = Buffer.from(`shared-blob-${nonce()}`)
  const sha = sha256(data)
  exec(`insert into memory.blob (owner_id, sha256, media_type, size, stored, content)
    values ('${o.id}', '${sha}', 'text/plain', ${data.length}, 'db', decode('${data.toString('hex')}', 'hex'));
    insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence) values
    ('${o.id}', '${e}', 'observations', 'observation', 'Del E', 'Body E.', 'observed', 'global', 'Test.'),
    ('${o.id}', '${g}', 'observations', 'observation', 'Keep G', 'Body G.', 'observed', 'global', 'Test.');
    insert into memory.entry_embedding (owner_id, entry_id, model, content_sha256, embedding)
    values ('${o.id}', '${e}', 'text-embedding-3-large', 'c1', array_fill(0.1, array[1024])::extensions.vector);
    insert into memory.entry_blob (owner_id, entry_id, name, sha256, kind) values
    ('${o.id}', '${e}', 'shared.txt', '${sha}', 'document'),
    ('${o.id}', '${g}', 'shared.txt', '${sha}', 'document');`)

  const del = await request('DELETE', `${memory.url}/me/entries/${e}`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(del.status, 200, del.text)
  assert.equal(sql(`select count(*)::int as n from memory.entry where owner_id = '${o.id}' and id = '${e}'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.entry_embedding where owner_id = '${o.id}' and entry_id = '${e}'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.entry_blob where owner_id = '${o.id}' and entry_id = '${e}'`)[0].n, 0)
  assert.equal(sql(`select count(*)::int as n from memory.blob where owner_id = '${o.id}' and sha256 = '${sha}'`)[0].n, 1)
})

test("another owner can't change a note", { skip: SKIP }, async () => {
  const A = createOwner('mut-a')
  const B = createOwner('mut-b')
  const eid = `owned-${nonce()}`
  exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence)
    values ('${A.id}', '${eid}', 'observations', 'observation', 'Locked title', 'Locked body', 'observed', 'global', 'Test.');`)
  const [before] = sql(`select * from memory.entry where owner_id = '${A.id}' and id = '${eid}'`)

  const p = await request('PATCH', `${memory.url}/me/entries/${eid}`, { headers: bearer(B.signInJwt()), body: { body: 'hacked' }, timeoutMs: 30_000 })
  const pr = await request('POST', `${memory.url}/me/entries/${eid}/prune`, { headers: bearer(B.signInJwt()), timeoutMs: 30_000 })
  const sp = await request('POST', `${memory.url}/me/entries/${eid}/supersede`, { headers: bearer(B.signInJwt()), body: { replacement: eid }, timeoutMs: 30_000 })
  const dl = await request('DELETE', `${memory.url}/me/entries/${eid}`, { headers: bearer(B.signInJwt()), timeoutMs: 30_000 })
  for (const r of [p, pr, sp, dl]) assert.equal(r.status, 404, r.text)

  const [after] = sql(`select * from memory.entry where owner_id = '${A.id}' and id = '${eid}'`)
  assert.deepEqual(after, before)
})

test('graph neighborhood', { skip: SKIP }, async () => {
  const A = createOwner('graph-a')
  const B = createOwner('graph-b')
  const rootId = `gr-0-${nonce()}`
  exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence)
    select '${A.id}', case when g = 0 then '${rootId}' else 'gr-${rootId}-' || g end, 'observations', 'observation', 'Node ' || g, 'Body ' || g, 'observed', 'global', 'Test.'
    from generate_series(0, 350) g;
    insert into memory.link (owner_id, src, dst, type)
    select '${A.id}', '${rootId}', 'gr-${rootId}-' || g, 'relates' from generate_series(1, 20) g;
    insert into memory.link (owner_id, src, dst, type)
    select '${A.id}', 'gr-${rootId}-' || ((g % 20) + 1), 'gr-${rootId}-' || g, 'relates' from generate_series(21, 350) g;
    insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence)
    values ('${B.id}', 'gr-b-only', 'observations', 'observation', 'B node', 'B.', 'observed', 'global', 'Test.');`)

  const r = await request('GET', `${memory.url}/me/graph?center=${rootId}&depth=2`, { headers: bearer(A.signInJwt()), timeoutMs: 30_000 })
  assert.equal(r.status, 200, r.text)
  const g = JSON.parse(r.text) as { nodes: { id: string }[]; edges: { src: string; dst: string }[] }
  assert.ok(g.nodes.length >= 1 && g.nodes.length <= 300, `nodes=${g.nodes.length}`)
  const nodeIds = new Set(g.nodes.map((n) => n.id))
  assert.ok(!nodeIds.has('gr-b-only'))
  const foreignNodes = sql(`select count(*)::int as n from memory.entry where id = any(array['${[...nodeIds].join("','")}']) and owner_id <> '${A.id}'`)[0].n
  assert.equal(foreignNodes, 0)
  for (const e of g.edges) {
    assert.ok(nodeIds.has(e.src) && nodeIds.has(e.dst), `dangling edge ${e.src} -> ${e.dst}`)
  }
})

