/**
 * Tier 3: R70 (#75), agent permissions (work/home/hobby realms, projects, computer, strict_projects),
 * per-session credential isolation, entry categorization, and quest/broadcast isolation against the real memory function.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { after, before, test } from 'node:test'
import { request } from '../../src/request.ts'
import { bearer, bedFor, idOf, marker, nonce, note } from './bed.ts'
import { waitFor } from '../helpers.ts'
import { apply, SKIP, sql, startRealMemory, type RealMemory } from './server.ts'

const MIGRATION = '20261116020000_agent_permissions_categories.sql'

let memory: RealMemory
let bed: ReturnType<typeof bedFor>

before(async () => {
  if (SKIP) return
  memory = await startRealMemory()
  bed = bedFor(memory)
})

after(async () => {
  await memory?.close()
})

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')
const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(', ') + ']'
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return '{' + Object.keys(o).sort().map((k) => `${JSON.stringify(k)}: ${canonical(o[k])}`).join(', ') + '}'
  }
  if (typeof v === 'string') return JSON.stringify(v)
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'number') return String(v)
  return v ? 'true' : 'false'
}
const legacyMakeId = (payload: Record<string, unknown>) => {
  const { id: _, ...rest } = payload
  const d = sha(canonical(rest))
  const head = slug(`${payload.scope ?? ''} ${payload.title ?? ''}`)
  return head ? `${head}-${d.slice(0, 8)}` : d.slice(0, 8)
}
const admin = (method: string, path: string, body?: unknown) =>
  request(method, `${memory.url}/api/v1${path}`, { headers: bearer(memory.adminToken), body, timeoutMs: 30_000 })

function newDevice(name: string): string {
  const token = `device-${randomBytes(8).toString('hex')}`
  sql(`insert into memory.device (name, token_sha256) values ('${name}', '${sha(token)}') on conflict (owner_id, name) do nothing`)
  return token
}

type Session = {
  id: string
  rpc: (method: string, params?: Record<string, unknown>) => Promise<any>
  send: (name: string, args?: Record<string, unknown>) => Promise<{ text: string; blocks: string[]; error: boolean; meta?: any }>
}

async function open(token = memory.token, client = 'claude-code'): Promise<Session> {
  const init = await bed.call('POST', '/mcp', bearer(token), {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', clientInfo: { name: client } },
  })
  assert.equal(init.status, 200, init.text)
  const id = String(init.headers['mcp-session-id'])
  const rpc = async (method: string, params: Record<string, unknown> = {}) => {
    const r = await bed.call('POST', '/mcp', { ...bearer(token), 'mcp-session-id': id }, { jsonrpc: '2.0', id: 2, method, params })
    assert.equal(r.status, 200, `${method}: ${r.text}`)
    return JSON.parse(r.text)
  }
  const send = async (name: string, args: Record<string, unknown> = {}) => {
    const res = (await rpc('tools/call', { name, arguments: args })).result
    return {
      text: res.content[0].text as string,
      blocks: res.content.map((c: any) => c.text as string),
      error: Boolean(res.isError),
      meta: res._meta,
    }
  }
  return { id, rpc, send }
}

async function registerAgent(args: Record<string, unknown>, token = memory.token, client = 'claude-code'): Promise<Session> {
  const s = await open(token, client)
  const r = await s.send('register_agent', args)
  assert.equal(r.error, false, r.text)
  return s
}

async function serve(paramSetId: string) {
  if (paramSetId === 'spreading.v5' && !sql(`select 1 from memory.param_set where id = 'spreading.v2'`).length) {
    await admin('POST', '/param-sets', { id: 'spreading.v2', parent: 'spreading.v1', params: { otherRunFactor: 0.9 }, note: 'tier 3 stand-in' })
    apply('20261103020000_trials_feedback.sql')
    apply('20261103030000_artifacts_storage.sql')
    apply('20261103040000_spreading_bestfirst.sql')
  }
  const rows = sql('select id from memory.param_set').map((r) => r.id as string)
    .map((param_set) => param_set === paramSetId ? { param_set, role: 'default', weight: 1000 } : { param_set, role: 'off', weight: 0 })
  const r = await admin('PUT', '/allocation', { rows, by: 'wen' })
  assert.equal(r.status, 200, r.text)
}

async function syncEmbeddings() {
  sql(`delete from memory.setting where name = 'embed_sync_status'`)
  const s = await bed.call('POST', '/embeddings/sync', bearer(memory.cronSecret))
  assert.equal(s.status, 202, s.text)
  await waitFor(() => {
    const [row] = sql(`select value from memory.setting where name = 'embed_sync_status'`)
    const v = row && JSON.parse(row.value)
    return v && !v.running ? v : null
  }, 60_000, 'the embedding sync')
}

test('R70 register_agent stores realm, projects, computer, type and session snapshot', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'claude-code')
  const tools = (await s.rpc('tools/list')).result.tools as any[]
  assert.equal(tools.length, 18)
  const regTool = tools.find((t) => t.name === 'register_agent')
  assert.deepEqual(regTool.inputSchema.required, ['name', 'context', 'surface', 'description'])

  const reg = await s.send('register_agent', {
    name: 'clyde-hobby',
    context: 'hobby',
    surface: 'antigravity',
    description: 'Clyde builder.',
    projects: ['Clyde', 'gewenyu99/like-vincent'],
    computer: 'macbook-pro',
    type: 'coding',
    strict_projects: true,
  })
  assert.equal(reg.error, false, reg.text)
  assert.ok(reg.text.startsWith('Registered clyde-hobby: a hobby agent'), reg.text)

  assert.deepEqual(
    sql(`select context, computer, projects, agent_type, strict_projects from memory.agent where name = 'clyde-hobby'`),
    [{ context: 'hobby', computer: 'macbook-pro', projects: ['clyde', 'gewenyu99/like-vincent'], agent_type: 'coding', strict_projects: true }],
  )
  assert.deepEqual(
    sql(`select session_context, session_projects, session_computer, session_strict_projects from memory.mcp_client where session_id = '${s.id}'`),
    [{ session_context: 'hobby', session_projects: ['clyde', 'gewenyu99/like-vincent'], session_computer: 'macbook-pro', session_strict_projects: true }],
  )
})

test('R70 per-session snapshot prevents multi-window credential collision', { skip: SKIP }, async () => {
  const sharedToken = newDevice('r70-shared-box')
  const s1 = await registerAgent({
    name: 'clyde-work',
    context: 'work',
    surface: 'claude-code',
    description: 'Work window.',
    projects: ['acme-api'],
    computer: 'work-mac',
    strict_projects: true,
  }, sharedToken, 'claude-code')

  // Same token AND same clientInfo.name in a second window!
  const s2 = await registerAgent({
    name: 'clyde-home',
    context: 'home',
    surface: 'claude-code',
    description: 'Home window.',
    projects: ['pennywhistle'],
    computer: 'home-mac',
    strict_projects: true,
  }, sharedToken, 'claude-code')

  assert.deepEqual(
    sql(`select agent, session_context, session_projects, session_computer from memory.mcp_client where session_id = '${s1.id}'`),
    [{ agent: 'clyde-work', session_context: 'work', session_projects: ['acme-api'], session_computer: 'work-mac' }],
  )
  assert.deepEqual(
    sql(`select agent, session_context, session_projects, session_computer from memory.mcp_client where session_id = '${s2.id}'`),
    [{ agent: 'clyde-home', session_context: 'home', session_projects: ['pennywhistle'], session_computer: 'home-mac' }],
  )

  const m = marker()
  const wWork = await s1.send('remember', note(`${m} acme rule`, { body: `${m} work secret for acme-api.` }))
  const wHome = await s2.send('remember', note(`${m} penny rule`, { body: `${m} home secret for pennywhistle.` }))
  assert.equal(wWork.error, false, wWork.text)
  assert.equal(wHome.error, false, wHome.text)

  const workRow = sql(`select context, project_slug, transferability from memory.entry where id = '${idOf(wWork.text)}'`)[0]
  assert.deepEqual(workRow, { context: 'work', project_slug: 'acme-api', transferability: 'project' })
  const homeRow = sql(`select context, project_slug, transferability from memory.entry where id = '${idOf(wHome.text)}'`)[0]
  assert.deepEqual(homeRow, { context: 'home', project_slug: 'pennywhistle', transferability: 'project' })

  const s1Recall = await s1.send('recall', { query: m })
  assert.ok(s1Recall.text.includes(idOf(wWork.text)), s1Recall.text)
  assert.ok(!s1Recall.text.includes(idOf(wHome.text)), `S1 must not inherit S2 home/pennywhistle:\n${s1Recall.text}`)
})

test('R70 work, home and hobby realms stay isolated while general knowledge transfers', { skip: SKIP }, async () => {
  const workAgent = await registerAgent({ name: 'r70-work', context: 'work', surface: 'claude-code', description: 'Work.' }, memory.token, 'r70-w')
  const homeAgent = await registerAgent({ name: 'r70-home', context: 'home', surface: 'claude-code', description: 'Home.' }, memory.token, 'r70-h')
  const hobbyAgent = await registerAgent({ name: 'r70-hobby', context: 'hobby', surface: 'claude-code', description: 'Hobby.' }, memory.token, 'r70-hb')

  const m = marker()
  const eWork = await workAgent.send('remember', note(`${m} work`, {
    body: `${m} confidential work detail.`,
    context: 'work',
    transferability: 'context',
    artifacts: [{ name: 'work.txt', kind: 'document', text: `WORK_BLOB_SECRET_${m}` }],
  }))
  const eHome = await homeAgent.send('remember', note(`${m} home`, {
    body: `${m} confidential home detail.`,
    context: 'home',
    transferability: 'context',
    artifacts: [{ name: 'home.txt', kind: 'document', text: `HOME_BLOB_SECRET_${m}` }],
  }))
  const eHobby = await hobbyAgent.send('remember', note(`${m} hobby`, {
    body: `${m} hobby woodworking detail.`,
    context: 'hobby',
    transferability: 'context',
    artifacts: [{ name: 'hobby.txt', kind: 'document', text: `HOBBY_BLOB_SECRET_${m}` }],
  }))
  const eGeneral = await workAgent.send('remember', note(`${m} general`, {
    body: `${m} universal markdown preference.`,
    context: 'general',
    transferability: 'general',
  }))

  const idWork = idOf(eWork.text), shaWork = /Blob work\.txt: ([0-9a-f]{64})/.exec(eWork.text)![1]
  const idHome = idOf(eHome.text), shaHome = /Blob home\.txt: ([0-9a-f]{64})/.exec(eHome.text)![1]
  const idHobby = idOf(eHobby.text), shaHobby = /Blob hobby\.txt: ([0-9a-f]{64})/.exec(eHobby.text)![1]
  const idGeneral = idOf(eGeneral.text)

  await syncEmbeddings()

  for (const arm of ['index.v1', 'hybrid.v1', 'spreading.v1']) {
    await serve(arm)
    const rW = await workAgent.send('recall', { query: m, depth: 'deep' })
    assert.ok(rW.text.includes(idWork) && rW.text.includes(idGeneral), `${arm} work:\n${rW.text}`)
    assert.ok(!rW.text.includes(idHome) && !rW.text.includes(idHobby), `${arm} work leaked:\n${rW.text}`)

    const rWBypass = await workAgent.send('recall', { query: m, context: 'home' })
    assert.ok(!rWBypass.text.includes(idHome) && !rWBypass.text.includes(idHobby), `${arm} work bypass:\n${rWBypass.text}`)

    const rH = await homeAgent.send('recall', { query: m, depth: 'deep' })
    assert.ok(rH.text.includes(idHome) && rH.text.includes(idGeneral), `${arm} home:\n${rH.text}`)
    assert.ok(!rH.text.includes(idWork) && !rH.text.includes(idHobby), `${arm} home leaked:\n${rH.text}`)

    const rHBypass = await homeAgent.send('recall', { query: m, context: 'work' })
    assert.ok(!rHBypass.text.includes(idWork) && !rHBypass.text.includes(idHobby), `${arm} home bypass:\n${rHBypass.text}`)

    const rHb = await hobbyAgent.send('recall', { query: m, depth: 'deep' })
    assert.ok(rHb.text.includes(idHobby) && rHb.text.includes(idGeneral), `${arm} hobby:\n${rHb.text}`)
    assert.ok(!rHb.text.includes(idWork) && !rHb.text.includes(idHome), `${arm} hobby leaked:\n${rHb.text}`)
  }

  // recall_more also stays isolated (including dormant/superseded hidden pool).
  sql(`update memory.entry set confidence = 0.05 where id in ('${idHome}', '${idHobby}')`)
  const rWPage1 = await workAgent.send('recall', { query: m })
  const ridW = /^retrieval ([0-9a-f-]{36})/.exec(rWPage1.text)![1]
  const rWMore = await workAgent.send('recall_more', { retrieval_id: ridW })
  assert.ok(!rWMore.text.includes(idHome) && !rWMore.text.includes(idHobby), `recall_more leaked:\n${rWMore.text}`)

  // get_entry and get_blob refuse forbidden entries/blobs with 0 leaked text.
  for (const [agentSess, forbiddenId, forbiddenSha, secretText] of [
    [workAgent, idHome, shaHome, `HOME_BLOB_SECRET_${m}`],
    [workAgent, idHobby, shaHobby, `HOBBY_BLOB_SECRET_${m}`],
    [homeAgent, idWork, shaWork, `WORK_BLOB_SECRET_${m}`],
    [hobbyAgent, idWork, shaWork, `WORK_BLOB_SECRET_${m}`],
  ] as const) {
    const ge = await agentSess.send('get_entry', { id: forbiddenId })
    assert.equal(ge.error, true, ge.text)
    assert.match(ge.text, /Access denied|outside .* permissions/i)
    assert.ok(!ge.text.includes('detail'), ge.text)

    const gb = await agentSess.send('get_blob', { sha256: forbiddenSha })
    assert.equal(gb.error, true, gb.text)
    assert.match(gb.text, /Access denied|outside .* permissions/i)
    assert.ok(!gb.text.includes(secretText), gb.text)
  }

  // Allowed get_entry and get_blob succeed.
  const okEntry = await homeAgent.send('get_entry', { id: idGeneral })
  assert.equal(okEntry.error, false, okEntry.text)
  assert.ok(okEntry.text.includes('universal markdown preference'))
  const okBlob = await workAgent.send('get_blob', { sha256: shaWork })
  assert.equal(okBlob.error, false, okBlob.text)
  assert.ok(okBlob.text.includes(`WORK_BLOB_SECRET_${m}`))

  // UI client (claude-ai) denied get_entry / get_blob emits an error card and never leaks entry/artifact data in _meta.
  const uiWork = await registerAgent({ name: 'r70-ui-work', context: 'work', surface: 'claude.ai', description: 'UI work.' }, memory.token, 'claude-ai')
  const uiGe = await uiWork.send('get_entry', { id: idHome })
  assert.equal(uiGe.error, true)
  assert.equal(uiGe.meta?.['clyde/card']?.entry, undefined)
  assert.match(String(uiGe.meta?.['clyde/card']?.error ?? ''), /Access denied|outside .* permissions/i)
  const uiGb = await uiWork.send('get_blob', { sha256: shaHome })
  assert.equal(uiGb.error, true)
  assert.equal(uiGb.meta?.['clyde/card']?.artifact, undefined)
  assert.match(String(uiGb.meta?.['clyde/card']?.error ?? ''), /Access denied|outside .* permissions/i)
})

test('R70 project, computer and spreading-graph boundaries stay isolated', { skip: SKIP }, async () => {
  await serve('spreading.v5')
  const devLaptop = newDevice('work-laptop')
  const devMini = newDevice('mac-mini')

  const aClyde = await registerAgent({
    name: 'a-clyde',
    context: 'hobby',
    surface: 'claude-code',
    description: 'Clyde specialist.',
    projects: ['clyde'],
    computer: 'work-laptop',
    strict_projects: true,
  }, devLaptop, 'r70-clyde-app')

  const aPenny = await registerAgent({
    name: 'a-penny',
    context: 'hobby',
    surface: 'claude-code',
    description: 'Pennywhistle specialist.',
    projects: ['pennywhistle'],
    computer: 'mac-mini',
    strict_projects: true,
  }, devMini, 'r70-penny-app')

  const m = marker()
  const clydeNote = await aClyde.send('remember', note(`${m} clyde design`, {
    body: `${m} clyde project architecture.`,
    transferability: 'project',
    project_slug: 'clyde',
  }))
  const pennyNote = await aPenny.send('remember', note(`${m} penny tuning`, {
    body: `${m} pennywhistle bore sizing.`,
    transferability: 'project',
    project_slug: 'pennywhistle',
  }))
  const laptopNote = await aClyde.send('remember', note(`${m} laptop env`, {
    body: `${m} local path on work-laptop.`,
    transferability: 'computer',
    computer: 'work-laptop',
  }))
  const miniNote = await aPenny.send('remember', note(`${m} mini env`, {
    body: `${m} local path on mac-mini.`,
    transferability: 'computer',
    computer: 'mac-mini',
  }))

  const idClyde = idOf(clydeNote.text), idPenny = idOf(pennyNote.text)
  const idLaptop = idOf(laptopNote.text), idMini = idOf(miniNote.text)

  // Two graph-only targets with zero shared query tokens; embeddings are deleted after syncEmbeddings()
  // so only spreading can reach them. idAllowed connects directly from idClyde; idBeyond connects ONLY via forbidden idPenny.
  const beyondForbidden = await aClyde.send('remember', note('Unrelated graph target', {
    body: 'This has no query tokens and should not be reached across a forbidden link.',
    transferability: 'project',
    project_slug: 'clyde',
  }))
  const idBeyond = idOf(beyondForbidden.text)
  sql(`insert into memory.link (src, dst, type, weight) values ('${idPenny}', '${idMini}', 'relates', 3.0), ('${idPenny}', '${idBeyond}', 'relates', 3.0) on conflict (owner_id, src, dst, type) do nothing`)

  // Writing bridged and allowedTarget via remember(..., links) invalidates cached graphs after the SQL link inserts above.
  const bridged = await aClyde.send('remember', note(`${m} bridge`, {
    body: `${m} bridge entry.`,
    transferability: 'project',
    project_slug: 'clyde',
    links: [{ type: 'relates', to: idPenny }],
  }))
  assert.equal(bridged.error, false, bridged.text)
  const idBridged = idOf(bridged.text)

  const allowedTarget = await aClyde.send('remember', note('Allowed direct graph neighbor', {
    body: 'Reachable directly from clydeNote via permitted spreading edge without query tokens.',
    transferability: 'project',
    project_slug: 'clyde',
    links: [{ type: 'relates', to: idClyde }],
  }))
  assert.equal(allowedTarget.error, false, allowedTarget.text)
  const idAllowed = idOf(allowedTarget.text)

  // get_entry on bridged must strip forbidden linked entry idPenny and its title.
  const bridgedEntry = await aClyde.send('get_entry', { id: idBridged })
  assert.equal(bridgedEntry.error, false, bridgedEntry.text)
  assert.ok(!bridgedEntry.text.includes(idPenny), `get_entry leaked forbidden linked id:\n${bridgedEntry.text}`)
  assert.ok(!bridgedEntry.text.includes('penny tuning'), `get_entry leaked forbidden linked title:\n${bridgedEntry.text}`)

  await syncEmbeddings()
  sql(`delete from memory.entry_embedding where entry_id in ('${idBeyond}', '${idAllowed}')`)

  for (const arm of ['spreading.v5', 'spreading.v1', 'hybrid.v1', 'index.v1']) {
    await serve(arm)
    const r = await aClyde.send('recall', { query: m })
    assert.ok(r.text.includes(idClyde), `${arm} missing clyde:\n${r.text}`)
    assert.ok(r.text.includes(idLaptop), `${arm} missing work-laptop:\n${r.text}`)
    if (arm.startsWith('spreading')) {
      assert.ok(r.text.includes(idAllowed), `${arm} failed to traverse permitted edge to idAllowed:\n${r.text}`)
    } else {
      assert.ok(!r.text.includes(idAllowed), `${arm} unexpectedly returned unembedded tokenless idAllowed:\n${r.text}`)
    }
    assert.ok(!r.text.includes(idPenny), `${arm} leaked pennywhistle:\n${r.text}`)
    assert.ok(!r.text.includes(idMini), `${arm} leaked mac-mini:\n${r.text}`)
    assert.ok(!r.text.includes(idBeyond), `${arm} traversed forbidden spreading edge:\n${r.text}`)

    // Even explicit project filter cannot bypass strict_projects: true.
    const rBypass = await aClyde.send('recall', { query: m, project: 'pennywhistle' })
    assert.ok(!rBypass.text.includes(idPenny), `${arm} project filter bypassed strict_projects:\n${rBypass.text}`)
  }

  assert.equal((await aClyde.send('get_entry', { id: idClyde })).error, false)
  assert.equal((await aClyde.send('get_entry', { id: idLaptop })).error, false)
  assert.equal((await aClyde.send('get_entry', { id: idPenny })).error, true)
  assert.equal((await aClyde.send('get_entry', { id: idMini })).error, true)
})

test('R70 recall and admin console filter memories by category, context, project and transferability', { skip: SKIP }, async () => {
  await serve('hybrid.v1')
  const w = await registerAgent({ name: 'r70-cat-work', context: 'work', surface: 'claude-code', description: 'Category tester.' }, memory.token, 'r70-cat-app')
  const m = marker()
  const arch = idOf((await w.send('remember', note(`${m} arch`, { body: `${m} service topology.`, category: 'architecture', context: 'work', transferability: 'context' }))).text)
  const bill = idOf((await w.send('remember', note(`${m} bill`, { body: `${m} invoice billing tiers.`, category: 'billing', context: 'work', transferability: 'context' }))).text)
  const style = idOf((await w.send('remember', note(`${m} style`, { body: `${m} naming style guide.`, category: 'style', context: 'work', transferability: 'context' }))).text)
  await syncEmbeddings()

  const r = await w.send('recall', { query: m, category: 'billing' })
  assert.ok(r.text.includes(bill), r.text)
  assert.ok(!r.text.includes(arch) && !r.text.includes(style), r.text)

  const res = await admin('GET', '/entries?category=billing&context=work&transferability=context')
  assert.equal(res.status, 200, res.text)
  const items = JSON.parse(res.text).items as any[]
  assert.ok(items.some((i) => i.id === bill), res.text)
  assert.ok(items.every((i) => i.category === 'billing'), res.text)
  assert.ok(!items.some((i) => i.id === arch || i.id === style), res.text)
})

test('R70 quests and broadcasts respect agent realm and project permissions', { skip: SKIP }, async () => {
  const hobbyClyde = await registerAgent({
    name: 'r70-q-clyde',
    context: 'hobby',
    surface: 'claude-code',
    description: 'Clyde questor.',
    projects: ['clyde'],
    strict_projects: true,
  }, newDevice('r70-q-dev1'), 'r70-q1-app')

  const personalPenny = await registerAgent({
    name: 'r70-q-penny',
    context: 'personal',
    surface: 'claude-code',
    description: 'Penny questor.',
    projects: ['pennywhistle'],
    strict_projects: true,
  }, newDevice('r70-q-dev2'), 'r70-q2-app')

  const workAcme = await registerAgent({
    name: 'r70-q-acme',
    context: 'work',
    surface: 'claude-code',
    description: 'Acme questor.',
    projects: ['acme'],
    strict_projects: true,
  }, newDevice('r70-q-dev3'), 'r70-q3-app')

  const post = async (s: Session, args: Record<string, unknown>) => {
    const r = await s.send('post_quest', args)
    assert.equal(r.error, false, r.text)
    return Number(/^Posted quest #(\d+):/.exec(r.text)![1])
  }

  const tag = `r70q${nonce()}`
  const qClyde = await post(hobbyClyde, { title: `Clyde task ${tag}`, brief: 'Build R70.', done_when: 'Tests pass.', context: 'hobby', project: 'clyde', tags: [tag] })
  const qPenny = await post(personalPenny, { title: `Penny task ${tag}`, brief: 'Tune whistle.', done_when: 'In tune.', context: 'personal', project: 'pennywhistle', tags: [tag] })
  const qAcme = await post(workAcme, { title: `Acme task ${tag}`, brief: 'Ship billing.', done_when: 'Paid.', context: 'work', project: 'acme', tags: [tag] })

  const list = await hobbyClyde.send('list_quests', { tag })
  assert.ok(list.text.includes(`#${qClyde}`), list.text)
  assert.ok(!list.text.includes(`#${qPenny}`) && !list.text.includes(`#${qAcme}`), list.text)

  // SessionStart board for r70-q-clyde includes only clyde hobby quest, never pennywhistle or acme.
  const dev1 = newDevice('r70-q-hook')
  await registerAgent({ name: 'r70-q-clyde-hook', context: 'hobby', surface: 'claude-code', description: 'Hook clyde.', projects: ['clyde'], strict_projects: true }, dev1, 'r70-qh-app')
  const start = await bed.call('POST', '/hooks/SessionStart?agent=r70-q-clyde-hook', bearer(dev1), { session_id: `r70-${nonce()}` })
  assert.equal(start.status, 200, start.text)
  assert.ok(!start.text.includes(`#${qPenny}`) && !start.text.includes(`#${qAcme}`), start.text)

  // Cross-project/cross-realm claim_quest is refused.
  assert.equal((await hobbyClyde.send('claim_quest', { id: qPenny })).error, true)
  assert.equal((await hobbyClyde.send('claim_quest', { id: qAcme })).error, true)
  assert.equal((await hobbyClyde.send('claim_quest', { id: qClyde })).error, false)

  // Scoped broadcast to all reaches only matching hobby + clyde agents.
  const hobbyClydePeer = await registerAgent({
    name: 'r70-q-clyde-peer',
    context: 'hobby',
    surface: 'claude-code',
    description: 'Peer clyde.',
    projects: ['gewenyu99/clyde'],
  }, memory.token, 'r70-qpeer-app')
  assert.ok(hobbyClydePeer.id)

  const msg = await hobbyClyde.send('post_message', { to: 'all', body: `R70 clyde notice ${nonce()}`, context: 'hobby', project: 'clyde' })
  assert.equal(msg.error, false, msg.text)
  const mid = Number(/^Posted message (\d+) to all\./.exec(msg.text)![1])
  const recipients = sql(`select recipient from memory.message_delivery where message_id = ${mid}`).map((r) => r.recipient as string)
  assert.ok(recipients.includes('r70-q-clyde-peer'), recipients.join(','))
  assert.ok(!recipients.includes('r70-q-penny') && !recipients.includes('r70-q-acme'), recipients.join(','))
})

test('R70 defaults preserve makeId and general baseline entries', { skip: SKIP }, async () => {
  const s = await open(memory.token, 'r70-legacy-app')
  const title = `Prefer loose leaf tea ${nonce()}`
  const legacyArgs = { pattern: 'preferences', title, body: 'Loose leaf only.', scope: 'global', evidence: 'Wen said so.' }
  const fullPayload = {
    pattern: legacyArgs.pattern,
    title: legacyArgs.title,
    body: legacyArgs.body,
    scope: legacyArgs.scope,
    evidence: legacyArgs.evidence,
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
  const wantId = legacyMakeId(fullPayload)
  const wrote = await s.send('remember', legacyArgs)
  assert.equal(wrote.error, false, wrote.text)
  assert.equal(idOf(wrote.text), wantId)

  const [row] = sql(`select category, context, transferability, project_slug, computer from memory.entry_current where id = '${wantId}'`)
  assert.deepEqual(row, { category: 'preferences', context: 'general', transferability: 'general', project_slug: null, computer: 'clyde-test' })

  const tea = sql(`select id, context, transferability from memory.entry_current where id = 'tea-oolong-temp'`)[0]
  assert.deepEqual(tea, { id: 'tea-oolong-temp', context: 'general', transferability: 'general' })

  // Migration idempotency + R48/R49 entry_current invoker/grant check.
  const before = sql(`select id, category, context, transferability, project_slug, computer from memory.entry order by id`)
  apply(MIGRATION)
  apply(MIGRATION)
  assert.deepEqual(sql(`select id, category, context, transferability, project_slug, computer from memory.entry order by id`), before)
  const [view] = sql(`select coalesce(c.reloptions, '{}') as options,
      has_table_privilege('memory_tenant', 'memory.entry_current', 'SELECT') as granted
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'memory' and c.relname = 'entry_current'`)
  assert.ok(String(view?.options).includes('security_invoker=true'), `entry_current missing security_invoker: ${view?.options}`)
  assert.equal(view?.granted, true, 'memory.entry_current must remain selectable by memory_tenant')
})

test('R70 indexes and filtered recall stay fast at 200 entries', { skip: SKIP }, async () => {
  const idxs = sql(`select indexdef from pg_indexes where schemaname = 'memory' and tablename = 'entry'`).map((r) => r.indexdef as string)
  for (const col of ['(category)', '(context)', '(transferability)', '(project_slug)']) {
    assert.ok(idxs.some((d) => d.includes(col)), `missing index on ${col}: ${idxs.join('\n')}`)
  }

  const tag = marker()
  const cats = ['architecture', 'billing', 'style', 'workflow']
  const realms = ['work', 'home', 'hobby']
  sql(`insert into memory.entry (id, pattern, title, body, authority, scope, sensitivity, lang, valid_from, source_id, evidence_kind, evidence, evidence_sha256, project, category, context, transferability, project_slug)
    select 'perf-${tag}-' || g, 'observations', 'Perf ${tag} ' || g, 'Indexed body ${tag} ' || g, 'observed', 'global', 'normal', 'en', '2026-11-15', 'src-a', 'summary', 'bench', 'x', 'proj-tea',
      (array['${cats.join("','")}'])[1 + (g % 4)], (array['${realms.join("','")}'])[1 + (g % 3)], 'context', 'proj-' || (g % 5)
    from generate_series(1, 200) g`)
  sql('analyze memory.entry')

  const plan = sql(`explain (format json) select id from memory.entry_current where context = 'work' and transferability = 'context' and category = 'billing' and project_slug = 'proj-1'`)
  assert.ok(Array.isArray(plan[0]['QUERY PLAN']) && plan[0]['QUERY PLAN'].length > 0)

  const t0 = performance.now()
  const res = await bed.call('POST', '/recall', bearer(memory.token), { query: tag, category: 'billing', context: 'work', transferability: 'context' })
  const elapsed = performance.now() - t0
  assert.equal(res.status, 200, res.text)
  assert.ok(elapsed < 5000, `filtered recall took ${elapsed} ms`)
})
