/** What the fake CLIs share: the scenario file, consumed turns, sessions, the argv log, and each turn's side effects. */
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export type FakeTurn = {
  match?: string; reply?: string; write?: Record<string, string>; commit?: string; clydeResult?: Record<string, unknown>
  // Real clyde todo calls, run first, each the words after "clyde todo", like ["start", "1", "--how", "edit the file"].
  todo?: string[][]
  json?: unknown; error?: string; crash?: boolean; hang?: boolean; delayMs?: number; exit?: number
  // pi only: hold the turn until this file exists in the fake state dir, so a test decides when the worker finishes.
  waitForFile?: string
  // Codex only: keep the writer alive after turn.completed.
  exitDelayMs?: number
  // pi only: stay alive after agent_settled, like an extension that leaked a timer.
  linger?: boolean
  // With hang: ignore SIGINT, so only SIGKILL ends it.
  stubborn?: boolean
}
export type Scenario = { turns: FakeTurn[]; runHooks?: boolean }
export type Session = { id: string; cwd: string; turns: { prompt: string; reply?: string }[] }

export const HARNESS = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const CLYDE_BIN = join(HARNESS, 'bin', 'clyde.ts')

const ENV_RECORDED = ['CLYDE_HOME', 'CLYDE_THREAD_ID', 'CLYDE_RUN_ID', 'CLYDE_MEMORY_SCOPE', 'CLAUDE_PLUGIN_ROOT', 'IS_SANDBOX', 'MEMORY_URL', 'MEMORY_TOKEN']

export function stateDir(): string {
  const dir = process.env.CLYDE_FAKE_STATE_DIR || join(tmpdir(), 'clyde-fake-state')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Every argv the fake received, before any parsing, so tests can assert exact flags even for refused calls. */
export function logArgv(bin: string, argv: string[]): void {
  const env: Record<string, string | undefined> = {}
  for (const k of ENV_RECORDED) env[k] = process.env[k]
  const line = { bin, argv, cwd: process.cwd(), env, envKeys: Object.keys(process.env).sort(), at: new Date().toISOString() }
  appendFileSync(join(stateDir(), 'argv.jsonl'), JSON.stringify(line) + '\n')
}

export function scenario(): Scenario {
  const path = process.env.CLYDE_FAKE_SCENARIO
  if (!path) return { turns: [] }
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A mkdir lock, since parallel threads run parallel fakes against one state dir. A killed holder's lock is broken. */
export function locked<T>(fn: () => T): T {
  const lock = join(stateDir(), 'lock')
  for (let i = 0; ; i++) {
    try {
      mkdirSync(lock)
      writeFileSync(join(lock, 'pid'), String(process.pid))
      break
    } catch {
      try {
        const holder = Number(readFileSync(join(lock, 'pid'), 'utf8'))
        if ((holder && !alive(holder)) || Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true })
      } catch {
        // The holder hasn't written its pid yet, or already released the lock.
      }
      if (i > 2000) throw new Error('fake: state lock stuck')
      sleepSync(5)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { recursive: true, force: true })
  }
}

function readJsonFile<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return fallback
  }
}

/** The first unconsumed turn whose match fits the prompt. A prompt nothing matches gets a plain reply. */
export function takeTurn(prompt: string): FakeTurn {
  const turns = scenario().turns ?? []
  return locked(() => {
    const path = join(stateDir(), 'consumed.json')
    const consumed: number[] = readJsonFile(path, [])
    const i = turns.findIndex((t, i) => !consumed.includes(i) && (!t.match || new RegExp(t.match).test(prompt)))
    if (i < 0) return {}
    writeFileSync(path, JSON.stringify([...consumed, i]))
    return turns[i]
  })
}

