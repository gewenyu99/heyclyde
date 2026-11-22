/**
 * Unit tests of R70 (#75), run with `deno test`: pure permission rules, realm equivalence, project slug matching,
 * explicit filters vs hard ceilings, quest permissions, and write.ts legacy makeId/digest parity. No database.
 */
import assert from 'node:assert/strict'
import {
  accessDeniedReason,
  agentProjectsOf,
  type AgentScope,
  allowedRealms,
  canReadEntry,
  type EntryFilter,
  type EntryMeta,
  entryWhereClauses,
  messageAgentMatches,
  normalizeComputer,
  normalizeProjectSlug,
  projectMatches,
  questPermitted,
  questWhereSql,
} from '../../../memory/supabase/functions/memory/permissions.ts'
import { TOOLS } from '../../../memory/supabase/functions/memory/mcp.ts'
import { annotateQuestsForViewer, questLine } from '../../../memory/supabase/functions/memory/quests.ts'
import { digest, makeId, Refused, resolveEntryDefaults, validate } from '../../../memory/supabase/functions/memory/write.ts'

const agent = (over: Partial<NonNullable<AgentScope>> = {}): NonNullable<AgentScope> => ({
  name: 'a-work',
  context: 'work',
  computer: 'work-laptop',
  projects: [],
  agentType: 'coding',
  strictProjects: false,
  sessionRepo: null,
  principal: 'work-laptop',
  ...over,
})

const entry = (over: Partial<EntryMeta> = {}): EntryMeta => ({
  category: 'general',
  context: 'general',
  transferability: 'general',
  project_slug: null,
  computer: null,
  pattern: 'observations',
  scope: 'global',
  ...over,
})

Deno.test('R70 allowedRealms treats home and personal as one realm, isolates work and hobby, and opens both/null', () => {
  assert.equal(allowedRealms('both'), null)
  assert.equal(allowedRealms(null), null)
  assert.deepEqual([...allowedRealms('work')!].sort(), ['work'])
  assert.deepEqual([...allowedRealms('hobby')!].sort(), ['hobby'])
  assert.deepEqual([...allowedRealms('home')!].sort(), ['home', 'personal'])
  assert.deepEqual([...allowedRealms('personal')!].sort(), ['home', 'personal'])
})

Deno.test('R70 projectMatches matches exact or single owner/repo basename without substring or cross-org collisions', () => {
  assert.equal(projectMatches('Clyde', 'clyde'), true)
  assert.equal(projectMatches('clyde', 'gewenyu99/like-vincent'), false)
  assert.equal(projectMatches('clyde', 'gewenyu99/clyde'), true)
  assert.equal(projectMatches('gewenyu99/clyde', 'Clyde'), true)
  assert.equal(projectMatches('org-a/clyde', 'org-b/clyde'), false)
  assert.equal(projectMatches('pennywhistle', 'clyde'), false)
  assert.equal(projectMatches('clyde', 'clyde-work'), false)
  assert.equal(projectMatches('', 'clyde'), false)
  assert.equal(projectMatches(null, 'clyde'), false)
})

Deno.test('R70 canReadEntry isolates work, home/personal and hobby while allowing general knowledge everywhere', () => {
  const work = agent({ name: 'w', context: 'work' })
  const home = agent({ name: 'h', context: 'home' })
  const personal = agent({ name: 'p', context: 'personal' })
  const hobby = agent({ name: 'hb', context: 'hobby' })
  const both = agent({ name: 'b', context: 'both' })

  const eGeneral = entry({ context: 'general', transferability: 'general' })
  const eWorkCross = entry({ context: 'work', transferability: 'general' })
  const eWork = entry({ context: 'work', transferability: 'context' })
  const eHome = entry({ context: 'home', transferability: 'context' })
  const ePersonal = entry({ context: 'personal', transferability: 'context' })
  const eHobby = entry({ context: 'hobby', transferability: 'context' })

  for (const viewer of [work, home, personal, hobby, both, null]) {
    assert.equal(canReadEntry(viewer, eGeneral), true)
    assert.equal(canReadEntry(viewer, eWorkCross), true)
  }

  assert.equal(canReadEntry(work, eWork), true)
  assert.equal(canReadEntry(work, eHome), false)
  assert.equal(canReadEntry(work, ePersonal), false)
  assert.equal(canReadEntry(work, eHobby), false)

  assert.equal(canReadEntry(home, eHome), true)
  assert.equal(canReadEntry(home, ePersonal), true)
  assert.equal(canReadEntry(home, eWork), false)
  assert.equal(canReadEntry(home, eHobby), false)

  assert.equal(canReadEntry(personal, eHome), true)
  assert.equal(canReadEntry(personal, ePersonal), true)
  assert.equal(canReadEntry(personal, eWork), false)

  assert.equal(canReadEntry(hobby, eHobby), true)
  assert.equal(canReadEntry(hobby, eWork), false)
  assert.equal(canReadEntry(hobby, eHome), false)

  for (const e of [eWork, eHome, ePersonal, eHobby]) {
    assert.equal(canReadEntry(both, e), true)
    assert.equal(canReadEntry(null, e), true)
  }

  // Explicit context filter NEVER bypasses hard realm ceiling.
  assert.equal(canReadEntry(work, eHome, { context: 'home' }), false)
  assert.equal(canReadEntry(home, eWork, { context: 'work' }), false)
  assert.equal(canReadEntry(hobby, eWork, { context: 'all' }), false)
})

