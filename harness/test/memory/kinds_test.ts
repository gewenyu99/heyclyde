/**
 * Tier 3's unit tests of claim kinds (R27, R15), run with `deno test`: the quote check, each kind's starting strength, and
 * the labels a packet and get_entry carry. No database.
 */
import assert from 'node:assert/strict'
import { eventTexts, quoteIn } from '../../../memory/supabase/functions/memory/evidence.ts'
import { renderEntry, renderItem } from '../../../memory/supabase/functions/memory/search.ts'
import { START } from '../../../memory/supabase/functions/memory/write.ts'

const DIG = 'memory.heyclyde.me. 300 IN A 104.21.32.1'

// R27 (#20): the quote check squashes case and whitespace, and a match must start and end on a token boundary.
Deno.test('a quote verifies across lines, case and quote marks', () => {
  assert.ok(quoteIn('Address: 104.21.32.1\nName: memory.heyclyde.me', 'Address: 104.21.32.1 Name: memory.heyclyde.me'))
  assert.ok(quoteIn('say "ok" now please', 'say "ok" now'))
  assert.ok(quoteIn(`${DIG}\n`, DIG.toUpperCase()))
})

Deno.test('a quote must start and end on a token boundary', () => {
  assert.ok(!quoteIn('memory.heyclyde.me. 300 IN A 104.21.32.123', DIG), 'a longer address is not the same address')
  assert.ok(!quoteIn(DIG, 'emory.heyclyde.me. 300 IN A 104.21.32.1'), 'a quote cannot start inside a word')
  assert.ok(!quoteIn('host-memory.heyclyde.me. 300 IN A 104.21.32.1', DIG), 'a hyphen joins words')
  assert.ok(!quoteIn(`result: ${DIG}.5`, DIG), 'a dot can continue an address')
  assert.ok(quoteIn(`result: (${DIG}), done`, DIG), 'brackets and commas are boundaries')
  assert.ok(quoteIn(`x ${DIG} y ${DIG}.99`, DIG), 'one good match is enough')
})

Deno.test('a quote under 8 characters never verifies', () => {
  assert.ok(!quoteIn('ok ok ok', 'ok'))
  assert.ok(!quoteIn('abcdefg', 'abcdefg'))
  assert.ok(quoteIn('abcdefgh', 'abcdefgh'))
})

Deno.test('the text of an event is its tool output or its prompt, and never what the agent sent', () => {
  const bash = { tool_name: 'Bash', tool_input: { command: `echo ${DIG}` }, tool_response: { stdout: 'out\n', stderr: 'err', interrupted: false } }
  assert.deepEqual(eventTexts('PostToolUse', bash).sort(), ['err', 'out\n'])
  const mcp = { tool_response: { content: [{ type: 'text', text: 'version = 2.4.1 released' }] } }
  assert.deepEqual(eventTexts('PostToolUse', mcp), ['version = 2.4.1 released'])
  assert.deepEqual(eventTexts('PostToolUse', { tool_response: 'Cloudflare Registrar: heyclyde.me registered' }),
    ['Cloudflare Registrar: heyclyde.me registered'])
  assert.deepEqual(eventTexts('UserPromptSubmit', { prompt: 'deploys go through deploy.sh', tool_response: 'no' }), ['deploys go through deploy.sh'])
  assert.deepEqual(eventTexts('SessionStart', { prompt: 'no', tool_response: 'no' }), [])
})

// R27: starting strength is MODEL-PLAN's table.
Deno.test('each kind starts at its strength and chances', () => {
  assert.deepEqual(START.fact, { confidence: 0.9, chances: 0 })
  assert.deepEqual(START.wen, { confidence: 0.7, chances: 3 })
  assert.deepEqual(START.observation, { confidence: 0.5, chances: 3 })
  assert.deepEqual(START.plan, { confidence: 0.5, chances: 3 })
})

const row = (fields: Record<string, unknown>) => ({
  id: 'e1', title: 'T', body: 'B', pattern: 'observations', authority: 'approved', scope: 'domain:tea', valid_from: '2026-11-03',
  kind: 'wen', confidence: 0.7, verified: null, evidence: '', evidence_kind: 'summary', sensitivity: 'normal', project: 'p', ...fields,
})

// R27 and R15: a packet item shows its kind and confidence, and a draft is marked unreviewed.
Deno.test('a packet item shows kind and confidence, unverified when the check failed, and unreviewed on a draft only', () => {
  const lines = (r: Record<string, unknown>) => renderItem(1, row(r)).split('\n')
  assert.equal(lines({})[1], '    wen · confidence 0.70 · approved · domain:tea · 2026-11-03')
  assert.equal(lines({ kind: 'fact', confidence: 0.9, verified: true })[1], '    fact · confidence 0.90 · approved · domain:tea · 2026-11-03')
  assert.equal(lines({ kind: 'observation', confidence: 0.5, verified: false, authority: 'draft' })[1],
    '    observation · unverified · confidence 0.50 · draft · unreviewed · domain:tea · 2026-11-03')
  assert.ok(!lines({ authority: 'observed' })[1].includes('unreviewed'))
})

Deno.test('get_entry shows kind and confidence on its own line, after the pattern line', () => {
  const text = renderEntry(row({ kind: 'plan', confidence: 0.5, authority: 'draft' }), []).split('\n')
  assert.equal(text[1], 'pattern observations · draft · domain:tea · valid from 2026-11-03 · project p')
  assert.equal(text[2], 'kind plan · confidence 0.50')
  assert.equal(renderEntry(row({ verified: false }), []).split('\n')[2], 'kind wen · confidence 0.70 · unverified')
})
