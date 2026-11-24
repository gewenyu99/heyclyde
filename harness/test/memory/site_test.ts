/**
 * R69 (#74): https://heyclyde.me is Clyde's public home page, served by the memory-proxy Worker for the root host, with
 * www redirecting to it. None of it calls the function. globalThis.fetch records any call the Worker makes.
 */
import assert from 'node:assert/strict'
import worker from '../../../memory/proxy/worker.js'
import { CLYDE_HOOK_SH } from '../../../memory/proxy/hook.js'
import { APP_LOGO, appCards, appSteps, DESIGN_URL, homePage, SOON, statePage } from '../../../memory/proxy/pages.js'
import { INDEXED as SITE_INDEXED, INDEXNOW_KEY, MOVED } from '../../../memory/proxy/site.js'
// R79 (like-vincent #84): the guides. Imported loosely, so the rest of this file still runs before guides.js exists.
type Guide = { path: string; kind: 'woe' | 'howto'; title: string; h1: string; faq: [string, string][] }
const { GUIDES } = (await import('../../../memory/proxy/guides.js').catch(() => ({ GUIDES: [] }))) as { GUIDES: Guide[] }

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
const BASE = ['/', '/docs', '/how-it-works', '/faq', '/privacy', '/terms']
const INDEXED = [...BASE, '/guides', ...GUIDES.map((g) => g.path)]
// Pages the site dropped when it shrank, and where each one went.
const REDIRECTS: Record<string, string> = { '/research': '/how-it-works', '/support': '/docs#support', '/docs/grok': '/docs#grok', '/signin': '/memories' }
const SUPPORT = 'support@heyclyde.me'
// No page has a byte cap (R79, like-vincent #84). Wen, 2026-11-17: the size of the site doesn't matter.
const h1s = (html: string) => [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').trim())
const text = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

Deno.test('the home page has the logo, pricing and its links', async () => {
  const { r, html } = await get('https://heyclyde.me/')
  assert.equal(r.status, 200)
  assert.match(String(r.headers.get('content-type')), /^text\/html/)
  assert.equal(calls, 0, 'the home page needs nothing from the function')
  assert.deepEqual(h1s(html), ['Your agents have the memory of a goldfish.'])
  assert.ok(text(html).includes('$2.99'))
  assert.ok(text(html).includes('$12.99'))
  assert.ok(/\bStarter\b/.test(text(html)))
  assert.ok(/\bFree\b/.test(text(html)))
  assert.ok(/<a[^>]*href="\/docs"[^>]*>[^<]*Get Clyde/.test(html), 'a Get Clyde link to the docs')
  for (const href of ['/docs', '/how-it-works', '/faq', '/privacy', '/terms']) assert.ok(html.includes(`href="${href}"`), href)
  assert.ok(html.includes('/_clyde/brand/clyde-lockup-light.svg'), 'the logo')
  assert.ok(/\/_clyde\/(brand\/clyde-mascot|scenes\/[a-z]+)-light\.svg/.test(html) && /\/_clyde\/(brand\/clyde-mascot|scenes\/[a-z]+)-dark\.svg/.test(html), 'a Clyde drawing in both themes')
  const honest = /<section[^>]*id="honest"[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
  assert.ok(honest.includes('cl-sticky') && /<h2[^>]*>[\s\S]*secure[\s\S]*?<\/h2>/.test(honest), 'sticky-note warning section that says it is not very secure')
  assert.ok(text(honest).includes('Use with caution.'), 'the warning says to use it with caution')
  assert.ok(text(html).includes('Shared memory') && text(html).includes('A quest board'))
  // The example windows are structure, not pinned copy: the hero scene, a recalled note and a quest card.
  assert.ok(html.includes('class="scene"'), 'the hero scene')
  assert.equal((html.match(/<article class="cl-card cl-memory">/g) ?? []).length >= 2, true, 'a recalled note in the scene and in Shared memory')
  assert.equal((html.match(/<article class="cl-quest">/g) ?? []).length, 1, 'one quest card')
  assert.ok(!html.includes('FAQPage') && !/<div class="faq">/.test(html), 'the FAQ lives on /faq, not the home page')
  assert.ok(html.includes('@media (max-width:960px){.site-hero{grid-template-columns:minmax(0,1fr)'), 'the hero is one column on a phone')
})

// Structure only: which parts are there and how they're wired. The wording is Wen's and isn't pinned here.
Deno.test('the home page has an app picker, a recall carousel and one bottom button', async () => {
  const { html } = await get('https://heyclyde.me/')
  const section = (id: string) => new RegExp(`<section[^>]*id="${id}"[\\s\\S]*?</section>`).exec(html)?.[0] ?? ''

  // The picker: one radio and one label per app, Claude checked, each panel the same steps /docs shows.
  const how = section('how')
  const ids = ['claude-ai', 'agent-setup', 'claude-code', 'antigravity', 'gemini', 'grok', 'chatgpt', 'other']
  const radios = [...how.matchAll(/<input[^>]*type="radio"[^>]*>/g)].map((m) => m[0])
  assert.deepEqual(radios.map((r) => /id="pick-([^"]+)"/.exec(r)?.[1]), ids, 'one radio per app, in order')
  assert.equal(new Set(radios.map((r) => /name="([^"]+)"/.exec(r)?.[1])).size, 1, 'the radios share one name, so arrow keys move between them')
  assert.deepEqual(radios.map((r) => / checked/.test(r)), [true, false, false, false, false, false, false, false], 'Claude is checked by default')
  for (const id of ids) {
    const app = appSteps(id)
    const label = new RegExp(`<label for="pick-${id}">([\\s\\S]*?)</label>`).exec(how)?.[1] ?? ''
    assert.ok(label.includes((APP_LOGO as Record<string, string[]>)[app.logo][0]), `${id}: the tab shows the app's logo`)
    assert.equal(label.includes('class="soon"'), SOON.has(app.logo), `${id}: a red asterisk only when the app is in SOON`)
    assert.ok(how.includes(`data-pick="${id}">${app.body}</div>`), `${id}: the panel is the app's steps from pages.js`)
    assert.ok(html.includes(`#pick-${id}:checked~.pick-panels [data-pick="${id}"]`), `${id}: its radio shows its panel`)
    assert.ok(html.includes(`#pick-${id}:checked~.pick-tabs [for="pick-${id}"]`), `${id}: its radio marks its tab`)
    assert.ok(html.includes(`#pick-${id}:focus-visible~.pick-tabs [for="pick-${id}"]`), `${id}: keyboard focus shows on its tab`)
  }
  assert.ok(html.includes('.pick-panel{display:none'), 'a panel is hidden until its radio is checked')
  assert.ok(!/\.pick-in\{[^}]*display:none/.test(html), 'the radios stay focusable')
  assert.equal((how.match(/class="soon-note"/g) ?? []).length, 1, 'the asterisk legend, once')
  assert.ok(!how.includes('<script'), 'the picker needs no script')

  // Six user-focused walkthrough slides directly under the heading (no card grid above), scrolling and snapping without script.
  const built = section('built')
  assert.ok(built.indexOf('<h2') < built.indexOf('<div class="rc" id="rc">'), 'the walkthrough sits directly under the section heading')
  assert.ok(!built.includes('mc-grid') && !built.includes('mc-card'), 'no detail card grid sits above the walkthrough')
  const slides = [...built.matchAll(/<article class="cl-card rc-slide" data-step="(\d+)">([\s\S]*?)<\/article>/g)]
  assert.deepEqual(slides.map((m) => m[1]), ['0', '1', '2', '3', '4', '5'], 'six ordered walkthrough slides')
  for (const [, step, slide] of slides) {
    assert.equal((slide.match(/<h3>[^<]+<\/h3>/g) ?? []).length, 1, `step ${step}: one outcome heading`)
    assert.ok(slide.includes('<div class="rc-stage">') && slide.includes('<p class="rc-cap">'), `step ${step}: a visual stage and caption`)
    const points = [...slide.matchAll(/<li><span><b>([^<]+)<\/b>([\s\S]*?)<\/span><\/li>/g)]
    assert.equal(points.length, 3, `step ${step}: a three-step walkthrough`)
  }
  for (const svg of built.matchAll(/<svg viewBox="[^"]+" role="img" aria-label="([^"]+)">/g)) {
    assert.ok(svg[1].length >= 20, `labelled SVG diagram: ${svg[1]}`)
  }
  assert.ok(slides[0][2].includes('billing/webhooks.ts') && slides[0][2].includes('stripe listen'), 'walkthrough 1 shows connected notes on a webhook example')
  assert.ok(slides[1][2].includes('auth-spec.md') && slides[1][2].includes('500 characters'), 'walkthrough 2 shows compact notes with side attachments')
  assert.ok(slides[2][2].includes('On trial') && slides[2][2].includes('Vitest'), 'walkthrough 3 shows the 3-recall trial filtering a bad guess')
  assert.ok(slides[3][2].includes('push-stage.sh') && slides[3][2].includes('GitHub Actions'), 'walkthrough 4 shows pushback replacing a stale note')
  assert.ok(slides[4][2].includes('30-day vacation') && slides[4][2].includes('searchable'), 'walkthrough 5 shows recall-counted decay sparing paused projects')
  assert.ok(slides[5][2].includes('class="sv-ant"') && slides[5][2].includes('Shadow ranker'), 'walkthrough 6 shows ant link testing and shadow rankers')
  assert.ok(/\.rc-track\{[^}]*overflow-x:auto[^}]*scroll-snap-type:x mandatory/.test(html), 'the track scrolls sideways and snaps')
  assert.ok(/\.rc-slide\{[^}]*scroll-snap-align:start/.test(html), 'each slide is a snap point')
  assert.ok(/<div class="rc-track" tabindex="0"/.test(built), 'the track takes keyboard focus')
  assert.ok(/<div class="rc-nav" hidden>/.test(built), 'step controls stay hidden without script')
  assert.deepEqual(attr(built, /<button class="rc-pill"[^>]*data-go="(\d+)"/g), ['0', '1', '2', '3', '4', '5'], 'a pill button for each walkthrough')
  assert.equal((built.match(/<button[^>]*data-dir="-?1"[^>]*aria-label="[^"]+"/g) ?? []).length, 2, 'a labelled prev and next button')
  assert.ok(/<span class="rc-count"[^>]*>1 \/ 6<\/span>/.test(built), 'a walkthrough count')
  assert.ok(built.includes('href="/how-it-works#built"'), 'a link to /how-it-works#built')
  assert.ok(/<script nonce="[A-Za-z0-9]{16,}">[^<]*getElementById\('rc'\)/.test(html), 'the walkthrough script carries the nonce')
  assert.ok(!html.includes('built-nums') && !html.includes('rc-works'), 'the old text blocks are gone')

  // One button at the bottom, after pricing. The plan cards have none.
  const pricing = section('pricing')
  assert.ok(pricing && !/<button|cl-btn/.test(pricing), 'plan cards carry no buttons')
  const after = html.slice(html.indexOf(pricing) + pricing.length, html.indexOf('<footer'))
  assert.deepEqual(attr(after, /<a class="cl-btn[^"]*" href="([^"]+)"/g), ['/docs'], 'one button after pricing, to /docs')
  assert.ok(!/<button/.test(after), 'nothing else to press after pricing')
  assert.ok(/\.end-cta\{[^}]*justify-content:center/.test(html), 'the button is centered')
  assert.ok(html.indexOf('id="how"') < html.indexOf('id="pricing"') && html.indexOf('id="built"') < html.indexOf('id="honest"'), 'the sections keep their order')

  // The hero's second paragraph keeps Wen's struck-out words.
  const hero = /<section class="hero[\s\S]*?<\/section>/.exec(html)?.[0] ?? ''
  assert.equal((hero.match(/<s class="strike">/g) ?? []).length, 1, 'the hero strikes out one phrase')
})

Deno.test('pricing matches memory.plan', async () => {
  const baseSql = Deno.readTextFileSync(new URL('../../../memory/supabase/migrations/20261115120000_billing.sql', import.meta.url))
  const tierSql = Deno.readTextFileSync(new URL('../../../memory/supabase/migrations/20261122010000_starter_plan_and_free_limits.sql', import.meta.url))
  const clyde = /\('clyde', '[^']+', (\d+), \w+, \w+, [\d.]+, (\d+), (\d+), \w+, \w+, (\d+)[^\n]*?, (\w+)\)/.exec(baseSql)!
  const starter = /'starter', 'Starter', (\d+), true, true, [\d.]+,\s*(\d+), (\d+), \d+, \d+,\s*(\d+), \d+, \d+, false, null,\s*null, true, false, (\d+)/.exec(tierSql)!
  const freeEntries = /entries_total = (\d+)/.exec(tierSql)![1]
  const freeRecalls = /recalls_month = (\d+)/.exec(tierSql)![1]
  const freeWrites = /remembers_month = (\d+)/.exec(tierSql)![1]
  const freeAgents = /connected_agents = (\d+)/.exec(tierSql)![1]
  const freeSeats = /seats = (\d+)/.exec(tierSql)![1]

  const t = text((await get('https://heyclyde.me/')).html)
  const n = (v: string) => Number(v).toLocaleString('en-US')
  assert.ok(t.includes(`$${(Number(clyde[1]) / 1e6).toFixed(2)}`), 'clyde price')
  assert.ok(t.includes(`$${(Number(starter[1]) / 1e6).toFixed(2)}`), 'starter price')
  for (const [label, v] of [['recalls', clyde[2]], ['writes', clyde[3]], ['computers', clyde[4]]]) {
    assert.ok(t.includes(`${n(v)} ${label}`), `clyde: ${n(v)} ${label}`)
  }
  for (const [label, v] of [['recalls', starter[2]], ['writes', starter[3]], ['computers', starter[4]]]) {
    assert.ok(t.includes(`${n(v)} ${label}`), `starter: ${n(v)} ${label}`)
  }
  assert.ok(t.includes(`${n(starter[5])} stored notes`), `starter: ${n(starter[5])} stored notes`)
  for (const [label, v] of [['recalls', freeRecalls], ['writes', freeWrites], ['computers', freeAgents]]) {
    assert.ok(t.includes(`${n(v)} ${label}`), `free: ${n(v)} ${label}`)
  }
  assert.ok(t.includes(`${n(freeEntries)} stored notes`), `free: ${n(freeEntries)} stored notes`)
  assert.ok(t.includes(`first ${n(freeSeats)} users`), `free: first ${n(freeSeats)} users`)
  const plans = /<section[^>]*id="pricing"[\s\S]*?<\/section>/.exec((await get('https://heyclyde.me/')).html)?.[0] ?? ''
  assert.ok(plans && !/\bremembers\b/.test(plans), 'plans count writes, not remembers')
})

Deno.test('the other pages, the 404 and the www redirect', async () => {
  for (const [path, title] of [['/privacy', 'Privacy policy'], ['/terms', 'Terms of service']]) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    assert.equal(r.status, 200, path)
    assert.deepEqual(h1s(html), [title])
    assert.equal(calls, 0, path)
  }
  const nope = await get('https://heyclyde.me/nope')
  assert.equal(nope.r.status, 404)
  assert.match(String(nope.r.headers.get('content-type')), /^text\/html/)
  assert.deepEqual(h1s(nope.html), ['Page not found'])
  assert.ok(nope.html.includes('/_clyde/brand/clyde-mascot-light.svg'), '404 mascot')
  assert.ok(nope.html.includes('<code>/nope</code>'), 'the 404 names the path')
  assert.ok(nope.html.includes('href="/"'), 'the 404 links home')
  assert.equal(calls, 0)
  const terms = text((await get('https://heyclyde.me/terms')).html)
  for (const place of ['European Union', 'Iceland', 'Liechtenstein', 'Norway', 'United Kingdom', 'Switzerland', 'Quebec', '14-day refund window', 'Starter', '$2.99', '$12.99']) {
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

// R55 (#60): the pages the Claude directory and Google Connected Apps link to. Support and the Grok guide now live on
// /docs, at #support and #grok.
Deno.test('the store pages', async () => {
  const want: Record<string, [string, string[]]> = {
    '/docs': ['Install Clyde', ['https://heyclyde.me/mcp', 'Claude', 'Gemini', 'Grok', 'export', 'delete', SUPPORT]],
    '/privacy': ['Privacy policy', ['Supabase', 'OpenAI', 'Polar', 'Resend', 'Cloudflare', 'export', 'delete', '30 days', 'Pennywhistle']],
    '/terms': ['Terms of service', ['Ontario', 'Quebec', 'Pennywhistle']],
  }
  for (const [path, [title, words]] of Object.entries(want)) {
    const { r, html } = await get(`https://heyclyde.me${path}`)
    assert.equal(r.status, 200, path)
    assert.deepEqual(h1s(html), [title], path)
    assert.equal(calls, 0, `${path} needs nothing from the function`)
    const t = text(html)
    for (const w of words) assert.ok(t.includes(w), `${path} mentions ${w}`)
  }
  const docs = (await get('https://heyclyde.me/docs')).html
  // /docs shows the connect page's own app cards, every one of them, in the same order.
  assert.ok(docs.includes(appCards()), '/docs carries appCards() as the connect page renders it')
  const apps = attr(docs, /data-app="([^"]+)"/g)
  assert.deepEqual(apps, attr(homePage('n0nce0000000000000000'), /data-app="([^"]+)"/g), '/docs and the connect page list the same apps')
  assert.deepEqual(apps, ['agent-setup', 'claude-ai', 'antigravity', 'grok', 'other', 'claude-code', 'gemini', 'chatgpt', 'antigravity-cloud'])
  assert.ok(/\.apps\{columns:2 380px;column-gap:16px/.test(docs) && /\.apps>\.app\{[^}]*break-inside:avoid/.test(docs), '/docs stacks app cards in a mosaic rather than a rigid row grid')
  assert.ok(!/\.apps\{display:grid/.test(docs) && !/<h2 id="agent-setup">/.test(docs), 'agent-setup lives inside the mosaic rather than a separate section')
  assert.ok(/<article[^>]*id="grok"[\s\S]*?grok\.com\/connectors[\s\S]*?https:\/\/heyclyde\.me\/mcp/.test(docs), '/docs#grok: the Grok steps with the MCP URL')
  const hooks = /<h2 id="hooks">[\s\S]*?<h2 id="hook-configs">/.exec(docs)?.[0] ?? ''
  for (const w of ['SessionStart', 'PreInvocation', 'invoke_subagent', 'PostToolUse', 'Stop', '/hooks', 'MEMORY_HOOKS=metadata']) {
    assert.ok(hooks.includes(w), `/docs#hooks mentions ${w}`)
  }
  const hookConfigs = /<h2 id="hook-configs">[\s\S]*?<h2 id="instructions">/.exec(docs)?.[0] ?? ''
  for (const w of [
    'https://heyclyde.me/clyde-hook.sh',
    'curl -fsSL https://heyclyde.me/install | sh',
    '~/.config/memory/clyde-hook.sh',
    '~/.gemini/config/hooks.json',
    '.agents/hooks.json',
    '~/.claude/settings.json',
    'hook_mode',
    '~/.codex/hooks.json',
    '~/.gemini/settings.json',
    'clyde-hook.sh antigravity PreInvocation',
    'clyde-hook.sh claude UserPromptSubmit',
    'clyde-hook.sh codex UserPromptSubmit',
    'clyde-hook.sh gemini BeforeAgent',
  ]) {
    assert.ok(hookConfigs.includes(w), `/docs#hook-configs mentions ${w}`)
  }
  const instructions = /<h2 id="instructions">[\s\S]*?<h2 id="then">/.exec(docs)?.[0] ?? ''
  assert.ok(instructions.includes('data-copy="Clyde is your only memory'), '/docs#instructions has a copyable Clyde rule')
  for (const w of ['Personal preferences', 'CLAUDE.md', 'AGENTS.md', 'Model Decision', 'Custom instructions', 'Saved info', 'GEMINI.md', 'Customize Grok', '.agents/rules/clyde.md']) {
    assert.ok(instructions.includes(w), `/docs#instructions covers ${w}`)
  }
  const cards = appCards()
  for (const id of ['claude-ai', 'claude-code', 'antigravity', 'gemini', 'grok', 'chatgpt', 'antigravity-cloud', 'other']) {
    const card = new RegExp(`<article[^>]*data-app="${id}"[\\s\\S]*?<\\/article>`).exec(cards)?.[0] ?? ''
    for (const w of ['MCP', 'Confirm:', 'register_agent', 'remember', 'Restart:']) {
      assert.ok(card.includes(w), `card ${id} includes ${w}`)
    }
  }
  for (const [id, cfg] of [
    ['claude-code', '~/.claude/settings.json'],
    ['claude-code', '~/.codex/hooks.json'],
    ['antigravity', '~/.gemini/config/hooks.json'],
    ['gemini', '~/.gemini/settings.json'],
    ['antigravity-cloud', '.agents/hooks.json'],
  ] as const) {
    const card = new RegExp(`<article[^>]*data-app="${id}"[\\s\\S]*?<\\/article>`).exec(cards)?.[0] ?? ''
    assert.ok(card.includes(cfg) && card.includes('clyde-hook.sh'), `card ${id} carries inline hook config ${cfg}`)
  }
  const agentSetup = /<article[^>]*data-app="agent-setup"[\s\S]*?<\/article>/.exec(cards)?.[0] ?? ''
  assert.ok(agentSetup.includes('cl-sticky'), 'agent-setup wears a sticky-note card in the mosaic')
  // R78 (like-vincent #83): register first, then the one command (MCP and sign-in), the hooks, the gate, confirm, restart.
  for (const w of [
    'Register first:', 'register_agent', 'curl -fsSL https://heyclyde.me/install | sh', 'remember', '~/.config/memory/token',
    'clyde-hook.sh', '~/.gemini/config/hooks.json', '~/.claude/settings.json', '~/.codex/hooks.json', '~/.gemini/extensions/clyde/hooks/hooks.json',
    'Hooks (required):', 'Gate check:', 'Confirm:', 'Restart:', 'Paste into your coding agent',
  ]) {
    assert.ok(agentSetup.includes(w), `mosaic agent-setup card covers ${w}`)
  }
  const order = ['Register first:', 'Install:', 'Hooks (required):', 'Gate check:', 'Confirm:', 'Restart:'].map((w) => agentSetup.indexOf(w))
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'agent-setup walks register -> install -> hooks -> gate -> confirm -> restart in order')
  const support = /<h2 id="support">[\s\S]*?<\/main>/.exec(docs)?.[0] ?? ''
  assert.ok(support.includes(`href="mailto:${SUPPORT}"`), '/docs#support: a mailto link to support')
  assert.ok(docs.includes('href="/privacy"'), '/docs points export and delete at the privacy policy')
})

// The pages that went away answer 301 to their new home, which exists and has the anchor.
Deno.test('the dropped pages redirect', async () => {
  assert.deepEqual(MOVED, REDIRECTS, 'site.js MOVED')
  for (const [from, to] of Object.entries(REDIRECTS)) {
    calls = 0
    const r = await worker.fetch(new Request(`https://heyclyde.me${from}`, { headers: { accept: 'text/html' } }), ENV)
    assert.equal(r.status, 301, from)
    assert.equal(r.headers.get('location'), `https://heyclyde.me${to}`, from)
    assert.equal(calls, 0, `${from} needs nothing from the function`)
    const [path, hash] = to.split('#')
    const { r: there, html } = await get(`https://heyclyde.me${path}`)
    assert.equal(there.status, 200, `${from} lands on a page`)
    if (hash) assert.ok(html.includes(`id="${hash}"`), `${to} has its anchor`)
    assert.ok(!INDEXED.includes(from), `${from} is not indexed`)
  }
})

// ---- R72 (#77): voice, doodles, SEO, and the two new pages ----

const attr = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1])
const meta = (html: string, key: string) => attr(html, new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)"`, 'g'))

Deno.test('how it works carries the research', async () => {
  const { r, html } = await get('https://heyclyde.me/how-it-works')
  assert.equal(r.status, 200)
  assert.equal(h1s(html).length, 1, 'one h1')
  const how = text(html)
  assert.ok(/<h2[^>]*>[^<]+<\/h2>/.test(html) && (html.match(/<li[ >]/g) ?? []).length >= 4, '/how-it-works lists what Clyde tries to do')
  for (const u of ['arxiv.org/abs/2607.13591', 'alphaxiv.org/abs/2602.22406', 'PMC3069643', 'NBK3905', 'arxiv.org/pdf/2604.27283', 'arxiv.org/html/2604.00131', 'taatgenLebiereAnderson.pdf']) {
    assert.ok(html.includes(u), `/how-it-works links ${u}`)
  }
  const docs = [...Deno.readDirSync(new URL('../../../memory/', import.meta.url))].filter((e) => e.name.endsWith('.md'))
    .map((e) => Deno.readTextFileSync(new URL(`../../../memory/${e.name}`, import.meta.url))).join('\n')
  const papers = attr(html, /href="(https?:\/\/[^"]*(?:arxiv|alphaxiv|ncbi|ai\.rug\.nl)[^"]*)"/g)
  assert.ok(papers.length >= 7, `${papers.length} paper links`)
  for (const u of papers) assert.ok(docs.includes(u), `${u} is cited in memory/*.md`)
})

// The header and footer every heyclyde.me page shares.
Deno.test('every page has the same header nav and footer', async () => {
  for (const path of [...INDEXED, '/nope']) {
    const { html } = await get(`https://heyclyde.me${path}`)
    const nav = /<nav class="topnav"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ''
    assert.deepEqual(attr(nav, /href="([^"]+)"/g), ['/docs', '/how-it-works', '/guides', '/faq'], `${path}: header nav`)
    assert.deepEqual(h1s(`<h1>${nav}</h1>`), ['DocsHow it worksGuidesFAQ'], `${path}: header nav labels`)
    const bar = /<header class="bar[\s\S]*?<\/header>/.exec(html)?.[0] ?? ''
    assert.ok(/<a class="cl-btn cl-btn--primary" href="\/docs">Get Clyde<\/a>/.test(bar), `${path}: a Get Clyde button to /docs`)
    const foot = /<footer[\s\S]*?<\/footer>/.exec(html)?.[0] ?? ''
    assert.deepEqual(attr(foot, /href="([^"]+)"/g), ['/docs', '/how-it-works', '/guides', '/faq', `mailto:${SUPPORT}`, '/privacy', '/terms', DESIGN_URL], `${path}: footer links`)
  }
})

Deno.test('every page has its own SEO tags', async () => {
  const titles = new Set<string>(), descs = new Set<string>()
  for (const path of INDEXED) {
    const { html } = await get(`https://heyclyde.me${path}`)
    const title = attr(html, /<title>([^<]*)<\/title>/g), desc = meta(html, 'description')
    assert.equal(title.length, 1, `${path}: one title`)
    assert.ok(title[0].length <= 65, `${path}: title is ${title[0].length} characters: ${title[0]}`)
    assert.ok((title[0].match(/\bclyde\b/gi) ?? []).length <= 1, `${path}: title repeats Clyde: ${title[0]}`)
    assert.equal(desc.length, 1, `${path}: one description`)
    assert.ok(desc[0].length >= 50 && desc[0].length <= 160, `${path}: description is ${desc[0].length} characters`)
    titles.add(title[0]); descs.add(desc[0])
    assert.deepEqual(attr(html, /<link rel="canonical" href="([^"]*)"/g), [`https://heyclyde.me${path}`], `${path}: canonical`)
    assert.deepEqual(meta(html, 'og:type'), [path.startsWith('/guides/') ? 'article' : 'website'], `${path}: og:type`)
    for (const k of ['og:title', 'og:description', 'og:url']) assert.equal(meta(html, k).length, 1, `${path}: ${k}`)
    assert.deepEqual(meta(html, 'og:image'), ['https://heyclyde.me/brand/og-banner.png'], `${path}: og:image`)
    assert.deepEqual(meta(html, 'twitter:card'), ['summary_large_image'], `${path}: twitter:card`)
  }
  for (const g of GUIDES.filter((x) => x.kind === 'woe')) {
    assert.ok(g.title.endsWith('?') && g.title.length <= 65, `${g.path}: a woe's title is the question, under 66 characters: ${g.title}`)
    assert.ok((await get(`https://heyclyde.me${g.path}`)).html.includes(`<title>${g.title.replace(/'/g, '&#39;')}</title>`), `${g.path}: <title> is the woe's title`)
  }
  assert.ok(GUIDES.filter((x) => x.kind === 'woe').length >= 8, 'at least 8 woe guides')
  assert.equal(titles.size, INDEXED.length, 'every title is different')
  assert.equal(descs.size, INDEXED.length, 'every description is different')
  assert.ok(Deno.statSync(new URL('../../../memory/proxy/public/brand/og-banner.png', import.meta.url)).isFile, 'the OG image ships')
})

const jsonld = (html: string) => attr(html, /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g).map((b) => JSON.parse(b))

Deno.test('structured data', async () => {
  const blocks = jsonld((await get('https://heyclyde.me/')).html)
  assert.deepEqual(blocks.map((b) => b['@type']).sort(), ['Organization', 'SoftwareApplication', 'WebSite'], 'home: WebSite, Organization and SoftwareApplication')
  const app = blocks.find((b) => b['@type'] === 'SoftwareApplication')
  const offers = (app.offers ?? []).map((o: { price: string; priceCurrency: string }) => `${o.price} ${o.priceCurrency}`).sort()
  assert.deepEqual(offers, ['0 USD', '12.99 USD', '2.99 USD'])
  const site = blocks.find((b) => b['@type'] === 'WebSite'), org = blocks.find((b) => b['@type'] === 'Organization')
  assert.equal(site.url, 'https://heyclyde.me')
  assert.equal(org.url, 'https://heyclyde.me')
  assert.equal(org.email, SUPPORT)
  assert.ok(Deno.statSync(new URL(`../../../memory/proxy/public${new URL(org.logo).pathname}`, import.meta.url)).isFile, `the Organization logo ${org.logo} ships`)
  for (const b of blocks) assert.equal(b['@context'], 'https://schema.org')

  const faqHtml = (await get('https://heyclyde.me/faq')).html
  const faqBlocks = jsonld(faqHtml)
  const faq = faqBlocks.find((b) => b['@type'] === 'FAQPage')
  assert.ok(faq && faq.mainEntity.length >= 8, `a FAQPage with 8 or more questions, not ${faq?.mainEntity.length}`)
  const shown = attr(faqHtml, /<h2[^>]*>([^<]*)<\/h2>/g).map((q) => q.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"'))
  for (const q of faq.mainEntity) {
    assert.equal(q['@type'], 'Question')
    assert.ok(q.acceptedAnswer?.text?.length > 0, `${q.name}: an answer`)
    assert.ok(shown.includes(q.name), `${q.name}: the question is on the page`)
  }

  for (const path of BASE.filter((p) => p !== '/')) {
    const b = jsonld((await get(`https://heyclyde.me${path}`)).html)
    const crumbs = b.find((x) => x['@type'] === 'BreadcrumbList')
    assert.ok(crumbs, `${path}: a BreadcrumbList`)
    assert.deepEqual(crumbs.itemListElement.map((e: { position: number; item: string }) => [e.position, e.item]),
      [[1, 'https://heyclyde.me'], [2, `https://heyclyde.me${path}`]], `${path}: breadcrumbs`)
    assert.ok(!b.some((x) => x['@type'] === 'FAQPage') || path === '/faq', `${path}: no FAQPage`)
  }
  assert.ok(!jsonld((await get('https://heyclyde.me/nope')).html).length, 'the 404 carries no structured data')
})

Deno.test('sitemap and robots', async () => {
  assert.deepEqual(SITE_INDEXED, INDEXED, 'site.js INDEXED')
  const sitemap = await worker.fetch(new Request('https://heyclyde.me/sitemap.xml'), ENV)
  assert.equal(sitemap.status, 200)
  assert.match(String(sitemap.headers.get('content-type')), /^application\/xml/)
  const xml = await sitemap.text()
  assert.deepEqual(attr(xml, /<loc>([^<]*)<\/loc>/g), INDEXED.map((p) => `https://heyclyde.me${p}`))
  assert.ok(xml.includes('<loc>https://heyclyde.me/faq</loc>'), '/faq is in the sitemap')
  const urls = attr(xml, /<url>([\s\S]*?)<\/url>/g)
  assert.equal(urls.length, INDEXED.length)
  for (const u of urls) {
    const mod = attr(u, /<lastmod>([^<]*)<\/lastmod>/g)
    assert.equal(mod.length, 1, `${u}: one lastmod`)
    assert.match(mod[0], /^\d{4}-\d{2}-\d{2}$/, `${u}: lastmod is a W3C date`)
    assert.ok(!Number.isNaN(Date.parse(mod[0])), `${u}: lastmod ${mod[0]} is a real date`)
  }
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

Deno.test('llms.txt and the IndexNow key', async () => {
  calls = 0
  const llms = await worker.fetch(new Request('https://heyclyde.me/llms.txt'), ENV)
  assert.equal(llms.status, 200)
  assert.match(String(llms.headers.get('content-type')), /^text\/markdown/)
  const md = await llms.text()
  assert.ok(md.startsWith('# Clyde\n'), 'llms.txt opens with an h1')
  assert.ok(md.includes('https://heyclyde.me/mcp'), 'llms.txt names the MCP URL')
  assert.ok(md.includes('https://heyclyde.me/clyde-hook.sh'), 'llms.txt names the hook script URL')
  const links = attr(md, /\]\((https:\/\/heyclyde\.me[^)]*)\)/g).map((u) => new URL(u).pathname)
  assert.ok(links.length >= 4, `${links.length} links`)
  for (const p of links) assert.ok(INDEXED.includes(p), `llms.txt links ${p}, an indexed page`)
  const hookRes = await worker.fetch(new Request('https://heyclyde.me/clyde-hook.sh'), ENV)
  assert.equal(hookRes.status, 200)
  assert.match(String(hookRes.headers.get('content-type')), /^text\/x-shellscript/)
  assert.equal(await hookRes.text(), CLYDE_HOOK_SH)
  assert.match(INDEXNOW_KEY, /^[a-f0-9]{32}$/, 'IndexNow key is 32 hex characters')
  const key = await worker.fetch(new Request(`https://heyclyde.me/${INDEXNOW_KEY}.txt`), ENV)
  assert.equal(key.status, 200)
  assert.match(String(key.headers.get('content-type')), /^text\/plain/)
  assert.equal(await key.text(), INDEXNOW_KEY)
  assert.equal(calls, 0, 'neither file reaches the function')
  assert.equal((await worker.fetch(new Request('https://heyclyde.me/0000000000000000.txt', { headers: { accept: 'text/html' } }), ENV)).status, 404, 'another .txt is the 404')
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

// R73 (#78): the home page's wall of real complaints about forgetful agents, each with its source and what Clyde does.
Deno.test('complaints wall', async () => {
  const { html } = await get('https://heyclyde.me/')
  const wall = /<section[^>]*id="complaints"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? ''
  const items = [...wall.matchAll(/<article class="complaint"[^>]*>([\s\S]*?)<\/article>/g)].map((m) => m[1])
  assert.ok(items.length >= 6, `${items.length} complaints on the wall`)
  for (const it of items) {
    const links = [...it.matchAll(/<a\s[^>]*>/g)].map((m) => m[0]).filter((a) => /href="https?:/.test(a))
    assert.equal(links.length, 1, 'exactly one source link')
    assert.match(links[0], /href="https:\/\//, 'the source is https')
    assert.match(links[0], /rel="[^"]*\bnofollow\b[^"]*"/, 'nofollow')
    assert.match(links[0], /rel="[^"]*\bnoopener\b[^"]*"/, 'noopener')
    assert.equal((it.match(/class="clyde-says\b/g) ?? []).length, 1, "exactly one Clyde note")
    for (const q of text(it).matchAll(/["“]([^"”]+)["”]/g)) assert.ok(q[1].trim().split(/\s+/).length <= 14, `quote over 14 words: ${q[1]}`)
  }
  assert.ok(!/\sstyle="/.test(wall), 'no style attributes')
})

// ---- R79 (like-vincent #84): guides people find by searching what went wrong, and no byte caps ----

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length
const unescape = (s: string) => s.replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"')

Deno.test('guides', async () => {
  assert.ok(GUIDES.length >= 14, `${GUIDES.length} guides`)
  const index = await get('https://heyclyde.me/guides')
  assert.equal(index.r.status, 200)
  assert.equal(h1s(index.html).length, 1, '/guides: one h1')
  for (const g of GUIDES) {
    assert.match(g.path, /^\/guides\/[a-z0-9-]+$/)
    assert.ok(index.html.includes(`href="${g.path}"`), `/guides links ${g.path}`)
    const { r, html } = await get(`https://heyclyde.me${g.path}`)
    assert.equal(r.status, 200, g.path)
    assert.match(String(r.headers.get('content-type')), /^text\/html/)
    assert.deepEqual(h1s(html), [unescape(g.h1).replace(/<[^>]+>/g, '')], `${g.path}: one h1`)
  }
  const xml = await (await worker.fetch(new Request('https://heyclyde.me/sitemap.xml'), ENV)).text()
  const llms = await (await worker.fetch(new Request('https://heyclyde.me/llms.txt'), ENV)).text()
  for (const p of ['/guides', ...GUIDES.map((g) => g.path)]) {
    assert.ok(xml.includes(`<loc>https://heyclyde.me${p}</loc>`), `sitemap lists ${p}`)
    assert.ok(llms.includes(`https://heyclyde.me${p})`), `llms.txt lists ${p}`)
  }
})

Deno.test('guides answer first', async () => {
  for (const g of GUIDES) {
    const { html } = await get(`https://heyclyde.me${g.path}`)
    const answer = /<p class="answer">([\s\S]*?)<\/p>/.exec(html)?.[1]
    assert.ok(answer, `${g.path}: a p.answer`)
    assert.ok(html.indexOf('<p class="answer">') > html.indexOf('</h1>'), `${g.path}: the answer comes after the h1`)
    assert.ok(words(text(answer!)) <= 60, `${g.path}: the answer is ${words(text(answer!))} words`)
    const shown = attr(html, /<h3 class="q">([^<]*)<\/h3>/g).map(unescape)
    assert.ok(shown.length >= 3, `${g.path}: ${shown.length} visible questions`)
    const blocks = jsonld(html)
    const art = blocks.find((b) => b['@type'] === 'Article')
    assert.ok(art, `${g.path}: an Article`)
    assert.equal(art.headline, h1s(html)[0], `${g.path}: headline is the h1`)
    assert.match(art.dateModified, /^\d{4}-\d{2}-\d{2}$/)
    assert.equal(art.publisher?.name, 'Pennywhistle software')
    const crumbs = blocks.find((b) => b['@type'] === 'BreadcrumbList')
    assert.deepEqual(crumbs?.itemListElement.map((e: { item: string }) => e.item), ['https://heyclyde.me', 'https://heyclyde.me/guides', `https://heyclyde.me${g.path}`], `${g.path}: crumbs`)
    const faq = blocks.find((b) => b['@type'] === 'FAQPage')
    assert.deepEqual(faq?.mainEntity.map((q: { name: string }) => q.name), shown, `${g.path}: FAQPage matches the visible questions`)
  }
})

Deno.test('guides link each other', async () => {
  for (const g of GUIDES) {
    const { html } = await get(`https://heyclyde.me${g.path}`)
    const main = /<main[\s\S]*?<\/main>/.exec(html)?.[0] ?? ''
    const others = new Set(attr(main, /href="(\/guides\/[a-z0-9-]+)"/g).filter((p) => p !== g.path))
    assert.ok(others.size >= 2, `${g.path} links ${others.size} other guides`)
    assert.ok(/href="\/docs(#[^"]*)?"/.test(main), `${g.path} links /docs`)
  }
  const { html } = await get('https://heyclyde.me/')
  const wall = /<section[^>]*id="complaints"[^>]*>([\s\S]*?)<\/section>/.exec(html)?.[1] ?? ''
  const items = [...wall.matchAll(/<article class="complaint"([^>]*)>([\s\S]*?)<\/article>/g)]
  for (const [, head, body] of items) {
    const guide = /data-guide="([^"]+)"/.exec(head)?.[1]
    assert.ok(guide && GUIDES.some((g) => g.path === guide), `a complaint names a real guide: ${guide}`)
    assert.ok(body.includes(`href="${guide}"`), `the complaint links ${guide}`)
  }
})

Deno.test('no byte caps', () => {
  // Wen, 2026-11-17: "no cap". No page, chat card or logo has a byte budget (R79, like-vincent #84).
  const caps = new RegExp(['PAGE', 'HOME'].map((w) => `${w}_MAX`).join('|') + '|(?:byteLength\\([^)]*\\)|encode\\([^)]*\\)\\.length)\\s*<' + '=')
  for (const f of ['site_test.ts', 'proxy_test.ts', 'ui.test.ts', 'design_test.ts']) {
    const src = Deno.readTextFileSync(new URL(`./${f}`, import.meta.url))
    assert.equal(caps.exec(src)?.[0] ?? null, null, `${f} caps something's bytes`)
  }
  for (const f of ['BRAND.md', 'ASSETS.md']) {
    const doc = Deno.readTextFileSync(new URL(`../../../design/${f}`, import.meta.url))
    assert.equal(/<=\s*`?[\d.,]+\s*(?:KB|bytes)|`<=\s*[\d.,]+`\s*bytes/.exec(doc)?.[0] ?? null, null, `${f} names a byte budget`)
  }
})

Deno.test('mobile nav, workspace accessibility, and accurate docs hook claims', async () => {
  const home = (await get('https://heyclyde.me/')).html
  assert.ok(!home.includes('.topnav{display:none}'), 'mobile header keeps primary navigation visible')
  assert.ok(home.includes('<nav class="topnav" aria-label="Primary">'), 'primary nav has accessible label')
  assert.ok(home.includes('<nav aria-label="Footer">'), 'footer nav has accessible label')

  const docs = (await get('https://heyclyde.me/docs')).html
  assert.ok(docs.includes('quick follow-ups skip recall while keeping the save reminder'), 'Antigravity docs match follow-up behavior')
  assert.ok(docs.includes('blocks <code>Stop</code> once if <code>remember</code> was skipped'), 'Codex docs match Stop behavior')

  const graph = (await get('https://heyclyde.me/graph')).html
  assert.ok(graph.includes('aria-current="page"'), 'active workspace nav link marks aria-current="page"')
  assert.ok(graph.includes('role="group" aria-label="Note neighborhood graph"'), 'graph SVG exposes interactive links with role="group"')
  assert.ok(graph.includes('role="status" aria-live="polite"'), 'graph status announces updates politely')
  assert.ok(graph.includes('Connect new agent') && graph.includes('View agents'), 'workspace header exposes Connect new agent and View agents actions')
  assert.ok(graph.includes('/auth/v1/logout?scope=local'), 'browser sign-out uses local scope so MCP sessions stay active')
  assert.ok(graph.includes("el.setAttribute('aria-live'"), 'workspace notices announce via aria-live')
  assert.ok(graph.includes('<nav aria-label="Footer">'), 'workspace footer nav has accessible label')
})

Deno.test('Round 1B: skip links, Sign in header CTA, dark/light theme-color, /docs wrap, and carousel keys', async () => {
  for (const path of [...INDEXED, '/nope']) {
    const { html } = await get(`https://heyclyde.me${path}`)
    assert.ok(html.includes('<a class="cl-skip" href="#main">Skip to content</a>'), `${path}: skip link`)
    assert.ok(/<main id="main" tabindex="-1"/.test(html), `${path}: main landmark target`)
    assert.ok(html.includes('<meta name="theme-color" content="#f4f4f1" media="(prefers-color-scheme: light)">'), `${path}: light theme-color`)
    assert.ok(html.includes('<meta name="theme-color" content="#121311" media="(prefers-color-scheme: dark)">'), `${path}: dark theme-color`)
    assert.ok(!html.includes('content="#f3f1ea"'), `${path}: no stale theme-color`)
    assert.ok(html.includes('<span class="acts"><a class="cl-btn acts-signin" href="/memories">Sign in</a><a class="cl-btn cl-btn--primary" href="/docs">Get Clyde</a></span>'), `${path}: Sign in button before Get Clyde`)
  }
  const home = (await get('https://heyclyde.me/')).html
  assert.ok(home.includes('<span class="rc-count" aria-live="polite">1 / 6</span>'), 'carousel count is polite live region')
  assert.ok(home.includes("e.key==='ArrowLeft'") && home.includes("e.key==='ArrowRight'"), 'carousel track wires Left/Right arrow keys')
  assert.ok(home.includes('Work in progress: Clyde is still finishing this integration.'), 'clarified SOON_NOTE copy')
  const docs = (await get('https://heyclyde.me/docs')).html
  assert.ok(docs.includes('grid-template-columns:minmax(0,1fr)') && docs.includes('.doc>*{min-width:0;max-width:100%}'), '/docs grid prevents mobile overflow')
  assert.ok(docs.includes('.cl-file__head>span{min-width:0;overflow-wrap:anywhere;}'), 'long file headings wrap cleanly')
})

// R79 (like-vincent #84), Wen 2026-11-17: "memory, message board, agent coordination, all the keywords". Each phrase someone
// might search sits in a page's <title> or h1, in llms.txt, and in the home page's SoftwareApplication keywords.
const KEYWORDS = ['AI agent memory', 'shared memory', 'MCP memory server', 'message board', 'agent coordination', 'multi-agent',
  'long-term memory', 'persistent memory', 'quest board', 'agent handoff', 'memory for Claude Code']
Deno.test('keywords', async () => {
  const heads: string[] = []
  for (const path of INDEXED) {
    const { html } = await get(`https://heyclyde.me${path}`)
    heads.push(unescape([...attr(html, /<title>([^<]*)<\/title>/g), ...h1s(html)].join(' | ')).toLowerCase())
  }
  const llms = (await (await worker.fetch(new Request('https://heyclyde.me/llms.txt'), ENV)).text()).toLowerCase()
  const home = (await get('https://heyclyde.me/')).html
  const app = jsonld(home).find((b) => b['@type'] === 'SoftwareApplication')
  const keys = String(app?.keywords ?? '').toLowerCase()
  for (const k of KEYWORDS.map((x) => x.toLowerCase())) {
    assert.ok(heads.some((h) => h.includes(k)), `"${k}" is in a page's title or h1`)
    assert.ok(llms.includes(k), `llms.txt says "${k}"`)
    assert.ok(keys.includes(k), `the home SoftwareApplication's keywords include "${k}"`)
  }
  const title = attr(home, /<title>([^<]*)<\/title>/g)[0].toLowerCase()
  for (const k of ['memory', 'message board', 'coordination']) assert.ok(title.includes(k), `the home title says ${k}`)
})
