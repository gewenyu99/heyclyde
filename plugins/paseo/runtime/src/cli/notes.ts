import { parseArgs } from 'node:util'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { agentReply, type Identity } from '../../../server/connection.ts'
import { clydeHome } from '../config.ts'
import { readJson, readJsonDir, writeJson } from '../store.ts'

const usage =
  'clyde notes recall QUERY | more RETRIEVAL_ID | get NOTE_ID | feedback RETRIEVAL_ID JSON | index --title TITLE --body TEXT --source NOTE_ID [--source NOTE_ID ...]'
export async function main(argv: string[]): Promise<number> {
  const [op, ...args] = argv
  if (!op || op === '--help') {
    console.log(usage)
    return 0
  }
  const run = process.env.CLYDE_RUN_ID, thread = process.env.CLYDE_THREAD_ID
  if (!run || !/^r-[a-z0-9-]+$/.test(run) || !thread || !/^t-[a-z0-9-]+$/.test(thread)) {
    throw Error('Shared notes require a Clyde run and thread')
  }
  const home = clydeHome()
  const record = readJson<{ runId?: string; readOnly?: boolean }>(join(home, 'threads', thread + '.json'))
  if (record?.runId !== run) throw Error('This thread does not belong to the run')
  const agent = readJson<Record<string, { agent: string }>>(join(home, 'chat-runs.json'))?.[run]?.agent ??
    readJson<{ paseoParentId?: string }>(join(home, 'runs', run + '.json'))?.paseoParentId
  const owner = agent && readJson<Record<string, Identity>>(join(home, 'residents.json'))?.[agent]
  if (!owner) throw Error('No originating Clyde memory identity is bound to this run')
  async function call(tool: string, input: Record<string, unknown>) {
    return (await agentReply(owner!, tool, input)).text
  }
  if (op === 'recall' && args.length) {
    const query = args.join(' ')
    const reply = await agentReply(owner, 'recall', {
      query,
      task: 'Groom shared memory; preserve original notes and artifacts.',
    })
    const card = reply.card as { retrieval_id?: string; items?: { id: string }[] }
    if (card?.retrieval_id && Array.isArray(card.items)) {
      const proof = {
        query: query.slice(0, 300),
        retrieval: card.retrieval_id,
        at: new Date().toISOString(),
        ids: card.items.map((n) => n.id),
      }
      const probeDir = join(home, 'note-probes', run)
      writeJson(join(probeDir, card.retrieval_id + '.json'), proof, 0o600)
      for (const note of readJsonDir<{ id: string; probes?: typeof proof[] }>(join(home, 'note-receipts', run))) {
        if (!proof.ids.includes(note.id)) continue
        const prior = readJsonDir<typeof proof>(probeDir).filter((v) =>
          v.query === query && v.retrieval !== proof.retrieval
        ).sort((a, b) =>
          a.at.localeCompare(b.at)
        )[0]
        const probes = [...(note.probes ?? []).filter((v) => v.query !== query).slice(-9), {
          ...proof,
          ...(prior ? { previous: prior.ids } : {}),
        }]
        writeJson(join(home, 'note-receipts', run, createHash('sha256').update(note.id).digest('hex') + '.json'), {
          ...note,
          probes,
        }, 0o600)
      }
    }
    console.log(reply.text)
    return 0
  }
  if (op === 'more' && args.length === 1) {
    console.log(await call('recall_more', { retrieval_id: args[0] }))
    return 0
  }
  if (op === 'get' && args.length === 1) {
    console.log(await call('get_entry', { id: args[0] }))
    return 0
  }
  if (op === 'feedback' && args.length === 2) {
    console.log(await call('feedback', { ...JSON.parse(args[1]), retrieval_id: args[0] }))
    return 0
  }
  const dir = join(home, 'note-receipts', run)
  type Receipt = {
    id: string
    title: string
    sources: string[]
    body?: string
    sourceCount?: number
    verifiedAt?: string
  }
  const receipts = () => readJsonDir<Receipt>(dir)
  async function verifyReceipt(note: Receipt) {
    const reply = await agentReply(owner!, 'get_entry', { id: note.id })
    if (!reply.text.startsWith(note.id + ':') || note.sources.some((s) => !reply.text.includes('relates ' + s))) {
      throw Error('Could not verify every source link on ' + note.id)
    }
    const card = reply.card as { entry?: { body?: string } }
    const receipt = {
      ...note,
      body: card?.entry?.body || reply.text.split('Evidence (')[0].slice(0, 1600),
      sourceCount: note.sources.length,
      verifiedAt: new Date().toISOString(),
    }
    writeJson(join(dir, createHash('sha256').update(note.id).digest('hex') + '.json'), receipt, 0o600)
    return receipt
  }
  if (op === 'verify') {
    const records = receipts()
    for (const note of records) await verifyReceipt(note)
    console.log(
      JSON.stringify({ verified: records.length, distinctSources: new Set(records.flatMap((r) => r.sources)).size }),
    )
    return 0
  }
  if (op !== 'index') throw Error(usage)
  if (record.readOnly) throw Error('Reviewers cannot write an index')
  const { values } = parseArgs({
    args,
    options: { title: { type: 'string' }, body: { type: 'string' }, source: { type: 'string', multiple: true } },
  })
  const title = values.title?.trim(), body = values.body?.trim(), sources = [...new Set(values.source ?? [])]
  if (!title || !body || !sources.length || sources.length > 12 || sources.some((s) => !s.trim())) throw Error(usage)
  const existing = receipts().find((r) =>
    r.sources.length === sources.length && sources.every((id) => r.sources.includes(id))
  )
  if (existing) {
    console.log(JSON.stringify(await verifyReceipt(existing)))
    return 0
  }
  for (const id of sources) {
    const source = await call('get_entry', { id })
    if (!source.startsWith(id + ':')) throw Error('Cannot verify source note ' + id)
  }
  const note = await call('remember', {
    pattern: 'references',
    title,
    body,
    long: body.length > 500,
    evidence: 'Related source notes: ' + sources.join(', '),
    links: sources.map((to) => ({ type: 'relates', to })),
    project_slug: owner!.project,
  })
  const id = note.match(/^Remembered (\S+)\.(?:\s|$)/)?.[1]
  if (!id) throw Error('Clyde did not acknowledge the new index: ' + note.slice(0, 200))
  await verifyReceipt({ id, title, sources })
  console.log(JSON.stringify({ id, title, sources, verified: true }))
  return 0
}
