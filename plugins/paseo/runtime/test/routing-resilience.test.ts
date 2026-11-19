import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolveCatalogRung, profiles, fallbackBackendsFor } from '../src/routing.ts'
import { deterministicProviderFailure } from '../src/flow/stage.ts'
import { flowDaemon, flowSetup, waitStatus } from './golden/flow.ts'

test('resolveCatalogRung handles exact match, same-family downgrade, cross-provider fallback, and pins', () => {
  const baseOpus = { model: 'opus' as const, reason: 'Planner preference', pinned: false }

  // Empty/offline catalog preserves configured rung unchanged.
  assert.deepEqual(resolveCatalogRung('planner', baseOpus, {}), { selection: baseOpus, rung: profiles.opus })

  // Exact catalog match keeps base model.
  const exact = resolveCatalogRung('planner', baseOpus, {
    claude: [{ id: 'claude-opus-5-5' }, { id: 'claude-opus-5' }],
  })
  assert.equal(exact.rung.model, 'claude-opus-5-5')
  assert.equal(exact.selection.resolvedModel, undefined)

  // Missing exact opus-5-5 picks highest non-[1m] same-family version (claude-opus-5 > claude-opus-4-8).
  const sameFamily = resolveCatalogRung('planner', baseOpus, {
    claude: [{ id: 'claude-opus-4-8' }, { id: 'claude-opus-5[1m]' }, { id: 'claude-opus-5' }],
  })
  assert.equal(sameFamily.rung.backend, 'claude')
  assert.equal(sameFamily.rung.model, 'claude-opus-5')
  assert.equal(sameFamily.selection.resolvedModel, 'claude-opus-5')
  assert.match(sameFamily.selection.reason, /claude-opus-5-5 unavailable, using claude-opus-5/)

  // No same-family match on claude crosses over to planner fallback (astra / codex).
  const crossPlanner = resolveCatalogRung('planner', baseOpus, {
    claude: [{ id: 'claude-sonnet-4-6' }],
    codex: [{ id: 'gpt-6.2-astra' }, { id: 'gpt-6.2-sol' }],
  })
  assert.equal(crossPlanner.selection.model, 'astra')
  assert.equal(crossPlanner.rung.backend, 'codex')
  assert.equal(crossPlanner.rung.model, 'gpt-6.2-astra')

  // Pinned selection stays on primary provider instead of crossing providers.
  const pinned = resolveCatalogRung('planner', { ...baseOpus, pinned: true }, {
    claude: [{ id: 'claude-sonnet-4-6' }],
    codex: [{ id: 'gpt-6.2-astra' }],
  })
  assert.equal(pinned.rung.backend, 'claude')
  assert.equal(pinned.rung.model, 'claude-opus-5-5')

  // Reviewer fallback when fable is absent moves to sonnet or codex sol.
  const reviewFallback = resolveCatalogRung('specReview', { model: 'fable', reason: 'Read-only review', pinned: false }, {
    claude: [{ id: 'claude-haiku-4-5' }],
    codex: [{ id: 'gpt-6.2-sol' }],
  })
  assert.equal(reviewFallback.selection.model, 'sol')
  assert.equal(reviewFallback.rung.backend, 'codex')

  assert.deepEqual(fallbackBackendsFor('planner', 'opus'), ['codex'])
  assert.deepEqual(fallbackBackendsFor('verify', 'fable'), ['codex'])
})

test('deterministicProviderFailure catches 400/model/version/auth/flag errors without matching 500 or test failures', () => {
  assert.ok(
    deterministicProviderFailure(
      "API Error: 400 Claude Code 2.1.271 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.",
    ),
  )
  assert.ok(deterministicProviderFailure('unrecognized_model: claude-opus-5-5'))
  assert.ok(deterministicProviderFailure('error: unknown flag --json-schema'))
  assert.ok(deterministicProviderFailure('Authentication_error: Please log in first'))
  assert.equal(deterministicProviderFailure('API Error: 503 temporary backend overload'), undefined)
  assert.equal(deterministicProviderFailure('The judge failed it: assertion failed'), undefined)
})

test('runStage pauses after 1 attempt on deterministic provider error and resumes cleanly when retried', async () => {
  const s = await flowSetup('task-rung1')
  const TASK = { prompt: 'Write hello.txt.', criteria: ['hello.txt exists'], checks: ['test -f hello.txt'] }
  const result = { status: 'done', summary: 'done', evidence: [] }
  const pass = { verdict: 'pass', criteria: [{ criterion: 'hello.txt exists', pass: true, evidence: 'ok' }], notes: 'ok' }
  writeFileSync(s.scenario, JSON.stringify({
    turns: [
      {
        match: 'worker for stage task of',
        error: 'API Error: 400 Claude Code 2.1.271 does not support this model; version 2.1.280 or newer is required.',
      },
      { match: 'worker for stage task of', reply: 'done', json: result, write: { 'hello.txt': 'hello\n' }, commit: 'add hello' },
      { match: 'judge for stage task of', json: pass },
    ],
  }))
  const { d, client } = await flowDaemon()
  try {
    const started = await client.startRun('task', TASK, s.repo)
    const asking = await waitStatus(client, started.id, ['asking', 'failed'])
    assert.equal(asking.status, 'asking', asking.error)
    assert.equal(asking.asks[0].kind, 'provider')
    assert.equal(asking.stages[0].attempts.length, 1, 'should pause after 1 attempt instead of retrying 3 times')
    await client.answer(started.id, 'retry')
    const done = await waitStatus(client, started.id, ['done', 'failed'])
    assert.equal(done.status, 'done', done.question ?? done.error)
    assert.equal(done.stages[0].attempts.length, 2)
  } finally {
    await d.close()
    await s.memory.close()
  }
})
