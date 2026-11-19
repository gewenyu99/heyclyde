import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { antigravity } from '../src/backends/antigravity.ts'
import { claudeArgs } from '../src/backends/claude.ts'
import { codexArgs } from '../src/backends/codex.ts'
import { auditChange, MAX_AUDIT_REPAIRS } from '../src/flow/audit.ts'
import { publishDraft } from '../src/flow/publish.ts'
import type { Driver } from '../src/flow/runtime.ts'
import { maxStageAttempts, runStage } from '../src/flow/stage.ts'
import type { FlowCtx, Run } from '../src/flow/types.ts'
import { flushPending } from '../src/memory-flush.ts'
import { deadLetters, enqueue, localId, pending, spoolStatus } from '../src/memory-spool.ts'
import { tempDir } from './helpers.ts'

function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'clyde-q45-')))
  const prev = process.env.CLYDE_HOME
  process.env.CLYDE_HOME = home
  return Promise.resolve()
    .then(() => fn(home))
    .finally(() => {
      if (prev === undefined) delete process.env.CLYDE_HOME
      else process.env.CLYDE_HOME = prev
      rmSync(home, { recursive: true, force: true })
    })
}

function makeGitRepo(prefix = 'q45-repo'): string {
  const repo = tempDir(prefix)
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim()
  git('init', '-q', '-b', 'main')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'app.txt'), 'v0\n')
  git('add', 'app.txt')
  git('commit', '-q', '-m', 'base')
  return repo
}

test('spool separates runtime and agent dirs, enforces modes, rejects symlinks, and prevents role escalation', async () => {
  await withTempHome((home) => {
    const dir = join(home, 'memory-spool')
    const rtPayload = {
      id: 'run-q45',
      pattern: 'projects',
      title: 'Runtime project',
      body: 'tracked run',
      authority: 'observed',
      scope: 'run:q45',
      evidence_kind: 'summary',
      evidence: 'ok',
      source: { kind: 'run', title: 'q45' },
    }
    const agPayload = {
      pattern: 'observations',
      title: 'Agent draft',
      body: 'draft body',
      authority: 'draft',
      scope: 'run:q45',
      project: 'run-q45',
      evidence_kind: 'assistant',
      evidence: 'seen',
    }
    const rt = enqueue(rtPayload, 'runtime', dir)
    const ag = enqueue(agPayload, 'agent', dir)
    assert.ok(existsSync(join(dir, 'runtime', `${encodeURIComponent(rt.id)}.json`)))
    assert.ok(existsSync(join(dir, 'agent', `${encodeURIComponent(ag.id)}.json`)))
    assert.equal(statSync(join(dir, 'runtime')).mode & 0o777, 0o700)
    assert.equal(statSync(join(dir, 'agent', `${encodeURIComponent(ag.id)}.json`)).mode & 0o777, 0o600)

    // File inside agent/ tampered to claim role:'runtime' still loads as role:'agent'.
    const agFile = join(dir, 'agent', `${encodeURIComponent(ag.id)}.json`)
    writeFileSync(agFile, JSON.stringify({ ...ag, role: 'runtime' }), { mode: 0o600 })
    assert.equal(pending(dir).find((r) => r.id === ag.id)?.role, 'agent')

    // Symlink in agent/ is ignored on pending().
    const linkPath = join(dir, 'agent', 'evil-link.json')
    symlinkSync(join(dir, 'runtime', `${encodeURIComponent(rt.id)}.json`), linkPath)
    assert.equal(pending(dir).some((r) => r.id === 'evil-link'), false)
    rmSync(linkPath)

    // Loose permissions on an entry file are ignored on pending().
    chmodSync(agFile, 0o644)
    assert.equal(pending(dir).some((r) => r.id === ag.id), false)
    chmodSync(agFile, 0o600)
    assert.equal(pending(dir).some((r) => r.id === ag.id), true)

    // Unsafe root/sub dir permissions reject enqueue.
    chmodSync(join(dir, 'agent'), 0o755)
    assert.throws(() => enqueue({ ...agPayload, title: 'Another' }, 'agent', dir), /Unsafe/)
    chmodSync(join(dir, 'agent'), 0o700)
  })
})

