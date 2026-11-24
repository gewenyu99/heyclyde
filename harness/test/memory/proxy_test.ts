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
  assert.deepEqual(apps, ['agent-setup', 'claude-ai', 'antigravity', 'grok', 'other', 'claude-code', 'gemini', 'chatgpt', 'antigravity-cloud'])
  assert.equal(h1(html), 'Connect your apps')
  assert.ok(html.includes('https://heyclyde.me/mcp'))
  assert.ok(html.includes('curl -fsSL https://heyclyde.me/install | sh'))
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

Deno.test('the home page is self-contained', async () => {
  stub(json({ ok: true }))
  const html = await (await get('/')).text()
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

Deno.test('R53 heyclyde.me serves /mcp, and since R78 the installer, and nothing else of the function', async () => {
  const rpc = { jsonrpc: '2.0', id: 1, method: 'ping' }
  for (const [path, init] of [
    ['/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer x' }, body: JSON.stringify(rpc) }],
    ['/.well-known/oauth-protected-resource', {}],
    ['/.well-known/oauth-protected-resource/mcp', {}],
    ['/.well-known/google-connected-apps', {}],
    ['/.well-known/openai-apps-challenge', {}],
    // R78: the one-command installer and its files, so `curl -fsSL https://heyclyde.me/install | sh` works.
    ['/install', {}],
    ['/install/files/clyde-hook.sh', {}],
  ] as [string, RequestInit][]) {
    stub(json({ ok: true }))
    const r = await at(`https://heyclyde.me${path}`, init)
    assert.equal(r.status, 200, path)
    assert.equal(sent.length, 1, path)
    assert.equal(sent[0].url, ORIGIN + path)
    assert.equal(sent[0].headers.get('x-memory-host'), 'heyclyde.me', path)
  }
  for (const path of ['/', '/oauth/consent?authorization_id=abc12345', '/install/check', '/install/claim/abc']) {
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

Deno.test('R55/oauth: POST /oauth/consent 303 and GET /oauth/provider 302 pass through Worker cleanly', async () => {
  stub(() => new Response(null, { status: 303, headers: { location: '/oauth/wait?authorization_id=abc12345' } }))
  const post = await at('https://memory.heyclyde.me/oauth/consent?authorization_id=abc12345', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=review%40heyclyde.me&password=pw',
  })
  assert.equal(post.status, 303)
  assert.equal(post.headers.get('location'), '/oauth/wait?authorization_id=abc12345')

  stub(() => new Response(null, { status: 302, headers: { location: 'https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/authorize?provider=google' } }))
  const prov = await at('https://memory.heyclyde.me/oauth/provider?authorization_id=abc12345&provider=google')
  assert.equal(prov.status, 302)
  assert.match(String(prov.headers.get('location')), /\/auth\/v1\/authorize\?provider=google/)

  stub(json({ state: 'blocked', message: 'memory: Clyde is not available here.' }, 451))
  const blocked = await at('https://memory.heyclyde.me/oauth/provider?authorization_id=abc12345&provider=google', {
    headers: { accept: 'text/html' },
  })
  assert.equal(blocked.status, 451)
  const html = await blocked.text()
  assert.ok(html.includes('Not available'), html)
})

Deno.test('verify passes through, GET only', async () => {
  stub(() => new Response(null, { status: 303, headers: { location: 'https://memory.heyclyde.me/oauth/approve?authorization_id=abc12345&code=pkce_1' } }))
  const ok = await at('https://memory.heyclyde.me/auth/v1/verify?token=x&type=magiclink&redirect_to=https://evil.example')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/verify?token=x&type=magiclink&redirect_to=https://evil.example')
  assert.equal(sent[0].headers.get('x-memory-proxy'), null, 'must not leak PROXY_SECRET to /auth/v1/verify')
  assert.equal(ok.status, 303)
  assert.equal(ok.headers.get('location'), 'https://memory.heyclyde.me/oauth/approve?authorization_id=abc12345&code=pkce_1')

  sent = []
  const post = await at('https://memory.heyclyde.me/auth/v1/verify?token=x&type=magiclink', { method: 'POST', body: 'x=1' })
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET')
  assert.equal(sent.length, 0)
})

Deno.test('site pages say Clyde', async () => {
  const stripVisible = (html: string) =>
    html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')

  stub(json({ ok: true }))
  const home = await at('https://heyclyde.me/')
  assert.equal(home.status, 200)
  assert.match(String(home.headers.get('content-type')), /^text\/html/)
  const homeHtml = await home.text()
  const homeTitle = /<title>([^<]*)<\/title>/i.exec(homeHtml)?.[1] ?? ''
  assert.ok(homeTitle.includes('Clyde'), homeTitle)

  for (const path of ['/memories', '/entries/note-1', '/graph', '/quests', '/agents', '/apps', '/usage', '/settings', '/invite', '/auth/callback']) {
    stub(json({ ok: true }))
    const r = await at(`https://heyclyde.me${path}`)
    assert.equal(r.status, 200, path)
    assert.match(String(r.headers.get('content-type')), /^text\/html/, path)
    assert.match(String(r.headers.get('cache-control')), /\bno-store\b/, path)
    assert.equal(sent.length, 0, path)
    const html = await r.text()
    const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? ''
    assert.ok(title.includes('Clyde'), `${path}: title ${title}`)
    assert.ok(!/\bstyle\s*=/i.test(html), `${path}: unexpected inline style attr`)
    const text = stripVisible(html)
    assert.equal(text.match(/\bmemory\b/i), null, `${path}: visible text matched /\\bmemory\\b/i`)
  }

  stub(json({ entries: [] }))
  const me = await at('https://heyclyde.me/me/entries', { headers: { authorization: 'Bearer jwt-1' } })
  assert.equal(me.status, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, `${ORIGIN}/me/entries`)
  assert.equal(sent[0].headers.get('x-memory-host'), 'heyclyde.me')

  stub(json({ access_token: 'tok-1' }))
  const tok = await at('https://heyclyde.me/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: 'anon-test' },
    body: JSON.stringify({ email: 'a@example.com', password: 'pw' }),
  })
  assert.equal(tok.status, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/token?grant_type=password')
  assert.equal(sent[0].headers.get('x-memory-proxy'), null)
  assert.equal(sent[0].headers.get('apikey'), 'anon-test')
})

// Google and GitHub sign-in on the consent page and the workspace. The buttons are design/auth.mjs's, styled by auth.css.
Deno.test('the consent page offers the providers the function names, each for this same request', async () => {
  stub(json({ state: 'ask_email', message: 'memory: enter your email', providers: ['github', 'google', 'twitter'] }))
  const html = await (await get('/oauth/consent?authorization_id=abc12345')).text()
  const links = [...html.matchAll(/<a class="cl-btn[^"]*cl-btn--provider" href="([^"]+)"/g)].map((m) => m[1])
  assert.deepEqual(links, ['/oauth/provider?authorization_id=abc12345&amp;provider=google', '/oauth/provider?authorization_id=abc12345&amp;provider=github'])
  assert.ok(html.includes('Continue with Google') && html.includes('Continue with GitHub'))
  assert.ok(!html.includes('twitter'))
  assert.ok(html.includes('.cl-btn--provider'), 'auth.css is inlined')
  stub(json({ state: 'ask_email', message: 'memory: enter your email' }))
  const none = await (await get('/oauth/consent?authorization_id=abc12345')).text()
  assert.ok(!/cl-btn--provider" href/.test(none) && !none.includes('cl-or-rule"'), 'no providers, no buttons and no rule')
})

Deno.test('a cancelled or failed provider sign-in goes back to this request\'s sign-in page and nowhere else', async () => {
  stub(json({ state: 'denied', message: 'memory: sign-in was cancelled at the provider. Nothing was shared.', retry: true }, 400))
  const r = await get('/oauth/approve?authorization_id=abc12345&direct=1&error=access_denied')
  const html = await r.text()
  assert.equal(r.status, 400)
  assert.equal(h1(html), 'Sign-in cancelled')
  assert.ok(html.includes('href="/oauth/consent?authorization_id=abc12345">Back to sign-in</a>'), html)
  stub(json({ state: 'error', message: "memory: that sign-in didn't start in this browser.", retry: true }, 403))
  const elsewhere = await (await get('/oauth/approve?authorization_id=abc12345&direct=1')).text()
  assert.equal(h1(elsewhere), 'Sign-in failed')
  assert.ok(elsewhere.includes('Back to sign-in'))
  // The link is built from this request's id, never from the JSON, and only with retry: true.
  stub(json({ state: 'error', message: 'memory: x', retry: 'https://evil.example' }, 400))
  assert.ok(!(await (await get('/oauth/approve?authorization_id=abc12345&direct=1')).text()).includes('Back to sign-in'))
  stub(json({ state: 'error', message: 'memory: x', retry: true }, 400))
  const badId = await (await get('/oauth/approve?authorization_id=x')).text()
  assert.ok(!badId.includes('Back to sign-in'), 'no id, no link')
})

Deno.test('the function\'s sign-in cookie survives the Worker, on redirects and on rendered pages', async () => {
  const cookie = '__Host-clyde_oauth=abc12345.bind; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax'
  stub(() => new Response(null, { status: 302, headers: { location: 'https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/authorize?provider=github', 'set-cookie': cookie } }))
  const start = await get('/oauth/provider?authorization_id=abc12345&provider=github')
  assert.equal(start.status, 302)
  assert.equal(start.headers.get('set-cookie'), cookie)
  const clear = '__Host-clyde_oauth=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  stub(() => Response.json({ state: 'denied', message: 'memory: cancelled', retry: true }, { status: 400, headers: { 'set-cookie': clear } }))
  const page = await get('/oauth/approve?authorization_id=abc12345&direct=1&error=access_denied')
  assert.match(String(page.headers.get('content-type')), /^text\/html/)
  assert.equal(page.headers.get('set-cookie'), clear)
  stub(() => new Response(null, { status: 303, headers: { location: '/oauth/wait?authorization_id=abc12345' } }))
  await get('/oauth/approve?authorization_id=abc12345&direct=1&bind=b&code=c', { accept: 'text/html', cookie: 'x=1; __Host-clyde_oauth=abc12345.b' })
  assert.equal(sent[0].headers.get('cookie'), 'x=1; __Host-clyde_oauth=abc12345.b', 'the browser\'s cookie reaches the function')
})

Deno.test('heyclyde.me passes the workspace\'s provider calls to Supabase Auth, GET only', async () => {
  const to = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x'
  stub(() => new Response(null, { status: 302, headers: { location: to } }))
  const q = '?provider=google&redirect_to=https%3A%2F%2Fheyclyde.me%2Fauth%2Fcallback%3Fstate%3Ds&code_challenge=c&code_challenge_method=s256'
  const go = await at(`https://heyclyde.me/auth/v1/authorize${q}`)
  assert.equal(go.status, 302)
  assert.equal(go.headers.get('location'), to)
  // The Worker may look up the anon key first, so the Auth call is the last one sent.
  assert.equal(sent.at(-1)!.url, `https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/authorize${q}`)
  assert.equal(sent.at(-1)!.headers.get('x-memory-proxy'), null)
  stub(json({ external: { google: true, github: false } }))
  const settings = await at('https://heyclyde.me/auth/v1/settings')
  assert.deepEqual(await settings.json(), { external: { google: true, github: false } })
  assert.equal(sent.at(-1)!.url, 'https://wlhlncmgjqyidosunugv.supabase.co/auth/v1/settings')
  for (const path of ['/auth/v1/authorize', '/auth/v1/settings']) {
    stub(json({ ok: true }))
    const post = await at(`https://heyclyde.me${path}`, { method: 'POST', body: '{}' })
    assert.equal(post.status, 405, path)
    assert.equal(sent.length, 0, path)
  }
})

Deno.test('the workspace sign-in carries the provider buttons and the callback page finishes the sign-in', async () => {
  stub(json({ ok: true }))
  const html = await (await at('https://heyclyde.me/memories')).text()
  assert.ok(html.includes('Continue with Google') && html.includes('Continue with GitHub'), 'buttons ship in the script, shown once /auth/v1/settings says so')
  assert.ok(html.includes('/auth/v1/settings') && html.includes('/auth/v1/authorize') && html.includes('grant_type=pkce'))
  assert.ok(html.includes('.cl-btn--provider'), 'auth.css is inlined')
  assert.ok(html.includes('.app-nav .cl-nav__item{width:auto;flex:none}'), 'workspace nav tabs stay horizontal on desktop')
  const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? ''
  assert.ok(script.includes('function __name(f) { return f; }'), 'esbuild keep_names __name helper is defined before socialClient')
  assert.doesNotThrow(() => new Function(script), 'the page script, provider client included, parses')
  // Simulate Wrangler/esbuild keep_names injecting __name(...) inside socialClient.toString()
  const esbuildScript = script.replace('function next(raw) {', 'function next(raw) {').replace(/var social = \(([\s\S]*?)\)\(window\);/, (_, fn) =>
    `var social = (${fn.replace(/return\s*\{\s*begin:/, '__name(next, "next"); return { begin:')})(window);`)
  const els: Record<string, any> = {
    'app-root': { getAttribute: (k: string) => k === 'data-view' ? 'usage' : '', innerHTML: '' },
    'app-user-bar': { innerHTML: '' },
    'sign-providers': { innerHTML: '', classList: { remove() {}, add() {} }, querySelectorAll: () => [] },
    'btn-toggle-pw': { addEventListener() {} },
    'otp-req': { addEventListener() {} },
    'otp-verify': { addEventListener() {} },
    'pw-form': { addEventListener() {}, classList: { toggle() {} } },
  }
  const docStub = {
    getElementById: (id: string) => els[id] ?? { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } },
    querySelectorAll: () => [],
  }
  const winStub: any = { location: { origin: 'https://heyclyde.me', pathname: '/usage', search: '', hash: '' } }
  assert.doesNotThrow(() =>
    new Function('document', 'window', 'location', 'localStorage', 'history', 'fetch', esbuildScript)(
      docStub, winStub, winStub.location, { getItem: () => null, removeItem() {}, setItem() {} },
      { replaceState() {} }, () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
    )
  )
  assert.ok(els['app-root'].innerHTML.includes('Sign in to Clyde'), 'APP_JS renders sign-in UI with esbuild __name present')
  assert.ok(!/<script[^>]*>[^<]*<\/script>[\s\S]*\son[a-z]+=/i.test(html), 'no inline event handlers')
  const cb = await at('https://heyclyde.me/auth/callback?state=s&code=c')
  assert.equal(cb.status, 200)
  assert.match(String(cb.headers.get('cache-control')), /no-store/)
  assert.match(String(cb.headers.get('content-security-policy')), /connect-src 'self'/)
  assert.match(await cb.text(), /data-view="callback"/)
})

Deno.test('Quest #41: auth proxy forces create_user=false on /auth/v1/otp, enforces methods, and blocks restricted regions', async () => {
  let lastBody = ''
  globalThis.fetch = ((input: string, init: RequestInit = {}) => {
    sent.push({ url: String(input), headers: new Headers(init.headers) })
    lastBody = typeof init.body === 'string' ? init.body : ''
    return Promise.resolve(Response.json({ ok: true }))
  }) as typeof fetch

  sent = []
  const otp = await worker.fetch(new Request('https://heyclyde.me/auth/v1/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new@example.com', create_user: true, CREATE_USER: true, extra: 1 }),
  }), { ...ENV, SUPABASE_ANON_KEY: 'anon-test' })
  assert.equal(otp.status, 200)
  assert.deepEqual(JSON.parse(lastBody), { email: 'new@example.com', create_user: false }, 'allowlisted body drops case-variant bypass keys')

  sent = []
  const tooBig = await worker.fetch(new Request('https://heyclyde.me/auth/v1/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'a@example.com', pad: 'x'.repeat(5000) }),
  }), { ...ENV, SUPABASE_ANON_KEY: 'anon-test' })
  assert.equal(tooBig.status, 413)
  assert.equal(sent.length, 0)

  sent = []
  const badJson = await worker.fetch(new Request('https://heyclyde.me/auth/v1/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  }), { ...ENV, SUPABASE_ANON_KEY: 'anon-test' })
  assert.equal(badJson.status, 400)
  assert.equal(sent.length, 0)

  const wrongMethod = await worker.fetch(new Request('https://heyclyde.me/auth/v1/otp', { method: 'GET' }), ENV)
  assert.equal(wrongMethod.status, 405)

  for (const cf of [{ country: 'FR' }, { country: 'GB' }, { country: 'T1' }, { country: 'XX' }, { country: 'CA', regionCode: 'QC' }, { country: 'US', regionCode: 'CA-QC' }]) {
    sent = []
    const req = new Request('https://heyclyde.me/auth/v1/otp', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'eu@example.com' }),
    })
    Object.defineProperty(req, 'cf', { value: cf })
    const blocked = await worker.fetch(req, { ...ENV, SUPABASE_ANON_KEY: 'anon-test' })
    assert.equal(blocked.status, 451, JSON.stringify(cf))
    assert.equal(sent.length, 0, JSON.stringify(cf))
  }

  for (const [target, method] of [['https://heyclyde.me/auth/v1/token?grant_type=pkce', 'POST'], ['https://heyclyde.me/auth/v1/verify', 'GET'], ['https://memory.heyclyde.me/auth/v1/verify', 'GET']] as const) {
    sent = []
    const req = new Request(target, { method })
    Object.defineProperty(req, 'cf', { value: { country: 'FR' } })
    const blocked = await worker.fetch(req, { ...ENV, SUPABASE_ANON_KEY: 'anon-test' })
    assert.equal(blocked.status, 451, target)
    assert.equal(sent.length, 0, target)
  }
})

