/** Claude Code as a backend: claude -p with the prompt on stdin, --session-id on the first turn and --resume after. */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join, relative, isAbsolute } from 'node:path'
import { clydeBin, clydeHome, turnTimeoutMs } from '../config.ts'
import { family } from '../roles.ts'
import { exitReason, lastJsonBlock, parseLine, runProcess } from './spawn.ts'
import type { Backend, TurnInput, TurnOutput } from './types.ts'

/**
 * CLYDE_CLAUDE_BIN, else claude on PATH, else the CLI the Claude desktop app ships in its bundle, newest version first.
 * The bundled one bills to the same plan, so a Mac with only the desktop app needs no extra install.
 */
export function claudeBin(): string {
  if (process.env.CLYDE_CLAUDE_BIN) return process.env.CLYDE_CLAUDE_BIN
  if ((process.env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, 'claude')))) return 'claude'
  const root = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code')
  const versions = safeList(root).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  for (const v of versions) {
    for (const build of safeList(join(root, v))) {
      const bin = join(root, v, build, 'claude.app', 'Contents', 'MacOS', 'claude')
      if (existsSync(bin)) return bin
    }
  }
  return 'claude'
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd']
// PreToolUse runs only for the tools that can change files, so reads never wait on a node start.
const EDIT_MATCHER = 'Edit|MultiEdit|Write|NotebookEdit|Bash'

const JUDGE_TOOLS = 'Read,Grep,Glob,Bash'
// Never allow Bash rules on a judge: Bash(git diff *) admits --output=<file>. These denials close that hole.
const JUDGE_DENY = ['Bash(git diff --output*)', 'Bash(git log --output*)']

function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * --settings JSON whose hooks run `clyde hook <Event>`, so hook rows reach memory without the model doing anything. PreToolUse and
 * Stop can also block, by exit code 2, to hold the worker to its work list.
 */
export function hookSettings(): object {
  const hooks: Record<string, object[]> = {}
  for (const event of HOOK_EVENTS) {
    const group: Record<string, unknown> = { hooks: [{ type: 'command', command: `${shq(process.execPath)} ${shq(clydeBin())} hook ${event}` }] }
    if (event === 'PreToolUse') group.matcher = EDIT_MATCHER
    hooks[event] = [group]
  }
  return { hooks }
}

// A worktree clyde cut sits under <CLYDE_HOME>/worktrees, or wherever Paseo put it as a workspace, on a clyde/<id> branch.
function insideWorktrees(cwd: string): boolean {
  const rel = relative(join(clydeHome(), 'worktrees'), cwd)
  return (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) || onClydeBranch(cwd)
}

function onClydeBranch(cwd: string): boolean {
  try {
    const git = (...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return git('rev-parse', '--abbrev-ref', 'HEAD').startsWith('clyde/') && git('rev-parse', '--git-dir') !== git('rev-parse', '--git-common-dir')
  } catch {
    return false
  }
}

export function permissionMode(input: TurnInput): string {
  return input.rung.permission ?? (insideWorktrees(input.cwd) ? 'bypassPermissions' : 'acceptEdits')
}

export function claudeArgs(input: TurnInput, session: string, resume: boolean): string[] {
  const args = ['-p', '--output-format', input.readOnly ? 'json' : 'stream-json']
  if (!input.readOnly) args.push('--verbose')
  args.push(resume ? '--resume' : '--session-id', session)
  if (input.rung.model) args.push('--model', input.rung.model)
  if (input.rung.effort) args.push('--effort', input.rung.effort)
  if (input.readOnly) {
    args.push('--tools', input.rung.model?.includes('fable') ? 'Read,Grep,Glob' : JUDGE_TOOLS, '--permission-mode', 'dontAsk', '--disallowedTools', ...JUDGE_DENY)
    if (input.rung.model?.includes('fable')) args.push('--strict-mcp-config','--mcp-config','{"mcpServers":{}}')
    if (input.schema) args.push('--json-schema', JSON.stringify(input.schema))
  } else {
    args.push('--permission-mode', permissionMode(input))
  }
  // The first request snapshots the system prompt, so a later --append-system-prompt would be ignored anyway.
  if (input.systemAppend && !resume) args.push('--append-system-prompt', input.systemAppend)
  args.push('--settings', JSON.stringify(hookSettings()))
  return args
}

/** --output-format json prints one object, or an array of every message with --verbose. Take the last result. */
function results(line: string): any[] {
  const e = parseLine(line)
  if (e) return e.type === 'result' ? [e] : []
  try {
    const arr = JSON.parse(line)
    return Array.isArray(arr) ? arr.filter((m) => m?.type === 'result') : []
  } catch {
    return []
  }
}

function errorOf(result: any): string {
  const errors = Array.isArray(result.errors) ? result.errors.join(', ') : ''
  return errors || (typeof result.result === 'string' && result.result) || `claude failed with ${result.subtype ?? 'an error'}`
}

export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  if (!input.session) {
    const session = randomUUID()
    input.onSession?.(session)
    return spawnTurn(input, session, false)
  }
  const out = await spawnTurn(input, input.session, true)
  // A first turn that died before claude wrote its transcript leaves an id nothing can resume, so start it now.
  if (out.missing) return spawnTurn(input, input.session, false)
  return out
}

async function spawnTurn(input: TurnInput, session: string, resume: boolean): Promise<TurnOutput & { missing?: boolean }> {
  const timeoutMs = turnTimeoutMs()
  let result: any = null
  let text = ''
  const proc = runProcess({
    bin: claudeBin(), args: claudeArgs(input, session, resume), cwd: input.cwd, env: input.env,
    stdin: input.prompt, signal: input.signal, timeoutMs,
    onLine: (line) => {
      const found = results(line)
      if (found.length) {
        result = found.at(-1)
        return
      }
      const e = parseLine(line)
      if (e?.type !== 'assistant' || e.parent_tool_use_id) return
      for (const block of e.message?.content ?? []) {
        if (block?.type === 'text') text = block.text
        else if (block?.type === 'tool_use') input.onProgress?.(`claude ran ${block.name}`)
      }
    },
  })
  const r = await proc.done
  // stream-json reports it as a result with errors, json only on stderr.
  const notFound = `No conversation found with session ID: ${session}`
  if (resume && r.code === 1 && (r.stderr.includes(notFound) || result?.errors?.includes?.(notFound))) {
    return { ok: false, text: '', session, missing: true }
  }
  const out: TurnOutput = { ok: false, text, session: result?.session_id ?? session }
  if (result) {
    out.text = typeof result.result === 'string' ? result.result : text
    out.usage = { cost: result.total_cost_usd, modelUsage: result.modelUsage }
  }
  if (r.timedOut || r.aborted || r.spawnError) out.error = exitReason('claude', r, timeoutMs)
  else if (!result) out.error = exitReason('claude', r, timeoutMs)
  else if (result.is_error !== false) out.error = errorOf(result)
  else if (r.code !== 0) out.error = exitReason('claude', r, timeoutMs)
  else out.ok = true
  if (out.ok && input.schema) out.json = result.structured_output ?? lastJsonBlock(out.text)
  return out
}

export const claude: Backend = { name: 'claude', family, runTurn }
