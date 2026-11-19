import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { call, follow } from '../../server/daemon.ts'
import { home, steps, task, type RawRun, type RawThread } from '../../server/shape.ts'

const NOW = new Date('2026-10-12T10:00:00Z')
const at = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString()
const thread = (o: Partial<RawThread>): RawThread => ({
  id: 't-x', title: 'x', status: 'idle', rung: { backend: 'codex', model: 'gpt-6-sol', effort: 'medium' },
  createdAt: at(30), updatedAt: at(1), turns: [], ...o,
})
const attempt = (n: number, threadId: string, extra: object = {}) => ({ n, rung: { backend: 'codex', model: 'gpt-6-sol', effort: 'high' }, threadId, startedAt: at(20 - n), ...extra })
const fail = { criterion: 'Guards probed', pass: false, evidence: 'no game-over probe' }
const pass = { criterion: 'Checks green', pass: true, evidence: 'npm test ok' }

function shipRun(o: Partial<RawRun> = {}): RawRun {
  return {
    id: 'r-ship', flow: 'ship', title: 'Tic tac toe API', status: 'running', input: { intent: 'Build a tic tac toe API. More words.' },
    createdAt: at(40), updatedAt: at(1), branch: 'clyde/r-ship', plan: { slices: [{ id: 's1' }, { id: 's2' }] },
    stages: [
      { name: 'plan', status: 'passed', startedAt: at(40), attempts: [attempt(1, 't-plan', { verdict: { verdict: 'pass', criteria: [pass] } })] },
      { name: 'code-it-works:s1', status: 'passed', startedAt: at(30), attempts: [attempt(1, 't-w1', { checks: [{ cmd: 'npm test', code: 0, output: '' }], verdict: { verdict: 'pass', criteria: [pass] } })] },
      { name: 'code-it-good:s1', status: 'running', startedAt: at(20), attempts: [
        attempt(1, 't-g1', { ok: true, checks: [{ cmd: 'npm test', code: 0, output: '' }], verdict: { verdict: 'fail', criteria: [pass, fail] } }),
        attempt(2, 't-g2'),
      ] },
    ],
    ...o,
  }
}

test('a ship slice is one piece titled with what it does, and its code-it skills are phases inside it', () => {
  const run = shipRun({ plan: { slices: [{ id: 's1', title: 'Game engine', acceptance: ['npm test -- engine'] }, { id: 's2', title: 'HTTP API' }] } })
  const s = steps(run)
  assert.deepEqual(s.map((x) => x.name), ['Plan', 'Slices 1–2', 'Review'])
  const [engine, api] = s[1].pieces
  assert.equal(engine.title, 'Game engine')
  assert.deepEqual(engine.phases.map((p) => [p.label, p.status]), [['works', 'passed'], ['good', 'sent-back'], ['clean', 'pending']])
  assert.equal(engine.status, 'sent-back')
  assert.equal(engine.sentBack, 1)
  assert.deepEqual(engine.doneWhen, ['npm test -- engine'])
  assert.equal(api.status, 'pending')
  assert.equal(s[0].pieces[0].title, 'Plan the work and get it approved')
})

test('a daemon restart that cut a turn off is an interruption, never a sent-back', () => {
  const run = shipRun()
  run.stages[2].attempts.unshift(attempt(0, 't-lost', { ok: false, reason: 'Lost when the daemon stopped.' }))
  const good = steps(run)[1].pieces[0]
  assert.equal(good.sentBack, 1)
  assert.equal(good.interrupted, 1)
  const view = task(run, [], {})
  assert.equal(view.attempts['code-it-good:s1'][0].outcome, 'Interrupted by a restart')
})

test('a piece that wrote its verdict to memory marks the hand-off to the next piece', () => {
  const run = shipRun()
  run.stages[1] = { ...run.stages[1], entry: 'e-1' }
  assert.equal(steps(run)[1].pieces[0].handoff, true)
  assert.equal(steps(shipRun())[1].pieces[0].handoff, false)
})

