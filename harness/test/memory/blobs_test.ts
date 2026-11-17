/**
 * Tier 3's unit tests of artifacts and blobs (R20, R42), run with `deno test`. No database and no Storage: the kind rule, the
 * defaults, the 500 character rule, itemChars, and what the docs and source must say.
 */
import assert from 'node:assert/strict'
import { EXPORT_STORED_TOTAL, KINDS, kindOf, MAX_STORED_BYTES, STORAGE_TIMEOUT_MS } from '../../../memory/supabase/functions/memory/blobs.ts'
import { INSTRUCTIONS, TOOLS } from '../../../memory/supabase/functions/memory/mcp.ts'
import { resolveParams } from '../../../memory/supabase/functions/memory/params.ts'
import { artifactsLine, renderItem } from '../../../memory/supabase/functions/memory/search.ts'
import { Refused, validate } from '../../../memory/supabase/functions/memory/write.ts'

const FUNCTION = new URL('../../../memory/supabase/functions/memory/', import.meta.url)
const MEMORY = new URL('../../../memory/', import.meta.url)

Deno.test('kindOf maps media types and names to the 8 kinds', () => {
  const cases: [string, string, string][] = [
    ['image/png', 'a.png', 'image'], ['video/mp4', 'a.mp4', 'video'], ['audio/mpeg', 'a.mp3', 'audio'],
    ['text/markdown', 'skills/x/SKILL.md', 'skill'], ['text/html', 'page.html', 'artifact'], ['application/pdf', 'a.pdf', 'document'],
    ['text/plain', 'notes.txt', 'document'], ['application/json', 'a.json', 'data'], ['text/csv', 'a.csv', 'data'],
    ['application/zip', 'a.zip', 'other'],
  ]
  assert.deepEqual(cases.map(([type, name]) => kindOf(type, name)), cases.map((c) => c[2]))
  assert.deepEqual([...KINDS].sort(), ['artifact', 'audio', 'data', 'document', 'image', 'other', 'skill', 'video'])
})

Deno.test('the export\'s Storage blob total defaults to 2147483648', () => {
  assert.equal(EXPORT_STORED_TOTAL, 2147483648)
})

Deno.test('Storage requests time out after 120000 ms by default', () => {
  assert.equal(STORAGE_TIMEOUT_MS, 120000)
})

Deno.test('a file in Storage may be 500 MB', () => {
  assert.equal(MAX_STORED_BYTES, 524288000)
})

Deno.test('only blobs.ts talks to Storage', () => {
  const offenders: string[] = []
  for (const f of Deno.readDirSync(FUNCTION)) {
    if (!f.isFile || !f.name.endsWith('.ts') || f.name === 'blobs.ts') continue
    if (Deno.readTextFileSync(new URL(f.name, FUNCTION)).includes('storage/v1')) offenders.push(f.name)
  }
  assert.deepEqual(offenders, [])
  assert.ok(Deno.readTextFileSync(new URL('blobs.ts', FUNCTION)).includes('storage/v1'))
})

Deno.test('the docs name the Storage tools, limits and kinds', () => {
  const api = Deno.readTextFileSync(new URL('API.md', MEMORY)), deploy = Deno.readTextFileSync(new URL('DEPLOY.md', MEMORY))
  for (const s of ['upload_blob', 'blob_quota_bytes', '10 GiB', '524288000', '1073741824', 'image, video, audio, document, skill, artifact, data, other']) {
    assert.ok(api.includes(s), `API.md lacks ${s}`)
  }
  for (const s of ['blob_quota_bytes', 'memory-blob-sweep']) assert.ok(deploy.includes(s), `DEPLOY.md lacks ${s}`)
})

Deno.test('the instructions and the remember description say artifact and 500', () => {
  assert.match(INSTRUCTIONS, /artifact/)
  assert.match(INSTRUCTIONS, /500/)
  const remember = TOOLS.find((t) => t.name === 'remember')!
  assert.match(remember.description, /artifact/)
  assert.match(remember.description, /500/)
  assert.ok(TOOLS.some((t) => t.name === 'upload_blob'))
})

const base = { pattern: 'observations', title: 'A title', body: 'x'.repeat(501), evidence_kind: 'summary', evidence: 'seen', sensitivity: 'normal' }

