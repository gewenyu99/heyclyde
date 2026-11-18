/**
 * clyde result --status done|blocked --summary S [--evidence-file F]: the worker's result, posted to the daemon for this thread.
 * The daemon refuses done while work list items are open, and blocked without a blocked item.
 */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { DaemonClient, DaemonError } from '../client.ts'

const USAGE = 'Usage: clyde result --status done|blocked --summary S [--evidence-file F]\nF holds a JSON list of {"criterion", "evidence"}.'

type Evidence = { criterion: string; evidence: string }

/** A list of {criterion, evidence}, or {evidence: [...]}, read from the file. Throws with the reason. */
export function readEvidence(path: string): Evidence[] {
  const value = JSON.parse(readFileSync(path, 'utf8'))
  const list = Array.isArray(value) ? value : value?.evidence
  if (!Array.isArray(list)) throw new Error('it must hold a JSON list of {"criterion", "evidence"}')
  for (const e of list) {
    if (typeof e?.criterion !== 'string' || typeof e?.evidence !== 'string') throw new Error('every item needs a criterion and an evidence string')
  }
  return list.map(({ criterion, evidence }) => ({ criterion, evidence }))
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv, options: { status: { type: 'string' }, summary: { type: 'string' }, 'evidence-file': { type: 'string' } },
  })
  if (values.status !== 'done' && values.status !== 'blocked') return usage('--status must be done or blocked.')
  if (!values.summary?.trim()) return usage('--summary is required.')
  const thread = process.env.CLYDE_THREAD_ID
  if (!thread) {
    console.error('clyde result: CLYDE_THREAD_ID is not set, so this is not a clyde thread.')
    return 1
  }
  const result: Record<string, unknown> = { status: values.status, summary: values.summary.trim() }
  if (values['evidence-file']) {
    try {
      result.evidence = readEvidence(values['evidence-file'])
    } catch (err) {
      console.error(`clyde result: can't use ${values['evidence-file']}: ${(err as Error).message}.`)
      return 1
    }
  }
  const client = DaemonClient.fromFile()
  if (!client) {
    console.error('clyde result: the clyde daemon is not running. End your last message with the fenced json block instead.')
    return 1
  }
  try {
    await client.postResult(thread, result)
  } catch (err) {
    // A refusal names the rule and prints the work list, so the worker sees what to close first.
    if (!(err instanceof DaemonError)) throw err
    console.error(`clyde result: ${err.message}`)
    return 1
  }
  const n = Array.isArray(result.evidence) ? result.evidence.length : 0
  console.log(`Reported ${values.status} for thread ${thread}, with ${n} evidence item${n === 1 ? '' : 's'}.`)
  return 0
}

function usage(problem: string): number {
  console.error(problem)
  console.error(USAGE)
  return 2
}
