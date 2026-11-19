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
import { OWNED_TABLES, seedEveryTable } from './tenants.ts'

let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startRealMemory({}, { storage: true })
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
  const afterPaid = await request('GET', `${memory.url}/me/usage`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(afterPaid.status, 200, afterPaid.text)
  assert.equal(JSON.parse(afterPaid.text).spend_limit_cents, 2000)

  const comp = createOwner('comp-spend')
  const compSet = await request('PATCH', `${memory.url}/me/billing`, {
    headers: bearer(comp.signInJwt()),
    body: { spend_limit_cents: 1000 },
    timeoutMs: 30_000,
  })
  assert.equal(compSet.status, 200, compSet.text)
  const afterComp = await request('GET', `${memory.url}/me/usage`, { headers: bearer(comp.signInJwt()), timeoutMs: 30_000 })
  assert.equal(afterComp.status, 200, afterComp.text)
  assert.equal(JSON.parse(afterComp.text).spend_limit_cents, 1000)
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
  const w1 = `kettle${nonce()}`, w2 = `zap${nonce()}`
  const fillers = Array.from({ length: 8 }, (_, i) => `sup-fill-${i}-${nonce()}`)
  const fillerSql = fillers.map((id, i) =>
    `('${o.id}', '${id}', 'observations', 'observation', 'Rule ${i} ${w1} ${w2}', 'Body ${i} ${w1} ${w2}.', 'approved', 'global', 'Test.', 0.95, 0)`
  ).join(',\n    ')
  exec(`insert into memory.entry (owner_id, id, pattern, kind, title, body, authority, scope, evidence, confidence, chances_left) values
    ('${o.id}', '${e}', 'decisions', 'observation', 'Old ${w1}', 'Old ${w1} rule.', 'observed', 'global', 'Test.', 0.9, 0),
    ('${o.id}', '${f}', 'decisions', 'observation', 'New ${w1} ${w2}', 'New ${w1} ${w2} rule.', 'approved', 'global', 'Test.', 0.95, 0),
    ${fillerSql},
    ('${o.id}', '${x1}', 'observations', 'observation', 'Rel 1', 'Rel 1.', 'observed', 'global', 'Test.', 0.8, 0),
    ('${o.id}', '${x2}', 'observations', 'observation', 'Rel 2', 'Rel 2.', 'observed', 'global', 'Test.', 0.8, 0);
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
    body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'recall', arguments: { query: `${w1} ${w2}` } } },
    timeoutMs: 30_000,
  })
  const recText = JSON.parse(rec.text).result.content[0].text as string
  let rid = /^retrieval ([0-9a-f-]{36})/.exec(recText)![1]
  let combined = ''
  for (let page = 0; page < 3; page++) {
    const more = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(o.deviceToken), 'mcp-session-id': sid },
      body: { jsonrpc: '2.0', id: 3 + page, method: 'tools/call', params: { name: 'recall_more', arguments: { retrieval_id: rid } } },
      timeoutMs: 30_000,
    })
    const moreText = JSON.parse(more.text).result.content[0].text as string
    combined += `\n${moreText}`
    const next = /More past these: recall_more\(retrieval_id="([0-9a-f-]{36})"\)/.exec(moreText)
    if (!next) break
    rid = next[1]
  }
  assert.ok(combined.includes(e) && combined.includes(`superseded by ${f}`), combined)
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

// ----------------------------------------------------------------------------------------------------- R65 (#70)

test('revoke an app', { skip: SKIP }, async () => {
  const a = createOwner('apps')
  const app1 = `client-one-${nonce()}`
  const app2 = `client-two-${nonce()}`
  const t1 = jwt({ sub: a.id, email: a.email, client_id: app1, client_name: 'App One', jti: randomUUID() })
  const t2 = jwt({ sub: a.id, email: a.email, client_id: app2, client_name: 'App Two', jti: randomUUID() })

  for (const tok of [t1, t2]) {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: bearer(tok),
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } },
      timeoutMs: 30_000,
    })
    assert.equal(r.status, 200, r.text)
  }

  const listed = await request('GET', `${memory.url}/me/apps`, { headers: bearer(a.signInJwt()), timeoutMs: 30_000 })
  assert.equal(listed.status, 200, listed.text)
  const appIds = (JSON.parse(listed.text).apps as { id: string }[]).map((x) => x.id)
  assert.ok(appIds.includes(app1) && appIds.includes(app2), listed.text)

  const rev = await request('DELETE', `${memory.url}/me/apps/${encodeURIComponent(app1)}`, {
    headers: bearer(a.signInJwt()),
    timeoutMs: 30_000,
  })
  assert.equal(rev.status, 200, rev.text)

  const call1 = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(t1),
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    timeoutMs: 30_000,
  })
  assert.equal(call1.status, 401, call1.text)

  const call2 = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(t2),
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    timeoutMs: 30_000,
  })
  assert.equal(call2.status, 200, call2.text)
})

test('export is complete and private', { skip: SKIP }, async () => {
  const aId = randomUUID(), bId = randomUUID()
  exec(`begin; select set_config('memory.owner', '${aId}', true); ${seedEveryTable('expa')} commit;
    begin; select set_config('memory.owner', '${bId}', true); ${seedEveryTable('expb')} commit;
    insert into memory.allowed_email (email, plan) values ('seed-expa@example.com', 'owner') on conflict (email) do nothing;
    update memory.entitlement set state = 'paid', plan = 'owner' where owner_id = '${aId}';`)
  const aJwt = jwt({ sub: aId, email: 'seed-expa@example.com', jti: randomUUID() })

  const r = await request('GET', `${memory.url}/me/export`, { headers: bearer(aJwt), timeoutMs: 30_000 })
  assert.equal(r.status, 200, r.text)
  assert.match(String(r.headers['content-type']), /x-ndjson/)
  const lines = r.text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { table: string; row: Record<string, any> })
  const seenTables = new Set<string>()
  for (const item of lines) {
    seenTables.add(item.table)
    assert.notEqual(item.row.owner_id, bId, `leaked row from ${bId} in ${item.table}`)
    assert.equal(item.row.owner_id, aId, `unexpected owner in ${item.table}`)
  }
  for (const table of OWNED_TABLES) {
    assert.ok(seenTables.has(table), `export missing owned table ${table}`)
  }
})

test('Quest #42: /me enforces quest plan limits, syncs live agent scopes, and paginates entries', { skip: SKIP }, async () => {
  // Free plan cannot post quests via /me/quests.
  const freeId = randomUUID()
  const freeEmail = `free-q42-${nonce()}@example.com`
  exec(`insert into memory.allowed_email (email, plan) values ('${freeEmail}', 'free') on conflict (email) do nothing;
    insert into memory.account (owner_id, email) values ('${freeId}', '${freeEmail}') on conflict do nothing;
    insert into memory.entitlement (owner_id, provider, plan, state, event_at) values ('${freeId}', 'comp', 'free', 'comp', now())
      on conflict (owner_id) do update set provider = 'comp', plan = 'free', state = 'comp', event_at = now();`)
  const freeJwt = jwt({ sub: freeId, email: freeEmail, jti: randomUUID() })
  const freeQuest = await request('POST', `${memory.url}/me/quests`, {
    headers: bearer(freeJwt),
    body: { title: 'Free quest attempt', brief: 'Should be refused.', done_when: 'Never.' },
    timeoutMs: 30_000,
  })
  assert.equal(freeQuest.status, 402, freeQuest.text)

  // Live agent scope edit propagates immediately to open MCP sessions in memory.mcp_client.
  const paidId = randomUUID()
  const paidEmail = `paid-q42-${nonce()}@example.com`
  exec(`insert into memory.allowed_email (email, plan) values ('${paidEmail}', 'owner') on conflict (email) do nothing;
    insert into memory.account (owner_id, email) values ('${paidId}', '${paidEmail}') on conflict do nothing;
    insert into memory.entitlement (owner_id, provider, plan, state, event_at) values ('${paidId}', 'owner', 'owner', 'paid', now())
      on conflict (owner_id) do update set provider = 'owner', plan = 'owner', state = 'paid', event_at = now();`)
  const paidJwt = jwt({ sub: paidId, email: paidEmail, jti: randomUUID() })
  const paidQuest = await request('POST', `${memory.url}/me/quests`, {
    headers: bearer(paidJwt),
    body: { title: 'Paid quest succeeds', brief: 'Paid plan allows posting quests.', done_when: 'Returns 201.' },
    timeoutMs: 30_000,
  })
  assert.equal(paidQuest.status, 201, paidQuest.text)
  const oauth = jwt({ sub: paidId, email: paidEmail, client_id: 'q42-client', jti: randomUUID() })
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(oauth),
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-code' } } },
    timeoutMs: 30_000,
  })
  const sid = String(init.headers['mcp-session-id'])
  const agentName = `q42-agent-${nonce()}`
  const reg = await request('POST', `${memory.url}/mcp`, {
    headers: { ...bearer(oauth), 'mcp-session-id': sid },
    body: {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'register_agent', arguments: { name: agentName, context: 'both', surface: 'claude-code', description: 'Live scope test.', projects: ['alpha', 'beta'] } },
    },
    timeoutMs: 30_000,
  })
  assert.equal(reg.status, 200, reg.text)
  const patch = await request('PATCH', `${memory.url}/me/agents/${encodeURIComponent(agentName)}`, {
    headers: bearer(paidJwt),
    body: { context: 'work', repos: ['alpha'], strict_projects: true },
    timeoutMs: 30_000,
  })
  assert.equal(patch.status, 200, patch.text)
  const [clientRow] = sql(`select session_context, session_projects, session_strict_projects from memory.mcp_client where owner_id = '${paidId}' and session_id = '${sid}'`)
  assert.equal(clientRow.session_context, 'work')
  assert.deepEqual(clientRow.session_projects, ['alpha'])
  assert.equal(clientRow.session_strict_projects, true)

  // Pagination on GET /me/entries returns accurate total, limit, offset, and has_more.
  exec(`begin; select set_config('memory.owner', '${paidId}', true);
    insert into memory.entry (id, pattern, title, body, evidence, kind, context) values
      ('q42-e1', 'observations', 'Page 1', 'b1', 'e1', 'observation', 'work'),
      ('q42-e2', 'observations', 'Page 2', 'b2', 'e2', 'observation', 'work'),
      ('q42-e3', 'observations', 'Page 3', 'b3', 'e3', 'observation', 'work');
    commit;`)
  const page1 = await request('GET', `${memory.url}/me/entries?limit=2&offset=0`, { headers: bearer(paidJwt), timeoutMs: 30_000 })
  assert.equal(page1.status, 200, page1.text)
  const p1 = JSON.parse(page1.text)
  assert.equal(p1.total, 3)
  assert.equal(p1.limit, 2)
  assert.equal(p1.offset, 0)
  assert.equal(p1.has_more, true)
  assert.equal(p1.entries.length, 2)
  const page2 = await request('GET', `${memory.url}/me/entries?limit=2&offset=2`, { headers: bearer(paidJwt), timeoutMs: 30_000 })
  const p2 = JSON.parse(page2.text)
  assert.equal(p2.total, 3)
  assert.equal(p2.has_more, false)
  assert.equal(p2.entries.length, 1)

  // Streaming GET /me/export handles early reader cancellation cleanly and streams all NDJSON rows when read in full.
  const aborted = await fetch(`${memory.url}/me/export`, { headers: bearer(paidJwt) })
  assert.equal(aborted.status, 200)
  await aborted.body?.getReader().cancel()
  const exp = await request('GET', `${memory.url}/me/export`, { headers: bearer(paidJwt), timeoutMs: 30_000 })
  assert.equal(exp.status, 200, exp.text)
  const exportedEntries = exp.text.trim().split('\n').map((line) => JSON.parse(line)).filter((x) => x.table === 'entry').map((x) => x.row.id)
  for (const id of ['q42-e1', 'q42-e2', 'q42-e3']) assert.ok(exportedEntries.includes(id), `export contains ${id}`)
})

test('delete account', { skip: SKIP }, async () => {
  const delId = randomUUID()
  const email = 'seed-delacc@example.com'
  exec(`begin; select set_config('memory.owner', '${delId}', true); ${seedEveryTable('delacc')} commit;
    insert into memory.allowed_email (email, plan) values ('${email}', 'owner') on conflict (email) do nothing;
    update memory.entitlement set state = 'paid', plan = 'owner', subscription_id = 'sub-delacc', customer_id = 'cus-delacc'
      where owner_id = '${delId}';
    delete from auth.users where email = '${email}';
    insert into auth.users (id, email) values ('${delId}', '${email}');`)

  const oauth = jwt({ sub: delId, email, client_id: 'del-client', jti: randomUUID() })
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(oauth),
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'claude-ai' } } },
    timeoutMs: 30_000,
  })
  assert.equal(init.status, 200, init.text)
  const sid = String(init.headers['mcp-session-id'])
  const png1 = randomBytes(512), png2 = randomBytes(512)
  const storeNote = await request('POST', `${memory.url}/mcp`, {
    headers: { ...bearer(oauth), 'mcp-session-id': sid },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: {
          pattern: 'observations',
          title: `Account delete blobs ${nonce()}`,
          body: 'Two binary blobs before delete.',
          evidence: 'Test.',
          artifacts: [
            { name: 'one.png', kind: 'image', media_type: 'image/png', base64: png1.toString('base64') },
            { name: 'two.png', kind: 'image', media_type: 'image/png', base64: png2.toString('base64') },
          ],
        },
      },
    },
    timeoutMs: 30_000,
  })
  assert.equal(storeNote.status, 200, storeNote.text)
  assert.equal(sql(`select count(*)::int as n from storage.objects where bucket_id = 'memory-blobs' and name like '${delId}/%'`)[0].n, 2)

  const auditsBefore = sql(`select count(*)::int as n from memory.admin_audit where action = 'account_delete' and before is null and after is null`)[0].n

  const delRes = await request('DELETE', `${memory.url}/me`, {
    headers: bearer(jwt({ sub: delId, email, jti: randomUUID() })),
    timeoutMs: 30_000,
  })
  assert.equal(delRes.status, 200, delRes.text)

  for (const table of OWNED_TABLES) {
    const n = sql(`select count(*)::int as n from memory.${table} where owner_id = '${delId}'`)[0].n
    assert.equal(n, 0, `${table} still has ${n} rows for ${delId}`)
  }
  assert.equal(sql(`select count(*)::int as n from storage.objects where bucket_id = 'memory-blobs' and name like '${delId}/%'`)[0].n, 0)
  const remainingObjects = [...(memory.storage?.objects.keys() ?? [])].filter((k) => k.startsWith(`${delId}/`) || k.startsWith(`incoming/${delId}/`))
  assert.equal(remainingObjects.length, 0, JSON.stringify(remainingObjects))
  assert.equal(sql(`select count(*)::int as n from auth.users where id = '${delId}'`)[0].n, 0)
  assert.ok(memory.auth.deletedUsers.has(delId))
  const auditsAfter = sql(`select count(*)::int as n from memory.admin_audit where action = 'account_delete' and before is null and after is null`)[0].n
  assert.equal(auditsAfter, auditsBefore + 1)
})

