/** The ship flow: headless with --auto-approve to run.done, resume after a daemon restart, and replanning on an answer. */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../src/config.ts'
import type { Run } from '../src/flow/types.ts'
import type { Thread } from '../src/types.ts'
import { flowDaemon, flowSetup, clyde, matchGolden, runEvents, waitStatus } from './golden/flow.ts'
import { flushPending } from '../src/memory-flush.ts'
import { argvLog, TEST_ROLES, turnsTaken, waitFor } from './helpers.ts'

const INTENT = { intent: 'Greet the user with a file.' }

function threads(home: string): Thread[] {
  return readdirSync(join(home, 'threads')).map((f) => JSON.parse(readFileSync(join(home, 'threads', f), 'utf8')))
}

test('clyde flow run ship --auto-approve runs plan, approval, every stage and review to run.done', async () => {
  const s = await flowSetup('ship-auto')
  // A judge ladder with a second family, so the claude planner and reviewer get a judge from another family.
  writeFileSync(join(s.home, 'roles.json'), JSON.stringify({ ...TEST_ROLES, judge: [{ backend: 'claude', model: 'sonnet' }, { backend: 'pi', model: 'xai/grok-4.7' }] }))
  try {
    const r = await clyde(['flow', 'run', 'ship', '--input', JSON.stringify(INTENT), '--auto-approve', '--json'], s.repo)
    assert.equal(r.code, 0, r.stderr)
    const report = JSON.parse(r.stdout)
    assert.equal(report.status, 'done')
    assert.deepEqual(report.stages.map((x: any) => [x.name, x.passed, x.attempts]), [
      ['plan', true, 1], ['code-it-works:s1', true, 1], ['code-it-good:s1', true, 1], ['code-it-clean:s1', true, 1], ['review', true, 1],
    ])
    assert.equal(report.stages[1].verdict.criteria.length, 6)
    assert.deepEqual(report.events.map((e: any) => e.type), runEvents(s.home, report.run).map((e) => e.type))
    assert.match(r.stderr, /^run\.started {5}Started run r-[0-9a-f]{8} \(ship\)/)
    assert.match(r.stderr, /\nanswer {10}approved \(auto-approve\)\n/)
    matchGolden('ship-auto', runEvents(s.home, report.run))

    const run: Run = JSON.parse(readFileSync(join(s.home, 'runs', `${report.run}.json`), 'utf8'))
    assert.deepEqual(run.plan, { intent: 'Greet the user with a file.', slices: [{ id: 's1', title: 'Write greet.txt', acceptance: ['test -f greet.txt'] }] })
    assert.equal(run.stages[1].attempts[0].checks?.[0].cmd, 'test -f greet.txt', 'the slice acceptance runs as the check')
    assert.match(run.asks[1].question, /^Run r-[0-9a-f]{8} finished every stage\. The work is on branch clyde\/r-[0-9a-f]{8} .*, 3 commits since [0-9a-f]{12}\. Review: REVIEW: 0 findings, 0 fixed, 0 open\. Judge verdict: pass\./)

    // The planner and reviewer are claude, so a judge from another family grades them. The code stages are pi, so claude judges.
    const byStage = (name: string) => threads(s.home).filter((t) => t.stage === name)
    assert.deepEqual(byStage('plan').map((t) => [t.rung.backend, t.rung.model, t.readOnly ?? false]).sort(), [['claude', 'claude-sonnet-5-5', false], ['pi', 'xai/grok-4.7', true]])
    assert.deepEqual(byStage('code-it-good:s1').map((t) => [t.rung.backend, t.readOnly ?? false]).sort(), [['claude', true], ['pi', false]])
    const planJudge = argvLog(s.state).find((c) => c.bin === 'pi' && c.argv.includes('xai/grok-4.7'))?.argv ?? []
    assert.equal(planJudge[planJudge.indexOf('--tools') + 1], 'read,grep,find,ls')
    const worker = threads(s.home).find((t) => t.stage === 'code-it-works:s1' && !t.readOnly) as Thread
    assert.ok(worker.turns[0].prompt.includes(`Read ${join(repoRoot(), 'skills', 'code-it-works', 'SKILL.md')} first and follow it. CLAUDE_PLUGIN_ROOT is ${repoRoot()}`))
    assert.match(worker.turns[0].prompt, /1\. Red then green\. The end condition failed for the expected reason, then passed\./)

    // memory holds the project, the plan, five verdicts and two answers, every one in the run's scope and project.
    const entries = run.entries.map((id) => s.memory.entries.get(id) as any)
    const kinds = entries.map((e) => [e.pattern, e.authority, e.evidence_kind])
    assert.deepEqual(kinds, [
      ['projects', 'observed', 'summary'], ['observations', 'observed', 'assistant'], ['decisions', 'approved', 'assistant'],
      ['decisions', 'approved', 'quote'], ['observations', 'observed', 'assistant'], ['observations', 'observed', 'assistant'],
      ['observations', 'observed', 'assistant'], ['observations', 'observed', 'assistant'], ['decisions', 'approved', 'quote'],
    ])
    for (const e of entries) {
      assert.equal(e.scope, `run:${run.id}`)
      assert.equal(e.project ?? e.id, `run-${run.id}`)
      assert.deepEqual(e.source, { kind: 'run', title: `clyde run ${run.id}`, uri: `clyde://runs/${run.id}` })
    }
    const plan = entries[2]
    assert.deepEqual(JSON.parse(s.memory.blobs.get(plan.blobShas[0].sha256)?.text ?? ''), run.plan)
    assert.deepEqual([entries[3].evidence, entries[8].evidence], ['approved', 'approved'])
    assert.ok(s.memory.calls.filter((c) => c.path === '/entries').every((c) => c.role === 'runtime' && c.status === 200))
  } finally {
    await s.memory.close()
  }
})

