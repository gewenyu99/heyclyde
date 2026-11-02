/**
 * Tier 3 support: a local stand-in for the two OpenAI routes the memory function calls, so CI never reaches OpenAI.
 * The function reads its URL from MEMORY_OPENAI_URL. Embeddings hash words into the vector, so texts that share words
 * sit close. The Decisions judge passes every write unless it holds FAKE_REFUSE, and calls every recall item relevant.
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

export const FAKE_REFUSE = 'fake-openai-refuses-this'
const DIM = 1024

export type FakeOpenAI = { url: string; calls: { path: string; body: any }[]; close: () => Promise<void> }

function vector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[createHash('sha256').update(word).digest().readUInt32BE(0) % DIM] += 1
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

function answer(path: string, body: any): unknown {
  const tokens = JSON.stringify(body).length
  if (path === '/embeddings') {
    return { data: body.input.map((t: string, index: number) => ({ index, embedding: vector(t) })), usage: { total_tokens: tokens } }
  }
  if (path === '/decisions') {
    // Recall's filter names its questions i1, i2 and so on. The write screen names its own.
    const refuse = String(body.input).includes(FAKE_REFUSE)
    const answers = body.questions.map((q: { name: string }) => ({
      type: 'predicate', name: q.name, probability: /^i\d+$/.test(q.name) ? 0.9 : refuse && q.name === 'injection' ? 0.99 : 0.01,
    }))
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
      const out = req.method === 'POST' && body && req.headers.authorization ? answer(path, body) : null
      calls.push({ path, body })
      res.writeHead(out ? 200 : 400, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out ?? { error: { message: `fake OpenAI has no ${req.method} ${req.url}` } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }) }
}
