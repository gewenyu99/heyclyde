/** clyde status [--all] [--json]: threads and runs, one line each, in a fixed format. */
import { parseArgs } from 'node:util'
import { DaemonClient, healthy } from '../client.ts'
import { readDaemonInfo } from '../config.ts'
import { rungLabel } from '../threads.ts'
import type { Thread } from '../types.ts'
import { spoolStatus } from '../memory-spool.ts'

/** thread <id> <status> <rung> <n> turns <title>, then what it's doing in parentheses. */
export function threadLine(t: Thread): string {
  const turns = `${t.turns.length} turn${t.turns.length === 1 ? '' : 's'}`
  const doing = t.progress ? `  (${t.progress})` : ''
  return `thread  ${t.id.padEnd(10)}  ${t.status.padEnd(7)}  ${rungLabel(t.rung).padEnd(34)}  ${turns.padEnd(8)}  ${t.title}${doing}`
}

/** run <id> <status> <flow> <stage>, then the question when it's asking. */
export function runLine(r: any): string {
  const stage = r.stages?.at?.(-1)?.name ? `stage ${r.stages.at(-1).name}` : ''
  const ask = r.status === 'asking' && r.question ? `  ${String(r.question).split('\n')[0]}` : ''
  return `run     ${String(r.id).padEnd(10)}  ${String(r.status).padEnd(7)}  ${String(r.flow).padEnd(34)}  ${stage}${ask}`
}

function spoolLine(spool: { depth: number; oldestAgeMs: number; deadLetterDepth: number }): string {
  const base = `memory spool  ${spool.depth} pending, oldest ${Math.round(spool.oldestAgeMs / 1000)}s`
  return spool.deadLetterDepth ? `${base}, ${spool.deadLetterDepth} dead-letter` : base
}
export function visible(threads: Thread[], runs: any[]): Thread[] {
  const live = new Set(runs.filter((r) => r.status === 'running' || r.status === 'asking').map((r) => r.id))
  return threads.filter((t) => !t.runId || live.has(t.runId))
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, all: { type: 'boolean' } } })
  const info = readDaemonInfo()
  if (!(await healthy(info)) || !info) {
    console.log(spoolLine(spoolStatus()))
    console.error('clyde daemon is not running. Start it with clyde daemon.')
    return 1
  }
  const client = new DaemonClient(info)
  const threads = await client.threads()
  const runs = await client.runs()
  const memorySpool = spoolStatus()
  if (values.json) {
    console.log(JSON.stringify({ threads, runs, memorySpool }, null, 2))
    return 0
  }
  const shown = values.all ? threads : visible(threads, runs)
  if (!threads.length && !runs.length) console.log('No threads or runs.')
  for (const t of shown) console.log(threadLine(t))
  for (const r of runs) console.log(runLine(r))
  console.log(spoolLine(memorySpool))
  const hidden = threads.length - shown.length
  if (hidden) console.log(`${hidden} thread${hidden === 1 ? '' : 's'} of finished runs hidden. clyde status --all lists them.`)
  return 0
}