test('flushPending quarantines permanent 4xx errors without head-of-line blocking and isolates role auth failures', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'memory-spool')
    const bad = enqueue({
      id: 'run-bad-400',
      pattern: 'projects',
      title: 'Bad entry',
      body: 'bad',
      authority: 'observed',
      scope: 'run:bad',
      evidence_kind: 'summary',
      evidence: 'ok',
      source: { kind: 'run', title: 'bad' },
    }, 'runtime', dir)
    const ag = enqueue({
      pattern: 'observations',
      title: 'Valid agent draft',
      body: 'valid note',
      authority: 'draft',
      scope: 'run:good',
      evidence_kind: 'assistant',
      evidence: 'seen',
    }, 'agent', dir)
    const rt = enqueue({
      id: 'run-good',
      pattern: 'projects',
      title: 'Good runtime',
      body: 'good',
      authority: 'observed',
      scope: 'run:good',
      evidence_kind: 'summary',
      evidence: 'ok',
      source: { kind: 'run', title: 'good' },
    }, 'runtime', dir)

    // Force identical createdAt ordering: bad arrives first, agent arrives next, good runtime arrives last.
    const seen: { id: string; auth: string }[] = []
    const send = async (_m: string, _u: string, opts: any) => {
      const rowId = opts.body.id ?? localId(opts.body)
      seen.push({ id: rowId, auth: opts.headers.authorization })
      if (rowId === bad.id) return { status: 400, text: 'bad payload', headers: {} }
      if (opts.headers.authorization === 'Bearer agent-tok') return { status: 401, text: 'expired agent token', headers: {} }
      return { status: 200, text: JSON.stringify({ id: rowId }), headers: {} }
    }

    const flushed = await flushPending({ url: 'http://memory.invalid', runtimeToken: 'rt-tok', agentToken: 'agent-tok', dir, send })
    assert.equal(flushed, 1, 'good runtime entry flushed despite permanent 400 and agent 401')
    assert.ok(seen.some((s) => s.id === bad.id))
    assert.ok(seen.some((s) => s.id === rt.id && s.auth === 'Bearer rt-tok'))
    assert.equal(deadLetters(dir).length, 1)
    assert.equal(deadLetters(dir)[0].id, bad.id)
    assert.match(deadLetters(dir)[0].reason, /HTTP 400/)
    const status = spoolStatus(dir)
    assert.equal(status.depth, 1)
    assert.equal(status.deadLetterDepth, 1)
    assert.ok(typeof status.oldestAgeMs === 'number' && status.oldestAgeMs >= 0)
    assert.deepEqual(pending(dir).map((r) => r.id), [ag.id])

    // Supplying a fresh agentToken drains the remaining agent entry.
    const flushed2 = await flushPending({ url: 'http://memory.invalid', runtimeToken: 'rt-tok', agentToken: 'fresh-agent', dir, send })
    assert.equal(flushed2, 1)
    assert.equal(pending(dir).length, 0)
  })
})