function sessionPath(kind: string, key: string): string {
  return join(stateDir(), 'sessions', kind, `${key.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
}

export function loadSession(kind: string, key: string): Session | null {
  return readJsonFile<Session | null>(sessionPath(kind, key), null)
}

export function saveSession(kind: string, key: string, s: Session): void {
  const path = sessionPath(kind, key)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(s, null, 2))
}

/** {{turn}}, {{session}}, {{prompt}} and {{history}} let a test see that a resumed session kept its earlier turns. */
export function replyText(turn: FakeTurn, s: Session, prompt: string): string {
  const template = turn.reply ?? 'turn {{turn}}: {{prompt}}'
  const history = s.turns.slice(0, -1).map((t) => t.prompt).join(' | ')
  return template
    .replaceAll('{{turn}}', String(s.turns.length)).replaceAll('{{session}}', s.id)
    .replaceAll('{{prompt}}', prompt).replaceAll('{{history}}', history)
}

/** One tool call a fake made: Claude's tool name and input, what it printed, and whether a hook blocked it. */
export type Effect = { tool: string; input: Record<string, unknown>; output: string; blocked?: boolean }
/** A PreToolUse check: the reason the call must wait, or null. Claude runs its real hooks here. pi has none. */
export type Gate = (tool: string, input: Record<string, unknown>) => string | null

/** clyde todo calls, files, a commit and an `clyde result`, done for real in the worker's directory, each asked of gate first. */
export function sideEffects(turn: FakeTurn, cwd: string, gate: Gate = () => null): Effect[] {
  const done: Effect[] = []
  const call = (tool: string, input: Record<string, unknown>, run: () => string) => {
    const why = gate(tool, input)
    if (why) {
      done.push({ tool, input, output: why, blocked: true })
      record('blocked.jsonl', { tool, input, reason: why })
      return
    }
    done.push({ tool, input, output: run() })
  }
  for (const args of turn.todo ?? []) {
    call('Bash', { command: `clyde todo ${args.map(shq).join(' ')}` }, () => clydeTodo(args))
  }
  for (const [rel, content] of Object.entries(turn.write ?? {})) {
    const path = join(cwd, rel)
    call('Write', { file_path: path, content }, () => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, content)
      return `wrote ${path}`
    })
  }
  if (turn.commit) {
    const message = turn.commit
    call('Bash', { command: `git add -A && git commit -q -m ${shq(message)}` }, () => {
      const env = { ...process.env, GIT_AUTHOR_NAME: 'fake', GIT_AUTHOR_EMAIL: 'fake@clyde', GIT_COMMITTER_NAME: 'fake', GIT_COMMITTER_EMAIL: 'fake@clyde' }
      execFileSync('git', ['-C', cwd, 'add', '-A'], { env, stdio: 'ignore' })
      execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', message], { env, stdio: 'ignore' })
      return `committed ${message}`
    })
  }
  if (turn.clydeResult) {
    const result = turn.clydeResult
    call('Bash', { command: `clyde result --status ${shq(String(result.status ?? 'done'))}` }, () => postResult(result))
  }
  return done
}

function shq(s: string): string {
  return /^[A-Za-z0-9._:/=-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

/** One JSON line in the state dir, so a test can see what the fakes ran and what clyde refused. */
export function record(file: string, value: unknown): void {
  appendFileSync(join(stateDir(), file), JSON.stringify(value) + '\n')
}

/** The real clyde todo, as a worker runs it from its shell. Prints what clyde printed. */
function clydeTodo(args: string[]): string {
  const r = spawnSync(process.execPath, [CLYDE_BIN, 'todo', ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  record('todo.jsonl', { args, code: r.status, stdout: r.stdout, stderr: r.stderr })
  return `${r.stdout}${r.stderr}`.trim()
}

function postResult(result: Record<string, unknown>): string {
  const args = [CLYDE_BIN, 'result', '--status', String(result.status ?? 'done'), '--summary', String(result.summary ?? '')]
  let dir: string | undefined
  if (result.evidence !== undefined) {
    dir = mkdtempSync(join(tmpdir(), 'clyde-fake-evidence-'))
    writeFileSync(join(dir, 'evidence.json'), JSON.stringify(result.evidence))
    args.push('--evidence-file', join(dir, 'evidence.json'))
  }
  const r = spawnSync(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  record('results.jsonl', { status: result.status, code: r.status, stdout: r.stdout, stderr: r.stderr })
  if (r.status !== 0) process.stderr.write(`fake: clyde result exited ${r.status}: ${r.stderr}`)
  if (dir) rmSync(dir, { recursive: true, force: true })
  return `${r.stdout}${r.stderr}`.trim()
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Reads stdin to EOF when it isn't a TTY, as all three CLIs do. An open pipe that never closes hangs here, like them. */
export function readStdin(capMs?: number): Promise<string | null> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    if (capMs) {
      timer = setTimeout(() => {
        process.stdin.pause()
        resolve(chunks.length ? Buffer.concat(chunks).toString('utf8') : null)
      }, capMs)
    }
    process.stdin.on('data', (c: Buffer) => chunks.push(c))
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    process.stdin.on('error', () => resolve(''))
  })
}

export function out(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/** Stops now. Writes to a pipe or a file are synchronous on Linux, so a piped reader still sees every line. */
export function exit(code: number): never {
  process.exit(code)
}

/** Never finishes on its own. The caller's signal handlers decide what a signal does, unless the turn is stubborn. */
export function hangForever(turn: FakeTurn = {}): Promise<never> {
  if (turn.stubborn) {
    process.removeAllListeners('SIGINT')
    process.on('SIGINT', () => {})
  }
  setInterval(() => {}, 60_000)
  return new Promise(() => {})
}

export function gitRepo(dir: string): boolean {
  return existsSync(dir) && spawnSync('git', ['-C', dir, 'rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0
}