test('a ship run resumes from its last passed stage after a daemon restart', async () => {
  const s = await flowSetup('ship-resume')
  let { d, client } = await flowDaemon()
  let id = ''
  try {
    id = (await client.call('POST', '/runs', { flow: 'ship', input: INTENT, cwd: s.repo })).id
    await waitStatus(client, id, ['asking'])
    await client.answer(id, 'approved')
    // plan worker and judge, code-it-works worker and judge, then the code-it-good worker hangs.
    await waitFor(() => turnsTaken(s.state) >= 5, 20_000, 'the code-it-good worker to hang')
    await d.close()
    const saved: Run = JSON.parse(readFileSync(join(s.home, 'runs', `${id}.json`), 'utf8'))
    assert.equal(saved.status, 'running')
    assert.deepEqual(saved.stages.map((x) => [x.name, x.status]), [['plan', 'passed'], ['code-it-works:s1', 'passed'], ['code-it-good:s1', 'running']])

    ;({ d, client } = await flowDaemon())
    const last = await waitStatus(client, id, ['asking', 'failed'])
    assert.match(last.question ?? '', /finished every stage/, 'the approval comes back from the record, so the next ask is the last one')
    await client.answer(id, 'approved')
    const run = await waitStatus(client, id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.deepEqual(run.stages.map((x) => [x.name, x.attempts.length]), [['plan', 1], ['code-it-works:s1', 1], ['code-it-good:s1', 2], ['code-it-clean:s1', 1], ['review', 1]])
    assert.equal(run.stages[2].attempts[0].reason, 'Lost when the daemon stopped.')
    assert.equal(run.stages[2].round, 2)
    assert.equal(threads(s.home).filter((t) => t.stage === 'plan').length, 2, 'the plan ran once, worker and judge')
    assert.deepEqual(run.asks.map((a) => a.key), ['ask:1', 'ask:2'])
    matchGolden('ship-resume', runEvents(s.home, id))
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('an answer that isn\'t approval replans with it as notes, and the new plan supersedes the old in memory', async () => {
  const s = await flowSetup('ship-replan')
  const { d, client } = await flowDaemon()
  try {
    const id: string = (await client.call('POST', '/runs', { flow: 'ship', input: INTENT, cwd: s.repo })).id
    const first = await waitStatus(client, id, ['asking'])
    assert.match(first.question ?? '', new RegExp(`^Approve the plan for run ${id}\\? Greet the user with a file\\.\\n\\n- s1: Write greet\\.txt \\(\`test -f greet\\.txt\`\\)\\n\\nThe full plan is memory entry ${first.planEntry}\\. Read it with clyde plan show --run ${id}\\.`))
    await client.answer(id, 'Add a goodbye slice too.')
    const second = await waitStatus(client, id, ['asking'])
    assert.match(second.question ?? '', /Greet and say goodbye\.\n\n- s1: Write greet\.txt .*\n- s2: Write bye\.txt/)
    const planner = threads(s.home).find((t) => t.stage === 'plan-2' && !t.readOnly) as Thread
    assert.match(planner.turns[0].prompt, /The user didn't approve the last plan\. Their answer:\n\nAdd a goodbye slice too\.\n\nReplan with it\./)
    await client.answer(id, 'approved')
    await waitFor(() => turnsTaken(s.state) >= 5, 20_000, 'the first code stage to start')
    assert.equal((await client.stopRun(id)).status, 'stopped')
    await flushPending({ url: s.memory.url, runtimeToken: s.memory.runtimeToken, agentToken: s.memory.token })

    const run: Run = await client.run(id)
    assert.equal(run.plans.length, 2)
    const [old, current] = run.plans.map((p) => s.memory.entries.get(p.entry) as any)
    assert.deepEqual([old.authority, current.authority, current.supersedes], ['approved', 'approved', [old.id]])
    assert.deepEqual(await client.call('GET', `/runs/${id}/plan`), { plan: run.plan, entry: current.id })
    const answers = run.asks.map((a) => s.memory.entries.get(a.entry as string) as any)
    assert.deepEqual(answers.map((a) => [a.authority, a.evidence_kind, a.evidence]), [['approved', 'quote', 'Add a goodbye slice too.'], ['approved', 'quote', 'approved']])

    // clyde plan set goes through this route, since only the daemon holds the runtime token.
    const edited = { intent: 'Greet only.', slices: [{ id: 's1', title: 'Write greet.txt', acceptance: [] }] }
    const set = await client.call('POST', `/runs/${id}/plan`, { plan: edited })
    await flushPending({ url: s.memory.url, runtimeToken: s.memory.runtimeToken, agentToken: s.memory.token })
    assert.deepEqual(s.memory.entries.get(set.entry)?.supersedes, [current.id])
    assert.deepEqual((await client.call('GET', `/runs/${id}/plan`)).plan, edited)
    const bad = await client.call('POST', `/runs/${id}/plan`, { plan: { intent: 'x', slices: [] } }).catch((e) => e.status)
    assert.equal(bad, 400)
  } finally {
    await d.close()
    await s.memory.close()
  }
})
