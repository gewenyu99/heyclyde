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
import { readUiResource, uiResources, uriOf, wantsUi, UI_EXTENSION, UI_MIME } from '../../../memory/supabase/functions/memory/ui/apps.ts'
import { CARDS, cardHtml } from '../../../memory/supabase/functions/memory/ui/cards.ts'
import { CARD_CSS } from '../../../memory/supabase/functions/memory/ui/style.ts'
import { COMPONENTS_CSS, LOGO_LOCKUP, TOKENS_CSS } from '../../../memory/supabase/functions/memory/ui/design.ts'
import { LOGO_LOCKUP as BRAND_LOCKUP } from '../../../memory/design/brand.js'
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
})

test('R67 cards are small and self-contained', () => {
  assert.equal(Object.keys(CARDS).length, 6)
  for (const card of Object.keys(CARDS)) {
    const html = cardHtml(card)
    assert.ok(Buffer.byteLength(html) <= 60_000, `${card} is ${Buffer.byteLength(html)} bytes`)
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
  assert.ok(Buffer.byteLength(LOGO_LOCKUP) <= 4_500, `LOGO_LOCKUP is ${Buffer.byteLength(LOGO_LOCKUP)} bytes`)
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

test('R67 cards render and escape everything from memory', { skip: NO_CHROME }, () => {
  const report = run(frames('light', 640))
  const ids = Object.keys(FIXTURES)
  assert.equal(ids.length, 7)
  for (const id of ids) {
    const f = report.frames[id]
    assert.equal(f.ready, cardFor(id), `${id} drew`)
    assert.equal(f.injected, 0, `${id} made no element from data`)
    assert.ok(f.text.includes('<b class="injected">'), `${id} shows the markup as text`)
  }
  assert.match(report.frames.remembered.text, /\bSaved\b/i, 'remembered card stamps Saved')
  assert.equal(report.xss, 0)
})

test('R67 card buttons call the tools', { skip: NO_CHROME }, () => {
  const report = run(frames('light', 640, {
    recall: ['article[data-id="e-1"] button.c-used', 'div.c-foot button.cl-btn--primary', 'article[data-id="e-1"] button.c-open'],
    quests: ['article[data-quest="12"] button.c-claim'],
  }))
  const calls = report.calls.map((c: any) => ({ name: c.name, arguments: c.arguments }))
  assert.deepEqual(calls, [
    { name: 'feedback', arguments: { retrieval_id: RID, entries: [{ entry_id: 'e-1', verdict: 'used' }] } },
    { name: 'get_entry', arguments: { id: 'e-1' } },
    { name: 'claim_quest', arguments: { id: 12 } },
  ])
})

test('R67 cards follow the host theme and fit chat width', { skip: NO_CHROME }, () => {
  let checked = 0
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [640, 360]) {
      const report = run(frames(theme, width))
      for (const [id, f] of Object.entries<any>(report.frames)) {
        assert.equal(f.theme, theme, `${id} ${theme} ${width}`)
        assert.equal(f.background, theme === 'light' ? 'rgb(255, 255, 255)' : 'rgb(27, 28, 26)', `${id} ${theme}`)
        assert.equal(f.overflow, false, `${id} at ${width} px scrolls sideways`)
        checked++
      }
    }
  }
  assert.equal(checked, 28)
})
