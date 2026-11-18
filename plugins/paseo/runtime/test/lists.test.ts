/** Work lists: the rules, clyde todo, clyde result gating, the prompt, the hooks, the nudge, seeding, delegation and memory handoff. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { DaemonClient } from '../src/client.ts'
import { startDaemon, type Daemon } from '../src/daemon.ts'
import { REPORT_ITEM } from '../src/flow/stage.ts'
import type { Run } from '../src/flow/types.ts'
import { Memory } from '../src/memory.ts'
import { changesFiles, formatList, Lists, type WorkList } from '../src/lists.ts'
import { EventLog } from '../src/events.ts'
import { editBlock } from '../src/lists.ts'
import type { Thread } from '../src/types.ts'
import type { FakeTurn } from './fakes/common.ts'
import { startFakeMemory, type FakeMemory } from './fakes/memory.ts'
import { flowDaemon, flowSetup, waitStatus } from './golden/flow.ts'
import { argvLog, LV, setup, waitFor } from './helpers.ts'

type Ran = { code: number | null; stdout: string; stderr: string }

/** The real clyde in a child, with this process's env plus extra. An undefined value removes a name. */
function clyde(args: string[], extra: Record<string, string | undefined> = {}): Promise<Ran> {
  const env: Record<string, string | undefined> = { ...process.env, ...extra }
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [LV, ...args], { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (c) => (stdout += c))
    child.stderr.on('data', (c) => (stderr += c))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

type H = { d: Daemon; client: DaemonClient; repo: string; state: string; home: string }

async function daemon(turns: FakeTurn[], extra: Record<string, string> = {}, scenario: object = {}): Promise<H> {
  const s = setup(turns, extra)
  if (Object.keys(scenario).length) writeFileSync(s.scenario, JSON.stringify({ turns, ...scenario }))
  const d = await startDaemon({ port: 0 })
  return { d, client: new DaemonClient({ pid: process.pid, port: d.port, token: d.token }), repo: s.repo, state: s.state, home: s.home }
}

function jsonl(state: string, file: string): any[] {
  try {
    return readFileSync(join(state, file), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch {
    return []
  }
}

function types(d: Daemon, id: string): string[] {
  return d.ctx.events.since(0).filter((e) => e.threadId === id).map((e) => e.type)
}

const PI = { backend: 'pi' as const, model: 'fake/fake-1' }

test('the list prints in the fixed format, and the rules hold: one doing, how, evidence, why, and history stays', () => {
  setup([])
  const lists = new Lists(new EventLog())
  const who = 'thread:t3'
  lists.add(who, ['Read the gate', 'Pick the end condition', 'Write the failing end condition', 'Build the thinnest path', 'Run the suite'])
  lists.start(who, 1, 'Read the Pass the gate section')
  lists.done(who, 1, 'skills/code-it-works/SKILL.md:86')
  lists.start(who, 2, 'Pick the cheapest check')
  lists.done(who, 2, 'node --test test/login.test.ts fails with 1 fail')
  lists.start(who, 3, 'node --test test/login.test.ts')
  assert.equal(lists.view(who).text, [
    'Work list, thread t3: 2 done, 1 doing, 2 todo',
    '[x] 1 Read the gate. Evidence: skills/code-it-works/SKILL.md:86',
    '[x] 2 Pick the end condition. Evidence: node --test test/login.test.ts fails with 1 fail',
    '[>] 3 Write the failing end condition. How: node --test test/login.test.ts',
    '[ ] 4 Build the thinnest path',
    '[ ] 5 Run the suite',
    'Next: finish 3, or mark it done with evidence.',
  ].join('\n'))

  // One item in progress: starting 4 puts 3 back to todo, and its how stays.
  lists.start(who, 4, 'Wire the route')
  assert.deepEqual(lists.get(who).items.map((i) => i.status), ['done', 'done', 'todo', 'doing', 'todo'])
  assert.equal(lists.get(who).items[2].how, 'node --test test/login.test.ts')

  const refuse = (fn: () => unknown) => assert.throws(fn, (e: any) => `${e.status} ${e.message}`.length > 0 && (refusals.push(`${e.status} ${e.message}`), true))
  const refusals: string[] = []
  refuse(() => lists.start(who, 5, ''))
  refuse(() => lists.done(who, 4, '  '))
  refuse(() => lists.block(who, 5, undefined))
  refuse(() => lists.done(who, 1, 'again'))
  refuse(() => lists.start(who, 2, 'redo it'))
  refuse(() => lists.start(who, 4, 'again'))
  refuse(() => lists.done(who, 9, 'x'))
  refuse(() => lists.add(who, []))
  refuse(() => lists.add('nobody', ['x']))
  assert.deepEqual(refusals, [
    '400 how must be a non-empty string',
    '400 evidence must be a non-empty string',
    '400 why must be a non-empty string',
    '409 item 1 is already done, and history stays. Add a new item instead',
    '409 item 2 is done, and history stays. Add a new item instead',
    '409 item 4 is already in progress',
    '404 the work list has no item 9',
    '400 items must be a non-empty list of strings',
    '400 a list owner is thread:<id>, run:<id> or pointman',
  ])
  // A change of plan is a new item, and the old one is blocked with why. Nothing is deleted or reworded.
  lists.block(who, 5, 'The suite moved to npm test, see item 6.')
  lists.add(who, ['Run npm test'])
  const after = lists.get(who)
  assert.deepEqual(after.items.map((i) => [i.id, i.text, i.status]), [
    [1, 'Read the gate', 'done'], [2, 'Pick the end condition', 'done'], [3, 'Write the failing end condition', 'todo'],
    [4, 'Build the thinnest path', 'doing'], [5, 'Run the suite', 'blocked'], [6, 'Run npm test', 'todo'],
  ])
  assert.match(formatList(after), /^Work list, thread t3: 2 done, 1 doing, 2 todo, 1 blocked\n/)
  assert.match(formatList(after), /\n\[!\] 5 Run the suite\. Why: The suite moved to npm test, see item 6\.\n/)
  // The file is the state, so a new Lists reads the same list.
  assert.deepEqual(new Lists(new EventLog()).get(who).items, after.items)
  assert.equal(formatList({ owner: 'pointman', items: [] }), 'Work list, point man: empty\nNext: add your steps, then start the first one and say how.')
})

test('changesFiles catches writes in a shell command and leaves reads and clyde todo alone', () => {
  for (const cmd of ['echo hi > a.txt', 'cat a >> b', 'sed -i s/a/b/ f', 'rm -rf dist', 'git commit -m x', 'git add -A && git commit -q -m done',
    'npm install left-pad', 'mv a b', 'touch x', 'printf x | tee out.txt', 'cd src && cp a b']) {
    assert.equal(changesFiles(cmd), true, cmd)
  }
  for (const cmd of ['cat a.txt', 'grep -rn foo src', 'npm test 2>&1', 'node --test > /dev/null', 'git diff HEAD', 'git status',
    'clyde todo add "compare a > b" "rm the old flag"', "clyde todo done 2 --evidence 'echo > x passed'",
    'clyde todo start 1 --how "write notes.txt > output"', 'ls -la']) {
    assert.equal(changesFiles(cmd), false, cmd)
  }
  assert.equal(changesFiles('clyde todo start 1 --how "write notes" && touch x'), true)
  assert.equal(changesFiles('clyde todo start 1 --how "write notes" > x'), true)
})

test('todo recovery uses the next new item number after closed history', () => {
  const list: WorkList = { owner: 'thread:t-recovery', items: [
    { id: 1, text: 'Earlier work', status: 'done', updatedAt: '' },
    { id: 2, text: 'Unavailable work', status: 'blocked', updatedAt: '' },
  ] }
  assert.match(editBlock(list, 'Write') ?? '', /clyde todo start 3 --how "Complete item 3"/)
})

test('clyde todo reads and changes the thread list, prints the whole list each time, and refuses with the list', async () => {
  const h = await daemon([])
  try {
    const t = h.d.ctx.threads.start({ title: 'todo', prompt: 'hi', cwd: h.repo, rung: PI })
    await h.d.ctx.threads.waitIdle(t.id)
    const env = { CLYDE_THREAD_ID: t.id }
    const empty = await clyde(['todo'], env)
    assert.deepEqual([empty.code, empty.stdout], [0, `Work list, thread ${t.id}: empty\nNext: add your steps, then start the first one and say how.\n`])
    const added = await clyde(['todo', 'add', 'Read the gate', 'Write the test'], env)
    assert.equal(added.stdout, `Work list, thread ${t.id}: 0 done, 0 doing, 2 todo\n[ ] 1 Read the gate\n[ ] 2 Write the test\nNext: start 1, and say how.\n`)
    const started = await clyde(['todo', 'start', '1', '--how', 'read skills/code/SKILL.md'], env)
    assert.match(started.stdout, /\n\[>\] 1 Read the gate\. How: read skills\/code\/SKILL\.md\n/)
    const done = await clyde(['todo', 'done', '1', '--evidence', 'skills/code/SKILL.md:12'], env)
    assert.match(done.stdout, /^Work list, thread t-[0-9a-f]+: 1 done, 0 doing, 1 todo\n\[x\] 1 Read the gate\. Evidence: skills\/code\/SKILL\.md:12\n/)
    const blocked = await clyde(['todo', 'block', '2', '--why', 'Needs Wen.'], env)
    assert.match(blocked.stdout, /\n\[!\] 2 Write the test\. Why: Needs Wen\.\nNext: nothing is open\. Report your result\.\n$/)

    const again = await clyde(['todo', 'done', '1', '--evidence', 'twice'], env)
    assert.equal(again.code, 1)
    assert.equal(again.stderr, 'clyde todo: item 1 is already done, and history stays. Add a new item instead\n')
    assert.equal(again.stdout, blocked.stdout, 'a refusal still prints the whole list')
    assert.equal((await clyde(['todo', 'start', '2'], env)).code, 2, '--how is required')
    assert.equal((await clyde(['todo', 'done', 'x', '--evidence', 'e'], env)).code, 2)
    assert.equal((await clyde(['todo', 'frob'], env)).code, 2)
    assert.equal((await clyde(['todo'], { CLYDE_THREAD_ID: undefined })).code, 2)
    const missing = await clyde(['todo'], { CLYDE_THREAD_ID: 't-00000000' })
    assert.deepEqual([missing.code, missing.stderr], [1, 'clyde todo: no thread t-00000000\n'])

    const run = await clyde(['todo', 'add', 'Plan the slices', '--run', 'r-1'], env)
    assert.equal(run.stdout, 'Work list, run r-1: 0 done, 0 doing, 1 todo\n[ ] 1 Plan the slices\nNext: start 1, and say how.\n')
    assert.ok(existsSync(join(h.home, 'lists', 'run:r-1.json')))
    const e = h.d.ctx.events.since(0).filter((x) => x.type === 'list.updated')
    assert.deepEqual(e.map((x) => x.summary), [
      `Work list thread:${t.id}: added items 1 to 2.`, `Work list thread:${t.id}: started 1.`, `Work list thread:${t.id}: finished 1.`,
      `Work list thread:${t.id}: blocked 2.`, 'Work list run:r-1: added item 1.',
    ])
    assert.deepEqual([e[0].threadId, e[4].runId], [t.id, 'r-1'])
  } finally {
    await h.d.close()
  }
})

test('clyde result is refused while items are open, and blocked needs a blocked item', async () => {
  const h = await daemon([])
  try {
    const t = h.d.ctx.threads.start({ title: 'gated', prompt: 'hi', cwd: h.repo, rung: PI, list: ['Fix the parser', 'Report with clyde result'] })
    await h.d.ctx.threads.waitIdle(t.id)
    const env = { CLYDE_THREAD_ID: t.id }
    const early = await clyde(['result', '--status', 'done', '--summary', 'All fixed.'], env)
    assert.equal(early.code, 1)
    assert.match(early.stderr, /^clyde result: Your work list has 2 open items, so clyde refused done\. Mark each done with evidence, or block it with why\.\n\nWork list, thread t-[0-9a-f]+: 0 done, 0 doing, 2 todo\n/)
    assert.equal(h.d.ctx.threads.result(t.id), undefined, 'a refused result changes nothing')
    const blocked = await clyde(['result', '--status', 'blocked', '--summary', 'Stuck.'], env)
    assert.equal(blocked.code, 1)
    assert.match(blocked.stderr, /blocked needs a blocked item\. Block the item you can't finish with clyde todo block N --why "<why>" first\./)

    await clyde(['todo', 'block', '1', '--why', 'The grammar is ambiguous.'], env)
    const nowBlocked = await clyde(['result', '--status', 'blocked', '--summary', 'Stuck on the grammar.'], env)
    assert.equal(nowBlocked.code, 0, nowBlocked.stderr)
    assert.equal((await clyde(['result', '--status', 'done', '--summary', 'x'], env)).code, 1, 'item 2 is still open')
    await clyde(['todo', 'done', '2', '--evidence', 'reported blocked'], env)
    const done = await clyde(['result', '--status', 'done', '--summary', 'Reported.'], env)
    assert.equal(done.code, 0, done.stderr)
    assert.deepEqual(h.d.ctx.threads.result(t.id), { status: 'done', summary: 'Reported.' })
  } finally {
    await h.d.close()
  }
})

test('every turn of a thread with a list starts with the list, and a thread without one keeps its prompt', async () => {
  const h = await daemon([{ match: 'first', reply: 'one' }, { match: 'second', reply: 'two' }, { match: 'plain', reply: 'three' }])
  try {
    const t = h.d.ctx.threads.start({ title: 'listed', prompt: 'first message', cwd: h.repo, rung: PI, list: ['Do the thing'] })
    await h.d.ctx.threads.waitIdle(t.id)
    h.d.ctx.threads.lists.start(`thread:${t.id}`, 1, 'carefully')
    h.d.ctx.threads.send(t.id, 'second message')
    const done = await h.d.ctx.threads.waitIdle(t.id)
    const plain = h.d.ctx.threads.start({ title: 'plain', prompt: 'plain message', cwd: h.repo, rung: PI })
    await h.d.ctx.threads.waitIdle(plain.id)
    const prompts = argvLog(h.state).map((c) => c.argv.at(-1))
    assert.equal(prompts[0], `Work list, thread ${t.id}: 0 done, 0 doing, 1 todo\n[ ] 1 Do the thing\nNext: start 1, and say how.\n\nfirst message`)
    assert.ok(prompts.some((p) => p === `Work list, thread ${t.id}: 0 done, 1 doing, 0 todo\n[>] 1 Do the thing. How: carefully\nNext: finish 1, or mark it done with evidence.\n\nsecond message`), prompts.join('\n---\n'))
    assert.equal(prompts.at(-1), 'plain message')
    assert.equal(done.turns[0].prompt, 'first message', 'the turn records the message, not the list')
  } finally {
    await h.d.close()
  }
})

test('a claude worker that edits before it has a list is blocked by its PreToolUse hook, and its Stop hook sends it back', async () => {
  const turns: FakeTurn[] = [
    { match: 'write the notes', write: { 'notes.txt': 'early\n' }, reply: 'Tried to write.' },
    { match: 'plan first', todo: [['add', 'Write notes.txt']], write: { 'notes.txt': 'still early\n' }, reply: 'Added, not started.' },
    // The Stop hook's reason comes back like a prompt, and each one takes the next of these.
    { match: 'open item', todo: [['start', '1', '--how', 'write the file']], write: { 'notes.txt': 'planned\n' }, reply: 'Wrote it.' },
    { match: 'open item', todo: [['done', '1', '--evidence', 'notes.txt holds planned']], clydeResult: { status: 'done', summary: 'notes written' }, reply: 'Reported.' },
  ]
  const h = await daemon(turns, {}, { runHooks: true })
  try {
    const t = h.d.ctx.threads.start({ title: 'hooked', prompt: 'write the notes', cwd: h.repo, rung: { backend: 'claude', model: 'sonnet' } })
    await h.d.ctx.threads.waitIdle(t.id)
    assert.ok(!existsSync(join(h.repo, 'notes.txt')), 'the hook blocked the write')
    h.d.ctx.threads.send(t.id, 'plan first')
    const done = await h.d.ctx.threads.waitIdle(t.id)
    assert.equal(readFileSync(join(h.repo, 'notes.txt'), 'utf8'), 'planned\n')

    const blocked = jsonl(h.state, 'blocked.jsonl')
    assert.deepEqual(blocked.map((b) => b.tool), ['Write', 'Write'])
    assert.match(blocked[0].reason, /^Your work list is empty, so clyde blocked this Write call\. Add your steps with clyde todo add/)
    assert.match(blocked[1].reason, /^Nothing on your work list is in progress, so clyde blocked this Write call\./)
    assert.match(blocked[0].reason, /Run exactly: clyde todo add "Prepare the requested edit"\nThen run: clyde todo start 1 --how "Complete item 1"/)
    assert.match(blocked[1].reason, /Run exactly: clyde todo start 1 --how "Complete item 1"/)
    const hooks = jsonl(h.state, 'hooks.jsonl')
    const pre = hooks.filter((x) => x.event === 'PreToolUse')
    assert.deepEqual(pre.map((x) => [x.tool, x.code]), [['Write', 2], ['Bash', 0], ['Write', 2], ['Bash', 0], ['Write', 0], ['Bash', 0], ['Bash', 0]])
    // Turn 1 had no list, so it stopped. Turn 2 stopped twice with item 1 open, went back each time, and then reported.
    const stops = hooks.filter((x) => x.event === 'Stop')
    assert.deepEqual(stops.map((x) => x.code), [0, 2, 2, 0])
    assert.match(stops[1].stderr, /^Your work list has 1 open item and no result is posted\. Continue with the next one, or block it with why\. Then report with clyde result\.\n\nWork list, thread t-[0-9a-f]+: 0 done, 0 doing, 1 todo\n/)
    assert.match(stops[2].stderr, /\n\[>\] 1 Write notes\.txt\. How: write the file\n/)
    assert.deepEqual(h.d.ctx.threads.result(t.id), { status: 'done', summary: 'notes written' })
    assert.equal(done.turns.at(-1)?.text, 'Reported.')
    assert.deepEqual(types(h.d, t.id).filter((x) => x.startsWith('thread.')), ['thread.started', 'thread.done', 'thread.done'])
  } finally {
    await h.d.close()
  }
})

test('the Stop gate sends a worker back at most 3 times per turn, and never once a result is posted', async () => {
  const h = await daemon([{ match: 'go', hang: true }])
  try {
    const t = h.d.ctx.threads.start({ title: 'stuck', prompt: 'go', cwd: h.repo, rung: PI, list: ['One thing'] })
    await waitFor(() => h.d.ctx.threads.get(t.id)?.turns.length, 5000, 'the turn to start')
    const gate = () => h.client.gate(t.id, 'Stop', {})
    assert.deepEqual([!!(await gate()), !!(await gate()), !!(await gate()), await gate()], [true, true, true, null])
    assert.equal(await h.client.gate(t.id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: 'x' } }), null, 'reads never wait')
    assert.match(await h.client.gate(t.id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rm x' } }) ?? '', /^Nothing on your work list is in progress, so clyde blocked this Bash call\./)
    await assert.rejects(h.client.todo(`thread:${t.id}`, 'start', { n: 999, how: 'try missing item' }))
    assert.equal(await h.client.gate(t.id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'clyde todo start 1 --how "Complete item 1"' } }), null, 'failed todo calls leave the recovery command open')
    assert.ok(await h.client.gate(t.id, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'clyde todo start 1 --how "Complete item 1" && touch x' } }), 'recovery never opens a compound file write')
    h.d.ctx.threads.lists.start(`thread:${t.id}`, 1, 'do it')
    assert.equal(await h.client.gate(t.id, 'PreToolUse', { tool_name: 'Edit', tool_input: {} }), null, 'an item in progress lets edits through')
    h.d.ctx.threads.stop(t.id)
    await h.d.ctx.threads.waitIdle(t.id)
    h.d.ctx.threads.threads.get(t.id)!.stopBlocks = 0
    h.d.ctx.threads.threads.get(t.id)!.resultAt = new Date(Date.now() + 1000).toISOString()
    assert.equal(await gate(), null, 'a posted result lets it stop')
    const judge = h.d.ctx.threads.start({ title: 'judge', prompt: 'judge', cwd: h.repo, rung: PI, readOnly: true, schema: {}, list: ['x'] })
    assert.equal(await h.client.gate(judge.id, 'PreToolUse', { tool_name: 'Write', tool_input: {} }), null, 'read-only threads have no list rules')
  } finally {
    await h.d.close()
  }
})

