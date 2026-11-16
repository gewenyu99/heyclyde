/**
 * R69 (#74): https://heyclyde.me is Clyde's public home page, served by the memory-proxy Worker for the root host, with
 * www redirecting to it. None of it calls the function. globalThis.fetch records any call the Worker makes.
 */
import assert from 'node:assert/strict'
import worker from '../../../memory/proxy/worker.js'
import { homePage, statePage } from '../../../memory/proxy/pages.js'

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
// R72 (#77): the pages a search engine should index, in the order the sitemap lists them.
const INDEXED = ['/', '/docs', '/how-it-works', '/research', '/support', '/docs/grok', '/privacy', '/terms', '/signin']
const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

Deno.test('the home page has the logo, pricing and its links', async () => {
  const { r, html } = await get('https://heyclyde.me/')
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('content-type')), /^text\/html/)
  assert.equal(calls, 0, 'the home page needs nothing from the function')
  assert.deepEqual(h1s(html), ['Your agents have the memory of a goldfish.'])
  assert.ok(text(html).includes('$12.99'))
  assert.ok(/\bFree\b/.test(text(html)))
  assert.ok(/<a[^>]*href="https:\/\/memory\.heyclyde\.me\/"[^>]*>[^<]*Get Clyde/.test(html), 'a Get Clyde link to the connect page')
  for (const href of ['/signin', '/privacy', '/terms']) assert.ok(html.includes(`href="${href}"`), href)
  assert.ok(html.includes('/_clyde/brand/clyde-lockup-light.svg'), 'the logo')
  assert.ok(html.includes('/_clyde/brand/clyde-mascot-light.svg') && html.includes('/_clyde/brand/clyde-mascot-dark.svg'), 'Sticky-Note Forehead Clyde mascot')
  assert.ok(html.includes('id="honest"') && html.includes('cl-sticky'), 'sticky-note warning section')
  assert.ok(text(html).includes("This is not advanced technology. It's probably not even very secure."))
  assert.ok(text(html).includes('Shared memory') && text(html).includes('A quest board made of sticky notes'))
  assert.ok(html.includes('@media (max-width:960px){.site-hero{grid-template-columns:minmax(0,1fr)'), 'the hero is one column on a phone')
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
  assert.deepEqual(h1s(nope.html), ['Nothing here'])
  assert.ok(nope.html.includes('/_clyde/brand/clyde-mascot-light.svg'), '404 mascot')
  assert.ok(text(nope.html).includes("Even Clyde doesn't remember a page at /nope"))
  assert.equal(calls, 0)
  const terms = text((await get('https://heyclyde.me/terms')).html)
  for (const place of ['European Union', 'Iceland', 'Liechtenstein', 'Norway', 'United Kingdom', 'Switzerland', 'Quebec', '14 days', '$12.99']) {
    assert.ok(terms.includes(place), `terms mentions ${place}`)
  }
  const termsHtml = (await get('https://heyclyde.me/terms')).html
  assert.ok(!/[€£]|\b(?:EUR|GBP|CHF)\b|hreflang/i.test(termsHtml), 'USD-only terms with no foreign currency or hreflang')
  const priv = text((await get('https://heyclyde.me/privacy')).html)
  for (const word of ['Supabase', 'Cloudflare', 'OpenAI', 'Polar', 'passwords']) assert.ok(priv.includes(word), `privacy mentions ${word}`)
  const www = await get('https://www.heyclyde.me/privacy?x=1')
  assert.equal(www.r.status, 301)
  assert.equal(www.r.headers.get('location'), 'https://heyclyde.me/privacy?x=1')
  assert.equal(calls, 0)
})

