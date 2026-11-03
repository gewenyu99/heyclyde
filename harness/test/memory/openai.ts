/**
 * Tier 3 support: a local stand-in for the two OpenAI routes the memory function calls, so CI never reaches OpenAI.
 * The function reads its URL from MEMORY_OPENAI_URL. Embeddings hash words into the vector, so texts that share words
 * sit close. The Decisions judge passes every write unless it holds FAKE_REFUSE, calls every recall item relevant, and
 * reads the learner's prompt as pushback when it holds FAKE_PUSHBACK. A request holding FAKE_DOWN gets a 500, as an
 * OpenAI outage would.
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

export const FAKE_REFUSE = 'fake-openai-refuses-this'
export const FAKE_DOWN = 'fake-openai-is-down'
export const FAKE_PUSHBACK = 'fake-openai-hears-pushback'
const DIM = 1024

export type FakeOpenAI = { url: string; calls: { path: string; body: any }[]; close: () => Promise<void> }

function vector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[createHash('sha256').update(word).digest().readUInt32BE(0) % DIM] += 1
  // A shared axis the text's own hash scales, so texts with no word in common still sit at distinct distances. Without it
  // they tie at 0, and a tie's order in the HNSW index isn't something a test can pin.
  v[0] += 0.05 + 0.05 * (createHash('sha256').update(`tie:${text}`).digest().readUInt32BE(0) / 2 ** 32)
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

function answer(path: string, body: any): unknown {
  const tokens = JSON.stringify(body).length
  if (path === '/embeddings') {
    return { data: body.input.map((t: string, index: number) => ({ index, embedding: vector(t) })), usage: { total_tokens: tokens } }
  }
  if (path === '/decisions') {
    // Recall's filter names its questions i1, i2 and so on. The write screen and the learner name their own.
    const input = String(body.input)
    const refuse = input.includes(FAKE_REFUSE), pushback = input.includes(FAKE_PUSHBACK)
    const answers = body.questions.map((q: { type: string; name: string; choices?: { value: string }[] }) => {
      // The learner's cause blames the first delivered item, after "none".
      if (q.type === 'choice') return { type: 'choice', name: q.name, choice: pushback ? (q.choices?.[1] ?? q.choices?.[0])?.value : 'none' }
      const yes = /^i\d+$/.test(q.name) || (refuse && q.name === 'injection') || (pushback && q.name === 'pushback')
      return { type: 'predicate', name: q.name, probability: yes ? 0.9 : 0.01 }
    })
    return { answers, usage: { input_tokens: tokens } }
  }
  return null
}

export async function startFakeOpenAI(): Promise<FakeOpenAI> {
  const calls: FakeOpenAI['calls'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const path = (req.url ?? '').replace(/^\/v1/, '')
      let body: any
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      calls.push({ path, body })
      if (JSON.stringify(body ?? '').includes(FAKE_DOWN)) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: 'fake OpenAI is down' } }))
        return
      }
      const out = req.method === 'POST' && body && req.headers.authorization ? answer(path, body) : null
      res.writeHead(out ? 200 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out ?? { error: { message: `fake OpenAI has no ${req.method} ${req.url}` } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
