/** The agent tools over the real CLI: recall and remember against the fake memory server, progress, result, hook and plan against a test daemon. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { DaemonClient } from '../src/client.ts'
import { startDaemon, type Daemon } from '../src/daemon.ts'
import { Memory } from '../src/memory.ts'
import { flushPending } from '../src/memory-flush.ts'
import type { FakeMemory } from './fakes/memory.ts'
import { startFakeMemory } from './fakes/memory.ts'
import { LV, setup, tempDir, waitFor } from './helpers.ts'

type Ran = { code: number | null; stdout: string; stderr: string; ms: number }

/** The real clyde in a child, with this process's env plus extra. An undefined value removes a name. */
function clyde(args: string[], extra: Record<string, string | undefined> = {}, input?: string): Promise<Ran> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { env: env as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', async (code) => {
      await flushPending({ url: env.MEMORY_URL, agentToken: env.MEMORY_TOKEN, runtimeToken: env.MEMORY_RUNTIME_TOKEN })
      resolve({ code, stdout, stderr, ms: Date.now() - started })
    })
    child.stdin.end(input ?? '')
  })
}

const PROJECT = {
  id: 'run-r1', pattern: 'projects', title: 'Run r1', body: 'A test run.', authority: 'observed', scope: 'run:r1',
  evidence_kind: 'summary', evidence: 'The test made it.', source: { kind: 'run', title: 'clyde run r1' },
}

/** A fake memory with run r1's project, and the env a worker in r1 would have. */
async function memoryRun(): Promise<{ memory: FakeMemory; env: Record<string, string> }> {
  setup([])
  const memory = await startFakeMemory()
  await new Memory(memory.url, memory.runtimeToken).remember(PROJECT)
  return { memory, env: { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, CLYDE_RUN_ID: 'r1', CLYDE_MEMORY_SCOPE: 'run:r1' } }
}

test('clyde remember writes a draft with the agent token, no id or source, and the blob', async () => {
  const { memory, env } = await memoryRun()
  try {
    const file = join(tempDir('blob'), 'evidence.md')
    writeFileSync(file, '# pass 3\nok 1 - login\n')
    const r = await clyde(['remember', '--title', 'Gate evidence for login', '--pattern', 'observations', '--body', 'The login tests pass.', '--blob-file', file], env)
    assert.equal(r.code, 0, r.stderr)
    const call = memory.calls.filter((c) => c.path === '/entries').at(-1)!
    assert.equal(call.role, 'agent')
    const body = call.body as Record<string, any>
    assert.deepEqual(
      [body.pattern, body.authority, body.scope, body.project, body.evidence_kind, 'id' in body, 'source' in body],
      ['observations', 'draft', 'run:r1', 'run-r1', 'assistant', false, false],
    )
    assert.deepEqual(body.blobs, [{ name: 'evidence.md', media_type: 'text/markdown', text: '# pass 3\nok 1 - login\n' }])
    const entry = [...memory.entries.values()].find((e) => e.title === 'Gate evidence for login')!
    assert.equal(r.stdout, `Remembered ${entry.id} as a draft in run:r1.\nBlob evidence.md: ${entry.blobShas[0].sha256}\n`)
  } finally {
    await memory.close()
  }
})

test('clyde remember takes --scope and --blob-name, sends binary blobs as base64, and refuses a non-run scope', async () => {
  const { memory, env } = await memoryRun()
  try {
    const file = join(tempDir('blob'), 'shot.bin')
    writeFileSync(file, Buffer.from([0, 255, 1, 2]))
    const r = await clyde(['remember', '--title=-starts with a dash', '--pattern=decisions', '--blob-file', file, '--blob-name', 'screen.png', '--scope', 'run:r1'], { ...env, CLYDE_MEMORY_SCOPE: undefined })
    assert.equal(r.code, 0, r.stderr)
    const body = memory.calls.filter((c) => c.path === '/entries').at(-1)!.body as Record<string, any>
    assert.equal(body.title, '-starts with a dash')
    assert.deepEqual(body.blobs, [{ name: 'screen.png', media_type: 'application/octet-stream', base64: 'AP8BAg==' }])
    const calls = memory.calls.length
    const global = await clyde(['remember', '--title', 'x', '--pattern', 'observations', '--scope', 'global'], env)
    assert.equal(global.code, 2)
    assert.match(global.stderr, /only in a run scope/)
    const none = await clyde(['remember', '--title', 'x', '--pattern', 'observations'], { ...env, CLYDE_MEMORY_SCOPE: undefined, CLYDE_RUN_ID: undefined })
    assert.equal(none.code, 2)
    const pattern = await clyde(['remember', '--title', 'x', '--pattern', 'thoughts'], env)
    assert.equal(pattern.code, 2)
    assert.equal(memory.calls.length, calls, 'no refused call reached memory')
  } finally {
    await memory.close()
  }
})

