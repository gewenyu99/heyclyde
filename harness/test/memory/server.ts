/** Tier 3 support: the memory Edge Function under deno, on schema memory rebuilt from the migrations and the made-up tea vault. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { join } from 'node:path'
import { repoRoot } from '../../src/config.ts'
import { request } from '../../src/request.ts'
import { type FakeOpenAI, startFakeOpenAI } from './openai.ts'

export const DATABASE_URL = process.env.MEMORY_TEST_DATABASE_URL ?? ''
export const SKIP = DATABASE_URL ? false : 'set MEMORY_TEST_DATABASE_URL to the postgres database of a supabase/postgres container to run the memory tests'

const DENO = process.env.MEMORY_TEST_DENO || 'deno'
const FUNCTION = join(repoRoot(), 'memory', 'supabase', 'functions', 'memory', 'index.ts')
const DATABASE = join(import.meta.dirname, 'database.ts')
// Without it, the harness's package.json puts deno in manual mode, where npm: imports have to be in harness/node_modules.
const NO_NODE_MODULES = '--node-modules-dir=none'

export type RealMemory = { url: string; token: string; runtimeToken: string; openai: FakeOpenAI; close: () => Promise<void> }

function database(command: 'reset' | 'drop', tokens: Record<string, string> = {}): void {
  const r = spawnSync(DENO, ['run', '-A', NO_NODE_MODULES, DATABASE, command], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL, ...tokens },
  })
  if (r.status !== 0) throw new Error(`database.ts ${command} failed (${r.status}): ${r.stderr || r.stdout || r.error?.message}`)
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

async function waitHealthy(url: string, child: ChildProcess, log: () => string): Promise<void> {
  // The first start downloads the function's npm and jsr imports.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`memory exited ${child.exitCode}:\n${log()}`)
    try {
      if ((await request('GET', `${url}/healthz`, { timeoutMs: 2000 })).status === 200) return
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`memory never answered /healthz:\n${log()}`)
}

/** A fresh schema memory and the function on it, with a device token and the runtime token. close() stops the function and drops the schema. */
export async function startRealMemory(): Promise<RealMemory> {
  const token = `device-${randomBytes(8).toString('hex')}`
  const runtimeToken = `runtime-${randomBytes(8).toString('hex')}`
  database('reset', { MEMORY_TEST_TOKEN: token, MEMORY_TEST_RUNTIME_TOKEN: runtimeToken })
  const port = await freePort()
  // Embeddings, the write judge and the recall filter all go to the fake, so nothing leaves the machine.
  const openai = await startFakeOpenAI()
  const env = {
    ...process.env, SUPABASE_DB_URL: DATABASE_URL, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`, MEMORY_OPENAI_URL: openai.url,
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
  }
  const child = spawn(DENO, ['run', '-A', NO_NODE_MODULES, FUNCTION], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (c) => (output += c))
  child.stderr?.on('data', (c) => (output += c))
  // The deployed function's path, so routes read the way MEMORY_URL makes them.
  const url = `http://127.0.0.1:${port}/functions/v1/memory`
  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
    await openai.close()
    database('drop')
  }
  try {
    await waitHealthy(url, child, () => output)
  } catch (err) {
    await close()
    throw err
  }
  return { url, token, runtimeToken, openai, close }
}
