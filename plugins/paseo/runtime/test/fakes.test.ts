/** The fake CLIs refuse what the real ones refuse, with the same text and exit codes, so a bad flag fails tier 1 first. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { FAKE_BIN, setup } from './helpers.ts'

function run(bin: string, args: string[], input?: string) {
  const r = spawnSync(join(FAKE_BIN, bin), args, { input: input ?? '', encoding: 'utf8', env: process.env, cwd: process.env.CLYDE_HOME })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

test('pi refuses an unknown flag with exit 1', () => {
  setup([])
  const r = run('pi', ['--mode', 'json', '--cwd', '/tmp', 'hi'])
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'Error: Unknown option: --cwd\n')
})

test('pi treats a prompt after -p that starts with - as a flag', () => {
  setup([])
  const r = run('pi', ['--mode', 'json', '-p', '-x'])
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'Error: Unknown option: -x\n')
})

test('claude refuses unknown flags, stream-json without --verbose, bad uuids and unknown resumes', () => {
  setup([])
  const cases: [string[], string][] = [
    [['-p', '--bogus-flag'], "error: unknown option '--bogus-flag'\n"],
    [['-p', '--output-format', 'stream-json'], 'Error: When using --print, --output-format=stream-json requires --verbose\n'],
    [['-p', '--session-id', 'nope'], 'Error: Invalid session ID. Must be a valid UUID.\n'],
    [['-p', '--resume', '11111111-2222-3333-4444-555555555555'], 'No conversation found with session ID: 11111111-2222-3333-4444-555555555555\n'],
    [['-p', '--permission-mode', 'nope'], "error: option '--permission-mode <mode>' argument 'nope' is invalid. Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan.\n"],
    [['-p', '--session-id', '11111111-2222-3333-4444-555555555555', '--resume', '11111111-2222-3333-4444-555555555555'], 'Error: --session-id can only be used with --continue or --resume if --fork-session is also specified.\n'],
  ]
  for (const [args, stderr] of cases) {
    const r = run('claude', args, 'hello')
    assert.equal(r.stderr, stderr, args.join(' '))
    assert.equal(r.code, 1, args.join(' '))
  }
})

test('claude reports an unknown resume id as a stream-json result too', () => {
  setup([])
  const id = '11111111-2222-3333-4444-555555555555'
  const r = run('claude', ['-p', '--output-format', 'stream-json', '--verbose', '--resume', id], 'hello')
  assert.equal(r.code, 1)
  const result = JSON.parse(r.stdout)
  assert.deepEqual([result.type, result.subtype, result.is_error, result.errors], ['result', 'error_during_execution', true, [`No conversation found with session ID: ${id}`]])
})

test('claude swallows a prompt placed after a variadic flag', () => {
  setup([])
  const r = run('claude', ['-p', '--output-format', 'json', '--allowedTools', 'Read', 'Grep', 'reply ok'])
  assert.equal(r.code, 1)
  assert.equal(r.stderr, 'Error: Input must be provided either through stdin or as a prompt argument when using --print\n')
})

test('claude refuses bypassPermissions as root unless IS_SANDBOX=1', { skip: process.getuid?.() !== 0 }, () => {
  setup([])
  delete process.env.IS_SANDBOX
  const r = run('claude', ['-p', '--permission-mode', 'bypassPermissions'], 'hi')
  assert.equal(r.code, 1)
  assert.equal(r.stderr, '--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n')
  process.env.IS_SANDBOX = '1'
})

test('codex refuses unknown flags and exec-only flags after resume with exit 2', () => {
  setup([])
  const full = run('codex', ['exec', '--full-auto', '-'], 'hi')
  assert.equal(full.code, 2)
  assert.match(full.stderr, /^error: unexpected argument '--full-auto' found\n/)
  const late = run('codex', ['exec', 'resume', '11111111-2222-3333-4444-555555555555', '-s', 'read-only', '-'], 'hi')
  assert.equal(late.code, 2)
  assert.match(late.stderr, /^error: unexpected argument '-s' found\n\nUsage: codex exec resume/)
})

test('codex fails on an unknown resume uuid and outside git without --skip-git-repo-check', () => {
  setup([])
  const missing = run('codex', ['exec', 'resume', '11111111-2222-3333-4444-555555555555', '--json', '--skip-git-repo-check', '-'], 'hi')
  assert.equal(missing.code, 1)
  assert.equal(missing.stdout, '')
  assert.equal(missing.stderr, 'Error: thread/resume: thread/resume failed: no rollout found for thread id 11111111-2222-3333-4444-555555555555 (code -32600)\n')
  const nogit = run('codex', ['exec', '--json', '-'], 'hi')
  assert.equal(nogit.code, 1)
  assert.equal(nogit.stderr, 'Not inside a trusted directory and --skip-git-repo-check was not specified.\n')
})