test('home lists only top-level live work; workers, judges, test threads and stopped runs are hidden or counted', () => {
  const threads = [
    thread({ id: 't-g2', title: 'r-ship worker', runId: 'r-ship', stage: 'code-it-good:s1', status: 'running', progress: 'running npm test' }),
    thread({ id: 't-judge', title: 'judge', runId: 'r-ship', readOnly: true, status: 'running' }),
    thread({ id: 't-solo', title: 'Research the decision API', status: 'running', turns: [{ n: 1, prompt: 'Find the API. Then report.', startedAt: at(5) }] }),
    thread({ id: 't-test', title: 'Reply with just: ok', status: 'running' }),
    thread({ id: 't-old', title: 'Old thing', status: 'failed' }),
  ]
  const runs = [shipRun(), shipRun({ id: 'r-stopped', title: 'Stopped run', status: 'stopped' }), shipRun({ id: 'r-child', parentThreadId: 't-solo' })]
  const h = home(threads, runs, { 't-plan': 'agent-1' }, 7, NOW)
  assert.deepEqual(h.tasks.map((t) => t.id).sort(), ['r-ship', 't-solo'])
  const ship = h.tasks.find((t) => t.id === 'r-ship')!
  assert.equal(ship.current, 'Worker is retrying s1 · good (attempt 2) — running npm test')
  assert.equal(ship.agentId, 'agent-1')
  assert.equal(ship.why, 'Build a tic tac toe API.')
  assert.equal(ship.pips.length, 4)
  assert.equal(ship.sentBack, 1)
  assert.equal(h.background, 2)
  assert.equal(h.revision, 7)
  assert.equal(h.needsYou.length, 0)
})

test('needs you holds asking runs with their open question, and point-man threads that ended on a question', () => {
  const asking = shipRun({ status: 'asking', question: 'Approve this plan?', asks: [{ kind: 'approve', question: 'Approve this plan?', askedAt: at(18) }] })
  const solo = thread({ id: 't-q', title: 'Shape check', turns: [{ n: 1, prompt: 'Look.', startedAt: at(9), endedAt: at(8), ok: true, text: 'Here is the shape.\n\nDoes this make sense?' }] })
  const h = home([solo], [asking], {}, 1, NOW)
  assert.deepEqual(h.needsYou.map((a) => [a.kind, a.id, a.question, a.approve]), [
    ['run', 'r-ship', 'Approve this plan?', true], ['thread', 't-q', 'Does this make sense?', false],
  ])
  assert.deepEqual(h.needsYou[0].plan, ['S1 · s1', 'S2 · s2'])
  assert.equal(h.needsYou[1].plan, undefined)
})

test('done today collects runs that ended today and nothing older', () => {
  const done = shipRun({ id: 'r-done', status: 'done', endedAt: at(30) })
  const old = shipRun({ id: 'r-old', status: 'done', endedAt: '2026-10-01T10:00:00Z' })
  const h = home([], [done, old], {}, 1, NOW)
  assert.deepEqual(h.doneToday.map((t) => t.id), ['r-done'])
  assert.equal(h.tasks.length, 0)
})

test('the task view keeps worker evidence beside the judge verdict per criterion, and selects the live piece', () => {
  const v = task(shipRun(), [thread({ id: 't-g2', runId: 'r-ship', status: 'running' })], {})
  assert.equal(v.selected, 'S1')
  const [first] = v.attempts['code-it-good:s1']
  assert.equal(first.outcome, 'Sent back')
  assert.deepEqual(first.criteria.map((c) => [c.criterion, c.result]), [['Checks green', 'pass'], ['Guards probed', 'fail']])
  assert.equal(v.background, 1)
  assert.equal(v.goal, 'Build a tic tac toe API.')
  assert.equal(v.summary, '1 of 4 pieces have passed. Worker is retrying s1 · good (attempt 2).')
})

function fakeDaemon() {
  const home = mkdtempSync(join(tmpdir(), 'clyde-plugin-'))
  const streams = new Set<ServerResponse>()
  const posted: { path: string; body: unknown }[] = []
  const server = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer tok') { res.writeHead(401).end(); return }
    if (req.url?.startsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(': clyde events\n\n')
      streams.add(res)
      req.on('close', () => streams.delete(res))
      return
    }
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      posted.push({ path: req.url ?? '', body: data ? JSON.parse(data) : null })
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
    })
  })
  return new Promise<{ home: string; emit: (id: number) => void; posted: typeof posted; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      writeFileSync(join(home, 'daemon.json'), JSON.stringify({ port, token: 'tok' }))
      resolve({
        home, posted,
        emit: (id) => { for (const s of streams) s.write(`id: ${id}\ndata: {"id":${id}}\n\n`) },
        close: () => { for (const s of streams) s.destroy(); server.close() },
      })
    })
  })
}

