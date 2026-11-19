/** Where clyde keeps its state, where the repo is, and the knobs that come from the environment. */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VERSION = '0.1.0'

export type DaemonInfo = { pid: number; port: number; token: string }

export function clydeHome(): string {
  return process.env.CLYDE_HOME || join(homedir(), '.clyde')
}

// Deprecated: the names from when memory was called kb. clyde reads them for one release, warns, and then drops them.
const RENAMED: Record<string, string> = {
  KB_URL: 'MEMORY_URL', KB_TOKEN: 'MEMORY_TOKEN', KB_RUNTIME_TOKEN: 'MEMORY_RUNTIME_TOKEN', CLYDE_KB_SCOPE: 'CLYDE_MEMORY_SCOPE',
}

function warnRenamed(old: string, where: string): void {
  console.error(`clyde: ${old}${where} is deprecated. Rename it ${RENAMED[old]}. The next release stops reading ${old}.`)
}

/**
 * Moves each deprecated name's value to its new name, unless the new name is set already, and removes the old one, so
 * no worker inherits it. bin/clyde.ts, the pi extension and loadMemoryEnv call it first thing.
 */
export function adoptRenamedEnv(env: NodeJS.ProcessEnv = process.env): void {
  for (const [old, name] of Object.entries(RENAMED)) {
    if (env[old] === undefined) continue
    warnRenamed(old, '')
    env[name] ??= env[old]
    delete env[old]
  }
}

/**
 * MEMORY_URL, MEMORY_TOKEN and MEMORY_RUNTIME_TOKEN from <CLYDE_HOME>/memory.env (KEY=VALUE lines, export optional), for any the
 * environment leaves unset. The daemon, doctor and up call it, so a daemon started from anywhere reaches memory.
 * Workers never call it, so the runtime token stays the daemon's.
 */
export function loadMemoryEnv(env: NodeJS.ProcessEnv = process.env): void {
  adoptRenamedEnv(env)
  let text = ''
  try {
    text = readFileSync(join(clydeHome(), 'memory.env'), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?(MEMORY_URL|MEMORY_TOKEN|MEMORY_RUNTIME_TOKEN|KB_URL|KB_TOKEN|KB_RUNTIME_TOKEN)=["']?([^"'\s]*)["']?\s*$/)
    if (!m || !m[2]) continue
    if (RENAMED[m[1]]) warnRenamed(m[1], ' in memory.env')
    const name = RENAMED[m[1]] ?? m[1]
    if (!env[name]) env[name] = m[2]
  }
}

export function harnessRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

export function repoRoot(): string {
  return resolve(harnessRoot(), '..')
}

/** The clyde entry point, run with node, so hooks and workers reach the same CLI whatever is on PATH. */
export function clydeBin(): string {
  return join(harnessRoot(), 'bin', 'clyde.ts')
}

export function canonicalBin(): string {
  const bin = clydeBin()
  try { return realpathSync(bin) } catch { return bin }
}

export function runtimeFingerprint(root = harnessRoot()): string {
  const hash = createHash('sha256')
  let base: string
  if (root === harnessRoot()) {
    base = canonicalBin()
  } else {
    try { base = realpathSync(root) } catch { base = root }
  }
  hash.update(base + '\n')
  const walk = (dir: string) => {
    let entries: string[]
    try { entries = readdirSync(dir).sort() } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        walk(full)
      } else if (st.isFile()) {
        hash.update(relative(root, full).replaceAll('\\', '/') + '\n')
        hash.update(readFileSync(full))
        hash.update('\n')
      }
    }
  }
  for (const sub of ['bin', 'src', 'flows']) walk(join(root, sub))
  return hash.digest('hex').slice(0, 16)
}

export function daemonInfoPath(): string {
  return join(clydeHome(), 'daemon.json')
}

export function readDaemonInfo(): DaemonInfo | null {
  try {
    const info = JSON.parse(readFileSync(daemonInfoPath(), 'utf8'))
    return typeof info?.port === 'number' && typeof info?.token === 'string' ? info : null
  } catch {
    return null
  }
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return process.env[name] !== undefined && process.env[name] !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}

export function daemonPort(): number {
  return intEnv('CLYDE_PORT', 7477)
}

export function turnTimeoutMs(): number {
  return intEnv('CLYDE_TURN_TIMEOUT_MS', 45 * 60 * 1000)
}

export function maxTurns(): number {
  return Math.max(1, intEnv('CLYDE_MAX_TURNS', 6))
}

/** How long a cancelled worker gets between SIGINT and SIGKILL. Tests shorten it. */
export function killGraceMs(): number {
  return intEnv('CLYDE_KILL_GRACE_MS', 10_000)
}