test('clyde remember --supersedes replaces an earlier section, so recall serves only the latest', async () => {
  const { memory, env } = await memoryRun()
  try {
    const first = await clyde(['remember', '--title', 'Shape', '--pattern', 'observations', '--body', 'First shape.'], env)
    assert.equal(first.code, 0, first.stderr)
    const oldId = /Remembered (\S+) /.exec(first.stdout)![1]
    const second = await clyde(['remember', '--title', 'Shape', '--pattern', 'observations', '--body', 'Second shape.', '--supersedes', oldId], env)
    assert.equal(second.code, 0, second.stderr)
    const body = memory.calls.filter((c) => c.path === '/entries').at(-1)!.body as Record<string, any>
    assert.deepEqual(body.supersedes, [oldId])
    const recall = await clyde(['recall', 'shape'], env)
    assert.equal(recall.code, 0, recall.stderr)
    assert.match(recall.stdout, /Second shape/)
    assert.doesNotMatch(recall.stdout, /First shape/)
  } finally {
    await memory.close()
  }
})

test('clyde remember queues entries while the server address is missing', async () => {
  const { memory, env } = await memoryRun()
  try {
    const off = await clyde(['remember', '--title', 'x', '--pattern', 'observations'], { ...env, MEMORY_URL: undefined })
    assert.equal(off.code, 0, off.stderr)
    assert.match(off.stdout, /Remembered .+ as a draft in run:r1/)
  } finally {
    await memory.close()
  }
})

test('clyde recall searches with the agent token, scoped to CLYDE_MEMORY_SCOPE unless --scope says otherwise', async () => {
  const { memory, env } = await memoryRun()
  try {
    await clyde(['remember', '--title', 'Oolong brew notes', '--pattern', 'observations', '--body', 'Brew oolong at 90C.'], env)
    const r = await clyde(['recall', 'oolong', 'brew'], env)
    assert.equal(r.code, 0, r.stderr)
    assert.match(r.stdout, /^retrieval r-1\n- \[run-r1-oolong-brew-notes-[0-9a-f]{8}\] Oolong brew notes: Brew oolong at 90C\.\n$/)
    let call = memory.calls.at(-1)!
    assert.deepEqual([call.path, call.role, call.body], ['/recall', 'agent', { query: 'oolong brew', task: '', scope: 'run:r1' }])
    const other = await clyde(['recall', 'oolong', '--scope', 'run:r9', '--task', 'brew tea'], env)
    assert.match(other.stdout, /No matching entries/)
    call = memory.calls.at(-1)!
    assert.deepEqual(call.body, { query: 'oolong', task: 'brew tea', scope: 'run:r9' })
    assert.equal((await clyde(['recall'], env)).code, 2)
    assert.equal((await clyde(['recall', 'x'], { ...env, MEMORY_URL: undefined })).code, 0)
  } finally {
    await memory.close()
  }
})

/** A daemon in this process and one idle thread, so the tools have a thread to post to. */
async function daemonThread(env: Record<string, string> = {}): Promise<{ d: Daemon; id: string }> {
  const s = setup([], env)
  const d = await startDaemon({ port: 0 })
  const t = d.ctx.threads.start({ title: 'tools', prompt: 'hi', cwd: s.repo, rung: { backend: 'pi', model: 'fake/fake-1' } })
  await d.ctx.threads.waitIdle(t.id)
  return { d, id: t.id }
}

