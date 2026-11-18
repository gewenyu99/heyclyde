/** clyde install: links the clyde extension into pi's agent dir and puts clyde on PATH. Safe to run again. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { agentDir, extensionPath } from '../backends/pi.ts'
import { clydeBin, clydeHome } from '../config.ts'

export type Step = { name: string; status: 'ok' | 'done' | 'todo'; detail: string }

export function extensionIndex(env: Record<string, string | undefined> = process.env): string {
  return join(agentDir(env), 'extensions', 'clyde', 'index.ts')
}

/** One line that re-exports the repo file, so a git pull updates the extension with no reinstall. */
export function indexSource(): string {
  return `export { default } from ${JSON.stringify(extensionPath())}\n`
}

export function installExtension(env: Record<string, string | undefined> = process.env): Step {
  const path = extensionIndex(env)
  const want = indexSource()
  let have: string | null = null
  try {
    have = readFileSync(path, 'utf8')
  } catch {
    // Not installed yet.
  }
  if (have === want) return { name: 'extension', status: 'ok', detail: `${path} already loads ${extensionPath()}` }
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, want)
  return { name: 'extension', status: 'done', detail: `${path} now loads ${extensionPath()}` }
}

function linkTarget(path: string): string | null {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
  } catch {
    return null
  }
}

/** Points link at target. Leaves a file that isn't a symlink alone, since it's someone else's clyde. */
function link(path: string, target: string): 'ok' | 'done' | 'taken' {
  const current = linkTarget(path)
  if (current === target) return 'ok'
  if (current === null && existsSync(path)) return 'taken'
  if (current !== null) rmSync(path, { force: true })
  mkdirSync(join(path, '..'), { recursive: true })
  symlinkSync(target, path)
  return 'done'
}

function onPath(dir: string, env: Record<string, string | undefined>): boolean {
  return (env.PATH ?? '').split(delimiter).includes(dir)
}

/** ~/.local/bin/clyde when that dir exists, else a link in <CLYDE_HOME>/bin and the exact line to add to your shell. */
export function installBin(env: Record<string, string | undefined> = process.env): Step {
  const local = join(env.HOME || homedir(), '.local', 'bin')
  if (existsSync(local)) {
    const path = join(local, 'clyde')
    const r = link(path, clydeBin())
    if (r === 'taken') return { name: 'clyde', status: 'todo', detail: `${path} is another program. Remove it, then run clyde install again.` }
    const note = onPath(local, env) ? '' : ` Add it to PATH: export PATH="${local}:$PATH"`
    return { name: 'clyde', status: note ? 'todo' : r, detail: `${path} -> ${clydeBin()}.${note}` }
  }
  const dir = join(clydeHome(), 'bin')
  link(join(dir, 'clyde'), clydeBin())
  if (onPath(dir, env)) return { name: 'clyde', status: 'ok', detail: `${join(dir, 'clyde')} is on PATH` }
  return { name: 'clyde', status: 'todo', detail: `Add this line to your shell profile: export PATH="${dir}:$PATH"` }
}

export function stepLine(s: Step): string {
  const word = { ok: 'ok', done: 'linked', todo: 'to do' }[s.status]
  return `${s.name.padEnd(10)}  ${word.padEnd(6)}  ${s.detail}`
}

export async function main(argv: string[]): Promise<number> {
  if (argv.length) {
    console.error('Usage: clyde install')
    return 2
  }
  for (const step of [installExtension(), installBin()]) console.log(stepLine(step))
  return 0
}