Deno.test('R70 canReadEntry enforces project and computer isolation and strict_projects', () => {
  const clyde = entry({ context: 'hobby', transferability: 'project', project_slug: 'gewenyu99/clyde' })
  const penny = entry({ context: 'hobby', transferability: 'project', project_slug: 'pennywhistle' })
  const workClyde = entry({ context: 'work', transferability: 'project', project_slug: 'clyde' })
  const laptopOnly = entry({ context: 'hobby', transferability: 'computer', computer: 'work-laptop' })
  const miniOnly = entry({ context: 'hobby', transferability: 'computer', computer: 'mac-mini' })

  const strict = agent({ context: 'hobby', projects: ['clyde'], computer: 'work-laptop', strictProjects: true })
  assert.equal(canReadEntry(strict, clyde), true)
  assert.equal(canReadEntry(strict, penny), false)
  assert.equal(canReadEntry(strict, penny, { project: 'pennywhistle' }), false, 'strictProjects ignores explicit project filter')
  assert.equal(canReadEntry(strict, workClyde), false, 'realm ceiling beats matching project slug')
  assert.equal(canReadEntry(strict, laptopOnly), true)
  assert.equal(canReadEntry(strict, miniOnly), false)

  const strictEmpty = agent({ context: 'hobby', projects: [], strictProjects: true })
  assert.equal(canReadEntry(strictEmpty, clyde), false)

  const relaxed = agent({ context: 'hobby', projects: ['clyde'], computer: null, principal: 'mac-mini', strictProjects: false })
  assert.equal(canReadEntry(relaxed, penny), true, 'project labels are advisory context when strictProjects is false')
  assert.equal(canReadEntry(relaxed, penny, { project: 'pennywhistle' }), true, 'explicit project filter still matches in allowed realm')
  assert.equal(canReadEntry(relaxed, clyde, { project: 'pennywhistle' }), false, 'explicit project filter still narrows')
  assert.equal(canReadEntry(relaxed, workClyde), false, 'realm ceiling still applies to non-strict agents')
  assert.equal(canReadEntry(relaxed, laptopOnly), false, 'falls back to principal when computer is null')
  assert.equal(canReadEntry(relaxed, miniOnly), true)

  const relaxedSql = entryWhereClauses(fakeDb, 'e', relaxed).map((c: Frag) => c.text).join(' AND ')
  assert.ok(relaxedSql.includes("e.transferability <> 'project' or e.project_slug is not null"), relaxedSql)
  assert.ok(!relaxedSql.includes('regexp_replace'), 'non-strict agent projects do not emit SQL project visibility wall')

  const withRepo = agent({ context: 'hobby', projects: [], sessionRepo: 'clyde', strictProjects: true })
  assert.equal(canReadEntry(withRepo, clyde), true)
  assert.equal(canReadEntry(withRepo, penny), false)
})

Deno.test('R70 canReadEntry filters by category, context, project and transferability', () => {
  const billing = entry({ category: 'billing', pattern: 'observations', context: 'work', transferability: 'context', project_slug: 'acme-api' })
  const arch = entry({ category: 'architecture', pattern: 'decisions', context: 'work', transferability: 'context', project_slug: 'acme-api' })
  const viewer = agent({ context: 'work', projects: ['acme-api'] })

  const match: EntryFilter = { category: 'billing', context: 'work', project: 'acme-api', transferability: 'context' }
  assert.equal(canReadEntry(viewer, billing, match), true)
  assert.equal(canReadEntry(viewer, arch, match), false)
  assert.equal(canReadEntry(viewer, arch, { category: 'decisions' }), true)
  assert.equal(canReadEntry(viewer, billing, { transferability: 'project' }), false)
  assert.equal(canReadEntry(viewer, billing, { context: 'general' }), false)
})

