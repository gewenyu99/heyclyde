import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extractPlan, run as ship } from '../flows/ship.ts'
import { PLAN_CRITERIA, PLAN_RESULT_BLOCK, planPrompt, workerPrompt } from '../src/flow/prompts.ts'
import { runStage } from '../src/flow/stage.ts'
import type { Driver } from '../src/flow/runtime.ts'
import type { Run, StageSpec } from '../src/flow/types.ts'
import type { Thread } from '../src/types.ts'
import { git, makeRepo, tempDir } from './helpers.ts'

const plan = { intent: 'Build a small change.', slices: [{ id: 's1', title: 'Make it', acceptance: ['test -f output'] }] }
const run = { id: 'r-test', cwd: '/tmp/repo', branch: 'clyde/r-test' } as Run

test('plan worker returns one reviewable artifact without a second shell reporting protocol', () => {
  const prompt = workerPrompt({ run, spec: { name: 'plan', prompt: planPrompt(plan.intent), criteria: PLAN_CRITERIA, extract: extractPlan, resultTemplate: PLAN_RESULT_BLOCK }, attempt: 1, root: '/repo', bin: '/repo/clyde' })
  assert.match(prompt, /after the user approves it/)
  assert.doesNotMatch(prompt, /clyde todo|clyde result --status|Commit locally/)
  assert.equal(prompt.split(PLAN_RESULT_BLOCK).length, 2)
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

const parentFailure = 'The originating Paseo agent is unavailable'
const followup = 'Also cover the disabled workspace case.'
const fourSlices = { intent: 'Support project and workspace policy.', slices: Array.from({ length: 4 }, (_, n) => ({ id: `s${n + 1}`, title: `Policy part ${n + 1}`, acceptance: [`node --test part-${n + 1}.test.ts`] })) }
const output = (value = fourSlices) => '```json\n' + JSON.stringify({ status: 'done', summary: 'PRIVATE worker summary', evidence: [], plan: value }) + '\n```'

function recoveryFixture(t: TestContext, options: { legacy?: boolean; rejectFirst?: boolean; changeThread?: (thread: Thread) => void } = {}) {
  const oldHome = process.env.CLYDE_HOME, oldMax = process.env.CLYDE_MAX_STAGE_ATTEMPTS
  const home = tempDir('saved-plan'), repo = makeRepo()
  process.env.CLYDE_HOME = home
  process.env.CLYDE_MAX_STAGE_ATTEMPTS = '5'
  t.after(() => {
    if (oldHome === undefined) delete process.env.CLYDE_HOME; else process.env.CLYDE_HOME = oldHome
    if (oldMax === undefined) delete process.env.CLYDE_MAX_STAGE_ATTEMPTS; else process.env.CLYDE_MAX_STAGE_ATTEMPTS = oldMax
  })
  writeFileSync(join(home, 'roles.json'), JSON.stringify({ planner: [{ backend: 'codex', model: 'planner' }], judge: [{ backend: 'claude', model: 'judge' }] }))
  const base = git(repo, 'rev-parse', 'HEAD'), at = '2026-11-19T20:00:00Z'
  const savedRun = { id: 'r-recover', flow: 'ship', title: 'Recover plan', status: 'running', cwd: repo, repo, branch: 'main', base, input: { intent: fourSlices.intent }, stages: [], asks: [], answers: [], entries: [], log: [], plans: [], createdAt: at, updatedAt: at } as unknown as Run
  const source: Thread = {
    id: 'saved-worker', title: 'Saved planner', rung: { backend: 'codex', model: 'planner' }, cwd: repo, runId: savedRun.id, stage: 'plan',
    paseoAgentId: 'managed-planner', paseoParentId: 'archived-parent', status: 'failed', queue: [], createdAt: at, updatedAt: at,
    turns: [
      { n: 1, prompt: 'Plan the policy.', startedAt: at, endedAt: at, ok: true, text: output() },
      { n: 2, prompt: followup, startedAt: at, endedAt: at, ok: false, text: '', error: parentFailure },
    ],
  }
  options.changeThread?.(source)
  const originalFailure = { n: 1, round: 1, rung: source.rung, threadId: source.id, startedAt: at, endedAt: at, ok: false, reason: 'The worker failed: ' + parentFailure, providerError: parentFailure }
  if (options.legacy) {
    savedRun.status = 'asking'
    savedRun.stages = JSON.parse(JSON.stringify([{ name: 'plan', role: 'planner', status: 'asking', base, round: 1, startedAt: at, attempts: [originalFailure] }]))
  }
  const threads = new Map([[source.id, structuredClone(source)]]), started: Parameters<Driver['startThread']>[0][] = []
  const events: { type: string; data: unknown }[] = []
  let judges = 0, workers = 0, answer: (value: string) => void = () => {}, askCount = 0
  const driver = {
    run: savedRun,
    threads: { get: (id: string) => threads.get(id), result: () => undefined },
    race: <T>(promise: Promise<T>) => promise, save: () => {}, log: () => {}, remember: async () => 'verdict-memory',
    emit: (type: string, _text: string, data: unknown) => events.push({ type, data }),
    stopped: (why: string) => new Error(why), route: async () => source.rung,
    ask: () => { askCount++; return new Promise<string>(resolve => { answer = resolve }) },
    check: async () => ({ code: 0, output: 'passed' }),
    startThread: (opts: Parameters<Driver['startThread']>[0]) => {
      started.push(opts)
      if (!opts.readOnly && ++workers === 1 && !options.legacy) return threads.get(source.id)!
      const id = opts.readOnly ? `judge-${++judges}` : `new-planner-${workers}`
      const pass = !(options.rejectFirst && judges === 1)
      const count = (opts.prompt.match(/^\d+\. /gm) ?? []).length
      const json = { verdict: pass ? 'pass' : 'fail', criteria: Array.from({ length: count }, (_, n) => ({ criterion: `gate ${n + 1}`, pass, evidence: 'Read the artifact.' })), notes: pass ? 'Plan checked.' : 'Add the disabled workspace case.' }
      const record: Thread = { ...source, id, status: 'idle', readOnly: opts.readOnly, rung: opts.rung, turns: [{ n: 1, prompt: opts.prompt, startedAt: at, endedAt: at, ok: true, ...(opts.readOnly ? { json } : { text: output() }) }] }
      threads.set(id, record)
      return record
    },
    waitThread: async (id: string) => threads.get(id)!,
  } as unknown as Driver
  const spec: StageSpec = { name: 'plan', role: 'planner', prompt: 'Plan policy.', criteria: ['The plan covers the intent.'], extract: extractPlan }
  return { driver, spec, started, events, originalFailure, source, answer: (value: string) => answer(value), asks: () => askCount }
}

test('a completed managed plan survives an unsent follow-up and is independently judged', async t => {
  const f = recoveryFixture(t)
  const result = await runStage(f.driver, f.spec)
  assert.deepEqual(result.artifact, fourSlices)
  assert.equal(f.started[0].list, undefined, 'planning artifact is the report, without forced CLI todo items')
  assert.equal(f.started.filter(x => !x.readOnly).length, 1, 'never reruns the expensive planner')
  const judge = f.started.find(x => x.readOnly)!
  assert.equal(judge.rung.backend, 'claude', 'judge is from another family')
  assert.match(judge.prompt, /could not be delivered to the planner: Also cover the disabled workspace case/)
  assert.match(judge.prompt, /Policy part 4/)
  assert.doesNotMatch(judge.prompt, /PRIVATE worker summary/)
  const attempts = f.driver.run.stages[0].attempts
  assert.equal(attempts.length, 2)
  assert.equal(attempts[0].ok, false)
  assert.equal(attempts[0].reason, 'The worker failed: ' + parentFailure)
  assert.equal(attempts[1].ok, true)
  assert.equal(attempts[1].threadId, attempts[0].threadId)
  assert.deepEqual(f.source.turns.map(x => x.ok), [true, false], 'original turn history remains intact')
})

test('a legacy paused plan replays from saved records only after an explicit retry', async t => {
  const f = recoveryFixture(t, { legacy: true })
  const pending = runStage(f.driver, f.spec)
  assert.equal(f.asks(), 1)
  assert.equal(f.started.length, 0, 'does not grade or rerun while waiting for the retry decision')
  f.answer('retry')
  const result = await pending
  assert.deepEqual(result.artifact, fourSlices)
  assert.equal(f.started.filter(x => !x.readOnly).length, 0)
  assert.deepEqual(f.driver.run.stages[0].attempts[0], f.originalFailure)
  assert.equal(f.driver.run.stages[0].attempts[1].ok, true)
})

test('a rejected recovered plan carries undelivered requirements into replanning and its next judge', async t => {
  const f = recoveryFixture(t, { rejectFirst: true })
  const result = await runStage(f.driver, f.spec)
  assert.equal(result.passed, true)
  const replanner = f.started.filter(x => !x.readOnly)[1]
  assert.match(replanner.prompt, /could not be delivered to the planner: Also cover the disabled workspace case/)
  assert.match(replanner.prompt, /Add the disabled workspace case/)
  const judges = f.started.filter(x => x.readOnly)
  assert.equal(judges.length, 2)
  assert.match(judges[1].prompt, /could not be delivered to the planner: Also cover the disabled workspace case/)
  assert.deepEqual(f.driver.run.stages[0].attempts.map(a => a.ok), [false, false, true])
})

test('recovered plans still go through spec review and user approval in the ship flow', async t => {
  const f = recoveryFixture(t)
  f.driver.run.routes = { planner: { model: 'sol', pinned: true, reason: 'test' } }
  const sequence: string[] = []
  await assert.rejects(ship({
    run: f.driver.run, stage: spec => runStage(f.driver, spec),
    agent: async opts => { assert.equal(opts.route, 'specReview'); sequence.push('spec review'); return { ok: true, text: '{"findings":[]}', json: { findings: [] } } },
    setPlan: async value => { assert.deepEqual(value, fourSlices); sequence.push('save plan'); return 'plan-memory' },
    ask: async question => { assert.match(question, /^Approve the plan/); sequence.push('approval'); throw new Error('waiting for approval') },
  } as Parameters<typeof ship>[0], { intent: fourSlices.intent }), /waiting for approval/)
  assert.deepEqual(sequence, ['spec review', 'save plan', 'approval'])
})

test('nonmatching launch errors, delivered work, invalid artifacts and unrelated threads never recover', async t => {
  const changes: ((thread: Thread) => void)[] = [
    thread => { thread.turns[1].error = 'Permission denied' },
    thread => { thread.turns[1].error = 'The originating Paseo workspace is unavailable' },
    thread => { thread.turns[1].text = 'I changed the plan.' },
    thread => { thread.turns[1].json = {} },
    thread => { thread.turns[0].text = '```json\n{"status":"done","summary":"missing artifact","evidence":[]}\n```' },
    thread => { thread.turns[0].ok = false },
    thread => { delete thread.turns[0].endedAt },
    thread => { delete thread.paseoAgentId },
    thread => { thread.stage = 'other' },
    thread => { thread.runId = 'other' },
  ]
  for (const changeThread of changes) {
    const f = recoveryFixture(t, { changeThread })
    f.driver.ask = async () => 'retry'
    const result = await runStage(f.driver, f.spec)
    assert.equal(result.passed, true)
    assert.equal(f.started.filter(x => !x.readOnly).length, 2, 'invalid recovery starts a fresh planner')
    assert.equal(f.driver.run.stages[0].attempts.length, 2)
    assert.notEqual(f.driver.run.stages[0].attempts[1].threadId, f.source.id)
  }
})
