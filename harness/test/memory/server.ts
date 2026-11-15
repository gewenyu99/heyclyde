/** Tier 3 support: the memory Edge Function under deno, on schema memory rebuilt from the migrations and the made-up tea vault. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { join } from 'node:path'
import { request } from '../../src/request.ts'
import { type FakeAuth, startFakeAuth } from './auth.ts'
import { type FakeOpenAI, type FakeOptions, startFakeOpenAI } from './openai.ts'
import { FakeStorage } from './storage.ts'

export const DATABASE_URL = process.env.MEMORY_TEST_DATABASE_URL ?? ''
export const SKIP = DATABASE_URL ? false : 'set MEMORY_TEST_DATABASE_URL to the postgres database of a supabase/postgres container to run the memory tests'

const DENO = process.env.MEMORY_TEST_DENO || 'deno'
// index.ts behind a stand-in for the Supabase runtime's EdgeRuntime global.
const FUNCTION = join(import.meta.dirname, 'edge.ts')
const DATABASE = join(import.meta.dirname, 'database.ts')
// Without it, the harness's package.json puts deno in manual mode, where npm: imports have to be in harness/node_modules.
const NO_NODE_MODULES = '--node-modules-dir=none'

export type RealMemory = {
  storage?: FakeStorage; serviceKey?: string; log?: () => string
  url: string; token: string; runtimeToken: string; adminToken: string; researchToken: string; cronSecret: string; openai: FakeOpenAI; auth: FakeAuth
  close: () => Promise<void>
  /** The function's environment, so a second instance on the same database can start (startSibling). */
  env?: Record<string, string | undefined>
}

function database(args: string[], tokens: Record<string, string> = {}): string {
  const r = spawnSync(DENO, ['run', '-A', NO_NODE_MODULES, DATABASE, ...args], {
    encoding: 'utf8', timeout: 120_000, env: { ...process.env, SUPABASE_DB_URL: DATABASE_URL, ...tokens },
  })
  if (r.status !== 0) throw new Error(`database.ts ${args[0]} failed (${r.status}): ${r.stderr || r.stdout || r.error?.message}`)
  return r.stdout
}

/** The rows of one SQL statement on the test database, for what no route shows: hashes, absences, seeded rows. */
export function sql(statement: string): Record<string, any>[] {
  return JSON.parse(database(['sql', statement]))
}

/** Runs one migration file from memory/supabase/migrations on the test database again. */
export function apply(file: string): void {
  database(['apply', file])
}

/** Runs memory.purge_messages() and reports how long the database took, in ms. */
export function purge(): { ms: number; result: unknown } {
  return JSON.parse(database(['purge']))
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

/** A fresh schema memory and the function on it, with a device token, the runtime, admin and research tokens, and the cron secret.
 * close() stops the function and drops the schema. extraEnv is added to the function's environment. */
export async function startRealMemory(extraEnv: Record<string, string> = {}, options: { storage?: boolean; openai?: FakeOptions } = {}): Promise<RealMemory> {
  const token = `device-${randomBytes(8).toString('hex')}`
  const runtimeToken = `runtime-${randomBytes(8).toString('hex')}`
  const adminToken = `admin-${randomBytes(8).toString('hex')}`
  const researchToken = `research-${randomBytes(8).toString('hex')}`
  const cronSecret = `cron-${randomBytes(8).toString('hex')}`
  database(['reset'], {
    MEMORY_TEST_TOKEN: token, MEMORY_TEST_RUNTIME_TOKEN: runtimeToken, MEMORY_TEST_ADMIN_TOKEN: adminToken, MEMORY_TEST_RESEARCH_TOKEN: researchToken, MEMORY_TEST_CRON_SECRET: cronSecret,
  })
  // Embeddings, the write judge and the recall filter all go to the fake OpenAI, and sign-ins to the fake Supabase Auth,
  // so nothing leaves the machine.
  const openai = await startFakeOpenAI(options.openai)
  // With storage, a fake Supabase Storage answers under /storage/v1 on the same origin as SUPABASE_URL, and the function is
  // given a service role key, which is what switches its Storage on.
  const serviceKey = options.storage ? randomBytes(20).toString('hex') : undefined
  const storage = serviceKey ? new FakeStorage(serviceKey) : undefined
  const auth = await startFakeAuth(storage?.handle)
  // The function's port is picked once the fakes hold theirs. Picked before, a fake listening on port 0 could be handed
  // the same one, and the function would die with AddrInUse.
  const port = await freePort()
  const env = {
    ...process.env, SUPABASE_DB_URL: DATABASE_URL, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}`, MEMORY_OPENAI_URL: openai.url,
    SUPABASE_URL: auth.url, SUPABASE_ANON_KEY: 'fake-anon-key', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    ...(serviceKey ? { SUPABASE_SERVICE_ROLE_KEY: serviceKey, MEMORY_STORAGE_TIMEOUT_MS: '2000' } : {}), ...extraEnv,
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
    await auth.close()
    database(['drop'])
  }
  try {
    await waitHealthy(url, child, () => output)
  } catch (err) {
    await close()
    throw err
  }
  return { url, token, runtimeToken, adminToken, researchToken, cronSecret, openai, auth, close, storage, serviceKey, log: () => output, env }
}

/** A second function process on the same database and fakes as `memory`, as another Edge Function instance would be. It
 * shares nothing in memory with the first. close() stops only it. */
export async function startSibling(memory: RealMemory): Promise<{ url: string; close: () => Promise<void>; log: () => string }> {
  const port = await freePort()
  const child = spawn(DENO, ['run', '-A', NO_NODE_MODULES, FUNCTION], { env: { ...memory.env, DENO_SERVE_ADDRESS: `tcp:127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout?.on('data', (c) => (output += c))
  child.stderr?.on('data', (c) => (output += c))
  const url = `http://127.0.0.1:${port}/functions/v1/memory`
  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
  }
  try {
    await waitHealthy(url, child, () => output)
  } catch (err) {
    await close()
    throw err
  }
  return { url, close, log: () => output }
}

/** startRealMemory with a fake Supabase Storage (storage.ts) and a service role key, so the function's Storage is on. */
export const startStorageBed = (extraEnv: Record<string, string> = {}) => startRealMemory(extraEnv, { storage: true })