Deno.test('every heyclyde.me page is locked down, and public pages are indexable', async () => {
  for (const path of [...INDEXED, '/nope']) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    const csp = String(r.headers.get('content-security-policy'))
    assert.match(csp, /default-src 'none'/, path)
    assert.match(csp, /script-src 'nonce-[A-Za-z0-9]{16,}'/, path)
    assert.equal(r.headers.get('x-frame-options'), 'DENY', path)
    assert.match(String(r.headers.get('cache-control')), /no-transform/, `${path}: Cloudflare may not inject scripts`)
    assert.ok(!/\sstyle="/.test(html), `${path}: no style attributes`)
    // What the page loads: src and srcset, and a link's href unless it's only a pointer (canonical).
    const loads = [...html.matchAll(/<(?:script|img|source|iframe)[^>]*\s(?:src|srcset)="([^"]+)"/gi), ...html.matchAll(/<link(?![^>]*rel="canonical")[^>]*\shref="([^"]+)"/gi)].map((m) => m[1])
    for (const u of loads) {
      assert.ok(!/^(https?:)?\/\//.test(u), `${path} loads ${u}`)
      if (u.startsWith('/_clyde/')) {
        const file = new URL(`../../../memory/proxy/public${u}`, import.meta.url)
        assert.ok(Deno.statSync(file).isFile, `${path} asset ${u} exists in memory/proxy/public`)
      }
    }
    if (path !== '/nope') assert.equal((html.match(/noindex/gi) ?? []).length, 0, `${path} must not carry noindex`)
    else assert.ok(html.includes('noindex'), 'the 404 is noindex')
    for (const m of html.matchAll(/<script([^>]*)>/g)) assert.match(m[1], /nonce="[A-Za-z0-9]{16,}"/, `${path}: every script carries the nonce`)
  }
})

// R55 (#60): the pages the Claude directory and Google Connected Apps link to.
Deno.test('the store pages', async () => {
  const src = Deno.readTextFileSync(new URL('../../../memory/supabase/functions/memory/mcp.ts', import.meta.url))
  const tools = [...src.slice(src.indexOf('export const TOOLS')).matchAll(/^    name: "([a-z_]+)"/gm)].map((m) => m[1])
  assert.ok(tools.length >= 10, `${tools.length} tools read from mcp.ts`)
  const want: Record<string, [string, string[]]> = {
    '/docs': ['Clyde docs', ['https://heyclyde.me/mcp', 'Claude', 'Gemini', 'export', 'delete', 'support@heyclyde.me', ...tools]],
    '/support': ['Support', ['support@heyclyde.me', 'export and delete']],
    '/docs/grok': ['Connect Grok to Clyde', ['Grok', 'https://heyclyde.me/mcp']],
    '/privacy': ['Privacy policy', ['Supabase', 'OpenAI', 'Polar', 'Resend', 'Cloudflare', 'export', 'delete', '30 days', 'Pennywhistle']],
    '/terms': ['Terms of service', ['Ontario', 'Quebec', 'Pennywhistle']],
  }
  for (const [path, [title, words]] of Object.entries(want)) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    assert.equal(r.status, 200, path)
    assert.deepEqual(h1s(html), [title], path)
    assert.equal(calls, 0, `${path} needs nothing from the function`)
    const bytes = new TextEncoder().encode(html).length
    assert.ok(bytes <= 50_000, `${path}: ${bytes} bytes`)
    const t = text(html)
    for (const w of words) assert.ok(t.includes(w), `${path} mentions ${w}`)
  }
  assert.ok((await get('https://heyclyde.me/support')).html.includes('href="/docs"'), '/support links the docs')
  const home = (await get('https://heyclyde.me/')).html
  for (const href of ['/docs', '/support']) assert.ok(home.includes(`href="${href}"`), `the footer links ${href}`)
})

// ---- R72 (#77): voice, doodles, SEO, and the two new pages ----

