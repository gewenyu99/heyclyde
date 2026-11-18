/** pi as a backend: --mode json, one process per turn, the conversation kept by --session-dir and --session-id. */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { harnessRoot, clydeHome, turnTimeoutMs } from '../config.ts'
import { CHATGPT, family } from '../roles.ts'
import { exitReason, lastJsonBlock, parseLine, runProcess } from './spawn.ts'
import type { Backend, TurnInput, TurnOutput } from './types.ts'

// pi exits only when its event loop drains, and an extension's leaked timer keeps it up after the answer.
const SETTLE_KILL_MS = 3000
// The judge reads and searches. It gets the diff in its prompt, so it needs no bash.
const READ_ONLY_TOOLS = 'read,grep,find,ls'

export function agentDir(env: Record<string, string | undefined>): string {
  return env.PI_CODING_AGENT_DIR || join(env.HOME || homedir(), '.pi', 'agent')
}

export function extensionPath(): string {
  return join(harnessRoot(), 'pi', 'clyde.ts')
}

/** clyde install links the extension into the agent dir, and pi refuses the same extension loaded twice. */
export function extensionInstalled(env: Record<string, string | undefined>): boolean {
  const dir = join(agentDir(env), 'extensions')
  return ['clyde/index.ts', 'clyde/index.js', 'clyde.ts'].some((p) => existsSync(join(dir, p)))
}

export function sessionDir(): string {
  return join(clydeHome(), 'sessions', 'pi')
}

/** pi reads --append-system-prompt as a file when the value is a path, which keeps long text out of argv. */
export function promptFile(text: string): string {
  const path = join(clydeHome(), 'prompts', `${createHash('sha256').update(text).digest('hex').slice(0, 16)}.md`)
  if (!existsSync(path)) {
    mkdirSync(join(clydeHome(), 'prompts'), { recursive: true })
    writeFileSync(path, text)
  }
  return path
}

/** -p reads a leading - or @ as a flag or a file, so such a prompt gets a leading space. */
export function safePrompt(prompt: string): string {
  return /^[-@]/.test(prompt) ? ` ${prompt}` : prompt
}

export function piArgs(input: TurnInput, session: string): string[] {
  const args = ['--mode', 'json', '-p', '--model', input.rung.model ?? CHATGPT]
  if (input.rung.effort) args.push('--thinking', input.rung.effort)
  args.push('--approve', '--session-dir', sessionDir(), '--session-id', session)
  if (input.readOnly) args.push('--tools', READ_ONLY_TOOLS)
  if (!extensionInstalled(input.env) && existsSync(extensionPath())) args.push('-e', extensionPath())
  if (input.systemAppend) args.push('--append-system-prompt', promptFile(input.systemAppend))
  args.push(safePrompt(input.prompt))
  return args
}

function textOf(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.filter((c: any) => c?.type === 'text').map((c: any) => c.text).join('')
}

function addUsage(total: Record<string, number>, usage: any): void {
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']) {
    if (typeof usage?.[k] === 'number') total[k] = (total[k] ?? 0) + usage[k]
  }
  if (typeof usage?.cost?.total === 'number') total.cost = (total.cost ?? 0) + usage.cost.total
}

export async function runTurn(input: TurnInput): Promise<TurnOutput> {
  const session = input.session ?? input.env.CLYDE_THREAD_ID ?? randomUUID()
  input.onSession?.(session)
  const timeoutMs = turnTimeoutMs()
  const usage: Record<string, number> = {}
  let last: any = null
  let settled = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const proc = runProcess({
    bin: process.env.CLYDE_PI_BIN || 'pi', args: piArgs(input, session), cwd: input.cwd, env: input.env,
    signal: input.signal, timeoutMs,
    onLine: (line) => {
      const e = parseLine(line)
      if (!e) return
      if (e.type === 'message_end' && e.message?.role === 'assistant') {
        last = e.message
        addUsage(usage, e.message.usage)
      } else if (e.type === 'tool_execution_start' && e.toolName) {
        input.onProgress?.(`pi ran ${e.toolName}`)
      } else if (e.type === 'agent_settled') {
        settled = true
        killTimer = setTimeout(() => proc.kill('SIGTERM'), SETTLE_KILL_MS)
      }
    },
  })
  const r = await proc.done
  clearTimeout(killTimer)
  const text = last ? textOf(last) : ''
  const out: TurnOutput = { ok: false, text, session, usage }
  if (!settled) out.error = exitReason('pi', r, timeoutMs)
  else if (!last) out.error = 'pi settled without an answer'
  else if (last.stopReason === 'error' || last.stopReason === 'aborted') {
    out.error = last.errorMessage || `pi stopped with ${last.stopReason}`
  } else out.ok = true
  if (out.ok && input.schema) out.json = lastJsonBlock(text)
  return out
}

export const pi: Backend = { name: 'pi', family, runTurn }
