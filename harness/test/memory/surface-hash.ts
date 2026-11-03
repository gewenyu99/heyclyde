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

/** The files a self-update installs and verifies. Their hash is the client surface. */
export const CLIENT_SURFACE_FILES = ['claude-settings.json', 'codex-hooks.json', 'install.sh', 'memory-hook', 'signing-pub.pem']

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** SHA-256 of the client files, read by name. */
export function clientSurfaceHash(read: (name: string) => string): string {
  const client: Record<string, string> = {}
  for (const name of CLIENT_SURFACE_FILES) client[name] = read(name)
  return sha256(JSON.stringify({ client }))
}

/** SHA-256 of the server instructions and the tool list. Nothing about the client files goes into it. */
export const serverSurfaceHash = (instructions: string, tools: unknown): string => sha256(JSON.stringify({ instructions, tools }))

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
