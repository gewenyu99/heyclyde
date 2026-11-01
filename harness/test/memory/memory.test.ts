/** Tier 3: the harness against the real memory server server on Postgres. Runtime writes, the agent tools, the token split, and a task run's handoff. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { DaemonClient } from '../../src/client.ts'
import { startDaemon } from '../../src/daemon.ts'
import { workListEntry } from '../../src/flow/memory.ts'
import type { Run } from '../../src/flow/types.ts'
import { Memory } from '../../src/memory.ts'
import { formatList, type WorkList } from '../../src/lists.ts'
import { FAKE_BIN, HARNESS, LV, setup, tempDir, waitFor } from '../helpers.ts'
import { SKIP, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory
const SEED = ['tea-oolong-temp', 'tea-oolong-old', 'tea-draft-cold', 'tea-supplier', 'tea-zh', 'proj-tea']

before(async () => {
  if (!SKIP) memory = await startRealMemory()
})

after(async () => {
  await memory?.close()
})

type Ran = { code: number | null; stdout: string; stderr: string }

function clyde(args: string[], extra: Record<string, string>): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function project(run: string): Record<string, unknown> {
  return {
    id: `run-${run}`, pattern: 'projects', title: `Run ${run}`, body: `The clyde test run ${run}.`, authority: 'observed', scope: `run:${run}`,
    evidence_kind: 'summary', evidence: 'The memory tier made it.', source: { kind: 'run', title: `clyde run ${run}`, uri: `clyde://runs/${run}` },
  }
}

/** True when id shows up in the packet before every seeded entry it holds. */
function leads(packet: string, id: string): boolean {
  const at = packet.indexOf(id)
  const seeds = SEED.map((s) => packet.indexOf(s)).filter((i) => i >= 0)
  return at >= 0 && seeds.every((i) => at < i)
}

test('the Memory class writes as the runtime: a project, an approved entry with a blob, and a safe resend', { skip: SKIP }, async () => {
  const rt = new Memory(memory.url, memory.runtimeToken)
  assert.equal((await rt.remember(project('k1'))).id, 'run-k1')
  const plan = {
    pattern: 'decisions', title: 'Plan: brew oolong at 90C', body: 'The plan for run k1. Brew oolong at 90C.', authority: 'approved',
    scope: 'run:k1', evidence_kind: 'assistant', evidence: 'The planner said so.', project: 'run-k1',
    source: { kind: 'run', title: 'clyde run k1', uri: 'clyde://runs/k1' }, blobs: [{ name: 'plan.json', media_type: 'application/json', text: '{"slices":[]}' }],
  }
  const first = await rt.remember(plan)
  const again = await rt.remember(plan)
  assert.equal(again.id, first.id, 'the same payload lands on the same entry')
  assert.equal(first.blobs[0].name, 'plan.json')
  const text = await rt.entry(first.id)
  assert.match(text ?? '', /approved/)
  assert.match(text ?? '', new RegExp(first.blobs[0].sha256))
  assert.equal(await rt.blob(first.blobs[0].sha256), '{"slices":[]}')
  assert.equal(await rt.entry('no-such-entry'), null)
  await rt.hook('SessionStart', { session_id: 'clyde-memory-test', run_id: 'k1' })
})

test('the agent token writes only drafts in a run scope, with no id or source, and a bad token gets nothing', { skip: SKIP }, async () => {
  await new Memory(memory.url, memory.runtimeToken).remember(project('k2'))
  const agent = new Memory(memory.url, memory.token)
  const note = { pattern: 'observations', title: 'A note', body: 'A body.', scope: 'run:k2', evidence_kind: 'assistant', evidence: 'ok', project: 'run-k2' }
  await assert.rejects(agent.remember({ ...note, authority: 'observed' }), /memory refused the entry \(400\): .*authority observed is above draft/)
  await assert.rejects(agent.remember({ ...note, authority: 'approved' }), /above draft/)
  await assert.rejects(agent.remember({ ...note, authority: 'draft', scope: 'global' }), /only in a run scope/)
  await assert.rejects(agent.remember({ ...note, authority: 'draft', id: 'mine' }), /\(400\)/)
  await assert.rejects(agent.remember({ ...note, authority: 'draft', source: { kind: 'run', title: 'x' } }), /\(400\)/)
  await assert.rejects(new Memory(memory.url, 'not-a-token').remember({ ...note, authority: 'draft' }), /\(401\)/)
  assert.match((await agent.remember({ ...note, authority: 'draft' })).id, /^run-k2-a-note-/)
})