Deno.test('R70 questPermitted checks realm, project, computer and agent_type', () => {
  const aClyde = agent({ name: 'a-clyde', context: 'hobby', projects: ['clyde'], computer: 'macbook-pro', agentType: 'coding', strictProjects: true })

  assert.equal(questPermitted(aClyde, { context: 'hobby', project: 'clyde', computer: null, agent_type: null }).ok, true)
  assert.equal(questPermitted(aClyde, { context: 'both', project: 'clyde', computer: 'MacBook-Pro', agent_type: 'coding' }).ok, true)
  assert.equal(questPermitted(aClyde, { context: 'personal', project: 'pennywhistle', computer: null, agent_type: null }).ok, false)
  assert.equal(questPermitted(aClyde, { context: 'work', project: 'clyde', computer: null, agent_type: null }).ok, false)
  assert.equal(questPermitted(aClyde, { context: 'hobby', project: 'pennywhistle', computer: null, agent_type: null }).ok, false)
  assert.equal(questPermitted(aClyde, { context: 'hobby', project: 'clyde', computer: 'mac-mini', agent_type: null }).ok, false)
  assert.equal(questPermitted(aClyde, { context: 'hobby', project: 'clyde', computer: null, agent_type: 'research' }).ok, false)

  const homeAgent = agent({ context: 'home', projects: [] })
  assert.equal(questPermitted(homeAgent, { context: 'personal', project: null, computer: null, agent_type: null }).ok, true)
})

Deno.test('R70 write.ts validate preserves legacy digest/makeId and rejects invalid R70 metadata', async () => {
  const legacyPayload = {
    pattern: 'preferences',
    title: 'Prefer 90C oolong',
    body: 'Brew oolong at 90C.',
    scope: 'global',
    evidence: 'Wen prefers 90C.',
    kind: null,
    evidence_event: null,
    evidence_kind: 'summary',
    authority: 'draft',
    sensitivity: 'normal',
    lang: 'en',
    project: null,
    valid_from: null,
    links: [],
    supersedes: [],
    blobs: [],
  }
  const expectedDigest = await digest(legacyPayload)
  const expectedId = makeId(legacyPayload, expectedDigest)
  const validated = await validate(legacyPayload, 'agent', 'legacy-bot')
  assert.equal(validated.digest, expectedDigest)
  assert.equal(validated.id, expectedId)

  for (const bad of [
    { category: 'Bad Category!' },
    { context: 'mars' },
    { transferability: 'org' },
    { project_slug: '../escape' },
    { computer: 'c'.repeat(65) },
  ]) {
    await assert.rejects(() => validate({ ...legacyPayload, ...bad }, 'agent', 'legacy-bot'), Refused, JSON.stringify(bad))
  }
})

Deno.test('R70 resolveEntryDefaults infers category, context, transferability, project_slug and computer', () => {
  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'preferences', scope: 'global' }, 'clyde-test', null, null),
    { category: 'preferences', context: 'general', transferability: 'general', project_slug: null, computer: 'clyde-test' },
  )
  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'decisions', scope: 'global' }, 'work-mac', {
      agent: 'clyde-work', context: 'work', session: 's1', computer: 'macbook-pro', projects: ['acme-api'],
    }, null),
    { category: 'architecture', context: 'work', transferability: 'project', project_slug: 'acme-api', computer: 'macbook-pro' },
  )
  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'observations', scope: 'global' }, 'work-mac', {
      agent: 'clyde-work', context: 'work', session: 's1', projects: ['a', 'b'],
    }, null),
    { category: 'general', context: 'work', transferability: 'context', project_slug: null, computer: 'work-mac' },
  )
  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'reactions', scope: 'repo:gewenyu99/like-vincent', transferability: 'general' }, 'box', {
      agent: 'a', context: 'hobby', session: 's1',
    }, null),
    { category: 'workflow', context: 'general', transferability: 'general', project_slug: 'gewenyu99/like-vincent', computer: 'box' },
  )
  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'decisions', scope: 'global', context: 'work' }, 'box', {
      agent: 'a', context: 'both', session: 's1',
    }, null),
    { category: 'architecture', context: 'work', transferability: 'context', project_slug: null, computer: 'box' },
  )
})

