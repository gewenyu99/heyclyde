/**
 * R78 (like-vincent #83): `curl -fsSL https://heyclyde.me/install | sh` is the whole setup. install.sh runs here by path from
 * the checkout, against an empty temp HOME and a small fake server, with no claude CLI (or a fake one), and must leave one
 * Clyde MCP server per app at https://heyclyde.me/mcp, clyde-hook.sh in every app's hooks, the app's own memory off, the
 * Clyde rule once per rule file, and nothing that a rerun would change. The fake answers hooks the way the function does,
 * with version.ts's own status and installer note, so a fresh install's hooks can be checked for the out-of-date line.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { tempDir } from '../helpers.ts'
import { CLIENT_VERSION, clientStatus, fromClydeHook, installerNote } from '../../../memory/supabase/functions/memory/version.ts'
import { CLAUDE_HOOKS_JSON, CLYDE_HOOK_SH, CLYDE_RULE, CODEX_HOOKS_JSON, GEMINI_HOOKS_JSON, ANTIGRAVITY_HOOKS_JSON } from '../../../memory/proxy/hook.js'

const CLIENT = join(repoRoot(), 'memory', 'supabase', 'functions', 'memory', 'client')
const INSTALL = join(CLIENT, 'install.sh')
const MCP = 'https://heyclyde.me/mcp'
const TOKEN = 'device-token-for-the-r78-test'
const homes: string[] = []
after(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }) })

type Fake = { url: string; hookLines: string[]; agents: string[]; close: () => Promise<void> }

/** /mcp, /healthz, /hooks and /messages, answered the way the function answers them. */
async function fakeServer(): Promise<Fake> {
  const fake = { hookLines: [], agents: [] } as unknown as Fake
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const sent = req.headers['x-memory-client-version'] as string | undefined
      res.setHeader('x-memory-client-latest', CLIENT_VERSION)
      if (sent) res.setHeader('x-memory-client-status', clientStatus(sent, 30))
      if (req.method === 'POST' && req.url === '/mcp') return res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      if (req.url === '/healthz') return res.end(JSON.stringify({ ok: true, version: '20261117.2', client_version: CLIENT_VERSION }))
      if (req.url?.startsWith('/hooks/') || req.url?.startsWith('/messages/')) fake.agents.push(String(req.headers['user-agent']))
      if (req.method === 'POST' && req.url?.startsWith('/hooks/')) {
        if (req.url.startsWith('/hooks/SessionStart')) res.setHeader('x-clyde-registered', '1')
        return res.end('')
      }
      if (req.method === 'GET' && req.url?.startsWith('/messages/')) {
        const quiet = sent === undefined && fromClydeHook(req.headers['user-agent'] as string)
        const note = quiet ? '' : installerNote(clientStatus(sent ?? null, 30), false)
        return res.end(note ? `${note}\n` : '')
      }
      res.statusCode = 404
      res.end('')
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  fake.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  return fake
}

function home(): string {
  const h = tempDir('clyde-r78-')
  homes.push(h)
  // Gemini CLI and Antigravity are "here" when ~/.gemini/config is.
  mkdirSync(join(h, '.gemini', 'config'), { recursive: true })
  return h
}

/** A fake claude CLI that does what `claude mcp add|remove --scope user` does to ~/.claude.json, and logs its calls. */
function fakeClaude(h: string): string {
  const bin = join(h, 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'claude'), `#!/bin/sh
echo "$*" >> "$HOME/claude-calls.log"
exec python3 - "$@" <<'PY'
import json, sys
from pathlib import Path
p = Path.home() / ".claude.json"
d = json.loads(p.read_text()) if p.exists() else {}
a = sys.argv[1:]
s = d.setdefault("mcpServers", {})
if a[:2] == ["mcp", "remove"]:
    sys.exit(0 if s.pop(a[2], None) is not None else 1)
if a[:2] == ["mcp", "add"]:
    rest = [x for x in a[2:] if x not in ("--transport", "http", "--scope", "user")]
    name, url = rest[0], rest[1]
    hdr = a[a.index("--header") + 1]
    k, v = hdr.split(": ", 1)
    s[name] = {"type": "http", "url": url, "headers": {k: v}}
p.write_text(json.dumps(d, indent=2))
PY
`)
  chmodSync(join(bin, 'claude'), 0o755)
  return bin
}

