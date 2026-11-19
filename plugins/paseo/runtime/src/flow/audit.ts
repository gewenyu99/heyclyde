import { inferRouting } from '../routing.ts'
import { Stopped } from './runtime.ts'
import { committedDiff, headSha } from './shell.ts'
import type { FlowCtx } from './types.ts'

type Finding = { id: string; evidence: string }
type Disposition = Finding & { status: 'confirmed' | 'dismissed' | 'needs a decision' }

const AUDIT_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'evidence'],
        properties: { id: { type: 'string', minLength: 1 }, evidence: { type: 'string', minLength: 1 } },
      },
    },
  },
}

const VERIFY_SCHEMA = {
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'status', 'evidence'],
        properties: {
          id: { type: 'string', minLength: 1 },
          status: { type: 'string', enum: ['confirmed', 'dismissed', 'needs a decision'] },
          evidence: { type: 'string', minLength: 1 },
        },
      },
    },
  },
}

function validFindings(value: unknown): Finding[] | null {
  const rows = (value as { findings?: Finding[] })?.findings
  if (
    !Array.isArray(rows) ||
    rows.some((f) =>
      !f || typeof f.id !== 'string' || !f.id.trim() || typeof f.evidence !== 'string' || !f.evidence.trim()
    ) ||
    new Set(rows.map((f) => f.id)).size !== rows.length
  ) return null
  return rows
}

function findings(value: unknown): Finding[] {
  const rows = validFindings(value)
  if (!rows) throw new Error('Reviewer returned invalid findings')
  return rows
}

function validDispositions(value: unknown, issues: Finding[]): Disposition[] | null {
  const rows = validFindings(value) as Disposition[] | null
  if (
    !rows ||
    rows.length !== issues.length ||
    rows.some((f) =>
      !issues.some((i) => i.id === f.id) || !['confirmed', 'dismissed', 'needs a decision'].includes(f.status)
    )
  ) return null
  return rows
}

async function review(ctx: FlowCtx, head: string, base: string) {
  const diff = await committedDiff(ctx.cwd, base, head)
  const audit = await ctx.agent({
    role: 'reviewer',
    route: 'audit',
    readOnly: true,
    title: 'Audit ' + head,
    schema: AUDIT_SCHEMA,
    validate: (parsed) => validFindings(parsed) !== null,
    prompt: 'Audit this change at ' + head + ' against ' + base +
      '. Inspect affected callers, tests and docs. Return a fenced JSON object with findings: [{id,evidence}]. Cite code locations and concrete impact. An empty array means no actionable findings.\n' +
      diff,
  })
  if (!audit.ok) throw new Error(audit.text || 'Audit unavailable')
  const issues = findings(audit.json)
  if (!issues.length) return []
  const triage = await ctx.agent({
    role: 'reviewer',
    route: 'verify',
    readOnly: true,
    title: 'Verify findings ' + head,
    schema: VERIFY_SCHEMA,
    validate: (parsed) => validDispositions(parsed, issues) !== null,
    prompt: 'Check every finding independently at ' + head +
      '. Return fenced JSON with findings: [{id,status,evidence}]. Use confirmed, dismissed, or needs a decision.\n' +
      JSON.stringify(issues) + '\n' + diff,
  })
  if (!triage.ok) throw new Error(triage.text || 'Finding verification unavailable')
  const rows = validDispositions(triage.json, issues)
  if (!rows) throw new Error('Incomplete finding dispositions')
  return rows.filter((f) => f.status !== 'dismissed')
}

async function cleanHead(ctx: FlowCtx) {
  const status = await ctx.check('git status --porcelain')
  if (status.code || status.output.trim()) throw new Error('Commit outstanding work before final verification')
  return headSha(ctx.cwd)
}

export const MAX_AUDIT_REPAIRS = 3
const MAX_MANUAL_ESCALATIONS = 2

