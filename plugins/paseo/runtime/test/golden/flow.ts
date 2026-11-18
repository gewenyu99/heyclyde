/** Flow test support: scenarios from test/scenarios, golden event sequences here, and a daemon with a fake memory server. UPDATE_GOLDEN=1 rewrites the sequences. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DaemonClient } from '../../src/client.ts'
import { startDaemon, type Daemon } from '../../src/daemon.ts'
import type { Run } from '../../src/flow/types.ts'
import type { ClydeEvent, Rung } from '../../src/types.ts'
import type { FakeTurn } from '../fakes/common.ts'
import { startFakeMemory, type FakeMemory } from '../fakes/memory.ts'
import { flushPending } from '../../src/memory-flush.ts'
import { HARNESS, LV, setup, waitFor, type Setup } from '../helpers.ts'

export type Scenario = { turns: FakeTurn[]; roles?: Record<string, Rung[]> }
export type FlowSetup = Setup & { memory: FakeMemory; env: Record<string, string> }

const GOLDEN = join(HARNESS, 'test', 'golden')

export function scenario(name: string): Scenario {
  return JSON.parse(readFileSync(join(HARNESS, 'test', 'scenarios', `${name}.json`), 'utf8'))
}

/** A fresh CLYDE_HOME and repo, the named scenario for the fakes, its roles, and a fake memory server unless memory is false. */
export async function flowSetup(name: string, opts: { memory?: boolean } = {}): Promise<FlowSetup> {
  const sc = scenario(name)
  const memory = await startFakeMemory()
  const env: Record<string, string> = opts.memory === false ? {} : { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken }
  const s = setup(sc.turns, env)
  if (sc.roles) writeFileSync(join(s.home, 'roles.json'), JSON.stringify(sc.roles))
  return { ...s, memory, env }
}

export async function flowDaemon(): Promise<{ d: Daemon; client: DaemonClient }> {
  const d = await startDaemon({ port: 0 })
  return { d, client: new DaemonClient({ pid: process.pid, port: d.port, token: d.token }) }
}

/** Every event the run and its threads posted, read from events.jsonl so it spans daemon restarts. */
export function runEvents(home: string, runId: string): ClydeEvent[] {
  return readFileSync(join(home, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((e) => e.runId === runId)
}

export function matchGolden(name: string, events: ClydeEvent[]): void {
  const types = events.map((e) => e.type)
  const path = join(GOLDEN, `${name}.json`)
  if (process.env.UPDATE_GOLDEN === '1') {
    writeFileSync(path, JSON.stringify(types, null, 2) + '\n')
    return
  }
  let want: string[]
  try {
    want = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error(`no golden file ${path}. Run with UPDATE_GOLDEN=1 to write it.`)
  }
  assert.deepEqual(types, want, `the event sequence for ${name} changed. Rerun with UPDATE_GOLDEN=1 if that's on purpose.`)
}

export async function waitStatus(client: DaemonClient, id: string, statuses: string[], timeoutMs = 20_000): Promise<Run> {
  const run = await waitFor(async () => {
    const r: Run = await client.run(id)
    return statuses.includes(r.status) ? r : null
  }, timeoutMs, `run ${id} to reach ${statuses.join(' or ')}`)
  await flushPending({
    url: process.env.MEMORY_URL, agentToken: process.env.MEMORY_TOKEN, runtimeToken: process.env.MEMORY_RUNTIME_TOKEN,
  })
  return run
}

export type ClydeRun = { code: number | null; stdout: string; stderr: string }

/** The real clyde CLI in a child process, with this process's env, so it starts its own daemon in-process. */
export function clyde(args: string[], cwd: string): Promise<ClydeRun> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', async (code) => {
      await flushPending({ url: process.env.MEMORY_URL, runtimeToken: process.env.MEMORY_RUNTIME_TOKEN, agentToken: process.env.MEMORY_TOKEN })
      resolve({ code, stdout, stderr })
    })
  })
}
