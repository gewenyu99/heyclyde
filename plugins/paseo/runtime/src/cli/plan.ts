/** clyde plan show|set: the run's plan, kept in memory as an approved entry. Both go through the daemon, which holds the runtime token. */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DaemonClient } from '../client.ts'

const USAGE = `Usage:
  clyde plan show [--run R] [--json]
  clyde plan set --file F [--run R]`

type Plan = { intent: string; slices: { id: string; title: string; acceptance?: string[] }[] }

export function planLines(run: string, plan: Plan, entry: string | null): string[] {
  const lines = [`Run ${run} plan${entry ? `, memory entry ${entry}` : ''}.`, `Intent: ${plan.intent}`]
  for (const s of plan.slices ?? []) {
    const acceptance = s.acceptance?.length ? ` Acceptance: ${s.acceptance.join(', ')}` : ''
    lines.push(`- ${s.id} ${s.title}.${acceptance}`)
  }
  return lines
}

export async function main(argv: string[]): Promise<number> {
  const [sub = 'show', ...rest] = argv
  const { values } = parseArgs({ args: rest, options: { run: { type: 'string' }, file: { type: 'string' }, json: { type: 'boolean' } } })
  if (sub !== 'show' && sub !== 'set') return usage(`Unknown subcommand ${sub}.`)
  const run = values.run ?? process.env.CLYDE_RUN_ID
  if (!run) return usage('clyde plan needs --run, or CLYDE_RUN_ID from inside a run.')
  const client = DaemonClient.fromFile()
  if (!client) {
    console.error('clyde plan: the clyde daemon is not running.')
    return 1
  }
  const path = `/runs/${encodeURIComponent(run)}/plan`
  if (sub === 'show') {
    const { plan, entry } = await client.call('GET', path)
    if (values.json) console.log(JSON.stringify({ plan, entry }, null, 2))
    else console.log(plan ? planLines(run, plan, entry).join('\n') : `Run ${run} has no plan yet.`)
    return 0
  }
  if (!values.file) return usage('clyde plan set needs --file with the plan as JSON.')
  let plan: unknown
  try {
    plan = JSON.parse(readFileSync(values.file, 'utf8'))
  } catch (err) {
    console.error(`clyde plan: ${values.file} is not a JSON plan: ${(err as Error).message}`)
    return 1
  }
  const set = await client.call('POST', path, { plan })
  console.log(['Plan set.', ...planLines(run, set.plan, set.entry)].join('\n'))
  return 0
}

function usage(problem: string): number {
  console.error(problem)
  console.error(USAGE)
  return 2
}
