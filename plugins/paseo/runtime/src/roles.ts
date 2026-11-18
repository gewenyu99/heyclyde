/** Roles map to ladders of rungs. Defaults live here, and <CLYDE_HOME>/roles.json overrides them by role. */
import { join } from 'node:path'
import { clydeHome } from './config.ts'
import { readJson } from './store.ts'
import type { Rung } from './types.ts'

export const CHATGPT = 'openai/gpt-6.1-sol'
export const CODEX = 'gpt-6-sol'
export const SONNET = 'claude-sonnet-5-5'

// Fast edits run on GPT-6 Sol and Sonnet 5.5 at high effort. Small jobs, threads and judging, go lower.
export const DEFAULT_ROLES: Record<string, Rung[]> = {
  thread: [{ backend: 'codex', model: CODEX, effort: 'low' }],
  planner: [{ backend: 'claude', model: SONNET, effort: 'high' }],
  worker: [
    { backend: 'codex', model: CODEX, effort: 'high' },
    { backend: 'codex', model: CODEX, effort: 'high', notes: true },
    { backend: 'claude', model: SONNET, effort: 'high', notes: true },
  ],
  judge: [{ backend: 'claude', model: SONNET, effort: 'medium' }, { backend: 'codex', model: CODEX, effort: 'medium' }],
  reviewer: [{ backend: 'claude', model: SONNET, effort: 'high' }],
}

export function roles(): Record<string, Rung[]> {
  const overrides = readJson<Record<string, Rung[]>>(join(clydeHome(), 'roles.json')) ?? {}
  const out = { ...DEFAULT_ROLES }
  for (const [role, ladder] of Object.entries(overrides)) {
    if (Array.isArray(ladder) && ladder.length && ladder.every(isRung)) out[role] = ladder
  }
  return out
}

/** The ladder for a role. An unknown role is an error, so a typo never silently runs the default. */
export function ladder(role: string): Rung[] {
  const found = roles()[role]
  if (!found) throw new Error(`unknown role ${role}. Known roles: ${Object.keys(roles()).join(', ')}`)
  return found
}

export function isRung(r: unknown): r is Rung {
  const b = (r as Rung)?.backend
  // Ruling 4: Claude runs only as Claude Code, so a pi rung on anthropic is not a rung clyde can read.
  if (b === 'pi' && String((r as Rung).model ?? '').startsWith('anthropic/')) return false
  return b === 'antigravity' || b === 'pi' || b === 'claude' || b === 'codex'
}

const FAMILIES: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', 'openai-codex': 'openai', xai: 'xai' }

/** The model family for the judge rule: claude and pi's anthropic are one family, codex and pi's openai another. */
export function family(rung: Rung): string {
  if (rung.backend === 'antigravity') return 'google'
  if (rung.backend === 'claude') return 'anthropic'
  if (rung.backend === 'codex') return 'openai'
  const provider = (rung.model ?? CHATGPT).split('/')[0]
  return FAMILIES[provider] ?? provider
}
