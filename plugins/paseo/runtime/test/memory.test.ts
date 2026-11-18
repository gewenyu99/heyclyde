/** The memory client against the fake memory server: runtime and agent tokens, recall scope, entries, blobs, and a hook that never blocks. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import http from 'node:http'
import { join } from 'node:path'
import { test } from 'node:test'
import { adoptRenamedEnv, loadMemoryEnv } from '../src/config.ts'
import { agentMemory, Memory, recallAsAgent, rememberAsAgent, runtimeMemory } from '../src/memory.ts'
import { startFakeMemory } from './fakes/memory.ts'
import { setup, tempDir } from './helpers.ts'

const SOURCE = { kind: 'clyde-flow', title: 'clyde runtime' }

function note(project: string, title: string, extra: object = {}) {
  return { pattern: 'observations', title, body: `${title} body`, authority: 'draft', scope: 'run:r1', evidence_kind: 'summary', evidence: 'seen', project, ...extra }
}

test('the runtime writes a project and approved entries, and the agent token writes drafts only', async () => {
  const memory = await startFakeMemory()
  try {
    setup([], { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
    const runtime = new Memory(memory.url, memory.runtimeToken)
    const project = await runtime.remember({ pattern: 'projects', title: 'run r1', body: 'the run', authority: 'observed', scope: 'run:r1', evidence_kind: 'summary', evidence: 'started', source: SOURCE })
    const plan = await runtime.remember({ ...note(project.id, 'the plan'), authority: 'approved', source: SOURCE, blobs: [{ name: 'plan', text: 'step one' }] })
    assert.equal(plan.blobs[0].name, 'plan')
    assert.equal(await runtime.blob(plan.blobs[0].sha256), 'step one')
    assert.deepEqual(await runtime.remember({ ...note(project.id, 'the plan'), authority: 'approved', source: SOURCE, blobs: [{ name: 'plan', text: 'step one' }] }), plan, 'a resend lands on the same entry')

    const agent = new Memory(memory.url, memory.token)
    const draft = await agent.remember(note(project.id, 'gate evidence for parser'))
    assert.match(draft.id, /^run-r1-gate-evidence-for-parser-[0-9a-f]{8}$/)
    await assert.rejects(agent.remember({ ...note(project.id, 'too high'), authority: 'approved' }), /authority approved is above draft/)
    await assert.rejects(agent.remember({ ...note(project.id, 'wide'), scope: 'global' }), /An agent writes only in a run scope/)
    assert.equal(memory.calls.filter((c) => c.path === '/entries').map((c) => c.role).join(','), 'runtime,runtime,runtime,agent,agent,agent')
  } finally {
    await memory.close()
  }
})

test('recall leaves run entries out unless scoped, and entry() is null for a missing id', async () => {
  const memory = await startFakeMemory()
  try {
    setup([], { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
    const runtime = new Memory(memory.url, memory.runtimeToken)
    const project = await runtime.remember({ pattern: 'projects', title: 'run r1', body: 'the run', authority: 'observed', scope: 'run:r1', evidence_kind: 'summary', evidence: 'started', source: SOURCE })
    const inRun = await runtime.remember({ ...note(project.id, 'parser handoff notes'), source: SOURCE })
    const unscoped = await recallAsAgent('parser handoff')
    assert.ok(!unscoped.includes(inRun.id))
    const scoped = await recallAsAgent('parser handoff', 'run:r1')
    assert.ok(scoped.includes(inRun.id))
    assert.match((await runtime.entry(inRun.id)) ?? '', /^# parser handoff notes/)
    assert.equal(await runtime.entry('missing'), null)
    assert.equal(await runtime.blob('0'.repeat(64)), null)
  } finally {
    await memory.close()
  }
})

test('memory writes remain available without a server address', async () => {
  setup([])
  assert.ok(runtimeMemory())
  assert.ok(agentMemory())
  assert.equal((await runtimeMemory().remember({ id: 'offline', title: 'offline' })).id, 'offline')
  assert.match(await recallAsAgent('offline'), /offline/)
})

test('hook never throws, and gives up on a silent memory server after 3 seconds', async () => {
  const dead = new Memory('http://127.0.0.1:9', 't')
  await dead.hook('Stop', { a: 1 })
  const silent = http.createServer(() => {})
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()))
  try {
    const memory = new Memory(`http://127.0.0.1:${(silent.address() as { port: number }).port}`, 't')
    const started = Date.now()
    await memory.hook('Stop', { a: 1 })
    const took = Date.now() - started
    assert.ok(took >= 2900 && took < 4500, `took ${took} ms`)
  } finally {
    silent.closeAllConnections()
    silent.close()
  }
})

test('hooks reach the fake memory server with the event in the path', async () => {
  const memory = await startFakeMemory()
  try {
    await new Memory(memory.url, memory.token).hook('SessionStart', { session_id: 's1' })
    assert.deepEqual(memory.hooks, [{ event: 'SessionStart', payload: { session_id: 's1' } }])
    await new Memory(memory.url, 'wrong').hook('SessionStart', {})
    assert.equal(memory.calls.at(-1)?.status, 401)
  } finally {
    await memory.close()
  }
})

test('a lost write response is retried with the same payload and creates one entry', async () => {
  const store = await startFakeMemory()
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    const upstream = await fetch(`${store.url}/entries`, {
      method: 'POST', headers: { authorization: `Bearer ${store.runtimeToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await upstream.text()
    if (store.calls.length === 1) req.socket.destroy()
    else res.writeHead(upstream.status).end(text)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  try {
    const client = new Memory(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`, store.runtimeToken,
      { writeTimeoutMs: 100, outageMs: 500, retryBaseMs: 10 })
    const result = await client.remember({ pattern: 'projects', title: 'resend', body: 'one', authority: 'observed',
      scope: 'run:resend', evidence_kind: 'summary', evidence: 'seen', source: SOURCE })
    assert.equal(store.calls.length, 2)
    assert.equal(store.entries.size, 1)
    assert.equal(result.id, [...store.entries.keys()][0])
    assert.deepEqual(store.calls[0].body, store.calls[1].body)
  } finally {
    proxy.closeAllConnections()
    proxy.close()
    await store.close()
  }
})

test('transient errors retry, while a sustained outage reports its duration', async () => {
  let attempts = 0
  const server = http.createServer((_req, res) => {
    attempts++
    if (attempts < 3) res.writeHead(503).end('unavailable')
    else res.writeHead(200).end('{"id":"recovered","blobs":[],"embedded":false}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    const client = new Memory(url, 'token', { writeTimeoutMs: 20, outageMs: 200, retryBaseMs: 10 })
    assert.equal((await client.remember({ title: 'recovered' })).id, 'recovered')
    assert.equal(attempts, 3)
    server.removeAllListeners('request')
    server.on('request', (_req, res) => res.writeHead(503).end('unavailable'))
    await assert.rejects(client.remember({ title: 'outage' }), /unavailable for at least \d+ ms/)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

test('a slow response times out per attempt and a later fast response succeeds', async () => {
  let attempts = 0
  const server = http.createServer((_req, res) => {
    attempts++
    if (attempts < 3) setTimeout(() => res.end('{"id":"late","blobs":[]}'), 80)
    else res.end('{"id":"ready","blobs":[]}')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const client = new Memory(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 'token',
      { writeTimeoutMs: 20, outageMs: 500, retryBaseMs: 10 })
    assert.equal((await client.remember({ title: 'slow' })).id, 'ready')
    assert.equal(attempts, 3)
  } finally {
    server.closeAllConnections()
    server.close()
  }
})

/** Runs fn with console.error captured, and returns what it printed. */
function stderrOf(fn: () => void): string[] {
  const printed: string[] = []
  const original = console.error
  console.error = (line: string) => { printed.push(line) }
  try { fn() } finally { console.error = original }
  return printed
}

