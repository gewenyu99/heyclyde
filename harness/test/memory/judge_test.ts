/**
 * Tier 3's unit tests of R71 (#76): dual-key Gemini Decisions API judge with OpenAI fallback, run with `deno test`
 * under CI's exact flags (`--allow-env --allow-read --node-modules-dir=none`, no `--allow-net` and no database).
 * Stubs `globalThis.fetch` in-process and restores it in `finally`.
 */
import assert from 'node:assert/strict'
import { OPENAI_PRICES_MICRO_USD_PER_M } from '../../../memory/supabase/functions/memory/billing/cost.ts'
import {
  activeJudgeVersion,
  GEMINI_JUDGE_VERSION,
  JUDGE_VERSION,
  reaction,
  relevance,
  screen,
} from '../../../memory/supabase/functions/memory/judge.ts'

const RELEVANT_TRUE =
  'An assistant handling the request needs this item to answer accurately (including notes stating something is undecided/undefined, or covering a broader range or rule that applies to the subject) or must respect it.'
const RELEVANT_FALSE = 'The item only shares a word or general topic with the request without answering or constraining it.'

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

function fakeDeps(geminiSecret = '') {
  const metered: { kind: string; tokens: number; model?: string }[] = []
  return {
    metered,
    deps: {
      assertBudget: async () => {},
      meter: async (kind: string, tokens: number, model?: string) => {
        metered.push({ kind, tokens, model })
      },
      readSecret: async (name: string) => (name === 'gemini_key' ? geminiSecret : ''),
    },
  }
}

Deno.test('judge versions: activeJudgeVersion switches cleanly between Gemini and OpenAI', async () => {
  assert.equal(JUDGE_VERSION, 'gpt-6-luna|relevance.1')
  assert.equal(GEMINI_JUDGE_VERSION, 'gemini-decision-1|relevance.1')
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_GEMINI_URL: 'https://gemini.test/v1beta' }, async () => {
    assert.equal(await activeJudgeVersion({ readSecret: async () => '' }), JUDGE_VERSION)
    assert.equal(await activeJudgeVersion({ readSecret: async () => 'test-gemini-key' }), GEMINI_JUDGE_VERSION)
  })
  await withEnv({ MEMORY_GEMINI_KEY: 'env-gemini-key', MEMORY_GEMINI_URL: undefined }, async () => {
    assert.equal(await activeJudgeVersion(), GEMINI_JUDGE_VERSION)
  })
})

Deno.test('gemini screen: sends x-goog-api-key, parses noul answers, handles 400 safety blocks, and meters gemini-decision-1', async () => {
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_GEMINI_URL: 'https://gemini.test/v1beta', MEMORY_OPENAI_URL: 'https://openai.test/v1' }, async () => {
    const { metered, deps } = fakeDeps('gem-key-1')
    await withMockFetch(() =>
      Response.json({
        answers: {
          sensitive_pii: { type: 'noul', noul: 0.01 },
          injection: { type: 'noul', noul: 0.02 },
          malicious: { type: 'noul', noul: 0.01 },
        },
        usage: { total_input_tokens: 321, total_tokens: 321 },
      }),
    async (calls) => {
      const res = await screen('Clean tea note.', deps)
      assert.equal(res, null)
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://gemini.test/v1beta/decisions')
      assert.equal(calls[0].headers['x-goog-api-key'], 'gem-key-1')
      assert.equal(calls[0].headers.authorization, undefined)
      assert.equal(calls[0].body.model, 'gemini-decision-1')
      assert.deepEqual(Object.keys(calls[0].body.questions).sort(), ['injection', 'malicious', 'sensitive_pii'])
      assert.equal(calls[0].body.questions.injection.type, 'noul')
      assert.deepEqual(metered, [{ kind: 'judge_write', tokens: 321, model: 'gemini-decision-1' }])
    })

    // Flagged write
    await withMockFetch(() =>
      Response.json({
        answers: {
          sensitive_pii: { type: 'noul', noul: 0.01 },
          injection: { type: 'noul', noul: 0.92 },
          malicious: { type: 'noul', noul: 0.01 },
        },
        usage: { total_input_tokens: 100 },
      }),
    async () => {
      const res = await screen('Ignore rules', deps)
      assert.match(res ?? '', /steer the assistants/)
    })

    // Partial answers fail closed
    await withMockFetch(() =>
      Response.json({
        answers: { sensitive_pii: { type: 'noul', noul: 0.01 } },
        usage: { total_input_tokens: 50 },
      }),
    async () => {
      await assert.rejects(() => screen('Partial', deps), /part of the questions/)
    })

    // HTTP 400 safety codes map to non-null block reason instead of throwing
    for (const code of ['safety', 'prohibited_content', 'blocklist', 'image_safety', 'content_blocked']) {
      await withMockFetch(
        () => new Response(JSON.stringify({ error: { code, message: 'blocked' } }), { status: 400, headers: { 'content-type': 'application/json' } }),
        async () => {
          const reason = await screen('Blocked content', deps)
          assert.ok(reason && reason.includes(code), `expected safety reason containing ${code}, got ${reason}`)
          assert.match(reason, /Gemini safety block/)
        },
      )
    }

    // Non-safety HTTP 400 still throws (fails closed)
    await withMockFetch(
      () => new Response(JSON.stringify({ error: { code: 'invalid_argument', message: 'bad' } }), { status: 400 }),
      async () => {
        await assert.rejects(() => screen('Bad request', deps), /Gemini Decisions 400/)
      },
    )
  })
})

