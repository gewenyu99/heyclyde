/** JSON files that survive a crash mid-write: write a temp file, then rename it over the old one. */
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function writeJson(path: string, value: unknown, mode = 0o644): void {
  const dirMode = (mode & 0o077) === 0 ? 0o700 : 0o755
  mkdirSync(dirname(path), { recursive: true, mode: dirMode })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const content = JSON.stringify(value, null, 2) + '\n'
    if ((mode & 0o077) === 0) {
      const fd = openSync(tmp, 'wx', mode)
      try { writeFileSync(fd, content) } finally { closeSync(fd) }
    } else {
      writeFileSync(tmp, content, { mode })
    }
    renameSync(tmp, path)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

/** Every parseable .json file in dir. A half-written temp file never matches, since it ends in .tmp. */
export function readJsonDir<T>(dir: string): T[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  return names.filter((n) => n.endsWith('.json')).map((n) => readJson<T>(join(dir, n))).filter((v): v is T => v !== null)
}