test('a worker that stops with open items and no result is nudged, and the nudge gets it to finish', async () => {
  const h = await daemon([
    { match: 'fix it', reply: 'I looked around.' },
    { match: 'open items', todo: [['done', '1', '--evidence', 'parser.ts:12'], ['done', '2', '--evidence', 'below']], clydeResult: { status: 'done', summary: 'parser fixed' }, reply: 'Reported.' },
  ])
  try {
    const t = h.d.ctx.threads.start({ title: 'nudged', prompt: 'fix it', cwd: h.repo, rung: PI, list: ['Fix the parser', 'Report with clyde result'] })
    const done = await h.d.ctx.threads.waitIdle(t.id)
    assert.deepEqual(done.turns.map((x) => [x.prompt, x.text]), [
      ['fix it', 'I looked around.'],
      ['Your list has 2 open items. Continue with the next one, or block it with why.', 'Reported.'],
    ])
    assert.deepEqual(types(h.d, t.id), ['thread.started', 'list.updated', 'thread.nudged', 'list.updated', 'list.updated', 'thread.done'])
    const nudged = h.d.ctx.events.since(0).find((e) => e.type === 'thread.nudged')
    assert.equal(nudged?.summary, `Thread ${t.id} "nudged" stopped with 2 open items, so clyde sent it back (1 of 3).`)
    assert.deepEqual(h.d.ctx.threads.result(t.id), { status: 'done', summary: 'parser fixed' })
  } finally {
    await h.d.close()
  }
})