Deno.test('R70 normalizeProjectSlug, normalizeComputer, messageAgentMatches and accessDeniedReason', () => {
  assert.equal(normalizeProjectSlug(' /Gewenyu99/Like-Vincent/ '), 'gewenyu99/like-vincent')
  assert.equal(normalizeProjectSlug('../etc/passwd'), null)
  assert.equal(normalizeComputer('  macbook-pro  '), 'macbook-pro')
  assert.equal(normalizeComputer('x'.repeat(65)), null)

  assert.equal(messageAgentMatches({ name: 'a', context: 'hobby', projects: ['gewenyu99/clyde'] }, 'hobby', 'clyde'), true)
  assert.equal(messageAgentMatches({ name: 'b', context: 'work', projects: ['clyde'] }, 'hobby', 'clyde'), false)
  assert.equal(messageAgentMatches({ name: 'c', context: 'hobby', projects: ['pennywhistle'] }, 'hobby', 'clyde'), false)

  const msg = accessDeniedReason(agent({ name: 'a-work', context: 'work' }), entry({ context: 'home', transferability: 'context' }))
  assert.match(msg, /Access denied:.*home.*outside a-work's permissions/)
})

type Frag = { text: string; vals: unknown[] }
const fakeDb: any = Object.assign(
  (strings: TemplateStringsArray, ...values: unknown[]): Frag => {
    let text = ''
    const vals: unknown[] = []
    for (let i = 0; i < strings.length; i++) {
      text += strings[i]
      if (i < values.length) {
        const v = values[i] as any
        if (v && typeof v === 'object' && 'text' in v && 'vals' in v) {
          text += v.text
          vals.push(...v.vals)
        } else {
          vals.push(v)
          text += `$${vals.length}`
        }
      }
    }
    return { text, vals }
  },
  { unsafe: (s: string): Frag => ({ text: s, vals: [] }) },
)

Deno.test('R70 entryWhereClauses and questWhereSql emit parameterized realm, project and filter predicates', () => {
  assert.equal(entryWhereClauses(fakeDb, 'e', null).length, 0)
  const clauses = entryWhereClauses(
    fakeDb,
    'e',
    agent({ context: 'hobby', projects: ['clyde'], computer: 'macbook-pro', strictProjects: true }),
    { category: 'billing', context: 'home', project: 'pennywhistle', transferability: 'context' },
  )
  const sqlText = clauses.map((c: Frag) => c.text).join(' AND ')
  const allVals = clauses.flatMap((c: Frag) => c.vals)
  assert.ok(sqlText.includes("e.transferability = 'general' or e.context = 'general'"), sqlText)
  assert.ok(sqlText.includes("e.context in ('home', 'personal')"), sqlText)
  assert.ok(allVals.includes('billing') && allVals.includes('clyde') && allVals.includes('macbook-pro'), JSON.stringify(allVals))

  const qFrag: Frag = questWhereSql(fakeDb, 'q', agent({ context: 'hobby', projects: ['clyde'], strictProjects: true }), null)
  assert.ok(qFrag.text.includes("q.context = 'both'"), qFrag.text)
  assert.ok(qFrag.vals.includes('clyde'), JSON.stringify(qFrag.vals))
})

Deno.test('R70 TOOLS keeps 18 tools and legacy required schemas', () => {
  assert.equal(TOOLS.length, 19)
  const reg = TOOLS.find((t) => t.name === 'register_agent')!
  assert.deepEqual(reg.inputSchema.required, ['name', 'context', 'surface', 'description'])
  for (const prop of ['projects', 'computer', 'type', 'strict_projects']) {
    assert.ok(prop in reg.inputSchema.properties, `register_agent missing ${prop}`)
  }
  const rec = TOOLS.find((t) => t.name === 'recall')!
  for (const prop of ['category', 'context', 'project', 'transferability']) {
    assert.ok(prop in rec.inputSchema.properties, `recall missing ${prop}`)
  }
  const rem = TOOLS.find((t) => t.name === 'remember')!
  assert.deepEqual(rem.inputSchema.required, ['pattern', 'title', 'body', 'evidence'])
  for (const prop of ['category', 'context', 'transferability', 'project_slug', 'computer']) {
    assert.ok(prop in rem.inputSchema.properties, `remember missing ${prop}`)
  }
})

Deno.test('R70 agentProjectsOf ignores sessionRepo when strict_projects and declared projects are set', () => {
  assert.deepEqual(
    agentProjectsOf(agent({ projects: ['clyde'], strictProjects: true, sessionRepo: 'gewenyu99/pennywhistle' })),
    ['clyde'],
  )
  assert.deepEqual(
    agentProjectsOf(agent({ projects: [], strictProjects: true, sessionRepo: 'gewenyu99/pennywhistle' })),
    ['gewenyu99/pennywhistle'],
  )
  assert.deepEqual(
    agentProjectsOf(agent({ projects: ['clyde'], strictProjects: false, sessionRepo: 'gewenyu99/pennywhistle' })),
    ['clyde', 'gewenyu99/pennywhistle'],
  )
  const strictClyde = agent({ projects: ['clyde'], strictProjects: true, sessionRepo: 'gewenyu99/pennywhistle' })
  assert.equal(canReadEntry(strictClyde, entry({ transferability: 'project', project_slug: 'pennywhistle' })), false)
  assert.equal(canReadEntry(strictClyde, entry({ transferability: 'project', project_slug: 'clyde' })), true)
})

Deno.test('R70 project/computer transferability with missing identifiers fails closed and run: stays context/general', () => {
  const registered = agent({ context: 'work', projects: ['clyde'], computer: 'macbook-pro' })
  assert.equal(canReadEntry(registered, entry({ transferability: 'project', project_slug: null })), false)
  assert.equal(canReadEntry(registered, entry({ transferability: 'computer', computer: null })), false)
  assert.equal(canReadEntry(null, entry({ transferability: 'project', project_slug: null })), true)
  assert.equal(canReadEntry(null, entry({ transferability: 'computer', computer: null })), true)

  const nonStrictEmpty = entryWhereClauses(fakeDb, 'e', agent({ projects: [], strictProjects: false })).map((c: Frag) => c.text).join(' AND ')
  assert.ok(nonStrictEmpty.includes("e.transferability <> 'project' or e.project_slug is not null"), nonStrictEmpty)
  assert.ok(nonStrictEmpty.includes("e.computer is not null"), nonStrictEmpty)
  assert.ok(!nonStrictEmpty.includes('e.project_slug is null'), nonStrictEmpty)

  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'observations', scope: 'run:abc' }, 'box', {
      agent: 'a', context: 'work', session: 's1',
    }, null),
    { category: 'general', context: 'work', transferability: 'context', project_slug: null, computer: 'box' },
  )
  assert.deepEqual(
    resolveEntryDefaults({ pattern: 'observations', scope: 'run:abc' }, 'anyone', null, null),
    { category: 'general', context: 'general', transferability: 'general', project_slug: null, computer: null },
  )
})