test('a waiting long-poll wakes on an SSE event, and times out to the same revision when nothing happens', async () => {
  const d = await fakeDaemon()
  process.env.CLYDE_HOME = d.home
  const live = follow()
  try {
    const start = Date.now()
    while (live.revision() === 0 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20))
    const base = live.revision()
    assert.ok(base > 0, 'connecting bumps the revision')
    assert.equal(await live.wait(base, 100), base)
    const woke = live.wait(base, 5000)
    d.emit(500)
    assert.equal(await woke, 500)
  } finally {
    live.close()
    d.close()
    delete process.env.CLYDE_HOME
  }
})

test('answers post to the run answer route with the reply text', async () => {
  const d = await fakeDaemon()
  process.env.CLYDE_HOME = d.home
  try {
    await call('POST', '/runs/r-ship/answer', { text: 'yes', via: 'paseo' })
    await call('POST', '/threads/t-q/messages', { text: 'go on', via: 'paseo' })
    await call('POST', '/runs/r-ship/stop', {})
    assert.deepEqual(d.posted, [
      { path: '/runs/r-ship/answer', body: { text: 'yes', via: 'paseo' } },
      { path: '/threads/t-q/messages', body: { text: 'go on', via: 'paseo' } },
      { path: '/runs/r-ship/stop', body: {} },
    ])
  } finally {
    d.close()
    delete process.env.CLYDE_HOME
  }
})

test('catch-up counts only completed work and carries the exact pending decision key',()=>{
  const paused=shipRun({id:'r-q',status:'asking',asks:[{key:'plan-2',kind:'approve',question:'Which format should the export use?',askedAt:at(12)}]});
  const waiting=thread({id:'t-q',title:'Export',turns:[{n:1,prompt:'Prepare export',startedAt:at(8),endedAt:at(6),ok:true,text:'Which format?'}]});
  const broken=shipRun({id:'r-f',status:'failed',endedAt:at(6),error:'Build command exited 1'});
  const h=home([waiting],[paused,broken],{},1,NOW);
  assert.equal(h.doneToday.length,0);
  assert.equal(h.needsYou.length,2);
  assert.equal(h.needsYou.find(a=>a.id==='r-q')?.askKey,'plan-2');
  assert.equal(h.needsYou.find(a=>a.id==='r-q')?.approve,false);
  assert.deepEqual(h.failedToday.map(c=>[c.id,c.current]),[['r-f','Build command exited 1']]);
});

test('overview check counts use only the most recent attempt per stage',()=>{
  const r=shipRun({status:'done',endedAt:at(2),auditedHead:'ab1234567890fff',
    stages:[{name:'task',status:'passed',startedAt:at(8),attempts:[
      attempt(1,'t1',{checks:[{cmd:'npm test',code:1,output:'old failure'}]}),
      attempt(2,'t2',{checks:[{cmd:'npm test',code:0,output:'passed'}]})]}]});
  const h=home([], [r],{},1,NOW);
  assert.equal(h.doneToday[0].checkSummary,'1/1 stage checks passed');
  assert.equal(h.doneToday[0].current,'Audited ab1234567890');
});

test('archived tasks disappear from approvals, running, failed and completed lists',()=>{
  const r=shipRun({archivedAt:at(5),status:'asking',question:'Approve?',asks:[{kind:'approve',askedAt:at(3),question:'Approve?'}]})
  const h=home([thread({archivedAt:at(4),status:'running'})],[r,{...r,id:'f',status:'failed',endedAt:at(5)},{...r,id:'d',status:'done',endedAt:at(5)}],{},1,NOW)
  assert.deepEqual([h.needsYou.length,h.tasks.length,h.failedToday.length,h.doneToday.length],[0,0,0,0])
})

