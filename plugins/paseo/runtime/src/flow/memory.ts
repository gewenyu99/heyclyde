/** What a run writes to memory with the runtime token: its project, plans, verdicts and the user's answers. */
import { firstLine } from './prompts.ts'
import type { AskRecord, Check, Run, StageRecord, Verdict } from './types.ts'

const LIMITS = { title: 300, body: 4000, evidence: 20000 }

export function projectId(runId: string): string {
  return `run-${runId}`
}

export function scopeOf(runId: string): string {
  return `run:${runId}`
}

/** One source per run, the same every time, so memory files every entry of the run under it. */
export function sourceOf(run: { id: string }): object {
  return { kind: 'run', title: `clyde run ${run.id}`, uri: `clyde://runs/${run.id}` }
}

/** Cuts text to max characters without splitting a surrogate pair or keeping a NUL, since memory refuses both. */
export function clip(text: string, max: number): string {
  let s = text.replace(/\0/g, '').trim()
  if (s.length <= max) return s
  s = s.slice(0, max - 3)
  if (/[\ud800-\udbff]$/.test(s)) s = s.slice(0, -1)
  return `${s}...`
}

/** Fills what every runtime write shares. Built from the run alone, so a resend after a restart lands on the same entry. */
export function entry(run: Run, fields: Record<string, unknown>): Record<string, unknown> {
  const e: Record<string, unknown> = {
    authority: 'observed', scope: scopeOf(run.id), project: run.project ?? projectId(run.id), source: sourceOf(run), ...fields,
  }
  for (const [k, max] of Object.entries(LIMITS)) if (typeof e[k] === 'string') e[k] = clip(e[k] as string, max)
  return e
}

export function projectEntry(run: Run): Record<string, unknown> {
  const input = JSON.stringify(run.input, null, 2)
  return entry(run, {
    id: projectId(run.id), pattern: 'projects', project: undefined, title: `Run ${run.id}: ${run.title}`,
    body: `clyde ${run.flow} run ${run.id} on branch ${run.branch}, cut from ${run.repo} at ${run.base.slice(0, 12)}. Its stages hand off through this scope.`,
    evidence_kind: 'summary', evidence: `The run's input:\n${input}`,
    blobs: input.length > LIMITS.evidence ? [{ name: 'input.json', media_type: 'application/json', text: input }] : undefined,
  })
}

export function verdictEntry(run: Run, stage: StageRecord, verdict: Verdict, diff: string, checks: Check[]): Record<string, unknown> {
  const lines = verdict.criteria.map((c) => `- ${c.pass ? 'Pass' : 'Fail'}: ${c.criterion}`)
  for (const c of checks) lines.push(`- Check \`${c.cmd}\` exited ${c.code}.`)
  const blobs = [{ name: 'verdict.json', media_type: 'application/json', text: JSON.stringify(verdict, null, 2) }]
  if (diff) blobs.push({ name: 'diff.patch', media_type: 'text/x-diff', text: diff })
  if (checks.length) blobs.push({ name: 'checks.txt', media_type: 'text/plain', text: checks.map((c) => `$ ${c.cmd}\nexit ${c.code}\n${c.output}`).join('\n\n') })
  return entry(run, {
    pattern: 'observations', title: `Verdict: stage ${stage.name} passed on attempt ${stage.attempts.length}`,
    body: `The judge passed stage ${stage.name} of run ${run.id}.\n${lines.join('\n')}${verdict.notes ? `\n\n${verdict.notes}` : ''}`,
    evidence_kind: 'assistant', evidence: verdict.criteria.map((c) => `${c.criterion}\n${c.evidence}`).join('\n\n') || verdict.notes || 'The judge passed it.',
    blobs,
  })
}

export function planEntry(run: Run, plan: Plan, supersedes?: string): Record<string, unknown> {
  const slices = plan.slices.map((s) => `- ${s.id}: ${s.title}`).join('\n')
  return entry(run, {
    pattern: 'decisions', authority: 'approved', title: `Plan: ${firstLine(plan.intent)}`,
    body: `The plan for run ${run.id}. ${plan.intent}\n\nSlices:\n${slices}`,
    evidence_kind: 'assistant', evidence: `The planner's slices and their acceptance checks:\n${JSON.stringify(plan.slices, null, 2)}`,
    blobs: [{ name: 'plan.json', media_type: 'application/json', text: JSON.stringify(plan, null, 2) }],
    supersedes: supersedes ? [supersedes] : undefined,
  })
}

export function answerEntry(run: Run, ask: AskRecord): Record<string, unknown> {
  const answer = ask.answer ?? ''
  return entry(run, {
    pattern: 'decisions', authority: 'approved', title: `Answer: ${firstLine(ask.question)}`,
    body: `Asked in run ${run.id}: ${ask.question}\n\nAnswer: ${answer}`,
    evidence_kind: 'quote', evidence: answer,
    blobs: ask.question.length + answer.length > LIMITS.body ? [{ name: 'ask.json', media_type: 'application/json', text: JSON.stringify(ask, null, 2) }] : undefined,
  })
}

/**
 * A worker's work list as a draft in its run, written by the daemon at the end of a turn. It's the worker's own claim, so
 * it stays a draft and the judge never gets it.
 */
export function workListEntry(runId: string, stage: string, threadId: string, list: object, text: string, supersedes?: string): Record<string, unknown> {
  return {
    pattern: 'observations', authority: 'draft', scope: scopeOf(runId), project: projectId(runId),
    source: sourceOf({ id: runId }),
    title: `Work list, ${stage}`,
    body: clip(`The work list of thread ${threadId} for stage ${stage} of run ${runId}, as the worker left it.\n\n${text}`, LIMITS.body),
    evidence_kind: 'assistant', evidence: clip(text, LIMITS.evidence),
    blobs: [{ name: 'work-list.json', media_type: 'application/json', text: JSON.stringify(list, null, 2) }],
    supersedes: supersedes ? [supersedes] : undefined,
  }
}

/** A refused payload is a bug in the runtime. Anything else, like a dead server or a bad token, is memory being unreachable. */
export function refused(err: unknown): boolean {
  return /^memory refused the entry \((400|413)\)/.test((err as Error)?.message ?? '')
}

export type Slice = { id: string; title: string; acceptance: string[] }
export type Plan = { intent: string; slices: Slice[] }

/** A plan is {intent, slices: [{id, title, acceptance: [cmd]}]}, with at least one slice and unique ids. */
export function parsePlan(value: unknown): Plan | null {
  const p = ((value as any)?.slices ? value : (value as any)?.plan) as Plan
  if (!p || typeof p.intent !== 'string' || !p.intent.trim() || !Array.isArray(p.slices) || !p.slices.length) return null
  const slices: Slice[] = []
  for (const s of p.slices) {
    const id = typeof s?.id === 'string' || typeof s?.id === 'number' ? String(s.id).trim() : ''
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(id) || typeof s.title !== 'string' || !s.title.trim()) return null
    const acceptance = Array.isArray(s.acceptance) ? s.acceptance : []
    if (!acceptance.every((c) => typeof c === 'string' && c.trim())) return null
    if (slices.some((x) => x.id === id)) return null
    slices.push({ id, title: s.title.trim(), acceptance })
  }
  return { intent: p.intent.trim(), slices }
}