test('clyde remember and clyde recall as an agent: a draft in the run that only a scoped recall serves, first', { skip: SKIP }, async () => {
  setup([])
  await new Memory(memory.url, memory.runtimeToken).remember(project('k3'))
  const env = { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, CLYDE_RUN_ID: 'k3', CLYDE_MEMORY_SCOPE: 'run:k3' }
  const file = join(tempDir('memory-blob'), 'evidence.txt')
  writeFileSync(file, 'oolong check: 90C held for 3 minutes\n')
  const r = await clyde(['remember', '--title', 'Oolong gate evidence', '--pattern', 'observations', '--body', 'The oolong temperature check passed.', '--blob-file', file], env)
  assert.equal(r.code, 0, r.stderr)
  const id = /^Remembered (\S+) as a draft in run:k3\.$/m.exec(r.stdout)?.[1] as string
  assert.ok(id, r.stdout)
  const text = await new Memory(memory.url, memory.token).entry(id)
  assert.match(text ?? '', /draft/)
  assert.match(text ?? '', /evidence\.txt/)
  const scoped = await clyde(['recall', 'oolong temperature'], env)
  assert.equal(scoped.code, 0, scoped.stderr)
  assert.ok(leads(scoped.stdout, id), `the run's note leads a scoped recall:\n${scoped.stdout}`)
  const unscoped = await clyde(['recall', 'oolong temperature'], { ...env, CLYDE_MEMORY_SCOPE: '' })
  assert.ok(!unscoped.stdout.includes(id), `an unscoped recall leaves run entries out:\n${unscoped.stdout}`)
  const other = await clyde(['recall', 'oolong temperature', '--scope', 'run:k9'], env)
  assert.ok(!other.stdout.includes(id), 'another run never sees it')
  const refused = await clyde(['remember', '--title', 'x', '--pattern', 'observations', '--scope', 'run:no-project'], env)
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /memory refused the entry \(400\)/)
})

