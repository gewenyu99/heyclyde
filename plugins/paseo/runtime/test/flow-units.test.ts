import { needsGitPermission } from '../src/flow/stage.ts'
/** clyde-flow's small pieces: gate parsing of every skill, the result and verdict parsers, judge choice, prompts, the diff and checks. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { pickAnswer } from '../src/cli/flow.ts'
import { clydeBin, repoRoot } from '../src/config.ts'
import { gate, skillPath } from '../src/flow/gate.ts'
import { clip, parsePlan } from '../src/flow/memory.ts'
import { approvalQuestion, blockQuestion, finalQuestion, isApproval, judgePrompt, limitQuestion, memoryQuestion, PLAN_CRITERIA, planPrompt, REVIEW_CRITERIA, reviewPrompt, slicePrompt, workerPrompt } from '../src/flow/prompts.ts'
import { diffSince, sh } from '../src/flow/shell.ts'
import type { Run } from '../src/flow/types.ts'
import { parseResult, parseVerdict, passes, pickJudge, workerResult } from '../src/flow/verdict.ts'
import { git, makeRepo, tempDir } from './helpers.ts'

const RUN = { id: 'r-1', cwd: '/w/r-1', branch: 'clyde/r-1', base: 'a'.repeat(40) } as Run

test('gate parses the bold lead-in bullets of every skill with a Pass the gate section', () => {
  const skills = readdirSync(join(repoRoot(), 'skills')).filter((name) => {
    const path = join(repoRoot(), 'skills', name, 'SKILL.md')
    return existsSync(path) && /^## Pass the gate$/m.test(readFileSync(path, 'utf8'))
  })
  assert.deepEqual(skills.sort(), ['code-it-clean', 'code-it-good', 'code-it-works'])
  for (const skill of skills) {
    const section = readFileSync(skillPath(skill), 'utf8').split('## Pass the gate')[1].split('\n## ')[0]
    const leads = [...section.matchAll(/^- \*\*(.+?)\*\*/gm)].map((m) => m[1])
    const criteria = gate(skill)
    assert.equal(criteria.length, leads.length, skill)
    criteria.forEach((c, i) => {
      assert.ok(c.startsWith(`${leads[i]} `), `${skill}: ${c}`)
      assert.doesNotMatch(c, /\*\*/)
    })
  }
  assert.deepEqual(gate('code-it-works')[0], 'Red then green. The end condition failed for the expected reason, then passed. Both commands and results are recorded.')
  assert.deepEqual(gate('code-it-good').map((c) => c.split('.')[0]), [
    'Every addition proven', 'Every failure has an outcome', 'Every guard probed', 'Every table true', 'Checks green', 'Siblings and docs current', 'Review closed', 'Still works',
  ])
  assert.equal(gate('code-it-clean').length, 5)
})

test('gate joins a wrapped bullet, takes another section, and refuses a missing skill, section or odd name', () => {
  const root = tempDir('skills')
  mkdirSync(join(root, 'skills', 'demo'), { recursive: true })
  writeFileSync(join(root, 'skills', 'demo', 'SKILL.md'), [
    '# Demo', '', '## Pass the gate', '', 'Intro line.', '', '- **First.** One line', '  that wraps.', '- **Second.**', '- plain bullet',
    '', 'Then hand off.', '', '## Other', '', '- **Elsewhere.** Not in the gate.',
  ].join('\n'))
  assert.deepEqual(gate('demo', undefined, root), ['First. One line that wraps.', 'Second.'])
  assert.deepEqual(gate('demo', 'Other', root), ['Elsewhere. Not in the gate.'])
  assert.throws(() => gate('demo', 'Missing', root), /skill demo has no bold bullets under "## Missing"/)
  assert.throws(() => gate('nobody', undefined, root), /skill nobody has no SKILL\.md/)
  assert.throws(() => gate('../demo', undefined, root), /must be a skill directory name/)
  assert.throws(() => gate('plan'), /skill plan has no bold bullets under "## Pass the gate"/)
})

test('a worker result comes from clyde result first, then the last fenced json block', () => {
  const done = { status: 'done', summary: 'ok', evidence: [{ criterion: 'a', evidence: 'b' }] }
  const text = `Done.\n\n\`\`\`json\n${JSON.stringify({ ...done, summary: 'from the block' })}\n\`\`\``
  assert.equal(workerResult(done, text)?.summary, 'ok')
  assert.equal(workerResult(undefined, text)?.summary, 'from the block')
  assert.equal(workerResult({ status: 'maybe' }, 'no block'), null)
  assert.equal(parseResult({ status: 'done', summary: 'x', evidence: [{ criterion: 1 }] }), null)
  assert.deepEqual(parseResult({ status: 'blocked', summary: 'stuck', extra: 1 }), { status: 'blocked', summary: 'stuck', evidence: [] })
})

