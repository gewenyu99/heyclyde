/** One stage: worker rungs, checks, an independent judge, and persistent retries with the last failure as notes. */
import {join} from 'node:path'
import {readJsonDir} from '../store.ts'
import { lastJsonBlock } from '../backends/spawn.ts'
import { clydeHome,repoRoot, clydeBin } from '../config.ts'
import { ladder } from '../roles.ts'
import { rungLabel } from '../threads.ts'
import type { Rung, Thread } from '../types.ts'
import { skillPath } from './gate.ts'
import { verdictEntry } from './memory.ts'
import { memoryMaintenance,planning,blockQuestion, firstLine, judgePrompt, limitQuestion, workerPrompt } from './prompts.ts'
import type { Driver } from './runtime.ts'
import { commitsSince, diffSince, headSha } from './shell.ts'
import type { Attempt, Check, StageRecord, StageResult, StageSpec, Verdict, WorkerResult } from './types.ts'
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
  if (run.paseoParentId && spec.name.startsWith('code-it-works:') && spec.checks?.length && !rec.attempts.length && !rec.baselineChecks) {
    // Capture evidence before any worker edits. A permission retry may resume after the change is already present.
    const baseline: Check[] = []
    for (const cmd of spec.checks) baseline.push({ cmd, ...(await d.check(cmd)) })
    rec.baselineChecks = baseline
    d.save()
  }
  const routed = spec.route && run.routes ? spec.route : undefined
  const workers = routed ? [] : ladder(rec.role)
  let notes = rec.attempts.at(-1)?.ok === false ? notesOf(rec.attempts.at(-1)!) : ''
  for (;;) {
    const maxAttempts = maxStageAttempts()
    if (rec.attempts.length >= maxAttempts) {
      Object.assign(rec, { status: 'failed', endedAt: now() })
      d.save()
      const why = rec.attempts.at(-1)?.reason
      const limit = `Stage ${spec.name} exceeded the maximum of ${maxAttempts} attempts`
      throw new Error(why ? `${firstLine(why).replace(/[.!?]$/, '')}. ${limit}` : limit)
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
    // Replaying a paused legacy run reaches this only after its explicit provider answer above.
    const previous = rec.attempts.at(-1)
    const saved = planning(spec) && spec.extract && previous?.ok === false && !previous.verdict && previous.reason === 'The worker failed: ' + UNSENT_PARENT_FAILURE
      ? recoverPlan(spec, d.threads.get(previous.threadId), run.id) : undefined
    const currentSpec = withUndeliveredRequirements(d, spec, rec)
    const out = saved
      ? await recoveredAttempt(d, currentSpec, rec, previous!, saved)
      : await attempt(d, currentSpec, rec, routed ? await d.route(routed) : workers[Math.min(rec.attempts.length, workers.length - 1)], notes)
    if (out.ok) return pass(d, rec, out)
    notes = out.notes
    // Attempts that die within seconds aren't the worker trying and failing. Something underneath is broken, and with no
    // attempt cap the loop would spin thousands of times a minute, as it did on a Claude session limit.
    const extractFails = consecutiveExtractFailures(rec.attempts)
    if (!out.limit && !out.providerError && !out.acceptedBlock && extractFails >= EXTRACT_FAILS) {
      out.providerError = `The worker missed the required output format ${extractFails} times in a row. ${rec.attempts.at(-1)?.reason ?? ''} Open chat or retry.`
    }
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
  const baseline = rec.baselineChecks?.map(c => `exit ${c.code}: ${c.cmd}`).join('\n')
  const worker = d.startThread({ title: `${run.id} ${spec.name} #${n} worker`, prompt: baseline ? prompt + "\nBefore this stage edited the worktree, the runtime observed:\n" + baseline : prompt, rung, stage: spec.name,
    ...(!(planning(spec) && spec.extract) && (!run.paseoParentId || memoryMaintenance(run)) ? { list: [...spec.criteria, REPORT_ITEM] } : {}), ...(representative ? { mirrorTitle: run.title } : {}) })
  const a: Attempt = { n, round: rec.round, rung, threadId: worker.id, startedAt: now() }
  rec.attempts.push(a)
  d.save()
  const done = await d.waitThread(worker.id)
  const turn = done.turns.at(-1)
  if (!turn?.ok) {
    const error = turn?.error ?? done.status
    const saved = recoverPlan(spec, done, run.id)
    if (saved && rec.attempts.length < maxStageAttempts()) {
      // Preserve the failed launch as its own attempt. The saved artifact gets a separate independent ruling.
      fail(d, a, 'The worker failed: ' + error)
      rec.round += 1
      return recoveredAttempt(d, withUndeliveredRequirements(d, spec, rec), rec, a, saved)
    }
    const perm = permissionFailure(error)
    if (perm) return { ...fail(d, a, 'The worker failed: ' + error), providerError: perm }
    const det = deterministicProviderFailure(error)
    if (det) return { ...fail(d, a, 'The worker failed: ' + error), providerError: det }
    return backendLimit(error) ? { ...fail(d, a, `The worker failed: ${error}.`), limit: error } : fail(d, a, `The worker failed: ${error}.`)
  }
  const text = turn.text ?? ''
  const result = workerResult(d.threads.result(worker.id), text)
  if (!result) return fail(d, a, 'The worker reported no result. Report with clyde result, or end the last message with the fenced json block.')
  return gradeOutput(d, spec, rec, a, text, result)
}

async function gradeOutput(d: Driver, spec: StageSpec, rec: StageRecord, a: Attempt, text: string, result: WorkerResult): Promise<Outcome> {
  const run = d.run
  a.result = result
  let verifiedExisting = false
  if (result.status === 'blocked') {
    const reason = result.summary
    const diff = await d.race(diffSince(run.cwd, rec.base))
    if (run.paseoParentId && diff && needsGitPermission(result)) {
      const question = 'Git needs permission to commit in the task worktree. Review the changes in Paseo and commit the files you approve, then retry.'
      return { ...fail(d, a, reason), providerError: question }
    }
    // A verification worker can try to re-stage an already committed implementation.
    // Judge that work against the original criteria and real checks; no new commit is required.
    const verifySlice = /^code-it-(?:good|clean):(.+)$/.exec(spec.name)?.[1]
    verifiedExisting = !!(run.paseoParentId && needsGitPermission(result) && !diff && verifySlice &&
      run.stages.some(s => s.name === 'code-it-works:' + verifySlice && s.status === 'passed' && s.base !== rec.base))
    if (!verifiedExisting) {
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
  }
  let artifact: unknown
  if (spec.extract) {
    try {
      artifact = spec.extract({ text, result })
    } catch (err) {
      return fail(d, a, (err as Error).message, { extractError: true })
    }
    if (artifact === undefined) return fail(d, a, "The worker's output doesn't hold what this stage makes.", { extractError: true })
  }
  const checks: Check[] = []
  for (const cmd of spec.checks ?? []) checks.push({ cmd, ...(await d.check(cmd)) })
  a.checks = checks
  d.save()
  const failed = checks.find((c) => c.code !== 0)
  // A failed check is decisive, so it skips the judge and goes straight to the next rung as notes.
  if (failed) return fail(d, a, `A check failed: \`${failed.cmd}\` exited ${failed.code}.`)
  // Quality and cleanup review the implemented slice even when this pass needs no additional edits.
  const slice = /^code-it-(?:good|clean):(.+)$/.exec(spec.name)?.[1]
  const base = spec.name === 'review' ? run.base
    : (slice && run.stages.find(stage => stage.name === 'code-it-works:' + slice)?.base) || rec.base
  const diff = await d.race(diffSince(run.cwd, base))
  const commits = await d.race(commitsSince(run.cwd, base))
  const { verdict, errors } = await judge(d, spec, rec, a, { base, diff, commits, checks, artifact })
  if (!verdict) {
    const why = `No judge returned a verdict, so the work is ungraded. ${errors.join(' ')}`
    return backendLimit(errors.join(' ')) ? { ...fail(d, a, why), limit: errors.join(' ') } : fail(d, a, why)
  }
  a.verdict = verdict
  if (!passes(verdict, spec.criteria, checks)) return fail(d, a, `The judge failed it: ${firstLine(verdict.notes) || 'no notes'}`)
  Object.assign(a, { ok: true, endedAt: now() })
  d.save()
  return { ok: true, verdict, summary: verifiedExisting ? 'Verified the existing commit against the stage criteria.' : result.summary, artifact, diff, checks }
}

// A shell sandbox can allow working files but refuse the linked worktree's Git index.
export function needsGitPermission(result: WorkerResult): boolean {
  if (result.status !== 'blocked') return false
  const report = [result.summary, ...result.evidence.map(item => item.evidence)].join(' ')
  return /\bgit\b/i.test(report) && /index[ .-]lock|unable to create[^\n]*\.git/i.test(report) &&
    /operation not permitted|permission denied|denied permission|read-only file system/i.test(report)
}

// This exact launcher error is raised before child.send, so later work cannot have invalidated the saved plan.
const UNSENT_PARENT_FAILURE = 'The originating Paseo agent is unavailable'
type SavedPlan = { text: string; result: WorkerResult; turn: number; followups: string[] }

function recoverPlan(spec: StageSpec, thread: Thread | undefined, runId: string): SavedPlan | undefined {
  if (!planning(spec) || !spec.extract || !thread?.paseoAgentId || thread.runId !== runId || thread.stage !== spec.name || thread.readOnly || thread.status !== 'failed') return
  const index = thread.turns.findLastIndex(t => t.ok === true && !!t.endedAt)
  if (index < 0 || index === thread.turns.length - 1) return
  const turn = thread.turns[index]
  const later = thread.turns.slice(index + 1)
  if (!later.every(t => t.ok === false && !!t.endedAt && t.error === UNSENT_PARENT_FAILURE && !t.text?.trim() && t.json === undefined)) return
  // Read the completed turn's own fenced result, never a mutable thread.result left by another turn.
  const text = turn.text ?? ''
  const result = workerResult(undefined, text)
  if (result?.status !== 'done') return
  try {
    if (spec.extract({ text, result }) === undefined) return
  } catch { return }
  return { text, result, turn: turn.n, followups: [...later.map(t => t.prompt), ...thread.queue].filter(t => t.trim()) }
}

function withUndeliveredRequirements(d: Driver, spec: StageSpec, rec: StageRecord): StageSpec {
  if (!planning(spec) || !spec.extract) return spec
  const followups = rec.attempts.flatMap(a => recoverPlan(spec, d.threads.get(a.threadId), d.run.id)?.followups ?? [])
  const criteria = [...new Set([...spec.criteria, ...followups.map(prompt => `The plan accounts for this user follow-up, which could not be delivered to the planner: ${prompt}`)])]
  return { ...spec, criteria }
}

async function recoveredAttempt(d: Driver, spec: StageSpec, rec: StageRecord, previous: Attempt, saved: SavedPlan): Promise<Outcome> {
  const a: Attempt = { n: rec.attempts.length + 1, round: rec.round, rung: previous.rung, threadId: previous.threadId, startedAt: now() }
  rec.attempts.push(a)
  d.save()
  d.emit('run.stage', `Run ${d.run.id} stage ${spec.name}: judging the saved plan from turn ${saved.turn} of ${a.threadId} after an undelivered follow-up.`, { stage: spec.name, attempt: a.n, recoveredFromAttempt: previous.n, threadId: a.threadId, turn: saved.turn })
  return gradeOutput(d, spec, rec, a, saved.text, saved.result)
}

/**
 * A fresh read-only thread from another model family, per ruling 8. It sees the criteria, the diff, the checks and the run
 * scope, never the worker's transcript or result. A judge that gives no verdict hands over to the next judge rung.
 */
async function judge(d: Driver, spec: StageSpec, rec: StageRecord, a: Attempt, o: { base?: string; diff: string; commits: string; checks: Check[]; artifact?: unknown }): Promise<{ verdict: Verdict | null; errors: string[] }> {
  const judges = ladder('judge')
  const pick = pickJudge(judges, a.rung)
  if (!pick.differs) d.log(`No judge rung is from another family than ${rungLabel(a.rung)}, so ${rungLabel(pick.rung)} judges stage ${spec.name}.`)
  const order = [pick.rung, ...judges.filter((j) => j !== pick.rung)]
  let prompt = judgePrompt({ run: d.run, spec, base: o.base ?? rec.base, commits: o.commits, diff: o.diff, checks: o.checks, artifact: o.artifact })
  if (/^code-it-(good|clean):/.test(spec.name) || spec.name === 'review') {
    prompt += '\nThese are verification stages. The accumulated committed change and actual acceptance checks above are the deliverable. No empty commit is required. No new implementation or extra test files should be demanded outside the approved scope.'
  }
  if (rec.baselineChecks?.length) {
    prompt += '\nThe runtime executed these checks before the first worker attempt. Compare them with the post-change checks above:\n' +
      rec.baselineChecks.map(c => `${c.cmd} exited ${c.code}\n${c.output.slice(-2000)}`).join('\n')
  }
  if (d.run.paseoParentId && a.result && !planning(spec) && !memoryMaintenance(d.run)) {
    prompt += '\nWorker-reported evidence (verify against files, checks and the change):\n' + JSON.stringify({ current: a.result, earlier: rec.attempts.filter(attempt => attempt.n < a.n && attempt.result).slice(-2).map(attempt => ({ attempt: attempt.n, report: attempt.result, checks: attempt.checks })) }).slice(0, 12000)
  }
  if(memoryMaintenance(d.run)){
    const receipts=readJsonDir<{id:string;title:string;sources:string[]}>(join(clydeHome(),'note-receipts',d.run.id))
    prompt+='\nThis is a shared-memory task. Grade the note changes, not repository diffs. The host read these new notes back from Clyde and verified their links to the original, unmodified notes: '+JSON.stringify(receipts)+
      '\nWorker report (check claims against those receipts): '+JSON.stringify(a.result)
  }
  const errors: string[] = []
  async function requestVerdict(rung: Rung, instructions: string) {
    const t = d.startThread({ title: `${d.run.id} ${spec.name} #${a.n} judge`, prompt: instructions, rung, stage: spec.name, readOnly: true, schema: VERDICT_SCHEMA })
    Object.assign(a, { judgeId: t.id, judgeRung: rung })
    d.save()
    const turn = (await d.waitThread(t.id)).turns.at(-1)
    const verdict = turn?.ok ? parseVerdict(turn.json) ?? parseVerdict(lastJsonBlock(turn.text ?? '')) : null
    return { verdict, error: turn?.error }
  }
  const contradictory = (v: Verdict | null) => v && v.criteria.length >= spec.criteria.length &&
    (v.verdict === 'pass') !== v.criteria.every(c => c.pass)
  for (const rung of order) {
    let response = await requestVerdict(rung, prompt)
    if (contradictory(response.verdict)) {
      d.log(`Checking an inconsistent verdict from ${rungLabel(rung)} for stage ${spec.name}.`)
      response = await requestVerdict(rung, prompt + '\nThe previous verdict disagreed with its individual grades. Recheck the evidence. Identify the unmet criterion if the verdict is fail. Return one consistent verdict.')
    }
    if (response.verdict && !contradictory(response.verdict)) return { verdict: response.verdict, errors }
    const why = `Judge ${rungLabel(rung)}: ${firstLine(response.error ?? 'no valid Verdict JSON')}.`
    errors.push(why)
    d.log(`${why.replace(/\.$/, '')} on stage ${spec.name} attempt ${a.n}.`)
  }
  return { verdict: null, errors }
}

function fail(d: Driver, a: Attempt, reason: string, extra?: Partial<Attempt>): Outcome {
  Object.assign(a, { ok: false, reason, endedAt: now(), ...extra })
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
const EXTRACT_FAILS = 3

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

/** How many of the latest attempts failed artifact extraction in a row with no verdict. */
export function consecutiveExtractFailures(attempts: Attempt[]): number {
  let n = 0
  for (let i = attempts.length - 1; i >= 0; i--) {
    const a = attempts[i]
    if (a.ok !== false || a.verdict || !a.extractError) break
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
  if (/The originating Paseo (?:agent|workspace) is unavailable|The originating Paseo agent has no workspace/i.test(error)) {
    return `${firstLine(error)} Open chat on this task to reattach it to a live chat, then retry.`
  }
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