const attr = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1])
const meta = (html: string, key: string) => attr(html, new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`, 'g'))

Deno.test('how it works and research', async () => {
  for (const path of ['/how-it-works', '/research']) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    assert.equal(r.status, 200, path)
    assert.equal(h1s(html).length, 1, `${path}: one h1`)
  }
  const how = text((await get('https://heyclyde.me/how-it-works')).html)
  for (const w of ['On trial', 'quest', 'reciprocal rank']) assert.ok(how.includes(w), `/how-it-works mentions ${w}`)
  const research = (await get('https://heyclyde.me/research')).html
  for (const u of ['arxiv.org/abs/2607.13591', 'alphaxiv.org/abs/2602.22406', 'PMC3069643', 'NBK3905', 'arxiv.org/pdf/2604.27283', 'arxiv.org/html/2604.00131', 'taatgenLebiereAnderson.pdf']) {
    assert.ok(research.includes(u), `/research links ${u}`)
  }
  const docs = [...Deno.readDirSync(new URL('../../../memory/', import.meta.url))].filter((e) => e.name.endsWith('.md'))
    .map((e) => Deno.readTextFileSync(new URL(`../../../memory/${e.name}`, import.meta.url))).join('\n')
  const papers = attr(research, /href="(https?:\/\/[^"]*(?:arxiv|alphaxiv|ncbi|ai\.rug\.nl)[^"]*)"/g)
  assert.ok(papers.length >= 7, `${papers.length} paper links`)
  for (const u of papers) assert.ok(docs.includes(u), `${u} is cited in memory/*.md`)
})

Deno.test('every page has its own SEO tags', async () => {
  const titles = new Set<string>(), descs = new Set<string>()
  for (const path of INDEXED) {
    const { html } = await get(`https://heyclyde.me${path}`)
    const title = attr(html, /<title>([^<]*)<\/title>/g), desc = meta(html, 'description')
    assert.equal(title.length, 1, `${path}: one title`)
    assert.equal(desc.length, 1, `${path}: one description`)
    assert.ok(desc[0].length >= 50 && desc[0].length <= 160, `${path}: description is ${desc[0].length} characters`)
    titles.add(title[0]); descs.add(desc[0])
    assert.deepEqual(attr(html, /<link rel="canonical" href="([^"]*)"/g), [`https://heyclyde.me${path}`], `${path}: canonical`)
    for (const k of ['og:title', 'og:description', 'og:url']) assert.equal(meta(html, k).length, 1, `${path}: ${k}`)
    assert.deepEqual(meta(html, 'og:image'), ['https://heyclyde.me/brand/og-banner.png'], `${path}: og:image`)
    assert.deepEqual(meta(html, 'twitter:card'), ['summary_large_image'], `${path}: twitter:card`)
    const bytes = new TextEncoder().encode(html).length
    assert.ok(bytes <= 50_000, `${path}: ${bytes} bytes`)
  }
  assert.equal(titles.size, INDEXED.length, 'every title is different')
  assert.equal(descs.size, INDEXED.length, 'every description is different')
  assert.ok(Deno.statSync(new URL('../../../memory/proxy/public/brand/og-banner.png', import.meta.url)).isFile, 'the OG image ships')
})

Deno.test('structured data', async () => {
  const { html } = await get('https://heyclyde.me/')
  const blocks = attr(html, /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g).map((b) => JSON.parse(b))
  const app = blocks.find((b) => b['@type'] === 'SoftwareApplication')
  assert.ok(app, 'a SoftwareApplication')
  const offers = (app.offers ?? []).map((o: { price: string; priceCurrency: string }) => `${o.price} ${o.priceCurrency}`).sort()
  assert.deepEqual(offers, ['0 USD', '12.99 USD'])
  const faq = blocks.find((b) => b['@type'] === 'FAQPage')
  assert.ok(faq && faq.mainEntity.length >= 3, 'a FAQPage with 3 or more questions')
})

Deno.test('sitemap and robots', async () => {
  const sitemap = await worker.fetch(new Request('https://heyclyde.me/sitemap.xml'), ENV)
  assert.equal(sitemap.status, 200)
  assert.match(String(sitemap.headers.get('content-type')), /^application\/xml/)
  assert.deepEqual(attr(await sitemap.text(), /<loc>([^<]*)<\/loc>/g), INDEXED.map((p) => `https://heyclyde.me${p}`))
  const site = await worker.fetch(new Request('https://heyclyde.me/robots.txt'), ENV)
  assert.equal(site.status, 200)
  assert.match(String(site.headers.get('content-type')), /^text\/plain/)
  const siteTxt = await site.text()
  assert.ok(siteTxt.includes('Sitemap: https://heyclyde.me/sitemap.xml'))
  assert.ok(!/^Disallow: \/\s*$/m.test(siteTxt), 'heyclyde.me is crawlable')
  calls = 0
  const api = await worker.fetch(new Request('https://memory.heyclyde.me/robots.txt'), ENV)
  assert.equal(api.status, 200)
  assert.ok((await api.text()).includes('Disallow: /'), 'memory.heyclyde.me stays out of search')
  assert.equal(calls, 0, 'robots.txt never reaches the function')
})

Deno.test('every page wears the doodles', async () => {
  for (const path of [...INDEXED, '/nope']) {
    const { html } = await get(`https://heyclyde.me${path}`)
    assert.ok(/\/_clyde\/scenes\/|clyde-mascot/.test(html), `${path}: a Clyde illustration`)
    assert.ok(html.includes('cl-sticky'), `${path}: a sticky note`)
  }
})

const SLOP = /\u2014|\u2013|\b(?:leverage|utilize|seamless|robust|empower|comprehensive|delve|crucial|supercharge)\b|second brain|AI-powered|allows you to|enables you to|in order to/i
Deno.test('the copy has no slop', async () => {
  const pages: [string, string][] = []
  for (const path of [...INDEXED, '/nope']) pages.push([path, text((await get(`https://heyclyde.me${path}`)).html)])
  pages.push(['memory.heyclyde.me/', text(homePage('n0nce0000000000000000'))])
  for (const state of ['check_email', 'waiting', 'connected', 'refused', 'ask_email', 'blocked', 'subscribed', 'expired', 'error']) {
    pages.push([`state ${state}`, text(statePage({ state, client: 'Claude', email: 'w@example.com', message: 'Not available.' }, 'n0nce0000000000000000', 'abcdefgh12'))])
  }
  pages.push(['ui/script.ts', Deno.readTextFileSync(new URL('../../../memory/supabase/functions/memory/ui/script.ts', import.meta.url))])
  for (const [where, t] of pages) {
    const m = SLOP.exec(t)
    assert.equal(m, null, `${where}: "${m?.[0]}" in ...${t.slice(Math.max(0, (m?.index ?? 0) - 60), (m?.index ?? 0) + 30)}`)
  }
  const home = pages[0][1]
  for (const w of ['goldfish', 'big AI']) assert.ok(home.includes(w), `the home page says ${w}`)
})