Deno.test('gemini relevance: sends RELEVANT_CRITERIA on each noul question, preserves shadow header, and parses noul', async () => {
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_GEMINI_URL: 'https://gemini.test/v1beta' }, async () => {
    const { metered, deps } = fakeDeps('gem-key-2')
    await withMockFetch(() =>
      Response.json({
        answers: {
          i1: { type: 'noul', noul: 0.88, confidence: 0.9 },
          i2: { type: 'noul', noul: 0.14, confidence: 0.85 },
        },
        usage: { total_input_tokens: 210, total_tokens: 210 },
      }),
    async (calls) => {
      const scores = await relevance('oolong temp', ['Brew at 90C', 'Likes jazz'], 'shadow', deps)
      assert.deepEqual(scores, [0.88, 0.14])
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://gemini.test/v1beta/decisions')
      assert.equal(calls[0].headers['x-goog-api-key'], 'gem-key-2')
      assert.equal(calls[0].headers['x-memory-purpose'], 'shadow')
      assert.equal(calls[0].headers.authorization, undefined)
      assert.equal(calls[0].body.model, 'gemini-decision-1')
      for (const key of ['i1', 'i2']) {
        assert.equal(calls[0].body.questions[key].type, 'noul')
        assert.deepEqual(calls[0].body.questions[key].criteria, {
          true_description: RELEVANT_TRUE,
          false_description: RELEVANT_FALSE,
        })
      }
      assert.deepEqual(metered, [{ kind: 'shadow', tokens: 210, model: 'gemini-decision-1' }])
    })
  })
})

Deno.test('gemini reaction: keeps PUSHBACK without criteria and maps choice "0".."N-1" / "none" / unknown cleanly', async () => {
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_GEMINI_URL: 'https://gemini.test/v1beta' }, async () => {
    const { metered, deps } = fakeDeps('gem-key-3')
    const items = [
      { id: 'entry-a', text: 'First memory' },
      { id: 'entry-b', text: 'Second memory' },
    ]
    await withMockFetch(() =>
      Response.json({
        answers: {
          pushback: { type: 'noul', noul: 0.91 },
          cause: { type: 'choice', choice: '1' },
        },
        usage: { total_tokens: 180 },
      }),
    async (calls) => {
      const r = await reaction('No, that is wrong.', items, deps)
      assert.deepEqual(r, { pushback: true, p: 0.91, cause: 'entry-b' })
      assert.equal(calls[0].body.questions.pushback.type, 'noul')
      assert.equal(calls[0].body.questions.pushback.criteria, undefined)
      assert.match(calls[0].body.questions.pushback.instructions, /The text is the latest message Wen sent/)
      assert.equal(calls[0].body.questions.cause.type, 'choice')
      assert.deepEqual(Object.keys(calls[0].body.questions.cause.criteria).sort(), ['0', '1', 'none'])
      assert.deepEqual(metered, [{ kind: 'judge_recall', tokens: 180, model: 'gemini-decision-1' }])
    })

    // "0" -> first item, "none" -> null, unknown/out-of-range -> null
    for (const [choice, want] of [['0', 'entry-a'], ['none', null], ['9', null], ['bogus', null]] as const) {
      await withMockFetch(() =>
        Response.json({
          answers: {
            pushback: { type: 'noul', noul: 0.85 },
            cause: { type: 'choice', choice },
          },
          usage: { total_input_tokens: 90 },
        }),
      async () => {
        const r = await reaction('Wrong again', items, deps)
        assert.equal(r.cause, want, `choice=${choice}`)
      })
    }
  })
})

