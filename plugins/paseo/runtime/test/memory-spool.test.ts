import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { agentMemory, runtimeMemory } from '../src/memory.ts'
import { flushPending } from '../src/memory-flush.ts'
import { localId, pending, spoolStatus } from '../src/memory-spool.ts'
import { startFakeMemory } from './fakes/memory.ts'
import { flowDaemon, flowSetup, waitStatus } from './golden/flow.ts'
import { waitFor } from './helpers.ts'

test('local queue answers reads without a server', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clyde-spool-'))
  const old = process.env.CLYDE_HOME
  process.env.CLYDE_HOME = home
  try {
    const project = { id: 'run-offline', pattern: 'projects', title: 'Offline run', body: 'offline tea',
      authority: 'observed', scope: 'run:offline', evidence_kind: 'summary', evidence: 'started', source: { kind: 'run', title: 'offline' } }
    assert.equal((await runtimeMemory({}).remember(project)).id, 'run-offline')
    const fields = { pattern: 'observations', title: 'Tea handoff', body: 'oolong tea ready',
      authority: 'draft', scope: 'run:offline', project: 'run-offline', evidence_kind: 'assistant', evidence: 'seen',
      blobs: [{ name: 'tea.txt', text: 'brew at 90C' }] }
    const note = await agentMemory({}).remember(fields)
    assert.equal((await agentMemory({}).remember(fields)).id, note.id)
    assert.match(await agentMemory({}).recall('oolong tea', 'run:offline'), new RegExp(note.id))
    assert.match(await runtimeMemory({}).entry(note.id) ?? '', /Tea handoff/)
    assert.equal(await agentMemory({}).blob(note.blobs[0].sha256), 'brew at 90C')
    assert.equal(pending().length, 2)
    assert.ok(spoolStatus(undefined, Date.now() + 300_000).oldestAgeMs >= 300_000)
  } finally {
    if (old === undefined) delete process.env.CLYDE_HOME
    else process.env.CLYDE_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('replay keeps one saved payload through a virtual five minute outage and a lost reply', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clyde-spool-'))
  const old = process.env.CLYDE_HOME
  process.env.CLYDE_HOME = home
  try {
    const payload = { id: 'run-replay', pattern: 'projects', title: 'Replay', body: 'saved once',
      authority: 'observed', scope: 'run:replay', evidence_kind: 'summary', evidence: 'saved', source: { kind: 'run', title: 'replay' } }
    assert.equal((await runtimeMemory({}).remember(payload)).id, payload.id)
    let elapsedMs = 0
    let lost = true
    const stored = new Map<string, string>()
    const copies: string[] = []
    const send = async (_method: string, _url: string, options: any) => {
      const body = JSON.stringify(options.body)
      copies.push(body)
      if (elapsedMs < 300_000) return { status: 503, text: 'unavailable', headers: {} }
      stored.set(options.body.id, body)
      if (lost) { lost = false; throw new Error('reply lost') }
      return { status: 200, text: JSON.stringify({ id: options.body.id }), headers: {} }
    }
    const config = { url: 'http://memory.invalid', runtimeToken: 'token', send }
    assert.equal(await flushPending(config), 0)
    assert.equal(pending().length, 1)
    elapsedMs = 300_000
    assert.equal(await flushPending(config), 0)
    assert.equal(pending().length, 1)
    assert.equal(await flushPending(config), 1)
    assert.equal(stored.size, 1)
    assert.equal(pending().length, 0)
    assert.ok(copies.every((body) => body === copies[0]))
  } finally {
    if (old === undefined) delete process.env.CLYDE_HOME
    else process.env.CLYDE_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('pending entries survive a new client and use the server id for unicode and blobs', async () => {
  const home = mkdtempSync(join(tmpdir(), 'clyde-spool-'))
  const old = process.env.CLYDE_HOME
  process.env.CLYDE_HOME = home
  try {
    const payload = { pattern: 'projects', title: 'Café 🫖', body: 'tea', authority: 'observed', scope: 'run:tea',
      evidence_kind: 'summary', evidence: 'tea', source: { kind: 'run', title: 'tea' },
      blobs: [{ name: 'notes.txt', text: 'warm tea' }] }
    const id = (await runtimeMemory({}).remember(payload)).id
    assert.equal(id, localId(payload))
    assert.equal(pending().length, 1)
    assert.match(await agentMemory({}).recall('Café', 'run:tea'), new RegExp(id))
    assert.match(await agentMemory({}).entry(id) ?? '', /warm tea|Blobs|Blob/)
    assert.equal(spoolStatus(undefined, Date.now() + 300_000).oldestAgeMs >= 300_000, true)
    const server = await startFakeMemory()
    try {
      assert.equal(await flushPending({ url: server.url, runtimeToken: server.runtimeToken, agentToken: server.token }), 1)
      assert.equal(server.entries.size, 1)
      assert.equal(server.entries.has(id), true)
      assert.equal(pending().length, 0)
    } finally { await server.close() }
  } finally {
    if (old === undefined) delete process.env.CLYDE_HOME
    else process.env.CLYDE_HOME = old
    rmSync(home, { recursive: true, force: true })
  }
})

test('a run completes through a simulated five minute server outage, then drains each entry once', async () => {
  const s = await flowSetup('task-rung1')
  let elapsedMs = 0
  let dropFirstReply = true
  const sent: unknown[] = []
  const proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.method === 'POST' && req.url === '/entries') sent.push(JSON.parse(Buffer.concat(chunks).toString()))
    if (elapsedMs < 300_000) { res.writeHead(503).end('unavailable'); return }
    const upstream = await fetch(`${s.memory.url}${req.url}`, {
      method: req.method, headers: { authorization: req.headers.authorization ?? '' },
      body: req.method === 'GET' ? undefined : Buffer.concat(chunks),
    })
    const output = Buffer.from(await upstream.arrayBuffer())
    if (req.url === '/entries' && dropFirstReply) { dropFirstReply = false; req.socket.destroy(); return }
    res.writeHead(upstream.status).end(output)
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  process.env.MEMORY_URL = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`
  const { d, client } = await flowDaemon()
  try {
    const started = await client.call<any>('POST', '/runs', { flow: 'task', input: {
      prompt: 'Write hello.txt holding hello.', criteria: ['A hello file. hello.txt holds hello.'], checks: ['test -f hello.txt'],
    }, cwd: s.repo })
    const note = await agentMemory().remember({ pattern: 'observations', title: 'handoff tea note', body: 'hello handoff tea',
      authority: 'draft', scope: `run:${started.id}`, project: `run-${started.id}`, evidence_kind: 'assistant', evidence: 'noted' })
    assert.match(await agentMemory().recall('handoff tea', `run:${started.id}`), new RegExp(note.id))
    assert.match(await runtimeMemory().entry(note.id) ?? '', /handoff tea note/)
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    assert.equal(run.asks.length, 0)
    assert.equal(run.stages[0].status, 'passed')
    const before = spoolStatus(undefined, Date.now() + 300_001)
    assert.ok(before.depth >= 3 && before.oldestAgeMs >= 300_000)
    elapsedMs = 300_001
    await waitFor(async () => {
      await flushPending({ url: process.env.MEMORY_URL, runtimeToken: s.memory.runtimeToken, agentToken: s.memory.token, timeoutMs: 200 })
      return pending().length === 0 ? true : null
    }, 10_000, 'the pending entries to drain')
    assert.equal(s.memory.entries.size, before.depth)
    assert.ok(s.memory.entries.has(note.id))
    assert.ok(s.memory.entries.has(`run-${started.id}`))
    assert.ok(s.memory.entries.has(run.stages[0].entry as string))
    assert.ok(sent.length > s.memory.entries.size, 'the lost reply caused a resend')
    const requests = sent as Record<string, any>[]
    for (const id of s.memory.entries.keys()) {
      const copies = requests.filter((body) => localId(body) === id)
      assert.ok(copies.length >= 1)
      assert.ok(copies.every((body) => JSON.stringify(body) === JSON.stringify(copies[0])), `resends of ${id} used the saved payload`)
    }
  } finally {
    await d.close()
    proxy.closeAllConnections()
    proxy.close()
    await s.memory.close()
  }
})
