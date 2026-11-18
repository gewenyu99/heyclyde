/** A fake Claude Code 2.1.296 in -p mode: its commander flags and errors, stream-json and json output, and sessions by id. */
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { exit, hangForever, logArgv, loadSession, out, readStdin, record, replyText, saveSession, scenario, sideEffects, sleep, takeTurn } from './common.ts'
import type { FakeTurn, Session } from './common.ts'

type Arity = 'bool' | 'value' | 'optional' | 'variadic'
const OPTIONS: Record<string, Arity> = {
  '--add-dir': 'variadic', '--agent': 'value', '--agents': 'value', '--allow-dangerously-skip-permissions': 'bool',
  '--allowedTools': 'variadic', '--allowed-tools': 'variadic', '--append-system-prompt': 'value', '--autocompact': 'value',
  '--ax-screen-reader': 'bool', '--bg': 'bool', '--background': 'bool', '--bare': 'bool', '--betas': 'variadic',
  '--brief': 'bool', '--chrome': 'bool', '--cloud': 'optional', '--continue': 'bool', '-c': 'bool',
  '--dangerously-skip-permissions': 'bool', '--debug': 'optional', '-d': 'optional', '--debug-file': 'value',
  '--desktop': 'bool', '--disable-slash-commands': 'bool', '--disallowedTools': 'variadic', '--disallowed-tools': 'variadic',
  '--effort': 'value', '--environment': 'value', '--exclude-dynamic-system-prompt-sections': 'bool',
  '--fallback-model': 'value', '--file': 'variadic', '--fork-session': 'bool', '--forward-subagent-text': 'bool',
  '--from-pr': 'optional', '--help': 'bool', '-h': 'bool', '--ide': 'bool', '--include-hook-events': 'bool',
  '--include-partial-messages': 'bool', '--input-format': 'value', '--json-schema': 'value', '--max-budget-usd': 'value',
  '--mcp-config': 'variadic', '--model': 'value', '--name': 'value', '-n': 'value', '--no-chrome': 'bool',
  '--no-session-persistence': 'bool', '--output-format': 'value', '--permission-mode': 'value',
  '--permission-prompts': 'value', '--plugin-dir': 'value', '--plugin-url': 'value', '--print': 'bool', '-p': 'bool',
  '--prompt-suggestions': 'optional', '--remote-control': 'optional', '--remote-control-session-name-prefix': 'value',
  '--replay-user-messages': 'bool', '--restricted': 'bool', '--resume': 'optional', '-r': 'optional', '--safe-mode': 'bool',
  '--session-id': 'value', '--setting-sources': 'value', '--settings': 'value', '--strict-mcp-config': 'bool',
  '--system-prompt': 'value', '--system-prompt-snapshot': 'value', '--teleport': 'optional', '--tmux': 'bool',
  '--tools': 'variadic', '--verbose': 'bool', '--version': 'bool', '-v': 'bool', '--worktree': 'optional', '-w': 'optional',
  // Hidden in --help but accepted.
  '--thinking': 'value', '--max-thinking-tokens': 'value', '--max-turns': 'value', '--system-prompt-file': 'value',
  '--append-system-prompt-file': 'value', '--permission-prompt-tool': 'value', '--workload': 'value',
}
const ALIASES: Record<string, string> = {
  '-c': '--continue', '-d': '--debug', '-h': '--help', '-n': '--name', '-p': '--print', '-r': '--resume', '-v': '--version',
  '-w': '--worktree', '--allowed-tools': '--allowedTools', '--disallowed-tools': '--disallowedTools', '--background': '--bg',
}
const CHOICES: Record<string, { label: string; values: string[] }> = {
  '--permission-mode': { label: '--permission-mode <mode>', values: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] },
  '--output-format': { label: '--output-format <format>', values: ['text', 'json', 'stream-json'] },
  '--input-format': { label: '--input-format <format>', values: ['text', 'stream-json'] },
}
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Args = { opts: Record<string, string[] | true>; positionals: string[] }

/** Commander's rules: a variadic option takes words until the next option, which is how a trailing prompt gets swallowed. */
export function parse(argv: string[]): Args | string {
  const a: Args = { opts: {}, positionals: [] }
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i]
    if (raw === '--') {
      a.positionals.push(...argv.slice(i + 1))
      break
    }
    if (!raw.startsWith('-') || raw === '-') {
      a.positionals.push(raw)
      continue
    }
    const [name, inline] = raw.includes('=') ? [raw.slice(0, raw.indexOf('=')), raw.slice(raw.indexOf('=') + 1)] : [raw, undefined]
    const arity = OPTIONS[name]
    if (!arity) return `error: unknown option '${name}'`
    const key = ALIASES[name] ?? name
    if (arity === 'bool') a.opts[key] = true
    else if (inline !== undefined) a.opts[key] = [inline]
    else if (arity === 'value') {
      if (i + 1 >= argv.length) return `error: option '${name} <value>' argument missing`
      a.opts[key] = [argv[++i]]
    } else if (arity === 'optional') {
      a.opts[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('-') ? [argv[++i]] : true
    } else {
      const vals: string[] = []
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) vals.push(argv[++i])
      a.opts[key] = vals
    }
  }
  return a
}