test('runAgentId skips unstarted failed worker threads and keeps the prior started worker', () => {
  const run = shipRun({
    status: 'asking',
    stages: [
      {
        name: 'plan',
        status: 'asking',
        startedAt: at(20),
        attempts: [attempt(1, 't-started'), attempt(2, 't-ghost')],
      },
    ],
  })
  const threads = [
    thread({
      id: 't-started',
      runId: 'r-ship',
      paseoAgentId: 'paseo-started',
      status: 'idle',
      turns: [{ n: 1, prompt: 'plan', startedAt: at(19), endedAt: at(18), ok: true, text: 'done' }],
    }),
    thread({
      id: 't-ghost',
      runId: 'r-ship',
      paseoAgentId: 'paseo-ghost',
      status: 'failed',
      turns: [{ n: 1, prompt: 'plan', startedAt: at(5), endedAt: at(4), ok: false, error: 'The originating Paseo agent is unavailable' }],
    }),
  ]
  assert.equal(task(run, threads, {}).agentId, 'paseo-started')
  assert.equal(home(threads, [run], {}, 1, NOW).tasks[0].agentId, 'paseo-started')
  assert.equal(task(run, [threads[1]], { 't-started': 'agent-fallback' }).agentId, 'agent-fallback')
})

const taskRun = (stage: RawRun['stages'][number], extra: Partial<RawRun> = {}): RawRun => shipRun({ flow: 'task', plan: undefined, stages: [stage], ...extra })
const taskStage = (attempts: RawRun['stages'][number]['attempts'], status = 'running') => ({ name: 'task', status, startedAt: at(20), attempts })

test('run activity explains a worker retry with the latest result and precise rejection', () => {
  const r = taskRun(taskStage([
    attempt(1, 'first', { result: { status: 'done', summary: 'Identified a missing archived-chat test.', evidence: [] }, verdict: { verdict: 'fail', criteria: [fail] } }),
    attempt(2, 'second'),
  ]))
  const threads = [thread({ id: 'second', runId: r.id, status: 'running' })]
  assert.deepEqual(task(r, threads, {}).runActivity, {
    headline: 'Worker is retrying the task (attempt 2)',
    latestResult: 'Identified a missing archived-chat test.',
    retryReason: 'no game-over probe',
  })
  assert.equal(home(threads, [r], {}, 1, NOW).tasks[0].current, task(r, threads, {}).runActivity?.headline)
})

test('reviewer status wins over completed worker progress during a retry', () => {
  const r = taskRun(taskStage([
    attempt(1, 'first', { reason: 'The judge needs evidence.', ok: false }),
    attempt(2, 'second', { ok: true, judgeId: 'judge', result: { status: 'done', summary: 'Added evidence.', evidence: [] } }),
  ]))
  assert.deepEqual(task(r, [thread({ id: 'second', progress: 'SessionEnd' }), thread({ id: 'judge', status: 'running' })], {}).runActivity, {
    headline: 'Reviewer is checking the task (attempt 2)', latestResult: 'Added evidence.', retryReason: 'The judge needs evidence.',
  })
})

test('checks and interruptions explain retries without inventing judge verdicts', () => {
  for (const [previous, reason] of [
    [attempt(1, 'first', { checks: [{ cmd: 'npm test', code: 1, output: 'failed' }] }), 'npm test exited 1'],
    [attempt(1, 'first', { ok: false, reason: 'Lost when the daemon stopped.' }), 'Lost when the daemon stopped.'],
  ] as const) {
    const r = taskRun(taskStage([previous, attempt(2, 'second')]))
    assert.deepEqual(task(r, [], {}).runActivity, { headline: 'Worker is retrying the task (attempt 2)', retryReason: reason })
  }
})

test('passed retry clears its rejection while an independent audit is active', () => {
  const r = taskRun(taskStage([
    attempt(1, 'first', { ok: false, reason: 'Missing evidence.' }),
    attempt(2, 'second', { verdict: { verdict: 'pass', criteria: [pass] }, result: { status: 'done', summary: 'Added the missing evidence.', evidence: [] } }),
  ], 'passed'))
  const audit = thread({ id: 'audit', title: 'r-ship Audit abc123', runId: r.id, readOnly: true, status: 'running' })
  assert.deepEqual(task(r, [audit], {}).runActivity, { headline: 'Reviewer is auditing the result', latestResult: 'Added the missing evidence.' })
  assert.deepEqual(task(r, [], {}).runActivity, { headline: 'Finalizing run', latestResult: 'Added the missing evidence.' })
})

