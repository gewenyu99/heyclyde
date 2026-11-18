import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { startDaemon } from '../src/daemon.ts'
import { EventLog } from '../src/events.ts'
import { mirrorName, startMirror } from '../src/mirror.ts'
import { saveState } from '../src/paseo.ts'
import { readJson, writeJson } from '../src/store.ts'
import { Threads } from '../src/threads.ts'
import { argvLog, FAKE_BIN, setup, waitFor } from './helpers.ts'

function harness(config: object = {}) {
  const h = setup([{ reply: 'first', delayMs: 150, exitDelayMs: 150 }, { reply: 'direct follow-up' }], { CLYDE_PASEO_BIN: join(FAKE_BIN, 'paseo') })
  const codexHome = join(h.home, 'codex')
  mkdirSync(join(codexHome, 'sessions'), { recursive: true })
  process.env.CODEX_HOME = codexHome
  writeJson(join(h.state, 'paseo.json'), { reply: 'mirrored answer', ...config })
  saveState({ agentId: 'pointman', cwd: h.repo, createdAt: new Date().toISOString() })
  const events = new EventLog()
  const threads = new Threads({ events })
  const start = () => threads.start({ title: 'mirror', prompt: 'first', cwd: h.repo, rung: { backend: 'codex', model: 'fake' } })
  const calls = () => { try { return readFileSync(join(h.state, 'paseo-argv.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l)) } catch { return [] } }
  const rollout = (id: string) => {
    const session = threads.get(id)!.session!
    const file = join(codexHome, 'sessions', `rollout-${session}.jsonl`)
    writeFileSync(file, JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'stale answer' } }) + '\n')
    writeJson(join(h.state, 'paseo.json'), { reply: 'mirrored answer', file, ...config })
    return file
  }
  return { ...h, events, threads, start, calls, rollout }
}

test('unmirrored follow-ups keep the direct Codex path', async () => {
  const h = harness()
  const t = h.start()
  await h.threads.waitIdle(t.id)
  h.threads.send(t.id, 'second')
  const done = await h.threads.waitIdle(t.id)
  assert.deepEqual(done.turns.map(t => t.text), ['first', 'direct follow-up'])
  assert.equal(argvLog(h.state).length, 2)
  assert.deepEqual(h.calls(), [])
})

test('only a top-level run representative and point-man standalone thread are eligible', async () => {
  const h = harness()
  const task = { id: 'r-task', flow: 'task', title: 'Ship the fix', stages: [{ name: 'task', attempts: [{ threadId: 't-first' }] }] }
  const ship = { id: 'r-ship', flow: 'ship', title: 'Build the app', stages: [{ name: 'plan', attempts: [{ threadId: 't-planner' }] }] }
  const nested = { ...task, id: 'r-nested', parentThreadId: 't-parent' }
  for (const run of [task, ship, nested]) writeJson(join(h.home, 'runs', `${run.id}.json`), run)
  const base = { title: 'worker title', rung: { backend: 'codex' as const }, cwd: h.repo, status: 'idle' as const,
    queue: [], turns: [], createdAt: '', updatedAt: '' }
  const named = (id: string, fields: object = {}) => mirrorName({ ...base, id, ...fields }, h.home)
  assert.equal(named('t-first', { runId: task.id }), task.title, 'old task representative remains eligible')
  assert.equal(named('t-planner', { runId: ship.id }), ship.title, 'old ship planner remains eligible')
  assert.equal(named('t-new', { runId: task.id, mirrorTitle: task.title }), task.title, 'new representative is eligible before attempt is saved')
  assert.equal(named('t-retry', { runId: task.id, stage: 'task' }), null)
  assert.equal(named('t-judge', { runId: task.id, stage: 'task', readOnly: true }), null)
  assert.equal(named('t-review', { runId: ship.id, stage: 'review' }), null)
  assert.equal(named('t-nested', { runId: nested.id, mirrorTitle: task.title }), null)
  assert.equal(named('t-child', { parentThreadId: 't-parent' }), null)
  assert.equal(named('t-standalone'), base.title)
})

test('background workers never import and keep direct turns even with a stale map entry', async () => {
  const h = harness()
  const close = startMirror(h.events, h.threads, h.home)
  try {
    const t = h.threads.start({ title: 'stage worker', prompt: 'first', cwd: h.repo,
      rung: { backend: 'codex', model: 'fake' }, runId: 'r-missing', stage: 'task' })
    await h.threads.waitIdle(t.id)
    writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'stale-agent' })
    h.threads.send(t.id, 'second')
    const done = await h.threads.waitIdle(t.id)
    assert.deepEqual(done.turns.map(turn => turn.text), ['first', 'direct follow-up'])
    assert.equal(argvLog(h.state).length, 2)
    assert.deepEqual(h.calls(), [])
  } finally { close() }
})

