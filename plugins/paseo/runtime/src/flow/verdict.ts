/** The judge's Verdict and the worker's result: the schema the backends enforce, and parsers that refuse anything else. */
import { lastJsonBlock } from '../backends/spawn.ts'
import { family } from '../roles.ts'
import type { Rung } from '../types.ts'
import type { Check, Verdict, WorkerResult } from './types.ts'

// Strict enough for codex --output-schema, which wants every property required and no extras.
export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterion: { type: 'string' }, pass: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['criterion', 'pass', 'evidence'],
        additionalProperties: false,
      },
    },
    notes: { type: 'string' },
  },
  required: ['verdict', 'criteria', 'notes'],
  additionalProperties: false,
}

export function parseVerdict(value: unknown): Verdict | null {
  const v = value as Verdict
  if (!v || typeof v !== 'object' || (v.verdict !== 'pass' && v.verdict !== 'fail')) return null
  if (!Array.isArray(v.criteria) || typeof v.notes !== 'string') return null
  const ok = v.criteria.every((c) => c && typeof c.criterion === 'string' && typeof c.pass === 'boolean' && typeof c.evidence === 'string')
  return ok ? { verdict: v.verdict, criteria: v.criteria.map(({ criterion, pass, evidence }) => ({ criterion, pass, evidence })), notes: v.notes } : null
}

export function parseResult(value: unknown): WorkerResult | null {
  const r = value as WorkerResult
  if (!r || typeof r !== 'object' || (r.status !== 'done' && r.status !== 'blocked') || typeof r.summary !== 'string') return null
  const evidence = Array.isArray(r.evidence) ? r.evidence : []
  if (!evidence.every((e) => e && typeof e.criterion === 'string' && typeof e.evidence === 'string')) return null
  return { status: r.status, summary: r.summary, evidence: evidence.map(({ criterion, evidence }) => ({ criterion, evidence })) }
}

/** clyde result wins. The fenced json block at the end of the last message is the fallback. */
export function workerResult(posted: unknown, text: string): WorkerResult | null {
  return parseResult(posted) ?? parseResult(lastJsonBlock(text))
}

/** Every fenced json block in text that parses, last first. */
export function jsonBlocks(text: string): unknown[] {
  const out: unknown[] = []
  for (const m of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    try {
      out.push(JSON.parse(m[1]))
    } catch {
      // A block that doesn't parse is skipped.
    }
  }
  return out.reverse()
}

/** Pass needs the judge's pass, every criterion it graded true, a grade for each gate item, and every check at exit 0. */
export function passes(v: Verdict, criteria: string[], checks: Check[]): boolean {
  return v.verdict === 'pass' && v.criteria.length >= criteria.length && v.criteria.every((c) => c.pass) && checks.every((c) => c.code === 0)
}

/** The first judge rung from another model family than the worker's. When none differs, the first, and the caller logs it. */
export function pickJudge(judges: Rung[], worker: Rung): { rung: Rung; differs: boolean } {
  const other = judges.find((j) => family(j) !== family(worker))
  return other ? { rung: other, differs: true } : { rung: judges[0], differs: false }
}

/** What the next rung hears about a failed attempt: the judge's notes, the criteria it failed, and failed checks. */
export function failureNotes(v: Verdict | null, checks: Check[], reason: string): string {
  const lines: string[] = [reason]
  for (const c of v?.criteria ?? []) if (!c.pass) lines.push(`- Failed: ${c.criterion}${c.evidence ? `\n  The judge saw: ${c.evidence}` : ''}`)
  if (v?.notes) lines.push(`The judge's notes: ${v.notes}`)
  for (const c of checks) if (c.code !== 0) lines.push(`- Check \`${c.cmd}\` exited ${c.code}:\n${tail(c.output, 1500)}`)
  return lines.join('\n')
}

export function tail(text: string, max: number): string {
  return text.length > max ? `...${text.slice(-max)}` : text
}