Deno.test('Quest #37: confirm_allow, POST /oauth/approve, and denied state render safely through Worker', async () => {
  const allowCookie = '__Host-clyde_allow=abc12345.bindtok; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax'
  stub(() => Response.json({
    state: 'confirm_allow',
    message: 'memory: Allow ChatGPT to use your Clyde? Callback: chatgpt.com.',
    client: 'ChatGPT',
    callback: 'https://chatgpt.com/connector/oauth/attacker',
    callback_host: 'chatgpt.com',
    email: 'wen@example.com',
    decision_token: 'formtok-123',
  }, { status: 200, headers: { 'set-cookie': allowCookie } }))
  const page = await get('/oauth/approve?authorization_id=abc12345&code=c1')
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('set-cookie'), allowCookie)
  assert.equal(page.headers.get('cache-control'), 'no-store, no-transform')
  const html = await page.text()
  assert.ok(html.includes('Allow <strong>ChatGPT</strong> to use your Clyde?'), html)
  assert.ok(html.includes('<code>chatgpt.com</code>') && html.includes('<code>https://chatgpt.com/connector/oauth/attacker</code>'), html)
  assert.ok(html.includes('<strong>wen@example.com</strong>'), html)
  assert.ok(html.includes('action="/oauth/approve?authorization_id=abc12345"'), html)
  assert.ok(html.includes('name="decision_token" value="formtok-123"'), html)
  assert.ok(html.includes('name="decision" value="allow"') && html.includes('name="decision" value="deny"'), html)

  const clearAllow = '__Host-clyde_allow=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax'
  stub(() => new Response(null, { status: 303, headers: { location: '/oauth/wait?authorization_id=abc12345', 'set-cookie': clearAllow } }))
  const post = await at('https://memory.heyclyde.me/oauth/approve?authorization_id=abc12345', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '__Host-clyde_allow=abc12345.bindtok' },
    body: 'decision=allow&decision_token=formtok-123',
  })
  assert.equal(post.status, 200)
  assert.equal(post.headers.get('refresh'), '0; url=/oauth/wait?authorization_id=abc12345')
  assert.equal(post.headers.get('set-cookie'), clearAllow)
  const postHtml = await post.text()
  assert.ok(postHtml.includes('location.replace("/oauth/wait?authorization_id=abc12345")'), postHtml)
  assert.equal(sent[0].headers.get('cookie'), '__Host-clyde_allow=abc12345.bindtok')
  assert.equal(sent[0].headers.get('accept'), 'application/json')

  stub(json({ state: 'denied', message: 'memory: denied ChatGPT. Nothing was shared.', client: 'ChatGPT' }))
  const denied = await at('https://memory.heyclyde.me/oauth/approve?authorization_id=abc12345', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: '__Host-clyde_allow=abc12345.bindtok' },
    body: 'decision=deny&decision_token=formtok-123',
  })
  assert.equal(denied.status, 200)
  const deniedHtml = await denied.text()
  assert.ok(deniedHtml.includes('Connection denied'), deniedHtml)
  assert.ok(deniedHtml.includes('<strong>ChatGPT</strong>'), deniedHtml)
})

