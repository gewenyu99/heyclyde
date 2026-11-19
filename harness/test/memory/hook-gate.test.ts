/**
 * R78 (like-vincent #83): the gate in clyde-hook.sh makes Clyde mandatory. An app that hasn't registered owes a register_agent,
 * a new task owes a recall, and while either is owed every other tool is refused (ToolSearch stays open, to load the tool).
 * A debt expires after 20 minutes. Writes to the app's own memory files are always refused. No token and no network here:
 * the gate is local, so it works for OAuth-only setups and through an outage.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { tempDir } from '../helpers.ts'
import { CLYDE_HOOK_SH } from '../../../memory/proxy/hook.js'

const dirs: string[] = []
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })

function env() {
  const dir = tempDir('clyde-gate-')
  dirs.push(dir)
  const script = join(dir, 'clyde-hook.sh')
  writeFileSync(script, CLYDE_HOOK_SH)
  chmodSync(script, 0o700)
  const run = (client: string, event: string, payload: unknown, now = 1_800_000_000) => {
    const r = spawnSync(script, [client, event], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, CLYDE_CONFIG_DIR: join(dir, 'cfg'), CLYDE_HOOK_STATE_DIR: join(dir, 'state'), CLYDE_HOOK_NOW: String(now), CLYDE_PASEO_AGENT: '', MEMORY_TOKEN: '', MEMORY_URL: '' },
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  /** The decision a PreToolUse (or Gemini BeforeTool) call comes back with: deny or allow. */
  const decide = (client: string, tool: string, input: Record<string, unknown> = {}, sid = 's1', now?: number) => {
    const out = run(client, client === 'gemini' ? 'BeforeTool' : 'PreToolUse', { session_id: sid, tool_name: tool, tool_input: input }, now)
    if (!out) return 'allow'
    const d = JSON.parse(out)
    return d.hookSpecificOutput?.permissionDecision ?? d.decision ?? 'allow'
  }
  return { run, decide }
}

const T0 = 1_800_000_000

test('R78 an unregistered app registers before anything else', () => {
  const g = env()
  const start = g.run('claude', 'SessionStart', { session_id: 's1' }, T0)
  assert.match(start, /register_agent \(name, context, surface, description, computer, type, projects\) before anything else/)
  assert.match(start, /only memory/)
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 1), 'deny')
  assert.equal(g.decide('claude', 'ToolSearch', {}, 's1', T0 + 2), 'allow')
  assert.equal(g.decide('claude', 'mcp__claude_ai_Clyde__register_agent', {}, 's1', T0 + 3), 'allow')
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 4), 'allow')
  // Registered once, the app's next session isn't asked again.
  assert.doesNotMatch(g.run('claude', 'SessionStart', { session_id: 's2' }, T0 + 5), /not registered/)
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's2', T0 + 6), 'allow')
})

test('R78 a new task is blocked before recall and allowed after', () => {
  const g = env()
  g.decide('claude', 'mcp__clyde__register_agent', {}, 's0', T0)
  const nudge = g.run('claude', 'UserPromptSubmit', { session_id: 's1', prompt: 'plan the billing webhook retry work for stripe' }, T0)
  assert.match(nudge, /recall comes first/)
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 1), 'deny')
  assert.equal(g.decide('claude', 'Read', { file_path: '/tmp/x' }, 's1', T0 + 2), 'deny')
  assert.equal(g.decide('claude', 'ToolSearch', {}, 's1', T0 + 3), 'allow')
  assert.equal(g.decide('claude', 'mcp__clyde__recall', { query: 'billing webhook' }, 's1', T0 + 4), 'allow')
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 5), 'allow')
  // A quick follow-up owes no recall, only the save reminder.
  assert.doesNotMatch(g.run('claude', 'UserPromptSubmit', { session_id: 's1', prompt: 'push it' }, T0 + 60), /recall/)
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 61), 'allow')
  // The same gate holds in Codex and Gemini CLI, each in its own output.
  g.run('codex', 'UserPromptSubmit', { session_id: 'c1', prompt: 'migrate the invoices table to the new schema today' }, T0)
  assert.equal(g.decide('codex', 'Bash', { command: ['bash', '-lc', 'ls'] }, 'c1', T0 + 1), 'deny')
  assert.equal(g.decide('codex', 'mcp__clyde__recall', {}, 'c1', T0 + 2), 'allow')
  assert.equal(g.decide('codex', 'Bash', { command: ['bash', '-lc', 'ls'] }, 'c1', T0 + 3), 'allow')
  g.run('gemini', 'BeforeAgent', { session_id: 'g1', prompt: 'migrate the invoices table to the new schema today' }, T0)
  assert.deepEqual(JSON.parse(g.run('gemini', 'BeforeTool', { session_id: 'g1', tool_name: 'run_shell_command', tool_input: { command: 'ls' } }, T0 + 1)).decision, 'deny')
  assert.equal(g.decide('gemini', 'mcp_clyde_recall', {}, 'g1', T0 + 2), 'allow')
  assert.equal(g.decide('gemini', 'run_shell_command', { command: 'ls' }, 'g1', T0 + 3), 'allow')
})

test('R78 a debt expires after 20 minutes', () => {
  const g = env()
  g.decide('claude', 'mcp__clyde__register_agent', {}, 's0', T0)
  g.run('claude', 'UserPromptSubmit', { session_id: 's1', prompt: 'plan the billing webhook retry work for stripe' }, T0)
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 1200), 'deny')
  assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 1201), 'allow')
  // And a registration debt the same way.
  const h = env()
  h.run('claude', 'SessionStart', { session_id: 'r1' }, T0)
  assert.equal(h.decide('claude', 'Bash', { command: 'ls' }, 'r1', T0 + 1201), 'allow')
})

