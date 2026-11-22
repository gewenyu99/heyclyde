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

  for (const path of ['/memories', '/entries/note-1', '/graph', '/quests', '/agents', '/apps', '/usage', '/settings', '/auth/callback']) {
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
