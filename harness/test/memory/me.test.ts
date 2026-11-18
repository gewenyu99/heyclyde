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