/** A command run without blocking, so the fake server in this process can answer it. */
function run(cmd: string, args: string[], env: Record<string, string>, input = ''): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    child.stdin.end(input)
    child.on('close', (status) => resolve({ status, stdout, stderr }))
  })
}

async function install(h: string, fake: Fake, extra: Record<string, string> = {}, bin = '') {
  const r = await run('sh', [INSTALL], { PATH: `${bin ? `${bin}:` : ''}/usr/bin:/bin:/usr/sbin:/sbin`, HOME: h, MEMORY_URL: fake.url, CLYDE_MCP_URL: MCP, MEMORY_TOKEN: TOKEN, MEMORY_DEVICE: 'r78-test', LANG: 'C', ...extra })
  assert.equal(r.status, 0, `install.sh exited ${r.status}: ${r.stderr}\n${r.stdout}`)
  return r
}

const json = (h: string, p: string) => JSON.parse(readFileSync(join(h, p), 'utf8'))
const text = (h: string, p: string) => readFileSync(join(h, p), 'utf8')
/** Every hook command in a {event: [group]} table, flat Antigravity handlers included. */
const commands = (table: Record<string, any[]>): string[] =>
  Object.values(table).flat().flatMap((g: any) => (g.command ? [g.command] : (g.hooks ?? []).map((x: any) => x.command)))
const count = (s: string, sub: string) => s.split(sub).length - 1
const RULE_LINE = CLYDE_RULE.split('\n')[0]

/** Every file the installer writes, with its bytes and mtime. */
function snapshot(h: string): Record<string, [string, number]> {
  const out: Record<string, [string, number]> = {}
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n)
      if (n === 'hook-state' || n === 'claude-calls.log') continue
      if (statSync(p).isDirectory()) walk(p)
      else out[p.slice(h.length)] = [readFileSync(p, 'utf8'), statSync(p).mtimeMs]
    }
  }
  walk(h)
  return out
}

test('R78 one command on an empty HOME connects clyde in all four apps', async () => {
  const fake = await fakeServer()
  try {
    const h = home()
    await install(h, fake)
    // Claude Code: one server, clyde, at heyclyde.me/mcp with the device token.
    const servers = json(h, '.claude.json').mcpServers
    assert.deepEqual(Object.keys(servers), ['clyde'])
    assert.deepEqual(servers.clyde, { type: 'http', url: MCP, headers: { Authorization: `Bearer ${TOKEN}` } })
    // Codex: one [mcp_servers.clyde], no memory, and memories off.
    const toml = text(h, '.codex/config.toml')
    assert.equal(count(toml, '[mcp_servers.clyde]'), 1)
    assert.equal(count(toml, '[mcp_servers.memory]'), 0)
    assert.match(toml, new RegExp(`url = "${MCP.replace(/[./]/g, '\\$&')}"`))
    assert.match(toml, /\[features\]\nmemories = false/)
    // Gemini CLI: the clyde extension. Antigravity: clyde in mcp_config.json.
    assert.equal(json(h, '.gemini/extensions/clyde/gemini-extension.json').mcpServers.clyde.httpUrl, MCP)
    assert.ok(!existsSync(join(h, '.gemini/extensions/memory')))
    const agy = json(h, '.gemini/config/mcp_config.json').mcpServers
    assert.deepEqual(Object.keys(agy), ['clyde'])
    assert.equal(agy.clyde.serverUrl, MCP)

    // Every hook command in every app runs clyde-hook.sh, with the gate on every tool, and the app's own memory off.
    const claude = json(h, '.claude/settings.json')
    assert.equal(claude.autoMemoryEnabled, false)
    assert.deepEqual(claude.hooks, JSON.parse(CLAUDE_HOOKS_JSON).hooks)
    assert.equal(claude.hooks.PreToolUse[0].matcher, '*')
    const codex = json(h, '.codex/hooks.json')
    assert.deepEqual(codex, JSON.parse(CODEX_HOOKS_JSON))
    assert.equal(codex.hooks.PreToolUse[0].matcher, '.*')
    const gemini = json(h, '.gemini/extensions/clyde/hooks/hooks.json')
    assert.deepEqual(gemini, JSON.parse(GEMINI_HOOKS_JSON))
    assert.equal(gemini.hooks.BeforeTool[0].matcher, '.*')
    const agyHooks = json(h, '.gemini/config/hooks.json')
    assert.deepEqual(agyHooks, JSON.parse(ANTIGRAVITY_HOOKS_JSON))
    for (const table of [claude.hooks, codex.hooks, gemini.hooks, agyHooks.clyde]) {
      const cmds = commands(table)
      assert.ok(cmds.length >= 4)
      for (const c of cmds) assert.match(c, /^~\/\.config\/memory\/clyde-hook\.sh (claude|codex|gemini|antigravity) \w+$/)
    }
    const hook = join(h, '.config/memory/clyde-hook.sh')
    assert.equal(readFileSync(hook, 'utf8'), CLYDE_HOOK_SH)
    assert.equal(statSync(hook).mode & 0o777, 0o700)
    assert.match(text(h, '.config/memory/memory-hook'), new RegExp(`^VERSION=${CLIENT_VERSION.replace('.', '\\.')}$`, 'm'))

    // The rule, once in each rule file.
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']) {
      assert.equal(count(text(h, f), RULE_LINE), 1, f)
      assert.equal(count(text(h, f), '<!-- clyde:begin -->'), 1, f)
    }
  } finally {
    await fake.close()
  }
})

