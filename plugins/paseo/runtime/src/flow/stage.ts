/** One stage: worker rungs, checks, an independent judge, and persistent retries with the last failure as notes. */
import {join} from 'node:path'
import {readJsonDir} from '../store.ts'
import { lastJsonBlock } from '../backends/spawn.ts'
import { clydeHome,repoRoot, clydeBin } from '../config.ts'
import { ladder } from '../roles.ts'
import { rungLabel } from '../threads.ts'
import type { Rung } from '../types.ts'
import { skillPath } from './gate.ts'
import { verdictEntry } from './memory.ts'
import { memoryMaintenance,blockQuestion, firstLine, judgePrompt, limitQuestion, workerPrompt } from './prompts.ts'
import type { Driver } from './runtime.ts'
import { commitsSince, diffSince, headSha } from './shell.ts'
import type { Attempt, Check, StageRecord, StageResult, StageSpec, Verdict } from './types.ts'
import { failureNotes, parseVerdict, passes, pickJudge, VERDICT_SCHEMA, workerResult } from './verdict.ts'

const LOST = 'Lost when the daemon stopped.'
export const REPORT_ITEM = 'Report with clyde result'

export function maxStageAttempts(): number {
  const raw = Number(process.env.CLYDE_MAX_STAGE_ATTEMPTS)
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 12
}

type Outcome = { ok: true; verdict: Verdict; summary: string; artifact?: unknown; diff: string; checks: Check[] } | { ok: false; notes: string; acceptedBlock?: string; providerError?:string; limit?: string }

export async function runStage(d: Driver, spec: StageSpec): Promise<StageResult> {
  validate(spec)
  const run = d.run
  let rec = run.stages.find((s) => s.name === spec.name)
  if (rec?.status === 'passed') return resultOf(rec)
  if (rec) {
    // An interrupted attempt is a failure. The next attempt gets its reason as notes.
    for (const a of rec.attempts) if (!a.endedAt) Object.assign(a, { endedAt: now(), ok: false, reason: LOST })
  } else {
    // The base comes before the first attempt, so the judge's diff holds every attempt's work.
    rec = { name: spec.name, skill: spec.skill, role: spec.role ?? 'worker', status: 'running', base: await d.race(headSha(run.cwd)), round: 0, attempts: [], startedAt: now() }
    run.stages.push(rec)
  }
  const routed = spec.route && run.routes ? spec.route : undefined
  const workers = routed ? [] : ladder(rec.role)
  let notes = rec.attempts.at(-1)?.ok === false ? notesOf(rec.attempts.at(-1)!) : ''
  for (;;) {
    const maxAttempts = maxStageAttempts()
    if (rec.attempts.length >= maxAttempts) {
      Object.assign(rec, { status: 'failed', endedAt: now() })
      d.save()
      throw new Error(`Stage ${spec.name} exceeded the maximum of ${maxAttempts} attempts`)
    }
    const pending = rec.status === 'asking' ? rec.attempts.at(-1) : undefined
    if (pending?.acceptedBlock || pending?.limit || pending?.providerError) {
      const kind = pending.acceptedBlock ? 'block' : pending.providerError ? 'provider' : 'limit'
      const question = pending.acceptedBlock
        ? blockQuestion(run, spec.name, pending.acceptedBlock)
        : pending.providerError ? pending.providerError : limitQuestion(run, spec.name, pending.limit!)
      const answer = await d.ask(`${spec.name}:${kind}:${pending.n}`, kind, question)
      rec.status = 'running'
      d.save()
      if (/^\s*stop\b/i.test(answer)) {
        Object.assign(rec, { status: 'failed', endedAt: now() })
        d.save()
        throw d.stopped(`stage ${spec.name} stopped by the user`)
      }
      if (pending.providerError && routed && run.routes?.[routed] && !run.routes[routed]!.pinned) {
        delete run.routes[routed]
        d.save()
      }
      notes = [notes, `Wen answered the ${kind} ask: ${answer}`].filter(Boolean).join('\n\n')
    }
    rec.round += 1
    rec.status = 'running'
    d.save()
    const rung = routed ? await d.route(routed) : workers[Math.min(rec.attempts.length, workers.length - 1)]
    const out = await attempt(d, spec, rec, rung, notes)
    if (out.ok) return pass(d, rec, out)
    notes = out.notes
    // Attempts that die within seconds aren't the worker trying and failing. Something underneath is broken, and with no
    // attempt cap the loop would spin thousands of times a minute, as it did on a Claude session limit.
    const spun = fastFailures(rec.attempts)
    if (!out.limit && !out.providerError && !out.acceptedBlock && spun >= FAST_FAILS) {
      out.providerError = `The worker failed to start ${spun} times. ${rec.attempts.at(-1)?.reason ?? ""} Fix the launch problem, then retry.`
    }
    if (out.limit && !run.quotaFailover && routed === 'worker' && run.routes?.worker && !run.routes.worker.pinned &&
        ['sol', 'sonnet'].includes(run.routes.worker.model) && rec.attempts.at(-1)?.reason?.startsWith('The worker failed:')) {
      const previous = run.routes.worker.model
      run.routes.worker = { model: previous === 'sol' ? 'sonnet' : 'sol', reason: previous + ' hit its usage limit. Continuing in the existing worktree.', pinned: false }
      run.quotaFailover = true
      d.save()
      continue
    }
    if (out.acceptedBlock || out.limit || out.providerError) {
      if (rec.attempts.length < maxAttempts) {
        const last = rec.attempts.at(-1)!
        if(out.providerError)last.providerError=out.providerError
        if (out.acceptedBlock) last.acceptedBlock = out.acceptedBlock
        if (out.limit) {
          last.limit = out.limit
          d.emit('run.limit', `Run ${run.id} stage ${spec.name} hit a backend limit: ${firstLine(out.limit)}`, { stage: spec.name, attempt: last.n, error: out.limit })
        }
        rec.status = 'asking'
        d.save()
      }
    }
  }
}