test('clyde progress posts a thread.progress event for CLYDE_THREAD_ID', async () => {
  const { d, id } = await daemonThread()
  try {
    const r = await clyde(['progress', 'Running', 'the tests'], { CLYDE_THREAD_ID: id })
    assert.deepEqual([r.code, r.stdout], [0, 'Posted.\n'], r.stderr)
    assert.equal(d.ctx.threads.get(id)?.progress, 'Running the tests')
    const e = d.ctx.events.since(0).at(-1)!
    assert.deepEqual([e.type, e.threadId, e.summary], ['thread.progress', id, `Thread ${id}: Running the tests`])
    assert.equal((await clyde(['progress', 'x'], { CLYDE_THREAD_ID: undefined })).code, 1)
    assert.equal((await clyde(['progress'], { CLYDE_THREAD_ID: id })).code, 2)
    const gone = await clyde(['progress', 'x'], { CLYDE_THREAD_ID: 't-00000000' })
    assert.equal(gone.code, 1)
    assert.match(gone.stderr, /no thread t-00000000/)
  } finally {
    await d.close()
  }
})

test('clyde result posts status, summary and the evidence file, and refuses a bad one', async () => {
  const { d, id } = await daemonThread()
  try {
    const file = join(tempDir('ev'), 'evidence.json')
    const evidence = [{ criterion: 'Tests pass.', evidence: 'npm test: # pass 3' }]
    writeFileSync(file, JSON.stringify(evidence))
    const r = await clyde(['result', '--status', 'done', '--summary', 'Login works.', '--evidence-file', file], { CLYDE_THREAD_ID: id })
    assert.equal(r.code, 0, r.stderr)
    assert.equal(r.stdout, `Reported done for thread ${id}, with 1 evidence item.\n`)
    assert.deepEqual(d.ctx.threads.result(id), { status: 'done', summary: 'Login works.', evidence })
    const blocked = await clyde(['result', '--status', 'blocked', '--summary', 'Needs Wen.'], { CLYDE_THREAD_ID: id })
    assert.equal(blocked.code, 0, blocked.stderr)
    assert.deepEqual(d.ctx.threads.result(id), { status: 'blocked', summary: 'Needs Wen.' })
    assert.equal((await clyde(['result', '--status', 'maybe', '--summary', 'x'], { CLYDE_THREAD_ID: id })).code, 2)
    assert.equal((await clyde(['result', '--status', 'done'], { CLYDE_THREAD_ID: id })).code, 2)
    writeFileSync(file, JSON.stringify([{ criterion: 'no evidence' }]))
    const bad = await clyde(['result', '--status', 'done', '--summary', 'x', '--evidence-file', file], { CLYDE_THREAD_ID: id })
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /every item needs a criterion and an evidence string/)
    assert.deepEqual(d.ctx.threads.result(id), { status: 'blocked', summary: 'Needs Wen.' }, 'a refused result changes nothing')
  } finally {
    await d.close()
  }
})

test('clyde hook adds the run and thread ids, reaches memory and the daemon, and prints nothing', async () => {
  setup([])
  const memory = await startFakeMemory()
  const { d, id } = await daemonThread({ MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token })
  try {
    const payload = { session_id: 's-1', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }
    const r = await clyde(['hook', 'PostToolUse'], { CLYDE_THREAD_ID: id, CLYDE_RUN_ID: 'r1' }, JSON.stringify(payload))
    assert.deepEqual([r.code, r.stdout, r.stderr], [0, '', ''])
    assert.deepEqual(memory.hooks.at(-1), { event: 'PostToolUse', payload: { ...payload, run_id: 'r1', thread_id: id } })
    assert.equal(memory.calls.at(-1)?.role, 'agent')
    assert.equal(d.ctx.threads.get(id)?.progress, 'PostToolUse Bash')
    const text = await clyde(['hook', 'Stop'], { CLYDE_THREAD_ID: id }, 'not json')
    assert.equal(text.code, 0)
    assert.deepEqual(memory.hooks.at(-1), { event: 'Stop', payload: { body: 'not json', thread_id: id } })
    assert.equal((await clyde(['hook'], {}, '{}')).code, 0)
  } finally {
    await d.close()
    await memory.close()
  }
})