test('a verdict must be well formed, and pass needs every criterion, a grade per gate item, and green checks', () => {
  const v = { verdict: 'pass', criteria: [{ criterion: 'a', pass: true, evidence: 'e' }, { criterion: 'b', pass: true, evidence: 'e' }], notes: '' }
  assert.deepEqual(parseVerdict({ ...v, extra: 1 }), v)
  assert.equal(parseVerdict({ ...v, verdict: 'maybe' }), null)
  assert.equal(parseVerdict({ ...v, criteria: [{ criterion: 'a', pass: 'yes', evidence: '' }] }), null)
  assert.equal(parseVerdict({ verdict: 'pass', criteria: [] }), null)
  const ok = parseVerdict(v) as NonNullable<ReturnType<typeof parseVerdict>>
  const green = [{ cmd: 'true', code: 0, output: '' }]
  assert.equal(passes(ok, ['a', 'b'], green), true)
  assert.equal(passes(ok, ['a', 'b', 'c'], green), false, 'a criterion the judge skipped fails')
  assert.equal(passes(ok, ['a', 'b'], [{ cmd: 'false', code: 1, output: '' }]), false)
  assert.equal(passes({ ...ok, criteria: [ok.criteria[0], { ...ok.criteria[1], pass: false }] }, ['a', 'b'], green), false)
  assert.equal(passes({ ...ok, verdict: 'fail' }, ['a', 'b'], green), false)
})

test('the judge is the first rung from another family, else the first rung', () => {
  const judges = [{ backend: 'claude', model: 'sonnet' }, { backend: 'pi', model: 'xai/grok-4.7' }] as const
  assert.deepEqual(pickJudge([...judges], { backend: 'pi', model: 'openai-codex/gpt-6.1-sol' }), { rung: judges[0], differs: true })
  assert.deepEqual(pickJudge([...judges], { backend: 'claude', model: 'opus' }), { rung: judges[1], differs: true })
  assert.deepEqual(pickJudge([judges[0]], { backend: 'pi', model: 'anthropic/claude-opus-5-5' }), { rung: judges[0], differs: false })
})

test('a plan needs an intent and slices with unique ids, and comes bare or under plan', () => {
  const plan = { intent: 'Do it.', slices: [{ id: 1, title: ' One ', acceptance: ['npm test'] }] }
  assert.deepEqual(parsePlan(plan), { intent: 'Do it.', slices: [{ id: '1', title: 'One', acceptance: ['npm test'] }] })
  assert.deepEqual(parsePlan({ status: 'done', plan }), parsePlan(plan))
  assert.equal(parsePlan({ intent: 'x', slices: [] }), null)
  assert.equal(parsePlan({ intent: 'x', slices: [{ id: 'a', title: 't' }, { id: 'a', title: 'u' }] }), null)
  assert.equal(parsePlan({ intent: 'x', slices: [{ id: 'a b', title: 't' }] }), null)
  assert.equal(parsePlan({ intent: 'x', slices: [{ id: 'a', title: 't', acceptance: [''] }] }), null)
})

test('clip never splits a surrogate pair or keeps a NUL, since memory refuses both', () => {
  assert.equal(clip('abc', 10), 'abc')
  assert.equal(clip('a\0b', 10), 'ab')
  // The cut at 6 lands between the halves of the first emoji.
  const cut = clip(`${'x'.repeat(5)}😀😀😀`, 9)
  assert.equal(cut, 'xxxxx...')
  assert.doesNotMatch(cut, /[\ud800-\udfff]/)
})

test('only a bare yes approves, and --answers matches before --auto-approve', () => {
  for (const yes of ['approved', 'Approve', 'yes', 'OK.', 'lgtm!', 'go ahead', 'ship it']) assert.ok(isApproval(yes), yes)
  for (const no of ['approved, but rename it', 'no', 'yes but split s1', '']) assert.ok(!isApproval(no), no)
  const answers = [{ match: '^Approve', text: 'approved' }, { match: 'hit a backend limit', text: 'retry' }]
  assert.deepEqual(pickAnswer('Approve the plan?', 'approve', answers, false), { text: 'approved', via: 'answers file' })
  assert.deepEqual(pickAnswer('Stage x hit a backend limit.', 'limit', answers, true), { text: 'retry', via: 'answers file' })
  assert.deepEqual(pickAnswer('Run r-1 finished every stage.', 'approve', [], true), { text: 'approved', via: 'auto-approve' })
  assert.deepEqual(pickAnswer("Run r-1 can't reach memory", 'memory', [], true), { text: 'stop', via: 'auto-approve' })
  assert.equal(pickAnswer('Anything', 'limit', answers, false), null)
})