test('auditChange runs bounded multi-round repairs reviewing full run.base..head diffs before escalating', async () => {
  const repo = makeGitRepo('q45-audit')
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', repo, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
      }).trim()
    const base = git('rev-parse', 'HEAD')
    writeFileSync(join(repo, 'app.txt'), 'v1-buggy\n')
    git('add', 'app.txt')
    git('commit', '-q', '-m', 'impl')

    const run = {
      id: 'r-audit',
      flow: 'task',
      title: 'audit multi',
      status: 'running',
      input: {},
      cwd: repo,
      repo,
      branch: 'main',
      base,
      stages: [],
      answers: [],
      asks: [],
      entries: [],
      plans: [],
      agents: {},
      log: [],
      firstEvent: 0,
      createdAt: '',
      updatedAt: '',
    } as unknown as Run

    const stagesCalled: string[] = []
    const auditedRanges: string[] = []
    let asks = 0
    const ctx: FlowCtx = {
      run,
      cwd: repo,
      scope: 'run:r-audit',
      async stage(spec) {
        stagesCalled.push(spec.name)
        const round = stagesCalled.length
        writeFileSync(join(repo, 'app.txt'), round >= 2 ? 'v3-clean\n' : 'v2-still-buggy\n')
        git('add', 'app.txt')
        git('commit', '-q', '-m', spec.name)
        run.stages.push({ name: spec.name, role: 'worker', status: 'passed', base, round, attempts: [], startedAt: '' })
        return { passed: true, attempts: 1, verdict: { verdict: 'pass', criteria: [], notes: 'ok' }, summary: 'fixed' }
      },
      async agent(opts) {
        if (opts.route === 'audit') auditedRanges.push(opts.title + ':' + opts.prompt.slice(0, 120))
        const content = execFileSync('git', ['-C', repo, 'show', 'HEAD:app.txt'], { encoding: 'utf8' })
        if (opts.route === 'audit') {
          if (content.includes('clean')) return { ok: true, text: '{}', json: { findings: [] } }
          return { ok: true, text: '{}', json: { findings: [{ id: 'f1', evidence: content.trim() }] } }
        }
        return { ok: true, text: '{}', json: { findings: [{ id: 'f1', status: 'confirmed', evidence: 'confirmed' }] } }
      },
      async check(cmd) { return { code: 0, output: cmd.includes('porcelain') ? '' : 'ok' } },
      async ask() { asks++; return 'ok' },
      async remember() { return 'e1' },
      async setPlan() { return 'p1' },
      gate() { return [] },
      persist() {},
      log() {},
    }

    await auditChange(ctx, ['true'])
    assert.deepEqual(stagesCalled, ['audit-repair', 'audit-repair-2'])
    assert.equal(asks, 0)
    assert.equal(run.auditedHead, git('rev-parse', 'HEAD'))
    assert.ok(auditedRanges.every((r) => r.includes('against ' + base)), 'every audit pass compares against run.base')

    // Now test MAX_AUDIT_REPAIRS cap escalation + stop handling.
    writeFileSync(join(repo, 'app.txt'), 'forever-buggy\n')
    git('add', 'app.txt')
    git('commit', '-q', '-m', 'reopen')
    const cappedRun = { ...run, stages: [], auditFindings: undefined, auditBaseHead: undefined, auditedHead: undefined } as Run
    const capStages: string[] = []
    let capAsk = ''
    await assert.rejects(
      auditChange({
        ...ctx,
        run: cappedRun,
        async stage(spec) {
          capStages.push(spec.name)
          writeFileSync(join(repo, 'app.txt'), `forever-${capStages.length}\n`)
          git('add', 'app.txt')
          git('commit', '-q', '-m', spec.name)
          cappedRun.stages.push({ name: spec.name, role: 'worker', status: 'passed', base, round: capStages.length, attempts: [], startedAt: '' })
          return { passed: true, attempts: 1, verdict: { verdict: 'pass', criteria: [], notes: 'ok' }, summary: 'tried' }
        },
        async agent(opts) {
          if (opts.route === 'audit') return { ok: true, text: '{}', json: { findings: [{ id: 'f1', evidence: 'still broken' }] } }
          return { ok: true, text: '{}', json: { findings: [{ id: 'f1', status: 'confirmed', evidence: 'confirmed' }] } }
        },
        async ask(q) { capAsk = q; return 'stop' },
      }, []),
      /Audit stopped by the user/,
    )
    assert.equal(capStages.length, MAX_AUDIT_REPAIRS)
    assert.match(capAsk, /Remaining findings at [0-9a-f]+\. Resolve them before retrying:/)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('publishDraft aborts immediately when signal is aborted and stage attempt cap stops runaway loops', async () => {
  const repo = makeGitRepo('q45-pub')
  try {
    const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const controller = new AbortController()
    controller.abort()
    const run = {
      id: 'r-pub', flow: 'task', title: 'pub abort', status: 'running', input: {},
      cwd: repo, repo, branch: 'clyde/r-pub', base: head, auditedHead: head,
      stages: [], answers: [], asks: [], entries: [], plans: [], agents: {}, log: [], firstEvent: 0, createdAt: '', updatedAt: '',
    } as unknown as Run
    await assert.rejects(
      publishDraft({
        run, cwd: repo, scope: 'run:r-pub', signal: controller.signal,
        stage: async () => { throw new Error('unused') },
        agent: async () => { throw new Error('unused') },
        check: async () => ({ code: 0, output: '' }),
        ask: async () => 'stop',
        remember: async () => 'e',
        setPlan: async () => 'p',
        gate: () => [],
        persist: () => {},
        log: () => {},
      }),
      /Publication aborted/,
    )
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }

  const prevMax = process.env.CLYDE_MAX_STAGE_ATTEMPTS
  process.env.CLYDE_MAX_STAGE_ATTEMPTS = '2'
  try {
    assert.equal(maxStageAttempts(), 2)
    const fakeDriver = {
      run: {
        id: 'r-cap',
        stages: [{ name: 'task', role: 'worker', status: 'running', base: 'abc', round: 2, attempts: [{ n: 1 }, { n: 2 }], startedAt: '' }],
      },
      race: <T>(p: Promise<T>) => p,
      save() {},
    } as unknown as Driver
    await assert.rejects(
      runStage(fakeDriver, { name: 'task', prompt: 'x', criteria: ['y'] }),
      /exceeded the maximum of 2 attempts/,
    )
  } finally {
    if (prevMax === undefined) delete process.env.CLYDE_MAX_STAGE_ATTEMPTS
    else process.env.CLYDE_MAX_STAGE_ATTEMPTS = prevMax
  }
})