Deno.test('annotateQuestsForViewer keeps all owner quests visible, sorts matches first on open, and tags mismatches', () => {
  const viewer = {
    name: 'antigravity',
    family: 'antigravity',
    context: 'work',
    type: 'coding',
    agentType: 'coding',
    projects: ['gewenyu99/heyclyde'],
    repos: ['gewenyu99/heyclyde'],
    strictProjects: true,
    computer: 'macbook',
  }
  const qOther = {
    id: 73,
    title: 'MedDispute task',
    done_when: 'Fixed.',
    priority: 'high',
    context: 'personal',
    project: 'med-dispute',
    assignee: 'gemini',
    posted_by: 'claude',
    state: 'open',
    tags: ['gemini'],
    target: {},
  }
  const qMine = {
    id: 72,
    title: 'Clyde fix',
    done_when: 'Green.',
    priority: 'normal',
    context: 'work',
    project: 'gewenyu99/heyclyde',
    assignee: 'any',
    posted_by: 'claude',
    state: 'open',
    tags: ['clyde'],
    target: {},
  }

  // Open listing shows both quests, puts the matching quest first, and tags the non-matching quest as other.
  const open = annotateQuestsForViewer([qOther, qMine], viewer, { show: 'open' })
  assert.deepEqual(open.map((x) => x.row.id), [72, 73])
  assert.equal(open[0].match?.ok, true)
  assert.equal(open[1].match?.ok, false)
  const otherLine = questLine(open[1].row, open[1].match)
  assert.ok(otherLine.includes('#73') && otherLine.includes('other:'), otherLine)
  const mineLine = questLine(open[0].row, open[0].match)
  assert.ok(mineLine.includes('#72') && !mineLine.includes('other:'), mineLine)

  // Show=all preserves newest-first order while keeping the advisory tag.
  const all = annotateQuestsForViewer([qOther, qMine], viewer, { show: 'all' })
  assert.deepEqual(all.map((x) => x.row.id), [73, 72])
  assert.equal(all[0].match?.ok, false)

  // Explicit project filter still narrows to that project.
  const filtered = annotateQuestsForViewer([qOther, qMine], viewer, { show: 'open', projectFilter: 'med-dispute' })
  assert.deepEqual(filtered.map((x) => x.row.id), [73])
})
