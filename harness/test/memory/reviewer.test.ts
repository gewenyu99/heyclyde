/**
 * Tier 3: R55 (#60), the store reviewers' demo account. An allowlisted account on plan owner signs in to an app with its
 * password on the consent page (no email link), holds exactly 40 sample notes from memory.reseed_reviewer(), sees them at
 * GET /me/entries, can delete one, and the nightly reseed puts all 40 back. Against the real memory function and a fake
 * Supabase Auth that knows the account's password.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, nonce } from './bed.ts'
import { apply, exec, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory
const email = `review-${nonce()}@example.com`
const password = `pw-${randomUUID()}`
// The fake Auth's stable id for an email, as it hands out at sign-in.
const h = createHash('sha256').update(email).digest('hex')
const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  memory.auth.passwords[email] = password
  exec(`insert into memory.allowed_email (email, plan) values ('${email}', 'owner');
    insert into memory.account (owner_id, email, email_confirmed) values ('${id}', '${email}', true);
    insert into memory.setting (name, value) values ('reviewer_owner_id', '${id}') on conflict (name) do update set value = excluded.value;`)
})

after(async () => {
  await memory?.close()
})

const reseed = () => Number(sql(`select memory.reseed_reviewer() as n`)[0].n)
const mine = (token = jwt({ sub: id, email, jti: randomUUID() })) =>
  request('GET', `${memory.url}/me/entries`, { headers: bearer(token), timeoutMs: 30_000 })

test('R55: the reviewer signs in with a password and holds 40 notes', { skip: SKIP }, async () => {
  assert.equal(reseed(), 40)
  assert.deepEqual(sql(`select plan, state from memory.entitlement where owner_id = '${id}'`), [{ plan: 'owner', state: 'comp' }])
  const auth = `auth-${nonce()}`
  memory.auth.authorizations[auth] = { redirect_uri: 'https://claude.ai/api/mcp/auth_callback', client: { id: 'claude-client', name: 'Claude' } }
  const consent = (pw: string) => request('POST', `${memory.url}/oauth/consent?authorization_id=${auth}`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email, password: pw }).toString(), timeoutMs: 30_000,
  })
  const wrong = await consent('not-it')
  assert.equal(wrong.status, 401, wrong.text)
  const ok = await consent(password)
  assert.equal(ok.status, 302, ok.text)
  assert.match(String(ok.headers.location), /^https:\/\/claude\.ai\/api\/mcp\/auth_callback\?code=/)
  const r = await mine()
  assert.equal(r.status, 200, r.text)
  assert.equal(JSON.parse(r.text).total, 40)
})

test('R55: a deleted note comes back with the nightly reseed', { skip: SKIP }, async () => {
  reseed()
  const list = JSON.parse((await mine()).text).entries as { id: string; pattern: string }[]
  const note = list.find((e) => e.pattern !== 'projects')!
  const gone = await request('DELETE', `${memory.url}/me/entries/${encodeURIComponent(note.id)}`, { headers: bearer(jwt({ sub: id, email, jti: randomUUID() })), timeoutMs: 30_000 })
  assert.equal(gone.status, 200, gone.text)
  assert.equal(JSON.parse((await mine()).text).total, 39)
  assert.equal(reseed(), 40)
  assert.equal(JSON.parse((await mine()).text).total, 40)
})

test("R55: another owner's /me never shows the reviewer's notes", { skip: SKIP }, async () => {
  reseed()
  const other = randomUUID(), otherEmail = `other-${nonce()}@example.com`
  exec(`insert into memory.allowed_email (email, plan) values ('${otherEmail}', 'owner');`)
  const r = await mine(jwt({ sub: other, email: otherEmail, jti: randomUUID() }))
  assert.equal(r.status, 200, r.text)
  assert.equal(JSON.parse(r.text).total, 0)
  const gone = await request('DELETE', `${memory.url}/me/entries/sample-lisbon`, { headers: bearer(jwt({ sub: other, email: otherEmail, jti: randomUUID() })), timeoutMs: 30_000 })
  assert.equal(gone.status, 404, gone.text)
  assert.equal(JSON.parse((await mine()).text).total, 40)
})

test('R55: the reseed runs nightly', { skip: SKIP }, () => {
  apply('20261116050000_reviewer.sql')
  try {
    const [job] = sql(`select schedule, command from cron.job where jobname = 'memory-reviewer-reseed'`)
    assert.match(job?.schedule ?? '', /^\d{1,2} \d{1,2} \* \* \*$/)
    assert.match(job.command, /memory\.reseed_reviewer\(\)/)
  } finally {
    sql(`select cron.unschedule('memory-reviewer-reseed')`)
  }
})

test("R55: Wen still connects with the reviewer on the allowlist", { skip: SKIP }, async () => {
  // Sign-up is closed here, and the allowlist holds Wen and the reviewer.
  const wen = String(sql(`select email from memory.allowed_email where plan = 'owner' and email not like 'review-%' and email not like 'other-%' order by added_at limit 1`)[0].email)
  const auth = `auth-${nonce()}`
  const page = await request('GET', `${memory.url}/oauth/consent?authorization_id=${auth}`, { timeoutMs: 30_000 })
  assert.equal(page.status, 200, page.text)
  assert.match(page.text, /email/i)
  const otps = () => memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').length
  const post = (who: string) => request('POST', `${memory.url}/oauth/consent?authorization_id=${auth}`, {
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ email: who }).toString(), timeoutMs: 30_000,
  })
  const n = otps()
  const stranger = await post(`nobody-${nonce()}@example.com`)
  assert.equal(stranger.status, 403, stranger.text)
  assert.equal(otps(), n)
  const own = await post(wen)
  assert.equal(own.status, 200, own.text)
  assert.equal(otps(), n + 1)
  assert.equal(memory.auth.calls.filter((c) => c.path === '/auth/v1/otp').at(-1)!.body.email, wen)
})