test('a run imports its representative under the run title, never its retry or judge', async () => {
  const h = harness()
  writeJson(join(h.home, 'runs', 'r-task.json'), { id: 'r-task', flow: 'task', title: 'Top-level title', stages: [{ name: 'task', attempts: [] }] })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    const start = (title: string, extra: object = {}) => h.threads.start({ title, prompt: 'first', cwd: h.repo,
      rung: { backend: 'codex', model: 'fake' }, runId: 'r-task', stage: 'task', ...extra })
    const rep = start('worker internal title', { mirrorTitle: 'Top-level title' })
    await h.threads.waitIdle(rep.id)
    await waitFor(() => readJson<Record<string, string>>(join(h.home, 'paseo-threads.json'))?.[rep.id])
    const retry = start('retry')
    const judge = start('judge', { readOnly: true })
    await Promise.all([h.threads.waitIdle(retry.id), h.threads.waitIdle(judge.id)])
    assert.equal(h.calls().filter(c => c[0] === 'import').length, 1)
    assert.deepEqual(Object.keys(readJson<Record<string, string>>(join(h.home, 'paseo-threads.json'))!), [rep.id])
    assert.ok(h.calls().some(c => c[0] === 'agent' && c.includes('Top-level title')))
  } finally { close() }
})

test('an import does not restore entries removed from the map while it runs', async () => {
  const h = harness({ importDelay: 250 })
  const path = join(h.home, 'paseo-threads.json')
  const old = h.start()
  await h.threads.waitIdle(old.id)
  writeJson(path, { [old.id]: 'archived-agent' })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    const t = h.start()
    await waitFor(() => h.calls().some(c => c[0] === 'import'))
    writeJson(path, {})
    await waitFor(() => readJson<Record<string, string>>(path)?.[t.id])
    assert.deepEqual(Object.keys(readJson<Record<string, string>>(path)!), [t.id])
  } finally { close() }
})

test('mirror startup archives background mappings before removing them, and preserves the point man', async () => {
  const h = harness()
  const background = h.threads.start({ title: 'judge', prompt: 'first', cwd: h.repo,
    rung: { backend: 'codex', model: 'fake' }, runId: 'r-old', stage: 'task', readOnly: true })
  await h.threads.waitIdle(background.id)
  writeJson(join(h.home, 'paseo-threads.json'), { [background.id]: 'archived-agent', 't-missing': 'gone', 't-point': 'pointman' })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    await waitFor(() => Object.keys(readJson<Record<string, string>>(join(h.home, 'paseo-threads.json')) ?? {}).length === 1)
    assert.deepEqual(readJson(join(h.home, 'paseo-threads.json')), { 't-point': 'pointman' })
    assert.deepEqual(h.calls().filter(c => c[0] === 'archive').map(c => c[1]).sort(), ['archived-agent', 'gone'])
    assert.ok(h.calls().every(c => c[1] !== 'pointman'))
  } finally { close() }
})

test('failed archive leaves the background agent mapped for retry', async () => {
  const h = harness({ failArchive: true })
  writeJson(join(h.home, 'paseo-threads.json'), { 't-missing': 'still-visible' })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    await waitFor(() => h.calls().some(c => c[0] === 'archive'))
    assert.deepEqual(readJson(join(h.home, 'paseo-threads.json')), { 't-missing': 'still-visible' })
  } finally { close() }
})

test('startup removes a mapping whose Paseo agent is already archived', async () => {
  const h = harness()
  writeFileSync(join(h.state, 'archived-old-agent'), '')
  writeJson(join(h.home, 'paseo-threads.json'), { 't-missing': 'old-agent' })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    await waitFor(() => Object.keys(readJson<Record<string, string>>(join(h.home, 'paseo-threads.json')) ?? {}).length === 0)
    assert.equal(h.calls().filter(c => c[0] === 'archive').length, 0)
  } finally { close() }
})

