#!/usr/bin/env node
/** clyde: the one CLI every agent shares. Each command lives in src/cli/<command>.ts and exports main(argv). */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { adoptRenamedEnv } from '../src/config.ts'

const COMMANDS: Record<string, string> = {
  daemon: 'Run the clyde daemon in the foreground',
  status: 'Threads and runs, one line each. --all adds the threads of finished runs. --json prints the raw state',
  thread: 'start, send, read, stop or run a background thread',
  flow: 'run, start, answer, stop or list a workflow run',
  notes: 'Read shared notes or create an additive verified index of existing sources in a Paseo run',
  recall: 'Search memory. Scope defaults to CLYDE_MEMORY_SCOPE',
  remember: 'Write a draft note to memory in the current run',
  plan: "Show or set the run's plan",
  progress: 'Post a one-line status update from inside a thread',
  result: "Post the worker's result to the daemon",
  todo: "Read or change this thread's work list: list, add, start, done, block",
  hook: 'Forward a hook payload on stdin to memory and the daemon',
  doctor: 'Check the CLIs, memory and the daemon',
  up: 'Start the point man, through Happier when it is set up',
  install: "Link the clyde extension into pi's agent dir",
}

const cliDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli')

function help(): void {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length))
  console.log('Usage: clyde <command> [options]\n\nCommands:')
  for (const [name, line] of Object.entries(COMMANDS)) console.log(`  ${name.padEnd(width)}  ${line}`)
}

async function main(argv: string[]): Promise<number> {
  adoptRenamedEnv()
  const [cmd, ...rest] = argv
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    help()
    return 0
  }
  if (!(cmd in COMMANDS)) {
    console.error(`clyde: unknown command ${cmd}. Run clyde help for the list.`)
    return 2
  }
  const path = join(cliDir, `${cmd}.ts`)
  if (!existsSync(path)) {
    console.error(`clyde ${cmd}: not built yet`)
    return 3
  }
  const mod = await import(pathToFileURL(path).href)
  const code = await mod.main(rest)
  return typeof code === 'number' ? code : 0
}

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code },
  (err) => {
    console.error(`clyde: ${err?.message ?? err}`)
    process.exitCode = 1
  },
)
