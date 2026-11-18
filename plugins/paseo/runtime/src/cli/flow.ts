/** clyde flow run|start|answer|stop|list|read: workflow runs from the command line, headless or through the running daemon. */
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { ensureDaemon, type DaemonClient } from '../client.ts'
import { connect } from '../daemon.ts'
import type { Run } from '../flow/types.ts'
import type { ClydeEvent } from '../types.ts'
import { runLine } from './status.ts'

const USAGE = `Usage:
  clyde flow run <flow> --input <json|@file> [--answers <file>] [--auto-approve] [--json]
  clyde flow start <flow> --input <json|@file> [--json]
  clyde flow answer <id> <text>
  clyde flow stop <id>
  clyde flow list [--json]
  clyde flow read <id> [--json]

clyde flow run exits 0 when the run is done, 1 when it failed or stopped, and 2 when it asked something nothing answered.`

const OPTIONS = {
  input: { type: 'string' }, answers: { type: 'string' }, 'auto-approve': { type: 'boolean' }, json: { type: 'boolean' }, text: { type: 'string' },
} as const

type Answer = { match: string; text: string }
type Values = { input?: string; answers?: string; 'auto-approve'?: boolean; json?: boolean; text?: string }

export async function main(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  let parsed
  try {
    parsed = parseArgs({ args: rest, options: OPTIONS, allowPositionals: true })
  } catch (err) {
    return usage((err as Error).message)
  }
  const { values, positionals } = parsed
  const [first, ...words] = positionals
  if (sub === 'run' || sub === 'start') {
    if (!first) return usage(`clyde flow ${sub} needs a flow name, like task or ship.`)
    let input: unknown
    try {
      input = readInput(values.input)
    } catch (err) {
      return usage((err as Error).message)
    }
    return sub === 'run' ? run(first, input, values) : start(first, input, values.json)
  }
  if (sub === 'list') return list(values.json)
  if (sub === 'answer' || sub === 'stop' || sub === 'read') {
    if (!first) return usage(`clyde flow ${sub} needs a run id.`)
    const client = await ensureDaemon()
    if (sub === 'read') return read(await client.run(first), values.json)
    if (sub === 'stop') return show(await client.stopRun(first), values.json)
    const text = values.text ?? words.join(' ')
    if (!text.trim()) return usage('clyde flow answer needs the answer text.')
    return show(await client.answer(first, text), values.json)
  }
  return usage(sub ? `Unknown subcommand ${sub}.` : '')
}

function usage(problem: string): number {
  if (problem) console.error(problem)
  console.error(USAGE)
  return 2
}

/** --input takes JSON, or @path for a JSON file. No input is an empty object, so the flow says what's missing. */
function readInput(raw?: string): unknown {
  if (raw === undefined) return {}
  const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`--input must be JSON or @file.json, and ${raw.length > 60 ? `${raw.slice(0, 57)}...` : raw} isn't`)
  }
}

function readAnswers(path: string): Answer[] {
  const list = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(list) || !list.every((a) => typeof a?.match === 'string' && typeof a?.text === 'string')) {
    throw new Error(`--answers ${path} must be a JSON list of {"match": "<regex>", "text": "<answer>"}`)
  }
  for (const a of list) new RegExp(a.match)
  return list
}

/** The first --answers entry whose match fits the question. Else --auto-approve: approvals get approved, the rest stop. */
export function pickAnswer(question: string, kind: string, answers: Answer[], auto: boolean): { text: string; via: string } | null {
  const found = answers.find((a) => new RegExp(a.match).test(question))
  if (found) return { text: found.text, via: 'answers file' }
  if (auto) return { text: kind === 'approve' ? 'approved' : 'stop', via: 'auto-approve' }
  return null
}

// ---------------------------------------------------------------- clyde flow run