Deno.test('invite page uses brain copy and preserves partner code across every auth method', async () => {
  const res = await at('https://heyclyde.me/invite?code=partner-test1234')
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.ok(html.includes('One brain for every agent'), 'expected brain stamp copy')
  assert.equal(/\bnotebook\b/i.test(html), false, 'unexpected notebook wording on /invite')
  assert.ok(html.includes('/auth/v1/otp?redirect_to='), 'OTP sign-in passes redirect_to query param')
  assert.ok(html.includes('localStorage.setItem(INV_PENDING_KEY'), 'pending invite persists in localStorage')
  assert.ok(html.includes("sp0.get('invite') || sp0.get('code')"), 'start() accepts both invite and code params')
})

Deno.test('Round 1B: OAuth error accessibility, password toggle, Check now, recovery docs, and workspace core', async () => {
  // ask_email without error: autofocus, password field in details with Show/Hide toggle, script runs even without Turnstile
  stub(json({ state: 'ask_email', message: 'memory: enter your email' }))
  const askHtml = await (await get('/oauth/consent?authorization_id=abc12345')).text()
  assert.ok(askHtml.includes('<a class="cl-skip" href="#main">Skip to content</a>'), 'OAuth page has skip link')
  assert.ok(askHtml.includes('<main id="main" tabindex="-1" class="sign">'), 'OAuth main has id=main tabindex=-1')
  assert.ok(askHtml.includes('id="email" type="email" name="email" autocomplete="email" required autofocus'), 'email has autofocus initially')
  assert.ok(askHtml.includes('<details class="cl-field"><summary>Have a password?</summary><div class="cl-field"><label for="password">Password</label><div class="cl-pw-wrap">') && askHtml.includes('id="toggle-pw"'), 'password toggle inside details')
  assert.ok(askHtml.includes("getElementById('toggle-pw')") && askHtml.includes('pageshow'), 'ask_email emits interaction script without Turnstile')

  // ask_email with error: drops autofocus, links #ask-error via aria-describedby & aria-invalid
  stub(json({ state: 'ask_email', error: 'Bad email', email: 'bad@example.com' }))
  const errHtml = await (await get('/oauth/consent?authorization_id=abc12345')).text()
  assert.ok(errHtml.includes('<p class="cl-error" id="ask-error" role="alert" tabindex="-1">Bad email</p>'), 'ask-error has alert role and tabindex=-1')
  assert.ok(errHtml.includes('aria-describedby="ask-error" aria-invalid="true"') && !/id="email"[^>]*autofocus/.test(errHtml), 'email drops autofocus and points to #ask-error')

  // check_email & waiting: Check now manual refresh link alongside Refresh: 3
  for (const [state, route] of [['check_email', 'consent'], ['waiting', 'wait']] as const) {
    stub(json({ state, email: 'a@example.com' }))
    const r = await get(`/oauth/${route}?authorization_id=abc12345`)
    assert.equal(r.headers.get('refresh'), '3; url=/oauth/wait?authorization_id=abc12345')
    const html = await r.text()
    assert.ok(html.includes('href="/oauth/wait?authorization_id=abc12345">Check now</a>'), `${state}: Check now link`)
  }

  // refused & expired without retry: Open setup docs link
  for (const [state, status, route] of [['refused', 403, 'approve'], ['expired', 410, 'wait']] as const) {
    stub(json({ state }, status))
    const html = await (await get(`/oauth/${route}?authorization_id=abc12345`)).text()
    assert.ok(html.includes('href="https://heyclyde.me/docs">Open setup docs</a>'), `${state}: Open setup docs link`)
  }

  // confirm_allow emits double-submit guard script
  stub(json({ state: 'confirm_allow', client: 'Claude', decision_token: 't1' }))
  const allowHtml = await (await get('/oauth/approve?authorization_id=abc12345')).text()
  assert.ok(allowHtml.includes("getElementById('allow')") && allowHtml.includes('setTimeout(function()') && allowHtml.includes('pageshow'), 'confirm_allow guards double submit')

  // Workspace authenticated views: usage meter formatting/status chips, entry breadcrumb, and Retry recovery card
  const appRes = await at('https://heyclyde.me/usage')
  const appHtml = await appRes.text()
  assert.ok(appHtml.includes('<a class="cl-skip" href="#main">Skip to content</a>') && appHtml.includes('<main id="main" tabindex="-1" class="wrap app-wrap">'), 'workspace skip link')
  assert.ok(appHtml.includes('sign-prov-skel') && appHtml.includes('aria-controls="onb-panel"') && appHtml.includes('ArrowRight'), 'CLS skeleton & accessible onboarding tabs')
  const appScript = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(appHtml)?.[1] ?? ''
  const runView = async (view: string, id: string, fetchImpl: (url: string) => Promise<unknown>) => {
    const els: Record<string, any> = {
      'app-root': { getAttribute: (k: string) => k === 'data-view' ? view : (k === 'data-id' ? id : ''), innerHTML: '' },
      'app-user-bar': { innerHTML: '' },
      'u-summary': { innerHTML: '' },
      'u-meters': { innerHTML: '' },
    }
    const docStub = { getElementById: (k: string) => els[k] ?? { addEventListener() {}, classList: { add() {}, remove() {}, toggle() {} } }, querySelectorAll: () => [] }
    const winStub: any = { location: { origin: 'https://heyclyde.me', pathname: '/usage', search: '', hash: '' } }
    const session = JSON.stringify({ access_token: 'tok-1', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 600_000 })
    new Function('document', 'window', 'location', 'localStorage', 'history', 'fetch', appScript)(
      docStub, winStub, winStub.location, { getItem: (k: string) => k === 'clyde_session_v1' ? session : null, removeItem() {}, setItem() {} },
      { replaceState() {} }, fetchImpl,
    )
    await new Promise((r) => setTimeout(r, 10))
    return els
  }
  const usageEls = await runView('usage', '', async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      plan: 'starter', state: 'paid', period: '2026-11', overage: false,
      meters: [
        { kind: 'egress_bytes', used: 85 * 1024 * 1024, included: 100 * 1024 * 1024, overage_cents: 0 },
        { kind: 'db_bytes', used: 10 * 1024 * 1024, included: 10 * 1024 * 1024, overage_cents: 0 },
      ],
    }),
  }))
  assert.ok(usageEls['u-meters'].innerHTML.includes('85.0 MB / 100.0 MB (85%)') && usageEls['u-meters'].innerHTML.includes('Near limit') && usageEls['u-meters'].innerHTML.includes('meter-bar--warn'), 'usage renders byte units + Near limit warning')
  assert.ok(usageEls['u-meters'].innerHTML.includes('10.0 MB / 10.0 MB (100%)') && usageEls['u-meters'].innerHTML.includes('At limit') && usageEls['u-meters'].innerHTML.includes('meter-bar--bad'), 'usage renders At limit danger')

  const overageEls = await runView('usage', '', async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({
      plan: 'clyde', state: 'paid', period: '2026-11', overage: true, spend_limit_cents: 1000,
      meters: [{ kind: 'requests', used: 1200, included: 1000, overage_cents: 45 }, { kind: 'db_bytes', used: 1024, included: 0, overage_cents: 0 }],
    }),
  }))
  assert.ok(overageEls['u-meters'].innerHTML.includes('Over included') && !overageEls['u-meters'].innerHTML.includes('At limit') && overageEls['u-meters'].innerHTML.includes('no separate cap'), 'usage distinguishes overage from hard stop and unmetered db_bytes')

  const entryErrEls = await runView('entry', 'e-9', async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'DB unavailable' }) }))
  assert.ok(entryErrEls['app-root'].innerHTML.includes('role="alert"') && entryErrEls['app-root'].innerHTML.includes('DB unavailable') && entryErrEls['app-root'].innerHTML.includes('Retry'), 'entry detail shows Retry recovery card on error')

  const entryOkEls = await runView('entry', 'e-9', async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify({ entry: { id: 'e-9', title: 'Test note', body: 'Hello', pattern: 'decisions', confidence: 0.9 } }),
  }))
  assert.ok(entryOkEls['app-root'].innerHTML.includes('aria-label="Breadcrumb"') && entryOkEls['app-root'].innerHTML.includes('href="/memories">Notes</a>') && entryOkEls['app-root'].innerHTML.includes('Test note'), 'entry detail renders accessible breadcrumb')
})

