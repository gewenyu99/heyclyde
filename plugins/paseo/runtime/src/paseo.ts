/**
 * Paseo, the local UI for the point man. The point man is a Claude Code agent in Paseo, so it runs the real claude binary on
 * the user's plan (ruling 4). The daemon wakes it through paseo-deliver.mjs, since paseo send would cut off a running tool call. Paseo listens on 127.0.0.1 and needs no account or relay.
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clydeBin, clydeHome } from './config.ts'
import { readJson, writeJson } from './store.ts'

export const POINT_MAN_LABEL = 'clyde=point-man'
const APP = '/Applications/Paseo.app'
const APP_BIN = `${APP}/Contents/Resources/bin/paseo`
const TIMEOUT_MS = 60_000

export type PaseoState = { agentId: string; cwd: string; createdAt: string }
export type Ran = { code: number | null; stdout: string; stderr: string; json: any; missing: boolean }

export const POINT_MAN_RULES = `You're Wen's point man. Keep talking with Wen. Delegate the work, then come straight back to chat.

- **Delegate first.** Delegate implementation and independent investigations to a background Clyde thread or flow. Keep interactive design in the foreground. Plan interactively with Wen. For code use a task or ship flow with a routing object. Set routing.complexity to complex for design, compatibility, permissions or concurrency changes, otherwise routine. Set routing.reason. Set routing.overrides to Wen's explicit choices by stage (planner, worker, audit, specReview, verify). Use sol, sonnet, opus, astra, neon, carbon, orchestrator or fable. Fable only reviews. Include the current lead as planner if Opus or Astra. Use draftPR:true only when Wen asks to open a PR. Use ship for substantial features, task for bounded changes. Give them a brief that stands alone, and use a worktree for code changes. Don't wait or poll for completion.
- **Keep tools narrow.** Use only clyde CLI calls in Bash and memory recall. You may read one or two files only to brief a worker. Discuss designs and acceptance criteria interactively. Delegate code edits and checks.
- **Use the memory server only.** Wen's memory lives there. Never read, write or rely on Claude Code's built-in file memory, including \`~/.claude/projects/*/memory\` and \`MEMORY.md\`.
- **Start and relay.** Use \`clyde status\`, \`clyde thread start --prompt "..." --title "..." [--cwd D] [--worktree]\`, \`clyde thread send <id> "..."\` and \`clyde thread read <id>\`. For flows, use \`clyde flow start task --input '{"prompt":"...","criteria":["..."],"checks":["npm test"]}'\`, \`clyde flow read <id>\` and \`clyde flow answer <id> "..."\`.
- **Let Wen answer.** At any skill checkpoint, including code-it-works' shape pitch, read the full pitch and relay it verbatim. Wait for Wen's answer, then pass it unchanged through \`clyde thread send\` or \`clyde flow answer\`. Never approve, infer an answer or answer for him. The verbatim pitch has no length limit.
- **Report events.** Messages starting with "clyde:" come from the daemon, not Wen. Read the thread or flow when needed. Keep routine updates to two sentences.

Reply with one line saying you're ready.`

/** CLYDE_PASEO_BIN, else paseo on PATH, else the CLI inside the Paseo desktop app. */
export function paseoBin(): string {
  if (process.env.CLYDE_PASEO_BIN) return process.env.CLYDE_PASEO_BIN
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const bin = join(dir, 'paseo')
    if (dir && existsSync(bin)) return bin
  }
  return existsSync(APP_BIN) ? APP_BIN : 'paseo'
}

export function statePath(): string {
  return join(clydeHome(), 'paseo.json')
}

export function readState(): PaseoState | null {
  const s = readJson<PaseoState>(statePath())
  return s && typeof s.agentId === 'string' ? s : null
}

export function saveState(state: PaseoState): void {
  writeJson(statePath(), state)
}

/** Runs paseo with --json and parses what it prints. Never throws. */
export function paseo(args: string[], timeoutMs = TIMEOUT_MS): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(paseoBin(), [...args, '--json'], { timeout: timeoutMs, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : null) : 0
      let json: any = null
      try {
        json = JSON.parse(stdout)
      } catch {
        // Not JSON, so the error is in stderr.
      }
      resolve({ code, stdout, stderr, json, missing: (err as any)?.code === 'ENOENT' })
    })
  })
}

