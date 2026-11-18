/** ship: a judged plan, one approval, then code-it-works, code-it-good and code-it-clean per slice, a review, and a last ask. */
import { publishDraft } from '../src/flow/publish.ts'
import { auditChange } from '../src/flow/audit.ts'
import { parsePlan, type Plan } from '../src/flow/memory.ts'
import { approvalQuestion, finalQuestion, isApproval, PLAN_CRITERIA, PLAN_RESULT_BLOCK, planPrompt, REVIEW_CRITERIA, reviewPrompt, slicePrompt } from '../src/flow/prompts.ts'
import type { FlowCtx, FlowMeta, WorkerOutput } from '../src/flow/types.ts'
import { jsonBlocks } from '../src/flow/verdict.ts'

export type ShipInput = { intent: string; notes?: string; cwd?: string; draftPR?: boolean }

export const meta: FlowMeta = {
  name: 'ship',
  description: 'Plan, ask once to approve, build each slice through the three code stages, review, and ask before the branch is yours.',
  input: '{"intent": "...", "notes": "...", "cwd": "/repo"}',
}

export const CODE_STAGES = ['code-it-works', 'code-it-good', 'code-it-clean']

export function validate(input: unknown): void {
  if ((input as { draftPR?: unknown })?.draftPR !== undefined && typeof (input as { draftPR?: unknown }).draftPR !== "boolean") throw new Error("draftPR must be boolean")
  const i = input as ShipInput
  if (typeof i?.intent !== 'string' || !i.intent.trim()) throw new Error('intent must be a non-empty string')
  if (i.notes !== undefined && typeof i.notes !== 'string') throw new Error('notes must be a string')
}

/** The planner puts its plan in a fenced json block, as plan beside its result or on its own. */
export function extractPlan(out: WorkerOutput): Plan {
  for (const block of jsonBlocks(out.text)) {
    const plan = parsePlan(block)
    if (plan) return plan
  }
  throw new Error('The worker returned no plan. End the last message with a fenced json block holding plan: {intent, slices: [{id, title, acceptance}]}.')
}

export async function run(ctx: FlowCtx, input: ShipInput) {
  const plan = await approvedPlan(ctx, input)
  for (const slice of plan.slices) {
    for (const skill of CODE_STAGES) {
      await ctx.stage({ name: `${skill}:${slice.id}`, skill, route: 'worker', prompt: slicePrompt(ctx.run, plan, slice, skill), criteria: ctx.gate(skill), checks: slice.acceptance })
    }
  }
  const checks = [...new Set(plan.slices.flatMap((s) => s.acceptance))]
  if (ctx.run.routes) {
    await auditChange(ctx, checks)
    if (ctx.run.auditedHead && input.draftPR === true) await publishDraft(ctx)
    return
  }
  const review = await ctx.stage({ name: 'review', skill: 'review', role: 'reviewer', prompt: reviewPrompt(ctx.run), criteria: REVIEW_CRITERIA, checks })
  const count = await ctx.check(`git rev-list --count ${ctx.run.base}..HEAD`)
  const verdict = review.passed ? 'pass' : 'skipped'
  await ctx.ask(finalQuestion(ctx.run, { commits: Number(count.output.trim()) || 0, review: review.summary, verdict }))
}

/** An answer that isn't a bare approval replans with that answer as notes. */
async function approvedPlan(ctx: FlowCtx, input: ShipInput): Promise<Plan> {
  let notes = input.notes ?? ''
  for (let round = 1; ; round++) {
    const stage = await ctx.stage({
      name: round === 1 ? 'plan' : `plan-${round}`, skill: 'plan', role: 'planner', route: 'planner', prompt: planPrompt(input.intent, notes),
      criteria: PLAN_CRITERIA, extract: extractPlan, resultTemplate: PLAN_RESULT_BLOCK,
    })
    if (!stage.passed) throw new Error('the plan stage was skipped, so there is nothing to build')
    let plan = stage.artifact as Plan
    let reviewNotes = ''
    if (ctx.run.routes) {
      const review = await ctx.agent({ role: 'reviewer', route: 'specReview', readOnly: true, title: 'Spec review ' + round,
        prompt: 'Review the proposed spec read-only for gaps and risks. Return JSON with findings as an array of concrete changes to consider. Use an empty array when ready to build.\n' + JSON.stringify(plan) })
      if (!review.ok) throw new Error('Spec review failed: ' + review.text)
      reviewNotes = '\nSpec review: ' + review.text
      const findings = (review.json as {findings?: unknown[]})?.findings
      if (!Array.isArray(findings) || findings.length) {
        const revision = await ctx.stage({ name:'plan-revision-' + round, skill:'plan', role:'planner', route:'planner',
          prompt:planPrompt(input.intent, 'Incorporate valid design feedback and retain prior constraints.\n' + JSON.stringify(plan) + reviewNotes),
          criteria:PLAN_CRITERIA,extract:extractPlan,resultTemplate:PLAN_RESULT_BLOCK })
        if (!revision.passed) throw new Error('The reviewed plan is incomplete')
        plan = revision.artifact as Plan
      }
    }
    const entry = await ctx.setPlan(plan)
    const answer = await ctx.ask(approvalQuestion(ctx.run, plan, entry) + reviewNotes)
    if (isApproval(answer)) return plan
    notes = answer + reviewNotes
  }
}
