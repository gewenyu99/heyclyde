/** clyde doctor: one line per check on the CLIs, their logins, the extension, the daemon and memory. Exit 1 when something is broken. */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { claudeBin } from '../backends/claude.ts'
import { codexBin } from '../backends/codex.ts'
import { agentDir, extensionInstalled, extensionPath } from '../backends/pi.ts'
import { DaemonClient, healthy } from '../client.ts'
import { loadMemoryEnv, readDaemonInfo } from '../config.ts'
import { createArgs, happierBin } from '../happier.ts'
import { agentMemory, runtimeMemory } from '../memory.ts'
import { request } from '../request.ts'
import { roles } from '../roles.ts'
import { probe } from '../routes/memory.ts'
import { extensionIndex, indexSource } from './install.ts'
import { spoolStatus } from '../memory-spool.ts'

// The flags each backend passes, per PLAN "Backend flags". The backends build argv inline and export no list,
// so these are kept here. Change them with src/backends/*.ts.
export const FLAGS = {
  pi: { help: [['--help']], flags: [['--mode', '-p', '--model', '--thinking', '--approve', '--session-dir', '--session-id', '-e', '--append-system-prompt', '--tools']] },
  claude: {
    help: [['--help']],
    flags: [['-p', '--output-format', '--verbose', '--session-id', '--resume', '--model', '--effort', '--permission-mode',
      '--append-system-prompt', '--settings', '--tools', '--disallowedTools', '--json-schema']],
  },
  // -s and -C go before resume, so exec's help must list them. Everything else repeats after resume.
  codex: {
    help: [['exec', '--help'], ['exec', 'resume', '--help']],
    flags: [
      ['--json', '--skip-git-repo-check', '-m', '-c', '--ephemeral', '--output-schema', '-s', '-C', '-o'],
      ['--json', '--skip-git-repo-check', '-m', '-c', '--ephemeral', '--output-schema', '-o'],
    ],
  },
  happier: {
    help: [['session', 'create', '--help'], ['session', 'send', '--help'], ['notify', '--help']],
    flags: [createArgs('.').filter((a) => a.startsWith('-')), ['--json'], ['-p', '-t']],
  },
} as const

type Name = keyof typeof FLAGS
export type Status = 'ok' | 'warn' | 'broken'
export type Check = { name: string; status: Status; detail: string }
type Ran = { code: number | null; out: string; missing: boolean }

const TIMEOUT_MS = 15_000

function binOf(name: Name): string {
  if (name === 'happier') return happierBin()
  if (name === 'claude') return claudeBin()
  if (name === 'codex') return codexBin()
  return process.env[`CLYDE_${name.toUpperCase()}_BIN`] || name
}

function run(bin: string, args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as any).code === 'number' ? (err as any).code : null) : 0
      resolve({ code, out: `${stdout}\n${stderr}`, missing: (err as any)?.code === 'ENOENT' })
    })
  })
}

