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
import { ANTIGRAVITY_HOOKS_JSON, CLAUDE_HOOKS_JSON, CLYDE_HOOK_SH, CODEX_HOOKS_JSON, GEMINI_HOOKS_JSON } from '../../../memory/proxy/hook.js'

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
  const agy = JSON.parse(ANTIGRAVITY_HOOKS_JSON)
  assert.ok(Array.isArray(agy.clyde.SessionStart) && agy.clyde.SessionStart[0].command.includes('antigravity SessionStart'))
  assert.ok(Array.isArray(agy.clyde.PreInvocation) && !('hooks' in agy.clyde.PreInvocation[0]), 'Antigravity PreInvocation uses flat handler array')
  assert.equal(agy.clyde.PreToolUse[0].matcher, 'invoke_subagent')
  assert.match(agy.clyde.PostToolUse[0].matcher, /clyde/)
  assert.ok(Array.isArray(agy.clyde.Stop) && !('hooks' in agy.clyde.Stop[0]), 'Antigravity Stop uses flat handler array')

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

    // 5. Stop returns {"decision":"allow"} per Antigravity contract.
    const stop = JSON.parse(h.run('antigravity', 'Stop', {
      conversationId: 'conv-1',
      workspacePaths: ['/work/billing'],
      fullyIdle: true,
    }, 1020))
    assert.deepEqual(stop, { decision: 'allow' })

    // 6. Quick follow-ups ("push it", "fix line 12 and show me a screenshot") stay silent!
    for (const [i, follow] of ['push it', 'fix line 12 and show me a screenshot', 'Also log bad webhook headers'].entries()) {
      const out = JSON.parse(h.run('antigravity', 'PreInvocation', {
        invocationNum: 4 + i,
        conversationId: 'conv-1',
        workspacePaths: ['/work/billing'],
        lastUserInput: follow,
      }, 1150 + i * 40))
      assert.deepEqual(out, {}, `follow-up "${follow}" must stay silent`)
    }

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
    // Claude Code: plain text on SessionStart / task-shift UserPromptSubmit, empty on follow-ups and Stop.
    assert.match(h.run('claude', 'SessionStart', { session_id: 'c1', cwd: '/repo' }, 100), /register_agent/)
    assert.match(h.run('claude', 'UserPromptSubmit', { session_id: 'c1', cwd: '/repo', prompt: 'Add OAuth callback validation' }, 105), /recall/)
    assert.equal(h.run('claude', 'PostToolUse', { session_id: 'c1', cwd: '/repo', tool_name: 'mcp__clyde__recall', tool_input: { query: 'OAuth callback' } }, 110), '')
    assert.equal(h.run('claude', 'UserPromptSubmit', { session_id: 'c1', cwd: '/repo', prompt: 'ship it' }, 150), '')
    assert.equal(h.run('claude', 'Stop', { session_id: 'c1', cwd: '/repo' }, 160), '')

    // Codex: plain text on SessionStart / task-shift UserPromptSubmit, {} JSON on Stop.
    assert.match(h.run('codex', 'SessionStart', { session_id: 'x1', cwd: '/repo' }, 200), /register_agent/)
    assert.match(h.run('codex', 'UserPromptSubmit', { session_id: 'x1', cwd: '/repo', prompt: 'Set up nightly Postgres backups' }, 205), /recall/)
    assert.equal(h.run('codex', 'UserPromptSubmit', { session_id: 'x1', cwd: '/repo', prompt: 'looks good' }, 240), '')
    assert.equal(h.run('codex', 'Stop', { session_id: 'x1', cwd: '/repo' }, 250).trim(), '{}')

    // Gemini CLI: mandatory JSON with hookSpecificOutput.additionalContext on nudges, {} when silent.
    const gs = JSON.parse(h.run('gemini', 'SessionStart', { session_id: 'g1', cwd: '/repo' }, 300))
    assert.equal(gs.hookSpecificOutput.hookEventName, 'SessionStart')
    assert.match(gs.hookSpecificOutput.additionalContext, /register_agent/)
    const gb1 = JSON.parse(h.run('gemini', 'BeforeAgent', { session_id: 'g1', cwd: '/repo', prompt: 'Configure Cloudflare Worker CSP headers' }, 305))
    assert.equal(gb1.hookSpecificOutput.hookEventName, 'BeforeAgent')
    assert.match(gb1.hookSpecificOutput.additionalContext, /recall/)
    assert.deepEqual(JSON.parse(h.run('gemini', 'AfterTool', { session_id: 'g1', cwd: '/repo', tool_name: 'mcp_clyde_recall', tool_input: { query: 'CSP headers' } }, 310)), {})
    assert.deepEqual(JSON.parse(h.run('gemini', 'BeforeAgent', { session_id: 'g1', cwd: '/repo', prompt: 'push it' }, 350)), {})
    assert.deepEqual(JSON.parse(h.run('gemini', 'AfterAgent', { session_id: 'g1', cwd: '/repo', prompt_response: 'Done.' }, 360)), {})
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
