/** clyde remember: one draft note in the run's memory scope, written with the agent token. memory picks the id and the source. */
import { readFileSync } from 'node:fs'
import { basename, extname } from 'node:path'
import { parseArgs } from 'node:util'
import { clip } from '../flow/memory.ts'
import { agentMemory } from '../memory.ts'

const USAGE = 'Usage: clyde remember --title T --pattern P [--body B] [--blob-file F] [--blob-name N] [--scope run:<id>] [--supersedes <id>]...'
const PATTERNS = ['observations', 'decisions', 'references', 'recommendations', 'preferences', 'reactions']
const MEDIA: Record<string, string> = {
  '.json': 'application/json', '.md': 'text/markdown', '.patch': 'text/x-diff', '.diff': 'text/x-diff',
  '.txt': 'text/plain', '.log': 'text/plain', '.ts': 'text/plain', '.js': 'text/plain', '.py': 'text/plain',
}

type Blob = { name: string; media_type: string; text?: string; base64?: string }

/** Text when the file is UTF-8, base64 otherwise, so a binary file survives the trip. */
export function readBlob(path: string, name?: string): Blob {
  const data = readFileSync(path)
  const text = data.toString('utf8')
  const blob: Blob = { name: name || basename(path), media_type: MEDIA[extname(path).toLowerCase()] ?? 'text/plain' }
  if (Buffer.from(text, 'utf8').equals(data) && !text.includes('\0')) blob.text = text
  else Object.assign(blob, { base64: data.toString('base64'), media_type: 'application/octet-stream' })
  return blob
}

/** The payload an agent may send: a draft in a run scope, no id and no source. */
export function payload(o: { title: string; pattern: string; body?: string; blob?: Blob; scope: string; supersedes?: string[] }): Record<string, unknown> {
  const runId = o.scope.slice('run:'.length)
  const body = o.body?.trim() || o.blob?.text?.trim() || o.title
  const evidence = o.blob?.text?.trim() || body
  const p: Record<string, unknown> = {
    pattern: o.pattern, title: clip(o.title, 300), body: clip(body, 4000), authority: 'draft', scope: o.scope,
    evidence_kind: 'assistant', evidence: clip(evidence, 20000), project: `run-${runId}`,
  }
  if (o.blob) p.blobs = [o.blob]
  if (o.supersedes?.length) p.supersedes = o.supersedes
  return p
}

export async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      title: { type: 'string' }, pattern: { type: 'string' }, body: { type: 'string' },
      'blob-file': { type: 'string' }, 'blob-name': { type: 'string' }, scope: { type: 'string' },
      supersedes: { type: 'string', multiple: true },
    },
  })
  if (!values.title?.trim() || !values.pattern) return usage('clyde remember needs --title and --pattern.')
  if (!PATTERNS.includes(values.pattern)) return usage(`--pattern must be one of ${PATTERNS.join(', ')}.`)
  const scope = values.scope ?? process.env.CLYDE_MEMORY_SCOPE ?? (process.env.CLYDE_RUN_ID ? `run:${process.env.CLYDE_RUN_ID}` : '')
  if (!/^run:[A-Za-z0-9._-]+$/.test(scope)) return usage('clyde remember writes only in a run scope. Pass --scope run:<id>, or run it inside a clyde run.')
  const memory = agentMemory()
  let blob: Blob | undefined
  if (values['blob-file']) {
    try {
      blob = readBlob(values['blob-file'], values['blob-name'])
    } catch (err) {
      console.error(`clyde remember: can't read ${values['blob-file']}: ${(err as Error).message}`)
      return 1
    }
  }
  const out = await memory.remember(payload({ title: values.title, pattern: values.pattern, body: values.body, blob, scope, supersedes: values.supersedes }))
  console.log(`Remembered ${out.id} as a draft in ${scope}.`)
  for (const b of out.blobs ?? []) console.log(`Blob ${b.name}: ${b.sha256}`)
  return 0
}

function usage(problem: string): number {
  console.error(problem)
  console.error(USAGE)
  return 2
}
