/**
 * clyde hook <event>: forwards a hook payload on stdin to memory and the daemon, and never takes past 3 s. It exits 0 and prints
 * nothing, except when the daemon's work list rules hold a PreToolUse or Stop: then the reason goes to stderr with exit 2,
 * which is Claude Code's blocking hook contract, so Claude reads the reason and goes on.
 */
import { DaemonClient } from '../client.ts'
import { agentMemory } from '../memory.ts'

// Claude Code waits on every hook, so a slow memory or daemon must never hold up the worker.
const DEADLINE_MS = 3000
const STDIN_MS = 1000
const MAX_STDIN = 1024 * 1024
const GATE_MS = 2500
// The hooks the daemon may hold. PreToolUse is only a gate, since PostToolUse already logs the call to memory.
const GATED = new Set(['PreToolUse', 'Stop'])

export async function main(argv: string[]): Promise<number> {
  const deadline = setTimeout(() => process.exit(0), DEADLINE_MS)
  try {
    const event = argv[0]
    if (!event) return 0
    const payload = withIds(parse(await readStdin()))
    const thread = process.env.CLYDE_THREAD_ID
    const sends: Promise<unknown>[] = []
    const memory = agentMemory()
    if (memory && event !== 'PreToolUse') sends.push(memory.hook(event, payload))
    const client = thread ? DaemonClient.fromFile() : null
    if (client && thread && event !== 'PreToolUse') sends.push(client.hook(thread, event, payload))
    // A daemon that can't answer lets the call through, so clyde being down never wedges a worker.
    const gate = client && thread && GATED.has(event) ? client.gate(thread, event, payload, GATE_MS).catch(() => null) : Promise.resolve(null)
    const [block] = await Promise.all([gate, Promise.allSettled(sends)])
    if (block) {
      process.stderr.write(`${block}\n`)
      return 2
    }
  } catch {
    // Bookkeeping only. The worker goes on.
  } finally {
    clearTimeout(deadline)
  }
  return 0
}

/** Adds the run and thread ids, so memory can join the hook row to the clyde run. */
export function withIds(payload: Record<string, unknown>, env: Record<string, string | undefined> = process.env): Record<string, unknown> {
  const out = { ...payload }
  if (env.CLYDE_RUN_ID) out.run_id = env.CLYDE_RUN_ID
  if (env.CLYDE_THREAD_ID) out.thread_id = env.CLYDE_THREAD_ID
  return out
}

function parse(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? v : { body: v }
  } catch {
    return { body: text.slice(0, 4000) }
  }
}

/** Reads stdin to EOF, or what arrived within STDIN_MS, since a caller may leave the pipe open. */
function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    const done = () => {
      clearTimeout(timer)
      // An open pipe would keep the process alive, so it's closed rather than paused.
      process.stdin.removeAllListeners()
      process.stdin.destroy()
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    const timer = setTimeout(done, STDIN_MS)
    process.stdin.on('data', (c: Buffer) => {
      size += c.length
      if (size <= MAX_STDIN) chunks.push(c)
    })
    process.stdin.on('end', done)
    process.stdin.on('error', done)
  })
}
