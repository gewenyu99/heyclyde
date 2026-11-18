/** A fake pi 1.1.0: the real flag parser's rules, --mode json events, and sessions found by --session-id and cwd. */
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { exit, hangForever, logArgv, loadSession, out, readStdin, replyText, saveSession, sideEffects, sleep, stateDir, takeTurn } from './common.ts'
import type { FakeTurn, Session } from './common.ts'

const VALUE = new Set(['--provider', '--model', '--api-key', '--system-prompt', '--append-system-prompt', '--name', '-n',
  '--session', '--session-id', '--fork', '--session-dir', '--models', '--tools', '-t', '--exclude-tools', '-xt',
  '--thinking', '--export', '--extension', '-e', '--skill', '--prompt-template', '--theme', '--use-theme', '--tui-mode'])
const BOOL = new Set(['--help', '-h', '--version', '-v', '--continue', '-c', '--resume', '-r', '--no-session',
  '--no-tools', '-nt', '--no-builtin-tools', '-nbt', '--no-extensions', '-ne', '--no-mcp', '--no-skills', '-ns',
  '--no-prompt-templates', '-np', '--no-themes', '--no-context-files', '-nc', '--verbose', '--approve', '-a',
  '--no-approve', '-na', '--offline'])
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

type Args = { flags: Record<string, string[]>; bools: Set<string>; messages: string[]; files: string[]; errors: string[]; unknown: string[] }

/** Mirrors dist/cli/args.js: -p takes the next word as the prompt unless it starts with - or @. */
export function parse(argv: string[]): Args {
  const a: Args = { flags: {}, bools: new Set(), messages: [], files: [], errors: [], unknown: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      for (const rest of argv.slice(i + 1)) (rest.startsWith('@') ? a.files : a.messages).push(rest.replace(/^@/, ''))
      break
    } else if (arg === '--mode') {
      const mode = argv[i + 1]
      if (mode === undefined || mode.startsWith('-')) a.errors.push('--mode requires text, json, or rpc')
      else if (!['text', 'json', 'rpc'].includes(mode)) a.errors.push(`Invalid mode "${mode}". Valid values: text, json, rpc`), i++
      else (a.flags['--mode'] = [mode]), i++
    } else if (arg === '--print' || arg === '-p') {
      a.bools.add('--print')
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('@') && (!next.startsWith('-') || next.startsWith('---'))) a.messages.push(next), i++
    } else if (VALUE.has(arg) && i + 1 < argv.length) {
      ;(a.flags[arg] ??= []).push(argv[++i])
    } else if (BOOL.has(arg)) {
      a.bools.add(arg)
    } else if (arg.startsWith('@')) {
      a.files.push(arg.slice(1))
    } else if (arg.startsWith('--')) {
      a.unknown.push(arg.split('=')[0])
      const next = argv[i + 1]
      if (!arg.includes('=') && next !== undefined && !next.startsWith('-') && !next.startsWith('@')) i++
    } else if (arg.startsWith('-')) {
      a.errors.push(`Unknown option: ${arg}`)
    } else {
      a.messages.push(arg)
    }
  }
  return a
}

function flag(a: Args, ...names: string[]): string | undefined {
  for (const n of names) if (a.flags[n]) return a.flags[n].at(-1)
  return undefined
}

function fail(message: string): never {
  process.stderr.write(`Error: ${message}\n`)
  return exit(1)
}

