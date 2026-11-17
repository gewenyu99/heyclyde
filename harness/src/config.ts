import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function harnessRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..')
}

export function repoRoot(): string {
  return resolve(harnessRoot(), '..')
}