test('import waits for direct process exit; a queued follow-up waits for import and uses Paseo', async () => {
  const h = harness({ importDelay: 150 })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    const t = h.start()
    await waitFor(() => h.threads.get(t.id)?.session)
    h.rollout(t.id)
    h.threads.progress(t.id, 'still running')
    assert.equal(h.calls().length, 0, 'progress must not import an active writer')
    h.threads.send(t.id, 'second')
    const done = await h.threads.waitIdle(t.id)
    assert.deepEqual(done.turns.map(t => [t.ok, t.text]), [[true, 'first'], [true, 'mirrored answer']])
    assert.equal(argvLog(h.state).length, 1, 'no codex resume after import')
    assert.deepEqual(h.calls().map(c => c[0]), ['import', 'agent', 'send', 'wait', 'inspect'])
    const prompt = readFileSync(join(h.state, 'sent-prompt'), 'utf8')
    assert.ok(prompt.includes(`CLYDE_THREAD_ID='${t.id}'`))
    assert.ok(prompt.endsWith('second'))
    assert.deepEqual(h.events.since(0).filter(e => e.type === 'thread.done').length, 2)
  } finally { close() }
})

test('a saved mirror routes through Paseo after restart and parses schema results', async () => {
  const h = harness({ reply: '{"verdict":"pass"}' })
  const t = h.start()
  await h.threads.waitIdle(t.id)
  h.rollout(t.id)
  writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'fake-agent' })
  const restarted = new Threads({ events: h.events })
  restarted.need(t.id).schema = { type: 'object' }
  restarted.send(t.id, 'judge')
  const done = await restarted.waitIdle(t.id)
  assert.equal(done.turns[1].ok, true)
  assert.deepEqual(done.turns[1].json, { verdict: 'pass' })
  assert.equal(argvLog(h.state).length, 1)
})

test('Paseo send failure fails the turn without falling back to a second writer', async () => {
  const h = harness({ failSend: true })
  const t = h.start()
  await h.threads.waitIdle(t.id)
  h.rollout(t.id)
  writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'fake-agent' })
  h.threads.send(t.id, 'second')
  const done = await h.threads.waitIdle(t.id)
  assert.match(done.turns[1].error!, /send refused/)
  assert.equal(argvLog(h.state).length, 1)
})

test('stopping a mirrored turn interrupts Paseo and drains Clyde', async () => {
  const h = harness({ hang: true })
  const t = h.start()
  await h.threads.waitIdle(t.id)
  h.rollout(t.id)
  writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'fake-agent' })
  h.threads.send(t.id, 'second')
  await waitFor(() => h.calls().some(c => c[0] === 'wait'))
  h.threads.stop(t.id)
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'stopped')
  assert.equal(done.turns[1].ok, false)
  assert.ok(h.calls().some(c => c[0] === 'stop'))
})

test('failed import retries on the next turn end', async () => {
  const h = harness({ failImport: true })
  const close = startMirror(h.events, h.threads, h.home)
  try {
    const t = h.start()
    await h.threads.waitIdle(t.id)
    await waitFor(() => h.calls().some(c => c[0] === 'import'))
    await waitFor(() => !h.threads.mirrorImports.has(t.id))
    h.threads.send(t.id, 'second')
    await h.threads.waitIdle(t.id)
    await waitFor(() => readJson<Record<string, string>>(join(h.home, 'paseo-threads.json'))?.[t.id])
    assert.equal(h.calls().filter(c => c[0] === 'import').length, 2)
  } finally { close() }
})

test('mirrored turns retain work-list prompts, nudges and fenced result handling', async () => {
  const h = harness()
  const t = h.start()
  await h.threads.waitIdle(t.id)
  h.rollout(t.id)
  writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'fake-agent' })
  h.threads.lists.add(`thread:${t.id}`, ['verify the answer'])
  h.threads.send(t.id, 'second')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.turns.length, 5, 'three nudges still go through Paseo')
  assert.equal(h.calls().filter(c => c[0] === 'send').length, 4)
  assert.match(readFileSync(join(h.state, 'sent-prompt'), 'utf8'), /verify the answer/)
  writeJson(join(h.state, 'paseo.json'), { file: join(process.env.CODEX_HOME!, 'sessions', `rollout-${done.session}.jsonl`), reply: '```json\n{"status":"blocked","summary":"needs input","evidence":[]}\n```' })
  h.threads.send(t.id, 'report')
  const reported = await h.threads.waitIdle(t.id)
  assert.equal(reported.turns.length, 6, 'fenced result prevents another nudge')
})