Deno.test('Phase B: COPY_JS, ASK_JS, quests, agents, onboarding details, pagination, and zero visible memory copy', async () => {
  // COPY_JS restores original data-label and activeElement without scroll jump
  const docsHtml = await (await at('https://heyclyde.me/docs')).text()
  assert.ok(docsHtml.includes('data-label') && docsHtml.includes("a.style.position='fixed';a.style.top='0';a.style.left='0'") && docsHtml.includes('preventScroll:true'), 'COPY_JS preserves button label and focus cleanly')

  // ASK_JS focuses #ask-error on load, ignores modified provider clicks, and resets Turnstile on persisted pageshow
  stub(json({ state: 'ask_email', error: 'Bad email', email: 'bad@example.com' }))
  const errHtml = await (await get('/oauth/consent?authorization_id=abc12345')).text()
  assert.ok(errHtml.includes("var ae=document.getElementById('ask-error');if(ae&&typeof ae.focus==='function')ae.focus();"), 'ASK_JS focuses #ask-error on load')
  assert.ok(errHtml.includes('e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0'), 'ASK_JS ignores modified provider clicks')
  assert.ok(errHtml.includes('e&&e.persisted&&window.turnstile&&window.turnstile.reset'), 'ASK_JS resets Turnstile on persisted pageshow')
  assert.ok(errHtml.includes('.is-failed{cursor:not-allowed}'), 'ASK_JS styles failed Turnstile button with not-allowed cursor')

  // Execute workspace views with auto-vivifying stubs
  const appHtml = await (await at('https://heyclyde.me/memories')).text()
  const appScript = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(appHtml)?.[1] ?? ''
  const runApp = async (view: string, id: string, fetchImpl: (url: string) => Promise<unknown>, opts: { search?: string } = {}) => {
    const els: Record<string, any> = {}
    const mk = (extra: any = {}) => ({
      innerHTML: '', textContent: '', value: '', checked: false, className: '',
      listeners: {} as Record<string, Function[]>,
      addEventListener(ev: string, fn: Function) { (this.listeners[ev] ??= []).push(fn) },
      setAttribute() {}, removeAttribute() {}, focus() {}, contains: () => false,
      closest: () => null, querySelector: () => null, querySelectorAll: () => [],
      classList: { add() {}, remove() {}, toggle() {} },
      ...extra,
    })
    els['app-root'] = mk({ getAttribute: (k: string) => k === 'data-view' ? view : (k === 'data-id' ? id : '') })
    els['app-user-bar'] = mk()
    const docStub: any = {
      getElementById: (k: string) => (els[k] ??= mk()),
      querySelectorAll: () => [],
    }
    const winStub: any = { location: { origin: 'https://heyclyde.me', pathname: `/${view}`, search: opts.search ?? '', hash: '' } }
    const session = JSON.stringify({ access_token: 'tok-1', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 600_000 })
    new Function('document', 'window', 'location', 'localStorage', 'history', 'fetch', appScript)(
      docStub, winStub, winStub.location,
      { getItem: (k: string) => k === 'clyde_session_v1' ? session : null, removeItem() {}, setItem() {} },
      { replaceState() {} }, fetchImpl,
    )
    await new Promise((r) => setTimeout(r, 20))
    return { els, winStub }
  }

  // Quests Retry spans full grid (#q-board loses app-cols-3)
  const { els: qErrEls } = await runApp('quests', '', async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: 'Boom' }) }))
  assert.equal(qErrEls['q-board'].className, 'app-grid', 'quest error resets #q-board to full-width app-grid')
  assert.ok(qErrEls['q-board'].innerHTML.includes('role="alert"') && qErrEls['q-board'].innerHTML.includes('Retry'), 'quest board renders Retry recovery card')

  // Quests render semantic stamps, tags, evidence, lease/closed metadata, and descriptive aria-label
  const { els: qOkEls } = await runApp('quests', '', async (url: string) => {
    if (url.includes('/me/quests')) {
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          quests: [
            { id: 7, state: 'open', priority: 'high', title: 'Ship tests', brief: 'Cover Phase B', done_when: 'All green', tags: ['ui'], assignee: 'codex' },
            { id: 8, state: 'claimed', priority: 'normal', title: 'Check logs', brief: 'Inspect traces', done_when: 'Zero 500s', claimed_by: 'claude', lease_until: '2026-11-24T00:00:00Z' },
            { id: 9, state: 'done', priority: 'normal', title: 'Build CSS', brief: 'Run build script', done_when: 'Synced', evidence: 'Commit abc123', closed_at: '2026-11-23T12:00:00Z' },
          ],
        }),
      }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ agents: [] }) }
  })
  assert.ok(qOkEls['col-open'].innerHTML.includes('cl-stamp--carbon') && qOkEls['col-open'].innerHTML.includes('aria-label="Copy claim prompt for quest #7: Ship tests"'), 'open quest renders semantic stamp and contextual label')
  assert.ok(qOkEls['col-claimed'].innerHTML.includes('cl-stamp--warn') && qOkEls['col-claimed'].innerHTML.includes('Lease until'), 'claimed quest renders lease timestamp')
  assert.ok(qOkEls['col-done'].innerHTML.includes('cl-stamp--ok') && qOkEls['col-done'].innerHTML.includes('Evidence:') && qOkEls['col-done'].innerHTML.includes('Commit abc123'), 'done quest surfaces evidence and closed timestamp')

  // Agents error resets when unauthenticated auth error happens cleanly without double render
  const { els: agOkEls } = await runApp('agents', '', async (url: string) => {
    if (url.includes('/me/onboarding')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: 1, entries: 1, recalls: 1, devices: 1 }) }
    if (url.includes('/me/agents')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: [{ name: 'claude', context: 'work', computer: 'mac-1', last_seen: '2026-11-23T12:00:00Z' }] }) }
    return { ok: true, status: 200, text: async () => JSON.stringify({ devices: [{ name: 'mbp', hooks: 'full', client_version: '1.4.0', last_seen: '2026-11-23T12:00:00Z' }] }) }
  })
  assert.ok(agOkEls['ag-list'].innerHTML.includes('Context: work') && agOkEls['ag-list'].innerHTML.includes('Host: mac-1'), 'agent card renders context and host')
  assert.ok(agOkEls['dev-list'].innerHTML.includes('v1.4.0') && agOkEls['dev-list'].innerHTML.includes('Seen '), 'device card renders client_version and last_seen')

  // Entries view fetches limit=50, surfaces Private/Confidential chip, and has zero /\bmemory\b/i in visible text
  let lastEntriesUrl = ''
  const { els: entEls } = await runApp('entries', '', async (url: string) => {
    if (url.includes('/me/onboarding')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: 1, entries: 1, recalls: 1, devices: 1 }) }
    lastEntriesUrl = url
    return {
      ok: true, status: 200,
      text: async () => JSON.stringify({
        total: 120,
        entries: [{ id: 'n-1', title: 'Token rule', body: 'Always store safely', kind: 'rule', pattern: 'decisions', sensitivity: 'private', confidence: 0.9 }],
      }),
    }
  })
  assert.ok(lastEntriesUrl.includes('limit=50'), 'entries view fetches limit=50 by default')
  assert.ok(entEls['entries-list'].innerHTML.includes('Private') && entEls['entries-pager'].innerHTML.includes('Next'), 'entries renders sensitivity chip and pagination')

  // Visible text in APP_JS UI markup never contains \bmemory\b (strip CSS/URL identifiers inside template strings)
  assert.ok(!appScript.includes('memory note') && !appScript.includes('Loading memory'), 'workspace UI uses note copy instead of memory')
  assert.ok(appHtml.includes('details && det.open') || appHtml.includes('det && det.open'), 'onboarding preserves details open state across tab switches')
})

