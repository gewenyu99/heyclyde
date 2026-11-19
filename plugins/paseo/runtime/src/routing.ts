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
  neon: { backend: 'antigravity', model: 'gemini-4-neon-high', effort: 'high' },
  fable: { backend: 'claude', model: 'claude-fable-5-2', effort: 'high' },
  orchestrator: { backend: 'antigravity', model: 'gemini-pro-orchestrator', effort: 'high' },
  carbon: { backend: 'antigravity', model: 'gemini-4-carbon-high', effort: 'high' },
} satisfies Record<string, Rung>

export type Model = keyof typeof profiles
export type Routine = 'sol' | 'sonnet'
export type Stage = 'planner' | 'worker' | 'specReview' | 'audit' | 'verify'
export type Selection = { model: Model; resolvedModel?: string; reason: string; pinned: boolean }
export type CatalogEntry = { id?: string }
export type ResolvedRoute = { selection: Selection; rung: Rung }
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

const STAGE_FALLBACKS: Partial<Record<Stage, Partial<Record<Model, Model[]>>>> = {
  planner: { opus: ['astra'], astra: ['opus'] },
  worker: { sonnet: ['sol'], sol: ['sonnet'] },
  specReview: { fable: ['sonnet', 'sol'], sonnet: ['sol'] },
  verify: { fable: ['sonnet', 'sol'], sonnet: ['sol'] },
  audit: { orchestrator: ['carbon'] },
}

function parseFamily(id: string): { key: string; ver: number[]; hasWindow: boolean } | null {
  const claude = /^(claude-(?:opus|sonnet|fable))-([\d.-]+)(\[[^\]]+\])?$/i.exec(id)
  if (claude) {
    return { key: claude[1].toLowerCase(), ver: claude[2].split(/[.-]/).map(Number), hasWindow: Boolean(claude[3]) }
  }
  const gpt = /^(gpt)-([\d.]+)-(sol|astra)$/i.exec(id)
  if (gpt) return { key: `gpt-${gpt[3].toLowerCase()}`, ver: gpt[2].split('.').map(Number), hasWindow: false }
  const gem = /^(gemini)-([\d.]+)-(neon|carbon|argon|hydrogen)-(low|medium|high|xhigh)$/i.exec(id)
  if (gem) {
    return {
      key: `gemini-${gem[3].toLowerCase()}-${gem[4].toLowerCase()}`,
      ver: gem[2].split('.').map(Number),
      hasWindow: false,
    }
  }
  return null
}

function compareVer(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

function familyMatch(baseModel: string, ids: string[]): string | undefined {
  const target = parseFamily(baseModel)
  if (!target) return undefined
  const candidates = ids
    .map((id) => ({ id, info: parseFamily(id) }))
    .filter((entry): entry is { id: string; info: NonNullable<ReturnType<typeof parseFamily>> } =>
      Boolean(entry.info) && entry.info.key === target.key && entry.info.hasWindow === target.hasWindow,
    )
    .sort((a, b) => compareVer(b.info.ver, a.info.ver))
  if (candidates.length > 0) return candidates[0].id
  if (target.key === 'claude-fable' && ids.includes('fable')) return 'fable'
  return undefined
}

function idsFor(entries?: CatalogEntry[]): string[] {
  if (!Array.isArray(entries)) return []
  return entries.map((e) => e?.id).filter((id): id is string => typeof id === 'string' && id.length > 0)
}

/** Return candidate secondary backends for a stage/model when its primary catalog omits the model. */
export function fallbackBackendsFor(stage: Stage, model: Model): Rung['backend'][] {
  const seen = new Set<Rung['backend']>()
  const primary = profiles[model].backend
  for (const alt of STAGE_FALLBACKS[stage]?.[model] ?? []) {
    const b = profiles[alt].backend
    if (b !== primary) seen.add(b)
  }
  return [...seen]
}

/** Resolve a selected model against live provider catalogs, falling back cleanly when unavailable. */
export function resolveCatalogRung(
  stage: Stage,
  selection: Selection,
  catalogs: Partial<Record<Rung['backend'], CatalogEntry[]>>,
): ResolvedRoute {
  const base = profiles[selection.model]
  const primaryIds = idsFor(catalogs[base.backend])
  if (primaryIds.length === 0) return { selection, rung: base }
  if (primaryIds.includes(base.model)) return { selection, rung: base }

  const sameFamily = familyMatch(base.model, primaryIds)
  if (sameFamily) {
    return {
      selection: {
        ...selection,
        resolvedModel: sameFamily,
        reason: `${selection.reason} (${base.model} unavailable, using ${sameFamily})`,
      },
      rung: { ...base, model: sameFamily },
    }
  }

  if (!selection.pinned) {
    for (const alt of STAGE_FALLBACKS[stage]?.[selection.model] ?? []) {
      const altRung = profiles[alt]
      const altIds = idsFor(catalogs[altRung.backend])
      if (altIds.length === 0) continue
      const matched = altIds.includes(altRung.model) ? altRung.model : familyMatch(altRung.model, altIds)
      if (!matched) continue
      return {
        selection: {
          ...selection,
          model: alt,
          ...(matched !== altRung.model ? { resolvedModel: matched } : {}),
          reason: `${selection.reason} (${base.model} unavailable, using ${matched})`,
        },
        rung: { ...altRung, model: matched },
      }
    }
  }

  return { selection, rung: base }
}
