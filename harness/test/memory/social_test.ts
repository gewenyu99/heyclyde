/**
 * The workspace's Google and GitHub sign-in, browser side (memory/proxy/social.js), run with `deno test` against a
 * stand-in window: PKCE, the state check, the 10-minute window, one use per sign-in, and where the tab lands after.
 */
import assert from 'node:assert/strict'
import { socialClient } from '../../../memory/proxy/social.js'

type Call = { url: string; init: RequestInit }

function fakeWindow(reply: () => Response = () => Response.json({ access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, user: { id: 'u1', email: 'a@example.com' } })) {
  const store = new Map<string, string>()
  const calls: Call[] = []
  const assigned: string[] = []
  const win = {
    crypto: globalThis.crypto,
    sessionStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)) },
      removeItem: (k: string) => { store.delete(k) },
    },
    location: { origin: 'https://heyclyde.me', assign: (u: string) => { assigned.push(u) } },
    fetch: (url: string, init: RequestInit) => { calls.push({ url, init }); return Promise.resolve(reply()) },
  }
  // The client is plain JS, so its results are read loosely here.
  const client: any = socialClient(win)
  return { win, store, calls, assigned, client }
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const pending = (store: Map<string, string>) => JSON.parse(store.get('clyde_social_v1') ?? 'null')

/** Starts a sign-in and returns the callback search Supabase Auth would send back for it. */
async function started(t: ReturnType<typeof fakeWindow>, provider = 'google', next = '/memories') {
  await t.client.begin(provider, next)
  return `?state=${encodeURIComponent(pending(t.store).state)}&code=auth-code-1`
}

Deno.test('begin sends the tab to Supabase Auth with an S256 challenge of a verifier only this tab keeps', async () => {
  const t = fakeWindow()
  for (const provider of ['google', 'github']) {
    await t.client.begin(provider, '/quests')
    const url = new URL(t.assigned.at(-1)!, 'https://heyclyde.me')
    const saved = pending(t.store)
    assert.equal(url.pathname, '/auth/v1/authorize')
    assert.equal(url.searchParams.get('provider'), provider)
    assert.equal(url.searchParams.get('code_challenge_method'), 's256')
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(saved.verifier)))
    assert.equal(url.searchParams.get('code_challenge'), b64url(digest))
    assert.ok(!t.assigned.at(-1)!.includes(saved.verifier), 'the verifier never leaves the tab')
    assert.equal(url.searchParams.get('redirect_to'), `https://heyclyde.me/auth/callback?state=${saved.state}`)
    assert.ok(saved.state.length >= 20 && saved.verifier.length >= 43)
    assert.equal(saved.provider, provider)
  }
})

Deno.test('begin refuses a provider Clyde does not offer and keeps nothing', async () => {
  const t = fakeWindow()
  await assert.rejects(() => t.client.begin('twitter', '/memories'), /isn't supported/)
  assert.equal(t.store.size, 0)
  assert.equal(t.assigned.length, 0)
})

Deno.test('finish trades the code with the stored verifier, once, and lands on the page that started it', async () => {
  const t = fakeWindow()
  const search = await started(t, 'github', '/entries/abc-123?x=1')
  const verifier = pending(t.store).verifier
  const res = await t.client.finish(search)
  assert.equal(res.ok, true)
  assert.equal(res.next, '/entries/abc-123?x=1')
  assert.equal(res.session.access_token, 'at-1')
  assert.equal(t.calls.length, 1)
  assert.equal(t.calls[0].url, '/auth/v1/token?grant_type=pkce')
  assert.deepEqual(JSON.parse(String(t.calls[0].init.body)), { auth_code: 'auth-code-1', code_verifier: verifier })
  assert.equal(t.store.size, 0, 'the pending sign-in is gone')
  const replay = await t.client.finish(search)
  assert.equal(replay.ok, false)
  assert.equal(replay.reason, 'missing')
  assert.equal(t.calls.length, 1, 'a replayed callback spends nothing')
})

Deno.test('a cancelled or failed provider sign-in says so and spends nothing', async () => {
  const t = fakeWindow()
  await started(t, 'google', '/quests')
  const denied = await t.client.finish('?error=access_denied&error_description=The+user+denied&state=x')
  assert.deepEqual([denied.ok, denied.reason, denied.next], [false, 'denied', '/quests'])
  assert.match(denied.message, /cancelled/)
  await started(t)
  const broken = await t.client.finish('?error=server_error&error_description=Unable+to+exchange+external+code')
  assert.deepEqual([broken.ok, broken.reason], [false, 'provider'])
  assert.match(broken.message, /Unable to exchange external code/)
  assert.equal(t.calls.length, 0)
  assert.equal(t.store.size, 0)
})

Deno.test('a callback whose state does not match, is stale or never started here is refused before the exchange', async () => {
  const t = fakeWindow()
  await started(t)
  const wrong = await t.client.finish('?state=someone-elses-state&code=attacker-code')
  assert.deepEqual([wrong.ok, wrong.reason], [false, 'state'])
  const noState = await (async () => { await started(t); return t.client.finish('?code=attacker-code') })()
  assert.deepEqual([noState.ok, noState.reason], [false, 'state'])
  const stale = await (async () => {
    const search = await started(t)
    const p = pending(t.store)
    t.store.set('clyde_social_v1', JSON.stringify({ ...p, at: Date.now() - 11 * 60 * 1000 }))
    return t.client.finish(search)
  })()
  assert.deepEqual([stale.ok, stale.reason], [false, 'expired'])
  const elsewhere = await fakeWindow().client.finish('?state=abc&code=planted-code')
  assert.deepEqual([elsewhere.ok, elsewhere.reason, elsewhere.next], [false, 'missing', '/memories'])
  const noCode = await (async () => { const s = await started(t); return t.client.finish(s.replace(/&code=[^&]*/, '')) })()
  assert.deepEqual([noCode.ok, noCode.reason], [false, 'code'])
  assert.equal(t.calls.length, 0)
})

Deno.test('a code Supabase Auth refuses ends as a failure, not a session', async () => {
  const t = fakeWindow(() => Response.json({ error: 'invalid_grant', error_description: 'invalid flow state' }, { status: 400 }))
  const res = await t.client.finish(await started(t))
  assert.deepEqual([res.ok, res.reason], [false, 'exchange'])
  const down = fakeWindow(() => { throw new Error('offline') })
  const net = await down.client.finish(await started(down))
  assert.deepEqual([net.ok, net.reason], [false, 'network'])
})

Deno.test('the page after sign-in is a workspace path on this origin, never another site', async () => {
  const t = fakeWindow()
  for (const ok of ['/memories', '/graph', '/quests?state=open', '/agents', '/apps', '/usage', '/settings', '/entries/e_12-ab']) {
    assert.equal(t.client.next(ok), ok)
  }
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example/memories', 'javascript:alert(1)', '/memories@evil.example',
    '/memories\n//evil.example', '/auth/callback', '/oauth/consent?authorization_id=x', '/memories#frag', '', null, undefined, `/memories?${'a'.repeat(600)}`]) {
    assert.equal(t.client.next(bad), '/memories', String(bad))
  }
  // A next that got into storage some other way is checked again on the way out.
  const search = await started(t)
  t.store.set('clyde_social_v1', JSON.stringify({ ...pending(t.store), next: '//evil.example' }))
  assert.equal((await t.client.finish(search)).next, '/memories')
})
