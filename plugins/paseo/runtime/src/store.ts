/** JSON files that survive a crash mid-write: write a temp file, then rename it over the old one. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function writeJson(path: string, value: unknown, mode = 0o644): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode })
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
