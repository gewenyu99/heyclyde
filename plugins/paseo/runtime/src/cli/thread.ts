/** clyde thread start|send|read|stop|run: background threads from the command line. */
import { parseArgs } from 'node:util'
import { ensureDaemon } from '../client.ts'
import { connect } from '../daemon.ts'
import type { Thread } from '../types.ts'
import { threadLine } from './status.ts'

const USAGE = `Usage:
  clyde thread start --prompt P [--title T] [--role R] [--cwd D] [--worktree] [--read-only] [--json]
  clyde thread send <id> <text>
  clyde thread read <id> [--json]
  clyde thread stop <id>
  clyde thread run --prompt P [--role R] [--cwd D] [--title T]`

const OPTIONS = {
  prompt: { type: 'string' }, title: { type: 'string' }, role: { type: 'string' }, cwd: { type: 'string' },
  text: { type: 'string' }, worktree: { type: 'boolean' }, 'read-only': { type: 'boolean' }, json: { type: 'boolean' },
} as const

export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  const { values, positionals } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true })
  if (sub === 'run') return run(values, positionals)
  if (sub === 'start') return start(values, positionals)
  if (sub === 'send' || sub === 'read' || sub === 'stop') {
    const [id, ...words] = positionals
    if (!id) return usage(`clyde thread ${sub} needs a thread id.`)
    const client = await ensureDaemon()
    if (sub === 'send') {
      const text = values.text ?? words.join(' ')
      if (!text) return usage('clyde thread send needs the text to send.')
      return show(await client.send(id, text), values.json)
    }
    if (sub === 'stop') return show(await client.stop(id), values.json)
    return read(await client.thread(id), values.json)
  }
  return usage(sub ? `Unknown subcommand ${sub}.` : '')
}

function usage(problem: string): number {
  if (problem) console.error(problem)
  console.error(USAGE)
  return 2
}

function body(values: Record<string, any>, positionals: string[]) {
  const prompt = values.prompt ?? positionals.join(' ')
  return {
    prompt, title: values.title, role: values.role, cwd: values.cwd ?? process.cwd(),
    worktree: values.worktree === true, readOnly: values['read-only'] === true, parentThreadId: process.env.CLYDE_THREAD_ID,
  }
}

async function start(values: Record<string, any>, positionals: string[]): Promise<number> {
  const b = body(values, positionals)
  if (!b.prompt) return usage('clyde thread start needs --prompt.')
  const client = await ensureDaemon()
  return show(await client.startThread(b), values.json)
}

function show(t: Thread, json?: boolean): number {
  console.log(json ? JSON.stringify(t, null, 2) : threadLine(t))
  return 0
}

function read(t: Thread, json?: boolean): number {
  if (json) return show(t, true)
  console.log(threadLine(t))
  const last = t.turns.at(-1)
  if (!last) return 0
  console.log(`\nTurn ${last.n} prompt: ${last.prompt.split('\n')[0]}`)
  if (last.text) console.log(`\n${last.text}`)
  if (last.error) console.log(`\nerror: ${last.error}`)
  return 0
}

/** One thread, one turn, the text on stdout. Exit 0 when the turn succeeded, 1 otherwise. */
async function run(values: Record<string, any>, positionals: string[]): Promise<number> {
  const b = body(values, positionals)
  if (!b.prompt) return usage('clyde thread run needs --prompt.')
  const { client, daemon } = await connect()
  try {
    const started = await client.startThread(b)
    const stop = () => { client.stop(started.id).catch(() => {}) }
    process.once('SIGINT', stop)
    const done = await client.waitIdle(started.id)
    process.off('SIGINT', stop)
    const last = done.turns.at(-1)
    if (last?.text) process.stdout.write(last.text.endsWith('\n') ? last.text : `${last.text}\n`)
    if (last?.ok) return 0
    console.error(`clyde: thread ${started.id} ${done.status}: ${last?.error ?? 'no answer'}`)
    return 1
  } finally {
    await daemon?.close()
  }
}
