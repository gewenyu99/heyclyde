/** The shapes of clyde-flow: what a flow asks of a stage, what a run records, and what the judge returns. PLAN "Flow contract". */
import type { Stage, Selection } from '../routing.ts'
import type { Rung } from '../types.ts'

export type StageSpec = {
  name: string; skill?: string; prompt: string; criteria: string[]; checks?: string[]; role?: string
  route?: Stage
  resultTemplate?: string
  // Pulls the stage's product out of the worker's output, like the plan. The judge sees it, never the worker's own claims.
  extract?: (output: WorkerOutput) => unknown
}

export type Criterion = { criterion: string; pass: boolean; evidence: string }
export type Verdict = { verdict: 'pass' | 'fail'; criteria: Criterion[]; notes: string }

export type WorkerResult = { status: 'done' | 'blocked'; summary: string; evidence: { criterion: string; evidence: string }[] }
export type WorkerOutput = { text: string; result: WorkerResult | null }

export type Check = { cmd: string; code: number; output: string }

export type StageResult = { passed: boolean; attempts: number; verdict: Verdict; summary: string; artifact?: unknown }

export type Attempt = {
  n: number; round: number; rung: Rung; threadId: string; startedAt: string; endedAt?: string
  ok?: boolean; reason?: string; result?: WorkerResult; checks?: Check[]; judgeId?: string; judgeRung?: Rung; verdict?: Verdict
  acceptedBlock?: string; limit?: string
}

export type StageStatus = 'running' | 'asking' | 'passed' | 'skipped' | 'failed'

export type StageRecord = {
  name: string; skill?: string; role: string; status: StageStatus; base: string; round: number; attempts: Attempt[]
  verdict?: Verdict; summary?: string; artifact?: unknown; entry?: string; startedAt: string; endedAt?: string
}

export type AskKind = 'approve' | 'block' | 'limit' | 'memory'
export type AskRecord = {
  key: string; kind: AskKind; question: string; askedAt: string
  answer?: string; via?: string; answeredAt?: string; entry?: string
}

export type RunStatus = 'running' | 'asking' | 'done' | 'failed' | 'stopped'

export type Run = {
  id: string; flow: string; title: string; status: RunStatus; input: unknown
  steering?: string[]
  auditFindings?: {id:string; evidence:string; status:'confirmed'|'dismissed'|'needs a decision'}[]
  pullRequest?: string
  auditedHead?: string; auditBaseHead?: string
  routes?: Partial<Record<Stage, Selection>>
  quotaFailover?: boolean
  parentThreadId?: string
  // cwd is the run's worktree, where every thread and check runs. repo is the checkout it was cut from.
  cwd: string; repo: string; branch: string; base: string
  stages: StageRecord[]; question?: string; answers: string[]; asks: AskRecord[]; entries: string[]
  project?: string; plan?: unknown; planEntry?: string; plans: { entry: string; plan: unknown }[]; agents: Record<string, AgentResult>
  log: string[]; firstEvent: number; error?: string; createdAt: string; updatedAt: string; endedAt?: string
}

export type AgentResult = { ok: boolean; text: string; json?: unknown }

export type FlowCtx = {
  run: Run; cwd: string; scope: string
  stage(spec: StageSpec): Promise<StageResult>
  agent(opts: { route?: Stage; role: string; prompt: string; readOnly?: boolean; title: string }): Promise<AgentResult>
  check(cmd: string): Promise<{ code: number; output: string }>
  ask(question: string): Promise<string>
  remember(entry: object): Promise<string>
  setPlan(plan: unknown): Promise<string>
  gate(skill: string, section?: string): string[]
  persist(): void
  log(line: string): void
}

export type FlowMeta = { name: string; description: string; input: string }

export type FlowModule = {
  meta: FlowMeta
  run(ctx: FlowCtx, input: any): Promise<unknown>
  // Throws with a line a person can act on when the input is wrong, so POST /runs answers 400 before a worktree exists.
  validate?(input: unknown): void
}