for (const backend of ['claude', 'pi'] as const) {
  test(`a mirrored ${backend} turn reads Paseo text logs`, async () => {
    const h = harness()
    const t = h.threads.start({ title: backend, prompt: 'first', cwd: h.repo, rung: { backend, model: 'fake' } })
    await h.threads.waitIdle(t.id)
    writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'fake-agent' })
    h.threads.send(t.id, 'second')
    const done = await h.threads.waitIdle(t.id)
    assert.equal(done.turns[1].ok, true)
    assert.equal(done.turns[1].text, 'mirrored answer')
    assert.equal(argvLog(h.state).length, 1)
    assert.ok(h.calls().some(c => c[0] === 'logs' && c.includes('--since')))
  })
}

test('Paseo workers can post todo updates and clyde result with their supplied CLI context', async () => {
  const h = harness()
  const daemon = await startDaemon({ port: 0 })
  const threads = daemon.ctx.threads
  try {
    const t = threads.start({ title: 'post result', prompt: 'first', cwd: h.repo, rung: { backend: 'codex', model: 'fake' } })
    const first = await threads.waitIdle(t.id)
    await waitFor(() => readJson<Record<string, string>>(join(h.home, 'paseo-threads.json'))?.[t.id])
    const file = join(process.env.CODEX_HOME!, 'sessions', `rollout-${first.session}.jsonl`)
    writeFileSync(file, '')
    writeJson(join(h.state, 'paseo.json'), { file, reply: 'finished', report: true })
    threads.lists.add(`thread:${t.id}`, ['verify the answer'])
    threads.send(t.id, 'finish and report')
    const done = await threads.waitIdle(t.id)
    assert.equal(done.turns[1].ok, true)
    assert.equal(done.turns.length, 2, 'posted result and settled list avoid nudges')
    assert.deepEqual(done.result, { status: 'done', summary: 'posted through Paseo' })
    assert.equal(threads.lists.get(`thread:${t.id}`).items[0].status, 'done')
  } finally { await daemon.close() }
})

for (const [config, error] of [[{ noCompletion: true }, /without completing/], [{ failed: true }, /agent failed/]] as const) {
  test(`Paseo failure is not accepted as an old successful answer: ${JSON.stringify(config)}`, async () => {
    const h = harness(config)
    const t = h.start()
    await h.threads.waitIdle(t.id)
    h.rollout(t.id)
    writeJson(join(h.home, 'paseo-threads.json'), { [t.id]: 'fake-agent' })
    h.threads.send(t.id, 'second')
    const done = await h.threads.waitIdle(t.id)
    assert.equal(done.turns[1].ok, false)
    assert.match(done.turns[1].error!, error)
    assert.notEqual(done.turns[1].text, 'stale answer')
  })
}

test('mirror never imports finished work, and at startup only work in flight', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { active, inFlight } = await import('../src/mirror.ts')
  const home = mkdtempSync(join(tmpdir(), 'clyde-mirror-active-'))
  const cwd = mkdtempSync(join(tmpdir(), 'clyde-mirror-cwd-'))
  mkdirSync(join(home, 'runs'))
  const run = (id: string, status: string) => writeFileSync(join(home, 'runs', `${id}.json`), JSON.stringify({ id, status, stages: [] }))
  run('r-live', 'running'); run('r-asking', 'asking'); run('r-stopped', 'stopped'); run('r-done', 'done')
  const t = (o: object) => ({ id: 't', title: 'x', rung: { backend: 'codex' }, cwd, status: 'idle', queue: [], turns: [], createdAt: '', updatedAt: '', ...o }) as never
  assert.equal(active(t({ runId: 'r-live' }), home), true)
  assert.equal(active(t({ runId: 'r-asking' }), home), true)
  assert.equal(active(t({ runId: 'r-stopped' }), home), false)
  assert.equal(active(t({ runId: 'r-done' }), home), false)
  assert.equal(active(t({ runId: 'r-missing' }), home), false)
  assert.equal(active(t({}), home), true)
  assert.equal(active(t({ status: 'failed' }), home), false)
  assert.equal(active(t({ status: 'running', cwd: join(cwd, 'gone') }), home), false)
  assert.equal(inFlight(t({}), home), false)
  assert.equal(inFlight(t({ status: 'running' }), home), true)
  assert.equal(inFlight(t({ runId: 'r-live' }), home), true)
  assert.equal(inFlight(t({ runId: 'r-done', status: 'running' }), home), false)
})
