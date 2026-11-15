/**
 * R69 (#74): https://heyclyde.me is Clyde's public home page, served by the memory-proxy Worker for the root host, with
 * www redirecting to it. None of it calls the function. globalThis.fetch records any call the Worker makes.
 */
import assert from 'node:assert/strict'
import worker from '../../../memory/proxy/worker.js'

const ENV = { PROXY_SECRET: 'test-proxy-secret' }
let calls = 0
globalThis.fetch = (() => {
  calls++
  return Promise.resolve(Response.json({ ok: true }))
}) as typeof fetch

async function get(url: string) {
  calls = 0
  const r = await worker.fetch(new Request(url, { headers: { accept: 'text/html' } }), ENV)
  return { r, html: r.headers.get('content-type')?.startsWith('text/html') ? await r.text() : '' }
}
const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

Deno.test('the home page has the logo, pricing and its links', async () => {
  const { r, html } = await get('https://heyclyde.me/')
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('content-type')), /^text\/html/)
  assert.equal(calls, 0, 'the home page needs nothing from the function')
  assert.equal(h1s(html).length, 1)
  assert.ok(text(html).includes('$12.99'))
  assert.ok(/\bFree\b/.test(text(html)))
  assert.ok(/<a[^>]*href="https:\/\/memory\.heyclyde\.me\/"[^>]*>[^<]*Get Clyde/.test(html), 'a Get Clyde link to the connect page')
  for (const href of ['/signin', '/privacy', '/terms']) assert.ok(html.includes(`href="${href}"`), href)
  assert.ok(html.includes('/_clyde/brand/clyde-lockup-light.svg'), 'the logo')
  assert.ok(new TextEncoder().encode(html).length <= 50_000, `${html.length} bytes`)
})

Deno.test('pricing matches memory.plan', async () => {
  const sql = Deno.readTextFileSync(new URL('../../../memory/supabase/migrations/20261115120000_billing.sql', import.meta.url))
  const row = (id: string) => new RegExp(`\\('${id}', '[^']+', (\\d+), \\w+, \\w+, [\\d.]+, (\\d+), (\\d+), \\w+, \\w+, (\\d+)[^\\n]*?, (\\w+)\\)`).exec(sql)!
  const clyde = row('clyde'), free = row('free')
  const t = text((await get('https://heyclyde.me/')).html)
  assert.ok(t.includes(`$${(Number(clyde[1]) / 1e6).toFixed(2)}`), 'price')
  const n = (v: string) => Number(v).toLocaleString('en-US')
  for (const [label, v] of [['recalls', clyde[2]], ['remembers', clyde[3]], ['computers', clyde[4]]]) {
    assert.ok(t.includes(`${n(v)} ${label}`), `clyde: ${n(v)} ${label}`)
  }
  for (const [label, v] of [['recalls', free[2]], ['writes', free[3]]]) assert.ok(t.includes(`${n(v)} ${label}`), `free: ${n(v)} ${label}`)
  assert.ok(t.includes(`first ${n(free[5])} people`), `free: first ${n(free[5])} people`)
})

Deno.test('the other pages, the 404 and the www redirect', async () => {
  for (const [path, title] of [['/signin', 'Sign in to Clyde'], ['/privacy', 'Privacy policy'], ['/terms', 'Terms of service']]) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    assert.equal(r.status, 200, path)
    assert.deepEqual(h1s(html), [title])
    assert.equal(calls, 0, path)
  }
  const nope = await get('https://heyclyde.me/nope')
  assert.equal(nope.r.status, 404)
  assert.match(String(nope.r.headers.get('content-type')), /^text\/html/)
  assert.equal(calls, 0)
  const www = await get('https://www.heyclyde.me/privacy?x=1')
  assert.equal(www.r.status, 301)
  assert.equal(www.r.headers.get('location'), 'https://heyclyde.me/privacy?x=1')
  assert.equal(calls, 0)
})

Deno.test('every heyclyde.me page is locked down', async () => {
  for (const path of ['/', '/signin', '/privacy', '/terms', '/nope']) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    const csp = String(r.headers.get('content-security-policy'))
    assert.match(csp, /default-src 'none'/, path)
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9]{16,}'/, path)
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path)
    assert.ok(!/\sstyle="/.test(html), `${path}: no style attributes`)
    const loads = [...html.matchAll(/<(?:script|link|img|source|iframe)[^>]*\s(?:src|href|srcset)="([^"]+)"/gi)].map((m) => m[1])
    for (const u of loads) assert.ok(!/^(https?:)?\/\//.test(u), `${path} loads ${u}`)
  }
})
