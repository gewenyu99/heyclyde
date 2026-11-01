/** Tier 3 support: the real memory server server from memory/ under uvicorn, on a scratch database loaded from the made-up test vault. */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { join } from 'node:path'
import { repoRoot } from '../../src/config.ts'
import { request } from '../../src/request.ts'

export const ADMIN_URL = process.env.MEMORY_TEST_DATABASE_URL ?? ''
export const SKIP = ADMIN_URL ? false : 'set MEMORY_TEST_DATABASE_URL to a Postgres admin URL to run the memory tests, e.g. postgresql://postgres@/postgres?host=/tmp&port=55432'

const MEMORY = join(repoRoot(), 'memory')
const PYTHON = process.env.KB_TEST_PYTHON || 'python3'

export type RealMemory = { url: string; token: string; runtimeToken: string; db: string; close: () => Promise<void> }

// Builds the vault the way memory/tests/conftest.py does, then loads seed.sql and db/schema.sql into a new database.
const CREATE = `
import sys, tempfile, pathlib
sys.path.insert(0, sys.argv[1])
import psycopg
from psycopg.conninfo import make_conninfo
from conftest import write_vault, compile_seed, MEMORY
root = write_vault(pathlib.Path(tempfile.mkdtemp(prefix="clyde-memory-seed-")))
built = compile_seed(root)
if built.returncode != 0:
    sys.exit("seed/build.py failed: " + built.stdout + built.stderr)
admin, name = sys.argv[2], sys.argv[3]
with psycopg.connect(admin, autocommit=True) as c:
    c.execute(f"drop database if exists {name}")
    c.execute(f"create database {name}")
url = make_conninfo(admin, dbname=name)
with psycopg.connect(url, autocommit=True) as c:
    c.execute((root / "out" / "seed.sql").read_text(encoding="utf-8"))
    c.execute((MEMORY / "db" / "schema.sql").read_text(encoding="utf-8"))
print(url)
`

const DROP = `
import sys, psycopg
with psycopg.connect(sys.argv[1], autocommit=True) as c:
    c.execute(f"drop database if exists {sys.argv[2]} with (force)")
`

function python(code: string, args: string[]): string {
  const r = spawnSync(PYTHON, ['-c', code, ...args], { encoding: 'utf8', cwd: MEMORY, timeout: 120_000 })
  if (r.status !== 0) throw new Error(`python failed (${r.status}): ${r.stderr || r.stdout}`)
  return r.stdout.trim()
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
  const deadline = Date.now() + 60_000
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

/** A fresh database and a memory server on it, with two different tokens. close() stops the server and drops the database. */
export async function startRealMemory(): Promise<RealMemory> {
  const db = `kb_lv_${process.pid}_${randomBytes(3).toString('hex')}`
  const dbUrl = python(CREATE, [join(MEMORY, 'tests'), ADMIN_URL, db])
  const port = await freePort()
  const token = `agent-${randomBytes(8).toString('hex')}`
  const runtimeToken = `runtime-${randomBytes(8).toString('hex')}`
  const env = {
    ...process.env, DATABASE_URL: dbUrl, MEMORY_TOKEN: token, MEMORY_RUNTIME_TOKEN: runtimeToken,
    // Ollama on a dead port, so hybrid ranks by keyword alone, as memory's own tests do.
    OLLAMA_URL: 'http://127.0.0.1:9', KB_EMBED_SYNC_SECONDS: '3600', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    PYTHONPATH: join(MEMORY, 'api'),
  }
  const child = spawn(PYTHON, ['-m', 'uvicorn', 'memory.server:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
    cwd: join(MEMORY, 'api'), env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (c) => (output += c))
  child.stderr?.on('data', (c) => (output += c))
  const url = `http://127.0.0.1:${port}`
  const close = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise((r) => child.once('exit', r))
    }
    python(DROP, [ADMIN_URL, db])
  }
  try {
    await waitHealthy(url, child, () => output)
  } catch (err) {
    await close()
    throw err
  }
  return { url, token, runtimeToken, db, close }
}
