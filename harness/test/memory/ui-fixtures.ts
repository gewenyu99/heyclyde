/**
 * R67: tool results as the function returns them to a UI-capable chat app, one per card, for the headless render test and
 * the screenshots. Every string a person could have written carries XSS from ui-host.ts, so a card that let markup through
 * would show it.
 */
import { XSS } from './ui-host.ts'

const badge = { name: 'clyde-chat', context: 'work', surface: 'claude.ai', registered: true }
const result = (card: Record<string, unknown>, text = 'plain text the model reads') => ({ content: [{ type: 'text', text }], _meta: { 'clyde/card': card } })

const mem = (n: number, extra: Record<string, unknown> = {}) => ({
  id: `e-${n}`, title: `Deploys go through deploy.sh ${n}`, body: `Wen ships the memory function with \`cd memory && ./deploy.sh\`, which runs the version guard first. ${n === 1 ? XSS : ''}`,
  pattern: 'decisions', kind: 'fact', confidence: 0.86, verified: true, authority: 'draft', unreviewed: true, scope: 'global', valid_from: '2026-11-02',
  provenance: 'from codex on mac-mini in repo:like-vincent (work)', superseded_by: null, private: false, quote: null,
  artifacts: [{ name: 'deploy-notes.md', kind: 'document', size: 5120 }], trial: false, chance: null, ...extra,
})

export const RID = '0b6a1f9e-3c2d-4e5f-8a7b-9c0d1e2f3a4b'

export const FIXTURES: Record<string, unknown> = {
  recall: result({
    card: 'recall', version: 1, badge, retrieval_id: RID, query: `how do we deploy ${XSS}`, degraded: null, page: 'packet',
    items: [mem(1), mem(2, { kind: 'wen', confidence: 0.95, unreviewed: false, quote: `Never deploy without the guard ${XSS}`, artifacts: [] }),
      mem(3, { kind: 'observation', confidence: 0.41, trial: true, chance: 2, provenance: null })],
  }),
  entry: result({
    card: 'entry', version: 1, badge,
    entry: {
      ...mem(4, { provenance: 'from codex on oauth:claude-ai in repo:like-vincent (work) (you wrote this)' }),
      links: [
        { dir: 'to', type: 'supports', id: 'e-9', title: `The version guard ${XSS}` },
        { dir: 'to', type: 'part_of', id: 'hub-1', title: 'Notes by codex' },
      ],
      artifacts: [{ name: `plan${XSS}.md`, kind: 'document', media_type: 'text/markdown', size: 2048, sha256: 'a'.repeat(64) }],
    },
  }),
  remembered: result({
    card: 'remembered', version: 1, badge,
    entry: {
      ...mem(5, {
        confidence: 0.5, kind: 'observation', title: `Saved note \`a4c6f84\` ${XSS}`,
        provenance: 'from clyde-chat on oauth:claude-ai (work) (you wrote this)',
      }),
      links: [{ dir: 'to', type: 'part_of', id: 'hub-1', title: 'Notes by clyde-chat' }],
      artifacts: [],
    },
  }),
  artifact: result({
    card: 'artifact', version: 1, badge,
    artifact: { sha256: 'a'.repeat(64), name: 'deploy-notes.md', media_type: 'text/markdown', from: 0, to: 120, total: 400, url: null, next: 120, text: `# Deploy\n\n1. Run the guard.\n2. ${XSS}` },
  }),
  quests: result({
    card: 'quests', version: 1, badge, action: 'list_quests', show: 'all', head: '3 quests (work context).',
    quests: [
      { id: 12, title: `Fix the docs links ${XSS}`, brief: 'The docs links in the guide point at old pages.', done_when: 'Every link in the guide answers 200.', state: 'open', priority: 'high', context: 'work', tags: ['docs'], assignee: 'any', posted_by: 'clyde-work', claimed_by: null, lease_until: null, closed_at: null, evidence: null, result_entry: null },
      { id: 13, title: 'Pin the server hash', brief: 'Bump SERVER_VERSION and pin the hash.', done_when: 'version.test.ts passes.', state: 'claimed', priority: 'normal', context: 'work', tags: [], assignee: 'any', posted_by: 'codex', claimed_by: 'clyde-chat', lease_until: '2026-11-15T23:00:00Z', closed_at: null, evidence: null, result_entry: null },
      { id: 14, title: 'Write R47', brief: 'The quest board issue.', done_when: 'Issue #52 exists.', state: 'done', priority: 'low', context: 'both', tags: ['issues', 'r47'], assignee: 'codex', posted_by: 'clyde-work', claimed_by: 'codex', lease_until: null, closed_at: '2026-11-15T20:00:00Z', evidence: 'Issue #52 is open with 23 criteria.', result_entry: 'e-7' },
    ],
  }),
  agent: result({ card: 'agent', version: 1, badge, agent: { name: 'clyde-chat', context: 'work', surface: 'claude.ai', description: `Wen's chat agent ${XSS}`, since: '2026-11-15' } }),
  error: result({ card: 'quests', version: 1, badge, error: `Quest #12 is already claimed by codex ${XSS}` }, 'Quest #12 is already claimed by codex'),
}

/** What the cards' own tools/call get back. */
export const CALLS: Record<string, unknown> = {
  feedback: { content: [{ type: 'text', text: 'Logged.' }] },
  get_entry: FIXTURES.entry,
  get_blob: FIXTURES.artifact,
  claim_quest: result({ ...(FIXTURES.quests as any)._meta['clyde/card'], action: 'claim_quest', quests: [{ ...(FIXTURES.quests as any)._meta['clyde/card'].quests[0], state: 'claimed', claimed_by: 'clyde-chat', lease_until: '2026-11-15T23:00:00Z' }] }, 'Claimed quest #12: Fix the docs links.'),
}
