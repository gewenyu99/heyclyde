/**
 * R53 (#58): the Claude Code plugin from R45 carries the recall-first and feedback guidance in a skill, since the server's
 * own instructions stay neutral for the stores' reviews.
 */
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INSTRUCTIONS } from '../../../memory/supabase/functions/memory/mcp.ts'

const SKILLS = join(import.meta.dirname!, '../../../plugins/memory/skills')

Deno.test('R53 recall-first lives in the plugin', () => {
  const skills = existsSync(SKILLS) ? readdirSync(SKILLS).map((d) => join(SKILLS, d, 'SKILL.md')).filter(existsSync) : []
  const guiding = skills.filter((f) => { const s = readFileSync(f, 'utf8'); return s.includes('recall') && s.includes('feedback') })
  assert.equal(guiding.length, 1, `skills that guide recall and feedback: ${guiding.join(', ')}`)
  assert.ok(!/\bbefore\b/i.test(INSTRUCTIONS), 'the instructions say before')
  assert.ok(!/\balways\b/i.test(INSTRUCTIONS), 'the instructions say always')
})