Deno.test('Round 3: concurrent refreshSession deduplication, shared invite banners, focus restoration, ARIA, and CSS fixes', async () => {
  // 1. CSS & HTML contracts on connect page, workspace pages, and /docs
  const connectHtml = await (await get('/')).text()
  const appsHeadIdx = connectHtml.indexOf('.apps-head{display:grid')
  const appsHeadMqIdx = connectHtml.indexOf('@media (max-width:860px){.apps-head{grid-template-columns:minmax(0,1fr)}}')
  assert.ok(appsHeadIdx > 0 && appsHeadMqIdx > appsHeadIdx, 'mobile @media (max-width:860px) .apps-head rule follows desktop .apps-head rule')
  assert.ok(connectHtml.includes('.apps{columns:2 380px'), 'connect page keeps .apps columns layout')

  const docsHtml = await (await at('https://heyclyde.me/docs')).text()
  const h1End = docsHtml.indexOf('</h1>')
  const h2Choose = docsHtml.indexOf('<h2 class="cl-sr-only">Choose an app</h2>')
  const firstH3 = docsHtml.indexOf('<h3 class="cl-title-3">')
  assert.ok(h1End > 0 && h2Choose > h1End && firstH3 > h2Choose, '/docs includes sr-only h2 before h3 app cards')

  const appHtml = await (await at('https://heyclyde.me/memories')).text()
  const appScript = /<script nonce="[^"]+">([\s\S]*?)<\/script>/.exec(appHtml)?.[1] ?? ''
  assert.ok(appHtml.includes('<div id="app-invite-banner" class="is-hidden"></div>'), 'workspace shell renders shared invite banner container')
  assert.ok(appHtml.includes('.gr-chip-btn[data-edge-type]:not(.is-on){text-decoration:line-through}') && !appHtml.includes('.gr-chip-btn:not(.is-on){opacity:.48'), '/graph toggled-off chips drop opacity:.48 and scope line-through to edge buttons')
  assert.ok(appHtml.includes('.gr-node:focus-visible circle.gr-vis{stroke:var(--cl-ink)') && appHtml.includes('.gr-node:focus-visible circle.gr-hit{stroke:var(--cl-carbon)'), 'graph node focus ring contrasts against decisions blue')
  assert.ok(appHtml.includes('a.cl-chip--warn') || appHtml.includes('Replaced by'), 'entry view renders superseded chip')

  // Helper to run APP_JS with stateful DOM + localStorage + focus tracking
  function makeHarness(view: string, id: string, opts: { search?: string; session?: Record<string, unknown> | null; store?: Record<string, string>; fetchImpl: (url: string, init?: RequestInit) => Promise<unknown> }) {
    const store: Record<string, string> = opts.store ?? {}
    if (opts.session) store['clyde_session_v1'] = JSON.stringify(opts.session)
    let activeEl: any = null
    const els: Record<string, any> = {}
    const mk = (extra: Record<string, unknown> = {}) => {
      const attrs: Record<string, string> = {}
      const node: any = {
        innerHTML: '', textContent: '', value: '', checked: false, disabled: false, className: '', isConnected: true,
        attrs,
        listeners: {} as Record<string, Function[]>,
        childrenNodes: [] as any[],
        parentElement: null as any,
        addEventListener(ev: string, fn: Function) { (this.listeners[ev] ??= []).push(fn) },
        removeEventListener() {},
        setAttribute(k: string, v: string) { attrs[k] = String(v) },
        getAttribute(k: string) { return attrs[k] ?? null },
        hasAttribute(k: string) { return k in attrs },
        removeAttribute(k: string) { delete attrs[k] },
        focus() { activeEl = this },
        contains(target: any) { return target === this || this.childrenNodes.includes(target) },
        closest: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        scrollIntoView() {},
        checkValidity: () => true,
        classList: {
          set: new Set<string>(),
          add(c: string) { this.set.add(c) },
          remove(c: string) { this.set.delete(c) },
          toggle(c: string, force?: boolean) { const on = force === undefined ? !this.set.has(c) : force; if (on) this.set.add(c); else this.set.delete(c); return on },
        },
        ...extra,
      }
      return node
    }
    els['app-root'] = mk({ getAttribute: (k: string) => k === 'data-view' ? view : (k === 'data-id' ? id : null) })
    els['app-user-bar'] = mk()
    els['app-invite-banner'] = mk()
    els['main'] = mk()
    const docStub: any = {
      get activeElement() { return activeEl },
      body: mk(),
      getElementById: (k: string) => (els[k] ??= mk()),
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    }
    const winStub: any = { location: { origin: 'https://heyclyde.me', pathname: `/${view}`, search: opts.search ?? '', hash: '' } }
    const storageStub = {
      getItem: (k: string) => (k in store ? store[k] : null),
      setItem: (k: string, v: string) => { store[k] = String(v) },
      removeItem: (k: string) => { delete store[k] },
    }
    new Function('document', 'window', 'location', 'localStorage', 'history', 'fetch', appScript)(
      docStub, winStub, winStub.location, storageStub, { replaceState() {} }, opts.fetchImpl,
    )
    return { els, store, getActive: () => activeEl, mk }
  }

  // 2a. Concurrent proactive refreshSession deduplication (3 concurrent /me/* calls on expired session)
  let refreshCalls = 0
  const seenAuthHeaders: string[] = []
  const hProactive = makeHarness('agents', '', {
    session: { access_token: 'at-old', refresh_token: 'rt-0', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() - 5000 },
    fetchImpl: async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        refreshCalls++
        await new Promise((r) => setTimeout(r, 15))
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'at-new', refresh_token: 'rt-1', expires_in: 3600, user: { id: 'u-1', email: 'a@example.com' } }),
        }
      }
      seenAuthHeaders.push(String((init?.headers as any)?.authorization ?? ''))
      if (url.includes('/me/onboarding')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: 1, entries: 1, recalls: 1, devices: 1 }) }
      if (url.includes('/me/agents')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: [] }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ devices: [] }) }
    },
  })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(refreshCalls, 1, '3 concurrent near-expiry api() calls only call /auth/v1/token once')
  assert.deepEqual(seenAuthHeaders, ['Bearer at-new', 'Bearer at-new', 'Bearer at-new'], 'all concurrent api() calls use rotated access token')
  assert.equal(JSON.parse(hProactive.store['clyde_session_v1']).refresh_token, 'rt-1', 'rotated refresh token persists in storage')

  // 2b. Concurrent 401 retry race (all 3 requests initially hit 401 with old token, single refresh rotates once, all 3 retry & succeed)
  let refresh401Calls = 0
  const retriedAuth: string[] = []
  const h401 = makeHarness('agents', '', {
    session: { access_token: 'at-old', refresh_token: 'rt-0', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 600_000 },
    fetchImpl: async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        refresh401Calls++
        await new Promise((r) => setTimeout(r, 15))
        return {
          ok: true, status: 200,
          json: async () => ({ access_token: 'at-rot', refresh_token: 'rt-rot', expires_in: 3600, user: { id: 'u-1', email: 'a@example.com' } }),
        }
      }
      const auth = String((init?.headers as any)?.authorization ?? '')
      if (auth === 'Bearer at-old') {
        return { ok: false, status: 401, text: async () => JSON.stringify({ error: 'expired' }) }
      }
      retriedAuth.push(auth)
      if (url.includes('/me/onboarding')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: 1, entries: 1, recalls: 1, devices: 1 }) }
      if (url.includes('/me/agents')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: [] }) }
      return { ok: true, status: 200, text: async () => JSON.stringify({ devices: [] }) }
    },
  })
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(refresh401Calls, 1, '3 concurrent 401 api() calls trigger only one token refresh')
  assert.equal(retriedAuth.length, 3, 'all 3 concurrent calls retry after refresh')
  assert.ok(retriedAuth.every((a) => a === 'Bearer at-rot'), 'all 3 retries use rotated access token')
  assert.equal(JSON.parse(h401.store['clyde_session_v1']).access_token, 'at-rot', 'storage retains rotated session without wiping')

  // 2c. Older failed refresh never wipes a session rotated while the failing refresh was in flight
  let staleRefreshCalls = 0
  const raceStore: Record<string, string> = {}
  makeHarness('usage', '', {
    store: raceStore,
    session: { access_token: 'at-0', refresh_token: 'rt-0', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() - 5000 },
    fetchImpl: async (url: string, init?: RequestInit) => {
      if (url.includes('/auth/v1/token?grant_type=refresh_token')) {
        staleRefreshCalls++
        // Simulate another tab rotating localStorage while this refresh fails
        raceStore['clyde_session_v1'] = JSON.stringify({ access_token: 'at-tab2', refresh_token: 'rt-tab2', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 3600_000 })
        return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }
      }
      assert.equal(String((init?.headers as any)?.authorization), 'Bearer at-tab2', 'adopts session rotated by another tab when stale refresh fails')
      return { ok: true, status: 200, text: async () => JSON.stringify({ plan: 'free', state: 'paid', period: '2026-11', meters: [] }) }
    },
  })
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(staleRefreshCalls, 1)
  assert.equal(JSON.parse(raceStore['clyde_session_v1']).refresh_token, 'rt-tab2', 'failed older refresh does not wipe newer rotated session')

  // 3. Invite banner renders on all non-/memories routes (and without duplication on /memories)
  for (const [viewName, idVal] of [['graph', ''], ['quests', ''], ['agents', ''], ['apps', ''], ['usage', ''], ['settings', ''], ['entry', 'e-1'], ['entries', '']] as const) {
    const hInv = makeHarness(viewName, idVal, {
      search: '?invite=partner-ok',
      session: { access_token: 'at-1', refresh_token: 'rt-1', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 600_000 },
      fetchImpl: async (url: string) => {
        if (url.includes('/me/invite/redeem')) return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, unlimited: true, label: 'VIP' }) }
        if (url.includes('/me/graph')) return { ok: true, status: 200, text: async () => JSON.stringify({ center: 'e-1', nodes: [], edges: [] }) }
        if (url.includes('/me/entries/')) return { ok: true, status: 200, text: async () => JSON.stringify({ entry: { id: 'e-1', title: 'T', body: 'B', pattern: 'decisions', confidence: 0.9 } }) }
        if (url.includes('/me/entries')) return { ok: true, status: 200, text: async () => JSON.stringify({ total: 0, entries: [] }) }
        if (url.includes('/me/onboarding')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: 1, entries: 1, recalls: 1, devices: 1 }) }
        if (url.includes('/me/quests')) return { ok: true, status: 200, text: async () => JSON.stringify({ quests: [] }) }
        if (url.includes('/me/agents')) return { ok: true, status: 200, text: async () => JSON.stringify({ agents: [] }) }
        if (url.includes('/me/devices')) return { ok: true, status: 200, text: async () => JSON.stringify({ devices: [] }) }
        if (url.includes('/me/apps')) return { ok: true, status: 200, text: async () => JSON.stringify({ apps: [] }) }
        return { ok: true, status: 200, text: async () => JSON.stringify({ plan: 'partner', state: 'paid', period: '2026-11', meters: [] }) }
      },
    })
    await new Promise((r) => setTimeout(r, 25))
    assert.equal(hInv.els['app-invite-banner'].className, 'app-banner app-banner--ok', `${viewName}: shared banner displays ok style`)
    assert.ok(hInv.els['app-invite-banner'].textContent.includes('Partner pass active (VIP)'), `${viewName}: shared banner displays partner pass message`)
    if (viewName === 'entries') {
      assert.ok(!hInv.els['app-root'].innerHTML.includes('Partner pass active'), 'entries view avoids duplicate banner inside #app-root')
    }
  }

  // 4. Focus preservation on pagination & onboarding auto-dismiss
  let obStep = 0
  const hFocus = makeHarness('entries', '', {
    session: { access_token: 'at-1', refresh_token: 'rt-1', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 600_000 },
    fetchImpl: async (url: string) => {
      if (url.includes('/me/onboarding')) {
        obStep++
        return {
          ok: true, status: 200,
          text: async () => JSON.stringify(obStep === 1 ? { agents: 1, entries: 1, recalls: 0, devices: 1 } : { agents: 1, entries: 1, recalls: 1, devices: 1 }),
        }
      }
      const isPage2 = url.includes('offset=50')
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          total: 60,
          has_more: !isPage2,
          entries: [{ id: isPage2 ? 'n-51' : 'n-1', title: 'Item', body: 'Body', pattern: 'decisions', confidence: 0.9 }],
        }),
      }
    },
  })
  await new Promise((r) => setTimeout(r, 25))
  // Click Next pager button -> page 2 disables Next, so focus moves to #btn-pg-prev
  hFocus.els['btn-pg-prev'].disabled = false
  hFocus.els['btn-pg-next'].disabled = true // simulates re-rendered page 2 state in stub
  await hFocus.els['btn-pg-next'].listeners.click[0]()
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(hFocus.getActive(), hFocus.els['btn-pg-prev'], 'pagination falls back focus to #btn-pg-prev when #btn-pg-next becomes disabled')

  // Click onboarding refresh -> 3rd check completes and clears #onb-slot -> focus moves to #q-in
  await hFocus.els['onb-refresh'].listeners.click[0]()
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(hFocus.els['onb-slot'].innerHTML, '', 'onboarding card dismisses after 3rd check')
  assert.equal(hFocus.getActive(), hFocus.els['q-in'], 'onboarding auto-dismiss moves focus to #q-in instead of body')

  // 5. Graph recenter focus + search error outside role="listbox"
  const hGraph = makeHarness('graph', '', {
    session: { access_token: 'at-1', refresh_token: 'rt-1', user_id: 'u-1', email: 'a@example.com', expires_at: Date.now() + 600_000 },
    fetchImpl: async (url: string) => {
      if (url.includes('/me/entries?q=')) {
        return { ok: false, status: 500, text: async () => JSON.stringify({ error: 'Search down' }) }
      }
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          center: 'n-1',
          nodes: [{ id: 'n-1', title: 'Node 1', pattern: 'decisions', confidence: 0.9 }, { id: 'n-2', title: 'Node 2', pattern: 'projects', confidence: 0.8 }],
          edges: [{ src: 'n-1', dst: 'n-2', type: 'relates' }],
        }),
      }
    },
  })
  await new Promise((r) => setTimeout(r, 25))
  assert.ok(hGraph.els['app-root'].innerHTML.includes('<div id="g-search-err" class="cl-hint cl-error is-hidden" role="alert"'), 'graph search error live region sits outside role="listbox"')
  hGraph.els['g-search'].value = 'broken'
  hGraph.els['g-search'].listeners.input[0]()
  await new Promise((r) => setTimeout(r, 220))
  assert.ok(hGraph.els['g-search-err'].textContent.includes("Couldn't search notes"), 'graph search error renders in sibling #g-search-err')
  assert.equal(hGraph.els['g-results'].innerHTML, '', 'role="listbox" #g-results does not contain role="alert" on error')
  await hGraph.els['g-recenter'].listeners.click[0]()
  await new Promise((r) => setTimeout(r, 25))
  assert.equal(hGraph.getActive(), hGraph.els['g-ins-title'], 'graph recenter moves focus to #g-ins-title')

  // 6. Sign-in #pw-form sets aria-invalid + aria-describedby="sign-msg" on #s-email and clears on input
  const hSign = makeHarness('entries', '', {
    session: null,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
  })
  await new Promise((r) => setTimeout(r, 20))
  hSign.els['s-email'].value = ''
  await hSign.els['pw-form'].listeners.submit[0]({ preventDefault() {} })
  assert.equal(hSign.els['s-email'].attrs['aria-invalid'], 'true', 'empty email sets aria-invalid="true"')
  assert.equal(hSign.els['s-email'].attrs['aria-describedby'], 'sign-msg', 'empty email points aria-describedby to #sign-msg')
  assert.equal(hSign.getActive(), hSign.els['s-email'], 'empty email focuses #s-email')
  hSign.els['s-email'].listeners.input[0]()
  assert.equal(hSign.els['s-email'].attrs['aria-invalid'], undefined, 'input clears aria-invalid on #s-email')
  assert.equal(hSign.els['s-email'].attrs['aria-describedby'], undefined, 'input clears aria-describedby on #s-email')
})