test('the kb names still work for one release, each with a warning, and never outrank the new ones', () => {
  const env: NodeJS.ProcessEnv = { KB_URL: 'http://old', KB_TOKEN: 'old-agent', MEMORY_TOKEN: 'new-agent', CLYDE_KB_SCOPE: 'run:r1' }
  const printed = stderrOf(() => adoptRenamedEnv(env))
  assert.deepEqual(env, { MEMORY_URL: 'http://old', MEMORY_TOKEN: 'new-agent', CLYDE_MEMORY_SCOPE: 'run:r1' })
  assert.equal(printed.length, 3)
  assert.match(printed[0], /^clyde: KB_URL is deprecated\. Rename it MEMORY_URL\./)
  assert.deepEqual(stderrOf(() => adoptRenamedEnv(env)), [], 'nothing is left to warn about')
})

test('a memory.env that still uses the kb names loads under the new ones', () => {
  setup([])
  writeFileSync(join(process.env.CLYDE_HOME!, 'memory.env'), 'export KB_URL=https://memory.example\nKB_TOKEN="agent"\nMEMORY_RUNTIME_TOKEN=runtime\n')
  const env: NodeJS.ProcessEnv = {}
  const printed = stderrOf(() => loadMemoryEnv(env))
  assert.deepEqual(env, { MEMORY_URL: 'https://memory.example', MEMORY_TOKEN: 'agent', MEMORY_RUNTIME_TOKEN: 'runtime' })
  assert.deepEqual(printed.map((l) => l.split(' is ')[0]), ['clyde: KB_URL in memory.env', 'clyde: KB_TOKEN in memory.env'])
})