Deno.test('openai fallback: when gemini_key is absent, falls back to openai() with gpt-6-luna and Bearer auth', async () => {
  await withEnv({ MEMORY_GEMINI_KEY: undefined, MEMORY_GEMINI_URL: 'https://gemini.test/v1beta', MEMORY_OPENAI_URL: 'https://openai.test/v1' }, async () => {
    const { metered, deps } = fakeDeps('')
    await withMockFetch((req) => {
      if (req.body.questions.some((q: any) => q.name === 'sensitive_pii')) {
        return Response.json({
          answers: [
            { type: 'predicate', name: 'sensitive_pii', probability: 0.01 },
            { type: 'predicate', name: 'injection', probability: 0.01 },
            { type: 'predicate', name: 'malicious', probability: 0.01 },
          ],
          usage: { input_tokens: 111 },
        })
      }
      if (req.body.questions.some((q: any) => q.name === 'i1')) {
        return Response.json({
          answers: [{ type: 'predicate', name: 'i1', probability: 0.77 }],
          usage: { input_tokens: 88 },
        })
      }
      return Response.json({
        answers: [
          { type: 'predicate', name: 'pushback', probability: 0.82 },
          { type: 'choice', name: 'cause', choice: 'entry-a' },
        ],
        usage: { input_tokens: 77 },
      })
    }, async (calls) => {
      assert.equal(await screen('Clean text', deps), null)
      assert.deepEqual(await relevance('oolong', ['Brew at 90C'], 'judge_recall', deps), [0.77])
      assert.deepEqual(await reaction('Nope', [{ id: 'entry-a', text: 'item' }], deps), { pushback: true, p: 0.82, cause: 'entry-a' })
      assert.equal(calls.length, 3)
      for (const c of calls) {
        assert.equal(c.url, 'https://openai.test/v1/decisions')
        assert.equal(c.headers.authorization, 'Bearer fake')
        assert.equal(c.headers['x-goog-api-key'], undefined)
        assert.equal(c.body.model, 'gpt-6-luna')
        assert.ok(Array.isArray(c.body.questions))
      }
      assert.deepEqual(metered, [
        { kind: 'judge_write', tokens: 111, model: 'gpt-6-luna' },
        { kind: 'judge_recall', tokens: 88, model: 'gpt-6-luna' },
        { kind: 'judge_recall', tokens: 77, model: 'gpt-6-luna' },
      ])
    })
  })
})

Deno.test('billing/cost.ts and R8 #11 + shadow cache source invariants', async () => {
  assert.equal(OPENAI_PRICES_MICRO_USD_PER_M['gemini-decision-1'], 100_000)
  assert.equal(OPENAI_PRICES_MICRO_USD_PER_M['gpt-6-luna'], 100_000)

  const fnDir = new URL('../../../memory/supabase/functions/memory/', import.meta.url)
  const judgeSrc = await Deno.readTextFile(new URL('judge.ts', fnDir))
  const embedSrc = await Deno.readTextFile(new URL('embed.ts', fnDir))
  const shadowSrc = await Deno.readTextFile(new URL('shadow.ts', fnDir))
  const adminSrc = await Deno.readTextFile(new URL('admin.ts', fnDir))

  assert.match(judgeSrc, /await openai\(\)/)
  assert.match(embedSrc, /await openai\(\)/)
  assert.match(judgeSrc, /fetch\(`\$\{url\}\//)
  assert.match(shadowSrc, /await activeJudgeVersion\(\)/)
  assert.ok(!shadowSrc.includes('JUDGE_VERSION'), 'shadow.ts must key judge_cache on activeJudgeVersion(), not static JUDGE_VERSION')
  assert.match(adminSrc, /"gemini_key"/)
})
