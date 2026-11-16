/**
 * R46 (#51): the Worker at memory.heyclyde.me, run with `deno test`. It asks the function for JSON on the sign-in routes
 * and renders pages from it, and serves the "connect your apps" page at /. The function is a stub here: globalThis.fetch
 * answers what each test sets, and records what the Worker sent.
 */
import assert from 'node:assert/strict'
import worker from '../../../memory/proxy/worker.js'

const ENV = { PROXY_SECRET: 'test-proxy-secret' }
type Sent = { url: string; headers: Headers }
let sent: Sent[] = []

/** The function answers every call with this response. */
function stub(reply: () => Response) {
  sent = []
  globalThis.fetch = ((input: string, init: RequestInit = {}) => {
    sent.push({ url: String(input), headers: new Headers(init.headers) })
    return Promise.resolve(reply())
  }) as typeof fetch
}

const json = (body: unknown, status = 200) => () => Response.json(body, { status })

function get(path: string, headers: Record<string, string> = { accept: 'text/html' }) {
  return worker.fetch(new Request(`https://memory.heyclyde.me${path}`, { headers }), ENV)
}

const h1 = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1].replace(/<[^>]+>/g, '').trim()

const STATES: [string, Record<string, unknown>, number, string, string][] = [
  ['check_email', { email: 'g•••••••@gmail.com' }, 200, 'Check your email', 'consent'],
  ['waiting', {}, 200, 'Waiting for confirmation', 'wait'],
  ['connected', { client: 'Claude' }, 200, 'Connected', 'approve'],
  ['refused', { client: 'Evil', callback: 'https://evil.example/cb' }, 403, 'Connection refused', 'approve'],
  ['expired', {}, 410, 'Link expired', 'wait'],
  ['error', { message: 'memory: that sign-in link didn\'t work.' }, 400, 'Sign-in failed', 'approve'],
]

Deno.test('renders each sign-in state', async () => {
  for (const [state, extra, status, title, route] of STATES) {
    stub(json({ state, message: `memory: ${state}`, ...extra }, status))
    const r = await get(`/oauth/${route}?authorization_id=abc12345`)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].headers.get('accept'), 'application/json', 'the Worker asks the function for JSON')
    assert.equal(sent[0].headers.get('x-memory-proxy'), ENV.PROXY_SECRET)
    assert.equal(r.status, status, state)
    assert.match(String(r.headers.get('content-type')), /^text\/html/, state)
    assert.equal(h1(await r.text()), title, state)
  }
})

Deno.test('escapes the app name', async () => {
  const evil = `<script>alert(1)</script>&"'`
  for (const state of ['connected', 'refused']) {
    stub(json({ state, client: evil, callback: evil, message: 'x' }, state === 'refused' ? 403 : 200))
    const html = await (await get('/oauth/approve?authorization_id=abc12345')).text()
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;'), state)
    assert.ok(!html.includes('<script>alert'), state)
  }
})

Deno.test('waiting pages advance by themselves and redirects pass through', async () => {
  for (const [state, extra, status, , route] of STATES) {
    stub(json({ state, ...extra }, status))
    const r = await get(`/oauth/${route}?authorization_id=abc12345`)
    const advances = state === 'check_email' || state === 'waiting'
    assert.equal(r.headers.get('refresh'), advances ? '3; url=/oauth/wait?authorization_id=abc12345' : null, state)
    assert.equal(r.headers.get('cache-control'), 'no-store, no-transform', state)
  }
  stub(() => new Response(null, { status: 302, headers: { location: 'https://claude.ai/api/mcp/auth_callback?code=c' } }))
  const moved = await get('/oauth/wait?authorization_id=abc12345')
  assert.equal(moved.status, 302)
  assert.equal(moved.headers.get('location'), 'https://claude.ai/api/mcp/auth_callback?code=c')
})

Deno.test('every page is locked down', async () => {
  const pages: Response[] = []
  for (const [state, extra, status, , route] of STATES) {
    stub(json({ state, ...extra }, status))
    pages.push(await get(`/oauth/${route}?authorization_id=abc12345`))
  }
  stub(json({ ok: true }))
  pages.push(await get('/'))
  for (const r of pages) {
    const csp = String(r.headers.get('content-security-policy'))
    assert.match(csp, /default-src 'none'/)
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1]
    assert.ok(nonce && nonce.length >= 16, csp)
    assert.equal(r.headers.get('x-frame-options'), 'DENY')
    assert.match(String(r.headers.get('cache-control')), /no-transform/, 'Cloudflare may not inject scripts')
    const html = await r.text()
    assert.ok(html.includes('<meta name="robots" content="noindex">'), 'memory.heyclyde.me pages carry noindex')
    assert.ok(!/<script[^>]*\ssrc=/i.test(html), 'no script loads from anywhere')
    for (const tag of html.match(/<script[^>]*>/g) ?? []) assert.ok(tag.includes(`nonce="${nonce}"`), tag)
  }
})

