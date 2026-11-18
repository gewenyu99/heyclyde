/** The happier CLI, for reaching the point man from a phone: sign-in check, the point man session, send and notify. */
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { clydeHome } from './config.ts'
import { readJson, writeJson } from './store.ts'

export const POINT_MAN_TAG = 'clyde-point-man'
const TIMEOUT_MS = 60_000

export type HappierState = { sessionId: string; tag: string; cwd: string; createdAt: string }
export type Ran = { code: number | null; stdout: string; stderr: string; json: any; missing: boolean }

export function happierBin(): string {
  return process.env.CLYDE_HAPPIER_BIN || 'happier'
}

export function statePath(): string {
  return join(clydeHome(), 'happier.json')
}

export function readState(): HappierState | null {
  const s = readJson<HappierState>(statePath())
  return s && typeof s.sessionId === 'string' ? s : null
}

export function saveState(state: HappierState): void {
  writeJson(statePath(), state)
}

/** Runs happier and parses the JSON envelope it prints with --json. Never throws. */
export function happier(args: string[], timeoutMs = TIMEOUT_MS): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(happierBin(), args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : null) : 0
      resolve({ code, stdout, stderr, json: envelope(stdout), missing: (err as any)?.code === 'ENOENT' })
    })
  })
}

/** The last line of stdout that parses as a JSON object, since happier may print warnings first. */
function envelope(stdout: string): any {
  for (const line of stdout.trim().split('\n').reverse()) {
    try {
      const v = JSON.parse(line)
      if (v && typeof v === 'object') return v
    } catch {
      // Not the envelope.
    }
  }
  try {
    return JSON.parse(stdout)
  } catch {
    return null
  }
}

function succeeded(r: Ran): boolean {
  return r.code === 0 && r.json?.ok === true
}

function problem(r: Ran, what: string): Error {
  if (r.missing) return new Error(`${happierBin()} is not on PATH`)
  const code = r.json?.error?.code ?? r.json?.error?.message
  const detail = code ?? (r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`)
  return new Error(`happier ${what} failed: ${detail}`)
}

/** Why Happier can't be used, or null when it's on PATH and signed in. */
export async function unavailable(): Promise<string | null> {
  const auth = await happier(['auth', 'status', '--json'], 15_000)
  if (auth.missing) return `${happierBin()} is not on PATH`
  if (succeeded(auth)) return null
  // Older builds without auth status --json still answer a session list when signed in.
  const list = await happier(['session', 'list', '--limit', '1', '--json'], 15_000)
  if (succeeded(list)) return null
  return 'happier is not signed in. Run happier auth login'
}

export async function available(): Promise<boolean> {
  return (await unavailable()) === null
}

/** The exact flags from PLAN "Happier". --auth native keeps pi on its own agent dir, so the clyde extension loads. */
export function createArgs(cwd: string): string[] {
  return [
    'session', 'create', '--backend', 'pi', '--path', cwd, '--title', 'Point man', '--tag', POINT_MAN_TAG,
    '--auth', 'native', '--permission-mode', 'auto', '--env', 'CLYDE_POINT_MAN=1', '--env', 'CLYDE_DELIVERY=happier', '--json',
  ]
}

/** Creates the point man session and returns its id. */
export async function createPointMan(cwd: string): Promise<string> {
  const r = await happier(createArgs(cwd))
  if (!succeeded(r)) throw problem(r, 'session create')
  const s = r.json.data?.session
  const id = s?.id ?? s?.sessionId ?? r.json.data?.sessionId
  if (typeof id !== 'string' || !id) throw new Error('happier session create answered without a session id')
  return id
}

/** True when happier still knows the session. */
export async function sessionExists(id: string): Promise<boolean> {
  return succeeded(await happier(['session', 'status', id, '--json'], 15_000))
}

/** Queues text as a user message in the session, so the turn runs through Happier and ends with a push. */
export async function send(sessionOrTag: string, text: string): Promise<void> {
  const r = await happier(['session', 'send', sessionOrTag, text, '--json'])
  if (!succeeded(r)) throw problem(r, 'session send')
}

/** A push with no agent turn. notify has no --json, so success is exit 0. */
export async function notify(title: string, message: string): Promise<void> {
  const r = await happier(['notify', '-p', message, '-t', title])
  if (r.code !== 0) throw problem(r, 'notify')
}
