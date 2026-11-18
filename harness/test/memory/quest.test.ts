/**
 * Tier 3: R62 (#67), quest routing by target (types, harness, device_id/device, repo, context) through one matcher
 * (`function questMatches` in memory/supabase/functions/memory/quest.ts) and GET /me/quests unmatched flagging.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { join } from 'node:path'
import { repoRoot } from '../../src/config.ts'
import { request } from '../../src/request.ts'
import { jwt } from './auth.ts'
import { bearer, nonce } from './bed.ts'
import { exec, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

let memory: RealMemory

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
})

after(async () => {
  await memory?.close()
})

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

function createOwner(tag: string) {
  const id = randomUUID()
  const email = `r62-${tag}-${nonce()}@example.com`
  const deviceName = `r62-${tag}-box`
  const token = `r62-tok-${tag}-${randomBytes(10).toString('hex')}`
  exec(`insert into memory.allowed_email (email, plan) values ('${email}', 'owner');
    insert into memory.account (owner_id, email, email_confirmed) values ('${id}', '${email}', true);
    insert into memory.device (name, token_sha256, owner_id) values ('${deviceName}', '${sha256(token)}', '${id}');`)
  const signInJwt = () => jwt({ sub: id, email, jti: randomUUID() })
  return { id, email, token, signInJwt }
}

async function openAgent(token: string, client: string, reg: Record<string, unknown>) {
  const init = await request('POST', `${memory.url}/mcp`, {
    headers: bearer(token),
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: client } } },
    timeoutMs: 30_000,
  })
  assert.equal(init.status, 200, init.text)
  const session = String(init.headers['mcp-session-id'])
  const send = async (name: string, args: Record<string, unknown>) => {
    const r = await request('POST', `${memory.url}/mcp`, {
      headers: { ...bearer(token), 'mcp-session-id': session },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } },
      timeoutMs: 30_000,
    })
    assert.equal(r.status, 200, r.text)
    const res = JSON.parse(r.text).result
    return { text: res.content[0].text as string, error: Boolean(res.isError) }
  }
  const r = await send('register_agent', reg)
  assert.equal(r.error, false, r.text)
  return send
}

test('routing by type and repo', { skip: SKIP }, async () => {
  const o = createOwner('route')
  const tok2 = `r62-tok-res-${randomBytes(10).toString('hex')}`
  exec(`insert into memory.device (name, token_sha256, owner_id) values ('r62-res-box', '${sha256(tok2)}', '${o.id}');`)

  const coder = await openAgent(o.token, 'claude-code', {
    name: `r62-coder-${nonce()}`,
    nickname: 'r62coder',
    type: 'coding',
    repos: ['gewenyu99/like-vincent'],
    context: 'work',
    surface: 'claude-code',
    description: 'Coding agent on like-vincent.',
  })
  const researcher = await openAgent(tok2, 'claude-code', {
    name: `r62-res-${nonce()}`,
    nickname: 'r62res',
    type: 'research',
    repos: ['gewenyu99/like-vincent'],
    context: 'work',
    surface: 'claude-code',
    description: 'Research agent.',
  })

  const tag = `r62${nonce()}`
  const posted = await coder('post_quest', {
    title: `Targeted quest ${tag}`,
    brief: 'Fix quest matcher edge case.',
    done_when: 'All quest tests pass.',
    tags: [tag],
    context: 'work',
    target: { types: ['coding'], repo: 'gewenyu99/like-vincent' },
  })
  assert.equal(posted.error, false, posted.text)
  const qid = Number(/^Posted quest #(\d+):/.exec(posted.text)![1])

  const coderList = await coder('list_quests', { tag })
  assert.equal(coderList.error, false, coderList.text)
  assert.ok(coderList.text.includes(`#${qid}`), coderList.text)

  const resList = await researcher('list_quests', { tag })
  assert.equal(resList.error, false, resList.text)
  assert.ok(!resList.text.includes(`#${qid}`), resList.text)

  const resClaim = await researcher('claim_quest', { id: qid })
  assert.equal(resClaim.error, true, resClaim.text)
  assert.ok(resClaim.text.toLowerCase().includes('type'), resClaim.text)
})

test('one matcher', () => {
  const dir = join(repoRoot(), 'memory', 'supabase', 'functions', 'memory')
  const out = execFileSync('grep', ['-rn', 'function questMatches', dir], { encoding: 'utf8' })
  const lines = out.split(/\r?\n/).filter(Boolean)
  assert.equal(lines.length, 1, out)
})

test('quests stay in their owner', { skip: SKIP }, async () => {
  const A = createOwner('own-a')
  const B = createOwner('own-b')
  const tokA2 = `r62-tok-a2-${randomBytes(10).toString('hex')}`
  const tokB2 = `r62-tok-b2-${randomBytes(10).toString('hex')}`
  exec(`insert into memory.device (name, token_sha256, owner_id) values ('r62-a2-box', '${sha256(tokA2)}', '${A.id}');
    insert into memory.device (name, token_sha256, owner_id) values ('r62-b2-box', '${sha256(tokB2)}', '${B.id}');`)

  const a1 = await openAgent(A.token, 'claude-code', { name: `r62-a1-${nonce()}`, type: 'coding', context: 'both', surface: 'claude-code', description: 'A1.' })
  const a2 = await openAgent(tokA2, 'codex-mcp-client', { name: `r62-a2-${nonce()}`, type: 'review', context: 'both', surface: 'codex', description: 'A2.' })
  const b1 = await openAgent(B.token, 'claude-code', { name: `r62-b1-${nonce()}`, type: 'coding', context: 'both', surface: 'claude-code', description: 'B1.' })
  const b2 = await openAgent(tokB2, 'codex-mcp-client', { name: `r62-b2-${nonce()}`, type: 'review', context: 'both', surface: 'codex', description: 'B2.' })

  const tag = `iso${nonce()}`
  const posted = await a1('post_quest', {
    title: `Owner A untargeted ${tag}`,
    brief: 'Open quest for any agent of A.',
    done_when: 'Seen only by A.',
    tags: [tag],
    context: 'both',
  })
  assert.equal(posted.error, false, posted.text)
  const qid = Number(/^Posted quest #(\d+):/.exec(posted.text)![1])

  for (const agent of [a1, a2]) {
    const l = await agent('list_quests', { tag })
    assert.ok(l.text.includes(`#${qid}`), `expected #${qid} for A: ${l.text}`)
  }
  for (const agent of [b1, b2]) {
    const l = await agent('list_quests', { tag })
    assert.ok(!l.text.includes(`#${qid}`), `unexpected #${qid} for B: ${l.text}`)
  }
})

test('unmatched after 24 hours', { skip: SKIP }, async () => {
  const o = createOwner('unmatched')
  const coder = await openAgent(o.token, 'claude-code', {
    name: `r62-um-${nonce()}`,
    type: 'coding',
    repos: ['gewenyu99/heyclyde'],
    context: 'work',
    surface: 'claude-code',
    description: 'Only coding agent for owner.',
  })

  const tag = `um${nonce()}`
  const pOld = await coder('post_quest', {
    title: `Old unmatched ${tag}`,
    brief: 'Needs ops agent on missing repo.',
    done_when: 'Flagged after 24h.',
    tags: [tag],
    context: 'work',
    target: { types: ['ops'], repo: 'gewenyu99/missing-repo' },
  })
  const oldId = Number(/^Posted quest #(\d+):/.exec(pOld.text)![1])

  const pNew = await coder('post_quest', {
    title: `Fresh unmatched ${tag}`,
    brief: 'Needs ops agent created 23h ago.',
    done_when: 'Not flagged yet.',
    tags: [tag],
    context: 'work',
    target: { types: ['ops'], repo: 'gewenyu99/missing-repo' },
  })
  const newId = Number(/^Posted quest #(\d+):/.exec(pNew.text)![1])

  exec(`update memory.quest set created_at = now() - interval '25 hours' where id = ${oldId};
    update memory.quest set created_at = now() - interval '23 hours' where id = ${newId};`)

  const res = await request('GET', `${memory.url}/me/quests`, { headers: bearer(o.signInJwt()), timeoutMs: 30_000 })
  assert.equal(res.status, 200, res.text)
  const quests = JSON.parse(res.text).quests as { id: number; unmatched: boolean }[]
  const qOld = quests.find((q) => Number(q.id) === oldId)
  const qNew = quests.find((q) => Number(q.id) === newId)
  assert.ok(qOld && qNew, res.text)
  assert.equal(qOld.unmatched, true)
  assert.equal(qNew.unmatched, false)
})

test('site quests pass the judge', { skip: SKIP }, async () => {
  const o = createOwner('sitequest')
  const before = sql(`select count(*)::int as n from memory.quest where owner_id = '${o.id}'`)[0].n
  const res = await request('POST', `${memory.url}/me/quests`, {
    headers: bearer(o.signInJwt()),
    body: {
      title: 'Rotate credentials',
      brief: 'Use key AKIAIOSFODNN7EXAMPLE in production.',
      done_when: 'Rotated.',
    },
    timeoutMs: 30_000,
  })
  assert.equal(res.status, 422, res.text)
  const afterCount = sql(`select count(*)::int as n from memory.quest where owner_id = '${o.id}'`)[0].n
  assert.equal(afterCount, before)
})
