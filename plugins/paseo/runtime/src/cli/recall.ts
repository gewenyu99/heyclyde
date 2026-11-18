/** clyde recall "<query>" [--scope run:<id>] [--task T]: memory recall with the agent token. The scope defaults to CLYDE_MEMORY_SCOPE. */
import { parseArgs } from 'node:util'
import { agentMemory } from '../memory.ts'

const USAGE = 'Usage: clyde recall "<query>" [--scope run:<id>] [--task T]'

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, options: { scope: { type: 'string' }, task: { type: 'string' } },
  })
  const query = positionals.join(' ').trim()
  if (!query) {
    console.error(USAGE)
    return 2
  }
  const memory = agentMemory()
  const scope = values.scope ?? process.env.CLYDE_MEMORY_SCOPE ?? ''
  console.log((await memory.recall(query, scope, values.task)).trimEnd())
  return 0
}