test('activity reports pending decisions and terminal outcomes without obsolete retry reasons', () => {
  const stage = taskStage([attempt(1, 'first', { ok: false, reason: 'Old rejection.' }), attempt(2, 'second', { result: { status: 'done', summary: 'Fixed the export.', evidence: [] } })])
  const cases: [Partial<RawRun>, { headline: string; latestResult: string }][] = [
    [{ status: 'asking', asks: [{ kind: 'approve', question: 'Approve this plan?', askedAt: at(1) }] }, { headline: 'Waiting for plan approval', latestResult: 'Fixed the export.' }],
    [{ status: 'asking', question: 'Which export format?' }, { headline: 'Waiting for your answer', latestResult: 'Fixed the export.' }],
    [{ status: 'failed', error: 'Build command exited 1' }, { headline: 'Build command exited 1', latestResult: 'Fixed the export.' }],
    [{ status: 'stopped' }, { headline: 'Run stopped', latestResult: 'Fixed the export.' }],
    [{ status: 'done' }, { headline: 'Finished', latestResult: 'Fixed the export.' }],
  ]
  for (const [extra, expected] of cases) assert.deepEqual(task(taskRun(stage, extra), [], {}).runActivity, expected)
})

test('activity distinguishes initial work and waiting review and omits boilerplate results', () => {
  assert.deepEqual(task(taskRun(taskStage([attempt(1, 'worker')])), [], {}).runActivity, { headline: 'Worker is working on the task' })
  assert.deepEqual(task(taskRun(taskStage([attempt(1, 'worker', { result: { status: 'done', summary: 'Done.', evidence: [] } })])), [], {}).runActivity, { headline: 'Waiting for review of the task' })
  assert.deepEqual(task(shipRun({ stages: [] }), [], {}).runActivity, { headline: 'Waiting to start' })
})


test('current worker failure differs from rejection and passed attempts do not cause obsolete retries', () => {
  assert.deepEqual(task(taskRun(taskStage([attempt(1, 'worker', { ok: false, reason: 'Provider unavailable.' })])), [], {}).runActivity, {
    headline: 'The task failed', retryReason: 'Provider unavailable.',
  })
  assert.deepEqual(task(taskRun(taskStage([
    attempt(1, 'worker', { reason: 'Old reason.', verdict: { verdict: 'pass', criteria: [pass] } }), attempt(2, 'next'),
  ])), [], {}).runActivity, { headline: 'Worker is working on the task (attempt 2)' })
})

test('task history reopens stopped and older runs and excludes removed work', () => {
  const old = at(3 * 24 * 60)
  const h = home([], [
    shipRun({ id: 'stop', status: 'stopped', endedAt: at(1) }),
    shipRun({ id: 'old', status: 'done', endedAt: old }),
    shipRun({ id: 'removed', status: 'failed', endedAt: old, archivedAt: old }),
    shipRun({ id: 'today', status: 'done', endedAt: at(1) }),
  ], {}, 1, NOW)
  assert.deepEqual(h.pastRuns?.map(r => r.id), ['stop', 'old'])
  assert.deepEqual(h.doneToday.map(r => r.id), ['today'])
})


const permissionAgent = 'ba8856e8-59c6-4e17-8c79-1d5168b8d731'
const permissionWorker = (extra: Partial<RawThread> = {}) => thread({
  id: 'worker', runId: 'r-ship', stage: 'task', status: 'running', paseoAgentId: permissionAgent,
  progress: 'Permission requested in Paseo worker ' + permissionAgent, nativeActivity: { permissionPending: true, observedAt: at(0) }, ...extra,
})

test('current managed worker permission request offers only its verified Paseo agent', () => {
  const r = taskRun(taskStage([attempt(1, 'worker')]))
  const worker = permissionWorker()
  assert.deepEqual(task(r, [worker], {}).runActivity, {
    headline: 'Worker needs your permission for the task', permissionAgentId: permissionAgent,
  })
  assert.equal(home([worker], [r], {}, 1, NOW).tasks[0].current, 'Worker needs your permission for the task')
  for (const extra of [
    { paseoAgentId: undefined }, { nativeActivity: undefined }, { nativeActivity: { permissionPending: false, observedAt: at(0) } }, { runId: 'another-run' },
    { archivedAt: at(1) }, { readOnly: true }, { status: 'queued' }, { status: 'idle' }, { status: 'failed' },
  ]) {
    const activity = task(r, [permissionWorker(extra)], {}).runActivity!
    assert.equal(activity.permissionAgentId, undefined)
    assert.doesNotMatch(activity.headline, /ba8856e8|Permission requested in Paseo/)
  }
})

