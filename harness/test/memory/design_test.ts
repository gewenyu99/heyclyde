/**
 * R68: Clyde's design system. memory/design/tokens.css is the one source of colors for every Clyde surface. These checks
 * hold its text colors to WCAG contrast in both themes, keep the two dark blocks identical, keep the generated
 * memory/design/css.js in step with the CSS files, and check the Worker's pages carry the tokens.
 */
import assert from 'node:assert/strict'
import { LOGO_LOCKUP, LOGO_MARK } from '../../../memory/design/brand.js'
import { COMPONENTS_CSS, FONTS_CSS, TOKENS_CSS } from '../../../memory/design/css.js'
import { homePage, statePage } from '../../../memory/proxy/pages.js'

const read = (p: string) => Deno.readTextFileSync(new URL(`../../../memory/design/${p}`, import.meta.url))
const tokensCss = read('tokens.css')
const componentsCss = read('components.css')

type Theme = Record<string, string>
function block(re: RegExp): Theme {
  const m = re.exec(tokensCss)
  assert.ok(m, `no block for ${re}`)
  return Object.fromEntries([...m[1].matchAll(/--cl-([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/g)].map((x) => [x[1], x[2]]))
}
const light = block(/^:root \{([\s\S]*?)\n\}/m)
const darkMedia = block(/:root:not\(\[data-theme="light"\]\) \{([\s\S]*?)\n {2}\}/)
const darkAttr = block(/:root\[data-theme="dark"\] \{([\s\S]*?)\n\}/)
const dark = { ...light, ...darkAttr }

function luminance(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

const PENS = Object.keys(light).filter((k) => k.startsWith('pen-'))
const GROUNDS = ['paper-0', 'paper-1', 'paper-2', 'sticky']
/** [foreground, ground, minimum]. 4.5 for text, 3 for control edges, focus and marks. */
const PAIRS: [string, string, number][] = [
  ...['ink', 'ink-2', 'ink-3'].flatMap((t) => GROUNDS.map((g): [string, string, number] => [t, g, 4.5])),
  ['carbon', 'paper-0', 4.5], ['carbon', 'paper-1', 4.5], ['carbon', 'sticky', 4.5], ['carbon-ink', 'carbon-wash', 4.5],
  ...['ok', 'warn', 'bad'].flatMap((s): [string, string, number][] => [[s, `${s}-wash`, 4.5], [s, 'paper-1', 4.5], [s, 'paper-0', 4.5], [s, 'sticky', 4.5]]),
  ...PENS.flatMap((p): [string, string, number][] => GROUNDS.map((g): [string, string, number] => [p, g, 4.5])),
  ['on-ink', 'ink', 4.5], ['on-carbon', 'carbon', 4.5], ['on-mark', 'mark', 4.5],
  ['edge', 'paper-1', 3], ['edge', 'paper-0', 3], ['edge', 'sticky', 3], ['carbon', 'paper-2', 3],
]

Deno.test('every text color in tokens.css holds WCAG contrast on its grounds, light and dark', () => {
  assert.equal(PENS.length, 7, 'seven pens')
  const failing: string[] = []
  for (const [name, theme] of [['light', light], ['dark', dark]] as const) {
    for (const [fg, bg, min] of PAIRS) {
      assert.ok(theme[fg] && theme[bg], `${name}: missing --cl-${fg} or --cl-${bg}`)
      const r = contrast(theme[fg], theme[bg])
      if (r < min) failing.push(`${name} ${fg} on ${bg} = ${r.toFixed(2)} < ${min}`)
    }
  }
  assert.deepEqual(failing, [])
})

Deno.test('the dark theme is the same whether the system or data-theme asks for it', () => {
  assert.deepEqual(darkMedia, darkAttr)
  for (const k of Object.keys(darkAttr)) assert.ok(k in light, `--cl-${k} has no light value`)
})

Deno.test('css.js is generated from the CSS files (node memory/design/build.mjs)', () => {
  assert.equal(TOKENS_CSS, tokensCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>])\s*/g, '$1').trim())
  assert.equal(FONTS_CSS, read('fonts.css').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>])\s*/g, '$1').trim())
  assert.equal(COMPONENTS_CSS, componentsCss.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{}:;,>])\s*/g, '$1').trim())
  for (const v of componentsCss.matchAll(/var\(--cl-([a-z0-9-]+)/g)) {
    const defined = tokensCss.includes(`--cl-${v[1]}:`) || componentsCss.includes(`--cl-${v[1]}:`)
    assert.ok(defined, `components.css uses --cl-${v[1]}, which neither tokens.css nor components.css defines`)
  }
  assert.ok(!/#[0-9a-f]{3,8}\b/i.test(componentsCss.replace(/\/\*[\s\S]*?\*\//g, '')), 'components.css has no literal colors')
})

Deno.test('every Worker page carries the tokens and the components', () => {
  const pages = [homePage('n0nce'), ...['ask_email', 'check_email', 'waiting', 'connected', 'refused', 'expired', 'blocked', 'subscribed', 'error']
    .map((state) => statePage({ state }, 'n0nce', 'abc12345'))]
  for (const html of pages) {
    assert.ok(html.includes(TOKENS_CSS), 'tokens inlined')
    assert.ok(html.includes(COMPONENTS_CSS), 'components inlined')
    assert.ok(html.includes('/_clyde/brand/clyde-lockup-light.svg') && html.includes('/_clyde/brand/clyde-lockup-dark.svg'), 'the clyde logo, both themes')
    assert.ok(html.includes(FONTS_CSS), 'the self-hosted fonts')
    for (const m of html.matchAll(/["(](\/_clyde\/[^")\s]+)/g)) {
      const file = new URL(`../../../memory/proxy/public${m[1]}`, import.meta.url)
      assert.ok(Deno.statSync(file).isFile, `${m[1]} is served from memory/proxy/public`)
    }
    assert.ok(!/\sstyle="/.test(html), 'no style attributes: the CSP allows only the nonce\'d <style>')
  }
})