export async function auditChange(ctx: FlowCtx, checks: string[]) {
  const run = ctx.run
  const initialHead = run.auditBaseHead ??= await cleanHead(ctx)
  ctx.persist()
  if (run.base === initialHead && await cleanHead(ctx) === initialHead) return
  // The initial dispositions survive a crash after the writer begins the repair.
  if (!run.auditFindings) {
    if (await cleanHead(ctx) !== initialHead) throw new Error('Implementation changed during the initial audit')
    run.auditFindings = await review(ctx, initialHead, run.base)
    ctx.persist()
  }
  const repairHeads = (run.auditRepairHeads ??= [])
  let head = initialHead
  let issues = run.auditFindings
  for (let round = 1; round <= MAX_AUDIT_REPAIRS && issues.length > 0; round++) {
    const idx = round - 1
    const pending = issues.filter((i) => i.status === 'needs a decision')
    const instruction = pending.length ? await ctx.ask('Resolve these audit findings: ' + JSON.stringify(pending), 'block') : ''
    if (/^\s*stop\b/i.test(instruction)) throw new Stopped('Audit stopped by the user at ' + head)
    if (run.routes?.worker && !run.routes.worker.pinned) {
      const complexity = inferRouting(issues.map((issue) => issue.evidence).join(' ') + ' ' + instruction)
      if (complexity.complexity === 'complex') {
        run.routes.worker = { model: 'opus', reason: 'Complex repair: ' + complexity.reason, pinned: false }
        ctx.persist()
      }
    }
    const prevHead = head
    const recordedHead = repairHeads[idx]
    const stageName = round === 1 ? 'audit-repair' : `audit-repair-${round}`
    const alreadyPassed = run.stages.some((s) => s.name === stageName && s.status === 'passed')
    const repaired = await ctx.stage({
      name: stageName,
      role: 'worker',
      route: 'worker',
      prompt: 'Fix these verified findings within the approved scope. Commit the changes.\n' + JSON.stringify(issues) +
        (instruction ? '\n' + instruction : ''),
      criteria: ['Resolve the verified findings and preserve the approved behavior'],
      checks,
    })
    if (!repaired.passed) throw new Error('Audit repair is incomplete')
    head = recordedHead ?? await cleanHead(ctx)
    if (!recordedHead && !alreadyPassed && head === prevHead) throw new Error('Audit repair produced no new revision')
    if (!recordedHead) {
      repairHeads[idx] = head
      ctx.persist()
    }
    issues = await review(ctx, head, run.base)
  }
  for (let manual = 1; manual <= MAX_MANUAL_ESCALATIONS && issues.length > 0; manual++) {
    const escIdx = MAX_AUDIT_REPAIRS + manual - 1
    const escStage = `audit-escalation-${manual}`
    const recordedHead = repairHeads[escIdx]
    const answer = await ctx.ask('Remaining findings at ' + head + '. Resolve them before retrying: ' + JSON.stringify(issues), 'block')
    if (/^\s*stop\b/i.test(answer)) throw new Stopped('Audit stopped by the user at ' + head)
    if (recordedHead) {
      if (run.stages.some((s) => s.name === escStage)) {
        await ctx.stage({
          name: escStage,
          role: 'worker',
          route: 'worker',
          prompt: 'Resolve these remaining audit findings using Wen\'s guidance. Commit the changes.\n' + JSON.stringify(issues) + '\nGuidance: ' + answer,
          criteria: ['Resolve the verified findings and preserve the approved behavior'],
          checks,
        })
      }
      head = recordedHead
    } else {
      let revised = await cleanHead(ctx)
      if (revised === head && answer.trim() && !/^approved$/i.test(answer.trim())) {
        const repaired = await ctx.stage({
          name: escStage,
          role: 'worker',
          route: 'worker',
          prompt: 'Resolve these remaining audit findings using Wen\'s guidance. Commit the changes.\n' + JSON.stringify(issues) + '\nGuidance: ' + answer,
          criteria: ['Resolve the verified findings and preserve the approved behavior'],
          checks,
        })
        if (!repaired.passed) throw new Error('Audit repair is incomplete')
        revised = await cleanHead(ctx)
      }
      if (revised === head) throw new Error('Remaining findings at ' + head)
      head = revised
      repairHeads[escIdx] = head
      ctx.persist()
    }
    issues = await review(ctx, head, run.base)
  }
  if (issues.length) throw new Error('Remaining findings after audit repair limit at ' + head)
  for (const command of checks) {
    const check = await ctx.check(command)
    if (check.code) throw new Error(command + ' failed at ' + head + ': ' + check.output)
  }
  if (await cleanHead(ctx) !== head) throw new Error('Head changed during final verification')
  run.auditedHead = head
  ctx.persist()
}