function assistant(content: unknown[], model: string, extra: Record<string, unknown> = {}) {
  const [provider, id] = model.includes('/') ? model.split('/', 2) : ['fake', model]
  const usage = { input: 12, output: 4, cacheRead: 0, cacheWrite: 0, totalTokens: 16, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
  return { role: 'assistant', content, api: 'fake', provider, model: id, usage, stopReason: 'stop', timestamp: Date.now(), ...extra }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  logArgv('pi', argv)
  const a = parse(argv)
  if (a.errors.length) fail(a.errors[0])
  // No extension registers a flag here, so pi rejects any unknown long flag once extensions load.
  if (a.unknown.length) fail(`Unknown option: ${a.unknown[0]}`)
  if (a.bools.has('--version') || a.bools.has('-v')) {
    process.stdout.write('1.1.0\n')
    return exit(0)
  }
  for (const ext of a.flags['--extension'] ?? []) if (!existsSync(ext)) fail(`Failed to load extension "${ext}": file not found`)
  for (const ext of a.flags['-e'] ?? []) if (!existsSync(ext)) fail(`Failed to load extension "${ext}": file not found`)
  const thinking = flag(a, '--thinking')
  if (thinking && !THINKING.includes(thinking)) {
    process.stderr.write(`Warning: Invalid thinking level "${thinking}". Valid values: ${THINKING.join(', ')}\n`)
  }
  const mode = flag(a, '--mode') ?? 'text'
  if (mode === 'rpc') fail('the fake pi has no rpc mode')

  const piped = (await readStdin()) ?? ''
  const prompt = (piped.trim() + (a.messages[0] ?? '')).trim()
  const model = flag(a, '--model') ?? 'fake/fake-1'
  const cwd = process.cwd()
  const sessionId = flag(a, '--session-id') ?? randomUUID()
  const sessionDir = flag(a, '--session-dir') ?? 'default'
  // pi finds a --session-id only among sessions whose header cwd is this cwd.
  const key = `${sessionDir}|${sessionId}|${cwd}`
  let s: Session | null = a.bools.has('--no-session') ? null : loadSession('pi', key)
  if (!s) {
    if (flag(a, '--session-id')) process.stderr.write(`Warning: No project session found with id '${sessionId}'; creating a new session with that id.\n`)
    s = { id: sessionId, cwd, turns: [] }
  }
  s.turns.push({ prompt })
  if (!a.bools.has('--no-session')) saveSession('pi', key, s)

  const turn: FakeTurn = takeTurn(prompt)
  const json = mode === 'json'
  const emit = (e: unknown) => json && out(e)
  emit({ type: 'session', version: 3, id: s.id, timestamp: new Date().toISOString(), cwd })
  emit({ type: 'agent_start' })
  emit({ type: 'turn_start' })
  const user = { role: 'user', content: [{ type: 'text', text: prompt }], timestamp: Date.now() }
  emit({ type: 'message_start', message: user })
  emit({ type: 'message_end', message: user })

  process.on('SIGINT', () => exit(130))
  if (turn.crash) {
    process.stderr.write('fake pi crashed\n')
    return exit(turn.exit ?? 1)
  }
  if (turn.hang) return void (await hangForever(turn))
  if (turn.delayMs) await sleep(turn.delayMs)
  while (turn.waitForFile && !existsSync(join(stateDir(), turn.waitForFile))) await sleep(20)

  if (turn.error) {
    const msg = assistant([], model, { stopReason: 'error', errorMessage: turn.error })
    emit({ type: 'message_start', message: { ...msg, stopReason: 'pending' } })
    emit({ type: 'message_end', message: msg })
  } else {
    // pi's hooks live in the clyde extension, which only the real pi loads, so the fake runs every call.
    for (const e of sideEffects(turn, cwd)) {
      const id = `tool:${randomUUID()}`
      const tool = e.tool === 'Write' ? 'write' : 'bash'
      const args = e.tool === 'Write' ? { path: e.input.file_path } : e.input
      emit({ type: 'tool_execution_start', toolCallId: id, toolName: tool, args })
      emit({ type: 'tool_execution_end', toolCallId: id, toolName: tool, result: { content: [{ type: 'text', text: e.output }] }, isError: false, durationMs: 1 })
    }
    let text = replyText(turn, s, prompt)
    if (turn.json !== undefined) text = `${text}\n\n\`\`\`json\n${JSON.stringify(turn.json, null, 2)}\n\`\`\``
    s.turns[s.turns.length - 1].reply = text
    if (!a.bools.has('--no-session')) saveSession('pi', key, s)
    const msg = assistant([{ type: 'text', text }], model)
    emit({ type: 'message_start', message: { ...msg, content: [], stopReason: 'pending' } })
    emit({ type: 'message_end', message: msg })
    if (!json) process.stdout.write(`${text}\n`)
  }
  emit({ type: 'turn_end' })
  emit({ type: 'agent_end', messages: [], willRetry: false })
  emit({ type: 'agent_settled', aborted: false })
  if (turn.linger) return void (await hangForever())
  // JSON mode exits 0 even on a model error. Text mode exits 1.
  return exit(turn.exit ?? (turn.error && !json ? 1 : 0))
}

main()