test('a task run with fake backends hands off through the real memory server, and a scoped recall serves its entries first', { skip: SKIP }, async () => {
  const sc = JSON.parse(readFileSync(join(HARNESS, 'test', 'scenarios', 'task-clyde-result.json'), 'utf8'))
  const s = setup(sc.turns, { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
  // pi as the worker, which first records its gate evidence with clyde remember, as the stage prompt tells it to.
  const pi = join(s.state, 'pi')
  writeFileSync(pi, [
    '#!/bin/sh',
    'for last; do :; done',
    'case "$last" in *"worker for stage"*)',
    '  printf "test -f hello.txt: exit 0\\noolong check passed\\n" > "$CLYDE_FAKE_STATE_DIR/evidence.txt"',
    `  ${JSON.stringify(process.execPath)} ${JSON.stringify(LV)} remember --title "Oolong gate evidence" --pattern observations --body "hello.txt holds hello and the oolong check passed." --blob-file "$CLYDE_FAKE_STATE_DIR/evidence.txt" >> "$CLYDE_FAKE_STATE_DIR/remember.log" 2>&1;;`,
    'esac',
    `exec ${JSON.stringify(join(FAKE_BIN, 'pi'))} "$@"`, '',
  ].join('\n'))
  chmodSync(pi, 0o755)
  process.env.CLYDE_PI_BIN = pi
  const d = await startDaemon({ port: 0 })
  const client = new DaemonClient({ pid: process.pid, port: d.port, token: d.token })
  try {
    const task = { prompt: 'Write hello.txt holding hello.', criteria: ['A hello file. hello.txt holds hello.'], checks: ['test -f hello.txt'] }
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input: task, cwd: s.repo })
    const run: Run = await waitFor(async () => {
      const r: Run = await client.run(started.id)
      return ['done', 'failed', 'stopped'].includes(r.status) ? r : null
    }, 30_000, 'the run to finish')
    assert.equal(run.status, 'done', JSON.stringify(run.stages))
    const log = readFileSync(join(s.state, 'remember.log'), 'utf8')
    const note = /^Remembered (\S+) as a draft in run:(\S+)\.$/m.exec(log)
    assert.ok(note, log)
    assert.equal(note[2], run.id)
    const rt = new Memory(memory.url, memory.runtimeToken)
    assert.match(await rt.entry(`run-${run.id}`) ?? '', /observed/, 'the run project is in memory')
    const verdict = run.stages[0].entry as string
    assert.deepEqual(run.entries, [`run-${run.id}`, verdict])
    assert.match(await rt.entry(verdict) ?? '', /observed/)
    assert.match(await rt.entry(note[1]) ?? '', /draft/)
    const env = { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, CLYDE_MEMORY_SCOPE: `run:${run.id}` }
    const recalled = await clyde(['recall', 'oolong gate evidence'], env)
    assert.ok(leads(recalled.stdout, note[1]), `the worker's note leads:\n${recalled.stdout}`)
    const verdicts = await clyde(['recall', 'verdict stage task passed'], env)
    assert.ok(leads(verdicts.stdout, verdict), `the verdict leads:\n${verdicts.stdout}`)
    // The worker's work list went to memory at the end of its turn, as a draft in the run.
    const handoff = join(s.home, 'lists', 'handoff', `${run.id}.json`)
    const list = await waitFor(() => { try { return JSON.parse(readFileSync(handoff, 'utf8')).task } catch { return null } }, 5000, 'the work list handoff')
    assert.match(await rt.entry(list.entry) ?? '', /: Work list, task\npattern observations · draft · run:[\s\S]*\[x\] 1 A hello file\./)
  } finally {
    await d.close()
  }
})

test('a work list version supersedes the last one in the real memory server, which recall and get_entry both show', { skip: SKIP }, async () => {
  const rt = new Memory(memory.url, memory.runtimeToken)
  await rt.remember(project('k3'))
  const at = new Date().toISOString()
  const v1: WorkList = { owner: 'thread:t-k3', items: [{ id: 1, text: 'Brew the oolong', status: 'doing', how: 'at 90C', updatedAt: at }] }
  const v2: WorkList = { owner: 'thread:t-k3', items: [{ id: 1, text: 'Brew the oolong', status: 'done', evidence: 'thermometer read 90C', updatedAt: at }] }
  const first = await rt.remember(workListEntry('k3', 'brew', 't-k3', v1, formatList(v1)))
  const second = await rt.remember(workListEntry('k3', 'brew', 't-k3', v2, formatList(v2), first.id))
  assert.notEqual(first.id, second.id)
  assert.match(await rt.entry(second.id) ?? '', /\npattern observations · draft · run:k3 /)
  const recalled = await clyde(['recall', 'work list brew oolong'], { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, CLYDE_MEMORY_SCOPE: 'run:k3' })
  assert.equal(recalled.code, 0, recalled.stderr)
  assert.ok(recalled.stdout.includes(second.id), recalled.stdout)
  // memory shows a superseded entry only struck through, pointing at the version that replaced it.
  const old = recalled.stdout.split('\n').find((l) => l.includes(first.id))
  if (old) assert.ok(old.includes(`~~Work list, brew~~ → ${second.id}`), `the old version points at the new one:\n${recalled.stdout}`)
  assert.match(await rt.entry(first.id) ?? '', new RegExp(second.id), 'the old entry names its replacement')
})
