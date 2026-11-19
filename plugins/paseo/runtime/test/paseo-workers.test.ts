import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backendLimit, permissionFailure } from '../src/flow/stage.ts'
import { flowDaemon } from './golden/flow.ts'
import { FAKE_BIN, setup, waitFor } from './helpers.ts'

test('permission denials are separate from quota errors', () => {
  const error =
    'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.'
  assert.ok(permissionFailure(error))
  assert.equal(backendLimit(error), false)
  assert.equal(permissionFailure('usage limit reached'), undefined)
})

test('native workers use the parent project and reuse their private task workspace across stages', () => {
  const base = mkdtempSync(join(tmpdir(), 'paseo-worker-'))
  const dist = join(base, 'cli/dist'), sdk = join(base, 'client/dist'), log = join(base, 'events')
  const checkout = join(base, 'worktree')
  mkdirSync(checkout)
  mkdirSync(join(dist, 'utils'), { recursive: true })
  mkdirSync(sdk, { recursive: true })
  writeFileSync(join(base, 'package.json'), '{"type":"module"}')
  writeFileSync(join(dist, 'utils/daemon-target.js'), 'export const selectDaemonTarget=()=>({})')
  writeFileSync(join(dist, 'utils/client.js'), 'export const connectToDaemon=async()=>({close:async()=>{}})')
  writeFileSync(
    join(sdk, 'index.js'),
    `
    import {appendFileSync,existsSync,readFileSync,writeFileSync} from 'node:fs'
    const put=x=>appendFileSync(process.env.WORKER_LOG,JSON.stringify(x)+'\\n')
    const saved=process.env.WORKER_LOG+'.workspace'
    const child={id:'child',cwd:process.env.CHILD_DIR,refresh:async()=>{},send:async()=>put('sent'),waitForFinish:async()=>({status:'idle',lastMessage:'finished'})}
    function handle(record){
      return {
        ...record,current:()=>record,refresh:async()=>record,
        agents:{create:async opts=>{put({workspace:record.id,child:opts});return child}},
      }
    }
    export const createPaseoApi=()=>({
      agents:{ref:id=>id==='parent'?{refresh:async()=>{},current:()=>({provider:'codex',currentModeId:'auto-review',workspaceId:'origin'})}:child},
      workspaces:{
        ref:id=>{
          if(id==='origin')return handle({id,directory:process.env.ORIGIN_DIR,projectId:'project'})
          const record=existsSync(saved)&&JSON.parse(readFileSync(saved,'utf8'))
          return handle(record?.id===id?record:null)
        },
        create:async opts=>{
          put({create:opts})
          const record={id:opts.workspaceId,projectId:opts.source.projectId,directory:opts.source.path,background:opts.background}
          writeFileSync(saved,JSON.stringify(record))
          return handle(record)
        },
      },
    })
  `,
  )
  const input = {
    first: true,
    id: 'child',
    thread: 'first-stage',
    run: 'r-original',
    messageId: 'one',
    cwd: checkout,
    title: 'Housekeeping · task #1 worker',
    taskTitle: 'Housekeeping',
    parent: 'parent',
    backend: 'antigravity',
    model: 'gemini-4-neon-high',
    prompt: 'hello',
    timeoutMs: 200,
  }
  const run = (allow: boolean, cwd: string, overrides: Partial<typeof input> = {}) => {
    writeFileSync(log, '')
    try {
      const out = execFileSync(process.execPath, [new URL('../src/paseo-worker.mjs', import.meta.url).pathname, dist], {
        input: JSON.stringify({ ...input, ...overrides, allowFullAccess: allow }),
        encoding: 'utf8',
        env: { ...process.env, ORIGIN_DIR: base, CHILD_DIR: cwd, WORKER_LOG: log },
      })
      return JSON.parse(out.trim().split('\n').at(-1)!)
    } catch (e) {
      return JSON.parse((e as { stdout: string }).stdout.trim().split('\n').at(-1)!)
    }
  }
  const events = () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  assert.match(run(false, checkout).error, /Permission required/)
  assert.deepEqual(events(), [])
  assert.match(run(true, base).error, /placement/)
  const [{ create }, agent] = events()
  assert.deepEqual(create.source, { kind: 'directory', path: realpathSync(checkout), projectId: 'project' })
  assert.equal(create.background, true)
  assert.equal(create.title, 'Housekeeping')
  assert.equal(create.callerAgentId, 'parent')
  assert.equal(agent.workspace, create.workspaceId)
  assert.equal(agent.child.parent, 'parent')
  assert.equal(agent.child.title, input.title)
  assert.equal(agent.child.background, true)
  assert.equal(agent.child.config.modeId, 'full-access')
  assert.equal(agent.child.config.provider, 'antigravity/gemini-4-neon-high')
  assert.equal(agent.child.prompt, undefined)
  assert.equal(run(true, checkout, { thread: 'second-stage' }).text, 'finished')
  const second = events()
  assert.equal(second.length, 2)
  assert.equal(second[0].workspace, create.workspaceId)
  assert.equal(second[0].child.labels['clyde.thread'], 'second-stage')
  assert.equal(second[1], 'sent')
  assert.equal(run(true, checkout, { first: false }).text, 'finished')
  assert.deepEqual(events(), ['sent'])
  assert.equal(run(true, base, { cwd: base }).text, 'finished')
  assert.equal(events()[0].workspace, 'origin')
})

