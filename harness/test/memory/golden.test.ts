/**
 * Tier 3: the v1 parameter sets rank exactly like the code before them (R32, #36). golden-v1.json is what that code
 * produced on the tea vault: every query on every arm, as a recall (candidates with scores, delivered list, packet) and
 * as the eval route ranks it. This file runs on its own memory, since the scenario resets the schema twice.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { call, LINK_TYPE_WEIGHTS, scenario } from './golden.ts'
import { SKIP, sql } from './server.ts'

test('v1 ranks exactly like today on every arm: same candidates and scores, same order, same delivered list, same packet', { skip: SKIP }, async () => {
  const golden = JSON.parse(readFileSync(join(import.meta.dirname, 'golden-v1.json'), 'utf8'))
  const ants = Object.fromEntries(LINK_TYPE_WEIGHTS.map(([s, t, d, w]) => [`${s}|${t}|${d}`, w]))
  const actual = await scenario((id, arm, pass) => {
    // The second pass's spreading runs on a set that carries the ants' weights, the way the table did. Index runs on a
    // session from before parameter sets, which names no set: it falls back to the arm's v1.
    const set = pass === 2 ? 'spreading.ants' : arm === 'index' ? null : `${arm}.v1`
    sql(`insert into memory.mcp_session (id, arm${set ? ', param_set' : ''}) values ('${id}', '${arm}'${set ? `, '${set}'` : ''})`)
  }, async (m, pass) => {
    if (pass === 2) {
      await call(m, 'POST', '/api/v1/param-sets', m.adminToken, {
        id: 'spreading.ants', parent: 'spreading.v1', params: { linkTypeWeights: ants }, note: 'the weights link_type_weight held when this was captured',
      })
    }
  })
  for (const pass of ['pass1', 'pass2']) {
    assert.deepEqual(Object.keys(actual[pass].recalls), Object.keys(golden[pass].recalls))
    for (const [key, want] of Object.entries<any>(golden[pass].recalls)) assert.deepEqual(actual[pass].recalls[key], want, `${pass} recall ${key}`)
    for (const [key, want] of Object.entries<any>(golden[pass].ranks)) assert.deepEqual(actual[pass].ranks[key], want, `${pass} eval rank ${key}`)
  }
})