async function attempt(d: Driver, spec: StageSpec, rec: StageRecord, rung: Rung, notes: string): Promise<Outcome> {
  const run = d.run
  const n = rec.attempts.length + 1
  const before = rec.attempts.at(-1)
  const after = before && !before.ok ? ` Attempt ${before.n} failed: ${firstLine(before.reason ?? '')}` : ''
  d.emit('run.stage', `Run ${run.id} stage ${spec.name}: attempt ${n} on ${rungLabel(rung)}.${after}`, { stage: spec.name, attempt: n, round: rec.round, rung })
  const prompt = workerPrompt({ run, spec, attempt: n, notes, skillFile: spec.skill ? skillPath(spec.skill) : undefined, root: repoRoot(), bin: clydeBin() })
  // The worker starts from a list the runtime writes, one item per gate criterion, and adds its own steps under them.
  const representative = !run.parentThreadId && rec.attempts.length === 0 &&
    ((run.flow === 'task' && spec.name === 'task') || (run.flow === 'ship' && spec.name === 'plan'))
  const worker = d.startThread({ title: `${run.id} ${spec.name} #${n} worker`, prompt, rung, stage: spec.name,
    list: [...spec.criteria, REPORT_ITEM], ...(representative ? { mirrorTitle: run.title } : {}) })
  const a: Attempt = { n, round: rec.round, rung, threadId: worker.id, startedAt: now() }
  rec.attempts.push(a)
  d.save()
  const done = await d.waitThread(worker.id)
  const turn = done.turns.at(-1)
  if (!turn?.ok) {
    const error = turn?.error ?? done.status
    const perm = permissionFailure(error)
    if (perm) return { ...fail(d, a, 'The worker failed: ' + error), providerError: perm }
    const det = deterministicProviderFailure(error)
    if (det) return { ...fail(d, a, 'The worker failed: ' + error), providerError: det }
    return backendLimit(error) ? { ...fail(d, a, `The worker failed: ${error}.`), limit: error } : fail(d, a, `The worker failed: ${error}.`)
  }
  const text = turn.text ?? ''
  const result = workerResult(d.threads.result(worker.id), text)
  if (!result) return fail(d, a, 'The worker reported no result. Report with clyde result, or end the last message with the fenced json block.')
  a.result = result
  if (result.status === 'blocked') {
    const reason = result.summary
    const diff = await d.race(diffSince(run.cwd, rec.base))
    const commits = await d.race(commitsSince(run.cwd, rec.base))
    const blockSpec = { ...spec, criteria: ['The worker is genuinely blocked and cannot resolve this stage without Wen.'], checks: [] }
    const { verdict, errors } = await judge(d, blockSpec, rec, a, { diff, commits, checks: [], artifact: { blocked: reason } })
    if (!verdict) {
      const why = errors.join(' ')
      return backendLimit(why) ? { ...fail(d, a, why), limit: why } : fail(d, a, why)
    }
    a.verdict = verdict
    if (passes(verdict, blockSpec.criteria, [])) return { ...fail(d, a, `The judge accepted the block: ${reason}`), acceptedBlock: reason }
    return fail(d, a, `The judge rejected the block: ${firstLine(verdict.notes) || reason}`)
  }
  let artifact: unknown
  if (spec.extract) {
    try {
      artifact = spec.extract({ text, result })
    } catch (err) {
      return fail(d, a, (err as Error).message)
    }
    if (artifact === undefined) return fail(d, a, "The worker's output doesn't hold what this stage makes.")
  }
  const checks: Check[] = []
  for (const cmd of spec.checks ?? []) checks.push({ cmd, ...(await d.check(cmd)) })
  a.checks = checks
  d.save()
  const failed = checks.find((c) => c.code !== 0)
  // A failed check is decisive, so it skips the judge and goes straight to the next rung as notes.
  if (failed) return fail(d, a, `A check failed: \`${failed.cmd}\` exited ${failed.code}.`)
  const diff = await d.race(diffSince(run.cwd, rec.base))
  const commits = await d.race(commitsSince(run.cwd, rec.base))
  const { verdict, errors } = await judge(d, spec, rec, a, { diff, commits, checks, artifact })
  if (!verdict) {
    const why = `No judge returned a verdict, so the work is ungraded. ${errors.join(' ')}`
    return backendLimit(errors.join(' ')) ? { ...fail(d, a, why), limit: errors.join(' ') } : fail(d, a, why)
  }
  a.verdict = verdict
  if (!passes(verdict, spec.criteria, checks)) return fail(d, a, `The judge failed it: ${firstLine(verdict.notes) || 'no notes'}`)
  Object.assign(a, { ok: true, endedAt: now() })
  d.save()
  return { ok: true, verdict, summary: result.summary, artifact, diff, checks }
}

