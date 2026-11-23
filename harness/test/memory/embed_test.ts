/**
 * Tier 3's unit tests of the memory function's own code, run with `deno test`, since they import it as deno does. No
 * database: postgres.js only connects on a first query. node --test skips this file, which isn't a *.test.ts.
 */
import assert from 'node:assert/strict'
import { OPENAI_PRICES_MICRO_USD_PER_M } from '../../../memory/supabase/functions/memory/billing/cost.ts'
import { activeEmbedModel, embed, entryText, GEMINI_EMBED_MODEL } from '../../../memory/supabase/functions/memory/embed.ts'

type RecordedFetch = { url: string; method: string; headers: Record<string, string>; body: any }

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prev = new Map<string, string | undefined>()
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, Deno.env.get(k))
    if (v === undefined) Deno.env.delete(k)
    else Deno.env.set(k, v)
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k)
      else Deno.env.set(k, v)
    }
  }
}

async function withMockFetch(
  handler: (req: RecordedFetch) => Response | Promise<Response>,
  fn: (calls: RecordedFetch[]) => Promise<void>,
) {
  const original = globalThis.fetch
  const calls: RecordedFetch[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET')
    const rawHeaders = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    const headers: Record<string, string> = {}
    rawHeaders.forEach((v, k) => {
      headers[k.toLowerCase()] = v
    })
    const rawBody = typeof init?.body === 'string' ? init.body : ''
    const body = rawBody ? JSON.parse(rawBody) : null
    const rec = { url, method, headers, body }
    calls.push(rec)
    return await handler(rec)
  }) as typeof fetch
  try {
    await fn(calls)
  } finally {
    globalThis.fetch = original
  }
}

// R9 (#12): entryText of a private row is its title.
Deno.test('entryText sends a private or confidential entry to OpenAI by its title alone', () => {
  const row = {
    title: 'Buys oolong from a private supplier', body: 'Supplier name and pricing.', evidence: 'my supplier is secret co',
    search_text: 'Buys oolong from a private supplier\nSupplier name and pricing.\nmy supplier is secret co',
  }
  assert.equal(entryText({ ...row, sensitivity: 'private' }), row.title)
  assert.equal(entryText({ ...row, sensitivity: 'confidential' }), row.title)
  assert.equal(entryText({ ...row, sensitivity: 'normal' }), row.search_text)
})

Deno.test('activeEmbedModel switches cleanly between Gemini and OpenAI', async () => {
  assert.equal(GEMINI_EMBED_MODEL, 'gemini-embedding-001')
  assert.equal(OPENAI_PRICES_MICRO_USD_PER_M['gemini-embedding-001'], 150_000)
  await withEnv({ MEMORY_GEMINI_KEY: undefined }, async () => {
    assert.equal(await activeEmbedModel({ readSecret: async () => '' }), 'text-embedding-3-large')
    assert.equal(await activeEmbedModel({ readSecret: async () => 'gem-key' }), GEMINI_EMBED_MODEL)
  })
  await withEnv({ MEMORY_GEMINI_KEY: 'env-gem-key' }, async () => {
    assert.equal(await activeEmbedModel({ readSecret: async () => '' }), GEMINI_EMBED_MODEL)
  })
})

Deno.test('embed uses Gemini batchEmbedContents with x-goog-api-key, normalizes 1024-dim vectors, and meters tokens', async () => {
  const metered: { kind: string; tokens: number; model?: string }[] = []
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_GEMINI_URL: 'https://gemini.test/v1beta', MEMORY_OPENAI_URL: 'https://openai.test/v1' }, async () => {
    await withMockFetch(() => {
      const vec = new Array<number>(1024).fill(0)
      vec[0] = 3
      vec[1] = 4
      return Response.json({
        embeddings: [{ values: vec }, { values: vec }],
        usageMetadata: { promptTokenCount: 42, totalTokenCount: 42 },
      })
    }, async (calls) => {
      const vecs = await embed(['alpha', 'beta'], {
        assertBudget: async () => {},
        meter: async (kind, tokens, model) => { metered.push({ kind, tokens, model }) },
        readSecret: async (name) => (name === 'gemini_key' ? 'gem-key-1' : ''),
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://gemini.test/v1beta/models/gemini-embedding-001:batchEmbedContents')
      assert.equal(calls[0].headers['x-goog-api-key'], 'gem-key-1')
      assert.equal(calls[0].headers.authorization, undefined)
      assert.equal(calls[0].body.requests.length, 2)
      assert.equal(calls[0].body.requests[0].outputDimensionality, 1024)
      assert.equal(vecs.length, 2)
      assert.equal(vecs[0].length, 1024)
      assert.ok(Math.abs(vecs[0][0] - 0.6) < 1e-6)
      assert.ok(Math.abs(vecs[0][1] - 0.8) < 1e-6)
      assert.deepEqual(metered, [{ kind: 'embed', tokens: 42, model: 'gemini-embedding-001' }])
    })
  })
})

Deno.test('embed falls back to OpenAI when gemini_key is absent', async () => {
  const metered: { kind: string; tokens: number; model?: string }[] = []
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_OPENAI_URL: 'https://openai.test/v1' }, async () => {
    await withMockFetch(() => {
      const vec = new Array<number>(1024).fill(0)
      vec[0] = 1
      return Response.json({
        data: [{ index: 0, embedding: vec }],
        usage: { total_tokens: 17 },
      })
    }, async (calls) => {
      const vecs = await embed(['hello'], {
        assertBudget: async () => {},
        meter: async (kind, tokens, model) => { metered.push({ kind, tokens, model }) },
        readSecret: async () => '',
      })
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://openai.test/v1/embeddings')
      assert.equal(calls[0].headers.authorization, 'Bearer fake')
      assert.equal(vecs.length, 1)
      assert.deepEqual(metered, [{ kind: 'embed', tokens: 17, model: 'text-embedding-3-large' }])
    })
  })
})