test("R78 writes to the app's own memory files are always refused", () => {
  const g = env()
  g.decide('claude', 'mcp__clyde__register_agent', {}, 's0', T0)
  const home = '/Users/someone'
  const memFile = `${home}/.claude/projects/-Users-someone-repo/memory/notes.md`
  assert.equal(g.decide('claude', 'Write', { file_path: memFile, content: 'x' }), 'deny')
  assert.equal(g.decide('claude', 'Edit', { file_path: `${home}/.claude/memory/x.md`, old_string: 'a', new_string: 'b' }), 'deny')
  assert.equal(g.decide('claude', 'Bash', { command: `echo hi >> ${home}/repo/${'MEMORY'}.md` }), 'deny')
  assert.equal(g.decide('codex', 'apply_patch', { input: `*** Begin Patch\n*** Add File: ${home}/.codex/memories/x.md\n+hi\n*** End Patch` }), 'deny')
  assert.equal(g.decide('codex', 'Bash', { command: ['bash', '-lc', `cat > ${home}/.codex/memories_v2/a.json`] }), 'deny')
  assert.equal(g.decide('gemini', 'save_memory', { fact: 'x' }), 'deny')
  assert.equal(g.decide('antigravity', 'write_to_file', { TargetFile: `${home}/.gemini/antigravity/knowledge/k.md`, CodeContent: 'x' }), 'deny')
  // Content that only mentions memory, and ordinary files, pass.
  assert.equal(g.decide('claude', 'Write', { file_path: `${home}/repo/notes.md`, content: 'see .claude/projects/x/memory/ for nothing' }), 'allow')
  assert.equal(g.decide('claude', 'Edit', { file_path: `${home}/repo/src/memory/store.ts`, old_string: 'a', new_string: 'b' }), 'allow')
  assert.equal(JSON.parse(g.run('antigravity', 'PreToolUse', { conversationId: 'a1', toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } })).decision, 'allow')
})

test('R78 the gate answers in under 300 ms', () => {
  const g = env()
  g.decide('claude', 'mcp__clyde__register_agent', {}, 's0', T0)
  g.run('claude', 'UserPromptSubmit', { session_id: 's1', prompt: 'plan the billing webhook retry work for stripe' }, T0)
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    assert.equal(g.decide('claude', 'Bash', { command: 'ls' }, 's1', T0 + 10), 'deny')
    times.push(performance.now() - t)
  }
  times.sort((a, b) => a - b)
  const median = (times[9] + times[10]) / 2
  assert.ok(median <= 300, `median ${median.toFixed(0)} ms`)
})

test("Antigravity's recall through call_mcp_tool pays the debt; other tools wait for it", () => {
  const g = env()
  g.decide('antigravity', 'call_mcp_tool', { ServerName: 'clyde', ToolName: 'register_agent' }, 'a0', T0)
  g.run('antigravity', 'PreInvocation', { conversationId: 'a1', lastUserInput: 'migrate the invoices table to the new schema today' }, T0)
  assert.equal(g.decide('antigravity', 'run_command', { CommandLine: 'ls' }, 'a1', T0 + 1), 'deny')
  assert.equal(g.decide('antigravity', 'call_mcp_tool', { ServerName: 'clyde', ToolName: 'list_quests' }, 'a1', T0 + 2), 'deny')
  assert.equal(g.decide('antigravity', 'call_mcp_tool', { ServerName: 'clyde', ToolName: 'recall', Arguments: { query: 'invoices schema' } }, 'a1', T0 + 3), 'allow')
  assert.equal(g.decide('antigravity', 'run_command', { CommandLine: 'ls' }, 'a1', T0 + 4), 'allow')
})

test('Clyde down: nothing is owed or blocked, and the agent hears Clyde is busy', () => {
  const dir = tempDir('clyde-down-')
  dirs.push(dir)
  const script = join(dir, 'clyde-hook.sh')
  writeFileSync(script, CLYDE_HOOK_SH)
  chmodSync(script, 0o700)
  // A token and a server that refuses every connection: the hook's call to Clyde fails at once.
  const run = (event: string, payload: unknown, now: number) => {
    const r = spawnSync(script, ['claude', event], {
      input: JSON.stringify(payload), encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, CLYDE_CONFIG_DIR: join(dir, 'cfg'), CLYDE_HOOK_STATE_DIR: join(dir, 'state'), CLYDE_HOOK_NOW: String(now), MEMORY_TOKEN: 'tok', MEMORY_URL: 'http://127.0.0.1:9' },
    })
    assert.equal(r.status, 0, r.stderr)
    return r.stdout.trim()
  }
  const start = run('SessionStart', { session_id: 'd1' }, T0)
  assert.match(start, /busy right now/)
  assert.match(start, /support@heyclyde\.me/)
  assert.doesNotMatch(start, /refused/)
  const nudge = run('UserPromptSubmit', { session_id: 'd1', prompt: 'plan the billing webhook retry work for stripe' }, T0 + 1)
  assert.match(nudge, /busy right now/)
  assert.doesNotMatch(nudge, /refused/)
  assert.equal(run('PreToolUse', { session_id: 'd1', tool_name: 'Bash', tool_input: { command: 'ls' } }, T0 + 2), '')
})