test('the worker prompt names the skill, the scope and every clyde tool, and says not to push or ask', () => {
  const spec = { name: 'code-it-works:s1', skill: 'code-it-works', prompt: 'Build it.', criteria: ['A. b.'], checks: ['npm test'] }
  const p = workerPrompt({ run: RUN, spec, attempt: 2, notes: 'Fix the parser.', skillFile: skillPath('code-it-works'), root: repoRoot(), bin: clydeBin() })
  for (const want of [
    `Read ${join(repoRoot(), 'skills', 'code-it-works', 'SKILL.md')} first`, `CLAUDE_PLUGIN_ROOT is ${repoRoot()}`, 'memory scope run:r-1',
    'clyde recall "code-it-works:s1" --scope run:r-1', 'clyde remember --pattern observations', 'clyde progress "<line>"', 'clyde result --status done',
    '```json\n{"status": "done"', 'Commit locally on the current branch. Never push', "The user approved this run's plan. Don't stop to ask",
    '1. A. b.', '- `npm test`', 'Fix the parser.', `run node ${clydeBin()}`, 'attempt 2',
  ]) assert.ok(p.includes(want), want)
})

test('the judge prompt is read-only, defaults to fail, and cuts a long diff', () => {
  const spec = { name: 'task', prompt: 'x', criteria: ['A.'] }
  const p = judgePrompt({ run: RUN, spec, base: 'b1', commits: 'c1 msg', diff: `+${'x'.repeat(60_000)}`, checks: [{ cmd: 'npm test', code: 1, output: 'boom' }] })
  for (const want of ["You're read-only. Don't edit files", 'Default to fail', 'A claim with no evidence fails', '`npm test` exited 1:\n\n```\nboom\n```', 'clyde recall "<query>" --scope run:r-1', 'The diff is cut here at 50000 of 60001 characters']) {
    assert.ok(p.includes(want), want)
  }
  assert.ok(p.length < 60_000)
  assert.match(judgePrompt({ run: RUN, spec, base: 'b1', commits: '', diff: '', checks: [] }), /No commits since then\.\n\nNothing changed since b1\./)
})

test('every prompt and question follows the voice rules: no em or en dashes, no semicolons', () => {
  const plan = { intent: 'Greet.', slices: [{ id: 's1', title: 'Write it', acceptance: ['test -f a'] }] }
  const spec = { name: 'task', skill: 'plan', prompt: 'x', criteria: ['A.'], checks: ['true'] }
  const texts = [
    workerPrompt({ run: RUN, spec, attempt: 1, notes: 'n', skillFile: '/s', root: '/r', bin: '/b' }),
    judgePrompt({ run: RUN, spec, base: 'b', commits: 'c', diff: '+x', checks: [{ cmd: 'true', code: 0, output: '' }], artifact: plan }),
    blockQuestion(RUN, 'task', 'Missing access.'), limitQuestion(RUN, 'task', 'Usage limit reached.'), memoryQuestion(RUN, 'connect ECONNREFUSED'),
    approvalQuestion(RUN, plan, 'e1'), finalQuestion(RUN, { commits: 2, review: 'Clean.', verdict: 'pass' }),
    planPrompt('Greet.', 'Split it.'), slicePrompt(RUN, plan, plan.slices[0], 'code-it-good'), reviewPrompt(RUN),
    ...PLAN_CRITERIA, ...REVIEW_CRITERIA,
  ]
  for (const t of texts) assert.doesNotMatch(t, /[–—;]/, t)
  assert.equal(blockQuestion(RUN, 'task', 'Missing access.'), "Stage task of run r-1 is blocked. The judge accepted the worker's reason: Missing access. Answer stop, or tell the worker how to proceed.")
})