test('R78 a rerun changes nothing', async () => {
  const fake = await fakeServer()
  try {
    const h = home()
    await install(h, fake)
    const first = snapshot(h)
    await new Promise((r) => setTimeout(r, 30))
    await install(h, fake)
    const second = snapshot(h)
    assert.deepEqual(Object.keys(second).sort(), Object.keys(first).sort())
    for (const [f, [bytes, mtime]] of Object.entries(first)) {
      assert.equal(second[f][0], bytes, `${f} changed on the rerun`)
      assert.equal(second[f][1], mtime, `${f} was rewritten on the rerun`)
    }
  } finally {
    await fake.close()
  }
})

test("R78 the installer migrates an old setup and keeps the user's own", async () => {
  const fake = await fakeServer()
  try {
    const h = home()
    const bin = fakeClaude(h)
    mkdirSync(join(h, '.claude'), { recursive: true })
    mkdirSync(join(h, '.codex'), { recursive: true })
    mkdirSync(join(h, '.gemini/extensions/memory/hooks'), { recursive: true })
    mkdirSync(join(h, '.config/memory'), { recursive: true })
    const old = { type: 'http', url: 'https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/mcp', headers: { Authorization: 'Bearer old' } }
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { memory: old, kb: old, notion: { type: 'http', url: 'https://mcp.notion.com/mcp' } } }))
    const userHook = { hooks: [{ type: 'command', command: 'echo my own hook' }] }
    writeFileSync(join(h, '.claude/settings.json'), JSON.stringify({
      model: 'opus',
      autoMemoryEnabled: true,
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: '~/.config/memory/memory-hook SessionStart' }] }, userHook],
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: '~/.config/memory/clyde-gate.sh prompt' }] }, { hooks: [{ type: 'command', command: '~/.config/kb/kb-hook UserPromptSubmit' }] }],
        PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: '~/.config/memory/clyde-gate.sh pre' }] },
          { matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: '~/.config/memory/clyde-guard.sh' }] },
          { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo my own guard' }] }],
        PostToolUse: [{ matcher: '.*__(recall|recall_more)$', hooks: [{ type: 'command', command: '~/.config/memory/clyde-gate.sh post' }] },
          { matcher: 'mcp__memory__.*', hooks: [{ type: 'command', command: '~/.config/memory/clyde-hook.sh claude PostToolUse' }] }],
      },
    }))
    writeFileSync(join(h, '.codex/hooks.json'), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: 'startup|resume', hooks: [{ type: 'command', command: 'MEMORY_AGENT=codex ~/.config/memory/memory-hook SessionStart' }] }],
      Stop: [userHook],
    } }))
    writeFileSync(join(h, '.codex/config.toml'), 'model = "gpt-5"\n\n[features]\nmemories = true\nweb_search = true\n\n[memories]\nuse_memories = true\n\n' +
      '[mcp_servers.memory]\nurl = "https://memory.heyclyde.me/mcp"\nhttp_headers = { Authorization = "Bearer old" }\n\n[mcp_servers.github]\nurl = "https://api.githubcopilot.com/mcp/"\n')
    writeFileSync(join(h, '.gemini/extensions/memory/gemini-extension.json'), JSON.stringify({ name: 'memory', mcpServers: { memory: { httpUrl: 'https://memory.heyclyde.me/mcp' } } }))
    writeFileSync(join(h, '.gemini/settings.json'), JSON.stringify({ theme: 'dark', hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: '~/.config/memory/clyde-hook.sh gemini BeforeAgent' }] }] },
      mcpServers: { clyde: { httpUrl: 'https://heyclyde.me/mcp' }, mine: { httpUrl: 'https://example.com/mcp' } } }))
    writeFileSync(join(h, '.gemini/config/mcp_config.json'), JSON.stringify({ mcpServers: { memory: { serverUrl: 'https://memory.heyclyde.me/mcp' }, 'chrome-devtools': { command: 'npx' } } }))
    writeFileSync(join(h, '.gemini/config/hooks.json'), JSON.stringify({
      clyde: { SessionStart: [{ type: 'command', command: '~/.config/memory/clyde-hook.sh antigravity SessionStart', timeout: 5 }] },
      'memory-lifecycle': { Stop: [{ type: 'command', command: 'python3 ./hooks/memory_hook.py', timeout: 10 }] },
    }))
    const OLD_RULE = '## Clyde\n\nUse Clyde MCP tools for shared memory across sessions and apps:\n- Once per session, call register_agent.\n'
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']) writeFileSync(join(h, f), `# Mine\n\nKeep tabs.\n\n${OLD_RULE}`)
    writeFileSync(join(h, '.config/memory/clyde-gate.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })

    await install(h, fake, {}, bin)

    const claudeJson = json(h, '.claude.json')
    assert.equal(claudeJson.numStartups, 7)
    assert.deepEqual(Object.keys(claudeJson.mcpServers).sort(), ['clyde', 'notion'])
    assert.equal(claudeJson.mcpServers.clyde.url, MCP)
    assert.match(text(h, 'claude-calls.log'), /mcp add --transport http --scope user clyde https:\/\/heyclyde\.me\/mcp/)
    const settings = json(h, '.claude/settings.json')
    assert.equal(settings.model, 'opus')
    assert.equal(settings.autoMemoryEnabled, false)
    const cmds = commands(settings.hooks)
    for (const gone of ['memory-hook', 'kb-hook', 'clyde-gate', 'clyde-guard']) assert.ok(!cmds.some((c) => c.includes(gone)), `${gone} left in`)
    assert.ok(cmds.includes('echo my own hook') && cmds.includes('echo my own guard'))
    const ours = JSON.parse(CLAUDE_HOOKS_JSON).hooks
    for (const [event, groups] of Object.entries<any[]>(ours)) {
      assert.equal(settings.hooks[event].filter((g: any) => g.hooks.some((x: any) => x.command.includes('clyde-hook'))).length, groups.length, event)
    }
    const codex = json(h, '.codex/hooks.json')
    assert.ok(!commands(codex.hooks).some((c) => c.includes('memory-hook')))
    assert.deepEqual(codex.hooks.Stop[0], userHook)
    const toml = text(h, '.codex/config.toml')
    assert.equal(count(toml, '[mcp_servers.'), 2)
    assert.equal(count(toml, '[mcp_servers.clyde]'), 1)
    assert.match(toml, /\[mcp_servers\.github\]/)
    assert.match(toml, /\[features\]\nmemories = false\nweb_search = true/)
    assert.match(toml, /^model = "gpt-5"/)
    assert.ok(!existsSync(join(h, '.gemini/extensions/memory')))
    const gset = json(h, '.gemini/settings.json')
    assert.equal(gset.theme, 'dark')
    assert.equal(gset.hooks, undefined)
    assert.deepEqual(Object.keys(gset.mcpServers), ['mine'])
    assert.deepEqual(Object.keys(json(h, '.gemini/config/mcp_config.json').mcpServers).sort(), ['chrome-devtools', 'clyde'])
    const agyHooks = json(h, '.gemini/config/hooks.json')
    assert.deepEqual(Object.keys(agyHooks).sort(), ['clyde', 'memory-lifecycle'])
    assert.deepEqual(agyHooks.clyde, JSON.parse(ANTIGRAVITY_HOOKS_JSON).clyde)
    for (const f of ['.claude/CLAUDE.md', '.codex/AGENTS.md', '.gemini/GEMINI.md']) {
      const t = text(h, f)
      assert.equal(count(t, 'Use Clyde MCP tools'), 0, f)
      assert.equal(count(t, RULE_LINE), 1, f)
      assert.match(t, /^# Mine\n\nKeep tabs\.\n\n<!-- clyde:begin -->/, f)
    }
    // The old gate script, if a computer has one, becomes the shim that hands off to clyde-hook.sh.
    assert.match(text(h, '.config/memory/clyde-gate.sh'), /exec "\$hook" claude PreToolUse/)
  } finally {
    await fake.close()
  }
})