/**
 * A fresh read-only thread from another model family, per ruling 8. It sees the criteria, the diff, the checks and the run
 * scope, never the worker's transcript or result. A judge that gives no verdict hands over to the next judge rung.
 */
async function judge(d: Driver, spec: StageSpec, rec: StageRecord, a: Attempt, o: { diff: string; commits: string; checks: Check[]; artifact?: unknown }): Promise<{ verdict: Verdict | null; errors: string[] }> {
  const judges = ladder('judge')
  const pick = pickJudge(judges, a.rung)
  if (!pick.differs) d.log(`No judge rung is from another family than ${rungLabel(a.rung)}, so ${rungLabel(pick.rung)} judges stage ${spec.name}.`)
  const order = [pick.rung, ...judges.filter((j) => j !== pick.rung)]
  let prompt = judgePrompt({ run: d.run, spec, base: rec.base, commits: o.commits, diff: o.diff, checks: o.checks, artifact: o.artifact })
  if(memoryMaintenance(d.run)){
    const receipts=readJsonDir<{id:string;title:string;sources:string[]}>(join(clydeHome(),'note-receipts',d.run.id))
    prompt+='\nThis is a shared-memory task. Grade the note changes, not repository diffs. The host read these new notes back from Clyde and verified their links to the original, unmodified notes: '+JSON.stringify(receipts)+
      '\nWorker report (check claims against those receipts): '+JSON.stringify(a.result)
  }
  const errors: string[] = []
  for (const rung of order) {
    const t = d.startThread({ title: `${d.run.id} ${spec.name} #${a.n} judge`, prompt, rung, stage: spec.name, readOnly: true, schema: VERDICT_SCHEMA })
    Object.assign(a, { judgeId: t.id, judgeRung: rung })
    d.save()
    const turn = (await d.waitThread(t.id)).turns.at(-1)
    const verdict = turn?.ok ? parseVerdict(turn.json) ?? parseVerdict(lastJsonBlock(turn.text ?? '')) : null
    if (verdict) return { verdict, errors }
    const why = `Judge ${rungLabel(rung)}: ${firstLine(turn?.error ?? 'no valid Verdict JSON')}.`
    errors.push(why)
    d.log(`${why.replace(/\.$/, '')} on stage ${spec.name} attempt ${a.n}.`)
  }
  return { verdict: null, errors }
}

