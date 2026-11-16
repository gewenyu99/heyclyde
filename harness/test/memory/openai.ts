/**
 * Tier 3 support: a local stand-in for the OpenAI and Gemini routes the memory function calls, so CI never reaches OpenAI
 * or Google. The function reads their URLs from MEMORY_OPENAI_URL and MEMORY_GEMINI_URL. Embeddings hash words into the
 * vector, so texts that share words sit close. The Decisions judge passes every write unless it holds FAKE_REFUSE (or
 * FAKE_SAFETY for Gemini 400 safety blocks), calls every recall item relevant, reads the learner's prompt as pushback when
 * it holds FAKE_PUSHBACK, and rates a recall item holding FAKE_IRRELEVANT at 0.01. A request holding FAKE_DOWN gets a 500.
 */
import { createHash } from 'node:crypto'
import http from 'node:http'

export const FAKE_REFUSE = 'fake-openai-refuses-this'
export const FAKE_DOWN = 'fake-openai-is-down'
export const FAKE_PUSHBACK = 'fake-openai-hears-pushback'
// A recall item holding this gets a relevance of 0.01, so the filter cuts it.
export const FAKE_IRRELEVANT = 'fake-openai-finds-this-irrelevant'
export const FAKE_SAFETY = 'fake-gemini-safety-blocks-this'
const DIM = 1024

export type FakeCall = { path: string; body: any; headers: Record<string, string | string[] | undefined>; tokens: number; api?: 'openai' | 'gemini' }
export type FakeOpenAI = { url: string; geminiUrl: string; calls: FakeCall[]; options: FakeOptions; close: () => Promise<void> }
/** delayMs holds every /decisions answer that long. failShadow answers 500 to every call the shadow runner tags with
 * x-memory-purpose: shadow. Both are the fake's options, so the function itself has no fault switch, and a test may change
 * them on the running fake through its `options`. */
export type FakeOptions = { delayMs?: number; failShadow?: boolean }

function vector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) v[createHash('sha256').update(word).digest().readUInt32BE(0) % DIM] += 1
  // A shared axis the text's own hash scales, so texts with no word in common still sit at distinct distances. Without it
  // they tie at 0, and a tie's order in the HNSW index isn't something a test can pin.
  v[0] += 0.05 + 0.05 * (createHash('sha256').update(`tie:${text}`).digest().readUInt32BE(0) / 2 ** 32)
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

function answer(path: string, body: any, gemini: boolean): unknown {
  const tokens = JSON.stringify(body).length
  if (path === '/embeddings' && !gemini) {
    return { data: body.input.map((t: string, index: number) => ({ index, embedding: vector(t) })), usage: { total_tokens: tokens } }
  }
  if (path === '/decisions') {
    const input = String(body.input)
    const refuse = input.includes(FAKE_REFUSE), pushback = input.includes(FAKE_PUSHBACK)
    // Recall's items are numbered "[n] text" lines, so an item's text is what follows its number up to the next one.
    const irrelevant = new Set(input.split(/\n(?=\[\d+\] )/).filter((part) => part.includes(FAKE_IRRELEVANT)).map((part) => /^\[(\d+)\]/.exec(part)?.[1]))
    if (gemini) {
      if (!body.questions || Array.isArray(body.questions) || body.model !== 'gemini-decision-1') return null
      const answers: Record<string, unknown> = {}
      for (const [name, q] of Object.entries(body.questions as Record<string, { type: string; criteria?: Record<string, string> }>)) {
        if (q.type === 'choice') {
          answers[name] = { type: 'choice', choice: pushback && q.criteria && '0' in q.criteria ? '0' : 'none' }
        } else {
          const yes = (/^i\d+$/.test(name) && !irrelevant.has(name.slice(1))) || (refuse && name === 'injection') || (pushback && name === 'pushback')
          answers[name] = { type: 'noul', noul: yes ? 0.9 : 0.01, confidence: 0.9 }
        }
      }
      return { answers, usage: { total_input_tokens: tokens, total_tokens: tokens } }
    }
    if (!Array.isArray(body.questions)) return null
    const answers = body.questions.map((q: { type: string; name: string; choices?: { value: string }[] }) => {
      // The learner's cause blames the first delivered item, after "none".
      if (q.type === 'choice') return { type: 'choice', name: q.name, choice: pushback ? (q.choices?.[1] ?? q.choices?.[0])?.value : 'none' }
      const yes = (/^i\d+$/.test(q.name) && !irrelevant.has(q.name.slice(1))) || (refuse && q.name === 'injection') || (pushback && q.name === 'pushback')
      return { type: 'predicate', name: q.name, probability: yes ? 0.9 : 0.01 }
    })
    return { answers, usage: { input_tokens: tokens } }
  }
  return null
}

export async function startFakeOpenAI(options: FakeOptions = {}): Promise<FakeOpenAI> {
  const calls: FakeOpenAI['calls'] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const rawPath = req.url ?? ''
      const gemini = rawPath.startsWith('/v1beta')
      const path = rawPath.replace(/^\/v1(?:beta)?/, '')
      let body: any
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = null
      }
      const shadow = req.headers['x-memory-purpose'] === 'shadow'
      const down = JSON.stringify(body ?? '').includes(FAKE_DOWN) || (shadow && options.failShadow)
      const safety = gemini && path === '/decisions' && JSON.stringify(body ?? '').includes(FAKE_SAFETY)
      const authOk = gemini ? Boolean(req.headers['x-goog-api-key']) && !req.headers.authorization : Boolean(req.headers.authorization)
      const out = !down && !safety && req.method === 'POST' && body && authOk ? answer(path, body, gemini) as any : null
      // The tokens this call is charged, as the function reads them from usage.
      calls.push({
        path,
        body,
        headers: req.headers,
        tokens: out?.usage?.input_tokens ?? out?.usage?.total_input_tokens ?? out?.usage?.total_tokens ?? 0,
        api: gemini ? 'gemini' : 'openai',
      })
      const send = () => {
        if (down) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: 'fake OpenAI is down' } }))
          return
        }
        if (safety) {
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { code: 'safety', message: 'fake Gemini safety block' } }))
          return
        }
        res.writeHead(out ? 200 : 400, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out ?? { error: { message: `fake OpenAI has no ${req.method} ${req.url}` } }))
      }
      if (options.delayMs && path === '/decisions') setTimeout(send, options.delayMs)
      else send()
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${port}/v1`,
    geminiUrl: `http://127.0.0.1:${port}/v1beta`,
    calls,
    options,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}
