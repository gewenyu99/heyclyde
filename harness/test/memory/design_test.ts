/**
 * R68: Clyde's design system. memory/design/tokens.css is the one source of colors for every Clyde surface. These checks
 * hold its text colors to WCAG contrast in both themes, keep the two dark blocks identical, keep the generated
 * memory/design/css.js in step with the CSS files, and check the Worker's pages carry the tokens.
 */
import assert from 'node:assert/strict'
import { COMPONENTS_CSS, TOKENS_CSS } from '../../../memory/design/css.js'
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
/** [foreground, ground, minimum]. 4.5 for text, 3 for control edges, focus and marks. */
const PAIRS: [string, string, number][] = [
  ...['ink', 'ink-2', 'ink-3'].flatMap((t) => ['paper-0', 'paper-1', 'paper-2'].map((g): [string, string, number] => [t, g, 4.5])),
  ['carbon', 'paper-0', 4.5], ['carbon', 'paper-1', 4.5], ['carbon-ink', 'carbon-wash', 4.5],
  ...['ok', 'warn', 'bad'].flatMap((s): [string, string, number][] => [[s, `${s}-wash`, 4.5], [s, 'paper-1', 4.5], [s, 'paper-0', 4.5]]),
  ...PENS.flatMap((p): [string, string, number][] => [[p, 'paper-0', 4.5], [p, 'paper-1', 4.5], [p, 'paper-2', 4.5]]),
  ['on-ink', 'ink', 4.5], ['on-carbon', 'carbon', 4.5], ['on-mark', 'mark', 4.5],
  ['edge', 'paper-1', 3], ['edge', 'paper-0', 3], ['carbon', 'paper-2', 3],
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
    assert.ok(html.includes('class="cl-mark"'), 'the clyde mark')
  }
})