test('clyde hook exits 0 within about 3 s when memory and the daemon never answer, and when stdin stays open', async () => {
  const s = setup([])
  const sockets = new Set<import('node:net').Socket>()
  const stuck = http.createServer(() => {})
  stuck.on('connection', (c) => sockets.add(c))
  await new Promise<void>((resolve) => stuck.listen(0, '127.0.0.1', () => resolve()))
  const port = (stuck.address() as { port: number }).port
  writeFileSync(join(s.home, 'daemon.json'), JSON.stringify({ pid: process.pid, port, token: 'x' }))
  try {
    const r = await clyde(['hook', 'SessionEnd'], { CLYDE_THREAD_ID: 't-1', MEMORY_URL: `http://127.0.0.1:${port}`, MEMORY_TOKEN: 'a' }, '{"session_id":"s"}')
    assert.deepEqual([r.code, r.stdout], [0, ''])
    assert.ok(r.ms < 4500, `took ${r.ms} ms`)
    // A caller that never closes stdin still gets an exit.
    const open = await new Promise<Ran>((resolve) => {
      const started = Date.now()
      const child = spawn(process.execPath, [LV, 'hook', 'Stop'], { env: { ...process.env, MEMORY_URL: undefined }, stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdin.write('{"partial":')
      child.on('close', (code) => resolve({ code, stdout: '', stderr: '', ms: Date.now() - started }))
    })
    assert.equal(open.code, 0)
    assert.ok(open.ms < 4500, `took ${open.ms} ms`)
  } finally {
    for (const c of sockets) c.destroy()
    stuck.close()
  }
})

test('clyde plan show and set go through the daemon, which writes the plan to memory as approved', async () => {
  const memory = await startFakeMemory()
  // The worker hangs, so the run stays running while the plan changes.
  const s = setup([{ match: 'worker for stage', hang: true }], { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
  const d = await startDaemon({ port: 0 })
  const client = new DaemonClient({ pid: process.pid, port: d.port, token: d.token })
  try {
    const run = await client.call('POST', '/runs', { flow: 'task', input: { prompt: 'Write hello.txt.', criteria: ['hello.txt exists.'] }, cwd: s.repo })
    const empty = await clyde(['plan', 'show', '--run', run.id])
    assert.deepEqual([empty.code, empty.stdout], [0, `Run ${run.id} has no plan yet.\n`], empty.stderr)
    const file = join(tempDir('plan'), 'plan.json')
    const plan = { intent: 'Greet the user.', slices: [{ id: 's1', title: 'Write greet.txt', acceptance: ['test -f greet.txt'] }] }
    writeFileSync(file, JSON.stringify(plan))
    const set = await clyde(['plan', 'set', '--file', file], { CLYDE_RUN_ID: run.id })
    assert.equal(set.code, 0, set.stderr)
    const entry = [...memory.entries.values()].find((e) => e.pattern === 'decisions' && e.scope === `run:${run.id}`)!
    assert.equal(entry.authority, 'approved')
    assert.equal(memory.calls.find((c) => c.path === '/entries' && (c.body as any)?.pattern === 'decisions')?.role, 'runtime')
    const lines = [`Run ${run.id} plan, memory entry ${entry.id}.`, 'Intent: Greet the user.', '- s1 Write greet.txt. Acceptance: test -f greet.txt']
    assert.equal(set.stdout, ['Plan set.', ...lines, ''].join('\n'))
    const shown = await clyde(['plan', 'show'], { CLYDE_RUN_ID: run.id })
    assert.equal(shown.stdout, [...lines, ''].join('\n'))
    const json = JSON.parse((await clyde(['plan', 'show', '--run', run.id, '--json'])).stdout)
    assert.deepEqual(json, { plan, entry: entry.id })
    writeFileSync(file, JSON.stringify({ intent: 'no slices', slices: [] }))
    const bad = await clyde(['plan', 'set', '--file', file, '--run', run.id])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /a plan is \{intent, slices/)
    assert.equal((await clyde(['plan', 'show'], { CLYDE_RUN_ID: undefined })).code, 2)
    await client.stopRun(run.id)
    await waitFor(async () => (await client.run(run.id)).status === 'stopped', 10_000, 'the run to stop')
  } finally {
    await d.close()
    await memory.close()
  }
})
