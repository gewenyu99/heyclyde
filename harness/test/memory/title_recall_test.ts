/**
 * Unit tests for Quest #11: runtime `projects` visibility in index/deep scans and 2+ word title pattern matching.
 */
import assert from 'node:assert/strict'
import { titlePatterns } from '../../../memory/supabase/functions/memory/search.ts'

const SEARCH_SRC = Deno.readTextFileSync(new URL('../../../memory/supabase/functions/memory/search.ts', import.meta.url))
const DEEP_SRC = Deno.readTextFileSync(new URL('../../../memory/supabase/functions/memory/deep.ts', import.meta.url))

Deno.test('titlePatterns extracts distinct non-stopword ASCII words (splitting hyphens/#) and CJK bigrams', () => {
  assert.deepEqual(titlePatterns('Clyde handoff'), [
    '(^|[^a-z0-9])clyde([^a-z0-9]|$)',
    '(^|[^a-z0-9])handoff([^a-z0-9]|$)',
  ])
  assert.deepEqual(titlePatterns('Sticky-Note Forehead Clyde quest #8 review'), [
    '(^|[^a-z0-9])sticky([^a-z0-9]|$)',
    '(^|[^a-z0-9])note([^a-z0-9]|$)',
    '(^|[^a-z0-9])forehead([^a-z0-9]|$)',
    '(^|[^a-z0-9])clyde([^a-z0-9]|$)',
    '(^|[^a-z0-9])quest([^a-z0-9]|$)',
    '(^|[^a-z0-9])8([^a-z0-9]|$)',
    '(^|[^a-z0-9])review([^a-z0-9]|$)',
  ])
  assert.deepEqual(titlePatterns('what is the'), [])
  assert.equal(titlePatterns('clyde').length, 1)
  assert.deepEqual(titlePatterns('喜欢乌龙茶'), ['喜欢', '欢乌', '乌龙', '龙茶'])
})

Deno.test('indexLines and deep hidden include non-seed non-notes runtime projects entries', () => {
  assert.ok(!/e\.pattern\s*<>\s*'projects'(?!\s+or\b)/.test(SEARCH_SRC), 'search.ts must not blindly exclude all pattern = projects')
  assert.ok(!/e\.pattern\s*<>\s*'projects'/.test(DEEP_SRC), 'deep.ts must not blindly exclude pattern = projects')
  assert.ok(SEARCH_SRC.includes("not like 'notes-%'") && SEARCH_SRC.includes("'seed'"), 'search.ts keeps notes-* and seed containers hidden')
})
