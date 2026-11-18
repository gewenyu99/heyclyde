/** Tier 2: the daemon runs the real pi as a worker, with the fake model and the clyde extension in worker mode. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startDaemon } from '../../src/daemon.ts'
import { Memory } from '../../src/memory.ts'
import { flushPending } from '../../src/memory-flush.ts'
import { startFakeMemory } from '../fakes/memory.ts'
import { HARNESS, setup, tempDir, waitFor } from '../helpers.ts'
import { assistantTexts, EXTENSION, installProvider, offlinePi, piCalls, piEnv, runJson, textOf, WORKER_TOOLS, writeScript } from './helpers.ts'

test('a pi worker reports with clyde_result and Threads.result returns it, with progress, recall and hooks on the way', async () => {
  const bin = tempDir('pi-bin')
  const s = setup([], { CLYDE_PI_BIN: offlinePi(bin) })
  installProvider(process.env.PI_CODING_AGENT_DIR as string)
  const memory = await startFakeMemory()
  Object.assign(process.env, { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
  const result = { status: 'done', summary: 'The readme is fixed.', evidence: [{ criterion: 'tests pass', evidence: 'npm test: 3 pass' }] }
  const script = writeScript(s.state, [
    { tool: 'clyde_progress', args: { line: 'reading the gate' } },
    { tool: 'clyde_recall', args: { query: 'readme gate' } },
    { tool: 'clyde_result', args: result },
    { text: 'Reported.' },
  ])
  process.env.CLYDE_FAKE_PI_SCRIPT = script.path
  const d = await startDaemon({ port: 0 })
  try {
    const t = d.ctx.threads.start({ title: 'worker', prompt: 'fix the readme', cwd: s.repo, rung: { backend: 'pi', model: 'fake/fake-1' }, runId: 'r1' })
    const done = await d.ctx.threads.waitIdle(t.id)
    assert.equal(done.status, 'idle', JSON.stringify(done.turns))
    assert.equal(done.turns[0].text, 'Reported.')
    assert.deepEqual(d.ctx.threads.result(t.id), result)
    const [argv] = piCalls(bin)
    assert.equal(argv[argv.indexOf('-e') + 1], EXTENSION, 'the backend loads the extension with -e')

    const progress = d.ctx.events.since(0).find((e) => e.type === 'thread.progress')
    assert.equal(progress?.summary, `Thread ${t.id}: reading the gate`)
    const recall = memory.calls.find((c) => c.path === '/recall')
    assert.deepEqual([recall?.role, (recall?.body as any)?.scope], ['agent', 'run:r1'], 'recall uses the agent token and the run scope')

    assert.deepEqual(script.seen()[0].tools.filter((x) => x.startsWith('clyde_')), WORKER_TOOLS, 'worker tools and no point man ones')

    // pi's session events reach memory under Claude Code's hook names, joined to the thread.
    await waitFor(() => memory.hooks.some((h) => h.event === 'SessionEnd'), 5000, 'the SessionEnd hook')
    const hooks = memory.hooks.filter((h) => h.event !== 'ClydeThread')
    for (const h of hooks) {
      assert.deepEqual([h.payload.session_id, h.payload.thread_id, h.payload.run_id, h.payload.hook_event_name], [t.id, t.id, 'r1', h.event])
    }
    const events = hooks.map((h) => h.event)
    for (const e of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'SessionEnd']) assert.ok(events.includes(e), `${e} in ${events.join(', ')}`)
    const posted = hooks.find((h) => h.event === 'PostToolUse' && h.payload.tool_name === 'clyde_result')
    assert.equal(posted?.payload.tool_response, `Reported done to clyde for thread ${t.id}.`)
    assert.ok(memory.hooks.some((h) => h.event === 'ClydeThread' && h.payload.session_id === t.id), 'the daemon tied the session to the thread')
  } finally {
    await d.close()
    await memory.close()
  }
})

test('with no daemon, clyde_result fails as a tool error and the worker still exits on its own', async () => {
  const s = setup([])
  const script = writeScript(s.state, [{ tool: 'clyde_result', args: { status: 'blocked', summary: 'No daemon.' } }, { text: 'Could not report.' }])
  const r = await runJson(['-p', 'report back'], {
    cwd: s.repo, env: piEnv({ CLYDE_THREAD_ID: 't-0rphan00', CLYDE_FAKE_PI_SCRIPT: script.path }), timeoutMs: 15_000,
  })
  assert.deepEqual([r.code, r.signal], [0, null], `pi exits by itself, so no handle leaked. ${r.stderr}`)
  const end = r.records.find((x) => x.type === 'tool_execution_end' && x.toolName === 'clyde_result')
  assert.equal(end?.isError, true)
  assert.equal(textOf(end.result.content), 'The clyde daemon is not running, so clyde has nowhere to send this.')
  assert.deepEqual(assistantTexts(r.records).at(-1), 'Could not report.')
})

test('installed in the agent dir as clyde install places it, the worker gets no -e and still has its tools', async () => {
  const bin = tempDir('pi-bin')
  const s = setup([], { CLYDE_PI_BIN: offlinePi(bin) })
  const agentDir = process.env.PI_CODING_AGENT_DIR as string
  installProvider(agentDir)
  mkdirSync(join(agentDir, 'extensions', 'clyde'), { recursive: true })
  writeFileSync(join(agentDir, 'extensions', 'clyde', 'index.ts'), `export { default } from ${JSON.stringify(EXTENSION)}\n`)
  const result = { status: 'blocked', summary: 'The gate needs a decision from Wen.' }
  process.env.CLYDE_FAKE_PI_SCRIPT = writeScript(s.state, [{ tool: 'clyde_result', args: result }, { text: 'Blocked.' }]).path
  const d = await startDaemon({ port: 0 })
  try {
    const t = d.ctx.threads.start({ title: 'installed', prompt: 'try the gate', cwd: s.repo, rung: { backend: 'pi', model: 'fake/fake-1' } })
    const done = await d.ctx.threads.waitIdle(t.id)
    assert.equal(done.status, 'idle', JSON.stringify(done.turns))
    assert.deepEqual(d.ctx.threads.result(t.id), result)
    assert.ok(!piCalls(bin)[0].includes('-e'), 'pi refuses the same extension twice, so no -e')
  } finally {
    await d.close()
  }
})

const REMEMBER_BUILT = existsSync(join(HARNESS, 'src', 'cli', 'remember.ts'))

test('clyde_remember writes a draft to memory through clyde remember, with the agent token and the blob', { skip: !REMEMBER_BUILT && 'clyde remember is not built yet' }, async () => {
  const s = setup([])
  const memory = await startFakeMemory()
  try {
    // The run's project, as the flow runtime writes it with the runtime token.
    const project = {
      id: 'run-r1', pattern: 'projects', title: 'r1', body: 'A test run.', authority: 'observed', scope: 'run:r1',
      evidence_kind: 'summary', evidence: 'The test made it.', source: { kind: 'run', title: 'clyde run r1' },
    }
    await new Memory(memory.url, memory.runtimeToken).remember(project)
    const note = { title: 'gate evidence', pattern: 'observations', body: 'The tests pass.', blob: 'ok 1 - hello\n# pass 1' }
    const script = writeScript(s.state, [{ tool: 'clyde_remember', args: note }, { text: 'Noted.' }])
    const env = { CLYDE_THREAD_ID: 't-1a2b3c4d', CLYDE_RUN_ID: 'r1', CLYDE_MEMORY_SCOPE: 'run:r1', MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, CLYDE_FAKE_PI_SCRIPT: script.path }
    const r = await runJson(['-p', 'note the evidence'], { cwd: s.repo, env: piEnv(env) })
    await flushPending({ url: memory.url, runtimeToken: memory.runtimeToken, agentToken: memory.token })
    const end = r.records.find((x) => x.type === 'tool_execution_end' && x.toolName === 'clyde_remember')
    assert.equal(end?.isError, false, textOf(end?.result?.content))
    const entry = [...memory.entries.values()].find((e) => e.title === 'gate evidence')
    assert.deepEqual([entry?.pattern, entry?.authority, entry?.scope, entry?.project], ['observations', 'draft', 'run:r1', 'run-r1'])
    assert.equal(memory.blobs.get(entry?.blobShas[0]?.sha256 as string)?.text, note.blob)
    assert.ok(memory.calls.filter((c) => c.path === '/entries').slice(1).every((c) => c.role === 'agent'), 'the worker writes with the agent token')
  } finally {
    await memory.close()
  }
})

test('a pi worker is held to its list: an edit waits for an item in progress, and it goes back to work while items are open', async () => {
  const bin = tempDir('pi-bin')
  const s = setup([], { CLYDE_PI_BIN: offlinePi(bin) })
  installProvider(process.env.PI_CODING_AGENT_DIR as string)
  const notes = join(s.repo, 'notes.txt')
  const early = join(s.repo, 'early.txt')
  const script = writeScript(s.state, [
    { tool: 'write', args: { path: early, content: 'too early\n' } },
    { tool: 'clyde_todo', args: { action: 'start', n: 1, how: 'write notes.txt with the write tool' } },
    { tool: 'write', args: { path: notes, content: 'planned\n' } },
    { text: 'Wrote it.' },
    // agent_before_settle sent it back here, since item 1 is still in progress and no result is posted.
    { tool: 'clyde_todo', args: { action: 'done', n: 1, evidence: 'notes.txt holds planned' } },
    { tool: 'clyde_result', args: { status: 'done', summary: 'Notes written.' } },
    { text: 'Reported.' },
  ])
  process.env.CLYDE_FAKE_PI_SCRIPT = script.path
  const d = await startDaemon({ port: 0 })
  try {
    const t = d.ctx.threads.start({ title: 'held', prompt: 'write the notes', cwd: s.repo, rung: { backend: 'pi', model: 'fake/fake-1' }, list: ['Write notes.txt'] })
    const done = await d.ctx.threads.waitIdle(t.id)
    assert.equal(done.status, 'idle', JSON.stringify(done.turns))
    assert.equal(done.turns.length, 1, 'pi went back to work inside the turn, so the daemon had nothing to nudge')
    assert.equal(done.turns[0].text, 'Reported.')
    assert.equal(readFileSync(notes, 'utf8'), 'planned\n')
    assert.deepEqual(d.ctx.threads.result(t.id), { status: 'done', summary: 'Notes written.' })
    const seen = script.seen()
    assert.ok(!existsSync(early), 'the tool_call handler blocked the write before an item was in progress')
    assert.match(seen[4].lastUser, /^Your work list has 1 open item and no result is posted\./, 'the settle hook sent it back with the list')
    assert.match(seen[0].lastUser, new RegExp(`^Work list, thread ${t.id}: 0 done, 0 doing, 1 todo\\n`), 'the prompt starts with the list')
    assert.deepEqual(d.ctx.threads.lists.get(`thread:${t.id}`).items.map((i) => i.status), ['done'])
  } finally {
    await d.close()
  }
})