function problem(r: Ran, what: string): Error {
  if (r.missing) return new Error(`${paseoBin()} is not installed`)
  const detail = r.json?.error?.message ?? (r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`)
  return new Error(`paseo ${what} failed: ${detail}`)
}

/** Why Paseo can't host the point man, or null when its daemon runs and Claude is available. */
export async function unavailable(): Promise<string | null> {
  const r = await paseo(['status'], 15_000)
  if (r.missing) return 'Paseo is not installed. Get it from paseo.sh/download'
  if (r.code !== 0 || r.json?.localDaemon !== 'running') return 'the Paseo daemon is not running. Open the Paseo app'
  const claude = (r.json.providers ?? []).find((p: any) => p.provider === 'claude')
  if (!claude?.available) return `Paseo can't run Claude Code${claude?.error ? `: ${claude.error}` : ''}`
  return null
}

/** Opens the Paseo desktop app when its daemon is stopped, and waits up to timeoutMs for the daemon to answer. */
export async function ensureRunning(timeoutMs = 45_000): Promise<string | null> {
  let why = await unavailable()
  if (!why || !why.startsWith('the Paseo daemon is not running') || process.platform !== 'darwin' || !existsSync(APP)) return why
  await new Promise<void>((resolve) => execFile('open', ['-g', '-a', APP], () => resolve()))
  const until = Date.now() + timeoutMs
  while (why && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 1000))
    why = await unavailable()
  }
  return why
}

export async function available(): Promise<boolean> {
  return (await unavailable()) === null
}

/** True when the saved agent still exists and isn't archived. */
export async function agentExists(id: string): Promise<boolean> {
  const r = await paseo(['inspect', id], 15_000)
  return r.code === 0 && r.json?.Id === id && !r.json?.Archived
}

/** Archives a saved Clyde agent, then confirms that Paseo marked it archived. */
export async function archive(id: string): Promise<void> {
  const before = await paseo(['inspect', id], 15_000)
  if (before.code !== 0 || before.json?.Id !== id) throw problem(before, 'inspect')
  if (!before.json.Archived) {
    const archived = await paseo(['archive', id])
    if (archived.code !== 0) throw problem(archived, 'archive')
  }
  const after = await paseo(['inspect', id], 15_000)
  if (after.code !== 0 || after.json?.Id !== id || after.json?.Archived !== true) throw problem(after, 'inspect archived agent')
}

/** Starts the point man as a background Claude agent in cwd, and returns its id. */
export async function createPointMan(cwd: string): Promise<string> {
  // clyde must be on the point man's PATH, next to the node that runs it.
  const path = [dirname(clydeBin()), join(process.env.HOME ?? '', '.local', 'bin'), dirname(process.execPath), process.env.PATH ?? ''].join(delimiter)
  const { preferences, profiles } = await import('./routing.ts')
  const lead = preferences(cwd).planner === 'astra' ? profiles.astra : profiles.opus
  const r = await paseo([
    'run', '-d', '--provider', lead.backend, '--model', lead.model, '--title', 'Point man', '--label', POINT_MAN_LABEL, '--cwd', cwd,
    '--env', `PATH=${path}`, '--env', `CLYDE_HOME=${clydeHome()}`, POINT_MAN_RULES,
  ], 120_000)
  const id = r.json?.agentId ?? r.json?.id ?? r.json?.Id ?? (Array.isArray(r.json) ? r.json[0]?.agentId ?? r.json[0]?.id : undefined)
  if (r.code !== 0 || typeof id !== 'string') throw problem(r, 'run')
  return id
}

/** Waits until the agent has no active turn. Rechecks status after wait before allowing a send. */
export async function waitForIdle(id: string): Promise<void> {
  for (;;) {
    const waited = await paseo(['wait', id, '--timeout', '50'], 55_000)
    const inspected = await paseo(['inspect', id], 15_000)
    if (inspected.code !== 0 || inspected.json?.Id !== id || inspected.json?.Archived) throw problem(inspected, 'inspect')
    if (inspected.json.Status === 'idle') return
    if (inspected.json.Status !== 'running') throw problem(waited.code !== 0 ? waited : inspected, 'wait')
    if (waited.code !== 0 && waited.code !== 1) throw problem(waited, 'wait')
  }
}

let sending: Promise<unknown> = Promise.resolve()
// The most times one message goes back to waiting because the turn changed under the send.
const GAP_RETRIES = 5
const DELIVER_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'paseo-deliver.mjs')

type DeliverCommand = { cmd: string; args: string[]; env: NodeJS.ProcessEnv }

/**
 * How to run paseo-deliver.mjs. CLYDE_PASEO_DELIVER names an executable that takes the agent id and reads the message on stdin.
 * Otherwise the script runs under the Paseo app's own runtime, the way the paseo wrapper script runs its CLI, because it
 * imports the CLI's client from inside app.asar. Null when this install has neither.
 */
