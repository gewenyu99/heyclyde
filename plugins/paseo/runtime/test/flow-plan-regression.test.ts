import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractPlan } from '../flows/ship.ts'
import { PLAN_CRITERIA, PLAN_RESULT_BLOCK, planPrompt, workerPrompt } from '../src/flow/prompts.ts'
import type { Run } from '../src/flow/types.ts'

const plan = { intent: 'Build a small change.', slices: [{ id: 's1', title: 'Make it', acceptance: ['test -f output'] }] }
const run = { id: 'r-test', cwd: '/tmp/repo', branch: 'clyde/r-test' } as Run

test('plan worker gets one fallback JSON shape containing plan, even when clyde result fails', () => {
  const prompt = workerPrompt({ run, spec: { name: 'plan', prompt: planPrompt(plan.intent), criteria: PLAN_CRITERIA, extract: extractPlan, resultTemplate: PLAN_RESULT_BLOCK }, attempt: 1, root: '/repo', bin: '/repo/clyde' })
  assert.match(prompt, /If clyde result fails,[\s\S]*"plan": \{"intent"/)
  assert.equal((prompt.match(/If clyde result fails/g) ?? []).length, 1)
})

test('plan gate tells planner and judge to decompose until cheap rungs can do every leaf with its own check', () => {
  const prompt = planPrompt(plan.intent)
  assert.match(prompt, /cheap rung/i)
  assert.match(prompt, /decompos/i)
  assert.match(prompt, /each (piece|slice).*check/i)
  assert.ok(PLAN_CRITERIA.some((c) => /cheap rung/i.test(c)))
  assert.ok(PLAN_CRITERIA.some((c) => /each (piece|slice).*check/i.test(c)))
})

test('extractPlan reads the runtime worker text containing a plan block', () => {
  assert.deepEqual(extractPlan({ text: `Summary.\n\n\`\`\`json\n${JSON.stringify({ status: 'done', summary: 'planned', evidence: [], plan })}\n\`\`\``, result: { status: 'done', summary: 'planned', evidence: [] } }), plan)
})
