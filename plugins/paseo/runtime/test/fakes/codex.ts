/** A fake codex-cli 0.162.1 `exec`: clap's flag rules including which flags may follow `resume`, and the JSONL events. */
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { exit, gitRepo, hangForever, locked, logArgv, loadSession, out, readStdin, replyText, saveSession, sideEffects, sleep, stateDir, takeTurn } from './common.ts'
import type { FakeTurn, Session } from './common.ts'

// Flags `resume` accepts too. The rest are exec-only and must come before `resume`.
const GLOBAL_VALUE = new Set(['-c', '--config', '--enable', '--disable', '-m', '--model', '--thread-source', '--cyber-access-program', '--output-schema', '-o', '--output-last-message'])
const GLOBAL_BOOL = new Set(['--json', '--experimental-json', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--strict-config', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--dangerously-bypass-hook-trust', '--worktree'])
const EXEC_VALUE = new Set(['-i', '--image', '--local-provider', '-p', '--profile', '-s', '--sandbox', '-C', '--cd', '--add-dir', '--color'])
const EXEC_BOOL = new Set(['--oss', '--approve-for-me', '--not-so-yolo', '-h', '--help', '-V', '--version'])
const RESUME_VALUE = new Set(['-i', '--image'])
const RESUME_BOOL = new Set(['--last', '--all', '-h', '--help'])
const CANON: Record<string, string> = {
  '--config': '-c', '--model': '-m', '--output-last-message': '-o', '--experimental-json': '--json', '--yolo': '--dangerously-bypass-approvals-and-sandbox',
  '--image': '-i', '--profile': '-p', '--sandbox': '-s', '--cd': '-C', '--not-so-yolo': '--approve-for-me',
}
const POSSIBLE: Record<string, { label: string; values: string[] }> = {
  '-s': { label: '--sandbox <SANDBOX_MODE>', values: ['read-only', 'workspace-write', 'danger-full-access'] },
  '--color': { label: '--color <COLOR>', values: ['always', 'never', 'auto'] },
}
const EXEC_USAGE = 'Usage: codex exec [OPTIONS] [PROMPT]\n       codex exec [OPTIONS] <COMMAND> [ARGS]'
const RESUME_USAGE = 'Usage: codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Args = { opts: Record<string, string[]>; bools: Set<string>; resume: boolean; positionals: string[] }

function usageError(message: string, resume: boolean): never {
  process.stderr.write(`error: ${message}\n\n${resume ? RESUME_USAGE : EXEC_USAGE}\n\nFor more information, try '--help'.\n`)
  return exit(2)
}

export function parse(argv: string[]): Args {
  const a: Args = { opts: {}, bools: new Set(), resume: false, positionals: [] }
  if (argv[0] !== 'exec') usageError(`the fake codex only knows exec, got '${argv[0] ?? ''}'`, false)
  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i]
    if (!a.resume && !a.positionals.length && raw === 'resume') {
      a.resume = true
      continue
    }
    if (raw === '-' || !raw.startsWith('-')) {
      a.positionals.push(raw)
      continue
    }
    const [name, inline] = raw.startsWith('--') && raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const takesValue = GLOBAL_VALUE.has(name) || (a.resume ? RESUME_VALUE.has(name) : EXEC_VALUE.has(name))
    const isBool = GLOBAL_BOOL.has(name) || (a.resume ? RESUME_BOOL.has(name) : EXEC_BOOL.has(name))
    if (!takesValue && !isBool) usageError(`unexpected argument '${name}' found`, a.resume)
    const key = CANON[name] ?? name
    if (isBool) {
      a.bools.add(key)
      continue
    }
    const value = inline ?? argv[++i]
    if (value === undefined) usageError(`a value is required for '${name}' but none was supplied`, a.resume)
    const choices = POSSIBLE[key]
    if (choices && !choices.values.includes(value)) {
      usageError(`invalid value '${value}' for '${choices.label}'\n  [possible values: ${choices.values.join(', ')}]`, a.resume)
    }
    ;(a.opts[key] ??= []).push(value)
  }
  return a
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  return exit(1)
}

function last(a: Args, key: string): string | undefined {
  return a.opts[key]?.at(-1)
}

