/** The three backends by name. */
import type { BackendName } from '../types.ts'
import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { antigravity } from './antigravity.ts'
import { pi } from './pi.ts'
import type { Backend } from './types.ts'

export const BACKENDS: Record<BackendName, Backend> = { pi, claude, codex, antigravity }

export function backend(name: string): Backend {
  const found = BACKENDS[name as BackendName]
  if (!found) throw new Error(`unknown backend ${name}. Known backends: pi, claude, codex`)
  return found
}