function fail(d: Driver, a: Attempt, reason: string): Outcome {
  Object.assign(a, { ok: false, reason, endedAt: now() })
  d.save()
  return { ok: false, notes: notesOf(a) }
}

/** reason is the attempt's one line for events and the record. The next rung gets the judge's whole say instead. */
function notesOf(a: Attempt): string {
  if (a.acceptedBlock) return `The judge accepted the block: ${a.acceptedBlock}`
  if (a.reason?.startsWith('The judge rejected the block:')) return failureNotes(a.verdict ?? null, a.checks ?? [], a.reason)
  return failureNotes(a.verdict ?? null, a.checks ?? [], a.verdict ? 'The judge failed it.' : a.reason ?? '')
}

/** The verdict goes to memory before the stage counts as passed, so a restart while memory is down reruns the stage rather than losing it. */
async function pass(d: Driver, rec: StageRecord, out: Extract<Outcome, { ok: true }>): Promise<StageResult> {
  rec.entry = await d.remember(verdictEntry(d.run, rec, out.verdict, out.diff, out.checks))
  Object.assign(rec, { status: 'passed', verdict: out.verdict, summary: out.summary, endedAt: now() })
  if (out.artifact !== undefined) rec.artifact = out.artifact
  d.save()
  const n = rec.attempts.length
  d.emit('run.passed', `Run ${d.run.id} stage ${rec.name} passed on attempt ${n}.`, { stage: rec.name, attempts: n, entry: rec.entry })
  return resultOf(rec)
}

function resultOf(rec: StageRecord): StageResult {
  const last = [...rec.attempts].reverse().find((a) => a.verdict)?.verdict
  const verdict = rec.verdict ?? last ?? { verdict: 'fail', criteria: [], notes: rec.attempts.at(-1)?.reason ?? 'No attempt finished.' }
  const out: StageResult = { passed: rec.status === 'passed', attempts: rec.attempts.length, verdict, summary: rec.summary ?? '' }
  if (rec.artifact !== undefined) out.artifact = rec.artifact
  return out
}

const FAST_MS = 30_000
const FAST_FAILS = 3

/** How many of the latest attempts failed in a row, each within FAST_MS and with no verdict. */
export function fastFailures(attempts: Attempt[]): number {
  let n = 0
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i]
    if (a.ok !== false || a.verdict || !a.endedAt || Date.parse(a.endedAt) - Date.parse(a.startedAt) > FAST_MS) break
    n++
  }
  return n
}

export function permissionFailure(error:string):string|undefined {
  if (/^Permission required:/i.test(error))return error
  if (/permission.*cannot prompt|headless.*cannot prompt|tool required the .*permission|soft-denying tool/i.test(error))
    return 'The provider denied a tool required by this worker. Retry with the permitted Paseo launch mode or choose another worker.'
}

/** Detect deterministic launch/CLI/auth failures that cannot succeed by blindly retrying. */
export function deterministicProviderFailure(error: string): string | undefined {
  if (
    /API Error:\s*40[013]\b|does not support this model|unrecognized_model|unknown model|model_not_found|invalid_model|version\s+[\d.]+\s+or newer is required|Run ['"]?claude update['"]?|unknown (?:flag|option)|unrecognized option|not logged in|please log in|authentication_error|invalid[_ ]api[_ ]key|unauthorized/i
      .test(error)
  ) {
    return `The provider rejected this launch (${firstLine(error)}). Fix the CLI or model config, then retry.`
  }
}

export function backendLimit(error: string): boolean {
  return /\b429\b|insufficient_quota|(?:usage|rate|token|context|spend|session|weekly|daily|hourly)\s*(?:window\s*)?limit|hit your (?:\w+ )?limit|limit\s*·\s*resets|(?:quota|limit)\s*(?:exceeded|exhausted|reached)|(?:exceeded|exhausted|reached)\s*(?:your\s*)?(?:usage|rate|token|context|quota|limit)/i.test(error)
}

function validate(spec: StageSpec): void {
  if (!spec?.name || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(spec.name)) throw new Error(`stage name ${spec?.name} must be letters, digits and . _ : -`)
  if (!spec.prompt?.trim()) throw new Error(`stage ${spec.name} needs a prompt`)
  if (!Array.isArray(spec.criteria) || !spec.criteria.length) throw new Error(`stage ${spec.name} needs at least one criterion`)
}

function now(): string {
  return new Date().toISOString()
}