Deno.test('a body over 500 characters is refused for an agent unless long is true, and 4000 is the cap', async () => {
  await assert.rejects(validate(base, 'agent'), (e: Error) => e instanceof Refused && /artifact/.test(e.message) && /500/.test(e.message))
  assert.equal((await validate({ ...base, long: true }, 'agent')).body.length, 501)
  assert.equal((await validate({ ...base, body: 'x'.repeat(500) }, 'agent')).body.length, 500)
  await assert.rejects(validate({ ...base, body: 'x'.repeat(4001), long: true }, 'agent'), /limit is 4000/)
})

Deno.test('artifacts and blobs are the same field, and a kind outside the 8 is refused', async () => {
  const short = { ...base, body: 'short' }
  const a = await validate({ ...short, artifacts: [{ name: 'a.txt', text: 'hello' }] }, 'agent')
  const b = await validate({ ...short, blobs: [{ name: 'a.txt', text: 'hello' }] }, 'agent')
  assert.deepEqual(a.blobs, b.blobs)
  assert.equal(a.blobs[0].kind, 'document')
  assert.equal((await validate({ ...short, artifacts: [{ name: 'S.md', media_type: 'text/markdown', text: 'x' }, { name: 'SKILL.md', text: 'y' }] }, 'agent')).blobs[1].kind, 'skill')
  await assert.rejects(validate({ ...short, artifacts: [{ name: 'a.xlsx', kind: 'spreadsheet', text: 'a' }] }, 'agent'), /Use one of image, video, audio, document, skill, artifact, data, other/)
  await assert.rejects(validate({ ...short, artifacts: [{ name: 'a', sha256: 'ZZ' + 'a'.repeat(62) }] }, 'agent'), /has a sha256 that isn't 64 hex digits/)
})

Deno.test('itemChars is an optional knob that cuts an item to that many characters plus a pointer', () => {
  assert.equal(resolveParams(null, { ...V1, itemChars: 500 }).itemChars, 500)
  assert.equal(resolveParams(null, V1).itemChars, undefined)
  assert.throws(() => resolveParams(null, { ...V1, itemChars: 10 }), /itemChars/)
  const row = { id: 'e1', title: 'T', body: 'b'.repeat(900), kind: 'observation', confidence: 0.5, authority: 'draft', scope: 'global', valid_from: '2026-11-03', sensitivity: 'normal' }
  const cut = renderItem(1, row, 500)
  assert.ok(cut.includes('b'.repeat(500) + '… more in get_entry'))
  assert.ok(!cut.includes('b'.repeat(501)))
  assert.ok(renderItem(1, row).includes('b'.repeat(900)), 'a set without itemChars cuts nothing')
  assert.ok(!renderItem(1, { ...row, body: 'short' }, 500).includes('more in get_entry'))
})

Deno.test('an item lists its artifacts by name, kind and size, and a private one lists none', () => {
  const row = { id: 'e1', title: 'T', body: 'b', kind: 'observation', confidence: 0.5, authority: 'draft', scope: 'global', valid_from: '2026-11-03', sensitivity: 'normal',
    artifacts: [{ name: 'plan.md', kind: 'document', size: 5120 }, { name: 'shot.png', kind: 'image', size: 1_572_864 }] }
  assert.equal(artifactsLine(row), 'Artifacts: plan.md (document, 5.0 KB), shot.png (image, 1.5 MB)')
  assert.ok(renderItem(1, row).includes('plan.md (document, 5.0 KB)'))
  assert.ok(!renderItem(1, { ...row, sensitivity: 'private' }).includes('plan.md'))
})

const V1 = {
  candidates: 20, packetItems: 5, packetTokens: 1200, filterK: 10, filterThreshold: 0.5, tiltBase: 0.9, tiltUnknownConfidence: 0.7, tiltWindow: 50,
  rowWindow: 30, dormant: 0.15, rrfK: 60, vecWeight: 2, indexDraftFactor: 0.5, scopeBoost: 2, restart: 0.5, iterations: 20, supersededFactor: 0.2,
  linkTypeWeights: {}, wTemperature: 0, wAge: 0, wKind: 0,
}