test('resolved, historical, reviewed and terminal permission requests have no permission action', () => {
  const worker = permissionWorker()
  const r = taskRun(taskStage([attempt(1, 'worker')]))
  assert.deepEqual(task(r, [{ ...worker, nativeActivity: { permissionPending: false, observedAt: at(0) }, progress: 'Paseo worker resumed after permission request' }], {}).runActivity, {
    headline: 'Worker is working on the task — Paseo worker resumed after permission request',
  })
  for (const run of [
    taskRun(taskStage([attempt(1, 'worker'), attempt(2, 'next')])),
    taskRun(taskStage([attempt(1, 'worker')], 'passed')),
    taskRun(taskStage([attempt(1, 'worker', { endedAt: at(1) })])),
    taskRun(taskStage([attempt(1, 'worker', { result: { status: 'done', summary: 'Done.', evidence: [] } })])),
    taskRun(taskStage([attempt(1, 'worker', { judgeId: 'reviewer' })])),
    ...['done', 'stopped', 'failed', 'asking'].map(status => ({ ...r, status })),
  ]) assert.equal(task(run, [worker], {}).runActivity?.permissionAgentId, undefined)
})

test('native launcher clears permission progress as soon as Paseo resolves the request', () => {
  const base = mkdtempSync(join(tmpdir(), 'clyde-permission-'))
  const dist = join(base, 'cli/dist'), sdk = join(base, 'client/dist')
  mkdirSync(join(dist, 'utils'), { recursive: true })
  mkdirSync(sdk, { recursive: true })
  writeFileSync(join(base, 'package.json'), '{"type":"module"}')
  writeFileSync(join(dist, 'utils/daemon-target.js'), 'export const selectDaemonTarget=()=>({})')
  writeFileSync(join(dist, 'utils/client.js'), 'export const connectToDaemon=async()=>({close:async()=>{}})')
  writeFileSync(join(sdk, 'index.js'), `
    let listener,sent=false,polls=0
    const snapshot={provider:'codex',status:'idle',activeTurn:null,pendingPermissions:[],labels:{'clyde.run':'run-one','clyde.thread':'thread-one'}}
    const entries=[];const emit=event=>{if(event.type==='timeline')entries.push({turnId:event.turnId,item:event.item});listener?.({agentId:${JSON.stringify(permissionAgent)},event})}
    const child={id:${JSON.stringify(permissionAgent)},cwd:${JSON.stringify(base)},current:()=>snapshot,
      refresh:async()=>{if(sent){polls++;snapshot.pendingPermissions=polls===1?[{id:'request-one'}]:[];if(polls===2){snapshot.status='idle';snapshot.activeTurn=null;emit({type:'timeline',turnId:'turn-one',item:{type:'assistant_message',text:'finished'}});emit({type:'turn_completed',turnId:'turn-one'})}}},
      send:async(text,opts)=>{sent=true;snapshot.status='running';snapshot.activeTurn={turnId:'turn-one'};emit({type:'timeline',turnId:'turn-one',item:{type:'user_message',messageId:opts.messageId,text}})},
      timeline:{subscribe:fn=>{listener=fn;const unsubscribe=()=>{};unsubscribe.ready=Promise.resolve();return unsubscribe},refetch:async()=>({entries})}}
    export const createPaseoApi=()=>({agents:{ref:()=>child}})
  `)
  const output = execFileSync(process.execPath, [new URL('../src/paseo-worker.mjs', import.meta.url).pathname, dist], {
    input: JSON.stringify({ first: false, id: permissionAgent, parent: 'parent', cwd: base, backend: 'codex',run:'run-one',thread:'thread-one',messageId:'message-one', prompt: 'continue', timeoutMs: 5000 }),
    encoding: 'utf8',env:{...process.env,CLYDE_PASEO_POLL_MS:'10'},
  })
  const events = output.trim().split('\n').map(line => JSON.parse(line))
  assert.ok(events.some(e=>e.progress==='Permission requested in Paseo worker '+permissionAgent))
  assert.equal(events.filter(e=>e.workerState).at(-1)?.workerState.permissionPending,false)
  assert.equal(events.filter(e=>e.workerState).at(-1)?.workerState.status,'idle')
  assert.deepEqual(events.at(-1),{ok:true,text:'finished'})
})
