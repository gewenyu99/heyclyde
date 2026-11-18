import { join } from 'node:path'
import { clydeHome } from './config.ts'
import { readJson, writeJson } from './store.ts'
import { paseo } from './paseo.ts'
import type { Rung } from './types.ts'

export const profiles = {
  sol: { backend: 'codex', model: 'gpt-6.2-sol', effort: 'high' },
  sonnet: { backend: 'claude', model: 'claude-sonnet-5-5', effort: 'high' },
  opus: { backend: 'claude', model: 'claude-opus-5-5', effort: 'high' },
  astra: { backend: 'codex', model: 'gpt-6.2-astra', effort: 'high' },
  fable: { backend: 'claude', model: 'claude-fable-5-2', effort: 'high' },
  orchestrator: { backend: 'antigravity', model: 'gemini-pro-orchestrator', effort: 'high' },
  carbon: { backend: 'antigravity', model: 'gemini-4-carbon-high', effort: 'high' },
} satisfies Record<string, Rung>

export type Model = keyof typeof profiles
export type Routine = 'sol' | 'sonnet'
export type Stage = 'planner' | 'worker' | 'specReview' | 'audit' | 'verify'
export type Selection = { model: Model; reason: string; pinned: boolean }
export type Routing = { complexity?: 'routine' | 'complex'; reason?: string; overrides?: Partial<Record<Stage, Model>> }
type Preferences = { planner?: 'opus' | 'astra'; routine?: Routine }
export function preferences(repo: string): Preferences {
  const file = readJson<{ defaults?: Preferences; projects?: Record<string, Preferences> }>(
    join(clydeHome(), 'routing.json'),
  )
  return { ...file?.defaults, ...file?.projects?.[repo] }
}
export function setPreference(repo: string, key: string, model: string) {
  if (
    !((key === 'planner' && ['opus', 'astra'].includes(model)) ||
      (key === 'routine' && ['sol', 'sonnet'].includes(model)))
  ) throw new Error('Invalid project preference')
  const path = join(clydeHome(), 'routing.json')
  const file = readJson<{ defaults?: Preferences; projects?: Record<string, Preferences> }>(path) ?? {}
  file.projects ??= {}
  file.projects[repo] = { ...file.projects[repo], [key]: model }
  writeJson(path, file, 0o600)
}

export function validateRouting(policy?: Routing) {
  if (policy === undefined) return
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('routing must be an object')
  if (policy.complexity !== undefined && !['routine', 'complex'].includes(policy.complexity)) {
    throw new Error('invalid routing complexity')
  }
  for (const [stage, model] of Object.entries(policy.overrides ?? {})) {
    if (!['planner', 'worker', 'specReview', 'audit', 'verify'].includes(stage) || !Object.hasOwn(profiles, model)) {
      throw new Error('unknown stage or model override')
    }
    if ((stage === 'worker' || stage === 'planner') && model === 'fable') {
      throw new Error('Fable is a read-only reviewer')
    }
  }
}
type Window = { id: string; remainingPct?: number; resetsAt?: string }
type Report = { sourceId: string; report?: { status: string; windows?: Window[] } }
export function inferRouting(description: string): Routing {
  const risk =
    /\b(data migration|schema migration|backward compatib(?:le|ility)|persisted.data compatibility|concurrency|race condition|permission boundary|cross.service contract)\b/i
      .exec(description)
  return risk ? { complexity: 'complex', reason: 'Preserve ' + risk[0] } : { complexity: 'routine' }
}
export async function usage(): Promise<Report[]> {
  const result = await paseo(['usage'], 4000)
  return result.code === 0 && Array.isArray(result.json) ? result.json : []
}
function windows(reports: Report[], model: Routine) {
  const accounts = reports.filter((r) => r?.sourceId === profiles[model].backend && r.report?.status === 'available')
  const result = new Map<string, number>()
  if (accounts.length !== 1) return result
  for (const w of accounts[0].report?.windows ?? []) {
    if (w.resetsAt && Date.parse(w.resetsAt) <= Date.now()) continue
    if (typeof w.remainingPct !== 'number' || w.remainingPct < 0 || w.remainingPct > 100) continue
    if (['five_hour', 'weekly'].includes(w.id) || (model === 'sonnet' && w.id === 'weekly_model_sonnet')) {
      result.set(w.id, w.remainingPct)
    }
  }
  return result
}

export function carbonAuditor(catalog: unknown): Selection {
  const exposed = Array.isArray(catalog) && catalog.some((model) => model?.id === profiles.orchestrator.model)
  return exposed ? { model: 'orchestrator', reason: 'Paseo exposes Orchestrator (Carbon)', pinned: false } : {
    model: 'carbon',
    reason: 'Carbon High is the default without a host-advertised Carbon orchestrator',
    pinned: false,
  }
}

export function select(stage: Stage, policy: Routing, prefs: Preferences, reports: Report[] = []): Selection {
  const override = policy.overrides?.[stage]
  if (override) return { model: override, pinned: true, reason: 'Requested for this stage' }
  const choice = (model: Model, reason: string) => ({ model, reason, pinned: false })
  if (stage === 'planner') return choice(prefs.planner === 'astra' ? 'astra' : 'opus', 'Planner preference')
  if (stage === 'audit') return choice('carbon', 'Independent audit of the final revision')
  if (stage !== 'worker') return choice('fable', 'Read-only review')
  if (policy.complexity === 'complex') return choice('opus', policy.reason || 'Complex implementation')
  const sol = windows(reports, 'sol'), sonnet = windows(reports, 'sonnet')
  const exhausted = (quotas: Map<string, number>) => [...quotas.values()].includes(0)
  if (exhausted(sol) && exhausted(sonnet)) throw new Error('Both routine workers have exhausted their usage windows')
  if (exhausted(sol)) return choice('sonnet', 'Sol has exhausted its usage window')
  if (exhausted(sonnet)) return choice('sol', 'Sonnet has exhausted its usage window')
  const periods = ['five_hour', 'weekly'].filter((key) => sol.has(key) || sonnet.has(key))
  if (periods.length && periods.every((key) => sol.has(key) && sonnet.has(key))) {
    const solRoom = Math.min(...sol.values()), sonnetRoom = Math.min(...sonnet.values())
    if (solRoom !== sonnetRoom) {
      return choice(solRoom > sonnetRoom ? 'sol' : 'sonnet', 'More remaining provider allowance')
    }
  }
  return choice(prefs.routine === 'sonnet' ? 'sonnet' : 'sol', 'Routine worker preference')
}
