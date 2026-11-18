/** task: one judged stage from a prompt, criteria and checks the point man writes. The judged background job. */
import { publishDraft } from '../src/flow/publish.ts'
import { auditChange } from '../src/flow/audit.ts'
import { existsSync } from 'node:fs'
import { skillPath } from '../src/flow/gate.ts'
import type { FlowCtx, FlowMeta } from '../src/flow/types.ts'
import { ladder } from '../src/roles.ts'

export type TaskInput = { prompt: string; criteria: string[]; checks?: string[]; role?: string; skill?: string; title?: string; cwd?: string; draftPR?: boolean }

export const meta: FlowMeta = {
  name: 'task',
  description: 'One stage: a worker does the prompt, the checks run, and a judge from another family grades the criteria.',
  input: '{"prompt": "...", "criteria": ["..."], "checks": ["npm test"], "role": "worker", "skill": "code-it-works", "title": "...", "cwd": "/repo"}',
}

export function validate(input: unknown): void {
  if ((input as { draftPR?: unknown })?.draftPR !== undefined && typeof (input as { draftPR?: unknown }).draftPR !== "boolean") throw new Error("draftPR must be boolean")
  const i = input as TaskInput
  if (typeof i?.prompt !== 'string' || !i.prompt.trim()) throw new Error('prompt must be a non-empty string')
  if (!strings(i.criteria) || !i.criteria.length) throw new Error('criteria must be a non-empty list of strings')
  if (i.checks !== undefined && !strings(i.checks)) throw new Error('checks must be a list of shell commands')
  if (i.role !== undefined) ladder(i.role)
  if (i.skill !== undefined && !existsSync(skillPath(i.skill))) throw new Error(`skill ${i.skill} has no SKILL.md`)
}

export async function run(ctx: FlowCtx, input: TaskInput) {
  const stage = await ctx.stage({
    name: 'task', route: input.role ? undefined : 'worker', skill: input.skill, prompt: input.prompt, criteria: input.criteria, checks: input.checks, role: input.role ?? 'worker',
  })
  if (stage.passed && ctx.run.routes) await auditChange(ctx, input.checks ?? [])
  if (stage.passed && ctx.run.auditedHead && input.draftPR === true) await publishDraft(ctx)
  return stage
}

function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string' && s.trim())
}