test('R78 MEMORY_CLAUDE=connector leaves Claude Code one server', async () => {
  const fake = await fakeServer()
  try {
    const h = home()
    writeFileSync(join(h, '.claude.json'), JSON.stringify({ mcpServers: { memory: { type: 'http', url: 'https://memory.heyclyde.me/mcp' } } }))
    await install(h, fake, { MEMORY_CLAUDE: 'connector' })
    assert.deepEqual(json(h, '.claude.json').mcpServers, {})
    assert.equal(text(h, '.config/memory/claude-mode').trim(), 'connector')
    await install(h, fake)
    assert.deepEqual(json(h, '.claude.json').mcpServers, {})
    const settings = json(h, '.claude/settings.json')
    assert.deepEqual(settings.hooks, JSON.parse(CLAUDE_HOOKS_JSON).hooks)
    assert.equal(settings.autoMemoryEnabled, false)
  } finally {
    await fake.close()
  }
})

test("R78 a fresh install's hooks print no out-of-date line", async () => {
  const fake = await fakeServer()
  try {
    const h = home()
    await install(h, fake)
    const hook = join(h, '.config/memory/clyde-hook.sh')
    const out: string[] = []
    for (const client of ['claude', 'codex', 'gemini']) {
      for (const [event, payload] of [['SessionStart', { session_id: `s-${client}` }], ['UserPromptSubmit', { session_id: `s-${client}`, prompt: 'plan the billing webhook retry work for stripe' }]] as const) {
        const ev = client === 'gemini' && event === 'UserPromptSubmit' ? 'BeforeAgent' : event
        const r = await run(hook, [client, ev], { PATH: '/usr/bin:/bin', HOME: h }, JSON.stringify(payload))
        assert.equal(r.status, 0)
        out.push(r.stdout)
      }
    }
    const all = out.join('\n')
    assert.match(all, /recall/, 'the hooks did run and nudge')
    assert.equal(all.split('\n').filter((l) => /out of date/i.test(l)).length, 0, all)
    assert.ok(!/^memory:/m.test(all))
    // Cloudflare in front of memory.heyclyde.me refuses Python-urllib's own User-Agent, so the hook names itself.
    assert.ok(fake.agents.length >= 6, String(fake.agents.length))
    for (const ua of fake.agents) assert.match(ua, new RegExp(`^clyde-hook/${CLIENT_VERSION.replace('.', '\\.')}$`))
  } finally {
    await fake.close()
  }
})
