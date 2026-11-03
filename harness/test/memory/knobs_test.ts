/**
 * Tier 3's unit test of the ranking code's source, run with `deno test`. Every ranking knob lives in a parameter set
 * (R32), so search.ts and service.ts hold no knob: not as a named constant, not as a bare number. No database.
 */
import assert from 'node:assert/strict'

const DIR = new URL('../../../memory/supabase/functions/memory/', import.meta.url)

/**
 * The source with comments blanked, string and regex literals emptied and template text dropped, so what is left is
 * code. An expression inside a template's `${}` stays, since a knob can hide in one.
 */
export function codeOf(src: string): string {
  let out = ''
  // 'tpl' for template text, a number for a `${}` expression's open braces.
  const stack: ('tpl' | number)[] = []
  const prev = () => out.trimEnd().at(-1) ?? ''
  for (let i = 0; i < src.length; i++) {
    const c = src[i], top = stack.at(-1)
    if (top === 'tpl') {
      if (c === '\\') i++
      else if (c === '`') stack.pop()
      else if (c === '$' && src[i + 1] === '{') {
        stack.push(0)
        i++
        out += ' '
      }
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && src[i + 1] === '*') {
      i = src.indexOf('*/', i + 2) + 1
      out += ' '
    } else if (c === '"' || c === "'") {
      for (i++; src[i] !== c; i++) if (src[i] === '\\') i++
      out += '""'
    } else if (c === '`') {
      stack.push('tpl')
      out += '""'
    } else if (c === '/' && (/[(,=:[!&|?{};]/.test(prev()) || prev() === '' || /\breturn$/.test(out.trimEnd()))) {
      // A regex literal: up to the next slash that is outside a character class, then its flags.
      let inClass = false
      for (i++; inClass || src[i] !== '/'; i++) {
        if (src[i] === '\\') i++
        else if (src[i] === '[') inClass = true
        else if (src[i] === ']') inClass = false
      }
      while (/[a-z]/.test(src[i + 1] ?? '')) i++
      out += '""'
    } else {
      if (typeof top === 'number') {
        if (c === '{') stack[stack.length - 1] = top + 1
        else if (c === '}') {
          if (top === 0) {
            stack.pop()
            out += ' '
            continue
          }
          stack[stack.length - 1] = top - 1
        }
      }
      out += c
    }
  }
  return out
}

/** Every numeric literal in the code, as a number, so 60_000 and 60000 are one. */
export function numbersIn(code: string): number[] {
  return [...code.matchAll(/(?<![\w.$])\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?(?![\w$])/gi)].map((m) => Number(m[0].replaceAll('_', '')))
}

// The numbers each file may still hold. They are structure, not knobs: array positions, 1 as a neutral weight or an
// offset, halving a range, a character count per token, a cache size and lifetime, a page size, a timestamp's width, and
// the message queue's agent-name length (40) and redelivery minutes (30).
const ALLOWED: Record<string, number[]> = {
  'search.ts': [0, 1, 2, 4, 512, 60000],
  'service.ts': [0, 1, 16, 30, 40, 20000, 100000],
}
// The names of the knobs that used to be constants or config, and the env vars that used to set them.
const KNOBS = [
  /\bFILTER_K\b/, /\bFILTER_THRESHOLD\b/, /\bTILT_BASE\b/, /\bDORMANT\b/, /\bRESTART\b/, /\bITERATIONS\b/, /\bSUPERSEDED_FACTOR\b/,
  /\bconfig\.(candidates|packetItems|packetTokens|rrfK|vecWeight|indexDraftFactor|scopeBoost)\b/,
]

// R32 (#36): a test fails if a knob is hard-coded in search.ts or service.ts.
Deno.test('no ranking knob is hard-coded in search.ts or service.ts', async () => {
  for (const [file, allowed] of Object.entries(ALLOWED)) {
    const code = codeOf(await Deno.readTextFile(new URL(file, DIR)))
    for (const knob of KNOBS) assert.ok(!knob.test(code), `${file} still names ${knob}`)
    const stray = [...new Set(numbersIn(code).filter((n) => !allowed.includes(n)))]
    assert.deepEqual(stray, [], `${file} holds numbers that no parameter set supplies`)
  }
})

// The check above is only worth having if it can fail.
Deno.test('the knob check sees a literal in code, and ignores comments, strings, regexes and SQL text', () => {
  const src = [
    'const RESTART = 0.5; // 12 items',
    '/* 1500 */ const re = /[0-9]{3}/g, s = "limit 50", t = `limit 20 ${x * 0.15} and ${ {a: 1}.a + 8 }`',
    'return a / 4 / 7',
  ].join('\n')
  const code = codeOf(src)
  assert.deepEqual(numbersIn(code), [0.5, 0.15, 1, 8, 4, 7])
  assert.match(code, /\bRESTART\b/)
})
