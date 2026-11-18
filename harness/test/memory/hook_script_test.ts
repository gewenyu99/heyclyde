/**
 * End-to-end execution tests for CLYDE_HOOK_SH (served at https://heyclyde.me/clyde-hook.sh and rendered on /docs).
 * Verifies Antigravity, Claude Code, Codex, and Gemini CLI hook contracts, mid-turn PreInvocation deduplication,
 * invoke_subagent suppression, task-shift gating, and optional device-token forwarding (full + metadata modes).
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ANTIGRAVITY_HOOKS_JSON, CLAUDE_HOOKS_JSON, CLYDE_HOOK_SH, CLYDE_VERIFY_SH, CODEX_HOOKS_JSON, GEMINI_HOOKS_JSON } from '../../../memory/proxy/hook.js'

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'clyde-hook-test-'))
  const script = join(dir, 'clyde-hook.sh')
  writeFileSync(script, CLYDE_HOOK_SH, 'utf8')
  chmodSync(script, 0o700)
  return {
    dir,
    script,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    run(client: string, event: string, payload: unknown, now = 1_700_000_000, extraEnv: Record<string, string> = {}) {
      const res = spawnSync(script, [client, event], {
        input: typeof payload === 'string' ? payload : JSON.stringify(payload),
        encoding: 'utf8',
        env: {
          ...process.env,
          CLYDE_CONFIG_DIR: join(dir, 'cfg'),
          CLYDE_HOOK_STATE_DIR: join(dir, 'state'),
          CLYDE_HOOK_NOW: String(now),
          MEMORY_TOKEN: '',
          MEMORY_URL: '',
          ...extraEnv,
        },
      })
      assert.equal(res.status, 0, `${client} ${event} exited ${res.status}: ${res.stderr}`)
      return res.stdout
    },
  }
}

Deno.test('hook JSON configs parse cleanly and match each client schema', () => {
  for (const [config, field] of [[CODEX_HOOKS_JSON, 'statusMessage'], [CLAUDE_HOOKS_JSON, 'statusMessage'], [GEMINI_HOOKS_JSON, 'name']]) {
    const groups = Object.values(JSON.parse(config).hooks).flat() as { hooks: Record<string, string>[] }[]
    const labels = groups.flatMap(group => group.hooks.map(handler => handler[field]))
    assert.ok(labels.every(label => label && label.includes('Clyde')))
    assert.equal(new Set(labels).size, labels.length)
  }
  assert.ok(Object.keys(JSON.parse(ANTIGRAVITY_HOOKS_JSON)).every(label => label.includes('Clyde')))
  const agy = Object.assign({}, ...Object.values(JSON.parse(ANTIGRAVITY_HOOKS_JSON)))
  assert.ok(Array.isArray(agy.SessionStart) && agy.SessionStart[0].command.includes('antigravity SessionStart'))
  assert.ok(Array.isArray(agy.PreInvocation) && !('hooks' in agy.PreInvocation[0]), 'Antigravity PreInvocation uses flat handler array')
  assert.equal(agy.PreToolUse[0].matcher, 'invoke_subagent')
  assert.match(agy.PostToolUse[0].matcher, /clyde/)
  assert.ok(Array.isArray(agy.Stop) && !('hooks' in agy.Stop[0]), 'Antigravity Stop uses flat handler array')

  const claude = JSON.parse(CLAUDE_HOOKS_JSON)
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact', 'SessionEnd']) {
    assert.ok(Array.isArray(claude.hooks[ev]), `Claude ${ev}`)
  }

  const codex = JSON.parse(CODEX_HOOKS_JSON)
  assert.equal(codex.hooks.SessionStart[0].matcher, 'startup|resume')
  assert.ok(Array.isArray(codex.hooks.UserPromptSubmit))
  assert.ok(Array.isArray(codex.hooks.Stop))

  const gemini = JSON.parse(GEMINI_HOOKS_JSON)
  for (const ev of ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent']) {
    assert.ok(Array.isArray(gemini.hooks[ev]), `Gemini ${ev}`)
  }
})

Deno.test('Antigravity lifecycle: deduplicates mid-turn PreInvocation, skips follow-ups and subagents, nudges shifts', () => {
  const h = makeEnv()
  try {
    // 1. SessionStart (before first prompt) injects session-start reminder once.
    const s0 = JSON.parse(h.run('antigravity', 'SessionStart', {
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
    }, 1000))
    assert.equal(s0.injectSteps?.length, 1)
    assert.match(s0.injectSteps[0].ephemeralMessage, /register_agent/)

    // 2. First PreInvocation (invocationNum 0) on a real task nudges recall.
    const p0 = JSON.parse(h.run('antigravity', 'PreInvocation', {
      invocationNum: 0,
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
      lastUserInput: 'Refactor the Polar webhook signature check',
    }, 1001))
    assert.equal(p0.injectSteps?.length, 1)
    assert.match(p0.injectSteps[0].ephemeralMessage, /recall/)

    // 3. Mid-turn PreInvocation (invocationNum 1..5 after tool calls) with SAME lastUserInput stays silent ({})!
    for (let step = 1; step <= 3; step++) {
      const mid = JSON.parse(h.run('antigravity', 'PreInvocation', {
        invocationNum: step,
        conversationId: 'conv-1',
        workspacePaths: ['/work/billing'],
        lastUserInput: 'Refactor the Polar webhook signature check',
      }, 1002 + step))
      assert.deepEqual(mid, {}, `mid-turn step ${step} must return empty {}`)
    }

    // 4. PostToolUse for recall records task tokens and returns {}.
    const post = JSON.parse(h.run('antigravity', 'PostToolUse', {
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
      toolCall: { name: 'mcp_memory_recall', args: { query: 'Polar webhook signature' } },
    }, 1010))
    assert.deepEqual(post, {})

    // 5. A turn that ended without remember gets one check; Antigravity hides the earlier text, so it replies again.
    const stop = JSON.parse(h.run('antigravity', 'Stop', {
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
      fullyIdle: true,
    }, 1020))
    assert.equal(stop.decision, 'continue')
    assert.match(stop.reason, /without Clyde remember.*write your reply again/)

    // 6. Quick follow-ups ("push it", "fix line 12 and show me a screenshot") skip recall but get the save reminder.
    for (const [i, follow] of ['push it', 'fix line 12 and show me a screenshot'].entries()) {
      const out = JSON.parse(h.run('antigravity', 'PreInvocation', {
        invocationNum: 4 + i,
        conversationId: 'conv-1',
        workspacePaths: ['/work/billing'],
        lastUserInput: follow,
      }, 1150 + i * 40))
      const msg = out.injectSteps?.[0]?.ephemeralMessage ?? ''
      assert.doesNotMatch(msg, /recall/, `follow-up "${follow}" must not ask for recall`)
      assert.match(msg, /final reply.*remember/, `follow-up "${follow}" gets the save reminder`)
    }

    // 6b. R78: the session started unregistered, so the gate holds every tool until register_agent runs.
    const gated = JSON.parse(h.run('antigravity', 'PreToolUse', { conversationId: 'conv-1', toolCall: { name: 'run_command', args: { CommandLine: 'ls' } } }, 1290))
    assert.equal(gated.decision, 'deny')
    const reg = JSON.parse(h.run('antigravity', 'PreToolUse', { conversationId: 'conv-1', toolCall: { name: 'mcp_clyde_register_agent', args: {} } }, 1291))
    assert.deepEqual(reg, { decision: 'allow' })

    // 7. Spawning a subagent via invoke_subagent suppresses both SessionStart and PreInvocation inside the subagent!
    const preSub = JSON.parse(h.run('antigravity', 'PreToolUse', {
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
      toolCall: {
        name: 'invoke_subagent',
        args: { Subagents: [{ Role: 'SVG Auditor', TypeName: 'research', Prompt: 'Audit every SVG viewBox in site.js' }] },
      },
    }, 1300))
    assert.deepEqual(preSub, { decision: 'allow' })

    const subStart = JSON.parse(h.run('antigravity', 'SessionStart', {
      conversationId: 'sub-conv-99',
      workspacePaths: ['/work/billing'],
    }, 1301))
    assert.deepEqual(subStart, {}, 'subagent SessionStart right after invoke_subagent stays silent')

    const subInv = JSON.parse(h.run('antigravity', 'PreInvocation', {
      invocationNum: 0,
      conversationId: 'sub-conv-99',
      workspacePaths: ['/work/billing'],
      lastUserInput: 'Audit every SVG viewBox in site.js',
    }, 1302))
    assert.deepEqual(subInv, {}, 'subagent PreInvocation stays silent')

    // 8. Unrelated new topic in the parent session nudges recall again!
    const newGoal = JSON.parse(h.run('antigravity', 'PreInvocation', {
      invocationNum: 10,
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
      lastUserInput: 'Design an animated carousel layout for customer testimonials on mobile screens',
    }, 1400))
    assert.equal(newGoal.injectSteps?.length, 1)
    assert.match(newGoal.injectSteps[0].ephemeralMessage, /recall/)

    // 9. Workspace folder switch nudges recall even on a short prompt!
    const folderShift = JSON.parse(h.run('antigravity', 'PreInvocation', {
      invocationNum: 11,
      conversationId: 'conv-1',
      workspacePaths: ['/work/other-repo'],
      lastUserInput: 'run the tests',
    }, 1410))
    assert.equal(folderShift.injectSteps?.length, 1)
    assert.match(folderShift.injectSteps[0].ephemeralMessage, /recall/)
  } finally {
    h.cleanup()
  }
})

Deno.test('Claude Code, Codex, and Gemini CLI output contracts', () => {
  const h = makeEnv()
  try {
    // Claude Code: plain text on SessionStart / task-shift UserPromptSubmit, only the save reminder on follow-ups.
    assert.match(h.run('claude', 'SessionStart', { session_id: 'c1', cwd: '/repo' }, 100), /register_agent/)
    assert.match(h.run('claude', 'UserPromptSubmit', { session_id: 'c1', cwd: '/repo', prompt: 'Add OAuth callback validation' }, 105), /recall/)
    assert.equal(h.run('claude', 'PostToolUse', { session_id: 'c1', cwd: '/repo', tool_name: 'mcp__clyde__recall', tool_input: { query: 'OAuth callback' } }, 110), '')
    const shipIt = h.run('claude', 'UserPromptSubmit', { session_id: 'c1', cwd: '/repo', prompt: 'ship it' }, 150)
    assert.doesNotMatch(shipIt, /recall/)
    assert.match(shipIt, /final reply.*remember/)
    const cstop = JSON.parse(h.run('claude', 'Stop', { session_id: 'c1', cwd: '/repo' }, 160))
    assert.equal(cstop.decision, 'block')
    assert.match(cstop.reason, /do not repeat or summarize it/)

    // Codex: plain text on SessionStart / task-shift UserPromptSubmit, JSON on Stop.
    assert.match(h.run('codex', 'SessionStart', { session_id: 'x1', cwd: '/repo' }, 200), /register_agent/)
    assert.match(h.run('codex', 'UserPromptSubmit', { session_id: 'x1', cwd: '/repo', prompt: 'Set up nightly Postgres backups' }, 205), /recall/)
    assert.doesNotMatch(h.run('codex', 'UserPromptSubmit', { session_id: 'x1', cwd: '/repo', prompt: 'looks good' }, 240), /recall/)
    assert.equal(JSON.parse(h.run('codex', 'Stop', { session_id: 'x1', cwd: '/repo' }, 250)).decision, 'block')

    // Gemini CLI: mandatory JSON with hookSpecificOutput.additionalContext on nudges, {} when silent.
    const gs = JSON.parse(h.run('gemini', 'SessionStart', { session_id: 'g1', cwd: '/repo' }, 300))
    assert.equal(gs.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(gs.hookSpecificOutput.additionalContext, /register_agent/)
    const gb1 = JSON.parse(h.run('gemini', 'BeforeAgent', { session_id: 'g1', cwd: '/repo', prompt: 'Configure Cloudflare Worker CSP headers' }, 305))
    assert.equal(gb1.hookSpecificOutput.hookEventName, 'BeforeAgent')
    assert.match(gb1.hookSpecificOutput.additionalContext, /recall/)
    assert.deepEqual(JSON.parse(h.run('gemini', 'AfterTool', { session_id: 'g1', cwd: '/repo', tool_name: 'mcp_clyde_recall', tool_input: { query: 'CSP headers' } }, 310)), {})
    assert.doesNotMatch(h.run('gemini', 'BeforeAgent', { session_id: 'g1', cwd: '/repo', prompt: 'push it' }, 350), /recall/)
    assert.equal(JSON.parse(h.run('gemini', 'AfterAgent', { session_id: 'g1', cwd: '/repo', prompt_response: 'Done.' }, 360)).decision, 'deny')
  } finally {
    h.cleanup()
  }
})

Deno.test('changed scope after recall, a save reminder on every prompt, and one Stop check when remember was skipped', () => {
  const h = makeEnv()
  try {
    for (const [client, submit, post, stop] of [
      ['claude', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
      ['codex', 'UserPromptSubmit', 'PostToolUse', 'Stop'],
      ['gemini', 'BeforeAgent', 'AfterTool', 'AfterAgent'],
      ['antigravity', 'PreInvocation', 'PostToolUse', 'Stop'],
    ]) {
      const call = (event: string, data: Record<string, unknown>) =>
        h.run(client, event, { session_id: 'scope', ...data })
      call(submit, { prompt: 'Document webhook retries' })
      call(post, { tool_name: 'mcp__clyde__recall' })
      assert.match(call(submit, { prompt: 'Also log headers' }), /scope.*information.*final reply.*remember/s)
      assert.match(call(submit, { prompt: 'Switch to billing' }), /recall comes first.*final reply.*remember/s)
      call(post, { tool_name: 'mcp__clyde__recall' })
      const reminder = JSON.parse(call(stop, {}))
      assert.match(reminder.reason, /without Clyde remember/)
      call(submit, { prompt: reminder.reason })
      assert.doesNotMatch(call(stop, {}), /remember/)
      assert.match(call(submit, { prompt: 'push it' }), /final reply.*remember/s)
      call(post, { tool_name: 'mcp__clyde__remember', tool_response: { isError: true } })
      assert.match(call(stop, {}), /without Clyde remember/)
      call(submit, { prompt: 'commit it' })
      call(post, { tool_name: 'mcp__clyde__remember' })
      assert.doesNotMatch(call(stop, {}), /remember/)
    }
  } finally {
    h.cleanup()
  }
})

Deno.test('device token forwarding supports full and metadata modes without duplicating nudges', async () => {
  const h = makeEnv()
  const received: { url: string; auth: string; body: Record<string, unknown> }[] = []
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      received.push({
        url: req.url || '',
        auth: String(req.headers.authorization || ''),
        body: raw ? JSON.parse(raw) : {},
      })
      if (req.url?.startsWith('/hooks/UserPromptSubmit')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Clyde: server task-shift recall nudge.')
      } else if (req.url?.startsWith('/messages/')) {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('Unread quest Q-12: deploy proxy')
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('')
      }
    })
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as { port: number }).port
  const baseUrl = `http://127.0.0.1:${port}`
  try {
    // Metadata mode strips prompt text before sending to server, and server nudge deduplicates local nudge!
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(h.script, ['claude', 'UserPromptSubmit'], {
        env: {
          ...process.env,
          CLYDE_CONFIG_DIR: join(h.dir, 'cfg'),
          CLYDE_HOOK_STATE_DIR: join(h.dir, 'state'),
          CLYDE_HOOK_NOW: '500',
          MEMORY_TOKEN: 'tok-test',
          MEMORY_URL: baseUrl,
          MEMORY_HOOKS: 'metadata',
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`)))
      child.stdin.end(JSON.stringify({ session_id: 'm1', cwd: '/work/corp', prompt: 'Secret internal roadmap migration' }))
    })
    assert.equal(received.filter((r) => r.url === '/hooks/UserPromptSubmit?agent=claude').length, 1)
    const sentBody = received[0].body
    assert.equal(sentBody.session_id, 'm1')
    assert.equal(sentBody.cwd, '/work/corp')
    assert.equal('prompt' in sentBody, false, 'metadata mode never sends prompt text')
    assert.ok(out.includes('Clyde: server task-shift recall nudge.'))
    assert.ok(out.includes('Unread quest Q-12: deploy proxy'))
    assert.equal((out.match(/recall/g) ?? []).length, 1, 'server nudge and local nudge are deduplicated')
  } finally {
    srv.close()
    h.cleanup()
  }
})

Deno.test('CLYDE_VERIFY_SH runs initialize, register_agent, and remember with required MCP fields', async () => {
  const calls: { method: string; session: string; params: Record<string, unknown> }[] = []
  const srv = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      calls.push({
        method: rpc.method,
        session: String(req.headers['mcp-session-id'] || ''),
        params: rpc.params || {},
      })
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'sess-verify-1' })
      const name = rpc.params?.name
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: name === 'remember' ? { id: 'note-first-1' } : { ok: true },
      }))
    })
  })
  await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve))
  const port = (srv.address() as { port: number }).port
  try {
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn('sh', ['-c', CLYDE_VERIFY_SH], {
        env: {
          ...process.env,
          MEMORY_TOKEN: 'tok-verify',
          MEMORY_URL: `http://127.0.0.1:${port}`,
          NO_PROXY: '127.0.0.1,localhost',
          no_proxy: '127.0.0.1,localhost',
        },
      })
      let stdout = '', stderr = ''
      child.stdout.on('data', (d) => { stdout += d })
      child.stderr.on('data', (d) => { stderr += d })
      child.on('error', reject)
      child.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`exit ${code}: ${stderr}`)))
    })
    assert.deepEqual(calls.map((c) => c.method), ['initialize', 'tools/call', 'tools/call'])
    assert.equal(calls[1].session, 'sess-verify-1')
    assert.equal(calls[1].params.name, 'register_agent')
    const regArgs = calls[1].params.arguments as Record<string, unknown>
    for (const k of ['name', 'context', 'surface', 'description']) assert.ok(regArgs[k], `register_agent.${k}`)
    assert.equal(calls[2].params.name, 'remember')
    const remArgs = calls[2].params.arguments as Record<string, unknown>
    for (const k of ['pattern', 'title', 'body', 'evidence']) assert.ok(remArgs[k], `remember.${k}`)
    assert.ok(String(remArgs.body).length < 500, 'remember body under 500 chars')
    assert.ok(out.includes('note-first-1'), 'prints returned first note id')
  } finally {
    srv.close()
  }
})

