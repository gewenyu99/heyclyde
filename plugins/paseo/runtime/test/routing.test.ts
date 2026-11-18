import assert from 'node:assert/strict'
import test from 'node:test'
import { carbonAuditor, inferRouting, select, validateRouting } from '../src/routing.ts'
import { claudeArgs } from '../src/backends/claude.ts'
import type { TurnInput } from '../src/backends/types.ts'
const report = (sourceId: string, remainingPct: number, id = 'five_hour') => ({
  sourceId,
  report: { status: 'available', windows: [{ id, remainingPct }] },
})

test('one choice respects explicit pins, exhausted limits, comparable windows and project preferences', () => {
  const quotas = [report('codex', 0), report('claude', 12)]
  assert.equal(select('worker', {}, {}, quotas).model, 'sonnet')
  assert.equal(select('worker', {}, {}, [report('codex', 63), report('claude', 74)]).model, 'sonnet')
  assert.equal(select('worker', {}, { routine: 'sonnet' }, []).model, 'sonnet')
  assert.equal(select('worker', {}, {}, [report('codex', 5), report('claude', 99, 'weekly')]).model, 'sol')
  assert.throws(() => select('worker', {}, {}, [report('codex', 0), report('claude', 0)]))
  const policy = inferRouting('Keep backward compatibility during the schema migration')
  assert.equal(select('worker', policy, {}).model, 'opus')
  assert.equal(select('worker', { ...policy, overrides: { worker: 'astra' } }, {}, quotas).pinned, true)
  assert.equal(select('audit', {}, {}, quotas).model, 'carbon')
  assert.equal(select('verify', {}, {}).model, 'fable')
  assert.throws(() => validateRouting({ overrides: { worker: 'fable' } }))
})

test('Fable receives file readers only in review sessions', () => {
  const args = claudeArgs({ rung: { model: 'claude-fable-5-2' }, readOnly: true } as TurnInput, 'test', false)
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob')
})

test('audits select only the Carbon orchestrator advertised by this host', () => {
  assert.equal(carbonAuditor([{ id: 'gemini-pro-orchestrator-argon' }]).model, 'carbon')
  assert.equal(carbonAuditor([{ id: 'gemini-pro-orchestrator' }]).model, 'orchestrator')
  assert.equal(select('audit', { overrides: { audit: 'carbon' } }, {}).pinned, true)
})