/** Every flag a --help text names, like -s, --sandbox or --mode=. */
export function helpFlags(text: string): Set<string> {
  return new Set([...text.matchAll(/(?:^|[\s,[(|])(--?[A-Za-z][\w-]*)/g)].map((m) => m[1]))
}

/** The backends some role uses. A missing CLI no role needs is only a warning. */
function used(): Set<string> {
  try {
    return new Set(Object.values(roles()).flat().map((r) => r.backend))
  } catch {
    return new Set(['pi', 'claude', 'codex'])
  }
}

function firstLine(text: string): string {
  return text.trim().split('\n').map((l) => l.trim()).find(Boolean) ?? ''
}

async function cli(name: Name, needed: boolean): Promise<Check> {
  const bin = binOf(name)
  const version = await run(bin, ['--version'])
  if (version.missing) {
    const why = name === 'happier' ? 'optional. clyde up runs pi in the terminal without it' : needed ? 'a role uses it' : 'no role uses it'
    return { name, status: needed ? 'broken' : 'warn', detail: `missing, ${bin} is not on PATH (${why})` }
  }
  const spec = FLAGS[name]
  const lost: string[] = []
  for (const [i, args] of spec.help.entries()) {
    const cmd = [bin, ...args].join(' ')
    const help = helpFlags((await run(bin, [...args])).out)
    const gone = spec.flags[i].filter((f) => !help.has(f))
    if (!help.size) lost.push(`${cmd} lists no flags at all`)
    else if (gone.length) lost.push(`${cmd} no longer lists ${gone.join(', ')}`)
  }
  const v = firstLine(version.out) || 'unknown version'
  if (lost.length) return { name, status: 'broken', detail: `${v}. ${lost.join('. ')}` }
  return { name, status: 'ok', detail: `${v}. --help lists every flag clyde passes` }
}

async function codexLogin(needed: boolean): Promise<Check> {
  const r = await run(binOf('codex'), ['login', 'status'])
  if (r.missing) return { name: 'codex login', status: needed ? 'broken' : 'warn', detail: 'codex is missing' }
  if (r.code === 0) return { name: 'codex login', status: 'ok', detail: firstLine(r.out.replace(/^WARNING:.*$/gm, '')) }
  return { name: 'codex login', status: needed ? 'broken' : 'warn', detail: 'not logged in. Run codex login' }
}

async function claudeLogin(needed: boolean): Promise<Check> {
  const r = await run(binOf('claude'), ['auth', 'status'])
  if (r.missing) return { name: 'claude login', status: needed ? 'broken' : 'warn', detail: 'claude is missing' }
  let status: any = null
  try {
    status = JSON.parse(r.out.slice(r.out.indexOf('{'), r.out.lastIndexOf('}') + 1))
  } catch {
    // Older builds have no auth status, so the first real turn tells.
  }
  if (status?.loggedIn === true) return { name: 'claude login', status: 'ok', detail: `logged in with ${status.authMethod ?? 'an unknown method'}` }
  if (status?.loggedIn === false) return { name: 'claude login', status: needed ? 'broken' : 'warn', detail: 'not logged in. Run claude auth login' }
  return { name: 'claude login', status: 'warn', detail: 'claude auth status gave no answer, so the login is unchecked' }
}

const KEY_FOR: Record<string, string> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', xai: 'XAI_API_KEY' }

/** The providers in pi's auth.json, against the providers the roles' pi rungs use. */
function piLogin(): Check {
  const path = join(agentDir(process.env), 'auth.json')
  let providers: string[] = []
  try {
    providers = Object.keys(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    // No auth.json yet.
  }
  let wanted: string[] = []
  try {
    wanted = Object.values(roles()).flat().filter((r) => r.backend === 'pi' && r.model?.includes('/')).map((r) => (r.model as string).split('/')[0])
  } catch {
    // roles.json is broken. The thread routes report that.
  }
  const missing = [...new Set(wanted)].filter((p) => !providers.includes(p) && !(KEY_FOR[p] && process.env[KEY_FOR[p]]))
  const have = providers.length ? providers.join(', ') : 'none'
  if (missing.length) return { name: 'pi login', status: 'broken', detail: `no login for ${missing.join(', ')}, which a role uses. auth.json has ${have}. Run pi, then /login` }
  return { name: 'pi login', status: 'ok', detail: `auth.json has ${have}` }
}

async function happierLogin(): Promise<Check> {
  const r = await run(happierBin(), ['auth', 'status', '--json'])
  if (r.missing) return { name: 'happier login', status: 'warn', detail: 'happier is missing' }
  if (r.code === 0 && /"ok"\s*:\s*true/.test(r.out)) return { name: 'happier login', status: 'ok', detail: 'signed in' }
  return { name: 'happier login', status: 'warn', detail: 'not signed in. Run happier auth login, or clyde up runs pi in the terminal' }
}

function extension(): Check {
  const env = process.env
  if (!extensionInstalled(env)) return { name: 'extension', status: 'warn', detail: `not in ${join(agentDir(env), 'extensions')}. Run clyde install. Workers pass -e until then` }
  let index = ''
  try {
    index = readFileSync(extensionIndex(env), 'utf8')
  } catch {
    return { name: 'extension', status: 'ok', detail: `installed in ${join(agentDir(env), 'extensions')} by hand` }
  }
  if (index === indexSource()) return { name: 'extension', status: 'ok', detail: `${extensionIndex(env)} loads ${extensionPath()}` }
  const target = /from\s+(".*?"|'.*?')/.exec(index)?.[1]
  return { name: 'extension', status: 'broken', detail: `${extensionIndex(env)} loads ${target ?? 'something else'}, not this checkout. Run clyde install` }
}

async function daemon(): Promise<{ check: Check; client: DaemonClient | null }> {
  const info = readDaemonInfo()
  if (!info) return { check: { name: 'daemon', status: 'warn', detail: 'not running. clyde up or clyde daemon starts it' }, client: null }
  if (!(await healthy(info))) return { check: { name: 'daemon', status: 'warn', detail: `daemon.json names pid ${info.pid}, which does not answer. clyde up starts a new one` }, client: null }
  const client = new DaemonClient(info)
  const h = await client.health()
  return { check: { name: 'daemon', status: 'ok', detail: `pid ${info.pid}, port ${info.port}, version ${h.version}, ${h.threads} threads, ${h.runs} runs` }, client }
}

async function kbChecks(client: DaemonClient | null): Promise<Check[]> {
  const url = process.env.MEMORY_URL
  if (!url) return [{ name: 'memory', status: 'warn', detail: 'MEMORY_URL is not set. Entries remain in the local memory spool' }]
  const out: Check[] = []
  try {
    const res = await request('GET', `${url.replace(/\/+$/, '')}/healthz`, { timeoutMs: 5000 })
    out.push(res.status === 200 ? { name: 'memory', status: 'ok', detail: `${url} answers` } : { name: 'memory', status: 'broken', detail: `${url}/healthz answered ${res.status}` })
  } catch (err) {
    return [{ name: 'memory', status: 'broken', detail: `${url} is unreachable: ${(err as Error).message}` }]
  }
  const agent = agentMemory()
  if (!process.env.MEMORY_TOKEN || !agent) out.push({ name: 'memory agent', status: 'broken', detail: 'MEMORY_TOKEN is not set, so workers can not recall or remember' })
  else {
    const p = await probe(agent)
    out.push({ name: 'memory agent', status: p.ok ? 'ok' : 'broken', detail: `MEMORY_TOKEN ${p.detail}` })
  }
  out.push(await runtimeCheck(client))
  return out
}

/** The runtime token from this shell when it has one, else from the daemon, which is where it has to be. */
async function runtimeCheck(client: DaemonClient | null): Promise<Check> {
  const memory = runtimeMemory()
  if (process.env.MEMORY_RUNTIME_TOKEN && memory) {
    if (process.env.MEMORY_RUNTIME_TOKEN === process.env.MEMORY_TOKEN) return { name: 'memory runtime', status: 'broken', detail: 'MEMORY_RUNTIME_TOKEN equals MEMORY_TOKEN, so every worker would write as the runtime' }
    const p = await probe(memory)
    return { name: 'memory runtime', status: p.ok ? 'ok' : 'broken', detail: `MEMORY_RUNTIME_TOKEN ${p.detail}` }
  }
  if (!client) return { name: 'memory runtime', status: 'warn', detail: 'MEMORY_RUNTIME_TOKEN is not set here and no daemon runs to ask' }
  try {
    const r = await client.call('GET', '/memory/check', undefined, 10_000)
    return { name: 'memory runtime', status: r.ok ? 'ok' : 'broken', detail: `the daemon's MEMORY_RUNTIME_TOKEN: ${r.detail}` }
  } catch (err) {
    return { name: 'memory runtime', status: 'warn', detail: `the daemon could not say: ${(err as Error).message}` }
  }
}

export async function checks(): Promise<Check[]> {
  loadMemoryEnv()
  const need = used()
  const d = await daemon()
  const groups = await Promise.all([
    cli('pi', need.has('pi')), piLogin(),
    cli('claude', need.has('claude')), claudeLogin(need.has('claude')),
    cli('codex', need.has('codex')), codexLogin(need.has('codex')),
    cli('happier', false), happierLogin(),
    extension(), d.check, kbChecks(d.client),
  ])
  const spool = spoolStatus()
  const detail = `${spool.depth} pending, oldest ${Math.round(spool.oldestAgeMs / 1000)}s` +
    (spool.deadLetterDepth ? `, ${spool.deadLetterDepth} dead-letter` : '')
  return [...groups.flat(), { name: 'memory spool', status: spool.depth || spool.deadLetterDepth ? 'warn' : 'ok', detail }]
}

export function checkLine(c: Check): string {
  return `${c.name.padEnd(14)}  ${c.status.padEnd(6)}  ${c.detail}`
}

export async function main(argv: string[]): Promise<number> {
  const json = argv.includes('--json')
  const all = await checks()
  const broken = all.filter((c) => c.status === 'broken').length
  if (json) console.log(JSON.stringify({ checks: all, broken }, null, 2))
  else {
    for (const c of all) console.log(checkLine(c))
    console.log(broken ? `${broken} broken.` : 'Nothing is broken.')
  }
  return broken ? 1 : 0
}