function one(a: Args, key: string): string | undefined {
  const v = a.opts[key]
  return Array.isArray(v) ? v[0] : undefined
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  return exit(1)
}

function modelId(alias?: string): string {
  if (!alias) return 'claude-sonnet-5-5'
  if (alias === 'fable' || alias === 'best') return 'claude-fable-5-1'
  return ['haiku', 'sonnet', 'opus'].includes(alias) ? `claude-${alias}-5-5` : alias
}

function usage() {
  return { input_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 100, output_tokens: 4, service_tier: 'standard' }
}

// Claude Code's own cap on a Stop hook sending it back is far higher. The daemon's 3 per turn ends the loop first.
const MAX_CONTINUES = 10

/**
 * Runs the command hooks for event as Claude Code does: a group's matcher is a regex on the tool name, and exit code 2
 * blocks with stderr as the reason, which goes back to the model. Returns that reason, or null.
 */
function runHooks(settings: any, event: string, payload: Record<string, unknown>): string | null {
  let block: string | null = null
  for (const group of settings?.hooks?.[event] ?? []) {
    if (group.matcher && typeof payload.tool_name === 'string' && !new RegExp(`^(?:${group.matcher})$`).test(payload.tool_name)) continue
    for (const h of group.hooks ?? []) {
      if (h.type !== 'command') continue
      const r = spawnSync('sh', ['-c', h.command], { input: JSON.stringify(payload), stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8', timeout: 10_000 })
      record('hooks.jsonl', { event, tool: payload.tool_name, code: r.status, stderr: r.stderr })
      if (r.status === 2) block ??= r.stderr.trim()
    }
  }
  return block
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  logArgv('claude', argv)
  const parsed = parse(argv)
  if (typeof parsed === 'string') fail(parsed)
  const a = parsed as Args
  for (const [key, c] of Object.entries(CHOICES)) {
    const v = one(a, key)
    if (v !== undefined && !c.values.includes(v)) fail(`error: option '${c.label}' argument '${v}' is invalid. Allowed choices are ${c.values.join(', ')}.`)
  }
  if (a.opts['--version']) {
    process.stdout.write('2.1.296 (Claude Code)\n')
    return exit(0)
  }
  if (!a.opts['--print']) fail('fake claude only runs with -p')
  const format = one(a, '--output-format') ?? 'text'
  if (format === 'stream-json' && !a.opts['--verbose']) fail('Error: When using --print, --output-format=stream-json requires --verbose')
  const effort = one(a, '--effort')
  if (effort && !EFFORTS.includes(effort)) {
    process.stderr.write(`Warning: Unknown --effort value '${effort}' — ignoring it and using the default effort. Valid values: ${EFFORTS.join(', ')}.\n`)
  }
  const mode = one(a, '--permission-mode') ?? 'default'
  const bypass = mode === 'bypassPermissions' || a.opts['--dangerously-skip-permissions']
  if (bypass && process.getuid?.() === 0 && process.env.IS_SANDBOX !== '1') {
    fail('--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons')
  }
  const sessionFlag = one(a, '--session-id')
  const resumeFlag = a.opts['--resume']
  if (sessionFlag && (resumeFlag || a.opts['--continue']) && !a.opts['--fork-session']) {
    fail('Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.')
  }
  if (sessionFlag && !UUID.test(sessionFlag)) fail('Error: Invalid session ID. Must be a valid UUID.')
  let schema: unknown
  if (one(a, '--json-schema')) {
    try {
      schema = JSON.parse(one(a, '--json-schema') as string)
    } catch {
      fail('Error: --json-schema must be valid JSON')
    }
  }
  let settings: any = {}
  const settingsArg = one(a, '--settings')
  if (settingsArg) {
    try {
      settings = JSON.parse(settingsArg.trim().startsWith('{') ? settingsArg : readFileSync(settingsArg, 'utf8'))
    } catch {
      // -p silently ignores settings that fail validation.
      settings = {}
    }
  }

  const cwd = process.cwd()
  let s: Session | null
  if (Array.isArray(resumeFlag)) {
    s = loadSession('claude', resumeFlag[0])
    if (!s) {
      const message = `No conversation found with session ID: ${resumeFlag[0]}`
      // Seen from 2.1.296: stream-json still writes a result carrying the error. json writes nothing to stdout.
      if (format === 'stream-json') {
        out({ type: 'result', subtype: 'error_during_execution', duration_ms: 0, duration_api_ms: 0, is_error: true, num_turns: 0,
          stop_reason: null, session_id: resumeFlag[0], total_cost_usd: 0, usage: usage(), modelUsage: {}, permission_denials: [],
          uuid: randomUUID(), errors: [message], result_index: 0 })
      }
      fail(message)
    }
  } else {
    const id = sessionFlag ?? randomUUID()
    const existing = loadSession('claude', id)
    // The in-use check only looks in this cwd's project dir.
    if (existing && existing.cwd === cwd) fail(`Error: Session ID ${id} is already in use.`)
    s = { id, cwd, turns: [] }
  }
  const session = s as Session

  const piped = await readStdin(3000)
  if (piped === null) {
    process.stderr.write('Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.\n')
  }
  const prompt = [a.positionals[0], piped ?? ''].filter(Boolean).join('\n').trim()
  if (!prompt) fail('Error: Input must be provided either through stdin or as a prompt argument when using --print')
  session.turns.push({ prompt })
  if (!a.opts['--no-session-persistence']) saveSession('claude', session.id, session)

  const model = modelId(one(a, '--model'))
  const stream = format === 'stream-json'
  const emit = (e: unknown) => stream && out(e)
  const base = { session_id: session.id }
  const hookPayload = (event: string) => ({ session_id: session.id, hook_event_name: event, cwd, transcript_path: '' })
  if (scenario().runHooks) runHooks(settings, 'SessionStart', hookPayload('SessionStart'))
  emit({
    type: 'system', subtype: 'init', cwd, ...base, tools: ['Bash', 'Edit', 'Read', 'Write'], mcp_servers: [], model,
    permissionMode: mode === 'manual' ? 'default' : mode, slash_commands: [], apiKeySource: 'none',
    claude_code_version: '2.1.296', output_style: 'default', agents: [], skills: [], plugins: [], uuid: randomUUID(),
  })

  const result = (fields: Record<string, unknown>) => ({
    type: 'result', subtype: 'success', is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1,
    stop_reason: 'end_turn', ...base, total_cost_usd: 0.0002, usage: usage(), modelUsage: { [model]: { costUSD: 0.0002 } },
    permission_denials: [], terminal_reason: 'completed', api_error_status: null, uuid: randomUUID(), result_index: 0, ...fields,
  })
  const finish = (r: object, code: number) => {
    if (format === 'text') process.stdout.write(`${(r as any).result ?? ''}\n`)
    else out(r)
    if (scenario().runHooks) runHooks(settings, 'SessionEnd', hookPayload('SessionEnd'))
    return exit(code)
  }

  const turn: FakeTurn = takeTurn(prompt)
  process.on('SIGINT', () => finish(result({
    subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming', stop_reason: null,
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'], result: undefined,
  }), 0))
  if (turn.crash) {
    process.stderr.write('fake claude crashed\n')
    return exit(turn.exit ?? 1)
  }
  if (turn.hang) return void (await hangForever(turn))
  if (turn.delayMs) await sleep(turn.delayMs)
  if (turn.error) {
    return finish(result({ is_error: true, terminal_reason: 'api_error', api_error_status: 500, result: turn.error, total_cost_usd: 0 }), turn.exit ?? 1)
  }

  const hooked = scenario().runHooks
  // With hooks on, every tool call asks PreToolUse first, and a block comes back to the model as the tool's error.
  const gate = (tool: string, input: Record<string, unknown>) => hooked ? runHooks(settings, 'PreToolUse', { ...hookPayload('PreToolUse'), tool_name: tool, tool_input: input }) : null
  const act = (t: FakeTurn, said: string): string => {
    for (const e of sideEffects(t, cwd, gate)) {
      const id = `toolu_${randomUUID().replaceAll('-', '').slice(0, 20)}`
      emit({ type: 'assistant', message: { model, id: `msg_${id}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id, name: e.tool, input: e.input }], usage: usage() }, parent_tool_use_id: null, ...base, uuid: randomUUID() })
      emit({ type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: e.output, ...(e.blocked ? { is_error: true } : {}) }] }, parent_tool_use_id: null, ...base, uuid: randomUUID() })
    }
    const text = t.json !== undefined && schema ? JSON.stringify(t.json) : replyText(t, session, said)
    emit({ type: 'assistant', message: { model, id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', content: [{ type: 'text', text }], stop_reason: null, usage: usage() }, parent_tool_use_id: null, ...base, uuid: randomUUID() })
    return text
  }
  let text = act(turn, prompt)
  session.turns[session.turns.length - 1].reply = text
  if (!a.opts['--no-session-persistence']) saveSession('claude', session.id, session)
  emit({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' }, uuid: randomUUID(), ...base })
  // A Stop hook that exits 2 sends the model back with its reason, which the scenario matches like a prompt.
  for (let i = 0; hooked && i < MAX_CONTINUES; i++) {
    const reason = runHooks(settings, 'Stop', { ...hookPayload('Stop'), stop_hook_active: i > 0, last_assistant_message: text })
    if (!reason) break
    text = act(takeTurn(reason), reason)
  }
  const extra = schema && turn.json !== undefined ? { structured_output: turn.json, num_turns: 2, stop_reason: 'tool_use' } : {}
  return finish(result({ result: text, ...extra }), turn.exit ?? 0)
}

main()
