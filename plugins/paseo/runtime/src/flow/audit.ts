import { inferRouting } from '../routing.ts'
import { committedDiff, headSha } from './shell.ts'
import type { FlowCtx } from './types.ts'

type Finding = { id: string; evidence: string }
type Disposition = Finding & { status: 'confirmed' | 'dismissed' | 'needs a decision' }

function findings(value: unknown): Finding[] {
  const rows = (value as { findings?: Finding[] })?.findings
  if (
    !Array.isArray(rows) ||
    rows.some((f) =>
      !f || typeof f.id !== 'string' || !f.id.trim() || typeof f.evidence !== 'string' || !f.evidence.trim()
    ) ||
    new Set(rows.map((f) => f.id)).size !== rows.length
  ) throw new Error('Reviewer returned invalid findings')
  return rows
}

async function review(ctx: FlowCtx, head: string, base: string) {
  const diff = await committedDiff(ctx.cwd, base, head)
  const audit = await ctx.agent({
    role: 'reviewer',
    route: 'audit',
    readOnly: true,
    title: 'Audit ' + head,
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
    prompt: 'Check every finding independently at ' + head +
      '. Return fenced JSON with findings: [{id,status,evidence}]. Use confirmed, dismissed, or needs a decision.\n' +
      JSON.stringify(issues) + '\n' + diff,
  })
  if (!triage.ok) throw new Error(triage.text || 'Finding verification unavailable')
  const rows = findings(triage.json) as Disposition[]
  if (
    rows.length !== issues.length ||
    rows.some((f) =>
      !issues.some((i) => i.id === f.id) || !['confirmed', 'dismissed', 'needs a decision'].includes(f.status)
    )
  ) throw new Error('Incomplete finding dispositions')
  return rows.filter((f) => f.status !== 'dismissed')
}

async function cleanHead(ctx: FlowCtx) {
  const status = await ctx.check('git status --porcelain')
  if (status.code || status.output.trim()) throw new Error('Commit outstanding work before final verification')
  return headSha(ctx.cwd)
}

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
  const issues = run.auditFindings
  if (issues.length) {
    const pending = issues.filter((i) => i.status === 'needs a decision')
    const instruction = pending.length ? await ctx.ask('Resolve these audit findings: ' + JSON.stringify(pending)) : ''
    if (run.routes?.worker && !run.routes.worker.pinned) {
      const complexity = inferRouting(issues.map((issue) => issue.evidence).join(' ') + ' ' + instruction)
      if (complexity.complexity === 'complex') {
        run.routes.worker = { model: 'opus', reason: 'Complex repair: ' + complexity.reason, pinned: false }
        ctx.persist()
      }
    }
    const repaired = await ctx.stage({
      name: 'audit-repair',
      role: 'worker',
      route: 'worker',
      prompt: 'Fix these verified findings within the approved scope. Commit the changes.\n' + JSON.stringify(issues) +
        '\n' + instruction,
      criteria: ['Resolve the verified findings and preserve the approved behavior'],
      checks,
    })
    if (!repaired.passed) throw new Error('Audit repair is incomplete')
  }
  let head = await cleanHead(ctx)
  if (issues.length && head === initialHead) throw new Error('Audit repair produced no new revision')
  while (head !== initialHead) {
    const remaining = await review(ctx, head, initialHead)
    if (!remaining.length) break
    await ctx.ask('Remaining findings at ' + head + '. Resolve them before retrying: ' + JSON.stringify(remaining))
    const revised = await cleanHead(ctx)
    if (revised === head) throw new Error('Remaining findings at ' + head)
    head = revised
  }
  for (const command of checks) {
    const check = await ctx.check(command)
    if (check.code) throw new Error(command + ' failed at ' + head + ': ' + check.output)
  }
  if (await cleanHead(ctx) !== head) throw new Error('Head changed during final verification')
  run.auditedHead = head
  ctx.persist()
}
