/**
 * R75 (#80): UserPromptSubmit nudges recall on new goals or scope shifts, and stays silent on promptless payloads,
 * metadata-only turns without a folder change, and quick follow-ups on the active task.
 */
import assert from 'node:assert/strict'
import { classifyPromptShift } from '../../../memory/supabase/functions/memory/nudge.ts'

Deno.test('metadata-only or promptless payloads stay silent unless cwd moves', () => {
  assert.equal(classifyPromptShift({ cwd: '/tmp' }), '')
  assert.equal(classifyPromptShift({ prompt: '   ', cwd: '/repo/a', prevCwd: '/repo/a' }), '')
  assert.equal(classifyPromptShift({ prompt: 'Migrate billing webhooks to Deno', hooksMode: 'metadata', cwd: '/repo/a', prevCwd: '/repo/a' }), '')
  const moved = classifyPromptShift({ prompt: 'secret internal prompt', hooksMode: 'metadata', cwd: '/repo/b', prevCwd: '/repo/a' })
  assert.match(moved, /^clyde: new goal or scope shift\..*recall/)
  assert.ok(!moved.includes('secret'), 'metadata mode embeds zero prompt words')
})

Deno.test('first task prompt in a session nudges recall', () => {
  const out = classifyPromptShift({ prompt: 'Migrate billing webhooks to Deno', cwd: '/repo/a' })
  assert.ok(out.startsWith('clyde: new goal or scope shift.'), out)
  assert.ok(out.includes('recall'), out)
  assert.ok(out.includes('billing') && out.includes('webhooks'), out)
  // Slash commands and bare acknowledgements never nudge even at session start.
  for (const trivial of ['/hooks', '/compact', 'yes', 'ok', 'thanks', 'push it', 'show me a screenshot']) {
    assert.equal(classifyPromptShift({ prompt: trivial, cwd: '/repo/a' }), '', trivial)
  }
})

Deno.test('quick follow-ups on the active task stay silent', () => {
  const active = {
    cwd: '/repo/a',
    prevCwd: '/repo/a',
    idleMs: 25_000,
    sinceRetrievalMs: 90_000,
    lastRetrievalText: 'migrate billing webhooks deno stripe signature retry',
  }
  for (const followUp of [
    'push it',
    'fix line 4',
    'show me a screenshot',
    'run the tests again',
    'Comments on artifact URI: file:///tmp/built_screenshots.md\nSelection:\n>Walkthrough 4',
    'update the billing webhook retry timeout to 10 seconds',
    'keep stripe signature check before parsing json in webhooks',
  ]) {
    assert.equal(classifyPromptShift({ ...active, prompt: followUp }), '', followUp)
  }
})

Deno.test('cwd switch, idle gap, or unrelated new goal nudges recall', () => {
  const active = {
    cwd: '/repo/a',
    prevCwd: '/repo/a',
    idleMs: 30_000,
    sinceRetrievalMs: 90_000,
    lastRetrievalText: 'migrate billing webhooks deno stripe signature retry',
  }
  const byCwd = classifyPromptShift({ ...active, cwd: '/repo/b', prompt: 'check status' })
  assert.ok(byCwd.startsWith('clyde: new goal or scope shift.'), `cwd switch: ${byCwd}`)

  const byIdle = classifyPromptShift({
    ...active,
    idleMs: 25 * 60_000,
    prompt: 'Check why dark mode header contrast fails on mobile Safari',
  })
  assert.ok(byIdle.startsWith('clyde: new goal or scope shift.'), `idle gap: ${byIdle}`)

  const byTopic = classifyPromptShift({
    ...active,
    prompt: 'Redesign the onboarding email template and magic link copy for mobile',
  })
  assert.ok(byTopic.startsWith('clyde: new goal or scope shift.'), `topic shift: ${byTopic}`)
})

Deno.test('nudge output stays bounded and metadata mode leaks zero prompt text', () => {
  const huge = 'Rebuild\x00\n\r' + 'authentication_pipeline_token_rotation '.repeat(160)
  const out = classifyPromptShift({ prompt: huge, cwd: '/repo/a' })
  assert.ok(out.length > 0 && out.length <= 200, `length=${out.length}`)
  assert.ok(out.endsWith('\n') && !out.slice(0, -1).includes('\n') && !out.includes('\r') && !out.includes('\x00'))

  const meta = classifyPromptShift({ prompt: 'topsecretword anothersecret', hooksMode: 'metadata', cwd: '/repo/b', prevCwd: '/repo/a' })
  assert.ok(meta.length > 0 && meta.length <= 200)
  assert.ok(!meta.includes('topsecretword') && !meta.includes('anothersecret'))
})

Deno.test('classifier runs 10k prompts under 200ms', () => {
  const samples = [
    { prompt: 'Migrate billing webhooks to Deno', cwd: '/repo/a' },
    { prompt: 'push it', cwd: '/repo/a', prevCwd: '/repo/a', idleMs: 5_000, sinceRetrievalMs: 20_000, lastRetrievalText: 'billing webhooks' },
    { prompt: 'Redesign the onboarding email template and magic link copy', cwd: '/repo/a', prevCwd: '/repo/a', idleMs: 10_000, sinceRetrievalMs: 40_000, lastRetrievalText: 'billing webhooks' },
    { prompt: 'check tests', hooksMode: 'metadata' as const, cwd: '/repo/b', prevCwd: '/repo/a' },
  ]
  const t0 = performance.now()
  for (let i = 0; i < 10_000; i++) classifyPromptShift(samples[i & 3])
  const elapsed = performance.now() - t0
  assert.ok(elapsed < 200, `10k calls took ${elapsed.toFixed(1)}ms`)
})