Deno.test('built design artifacts carry the logo, the live MCP URL, and current typeface docs', () => {
  for (const f of ['src/directions.html', 'directions.html']) {
    const html = read(f)
    assert.equal((html.match(/class="cl-mark"/g) ?? []).length, 0, `${f} has no removed .cl-mark span`)
  }
  assert.ok(read('directions.html').includes('class="cl-logo"'), 'directions.html inlines brand.js logo')
  for (const f of ['src/clyde-prototype.html', 'clyde-prototype.html']) {
    const html = read(f)
    assert.equal((html.match(/https:\/\/heyclyde\.me\/mcp/g) ?? []).length, 0, `${f} has no root-host /mcp URL`)
    assert.ok(html.includes('https://memory.heyclyde.me/mcp'), `${f} uses https://memory.heyclyde.me/mcp`)
  }
  const principles = read('PRINCIPLES.md')
  assert.equal((principles.match(/system faces only/gi) ?? []).length, 0, 'PRINCIPLES.md reflects self-hosted web fonts')
  assert.ok(principles.includes('Bricolage Grotesque') && principles.includes('fonts.css'), 'PRINCIPLES.md names the web faces and fonts.css')
})

Deno.test('sticky-note tokens, doodle components, and Sticky-Note Forehead Clyde assets are shipped in sync', () => {
  for (const t of ['sticky', 'sticky-edge', 'sticky-strip']) {
    assert.ok(light[t] && darkAttr[t], `tokens.css defines --cl-${t} in light and dark`)
  }
  assert.ok(tokensCss.includes('--cl-sticky-shadow:'), 'tokens.css defines --cl-sticky-shadow')
  for (const cls of ['.cl-sticky', '.cl-sticky--tilt', '.cl-sticky--blue', '.cl-scribble', '.cl-mascot']) {
    assert.ok(componentsCss.includes(cls), `components.css defines ${cls}`)
  }
  assert.ok(LOGO_LOCKUP.includes('class="c"') && LOGO_LOCKUP.includes('class="i"'), 'LOGO_LOCKUP uses ink and carbon token classes')
  assert.ok(LOGO_MARK.includes('class="c"') && LOGO_MARK.includes('class="i"'), 'LOGO_MARK uses ink and carbon token classes')
  for (const file of ['clyde-mascot-light.svg', 'clyde-mascot-dark.svg', 'clyde-lockup-light.svg', 'clyde-lockup-dark.svg']) {
    const a = Deno.readTextFileSync(new URL(`../../../memory/design/brand/${file}`, import.meta.url))
    const b = Deno.readTextFileSync(new URL(`../../../memory/proxy/public/_clyde/brand/${file}`, import.meta.url))
    assert.equal(a, b, `${file} matches between design/brand and proxy/public/_clyde/brand`)
    if (file.startsWith('clyde-mascot-')) assert.ok(a.length >= 2_500, `${file} is a richly traced hand-drawn mascot`)
  }
  const brandMd = read('BRAND.md')
  assert.ok(/sticky note/i.test(brandMd) && /doodle/i.test(brandMd), 'BRAND.md documents sticky-note + doodle system')
  assert.equal((brandMd.match(/guild's clerk|Clyde has no face/gi) ?? []).length, 0, 'retired guild clerk / no-face rules')
  const assetsMd = read('ASSETS.md')
  for (const app of ['Claude', 'Claude Code', 'ChatGPT', 'Codex', 'Gemini', 'Antigravity', 'Grok']) {
    assert.ok(assetsMd.includes(app), `ASSETS.md documents ${app}`)
  }
  for (const rel of [
    'assets/icon-light.svg', 'assets/icon-dark.svg', 'assets/icon-1024.png', 'assets/icon-512.png', 'assets/icon-128.png',
    'assets/og-banner-1200x630.svg', 'assets/og-banner-1200x630.png',
    'assets/doodles/sticky-yellow.svg', 'assets/doodles/sticky-blue.svg', 'assets/doodles/sticky-tilted-pair.svg',
    'assets/doodles/arrow-right.svg', 'assets/doodles/arrow-curve.svg',
    'assets/doodles/scribble-underline.svg', 'assets/doodles/scribble-circle.svg',
    'assets/doodles/tape-strip.svg', 'assets/doodles/pushpin.svg', 'assets/doodles/app-handoff.svg',
  ]) {
    const st = Deno.statSync(new URL(`../../../memory/design/${rel}`, import.meta.url))
    assert.ok(st.isFile && st.size > 100, `shared asset ${rel} exists and is non-empty`)
  }
  for (const scene of ['relay', 'questboard', 'nosecrets', 'goldfish', 'standing']) {
    const jpg = Deno.statSync(new URL(`../../../memory/design/assets/scenes/${scene}.jpg`, import.meta.url))
    assert.ok(jpg.isFile && jpg.size > 10_000, `scene source ${scene}.jpg exists`)
    for (const theme of ['light', 'dark']) {
      const a = Deno.readTextFileSync(new URL(`../../../memory/design/assets/scenes/${scene}-${theme}.svg`, import.meta.url))
      const b = Deno.readTextFileSync(new URL(`../../../memory/proxy/public/_clyde/scenes/${scene}-${theme}.svg`, import.meta.url))
      assert.equal(a, b, `scene ${scene}-${theme}.svg matches between design/assets/scenes and proxy/public/_clyde/scenes`)
      assert.ok(a.length >= 2_500 && a.includes('<svg'), `scene ${scene}-${theme}.svg is a traced SVG`)
    }
  }
})
