/** Threads over the fake CLIs: one turn, queued turns on each backend, stop, crash, timeout, the global cap, worktrees and env. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { hookSettings } from '../src/backends/claude.ts'
import { extensionPath } from '../src/backends/pi.ts'
import { repoRoot } from '../src/config.ts'
import { startDaemon } from '../src/daemon.ts'
import { EventLog } from '../src/events.ts'
import { Memory } from '../src/memory.ts'
import { writeJson } from '../src/store.ts'
import { Threads } from '../src/threads.ts'
import type { BackendName, Rung } from '../src/types.ts'
import type { FakeTurn } from './fakes/common.ts'
import { startFakeMemory } from './fakes/memory.ts'
import { argvLog, git, setup, turnsTaken, waitFor } from './helpers.ts'

const RUNGS: Record<BackendName, Rung> = {
  pi: { backend: 'pi', model: 'openai-codex/gpt-6.1-sol', effort: 'medium' },
  claude: { backend: 'claude', model: 'sonnet', effort: 'high' },
  codex: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'medium' },
}

function harness(turns: FakeTurn[], opts: { memory?: Memory; maxTurns?: number; env?: Record<string, string> } = {}) {
  const s = setup(turns, opts.env)
  const events = new EventLog()
  const threads = new Threads({ events, memory: opts.memory ?? null, maxTurns: opts.maxTurns })
  return { ...s, events, threads, types: () => events.since(0).map((e) => e.type) }
}

function piExtension(): string[] {
  return existsSync(extensionPath()) ? ['-e', extensionPath()] : []
}

function holdCodexWriter(state: string, session: string): string {
  const dir = join(state, 'codex-writers')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, session)
  writeFileSync(path, String(process.pid))
  return path
}

test('a Codex follow-up waits for process exit after turn.completed', async () => {
  const h = harness([{ reply: 'shape pitch', exitDelayMs: 500 }, { reply: 'accepted' }])
  const t = h.threads.start({ title: 'checkpoint', prompt: 'pitch', cwd: h.repo, rung: RUNGS.codex })
  await waitFor(() => existsSync(join(h.state, 'codex-completed')))
  assert.equal(h.threads.get(t.id)?.status, 'running')
  assert.ok(!h.types().includes('thread.done'))
  h.threads.send(t.id, 'yes')
  assert.equal(argvLog(h.state).length, 1)
  const done = await h.threads.waitIdle(t.id)
  assert.deepEqual(done.turns.map((x) => [x.ok, x.text]), [[true, 'shape pitch'], [true, 'accepted']])
  assert.equal(argvLog(h.state).length, 2)
})

test('Codex retries a rejected resume once the active writer releases it', async () => {
  const h = harness([{ reply: 'pitch' }, { reply: 'turn {{turn}} after {{history}}' }])
  const t = h.threads.start({ title: 'checkpoint', prompt: 'pitch', cwd: h.repo, rung: RUNGS.codex })
  const first = await h.threads.waitIdle(t.id)
  const writer = holdCodexWriter(h.state, first.session!)
  h.threads.send(t.id, 'yes')
  await waitFor(() => h.threads.get(t.id)?.progress?.includes('waiting for the active writer'))
  rmSync(writer)
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.session, first.session)
  assert.deepEqual(done.turns.map((x) => [x.ok, x.text]), [[true, 'pitch'], [true, 'turn 2 after pitch']])
  assert.equal(turnsTaken(h.state), 2, 'the rejected resume never took a turn')
  assert.equal(argvLog(h.state).length, 3)
  assert.deepEqual(h.types(), ['thread.started', 'thread.done', 'thread.done'])
})

test('Codex stops retrying a persistent active writer after four attempts', async () => {
  const h = harness([{ reply: 'pitch' }])
  const t = h.threads.start({ title: 'busy', prompt: 'pitch', cwd: h.repo, rung: RUNGS.codex })
  const first = await h.threads.waitIdle(t.id)
  holdCodexWriter(h.state, first.session!)
  h.threads.send(t.id, 'yes')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'failed')
  assert.match(done.turns[1].error!, /already has an active writer \(code -32600\)/)
  assert.equal(argvLog(h.state).length, 5)
  assert.equal(turnsTaken(h.state), 1)
})

test('stopping Codex during resume backoff cancels further attempts', async () => {
  const h = harness([{ reply: 'pitch' }])
  const t = h.threads.start({ title: 'cancel retry', prompt: 'pitch', cwd: h.repo, rung: RUNGS.codex })
  const first = await h.threads.waitIdle(t.id)
  holdCodexWriter(h.state, first.session!)
  h.threads.send(t.id, 'yes')
  await waitFor(() => h.threads.get(t.id)?.progress?.includes('waiting for the active writer'))
  h.threads.stop(t.id)
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'stopped')
  assert.equal(done.turns[1].error, 'codex was stopped')
  assert.equal(argvLog(h.state).length, 2)
})

test('Codex never retries an active-writer error after the turn has started', async () => {
  const h = harness([{ reply: 'pitch' }, { error: 'thread/resume failed: thread x already has an active writer (code -32600)' }])
  const t = h.threads.start({ title: 'started failure', prompt: 'pitch', cwd: h.repo, rung: RUNGS.codex })
  await h.threads.waitIdle(t.id)
  h.threads.send(t.id, 'yes')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'failed')
  assert.equal(argvLog(h.state).length, 2)
  assert.equal(turnsTaken(h.state), 2)
})

test('a pi thread runs one turn, posts thread.done and persists', async () => {
  const h = harness([{ reply: 'hello from pi' }])
  const t = h.threads.start({ title: 'greet', prompt: 'say hello', cwd: h.repo, rung: RUNGS.pi })
  assert.equal(t.status, 'running')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'idle')
  assert.equal(done.turns[0].ok, true)
  assert.equal(done.turns[0].text, 'hello from pi')
  assert.equal(done.session, t.id)
  assert.deepEqual(h.types(), ['thread.started', 'thread.done'])
  assert.match(h.events.since(1)[0].summary, /^Thread t-[0-9a-f]{8} "greet" is done: hello from pi$/)
  const saved = JSON.parse(readFileSync(join(h.home, 'threads', `${t.id}.json`), 'utf8'))
  assert.equal(saved.status, 'idle')
  const [call] = argvLog(h.state)
  assert.deepEqual(call.argv, [
    '--mode', 'json', '-p', '--model', 'openai-codex/gpt-6.1-sol', '--thinking', 'medium', '--approve',
    '--session-dir', join(h.home, 'sessions', 'pi'), '--session-id', t.id, ...piExtension(), 'say hello',
  ])
  assert.equal(call.cwd, h.repo)
})

for (const name of ['pi', 'claude', 'codex'] as BackendName[]) {
  test(`a second message queues behind a running ${name} turn and continues the same session`, async () => {
    const h = harness([{ match: 'first', reply: 'one', delayMs: 300 }, { match: 'second', reply: 'turn {{turn}} after {{history}}' }])
    const t = h.threads.start({ title: 'two turns', prompt: 'first message', cwd: h.repo, rung: RUNGS[name], systemAppend: 'be brief' })
    const queued = h.threads.send(t.id, 'second message')
    assert.equal(queued.status, 'running')
    assert.deepEqual(queued.queue, ['second message'])
    const done = await h.threads.waitIdle(t.id)
    assert.equal(done.status, 'idle')
    assert.deepEqual(done.turns.map((x) => x.text), ['one', 'turn 2 after first message'])
    assert.deepEqual(h.types(), ['thread.started', 'thread.done', 'thread.done'])
    const [first, second] = argvLog(h.state).map((c) => c.argv)
    if (name === 'pi') {
      for (const argv of [first, second]) assert.equal(argv[argv.indexOf('--session-id') + 1], t.id)
      assert.ok(second.includes('--append-system-prompt'), 'pi gets the system prompt every turn')
    } else if (name === 'claude') {
      const uuid = done.session as string
      assert.match(uuid, /^[0-9a-f-]{36}$/)
      assert.deepEqual(first, ['-p', '--output-format', 'stream-json', '--verbose', '--session-id', uuid, '--model', 'sonnet',
        '--effort', 'high', '--permission-mode', 'acceptEdits', '--append-system-prompt', 'be brief', '--settings', JSON.stringify(hookSettings())])
      assert.deepEqual(second, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', uuid, '--model', 'sonnet',
        '--effort', 'high', '--permission-mode', 'acceptEdits', '--settings', JSON.stringify(hookSettings())])
    } else {
      const tid = done.session as string
      const out = (argv: string[]) => argv[argv.indexOf('-o') + 1]
      assert.match(out(first), new RegExp(`^${join(h.home, 'tmp')}/codex-[0-9a-f]+\\.last\\.txt$`))
      const permissions = ['--ignore-user-config', '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify(['tmp', 'memory-spool/agent', 'note-receipts', 'note-probes', 'recall-sessions'].map((rel) => join(h.home, rel)))}`,
        '-c', 'sandbox_workspace_write.network_access=true', '-c', 'features.network_proxy.enabled=true',
        '-c', 'features.network_proxy.domains={"127.0.0.1"="allow"}', '-c', 'approval_policy="never"']
      assert.deepEqual(first, ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium',
        ...permissions, '-s', 'workspace-write', '-C', h.repo, '-o', out(first), '-'])
      assert.deepEqual(second, ['exec', '-s', 'workspace-write', '-C', h.repo, 'resume', tid, '--json', '--skip-git-repo-check',
        '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=medium', ...permissions, '-o', out(second), '-'])
    }
  })
}

test('the claude hook settings run clyde hook for seven events through node, PreToolUse only for tools that change files', () => {
  const hooks = (hookSettings() as any).hooks
  assert.deepEqual(Object.keys(hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd'])
  assert.equal(hooks.PreToolUse[0].matcher, 'Edit|MultiEdit|Write|NotebookEdit|Bash')
  assert.equal(hooks.Stop[0].matcher, undefined)
  assert.equal(hooks.Stop[0].hooks[0].command, `'${process.execPath}' '${join(repoRoot(), 'runtime', 'bin', 'clyde.ts')}' hook Stop`)
})

test('stop interrupts a hanging claude turn and the thread ends stopped', async () => {
  const h = harness([{ hang: true }])
  const t = h.threads.start({ title: 'hangs', prompt: 'wait forever', cwd: h.repo, rung: RUNGS.claude })
  await waitFor(() => turnsTaken(h.state), 5000, 'the fake to take its turn')
  const stopped = h.threads.stop(t.id)
  assert.equal(stopped.status, 'stopped')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'stopped')
  assert.equal(done.turns[0].ok, false)
  assert.equal(done.turns[0].error, 'claude was stopped')
  assert.ok(done.session, 'a stopped thread keeps its session')
  assert.deepEqual(h.types(), ['thread.started', 'thread.stopped'])
})

test('a stopped thread drops its queue, and a later send resumes the session', async () => {
  const h = harness([{ match: 'first', hang: true }, { match: 'again', reply: 'back: {{history}}' }])
  const t = h.threads.start({ title: 'resume', prompt: 'first', cwd: h.repo, rung: RUNGS.claude })
  h.threads.send(t.id, 'queued and dropped')
  await waitFor(() => turnsTaken(h.state), 5000, 'the fake to take its turn')
  assert.deepEqual(h.threads.stop(t.id).queue, [])
  await h.threads.waitIdle(t.id)
  h.threads.send(t.id, 'again')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.turns.at(-1)?.text, 'back: first')
  const calls = argvLog(h.state)
  assert.equal(calls.length, 2)
  assert.ok(calls[1].argv.includes('--resume'))
})

test('a claude session that was never written gets started rather than failing every later turn', async () => {
  const h = harness([{ reply: 'first' }, { reply: 'turn {{turn}} again' }])
  const t = h.threads.start({ title: 'lost', prompt: 'hello', cwd: h.repo, rung: RUNGS.claude })
  const first = await h.threads.waitIdle(t.id)
  // As if the first process died before claude wrote its transcript.
  rmSync(join(h.state, 'sessions', 'claude', `${first.session}.json`))
  h.threads.send(t.id, 'again')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.turns[1].ok, true)
  assert.equal(done.turns[1].text, 'turn 1 again')
  assert.equal(done.session, first.session)
  const calls = argvLog(h.state).map((c) => c.argv)
  assert.equal(calls.length, 3)
  assert.equal(calls[1][calls[1].indexOf('--resume') + 1], first.session)
  assert.equal(calls[2][calls[2].indexOf('--session-id') + 1], first.session)
})

test('a fake turn posts its result with the real clyde result', { skip: !existsSync(join(repoRoot(), 'harness', 'src', 'cli', 'result.ts')) }, async () => {
  const h = harness([{ reply: 'done', clydeResult: { status: 'done', summary: 'parser fixed', evidence: [{ criterion: 'tests pass', evidence: 'npm test green' }] } }])
  const d = await startDaemon({ port: 0 })
  try {
    const t = d.ctx.threads.start({ title: 'result', prompt: 'fix it', cwd: h.repo, rung: RUNGS.pi })
    await d.ctx.threads.waitIdle(t.id)
    assert.deepEqual(d.ctx.threads.result(t.id), { status: 'done', summary: 'parser fixed', evidence: [{ criterion: 'tests pass', evidence: 'npm test green' }] })
  } finally {
    await d.close()
  }
})

test('a crash fails the thread with the exit code and stderr', async () => {
  const h = harness([{ crash: true, exit: 3 }])
  const t = h.threads.start({ title: 'crash', prompt: 'crash now', cwd: h.repo, rung: RUNGS.codex })
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'failed')
  assert.equal(done.turns[0].error, 'codex exited with code 3: fake codex crashed')
  assert.deepEqual(h.types(), ['thread.started', 'thread.failed'])
  assert.match(h.events.since(1)[0].summary, /failed: codex exited with code 3/)
})

test('a hang hits CLYDE_TURN_TIMEOUT_MS and the thread fails', async () => {
  const h = harness([{ hang: true }], { env: { CLYDE_TURN_TIMEOUT_MS: '400' } })
  const t = h.threads.start({ title: 'slow', prompt: 'take forever', cwd: h.repo, rung: RUNGS.pi })
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'failed')
  assert.equal(done.turns[0].error, 'pi timed out after 400 ms')
})

test('a worker that ignores SIGINT gets SIGKILL after the grace period', async () => {
  const h = harness([{ hang: true, stubborn: true }], { env: { CLYDE_TURN_TIMEOUT_MS: '300', CLYDE_KILL_GRACE_MS: '300' } })
  const started = Date.now()
  const t = h.threads.start({ title: 'stubborn', prompt: 'ignore signals', cwd: h.repo, rung: RUNGS.codex })
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.turns[0].error, 'codex timed out after 300 ms')
  assert.ok(Date.now() - started < 4000)
})

test('pi lingering after agent_settled is killed 3 seconds later and the turn still succeeds', async () => {
  const h = harness([{ reply: 'answered', linger: true }])
  const started = Date.now()
  const t = h.threads.start({ title: 'linger', prompt: 'leak a timer', cwd: h.repo, rung: RUNGS.pi })
  const done = await h.threads.waitIdle(t.id)
  const took = Date.now() - started
  assert.equal(done.turns[0].ok, true)
  assert.equal(done.turns[0].text, 'answered')
  assert.ok(took >= 2900 && took < 8000, `took ${took} ms`)
})

test('a pi model error fails the turn although pi exits 0', async () => {
  const h = harness([{ error: 'scripted failure' }])
  const t = h.threads.start({ title: 'model error', prompt: 'fail please', cwd: h.repo, rung: RUNGS.pi })
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'failed')
  assert.equal(done.turns[0].error, 'scripted failure')
})

test('a claude result with is_error fails the turn', async () => {
  const h = harness([{ error: 'There is an issue with the selected model' }])
  const t = h.threads.start({ title: 'api error', prompt: 'fail please', cwd: h.repo, rung: RUNGS.claude })
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.turns[0].error, 'There is an issue with the selected model')
})

test('a codex resume that comes back on another thread id fails rather than losing the conversation', async () => {
  const h = harness([{ reply: 'first' }, { reply: 'second' }])
  const t = h.threads.start({ title: 'mismatch', prompt: 'hello', cwd: h.repo, rung: RUNGS.codex })
  await h.threads.waitIdle(t.id)
  // A non-UUID id that names no thread makes codex start a new one silently.
  ;(h.threads.threads.get(t.id) as any).session = 'not-a-uuid'
  h.threads.send(t.id, 'continue')
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'failed')
  assert.match(done.turns[1].error ?? '', /^codex started thread [0-9a-f-]{36} instead of resuming not-a-uuid$/)
})

test('CLYDE_MAX_TURNS caps running turns and the rest queue', async () => {
  const h = harness([{ match: 'one', delayMs: 400, reply: 'a' }, { match: 'two', reply: 'b' }], { maxTurns: 1 })
  const a = h.threads.start({ title: 'a', prompt: 'one', cwd: h.repo, rung: RUNGS.pi })
  const b = h.threads.start({ title: 'b', prompt: 'two', cwd: h.repo, rung: RUNGS.pi })
  assert.equal(a.status, 'running')
  assert.equal(b.status, 'queued')
  const [da, db] = await Promise.all([h.threads.waitIdle(a.id), h.threads.waitIdle(b.id)])
  assert.equal(da.turns[0].text, 'a')
  assert.equal(db.turns[0].text, 'b')
  assert.ok(db.turns[0].startedAt >= (da.turns[0].endedAt as string))
})

test('a worktree thread runs in its own branch with bypassPermissions and commits there', async () => {
  const h = harness([{ write: { 'notes.txt': 'from the worker\n' }, commit: 'worker commit', reply: 'committed' }])
  const head = git(h.repo, 'rev-parse', 'HEAD')
  const t = h.threads.start({ title: 'wt', prompt: 'write notes', cwd: h.repo, rung: RUNGS.claude, worktree: true })
  assert.equal(t.worktree, join(h.home, 'worktrees', t.id))
  assert.equal(t.cwd, t.worktree)
  assert.equal(t.branch, `clyde/${t.id}`)
  assert.equal(t.base, head)
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.turns[0].ok, true)
  assert.equal(git(t.cwd, 'log', '-1', '--format=%s'), 'worker commit')
  assert.equal(git(t.cwd, 'rev-parse', '--abbrev-ref', 'HEAD'), `clyde/${t.id}`)
  assert.equal(git(h.repo, 'rev-parse', 'HEAD'), head, 'the main checkout is untouched')
  const [call] = argvLog(h.state)
  assert.equal(call.cwd, t.cwd)
  assert.equal(call.argv[call.argv.indexOf('--permission-mode') + 1], 'bypassPermissions')
})

test('workers get the allowlisted env, never CLAUDE_CODE_* or MEMORY_RUNTIME_TOKEN', async () => {
  const h = harness([{ reply: 'ok' }], {
    env: { CLAUDE_CODE_REMOTE_SESSION_ID: 'cse_hijack', MEMORY_RUNTIME_TOKEN: 'runtime-secret', MEMORY_TOKEN: 'agent-token', MEMORY_URL: 'http://127.0.0.1:9', SOME_RANDOM: 'x', CLYDE_POINT_MAN: '1' },
  })
  const t = h.threads.start({ title: 'env', prompt: 'print env', cwd: h.repo, rung: RUNGS.claude, runId: 'r-abc' })
  await h.threads.waitIdle(t.id)
  const [call] = argvLog(h.state)
  for (const k of ['CLAUDE_CODE_REMOTE_SESSION_ID', 'MEMORY_RUNTIME_TOKEN', 'SOME_RANDOM', 'CLYDE_POINT_MAN']) {
    assert.ok(!call.envKeys.includes(k), `${k} must not reach the worker`)
  }
  assert.ok(call.envKeys.includes('MEMORY_TOKEN'))
  assert.ok(!call.envKeys.some((k) => k.startsWith('CLAUDE_CODE_')))
  assert.deepEqual(call.env, {
    CLYDE_HOME: h.home, CLYDE_THREAD_ID: t.id, CLYDE_RUN_ID: 'r-abc', CLYDE_MEMORY_SCOPE: 'run:r-abc', CLAUDE_PLUGIN_ROOT: repoRoot(),
    IS_SANDBOX: '1', MEMORY_URL: 'http://127.0.0.1:9', MEMORY_TOKEN: 'agent-token',
  })
  assert.ok(h.events.since(0).every((e) => e.runId === 'r-abc'))
  delete process.env.CLAUDE_CODE_REMOTE_SESSION_ID
  delete process.env.SOME_RANDOM
})

test('a read-only claude turn uses the judge flags and returns structured output', async () => {
  const verdict = { verdict: 'pass', criteria: [], notes: 'fine' }
  const h = harness([{ json: verdict }])
  const schema = { type: 'object', properties: { verdict: { enum: ['pass', 'fail'] } } }
  const t = h.threads.start({ title: 'judge', prompt: 'grade it', cwd: h.repo, rung: { backend: 'claude', model: 'sonnet' }, readOnly: true, schema })
  const done = await h.threads.waitIdle(t.id)
  assert.deepEqual(done.turns[0].json, verdict)
  const [call] = argvLog(h.state)
  assert.deepEqual(call.argv, ['-p', '--output-format', 'json', '--session-id', done.session, '--model', 'sonnet',
    '--tools', 'Read,Grep,Glob', '--permission-mode', 'dontAsk', '--disallowedTools', 'Bash', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--json-schema', JSON.stringify(schema), '--settings', JSON.stringify(hookSettings())])
})

test('a read-only codex turn is ephemeral with an output schema file and never resumes', async () => {
  const h = harness([{ json: { verdict: 'fail' } }])
  const t = h.threads.start({ title: 'judge', prompt: 'grade it', cwd: h.repo, rung: { backend: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, readOnly: true, schema: { type: 'object' } })
  const done = await h.threads.waitIdle(t.id)
  assert.deepEqual(done.turns[0].json, { verdict: 'fail' })
  assert.equal(done.session, undefined)
  const [{ argv }] = argvLog(h.state)
  const schemaFile = argv[argv.indexOf('--output-schema') + 1]
  assert.deepEqual(argv, ['exec', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort=high',
    '--ephemeral', '--ignore-user-config', '-c', 'approval_policy="never"',
    '--output-schema', schemaFile, '-s', 'read-only', '-C', h.repo, '-o', argv[argv.indexOf('-o') + 1], '-'])
  assert.ok(!existsSync(schemaFile), 'the schema file is cleaned up')
})

test('a read-only pi turn gets read tools only and its fenced json block', async () => {
  const h = harness([{ reply: 'verdict below', json: { verdict: 'pass' } }])
  const t = h.threads.start({ title: 'judge', prompt: 'grade it', cwd: h.repo, rung: { backend: 'pi', model: 'xai/grok-4.7' }, readOnly: true, schema: {} })
  const done = await h.threads.waitIdle(t.id)
  assert.deepEqual(done.turns[0].json, { verdict: 'pass' })
  const [{ argv }] = argvLog(h.state)
  assert.deepEqual(argv.slice(0, 5), ['--mode', 'json', '-p', '--model', 'xai/grok-4.7'])
  assert.ok(!argv.includes('--thinking'), 'no effort means pi picks its default')
  assert.equal(argv[argv.indexOf('--tools') + 1], 'read,grep,find,ls')
})

test('a new thread posts one ClydeThread hook to memory with its session', async () => {
  const memory = await startFakeMemory()
  try {
    const h = harness([{ reply: 'a' }, { reply: 'b' }], { memory: new Memory(memory.url, memory.runtimeToken) })
    const t = h.threads.start({ title: 'hooked', prompt: 'one', cwd: h.repo, rung: RUNGS.claude, runId: 'r-1' })
    await h.threads.waitIdle(t.id)
    h.threads.send(t.id, 'two')
    const done = await h.threads.waitIdle(t.id)
    await waitFor(() => memory.hooks.length, 3000, 'the hook')
    assert.deepEqual(memory.hooks, [{ event: 'ClydeThread', payload: { session_id: done.session, thread_id: t.id, run_id: 'r-1' } }])
    assert.equal(memory.calls[0].role, 'runtime')
  } finally {
    await memory.close()
  }
})

test('an unknown backend is refused before a thread exists', () => {
  const h = harness([])
  assert.throws(() => h.threads.start({ title: 'x', prompt: 'x', cwd: h.repo, rung: { backend: 'gemini' as BackendName } }), /unknown backend gemini/)
  assert.equal(h.threads.list().length, 0)
})

test('recovery keeps a stopped thread stopped and runs a thread that was only queued', async () => {
  const h = harness([{ reply: 'ran after restart' }])
  const at = new Date().toISOString()
  const base = { rung: RUNGS.pi, cwd: h.repo, createdAt: at, updatedAt: at }
  writeJson(join(h.home, 'threads', 't-stopped.json'), { ...base, id: 't-stopped', title: 'stopped', status: 'stopped', queue: [], turns: [{ n: 1, prompt: 'x', startedAt: at }] })
  writeJson(join(h.home, 'threads', 't-queued.json'), { ...base, id: 't-queued', title: 'queued', status: 'queued', queue: ['run me'], turns: [] })
  const threads = new Threads({ events: h.events })
  threads.recover()
  const stopped = threads.get('t-stopped')
  assert.equal(stopped?.status, 'stopped')
  assert.equal(stopped?.turns[0].error, 'stopped')
  const done = await threads.waitIdle('t-queued')
  assert.equal(done.turns[0].text, 'ran after restart')
  assert.deepEqual(h.types(), ['thread.done'])
})

test('a message sent while a stopped turn is still exiting runs once the process is gone', async () => {
  const h = harness([{ match: 'first', hang: true }, { match: 'after', reply: 'ran after the stop' }])
  const t = h.threads.start({ title: 'stop then send', prompt: 'first', cwd: h.repo, rung: RUNGS.codex })
  await waitFor(() => turnsTaken(h.state), 5000, 'the fake to take its turn')
  h.threads.stop(t.id)
  const sent = h.threads.send(t.id, 'after')
  assert.deepEqual(sent.queue, ['after'])
  const done = await h.threads.waitIdle(t.id)
  assert.equal(done.status, 'idle')
  assert.deepEqual(done.turns.map((x) => [x.ok, x.text]), [[false, ''], [true, 'ran after the stop']])
  assert.deepEqual(h.types(), ['thread.started', 'thread.stopped', 'thread.done'])
})
