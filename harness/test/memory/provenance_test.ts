/**
 * R41 (#45): the one function that words a note's provenance for a recall packet. No database.
 */
import assert from 'node:assert/strict'
import { PROVENANCE_MAX, provenanceLine, YOU_WROTE_THIS } from '../../../memory/supabase/functions/memory/provenance.ts'

const codex = { device: 'mac-mini', agent: 'codex', agent_context: 'work', repo: 'posthog' }

Deno.test('provenance: the line names the agent, the machine, the repo and the work context', () => {
  assert.equal(provenanceLine(codex, null), 'from codex on mac-mini in repo:posthog (work)')
})

Deno.test('provenance: a note with no repo or no profile leaves those parts out', () => {
  assert.equal(provenanceLine({ device: 'mac-mini', agent: 'claude', agent_context: null, repo: null }, null), 'from claude on mac-mini')
  assert.equal(provenanceLine({ ...codex, repo: null }, null), 'from codex on mac-mini (work)')
  assert.equal(provenanceLine({ ...codex, agent_context: null }, null), 'from codex on mac-mini in repo:posthog')
})

Deno.test("provenance: the reader's own note says so, and only the same agent on the same machine counts as the reader", () => {
  assert.ok(provenanceLine(codex, { device: 'mac-mini', agent: 'codex' }).endsWith(YOU_WROTE_THIS))
  assert.equal(YOU_WROTE_THIS, '(you wrote this)')
  assert.ok(!provenanceLine(codex, { device: 'macbook-air', agent: 'codex' }).includes(YOU_WROTE_THIS), 'same agent name, other machine')
  assert.ok(!provenanceLine(codex, { device: 'mac-mini', agent: 'claude' }).includes(YOU_WROTE_THIS), 'same machine, other agent')
})

Deno.test('provenance: never more than 60 characters, whatever the names, and it keeps the agent and the machine', () => {
  assert.equal(PROVENANCE_MAX, 60)
  const long = { device: 'd'.repeat(80), agent: 'a'.repeat(40), agent_context: 'personal', repo: 'r'.repeat(200) }
  for (const viewer of [null, { device: long.device, agent: long.agent }]) {
    for (const p of [long, { ...long, repo: 'posthog' }, { ...long, device: 'mac-mini' }, { ...long, agent: 'codex' }]) {
      const line = provenanceLine(p, viewer)
      assert.ok(line.length <= 60, `${line.length}: ${line}`)
      assert.ok(line.startsWith('from a') || line.startsWith('from codex'), line)
      assert.match(line, / on [dm]/)
    }
  }
  assert.equal(provenanceLine({ device: 'mac-mini', agent: 'codex', agent_context: 'work', repo: 'x'.repeat(30) }, null),
    'from codex on mac-mini (work)', 'a repo that does not fit is the first thing dropped')
})