function deliverCommand(id:string):DeliverCommand|null {
  return helperCommand(DELIVER_SCRIPT,[id],process.env.CLYDE_PASEO_DELIVER)
}
export function helperCommand(script:string, argv:string[], override?:string):DeliverCommand|null {
  if (override) return {cmd:override,args:argv,env:process.env}
  const bin = paseoBin()
  if (!bin.startsWith('/')) return null
  const resources = dirname(dirname(realpathSync(bin)))
  const runtime = join(resources, '..', 'Frameworks', 'Paseo Helper.app', 'Contents', 'MacOS', 'Paseo Helper')
  const runner = join(resources, 'app.asar.unpacked', 'dist', 'daemon', 'node-entrypoint-runner.js')
  if (!existsSync(runtime) || !existsSync(runner)) return null
  const cli = join(resources, 'app.asar', 'node_modules', '@getpaseo', 'cli', 'dist')
  return {
    cmd: runtime,
    args: ['--disable-warning=DEP0040', runner, 'node-script', script, cli, ...argv],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PASEO_NODE_ENV: 'production' },
  }
}

function deliver(id: string, text: string): Promise<Ran> {
  const command = deliverCommand(id)
  if (!command) return Promise.resolve({ code: null, stdout: '', stderr: '', json: null, missing: true })
  return new Promise((resolve) => {
    const child = spawn(command.cmd, command.args, { env: command.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    child.on('error', (err) => resolve({ code: null, stdout, stderr: String(err), json: null, missing: (err as any).code === 'ENOENT' }))
    child.on('close', (code) => {
      let json: any = null
      try { json = JSON.parse(stdout.trim().split('\n').at(-1) ?? '') } catch { /* The error is in stderr. */ }
      resolve({ code, stdout, stderr, json, missing: false })
    })
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}

/**
 * Sends a message to the point man without cutting off its turn. Paseo's own paseo send can't promise that. It leaves out
 * activeTurnBehavior, the daemon then defaults to "interrupt", and a send to a running agent cancels the tool call in
 * flight (see the notes in paseo-deliver.mjs). So the message goes out through paseo-deliver.mjs, which hands it to the
 * daemon as a one-run schedule. The daemon checks for a running turn and starts the run in one step, so a turn that starts
 * after waitForIdle, even a millisecond before the send, makes the daemon refuse and nothing is sent. A refused message
 * goes back to waiting for idle. Clyde's own sends are queued so none of them starts that turn. The daemon's check and its
 * start of the run are two steps, so a turn starting between them (a few milliseconds) gets the message as a steer queued
 * behind its running tool call, not a cancel (the notes in paseo-deliver.mjs name the lines).
 */
export function send(id: string, text: string): Promise<void> {
  const run = sending.then(() => sendWhenIdle(id, text))
  sending = run.catch(() => {})
  return run
}

async function sendWhenIdle(id: string, text: string): Promise<void> {
  if (!deliverCommand(id)) throw new Error('paseo send would interrupt a running turn, and this Paseo install has no runtime for the delivery script')
  for (let gap = 0; ; ) {
    await waitForIdle(id)
    const r = await deliver(id, text)
    if (r.code === 0 && r.json?.ok === true) return
    // The daemon found a turn running and sent nothing, so waiting again is always right.
    if (r.json?.busy === true) continue
    if (gap++ < GAP_RETRIES && !r.missing) continue
    throw new Error(`paseo deliver failed: ${r.json?.error ?? (r.stderr.trim().split('\n').at(-1) || `exit ${r.code}`)}`)
  }
}

/** Imports a Claude or Codex session as a Paseo agent named title, and returns the agent's id. */
export async function importSession(session: string, provider: string, cwd: string, labels: string[], title: string): Promise<string> {
  const r = await paseo(['import', session, '--provider', provider, '--cwd', cwd, ...labels.flatMap((l) => ['--label', l])])
  const id = r.json?.agentId
  if (r.code !== 0 || typeof id !== 'string') throw problem(r, 'import')
  await paseo(['agent', 'update', id, '--name', title])
  return id
}

/** Re-reads the agent's session from disk, so turns clyde ran since the import show up. */
export async function reload(id: string): Promise<void> {
  const r = await paseo(['agent', 'reload', id])
  if (r.code !== 0) throw problem(r, 'agent reload')
}

/** Opens the agent in the Paseo desktop app. */
export async function open(id: string): Promise<void> {
  const r = await paseo(['agent', 'open', id], 30_000)
  if (r.code !== 0) throw problem(r, 'agent open')
}
