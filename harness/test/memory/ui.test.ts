/**
 * R67 (#72): the cards chat apps render. Who gets them, and the cards themselves, rendered in headless Chrome behind a
 * stand-in MCP Apps host (ui-host.ts): they draw, escape everything from memory, call the right tools, follow the host's
 * theme and fit chat width. No database: apps.test.ts covers the function's side.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { readUiResource, requestWantsUi, uiResources, uriOf, wantsUi, UI_EXTENSION, UI_MIME } from '../../../memory/supabase/functions/memory/ui/apps.ts'
import { CARDS, cardHtml } from '../../../memory/supabase/functions/memory/ui/cards.ts'
import { CARD_CSS } from '../../../memory/supabase/functions/memory/ui/style.ts'
import { COMPONENTS_CSS, LOGO_LOCKUP, TOKENS_CSS } from '../../../memory/supabase/functions/memory/ui/design.ts'
import { LOGO_LOCKUP as BRAND_LOCKUP } from '../../../design/brand.js'
import * as design from '../../../memory/design/css.js'
import { CALLS, FIXTURES, RID } from './ui-fixtures.ts'
import { findChrome, hostPage, render, type Frame } from './ui-host.ts'

const CHROME = findChrome()
// CI runs on ubuntu-latest, which has Chrome, so there a missing browser fails rather than skips.
const NO_CHROME = CHROME ? false : process.env.CI ? false : 'no Chrome or Chromium on this computer (set CHROME)'
const dir = mkdtempSync(join(tmpdir(), 'clyde-ui-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const cardFor = (fixture: string) => (fixture === 'error' ? 'quests' : fixture)
const frames = (theme: 'light' | 'dark', width: number, clicks: Record<string, string[]> = {}): Frame[] =>
  Object.keys(FIXTURES).map((f) => ({ id: f, card: cardFor(f), html: cardHtml(cardFor(f)), theme, result: FIXTURES[f], width, clicks: clicks[f] }))
let n = 0
function run(list: Frame[]) {
  assert.ok(CHROME, 'Chrome is needed: set CHROME to its path')
  const file = join(dir, `host-${++n}.html`)
  writeFileSync(file, hostPage(list, CALLS))
  return render(CHROME!, file, join(dir, `profile-${n}`))
}

test('R67 only card-rendering clients get cards', () => {
  const ext = (mimeTypes?: string[]) => ({ extensions: { [UI_EXTENSION]: mimeTypes ? { mimeTypes } : {} } })
  const cases: [string, unknown, boolean][] = [
    ['claude-ai', undefined, true], ['Anthropic/claude.ai', undefined, true], ['openai-mcp', undefined, true], ['chatgpt', undefined, true],
    ['r67-any', ext(), true],
    ['claude-code', undefined, false], ['codex-mcp-client', undefined, false], ['gemini-cli-mcp-client', undefined, false], ['antigravity', undefined, false],
    ['claude-code', ext(['text/html']), false],
  ]
  let right = 0
  for (const [name, capabilities, want] of cases) {
    assert.equal(wantsUi({ clientInfo: { name }, capabilities }), want, `${name} ${JSON.stringify(capabilities)}`)
    right++
  }
  assert.equal(right, 10)
  assert.equal(wantsUi({ clientInfo: { name: 'r67-any' }, capabilities: ext([UI_MIME]) }), true)
  assert.equal(requestWantsUi({ _meta: { 'io.modelcontextprotocol/clientCapabilities': ext([UI_MIME]) } }), true)
  assert.equal(requestWantsUi({ _meta: { 'openai/userAgent': 'Mozilla/5.0' } }), true)
  assert.equal(requestWantsUi({}, 'openai-mcp/1.0.0'), true)
  assert.equal(requestWantsUi({}, 'claude-code/1.0'), false)
})

test('R67 cards are self-contained', () => {
  assert.equal(Object.keys(CARDS).length, 6)
  for (const card of Object.keys(CARDS)) {
    const html = cardHtml(card)
    assert.equal((html.match(/(src|href)\s*=\s*["']?https?:/gi) ?? []).length, 0, `${card} fetches nothing`)
    assert.equal(html.split('</script>').length - 1, 1, `${card} has one script, which nothing in it closes early`)
    const r = readUiResource(uriOf(card), 'https://project.supabase.co')!
    assert.equal(r.contents[0].mimeType, UI_MIME)
    assert.equal((r.contents[0]._meta.ui as any).csp?.connectDomains, undefined, `${card} connects nowhere`)
  }
  assert.equal(uiResources().length, 6)
  assert.equal(readUiResource('ui://clyde/nope.html', null), null)
})

test('R67 the cards use only the design tokens', () => {
  // The function's copy of Clyde's design system is memory/design/css.js's, word for word.
  assert.equal(TOKENS_CSS, design.TOKENS_CSS, 'run node memory/design/build.mjs')
  assert.equal(COMPONENTS_CSS, design.COMPONENTS_CSS, 'run node memory/design/build.mjs')
  assert.equal(LOGO_LOCKUP, BRAND_LOCKUP, 'the logo is brand.js\'s: run node memory/design/build.mjs')
  for (const card of Object.keys(CARDS)) {
    const html = cardHtml(card)
    assert.ok(html.includes(BRAND_LOCKUP), `${card} carries the logo`)
    assert.ok(!html.includes('Nothing filed matches yet.'), `${card} drops retired clerk copy`)
    assert.ok(html.includes('Nothing in Clyde matches that yet.') && html.includes("Quest board's empty."), `${card} carries non-serious empty state copy`)
  }
  const defined = new Set([...(TOKENS_CSS + COMPONENTS_CSS).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]))
  const used = new Set([...CARD_CSS.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  assert.ok(used.size > 10)
  for (const name of used) assert.ok(defined.has(name), `${name} is not a design token`)
  assert.equal((CARD_CSS.match(/#[0-9a-f]{3,8}\b|rgb\(/gi) ?? []).length, 0, 'the card CSS has no literal colors')
})

test('R67 cards stay lean, drop noise, and escape everything', { skip: NO_CHROME }, () => {
  const ids = Object.keys(FIXTURES)
  assert.equal(ids.length, 7)
  const report = run(frames('light', 640))
  for (const id of ids) {
    const f = report.frames[id]
    assert.equal(f.ready, cardFor(id), `${id} drew`)
    assert.equal(f.injected, 0, `${id} made no element from data`)
    assert.ok(f.text.includes('<b class="injected">'), `${id} shows the markup as text`)
  }
  for (const id of ['recall', 'entry'] as const) {
    assert.match(report.frames[id].text, /\d+%/, `${id} shows confidence percentage`)
    assert.ok(!report.frames[id].text.includes('% confidence'), `${id} drops verbose confidence label`)
    assert.ok(!report.frames[id].text.includes('unreviewed'), `${id} drops unreviewed label`)
    assert.ok(!report.frames[id].text.includes('agent-filed'), `${id} drops agent-filed label`)
    assert.equal(report.frames[id].memoryPadding, '10px 12px', `${id} keeps lean .cl-memory padding when open`)
  }
  const rem = report.frames.remembered
  assert.equal(rem.memoryPadding, '10px 12px', 'remembered keeps lean .cl-memory padding when open')
  assert.ok(report.sizes.remembered.height <= 200, `remembered card height ${report.sizes.remembered.height}px <= 200px at 640px`)
  assert.match(rem.text, /\bSaved\b/, 'remembered card marks Saved')
  assert.ok(rem.text.includes('a4c6f84') && !rem.text.includes('`a4c6f84`'), 'remembered renders inline code without raw backticks')
  for (const noise of ["won't forget", 'unreviewed', 'agent-filed', '% confidence', 'oauth:', 'Copy id', 'Notes by ', 'you wrote this']) {
    assert.ok(!rem.text.includes(noise), `remembered omits "${noise}"`)
  }
  assert.deepEqual(rem.buttons, ['Open', 'Collapse'], 'remembered has only Open and one collapse toggle')
  assert.ok(report.frames.entry.text.includes('The version guard'), 'entry shows real supports link')
  for (const noise of ['Notes by ', 'oauth:', 'you wrote this', 'Copy id']) {
    assert.ok(!report.frames.entry.text.includes(noise), `entry strips "${noise}"`)
  }
  assert.ok(report.frames.entry.text.includes('from codex in repo:like-vincent (work)'), 'entry keeps clean provenance')
  assert.equal(report.frames.agent.memoryPadding, null, 'agent card has no .cl-memory wrapper')
  assert.equal(report.xss, 0)
  // Compact stays one click away.
  const compact = run(frames('light', 640, { entry: ['button.c-toggle'], remembered: ['button.c-toggle'], artifact: ['button.c-toggle'] }))
  for (const id of ['entry', 'remembered', 'artifact'] as const) assert.ok(compact.frames[id].compactItems >= 1, `${id} folds on Collapse`)
  assert.equal(compact.xss, 0)
})

// R78 (like-vincent #83): a card shows open, in the conversation, with no click. It declares inline first, asks the host for
// inline, carries ChatGPT's inline-first hint, and puts its height on the document for hosts that read it there.
test('R78 cards open inline and expanded', { skip: NO_CHROME }, () => {
  const report = run(frames('light', 640))
  for (const id of Object.keys(FIXTURES)) {
    const f = report.frames[id]
    assert.equal(f.compactItems, 0, `${id} starts open`)
    assert.deepEqual(report.appCapabilities[id]?.availableDisplayModes, ['inline', 'fullscreen'], `${id} declares inline first`)
    const asks = report.requests.filter((r: any) => r.frame === id && r.method === 'ui/request-display-mode')
    assert.equal(asks.length, 1, `${id} asks for a display mode once`)
    assert.deepEqual(asks[0].params, { mode: 'inline' })
    assert.match(f.docHeight, /^\d+px$/, `${id} puts its height on the document`)
    assert.equal(parseInt(f.docHeight), report.sizes[id].height, `${id} document height matches size-changed`)
  }
  for (const card of Object.keys(CARDS)) {
    const meta = readUiResource(uriOf(card), null)!.contents[0]._meta as any
    assert.deepEqual(meta['openai/ui'], { availableDisplayModes: ['inline', 'fullscreen'] }, card)
    assert.equal(meta.ui.prefersBorder, false, card)
    assert.equal(meta.ui.preferredDisplayMode, undefined, `${card} stays in the conversation`)
  }
})

test('R67 multi-item cards cap at top three by default with a show-more button', { skip: NO_CHROME }, () => {
  const baseRecall = (FIXTURES.recall as any)._meta['clyde/card']
  const manyRecall = {
    content: [{ type: 'text', text: '5 results' }],
    _meta: { 'clyde/card': { ...baseRecall, items: [1, 2, 3, 4, 5].map((k) => ({ ...baseRecall.items[0], id: `m-${k}`, title: `Result ${k}` })) } },
  }
  const baseQuests = (FIXTURES.quests as any)._meta['clyde/card']
  const manyQuests = {
    content: [{ type: 'text', text: '5 quests' }],
    _meta: { 'clyde/card': { ...baseQuests, quests: [1, 2, 3, 4, 5].map((k) => ({ ...baseQuests.quests[0], id: 100 + k, title: `Quest ${k}` })) } },
  }
  const report = run([
    { id: 'r-capped', card: 'recall', html: cardHtml('recall'), theme: 'dark', result: manyRecall, width: 640 },
    { id: 'r-more', card: 'recall', html: cardHtml('recall'), theme: 'dark', result: manyRecall, width: 640, clicks: ['button.c-more'] },
    { id: 'q-capped', card: 'quests', html: cardHtml('quests'), theme: 'dark', result: manyQuests, width: 640 },
    { id: 'q-more', card: 'quests', html: cardHtml('quests'), theme: 'dark', result: manyQuests, width: 640, clicks: ['button.c-more'] },
  ])
  assert.equal(report.frames['r-capped'].visibleItems, 3)
  assert.ok(report.frames['r-capped'].buttons.includes('Show 2 more'))
  assert.equal(report.frames['r-more'].visibleItems, 5)
  assert.ok(report.frames['r-more'].buttons.includes('Show top 3'))
  assert.equal(report.frames['q-capped'].visibleItems, 3)
  assert.ok(report.frames['q-capped'].buttons.includes('Show 2 more'))
  assert.equal(report.frames['q-more'].visibleItems, 5)
})

test('R67 card buttons call the tools, and degrade cleanly when host tool IPC is missing', { skip: NO_CHROME }, () => {
  const report = run(frames('light', 640, {
    recall: ['div.c-foot button.cl-btn--primary', 'article[data-id="e-1"] button.c-open'],
    quests: ['article[data-quest="12"] button.c-qsum', 'article[data-quest="12"] button.c-claim'],
  }))
  const calls = report.calls.map((c: any) => ({ name: c.name, arguments: c.arguments }))
  assert.deepEqual(calls, [
    { name: 'feedback', arguments: { retrieval_id: RID, verdict:'helpful', card_vote:true } },
    { name: 'get_entry', arguments: { id: 'e-1' } },
    { name: 'claim_quest', arguments: { id: 12 } },
  ])

  const noIpcReport = run([
    {
      id: 'recall-noipc', card: 'recall', html: cardHtml('recall'), theme: 'dark', result: FIXTURES.recall, width: 640, noIpc: true,
      clicks: ['div.c-foot button.cl-btn--primary', 'article[data-id="e-1"] button.c-open'],
    },
    {
      id: 'quests-noipc', card: 'quests', html: cardHtml('quests'), theme: 'dark', result: FIXTURES.quests, width: 640, noIpc: true,
      clicks: ['article[data-quest="12"] button.c-qsum', 'article[data-quest="12"] button.c-claim'],
    },
  ])
  for (const id of ['recall-noipc', 'quests-noipc'] as const) {
    assert.ok(!noIpcReport.frames[id].text.includes('IPC not available'), `${id} hides raw IPC error`)
  }
  assert.match(noIpcReport.frames['recall-noipc'].text, /Feedback can't send from this card right now/)
  assert.ok(noIpcReport.frames['recall-noipc'].buttons.includes('Hide details') && noIpcReport.frames['recall-noipc'].buttons.includes('Details') && noIpcReport.frames['recall-noipc'].buttons.includes('Open'), 'Details falls back to local entry details without IPC')
  assert.match(noIpcReport.frames['quests-noipc'].text, /Actions can't send from this card right now/)
})

test('R67 cards follow the host theme and fit chat width', { skip: NO_CHROME }, () => {
  const expandAll = Object.fromEntries(Object.keys(FIXTURES).map((id) => [id, ['button.c-toggle']]))
  let checked = 0
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [640, 360]) {
      for (const clicks of [{}, expandAll]) {
        const report = run(frames(theme, width, clicks))
        for (const [id, f] of Object.entries<any>(report.frames)) {
          assert.equal(f.theme, theme, `${id} ${theme} ${width}`)
          assert.equal(f.background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(27, 28, 26)', `${id} ${theme}`)
          assert.equal(f.overflow, false, `${id} at ${width} px scrolls sideways`)
          checked++
        }
      }
    }
  }
  assert.equal(checked, 56)
})

test('Quest #47: MCP cards wire vote state, live status regions, form labels, and focus', () => {
  const recallHtml = cardHtml('recall')
  assert.ok(recallHtml.includes('role:"status"') || recallHtml.includes('"role":"status"') || recallHtml.includes('role: "status"'), 'recall status uses role=status')
  assert.ok(recallHtml.includes('"aria-live": "polite"') || recallHtml.includes('"aria-live":"polite"'), 'recall status uses aria-live=polite')
  assert.ok(recallHtml.includes('"aria-pressed"') && recallHtml.includes('c-used') && recallHtml.includes('c-wrong'), 'recall vote buttons expose aria-pressed and vote classes')
  assert.ok(CARD_CSS.includes('.cl-btn.c-used[aria-pressed=true]') && CARD_CSS.includes('opacity:1'), 'pressed vote button preserves WCAG contrast when disabled')
  assert.ok(recallHtml.includes('role:"alert"') || recallHtml.includes('role: "alert"'), 'async card errors use role=alert')
  const questsHtml = cardHtml('quests')
  assert.ok(questsHtml.includes('for: evId') && questsHtml.includes('for: enId'), 'quest completion form associates labels with inputs')
  assert.ok(questsHtml.includes('(open ? fold : sum).focus()'), 'expand/collapse preserves keyboard focus')
})

test('an empty recall offers no feedback action', { skip: NO_CHROME }, () => {
  const empty = structuredClone(FIXTURES.recall)
  empty._meta['clyde/card'].items = []
  const report = run([{ id: 'empty', card: 'recall', html: cardHtml('recall'), theme: 'dark', result: empty, width: 375 }])
  assert.match(report.frames.empty.text, /Nothing in Clyde matches/)
  assert.ok(!report.frames.empty.buttons.some(label => /That helped|That didn/.test(label)))
})

test('ChatGPT hybrid host with window.openai still completes MCP Apps handshake and renders', { skip: NO_CHROME }, () => {
  const report = run([
    {
      id: 'chatgpt-hybrid', card: 'recall', html: cardHtml('recall'), theme: 'dark', result: FIXTURES.recall, width: 640,
      withOpenAi: true, clicks: ['div.c-foot button.cl-btn--primary'],
    },
    {
      id: 'chatgpt-meta-oa', card: 'recall', html: cardHtml('recall'), theme: 'light', result: FIXTURES.recall, width: 640,
      withOpenAi: true, stripMeta: true,
    },
  ])
  for (const id of ['chatgpt-hybrid', 'chatgpt-meta-oa'] as const) {
    assert.equal(report.initialized[id], true, `${id} completes ui/initialize + initialized despite window.openai`)
    assert.equal(report.frames[id].ready, 'recall', `${id} renders the recall card`)
    assert.ok(report.sizes[id]?.height > 0, `${id} sends ui/notifications/size-changed`)
    assert.ok(report.frames[id].oaHeights.length > 0, `${id} notifies window.openai intrinsic height too`)
  }
  assert.equal(report.frames['chatgpt-hybrid'].oaCalls, 0, 'hybrid MCP Apps host sends tools/call over MCP bridge')
  assert.deepEqual(report.calls.map((c: any) => ({ frame: c.frame, name: c.name })), [
    { frame: 'chatgpt-hybrid', name: 'feedback' },
  ])
})

test('Round 1B: MCP card button targets, degraded fallback copy, and Open in Clyde', { skip: NO_CHROME }, () => {
  for (const sel of ['.c-toggle', '.c-fold', '.c-more', '.c-art']) {
    assert.match(CARD_CSS, new RegExp(`\\${sel}\\{[^}]*min-height:28px`), `CARD_CSS includes ${sel} min-height:28px`)
  }
  assert.match(CARD_CSS, /@media \(pointer:coarse\)\{[^}]*min-height:44px/, 'CARD_CSS bumps touch targets to 44px on coarse pointers')
  assert.ok(CARD_CSS.includes('touch-action:manipulation'), 'touch-action in CARD_CSS')
  assert.ok(!CARD_CSS.includes('.c-sum .cl-state{font-size:0'), 'collapsed state text stays visible at <= 460px')
  const degradedRecall = structuredClone(FIXTURES.recall) as any
  degradedRecall._meta['clyde/card'].degraded = 'embed_timeout'
  const degradedFilter = structuredClone(FIXTURES.recall) as any
  degradedFilter._meta['clyde/card'].degraded = 'filter_failed'
  const report = run([
    { id: 'recall-deg', card: 'recall', html: cardHtml('recall'), theme: 'light', result: degradedRecall, width: 375, clicks: ['article[data-id="e-1"] button.c-open'] },
    { id: 'recall-filter', card: 'recall', html: cardHtml('recall'), theme: 'light', result: degradedFilter, width: 375 },
    { id: 'entry-open', card: 'entry', html: cardHtml('entry'), theme: 'dark', result: FIXTURES.entry, width: 375, clicks: ['button.c-ext'] },
    { id: 'rem-card', card: 'remembered', html: cardHtml('remembered'), theme: 'light', result: FIXTURES.remembered, width: 375, clicks: ['button.c-ext'] },
  ])
  assert.ok(report.frames['recall-deg'].text.includes('Keyword search fallback active.'), 'plain-English degraded banner')
  assert.ok(!report.frames['recall-deg'].text.includes('embed_timeout'), 'raw degraded code kept out of visible text')
  assert.ok(report.frames['recall-filter'].text.includes('Relevance filter failed, so results are unfiltered.'), 'filter degraded banner explains unfiltered results')
  assert.ok(!report.frames['recall-filter'].text.includes('filter_failed'), 'raw filter_failed code kept out of visible text')
  for (const id of ['recall-deg', 'entry-open', 'rem-card'] as const) {
    assert.ok(!report.frames[id].buttons.includes('Copy id'), `${id} drops Copy id`)
    assert.ok(report.frames[id].buttons.includes('Open'), `${id} shows Open link button`)
    assert.equal(report.frames[id].overflow, false, `${id} zero horizontal overflow at 375px`)
  }
  assert.ok(report.requests.some((r: any) => r.frame === 'entry-open' && r.method === 'ui/open-link' && r.params?.url === 'https://heyclyde.me/entries/e-4'), 'entry Open opens entry URL via ui/open-link')
  assert.ok(report.requests.some((r: any) => r.frame === 'rem-card' && r.method === 'ui/open-link' && r.params?.url === 'https://heyclyde.me/entries/e-5'), 'remembered Open opens entry URL via ui/open-link')
})

test('lean card interactions: long body More/Less, safe inline code XSS, collapsed mobile state, and quest form validation', { skip: NO_CHROME }, () => {
  const longRem = structuredClone(FIXTURES.remembered) as any
  longRem._meta['clyde/card'].entry.body = 'Line one with `ui/script.ts` and `<img src=x>`.\nLine two.\nLine three.\nLine four.\nLine five.\n' + 'Detail '.repeat(60)
  const report = run([
    { id: 'rem-long', card: 'remembered', html: cardHtml('remembered'), theme: 'light', result: longRem, width: 640 },
    { id: 'rem-long-open', card: 'remembered', html: cardHtml('remembered'), theme: 'light', result: longRem, width: 640, clicks: ['button.c-body-more'] },
    { id: 'recall-360-collapsed', card: 'recall', html: cardHtml('recall'), theme: 'dark', result: FIXTURES.recall, width: 360, clicks: ['button.c-toggle'] },
    {
      id: 'quest-empty-submit', card: 'quests', html: cardHtml('quests'), theme: 'light', result: FIXTURES.quests, width: 640,
      clicks: ['article[data-quest="13"] button.c-complete-btn', 'article[data-quest="13"] form.c-complete button[type="submit"]'],
    },
  ])
  assert.ok(report.frames['rem-long'].buttons.includes('More'), 'long remembered body shows More toggle')
  assert.ok(report.frames['rem-long'].text.includes('ui/script.ts') && !report.frames['rem-long'].text.includes('`ui/script.ts`'), 'inline code strips backticks')
  assert.ok(report.frames['rem-long'].text.includes('<img src=x>') && report.frames['rem-long'].injected === 0, 'backticked HTML stays escaped')
  assert.ok(report.frames['rem-long-open'].buttons.includes('Less'), 'clicking More flips to Less')
  assert.ok(report.sizes['rem-long-open'].height > report.sizes['rem-long'].height, 'expanding long body grows height')
  assert.equal(report.frames['recall-360-collapsed'].compactItems, 3, 'recall collapses all 3 rows at 360px')
  assert.equal(report.frames['recall-360-collapsed'].overflow, false, 'collapsed recall fits 360px')
  assert.ok(report.frames['recall-360-collapsed'].text.includes('on trial'), 'collapsed recall keeps state label legible at 360px')
  assert.equal(report.calls.length, 0, 'whitespace-only quest completion does not call complete_quest')
  assert.match(report.frames['quest-empty-submit'].text, /Add evidence showing done-when holds/, 'empty quest submit shows inline validation error')

  const dualDegraded = structuredClone(FIXTURES.recall) as any
  dualDegraded._meta['clyde/card'].degraded = 'embed-failed,filter-failed'
  const morePage = structuredClone(FIXTURES.recall) as any
  morePage._meta['clyde/card'].page = 'more'
  morePage._meta['clyde/card'].query = 'deploy'
  const moreEmpty = structuredClone(morePage) as any
  moreEmpty._meta['clyde/card'].items = []
  const pdfArt = structuredClone(FIXTURES.artifact) as any
  pdfArt._meta['clyde/card'].artifact = { sha256: 'b'.repeat(64), name: 'spec.pdf', media_type: 'application/pdf', size: 8192, url: 'https://storage.example/spec.pdf', text: null }
  const report2 = run([
    { id: 'recall-dual', card: 'recall', html: cardHtml('recall'), theme: 'light', result: dualDegraded, width: 375 },
    { id: 'recall-more', card: 'recall', html: cardHtml('recall'), theme: 'light', result: morePage, width: 640 },
    { id: 'recall-more-empty', card: 'recall', html: cardHtml('recall'), theme: 'light', result: moreEmpty, width: 640 },
    { id: 'art-pdf', card: 'artifact', html: cardHtml('artifact'), theme: 'dark', result: pdfArt, width: 375 },
  ])
  assert.match(report2.frames['recall-dual'].text, /keyword-only\s*·\s*unfiltered/i, 'dual degraded banner keeps both chips')
  assert.ok(report2.frames['recall-more'].text.includes('3 more memories for') && !report2.frames['recall-more'].text.includes('more for 3'), 'recall_more uses clean grammar')
  assert.ok(report2.frames['recall-more-empty'].text.includes('Nothing more in Clyde matches that.'), 'empty recall_more states no more matches')
  assert.ok(report2.frames['art-pdf'].text.includes('expires in 10 minutes') && report2.frames['art-pdf'].buttons.includes('Download') && !report2.frames['art-pdf'].buttons.includes('Expand'), 'binary artifact card shows expiry and omits dead toggle')
})