Deno.test('non-JSON replies pass through', async () => {
  for (const [status, body] of [[200, 'memory: plain'], [429, 'memory: too many']] as const) {
    stub(() => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } }))
    const r = await get('/oauth/consent?authorization_id=abc12345')
    assert.equal(r.status, status)
    assert.equal(await r.text(), body)
  }
  // R53: a bare 5xx becomes a 502 that says what happened, on a sign-in route as its error page.
  stub(() => new Response('boom', { status: 500, headers: { 'content-type': 'text/plain; charset=utf-8' } }))
  const failed = await get('/oauth/consent?authorization_id=abc12345')
  assert.equal(failed.status, 502)
  const page = await failed.text()
  assert.equal(h1(page), 'Sign-in failed')
  assert.ok(page.includes('status 500'), page)
  // Every other route goes to the function as it came, with the proxy's headers and no JSON ask.
  stub(json({ ok: true }))
  const r = await get('/healthz', { accept: 'text/html', 'x-memory-client': 'spoofed', 'cf-connecting-ip': '203.0.113.5' })
  assert.deepEqual(await r.json(), { ok: true })
  assert.equal(sent[0].url, 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/healthz')
  assert.equal(sent[0].headers.get('accept'), 'text/html')
  assert.equal(sent[0].headers.get('x-memory-client'), '203.0.113.5')
})