/** One live exec per thread, as codex's thread-writer lock enforces across processes. */
function claimWriter(thread: string): string {
  const path = join(stateDir(), 'codex-writers', thread)
  locked(() => {
    mkdirSync(join(stateDir(), 'codex-writers'), { recursive: true })
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8'))
      let alive = false
      try {
        process.kill(pid, 0)
        alive = true
      } catch {
        // The holder is gone.
      }
      if (alive) fail(`Error: thread/resume: thread/resume failed: thread ${thread} already has an active writer (code -32600)`)
    }
    writeFileSync(path, String(process.pid))
  })
  return path
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  logArgv('codex', argv)
  const a = parse(argv)
  for (const c of a.opts['-c'] ?? []) {
    if (!c.includes('=') || c.startsWith('=')) fail(`Error parsing -c overrides: Invalid override (missing '='): ${c}`)
  }
  if (a.bools.has('--full-auto')) usageError(`unexpected argument '--full-auto' found`, a.resume)
  const cwd = resolve(last(a, '-C') ?? process.cwd())
  if (!a.bools.has('--skip-git-repo-check') && !a.bools.has('--dangerously-bypass-approvals-and-sandbox') && !gitRepo(cwd)) {
    fail('Not inside a trusted directory and --skip-git-repo-check was not specified.')
  }
  const schemaFile = last(a, '--output-schema')
  if (schemaFile && !existsSync(schemaFile)) fail(`Error: failed to read output schema file ${schemaFile}`)

  let s: Session | null = null
  let promptArg: string | undefined
  if (a.resume) {
    const [id, p] = a.positionals
    promptArg = p
    if (id && UUID.test(id)) {
      s = loadSession('codex', id)
      if (!s) fail(`Error: thread/resume: thread/resume failed: no rollout found for thread id ${id} (code -32600)`)
    }
    // A non-UUID id that names no thread silently starts a new one, as the real resume does.
  } else {
    promptArg = a.positionals[0]
  }
  const thread = s?.id ?? randomUUID()
  const session: Session = s ?? { id: thread, cwd, turns: [] }
  const writer = a.bools.has('--ephemeral') ? undefined : claimWriter(thread)
  const release = () => writer && rmSync(writer, { force: true })

  let prompt = ''
  if (promptArg === undefined || promptArg === '-') {
    if (promptArg === undefined) process.stderr.write('Reading prompt from stdin...\n')
    prompt = ((await readStdin()) ?? '').trim()
    if (!prompt) {
      release()
      fail('No prompt provided via stdin.')
    }
  } else prompt = promptArg
  session.turns.push({ prompt })
  if (!a.bools.has('--ephemeral')) saveSession('codex', thread, session)

  const turn: FakeTurn = takeTurn(prompt)
  out({ type: 'thread.started', thread_id: thread })
  out({ type: 'turn.started' })
  // SIGINT interrupts the turn: no turn event, no -o file, exit 1.
  process.on('SIGINT', () => {
    release()
    exit(1)
  })
  if (turn.crash) {
    release()
    process.stderr.write('fake codex crashed\n')
    return exit(turn.exit ?? 1)
  }
  if (turn.hang) return void (await hangForever(turn))
  if (turn.delayMs) await sleep(turn.delayMs)
  if (turn.error) {
    out({ type: 'error', message: `Reconnecting... 1/5 (${turn.error})` })
    out({ type: 'error', message: turn.error })
    out({ type: 'turn.failed', error: { message: turn.error } })
    release()
    return exit(turn.exit ?? 1)
  }
  let n = 0
  for (const e of sideEffects(turn, cwd)) {
    if (e.tool === 'Write') out({ type: 'item.completed', item: { id: `item_${n++}`, type: 'file_change', changes: [{ path: e.input.file_path, kind: 'add' }], status: 'completed' } })
    else out({ type: 'item.completed', item: { id: `item_${n++}`, type: 'command_execution', command: e.input.command, aggregated_output: e.output, exit_code: 0, status: 'completed' } })
  }
  const text = turn.json !== undefined && schemaFile ? JSON.stringify(turn.json) : replyText(turn, session, prompt)
  session.turns[session.turns.length - 1].reply = text
  if (!a.bools.has('--ephemeral')) saveSession('codex', thread, session)
  out({ type: 'item.completed', item: { id: `item_${n++}`, type: 'agent_message', text } })
  const tokens = 42 * session.turns.length
  out({ type: 'turn.completed', usage: { input_tokens: tokens, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 } })
  if (turn.exitDelayMs) {
    writeFileSync(join(stateDir(), 'codex-completed'), thread)
    await sleep(turn.exitDelayMs)
  }
  const lastFile = last(a, '-o')
  if (lastFile) writeFileSync(lastFile, text)
  release()
  return exit(turn.exit ?? 0)
}

main()
