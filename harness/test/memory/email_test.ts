/**
 * R76 (#81): Clyde's Supabase Auth sign-in email templates (magic_link.html and confirmation.html), subjects in
 * config.toml, host-locked verification URLs, and Gmail's 102 KB clip budget.
 */
import assert from 'node:assert/strict'

const TEMPLATES = [
  { file: 'magic_link.html', type: 'magiclink', subject: 'Your Clyde sign-in link' },
  { file: 'confirmation.html', type: 'signup', subject: 'Confirm your email for Clyde' },
] as const

const TEMPLATE_DIR = new URL('../../../memory/supabase/templates/', import.meta.url)
const CONFIG_PATH = new URL('../../../memory/supabase/config.toml', import.meta.url)
const MEMORY_DIR = new URL('../../../memory/', import.meta.url)
const PUBLIC_DIR = new URL('../../../memory/proxy/public', import.meta.url)

const readTemplate = (name: string) => Deno.readTextFileSync(new URL(name, TEMPLATE_DIR))

function visibleProse(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/&(?:[a-z]+|#\d+|#x[0-9a-f]+);/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseTomlStrings(src: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = ''
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/#(?=(?:[^"]*"[^"]*")*[^"]*$).*$/, '').trim()
    if (!line) continue
    const sec = /^\[([^\]]+)\]$/.exec(line)
    if (sec) {
      current = sec[1].trim()
      sections[current] ??= {}
      continue
    }
    const kv = /^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"$/.exec(line)
    if (kv && current) sections[current][kv[1]] = kv[2]
  }
  return sections
}

Deno.test('auth emails say Clyde, never memory', () => {
  for (const { file } of TEMPLATES) {
    const prose = visibleProse(readTemplate(file))
    assert.equal((prose.match(/\bmemory\b/gi) ?? []).length, 0, `${file}: prose calls the product memory`)
    assert.ok((prose.match(/Clyde/g) ?? []).length >= 2, `${file}: prose mentions Clyde fewer than 2 times`)
    assert.ok(!/[\u2014\u2013;]/.test(prose), `${file}: prose carries em/en dash or semicolon`)
  }
})

Deno.test('config points at both templates', () => {
  const cfg = parseTomlStrings(Deno.readTextFileSync(CONFIG_PATH))
  for (const { file, subject } of TEMPLATES) {
    const key = `auth.email.template.${file.replace('.html', '')}`
    const sec = cfg[key]
    assert.ok(sec, `config.toml missing [${key}]`)
    assert.equal(sec.subject, subject, `${key}.subject`)
    assert.ok(sec.content_path, `${key}.content_path missing`)
    const target = new URL(sec.content_path.replace(/^\.\//, ''), MEMORY_DIR)
    assert.ok(Deno.statSync(target).isFile, `${key} target does not exist: ${sec.content_path}`)
    assert.equal(Deno.readTextFileSync(target), readTemplate(file))
  }
})

Deno.test("one link, twice, on Clyde's host", () => {
  const allowedStatic = new Set(['https://heyclyde.me', 'mailto:support@heyclyde.me'])
  for (const { file, type } of TEMPLATES) {
    const html = readTemplate(file)
    const hrefs = [...html.matchAll(/\shref="([^"]+)"/g)].map((m) => m[1])
    const signIn = hrefs.filter((h) => !allowedStatic.has(h))
    assert.equal(signIn.length, 2, `${file}: expected exactly 2 sign-in hrefs, got ${signIn.join(', ')}`)
    for (const u of signIn) {
      assert.ok(u.startsWith('https://memory.heyclyde.me/auth/v1/verify?'), `${file}: unexpected sign-in href ${u}`)
      assert.ok(u.includes(`type=${type}`), `${file}: missing type=${type} in ${u}`)
      assert.ok(u.includes('token={{ .TokenHash }}'), `${file}: missing {{ .TokenHash }} in ${u}`)
      assert.ok(u.includes('redirect_to='), `${file}: missing redirect_to in ${u}`)
    }
    assert.ok(!html.includes('.ConfirmationURL'), `${file}: still uses {{ .ConfirmationURL }}`)
    assert.ok(html.includes('{{ .Email }}'), `${file}: missing {{ .Email }}`)
  }
})

Deno.test('no scripts, no outside hosts', () => {
  const allowedHosts = new Set(['heyclyde.me', 'memory.heyclyde.me'])
  for (const { file } of TEMPLATES) {
    const html = readTemplate(file)
    assert.equal((html.match(/<script\b/gi) ?? []).length, 0, `${file}: contains <script>`)
    assert.equal((html.match(/<form\b/gi) ?? []).length, 0, `${file}: contains <form>`)
    assert.equal((html.match(/<iframe\b/gi) ?? []).length, 0, `${file}: contains <iframe>`)
    for (const m of html.matchAll(/https?:\/\/([^/\s"'<>?#]+)/gi)) {
      assert.ok(allowedHosts.has(m[1]), `${file}: disallowed external host ${m[1]}`)
    }
    for (const m of html.matchAll(/https:\/\/heyclyde\.me(\/brand\/email\/[^"'\s<>]+)/g)) {
      const asset = new URL(`../../../memory/proxy/public${m[1]}`, import.meta.url)
      assert.ok(Deno.statSync(asset).isFile, `${file}: missing asset ${m[1]} in memory/proxy/public`)
    }
  }
})

Deno.test("under Gmail's clip", () => {
  for (const { file } of TEMPLATES) {
    const bytes = new TextEncoder().encode(readTemplate(file)).length
    assert.ok(bytes < 102_400, `${file}: ${bytes} bytes exceeds 102,400 clip limit`)
  }
})