test('starting a native task cuts the isolated branch without opening a visible mirror', async () => {
  const s = setup([], { CLYDE_PASEO_BIN: join(FAKE_BIN, 'paseo') })
  const worker = join(s.state, 'worker')
  const launch = join(s.state, 'launch.json')
  writeFileSync(join(s.home, 'paseo.json'), JSON.stringify({ agentId: 'parent' }))
  writeFileSync(join(s.state, 'paseo.json'), '{}')
  writeFileSync(
    worker,
    `#!/usr/bin/env node
    let input=''
    for await (const chunk of process.stdin) input+=chunk
    const {writeFileSync}=await import('node:fs')
    writeFileSync(${JSON.stringify(launch)},input)
    setInterval(()=>{},60000)
  `,
    { mode: 0o755 },
  )
  process.env.CLYDE_PASEO_WORKER_BIN = worker
  const { d, client } = await flowDaemon()
  try {
    const run = await client.call<{ id: string; cwd: string }>('POST', '/runs', {
      flow: 'task',
      cwd: s.repo,
      input: { title: 'Memory housekeeping', prompt: 'Review stale memories', criteria: ['report'] },
      paseoParentId: 'parent',
    })
    await waitFor(() => existsSync(launch))
    const input = JSON.parse(readFileSync(launch, 'utf8'))
    assert.equal(run.cwd, join(s.home, 'worktrees', run.id))
    assert.equal(
      execFileSync('git', ['-C', run.cwd, 'branch', '--show-current'], { encoding: 'utf8' }).trim(),
      'clyde/' + run.id,
    )
    assert.equal(input.cwd, run.cwd)
    assert.equal(input.parent, 'parent')
    assert.equal(input.taskTitle, 'Memory housekeeping')
    assert.equal(input.title, 'Memory housekeeping · task #1 worker')
    const log = join(s.state, 'paseo-argv.jsonl')
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []
    assert.ok(!calls.some((args) => args[0] === 'workspace' && args[1] === 'create'))
  } finally {
    await d.close()
  }
})

test('removing a queued run is idempotent and its record and worktree survive a daemon restart', async () => {
  const s = setup([{ match: 'worker for stage task', hang: true }])
  let { d, client } = await flowDaemon()
  try {
    const run = await client.startRun('task', { prompt: 'queue removal check', criteria: ['report'] }, s.repo)
    const path = '/runs/' + run.id + '/archive'
    const a = await client.call<{ archivedAt: string; status: string }>('POST', path, {})
    assert.equal(a.status, 'stopped')
    assert.ok(a.archivedAt)
    assert.equal((await client.call<{ archivedAt: string }>('POST', path, {})).archivedAt, a.archivedAt)
    await d.close()
    ;({ d, client } = await flowDaemon())
    const recovered = await client.run(run.id)
    assert.equal(recovered.archivedAt, a.archivedAt)
    assert.equal(readFileSync(join(recovered.cwd, 'README.md'), 'utf8'), '# test repo\n')
  } finally {
    await d.close()
  }
})