Deno.test('the home page lists every app and / still reaches the function', async () => {
  stub(json({ ok: true }))
  const r = await get('/')
  assert.equal(sent.length, 0, 'the home page needs nothing from the function')
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('content-type')), /^text\/html/)
  const html = await r.text()
  const apps = [...html.matchAll(/data-app="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(apps, ['claude-ai', 'claude-code', 'antigravity', 'gemini', 'grok', 'chatgpt', 'antigravity-cloud', 'other'])
  assert.equal(h1(html), 'Connect your apps')
  assert.ok(html.includes('https://heyclyde.me/mcp'))
  assert.ok(html.includes('curl -fsSL https://memory.heyclyde.me/install | sh'))
  assert.ok(/<div class="cl-sticky[^"]*">\s*<b>Use with caution\.<\/b>/.test(html), 'connect page carries the sticky-note warning')
  assert.ok(/ChatGPT[\s\S]*Grok|Claude,\s*ChatGPT/.test(html), 'how-it-works names ChatGPT alongside supported apps')
  for (const headers of [{ accept: 'text/html', authorization: 'Bearer x' }, { accept: 'application/json' }] as Record<string, string>[]) {
    stub(json({ ok: true }))
    const through = await get('/', headers)
    assert.equal(sent.length, 1, JSON.stringify(headers))
    assert.equal(sent[0].url, 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory')
    assert.deepEqual(await through.json(), { ok: true })
  }
})

Deno.test('the home page is small and self-contained', async () => {
  stub(json({ ok: true }))
  const html = await (await get('/')).text()
  // 42 KB since the official app logos (40,175 bytes) and the ChatGPT card (40,805 bytes) went in.
  assert.ok(new TextEncoder().encode(html).length <= 42_000, `${html.length} bytes`)
  const loads = [...html.matchAll(/<(?:script|link|img|iframe)[^>]*\s(?:src|href)="([^"]+)"/gi)].map((m) => m[1])
  for (const u of loads) assert.ok(!/^(https?:)?\/\//.test(u) && !u.startsWith('http'), `loads ${u}`)
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(html), 'no CSS loads from elsewhere')
})

// R46 with R38's open sign-up: the consent page asks for an email, and a blocked country is refused.
Deno.test('ask_email renders a form that posts back to this request, through the Worker', async () => {
  stub(json({ state: 'ask_email', message: 'memory: enter your email', post: 'https://evil.example/steal' }))
  const r = await get('/oauth/consent?authorization_id=abc12345')
  const html = await r.text()
  assert.equal(r.status, 200)
  assert.equal(h1(html), 'Sign in to Clyde')
  assert.equal(r.headers.get('refresh'), null, 'the form waits for the person, not a timer')
  assert.match(String(r.headers.get('content-security-policy')), /form-action 'self'/)
  const form = /<form[^>]*>/.exec(html)?.[0] ?? ''
  assert.match(form, /method="post"/)
  assert.match(form, /action="\/oauth\/consent\?authorization_id=abc12345"/, 'the action comes from this request, never the JSON')
  assert.ok(!html.includes('evil.example'))
  assert.match(html, /<input[^>]*type="email"[^>]*name="email"/)

  stub(json({ state: 'check_email', email: 'w••@example.com', message: 'memory: sent' }))
  const posted = await worker.fetch(new Request('https://memory.heyclyde.me/oauth/consent?authorization_id=abc12345', {
    method: 'POST', headers: { accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=w%40example.com',
  }), ENV)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.get('accept'), 'application/json')
  assert.equal(posted.status, 200)
  assert.equal(h1(await posted.text()), 'Check your email')
  assert.equal(posted.headers.get('refresh'), '3; url=/oauth/wait?authorization_id=abc12345')
})

Deno.test('a blocked country gets its own page with 451', async () => {
  stub(json({ state: 'blocked', message: "Clyde isn't available in your country." }, 451))
  const r = await get('/oauth/consent?authorization_id=abc12345')
  const html = await r.text()
  assert.equal(r.status, 451)
  assert.equal(h1(html), 'Not available in your region')
  assert.ok(html.includes('Clyde isn&#39;t available in your country.'))
  assert.equal(r.headers.get('refresh'), null)
})

Deno.test('a browser on /billing/thanks gets a page, and other callers reach the function', async () => {
  stub(json({ ok: true }))
  const r = await get('/billing/thanks')
  assert.equal(sent.length, 0)
  assert.equal(r.status, 200)
  const thanksHtml = await r.text()
  assert.equal(h1(thanksHtml), 'Subscription active')
  assert.ok(/<span class="cl-stamp cl-stamp--ok[^"]*">Paid /.test(thanksHtml), 'the subscribed ticket carries a Paid stamp')
  assert.ok(/<span class="cl-label">Subscription<\/span>/.test(thanksHtml), 'the ticket is labelled Subscription, not Sign-in')
  stub(() => new Response('memory: thanks.', { headers: { 'content-type': 'text/plain' } }))
  const plain = await get('/billing/thanks', { accept: '*/*' })
  assert.equal(sent.length, 1)
  assert.equal(await plain.text(), 'memory: thanks.')
})

// R53 (#58): listings use https://heyclyde.me/mcp. heyclyde.me hands the function /mcp and the discovery files, tells it
// which host was used, and keeps every other path, sign-in included, to the site.
const ORIGIN = 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory'
const at = (url: string, init: RequestInit = {}) => worker.fetch(new Request(url, init), ENV)

Deno.test('R53 heyclyde.me serves /mcp and nothing else of the function', async () => {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'ping' }
  for (const [path, init] of [
    ['/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(rpc) }],
    ['/.well-known/oauth-protected-resource', {}],
    ['/.well-known/oauth-protected-resource/mcp', {}],
    ['/.well-known/google-connected-apps', {}],
  ] as [string, RequestInit][]) {
    stub(json({ ok: true }))
    const r = await at(`https://heyclyde.me${path}`, init)
    assert.equal(r.status, 200, path)
    assert.equal(sent.length, 1, path)
    assert.equal(sent[0].url, ORIGIN + path)
    assert.equal(sent[0].headers.get('x-memory-host'), 'heyclyde.me', path)
  }
  for (const path of ['/', '/oauth/consent?authorization_id=abc12345', '/install']) {
    stub(json({ ok: true }))
    await at(`https://heyclyde.me${path}`, { headers: { accept: 'text/html' } })
    assert.equal(sent.length, 0, path)
  }
})

Deno.test('R53 a caller can\'t pick the host', async () => {
  stub(json({ ok: true }))
  await at('https://memory.heyclyde.me/mcp', { method: 'POST', headers: { 'x-memory-host': 'heyclyde.me', authorization: 'Bearer x' }, body: '{}' })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].headers.get('x-memory-host'), null)
})

Deno.test('R53 errors carry detail', async () => {
  const replies: (() => Response)[] = [
    () => new Response('Internal Server Error', { status: 500, headers: { 'content-type': 'text/plain' } }),
    () => { throw new TypeError('network connection lost') },
  ]
  for (const reply of replies) {
    stub(reply)
    const r = await at('https://memory.heyclyde.me/mcp', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    })
    assert.equal(r.status, 502)
    assert.match(String(r.headers.get('content-type')), /^application\/json/)
    const raw = await r.text()
    assert.ok(!raw.includes('Internal Server Error'), raw)
    const body = JSON.parse(raw)
    assert.equal(body.jsonrpc, '2.0')
    assert.ok(body.error.message.length >= 40 && body.error.message.includes('Clyde'), body.error.message)
  }
})