test('the daemon nudges every backend at most 3 times in a row, and a message from outside resets the count', async () => {
  const h = await daemon([])
  try {
    for (const backend of ['codex', 'claude'] as const) {
      const t = h.d.ctx.threads.start({ title: backend, prompt: 'start', cwd: h.repo, rung: { backend }, list: ['Never done'] })
      let done = await h.d.ctx.threads.waitIdle(t.id)
      assert.equal(done.turns.length, 4, `${backend}: the turn and 3 nudges`)
      assert.deepEqual(types(h.d, t.id).filter((x) => x.startsWith('thread.')), ['thread.started', 'thread.nudged', 'thread.nudged', 'thread.nudged', 'thread.done'])
      h.d.ctx.threads.send(t.id, 'try again')
      done = await h.d.ctx.threads.waitIdle(t.id)
      assert.equal(done.turns.length, 8, `${backend}: a new message gets 3 nudges of its own`)
    }
  } finally {
    await h.d.close()
  }
})

test("the point man's list tracks threads and flows it starts, and closes each when it ends", async () => {
  const s = await flowSetup('task-rung1')
  const { d, client } = await flowDaemon()
  try {
    const ok: Thread = await client.startThread({ title: 'count files', prompt: 'count the files', cwd: s.repo, rung: PI, track: 'pointman' })
    await d.ctx.threads.waitIdle(ok.id)
    const run: Run = await client.startRun('task', { prompt: 'Write hello.txt holding hello.', criteria: ['A hello file.'] }, s.repo, 'pointman')
    await waitStatus(client, run.id, ['done', 'failed', 'stopped'])
    const list = await client.list('pointman')
    assert.deepEqual(list.items.map((i: any) => [i.id, i.text, i.status, i.threadId ?? i.runId]), [
      [1, `Thread ${ok.id}: count files`, 'done', ok.id],
      [2, `Run ${run.id} (task): Write hello.txt holding hello.`, 'done', run.id],
    ])
    assert.equal((list.items[0] as any).evidence, 'turn 1: count the files')
    assert.equal((list.items[1] as any).evidence, `Run ${run.id} is done on branch clyde/${run.id}.`)
    assert.equal((await client.startThread({ prompt: 'x', cwd: s.repo, rung: PI, track: 'someone' }).catch((e) => e.status)), 400)
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test("a failed or stopped thread blocks its item on the point man's list", async () => {
  const h = await daemon([{ match: 'crash', crash: true }, { match: 'hang', hang: true }])
  try {
    const failing = await h.client.startThread({ title: 'broken', prompt: 'crash please', cwd: h.repo, rung: PI, track: 'pointman' })
    await h.d.ctx.threads.waitIdle(failing.id)
    const hanging = await h.client.startThread({ title: 'slow', prompt: 'hang please', cwd: h.repo, rung: PI, track: 'pointman' })
    await waitFor(() => h.d.ctx.threads.get(hanging.id)?.turns.length, 5000, 'the turn to start')
    await h.client.stop(hanging.id)
    const list = await h.client.list('pointman')
    assert.deepEqual(list.items.map((i: any) => [i.status, i.why]), [
      ['blocked', 'The thread failed: pi exited with code 1: fake pi crashed'], ['blocked', 'The thread was stopped.'],
    ])
    assert.match(list.text, /^Work list, point man: 0 done, 0 doing, 0 todo, 2 blocked\n/)
  } finally {
    await h.d.close()
  }
})

test('a flow stage seeds its worker list from the gate, and the judge never sees the list', async () => {
  const s = await flowSetup('task-rung1')
  const { d, client } = await flowDaemon()
  try {
    const input = { prompt: 'Write hello.txt holding hello.', criteria: ['A hello file. hello.txt holds hello.'], checks: ['test -f hello.txt'] }
    const started: Run = await client.call('POST', '/runs', { flow: 'task', input, cwd: s.repo })
    const run = await waitStatus(client, started.id, ['done', 'failed', 'stopped'])
    assert.equal(run.status, 'done', run.error)
    const a = run.stages[0].attempts[0]
    const list: WorkList = JSON.parse(readFileSync(join(s.home, 'lists', `thread:${a.threadId}.json`), 'utf8'))
    assert.deepEqual(list.items.map((i) => [i.text, i.status]), [[input.criteria[0], 'todo'], [REPORT_ITEM, 'todo']])
    const workerPrompt = argvLog(s.state).find((c) => c.bin === 'pi')?.argv.at(-1) as string
    assert.match(workerPrompt, new RegExp(`^Work list, thread ${a.threadId}: 0 done, 0 doing, 2 todo\\n\\[ \\] 1 A hello file\\. hello\\.txt holds hello\\.\\n`))
    const judge: Thread = JSON.parse(readFileSync(join(s.home, 'threads', `${a.judgeId}.json`), 'utf8'))
    assert.doesNotMatch(judge.turns[0].prompt, /Work list|Report with clyde result/)
    assert.equal(existsSync(join(s.home, 'lists', `thread:${a.judgeId}.json`)), false, 'the judge has no list')
    // The worker's list still went to memory, as a draft the next stage can recall.
    const entry = [...s.memory.entries.values()].find((e) => e.title === 'Work list, task')
    assert.deepEqual([entry?.authority, entry?.scope, entry?.pattern], ['draft', `run:${run.id}`, 'observations'])
  } finally {
    await d.close()
    await s.memory.close()
  }
})

test('a changed run-thread list goes to memory at each turn end, superseding the last version, and an unchanged one does not', async () => {
  const memory: FakeMemory = await startFakeMemory()
  const h = await daemon([
    { match: 'build it', todo: [['start', '1', '--how', 'write the module']], reply: 'Started.' },
    { match: 'open items', todo: [['done', '1', '--evidence', 'src/a.ts:1'], ['done', '2', '--evidence', 'below']], clydeResult: { status: 'done', summary: 'built' }, reply: 'Done.' },
    { match: 'anything else', reply: 'No.' },
  ], { MEMORY_URL: memory.url, MEMORY_TOKEN: memory.token, MEMORY_RUNTIME_TOKEN: memory.runtimeToken })
  try {
    await new Memory(memory.url, memory.runtimeToken).remember({
      id: 'run-r1', pattern: 'projects', title: 'Run r1', body: 'A test run.', authority: 'observed', scope: 'run:r1',
      evidence_kind: 'summary', evidence: 'The test made it.', source: { kind: 'run', title: 'clyde run r1' },
    })
    const t = h.d.ctx.threads.start({ title: 'w', prompt: 'build it', cwd: h.repo, rung: PI, runId: 'r1', stage: 'build', list: ['Build the module', 'Report with clyde result'] })
    await h.d.ctx.threads.waitIdle(t.id)
    h.d.ctx.threads.send(t.id, 'anything else')
    await h.d.ctx.threads.waitIdle(t.id)
    const writes = () => memory.calls.filter((c) => c.path === '/entries' && (c.body as any)?.title === 'Work list, build')
    await waitFor(() => writes().length >= 2, 5000, 'two memory writes')
    await h.d.close()
    assert.equal(writes().length, 2, 'the third turn changed nothing, so nothing new went to memory')
    const versions = [...memory.entries.values()].filter((e) => e.title === 'Work list, build')
    const first = versions.find((e) => !e.supersedes)!
    const second = versions.find((e) => e.supersedes)!
    assert.ok(writes().every((c) => c.role === 'runtime' && c.status === 200))
    assert.deepEqual([first.authority, first.scope, first.project, first.supersedes], ['draft', 'run:r1', 'run-r1', undefined])
    assert.deepEqual(second.supersedes, [first.id])
    assert.match(first.evidence, /\[>\] 1 Build the module\. How: write the module/)
    assert.match(second.evidence, /^Work list, thread t-[0-9a-f]+: 2 done, 0 doing, 0 todo\n/)
    const blob = JSON.parse(memory.blobs.get(second.blobShas[0].sha256)?.text ?? '{}')
    assert.deepEqual(blob.items.map((i: any) => i.status), ['done', 'done'])
    const recalled = await new Memory(memory.url, memory.token).recall('work list build', 'run:r1')
    assert.ok(recalled.includes(second.id) && !recalled.includes(first.id), recalled)
  } finally {
    await h.d.close()
    await memory.close()
  }
})

test('clyde todo needs a daemon, and the CLI lists todo in clyde help', async () => {
  setup([])
  const r = await clyde(['todo'], { CLYDE_THREAD_ID: 't-1' })
  assert.deepEqual([r.code, r.stderr], [1, 'clyde todo: the clyde daemon is not running.\n'])
  const help = await clyde(['help'])
  assert.match(help.stdout, /^ {2}todo +Read or change this thread's work list/m)
})