async function run(flow: string, input: unknown, values: Values): Promise<number> {
  let answers: Answer[] = []
  try {
    answers = values.answers ? readAnswers(values.answers) : []
  } catch (err) {
    return usage((err as Error).message)
  }
  const print = (line: string) => (values.json ? process.stderr : process.stdout).write(`${line}\n`)
  const { client, daemon } = await connect()
  try {
    let started: Run
    try {
      started = await client.startRun(flow, input, process.cwd(), undefined, process.env.CLYDE_THREAD_ID)
    } catch (err) {
      console.error(`clyde flow run: ${(err as Error).message}`)
      return 1
    }
    const seen: ClydeEvent[] = []
    const stop = () => { client.stopRun(started.id).catch(() => {}) }
    process.once('SIGINT', stop)
    const code = await follow(client, started, (e) => {
      seen.push(e)
      print(`${e.type.padEnd(15)} ${e.summary}`)
    }, (e) => {
      const data = (e.data ?? {}) as { question?: string; kind?: string }
      const picked = pickAnswer(data.question ?? '', data.kind ?? 'approve', answers, values['auto-approve'] === true)
      if (picked) print(`${'answer'.padEnd(15)} ${picked.text} (${picked.via})`)
      else print(`\nRun ${started.id} is waiting on this, and nothing here answers it:\n\n${data.question ?? ''}\n\nAnswer with clyde flow answer ${started.id} "<text>".`)
      return picked
    })
    process.off('SIGINT', stop)
    if (values.json) {
      const final: Run = await client.run(started.id)
      const stages = final.stages.map((s) => ({ name: s.name, passed: s.status === 'passed', attempts: s.attempts.length, verdict: s.verdict ?? null }))
      console.log(JSON.stringify({ run: final.id, status: final.status, stages, entries: final.entries, events: seen }, null, 2))
    }
    return code
  } finally {
    await daemon?.close()
  }
}

/**
 * Streams the run's events from its first one. Each ask goes to onAsk, and an answer it picks is posted.
 * Resolves with the exit code: 0 done, 1 failed or stopped, 2 an ask nothing answered.
 */
function follow(client: DaemonClient, started: Run, onEvent: (e: ClydeEvent) => void, onAsk: (e: ClydeEvent) => { text: string; via: string } | null): Promise<number> {
  return new Promise((resolve) => {
    let finished = false
    const end = (code: number) => {
      if (finished) return
      finished = true
      close()
      resolve(code)
    }
    const close = client.events(started.firstEvent - 1, (e) => {
      if (finished || e.runId !== started.id) return
      onEvent(e)
      if (e.type === 'run.done') return end(0)
      if (e.type === 'run.failed' || e.type === 'run.stopped') return end(1)
      if (e.type !== 'run.ask') return
      const picked = onAsk(e)
      if (!picked) return end(2)
      client.call('POST', `/runs/${encodeURIComponent(started.id)}/answer`, picked).catch((err) => {
        console.error(`clyde flow run: the answer didn't land: ${(err as Error).message}`)
        end(1)
      })
    }, (err) => {
      if (!finished) console.error(`clyde flow run: the event stream ended${err ? `: ${err.message}` : ''}`)
      end(1)
    })
  })
}


// ---------------------------------------------------------------- the rest

async function start(flow: string, input: unknown, json?: boolean): Promise<number> {
  const client = await ensureDaemon()
  return show(await client.startRun(flow, input, process.cwd(), undefined, process.env.CLYDE_THREAD_ID), json)
}

async function list(json?: boolean): Promise<number> {
  const client = await ensureDaemon()
  const runs: Run[] = await client.runs()
  if (json) console.log(JSON.stringify(runs, null, 2))
  else if (!runs.length) console.log('No runs.')
  else for (const r of runs) console.log(runLine(r))
  return 0
}

function show(r: Run, json?: boolean): number {
  console.log(json ? JSON.stringify(r, null, 2) : runLine(r))
  return 0
}

function read(r: Run, json?: boolean): number {
  if (json) return show(r, true)
  console.log(runLine(r))
  console.log(`branch ${r.branch} in ${r.cwd}`)
  for (const s of r.stages) {
    const n = `${s.attempts.length} attempt${s.attempts.length === 1 ? '' : 's'}`
    console.log(`  stage  ${s.name.padEnd(24)}  ${s.status.padEnd(7)}  ${n.padEnd(10)}  ${s.summary ?? ''}`.trimEnd())
  }
  if (r.status === 'asking' && r.question) console.log(`\nasking: ${r.question}`)
  if (r.error) console.log(`\nerror: ${r.error}`)
  return 0
}
