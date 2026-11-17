/**
 * R31's two surfaces and the guard that pins each to a version. The client surface is what a computer self-updates from:
 * the files in memory/supabase/functions/memory/client/ (not files.ts, which is baked from them, and not the .sig files,
 * which deploy.sh makes). The server surface is what MCP clients read at initialize: the tools and the instructions.
 * Plain node, so version.test.ts and deploy.sh's guard run it without a database. The server surface needs mcp.ts, which
 * only deno loads, so surface.ts prints that hash.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** The Gemini CLI and Antigravity files (R45 #50): the Gemini hook adapter, the extension's hooks and manifest, and
 * Antigravity's MCP entry. */
export const AGENT_APP_FILES = ['gemini-hook', 'gemini-hooks.json', 'gemini-extension.json', 'antigravity-mcp.json']

/** The files a self-update installs and verifies. Their hash is the client surface. */
export const CLIENT_SURFACE_FILES = ['claude-settings.json', 'codex-hooks.json', 'install.sh', 'memory-hook', 'signing-pub.pem', ...AGENT_APP_FILES]

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** SHA-256 of the client files, read by name. */
export function clientSurfaceHash(read: (name: string) => string): string {
  const client: Record<string, string> = {}
  for (const name of CLIENT_SURFACE_FILES) client[name] = read(name)
  return sha256(JSON.stringify({ client }))
}

/** SHA-256 of the server instructions and the tool list, and since R67 what card-rendering chat apps read (`ui`). Nothing
 * about the client files goes into it. */
export const serverSurfaceHash = (instructions: string, tools: unknown, ui?: unknown): string =>
  sha256(JSON.stringify(ui === undefined ? { instructions, tools } : { instructions, tools, ui }))

export type SurfaceCheck = {
  /** The version now in force. */
  version: string
  /** The hash of the surface as it is on disk. */
  hash: string
  /** The map in version.ts: one hash per version. */
  hashes: Record<string, string>
  /** Every [version, hash] an earlier commit on main pinned. */
  history: [string, string][]
}

/** Hashes that main's history holds for a version but that never shipped, so the history check skips them. Each needs a
 * reason. 20261102.1's first pin (c5c9…) was from R31's first review round, re-pinned to 70276… in round two before the
 * first deploy, so the clients running 20261102.1 have only ever had 70276…. Add nothing here for a version that shipped. */
export const NEVER_SHIPPED: Record<string, string[]> = {
  '20261102.1': ['c5c9c8f997093c90726d3a43d9c13283279e6baaeb7bdc0c215c9c4d7f7c08bf'],
  // R67's branch pinned 20261115.2 three times while the design system's CSS moved under the cards (558f… with R46's
  // placeholder tokens, 8a85… with the first components.css). The branch reached main before any deploy, which shipped
  // ed27… first.
  '20261115.2': ['558ff788dd3c921c129b59dc9e6b5ca8cda51738a5fd01c26bf4e4257b96e6bf', '8a8599305cbb8fd36244b9b6237ce6b29eb054846f6bab79b028ed97be4a7d45'],
}

/** What is wrong with the pin, as sentences. Empty when the surface, its version and the history agree. */
export function checkSurface({ version, hash, hashes, history }: SurfaceCheck): string[] {
  const problems: string[] = []
  if (!(version in hashes)) {
    problems.push(`The map has no entry for ${version}. Add "${version}": "${hash}".`)
  } else if (hashes[version] !== hash) {
    problems.push(`The surface changed but ${version} still pins ${hashes[version]}. Bump the version and add an entry for ${hash}.`)
  }
  const byHash = new Map<string, string>()
  for (const [v, h] of Object.entries(hashes)) {
    const other = byHash.get(h)
    if (other) problems.push(`Versions ${other} and ${v} share the hash ${h}. Each version pins its own surface.`)
    byHash.set(h, v)
  }
  for (const [v, h] of history) {
    if (NEVER_SHIPPED[v]?.includes(h)) continue
    if (!(v in hashes)) problems.push(`The entry for ${v} was removed. A released version stays pinned.`)
    else if (hashes[v] !== h) problems.push(`The entry for ${v} changed from ${h} to ${hashes[v]}. A released version's hash never changes: bump the version instead.`)
  }
  return problems
}

/** The `{ "version": "hash" }` pairs in the exported const of version.ts's source. */
export function parseHashes(source: string, name: string): Record<string, string> {
  const start = source.indexOf(`export const ${name}`)
  if (start < 0) return {}
  const block = source.slice(start, source.indexOf('};', start))
  const out: Record<string, string> = {}
  for (const m of block.matchAll(/"(\d{8}\.\d+)":\s*"([0-9a-f]{64})"/g)) out[m[1]] = m[2]
  return out
}

/** Every pair the const held at any commit of `ref` that touched version.ts. `ref` falls back to HEAD without an origin/main. */
export function hashHistory(repo: string, file: string, name: string): [string, string][] {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })
  let ref = 'origin/main'
  try {
    git('rev-parse', '--verify', '--quiet', ref)
  } catch {
    ref = 'HEAD'
  }
  const seen = new Map<string, string>()
  for (const sha of git('log', '--format=%H', ref, '--', file).split('\n').filter(Boolean)) {
    let source: string
    try {
      source = git('show', `${sha}:${file}`)
    } catch {
      continue
    }
    for (const [v, h] of Object.entries(parseHashes(source, name))) if (!seen.has(`${v}\0${h}`)) seen.set(`${v}\0${h}`, v)
  }
  return [...seen.keys()].map((k) => k.split('\0') as [string, string])
}

export const readText = (path: string) => readFileSync(path, 'utf8')