test('diffSince holds commits, edits and new files, and leaves the index alone', async () => {
  const beforeHome = process.env.CLYDE_HOME
  process.env.CLYDE_HOME = tempDir('flow-units-home')
  try {
    const repo = makeRepo()
    const base = git(repo, 'rev-parse', 'HEAD')
    writeFileSync(join(repo, 'committed.txt'), 'one\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-q', '-m', 'one')
    writeFileSync(join(repo, 'README.md'), '# changed\n')
    writeFileSync(join(repo, 'untracked.txt'), 'new\n')
    const diff = await diffSince(repo, base)
    for (const want of ['+one', '+# changed', '+new', 'b/untracked.txt']) assert.ok(diff.includes(want), want)
    assert.equal(git(repo, 'status', '--porcelain'), 'M README.md\n?? untracked.txt', 'nothing got staged')
    await assert.rejects(diffSince(repo, 'f'.repeat(40)), /git diff f+ failed/)
  } finally {
    if (beforeHome === undefined) delete process.env.CLYDE_HOME
    else process.env.CLYDE_HOME = beforeHome
  }
})

test('sh returns the exit code and output, and a timeout kills the whole process group', async () => {
  const dir = tempDir('sh')
  assert.deepEqual(await sh('echo out; echo err >&2; exit 3', dir), { code: 3, output: 'out\nerr\n', stderr: '' })
  const started = Date.now()
  const slow = await sh('sleep 30 & sleep 30; echo never', dir, { timeoutMs: 200 })
  assert.ok(Date.now() - started < 5000)
  assert.equal(slow.code, 137)
  assert.match(slow.output, /timed out after 200 ms$/)
  const abort = new AbortController()
  const pending = sh('sleep 30', dir, { signal: abort.signal })
  abort.abort()
  assert.match((await pending).output, /stopped$/)
})

test('the plan judge grades the plan document and never asks for diffs or red and green evidence', async () => {
  const { judgePrompt, planning } = await import('../src/flow/prompts.ts')
  const run = { id: 'r-1', cwd: '/w', branch: 'clyde/r-1' } as never
  const plan = judgePrompt({ run, spec: { name: 'plan', role: 'planner', prompt: '', criteria: ['Slices are small.'] }, base: 'abc', commits: '', diff: '', checks: [], artifact: { slices: [] } } as never)
  assert.match(plan, /This stage produces a plan, not code/)
  assert.match(plan, /Don't ask for a diff, commits, test runs, or red and green evidence/)
  assert.doesNotMatch(plan, /Default to fail\. A criterion passes only when you can point at its evidence in the diff/)
  const code = judgePrompt({ run, spec: { name: 'task', role: 'worker', prompt: '', criteria: ['x'] }, base: 'abc', commits: '', diff: '', checks: [] } as never)
  assert.match(code, /Grade the change against the gate/)
  assert.equal(planning({ name: 'plan-2' }), true)
  assert.equal(planning({ name: 'code-it-works:s1', role: 'worker' }), false)
})

test("a Claude session limit counts as a backend limit, and attempts dying within seconds stop the loop", async () => {
  const { backendLimit, fastFailures } = await import('../src/flow/stage.ts')
  assert.equal(backendLimit("You've hit your session limit · resets 5:40pm (America/Toronto)."), true)
  assert.equal(backendLimit('You hit your weekly limit'), true)
  assert.equal(backendLimit('npm test failed: 3 assertions'), false)
  const t0 = Date.parse('2026-10-12T21:39:00Z')
  const quick = (n: number) => ({ n, ok: false, startedAt: new Date(t0 + n * 3000).toISOString(), endedAt: new Date(t0 + n * 3000 + 2000).toISOString(), reason: 'boom' })
  const slow = { n: 0, ok: false, startedAt: new Date(t0 - 600_000).toISOString(), endedAt: new Date(t0 - 60_000).toISOString(), reason: 'judge failed' }
  assert.equal(fastFailures([slow, quick(1), quick(2), quick(3)] as never), 3)
  assert.equal(fastFailures([quick(1), slow] as never), 0)
  assert.equal(fastFailures([quick(1), { ...quick(2), verdict: { verdict: 'fail' } }] as never), 0)
})

test('native task workers can report through their final message without accessing the daemon socket', () => {
  const text = workerPrompt({run:{...RUN,paseoParentId:'parent'},spec:{name:'task',prompt:'Create a receipt',criteria:['One file']},attempt:1,root:'/r',bin:'/b'})
  assert.match(text, /one fenced JSON block/)
  assert.match(text, /native permission UI/)
  assert.doesNotMatch(text, /clyde todo|clyde result --status/)
})

test('a blocked native Git index asks for user action rather than another speculative retry', () => {
  const message = {status:'blocked' as const, summary:'Could not commit with Git', evidence:[{criterion:'commit',evidence:'index.lock: Operation not permitted'}]}
  assert.equal(needsGitPermission(message),true)
  assert.equal(needsGitPermission({...message,status:'done'}),false)
  assert.equal(needsGitPermission({...message,evidence:[]}),false)
})
