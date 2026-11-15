/**
 * R48 (#53): every insert into an owned table whose key starts with owner_id names owner_id in its on conflict target.
 * Postgres infers the conflict from a unique index, and once the keys are (owner_id, ...) a target without owner_id matches
 * none and fails with 42P10.
 */
import assert from 'node:assert/strict'

const ROOT = new URL('../../../memory/supabase/functions/memory/', import.meta.url)

/** The owned tables whose primary key starts with owner_id after the tenancy migration, and device, whose name is unique
 * per owner. */
const OWNER_KEYED = new Set([
  'account', 'agent', 'device', 'agent_binding', 'blob', 'board_seen', 'burst', 'co_use', 'entitlement', 'entry', 'entry_blob',
  'entry_embedding', 'entry_provenance', 'judge_cache', 'link', 'mcp_client', 'mcp_session', 'source', 'upload', 'usage',
])

function sources(dir: URL): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  for (const f of Deno.readDirSync(dir)) {
    const url = new URL(f.name + (f.isDirectory ? '/' : ''), dir)
    if (f.isDirectory) out.push(...sources(url))
    else if (f.name.endsWith('.ts')) out.push({ name: url.pathname.split('/functions/memory/')[1], text: Deno.readTextFileSync(url) })
  }
  return out
}

Deno.test('R48: every conflict target names owner_id', () => {
  const missing: string[] = []
  let checked = 0
  for (const { name, text } of sources(ROOT)) {
    // An insert and its on conflict sit in one template literal, so neither crosses a backtick.
    for (const m of text.matchAll(/insert into memory\.(\w+)\b[^`]*?on conflict \(([^)]*)\)/g)) {
      if (!OWNER_KEYED.has(m[1])) continue
      checked++
      if (!m[2].split(',').map((c) => c.trim()).includes('owner_id')) missing.push(`${name}: ${m[1]} (${m[2]})`)
    }
  }
  assert.ok(checked >= 10, `found ${checked} conflict targets on owned tables`)
  assert.deepEqual(missing, [])
})
