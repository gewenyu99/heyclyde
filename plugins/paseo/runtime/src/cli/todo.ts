/** clyde todo: the work list the daemon keeps for this thread, or for a run with --run. Every call prints the whole list. */
import { parseArgs } from 'node:util'
import { DaemonClient, DaemonError, type ListView } from '../client.ts'

const USAGE = `Usage:
  clyde todo [list] [--run R]
  clyde todo add "<text>"... [--run R]
  clyde todo start N --how "<how you'll do it>" [--run R]
  clyde todo done N --evidence "<command and result, path:line, or sha>" [--run R]
  clyde todo block N --why "<why>" [--run R]
The list is CLYDE_THREAD_ID's, or run R's with --run.`

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true,
    options: { run: { type: 'string' }, how: { type: 'string' }, evidence: { type: 'string' }, why: { type: 'string' } },
  })
  const [sub = 'list', ...rest] = positionals
  const owner = values.run ? `run:${values.run}` : process.env.CLYDE_THREAD_ID ? `thread:${process.env.CLYDE_THREAD_ID}` : ''
  if (!owner) return usage('clyde todo needs CLYDE_THREAD_ID, which clyde sets in every thread, or --run R.')
  const call = request(sub, rest, values)
  if (typeof call === 'string') return usage(call)
  const client = DaemonClient.fromFile()
  if (!client) {
    console.error('clyde todo: the clyde daemon is not running.')
    return 1
  }
  try {
    const list = call ? await client.todo(owner, call.action, call.body) : await client.list(owner)
    console.log(list.text)
    return 0
  } catch (err) {
    if (!(err instanceof DaemonError)) throw err
    console.error(`clyde todo: ${err.message}`)
    // The model sees the state it has to work from even when its change was refused.
    const list: ListView | null = await client.list(owner).catch(() => null)
    if (list) console.log(list.text)
    return 1
  }
}

type Call = { action: 'add' | 'start' | 'done' | 'block'; body: object } | null

/** The daemon call for a subcommand, null to just read the list, or the usage problem. */
function request(sub: string, rest: string[], v: { how?: string; evidence?: string; why?: string }): Call | string {
  if (sub === 'list') return rest.length ? 'clyde todo list takes no arguments.' : null
  if (sub === 'add') return rest.length ? { action: 'add', body: { items: rest } } : 'clyde todo add needs the text of at least one item.'
  const field = { start: 'how', done: 'evidence', block: 'why' }[sub] as 'how' | 'evidence' | 'why' | undefined
  if (!field) return `Unknown subcommand ${sub}.`
  const n = Number(rest[0])
  if (rest.length !== 1 || !Number.isInteger(n) || n < 1) return `clyde todo ${sub} needs one item number, like 3.`
  if (!v[field]?.trim()) return `clyde todo ${sub} needs --${field}.`
  return { action: sub as 'start' | 'done' | 'block', body: { n, [field]: v[field] } }
}

function usage(problem: string): number {
  if (problem) console.error(problem)
  console.error(USAGE)
  return 2
}