test('antigravity, claude, and codex read-only modes enforce closed tool sets and structured error handling', async () => {
  const dir = tempDir('q45-agy')
  const prevBin = process.env.CLYDE_AGY_BIN
  try {
    const argvFile = join(dir, 'argv.json')
    const bin = join(dir, 'agy')
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nconst fs = require('node:fs');\nfs.writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(process.argv.slice(2)));\nconsole.log('not valid json {{');\n`,
      { mode: 0o755 },
    )
    process.env.CLYDE_AGY_BIN = bin
    const res = await antigravity.runTurn({
      rung: { backend: 'antigravity', model: 'gemini-4-carbon-high' },
      cwd: dir,
      env: process.env,
      prompt: 'audit this',
      readOnly: true,
      schema: { type: 'object', properties: { findings: { type: 'array' } } },
      signal: new AbortController().signal,
    })
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /invalid JSON/i)
    const argv = JSON.parse(execFileSync('cat', [argvFile], { encoding: 'utf8' })) as string[]
    assert.ok(argv.includes('--sandbox'))
    assert.ok(argv.includes('--disable-slash-commands'))
    assert.ok(argv.includes('--json-schema'))
    const settings = JSON.parse(argv[argv.indexOf('--settings') + 1])
    assert.deepEqual(settings.permissions.allow, ['read_file(*)', 'glob(*)', 'grep(*)', 'list_dir(*)'])
    for (const d of ['command(*)', 'run_command(*)', 'write_file(*)', 'edit_file(*)', 'mcp(*)', 'execute_url(*)']) {
      assert.ok(settings.permissions.deny.includes(d), `missing deny rule ${d}`)
    }
  } finally {
    if (prevBin === undefined) delete process.env.CLYDE_AGY_BIN
    else process.env.CLYDE_AGY_BIN = prevBin
    rmSync(dir, { recursive: true, force: true })
  }

  const cArgs = claudeArgs(
    { rung: { backend: 'claude', model: 'sonnet' }, cwd: '/tmp', env: {}, prompt: 'p', readOnly: true, signal: new AbortController().signal },
    'sess-1',
    false,
  )
  assert.equal(cArgs[cArgs.indexOf('--tools') + 1], 'Read,Grep,Glob')
  assert.ok(cArgs.includes('--strict-mcp-config'))
  assert.equal(cArgs[cArgs.indexOf('--mcp-config') + 1], '{"mcpServers":{}}')

  const xArgs = codexArgs(
    { rung: { backend: 'codex', model: 'gpt-6.1-sol' }, cwd: '/tmp', env: {}, prompt: 'p', readOnly: true, signal: new AbortController().signal },
    { out: '/tmp/out.txt' },
  )
  assert.ok(xArgs.includes('--ephemeral'))
  assert.ok(xArgs.includes('--ignore-user-config'))
  assert.ok(xArgs.includes('approval_policy="never"'))
  assert.equal(xArgs[xArgs.indexOf('-s') + 1], 'read-only')
})

test('specReview fails closed when reviewer returns malformed non-JSON findings', async () => {
  const { run: runShip } = await import('../flows/ship.ts')
  const fakeCtx: FlowCtx = {
    run: {
      id: 'r-spec',
      flow: 'ship',
      title: 'spec check',
      status: 'running',
      input: { intent: 'ship something' },
      routes: { planner: { model: 'sonnet', reason: 'test', pinned: true }, specReview: { model: 'sonnet', reason: 'test', pinned: true } },
      cwd: '/tmp',
      repo: '/tmp',
      branch: 'clyde/r-spec',
      base: 'abc',
      stages: [],
      answers: [],
      asks: [],
      entries: [],
      plans: [],
      agents: {},
      log: [],
      firstEvent: 0,
      createdAt: '',
      updatedAt: '',
    },
    cwd: '/tmp',
    scope: 'run:r-spec',
    stage: async () => ({
      passed: true,
      attempts: 1,
      verdict: { verdict: 'pass', criteria: [], notes: 'ok' },
      summary: 'ok',
      artifact: { intent: 'ship', slices: [{ id: 's1', title: 's1', acceptance: ['true'] }] },
    }),
    agent: async () => ({ ok: true, text: 'looks fine without JSON findings', json: undefined }),
    check: async () => ({ code: 0, output: '' }),
    ask: async () => 'approve',
    remember: async () => 'e1',
    setPlan: async () => 'p1',
    gate: () => [],
    persist: () => {},
    log: () => {},
  }
  await assert.rejects(runShip(fakeCtx, { intent: 'ship something' }), /Spec review returned invalid findings/)
})
