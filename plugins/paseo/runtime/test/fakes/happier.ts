/** A fake @happier-dev/cli 0.2.16: auth status, session create|status|send|list and notify, with the real JSON envelopes. */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { exit, locked, logArgv, out, stateDir } from './common.ts'

// CLYDE_FAKE_HAPPIER names a JSON file: {authed?: false, failSends?: N, sessionId?, lostSession?: true}. Unset means signed in.
type Config = { authed?: boolean; failSends?: number; sessionId?: string; lostSession?: boolean }

const CREATE_VALUE = new Set(['--path', '--backend', '--agent', '--title', '--tag', '--prompt', '--message', '--model', '--permission-mode',
  '--mode', '--config-option', '--reasoning-effort', '--config-overrides-json', '--launch-profile', '--env', '--auth', '--connected-services',
  '--auth-json', '--mcp-selection-json', '--transcript-storage', '--terminal-json', '--codex-backend-mode', '--runtime-descriptor-json',
  '--agent-runtime-descriptor-json', '--host', '--machine-id', '--spawn-attempt-id'])
const CREATE_BOOL = new Set(['--json', '--ultracode', '--resume-spawn-attempt'])
const SEND_VALUE = new Set(['--local-id', '--permission-mode', '--model', '--timeout'])
const SEND_BOOL = new Set(['--json', '--wait'])
const CREATE_HELP = `happier session create [options]

Options:
  [--path <path>] [--backend <backend-target>]
  [--title <title>] [--tag <tag>]
  [--prompt <text>|--message <text>]
  [--model <model-id>] [--permission-mode <read_only|default|auto|yolo>]
  [--env <KEY=VALUE>]
  [--auth <default|native|cs:<id>>|--connected-services <selector>|--auth-json <json>]
  [--json]`
const SEND_HELP = 'happier session send <session-id-or-prefix-or-tag> <message> [--local-id <id>] [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]'
const NOTIFY_HELP = `happy notify - Send notification

Usage:
  happier notify -p <message> [-t <title>]    Send notification with custom message and optional title

Options:
  -p <message>    Notification message (required)
  -t <title>      Notification title (optional, defaults to "Happier")`

function config(): Config {
  const path = process.env.CLYDE_FAKE_HAPPIER
  if (!path) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return {}
  }
}

function envelope(kind: string, ok: boolean, body: Record<string, unknown>): never {
  out({ v: 1, ok, kind, ...body })
  return exit(ok ? 0 : 1)
}

function notAuthed(kind: string): never {
  return envelope(kind, false, { error: { code: 'not_authenticated' } })
}

/** Flags and positionals the way the real parser takes them. An unknown flag is an error, as there. */
function parse(args: string[], values: Set<string>, bools: Set<string>, kind: string) {
  const flags: Record<string, string[]> = {}
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (bools.has(a)) (flags[a] ??= []).push('true')
    else if (values.has(a)) {
      if (args[i + 1] === undefined) envelope(kind, false, { error: { code: 'invalid_arguments', message: `${a} needs a value` } })
      ;(flags[a] ??= []).push(args[++i])
    } else if (a.startsWith('--')) envelope(kind, false, { error: { code: 'invalid_arguments', message: `unknown option ${a}` } })
    else positionals.push(a)
  }
  return { flags, positionals }
}

/** How many sends came before this one, kept in the state dir so each process sees the last one's count. */
function sendsBefore(): number {
  return locked(() => {
    const path = join(stateDir(), 'happier-sends.json')
    let n = 0
    try {
      n = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      // None yet.
    }
    writeFileSync(path, JSON.stringify(n + 1))
    return n
  })
}

function main(): void {
  const argv = process.argv.slice(2)
  logArgv('happier', argv)
  const c = config()
  const authed = c.authed !== false
  const [cmd, sub, ...rest] = argv
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write('0.2.16\n')
    return exit(0)
  }
  if (cmd === 'auth' && sub === 'status') {
    if (!rest.includes('--json')) {
      process.stdout.write(authed ? 'Authentication\n✓ Authenticated\n' : 'Authentication\nx Not authenticated on api.happier.dev\n')
      return exit(0)
    }
    return authed ? envelope('auth_status', true, { data: { authenticated: true } }) : envelope('auth_status', false, { error: { code: 'not_authenticated', serverId: 'cloud' } })
  }
  if (cmd === 'notify') {
    if (sub === '--help' || sub === '-h') {
      process.stdout.write(`${NOTIFY_HELP}\n`)
      return exit(0)
    }
    if (!authed) {
      process.stderr.write('Error: Not authenticated. Please run "happier auth login" first.\n')
      return exit(1)
    }
    const p = argv.indexOf('-p')
    if (p < 0 || !argv[p + 1]) {
      process.stderr.write('Error: Message is required. Use -p "your message"\n')
      return exit(1)
    }
    process.stdout.write('✓ Push notification sent successfully!\n')
    return exit(0)
  }
  if (cmd !== 'session') {
    process.stderr.write(`fake happier knows auth status, notify and session, not ${cmd}\n`)
    return exit(2)
  }
  if (rest.includes('--help')) {
    process.stdout.write(`${sub === 'create' ? CREATE_HELP : sub === 'send' ? SEND_HELP : 'happier session <command>'}\n`)
    return exit(0)
  }
  const kind = `session_${sub}`
  if (!authed) return notAuthed(kind)
  const id = c.sessionId ?? 'sess-fake-1'
  if (sub === 'create') {
    const { flags } = parse(rest, CREATE_VALUE, CREATE_BOOL, kind)
    for (const e of flags['--env'] ?? []) if (!/^[^=]+=/.test(e)) envelope(kind, false, { error: { code: 'invalid_arguments', message: `--env ${e} must be KEY=VALUE` } })
    return envelope(kind, true, { data: { session: { id, tag: flags['--tag']?.[0] ?? null }, created: true } })
  }
  if (sub === 'status') {
    if (c.lostSession || (rest[0] !== id && rest[0] !== 'clyde-point-man')) return envelope(kind, false, { error: { code: 'session_not_found' } })
    return envelope(kind, true, { data: { session: { id, active: true } } })
  }
  if (sub === 'list') return envelope(kind, true, { data: { sessions: c.lostSession ? [] : [{ id }] } })
  if (sub === 'send') {
    const { positionals } = parse(rest, SEND_VALUE, SEND_BOOL, kind)
    if (positionals.length < 2) return envelope(kind, false, { error: { code: 'invalid_arguments', message: 'session send needs a session and a message' } })
    if (sendsBefore() < (c.failSends ?? 0)) return envelope(kind, false, { error: { code: 'session_not_found' } })
    return envelope(kind, true, { data: { sessionId: positionals[0], localId: 'local-1', waited: false } })
  }
  process.stderr.write(`fake happier has no session ${sub}\n`)
  return exit(2)
}

main()
