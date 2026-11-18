/**
 * R31: two versions, one for the client files that drive self-update (CLIENT_VERSION) and one for the tools and
 * instructions MCP clients read (SERVER_VERSION). Each is pinned to the hash of its surface, so a change can't ship
 * under the old number. A client's status comes from the dates the client versions were released. No database needed.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import {
  CLIENT_RELEASES, CLIENT_SURFACE_HASHES, CLIENT_VERSION, clientStatus, compareVersions, fromClydeHook, installerNote, parseVersion, reportable, SERVER_SURFACE_HASHES,
  SERVER_VERSION,
} from '../../../memory/supabase/functions/memory/version.ts'
import { AGENT_APP_FILES, CLIENT_SURFACE_FILES, checkSurface, clientSurfaceHash, hashHistory, parseHashes, readText, serverSurfaceHash } from './surface-hash.ts'

const FUNCTION = join(repoRoot(), 'memory', 'supabase', 'functions', 'memory')
const VERSION_FILE = 'memory/supabase/functions/memory/version.ts'
const DENO = process.env.MEMORY_TEST_DENO || 'deno'
// deploy.sh sets MEMORY_REQUIRE_DENO, so a computer without deno can't deploy past the guard by skipping it.
const SKIP_DENO = spawnSync(DENO, ['--version']).status === 0 || process.env.MEMORY_REQUIRE_DENO ? false : 'deno is not installed'

test('CLIENT_VERSION and SERVER_VERSION are each a date and a serial', () => {
  assert.ok(parseVersion(CLIENT_VERSION), `${CLIENT_VERSION} is not YYYYMMDD.N`)
  assert.ok(parseVersion(SERVER_VERSION), `${SERVER_VERSION} is not YYYYMMDD.N`)
})

// R31 fix 7: the client surface is pinned to CLIENT_VERSION.
test('the client files hash to the entry for CLIENT_VERSION, so changing one needs a client version bump', () => {
  const hash = clientSurfaceHash((name) => readText(join(FUNCTION, 'client', name)))
  const problems = checkSurface({ version: CLIENT_VERSION, hash, hashes: CLIENT_SURFACE_HASHES, history: hashHistory(repoRoot(), VERSION_FILE, 'CLIENT_SURFACE_HASHES') })
  assert.deepEqual(problems, [], `Bump CLIENT_VERSION (and add its CLIENT_RELEASES entry) in ${VERSION_FILE}, then pin ${hash}.`)
})

// R45 (#50): the Gemini and Antigravity files ship like the rest. deploy.sh signs them, the function serves them, an update
// fetches and verifies them, and the installer fetches them. A file left off one list would never reach a computer.
test('every list of client files names the Gemini and Antigravity files, and the lists agree', () => {
  const surface = [...CLIENT_SURFACE_FILES].sort()
  for (const f of AGENT_APP_FILES) assert.ok(surface.includes(f), `${f} is in the client surface`)
  const words = (text: string) => text.split(/[\s,'"]+/).filter(Boolean).sort()
  const deploy = /^FILES = \[(.*)\]$/m.exec(readText(join(repoRoot(), 'memory', 'deploy.sh')))
  assert.ok(deploy, 'deploy.sh has a FILES list')
  assert.deepEqual(words(deploy[1]), surface, 'deploy.sh signs every client file')
  const served = /^const CLIENT_FILES = \[([^\]]*)\];$/m.exec(readText(join(FUNCTION, 'index.ts')))
  assert.ok(served, 'index.ts has a CLIENT_FILES list')
  assert.deepEqual(words(served[1]), surface, 'the function serves every client file')
  const update = /^  for f in (.*); do$/m.exec(readText(join(FUNCTION, 'client', 'memory-hook')))
  assert.ok(update, "memory-hook's update has a file loop")
  assert.deepEqual(words(update[1]), surface, 'an update fetches and verifies every client file')
  const install = /^FILES="(.*)"$/m.exec(readText(join(FUNCTION, 'client', 'install.sh')))
  assert.ok(install, 'install.sh has a FILES list for its fetch loop')
  assert.deepEqual(words(install[1]), surface.filter((f) => f !== 'install.sh'), 'a curl | sh install fetches every other client file')
})

// R45 (#50): the release that brings the Gemini and Antigravity files is a client bump with its own pin.
test('CLIENT_VERSION moved past 20261102.1 for the Gemini and Antigravity files, with a release and a pin', () => {
  assert.ok(compareVersions(CLIENT_VERSION, '20261102.1') > 0, CLIENT_VERSION)
  assert.ok(CLIENT_RELEASES.some((r) => r.version === CLIENT_VERSION))
  assert.match(CLIENT_SURFACE_HASHES[CLIENT_VERSION] ?? '', /^[0-9a-f]{64}$/)
})

// R31 fix 7: the server surface is pinned to SERVER_VERSION.
test('the tool list and instructions hash to the entry for SERVER_VERSION, so changing one needs a server version bump', { skip: SKIP_DENO }, () => {
  const r = spawnSync(DENO, ['run', '-A', '--node-modules-dir=none', join(import.meta.dirname, 'surface.ts')], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, r.stderr || String(r.error))
  const { version, hash } = JSON.parse(r.stdout)
  assert.equal(version, SERVER_VERSION)
  const problems = checkSurface({ version: SERVER_VERSION, hash, hashes: SERVER_SURFACE_HASHES, history: hashHistory(repoRoot(), VERSION_FILE, 'SERVER_SURFACE_HASHES') })
  assert.deepEqual(problems, [], `Bump SERVER_VERSION in ${VERSION_FILE}, then pin ${hash}.`)
})

test('the guard fails a surface that changed under the old version, a shared hash, and a pinned hash that moved', () => {
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64)
  const ok = { version: '20261102.2', hash: b, hashes: { '20261102.1': a, '20261102.2': b }, history: [['20261102.1', a]] as [string, string][] }
  assert.deepEqual(checkSurface(ok), [])
  // The surface changed and the version didn't.
  assert.match(checkSurface({ ...ok, hash: c }).join('\n'), /still pins b+/)
  // A bump with no entry.
  assert.match(checkSurface({ ...ok, version: '20261103.1', hash: c }).join('\n'), /no entry for 20261103\.1/)
  // Two versions with one hash: a bump that changed nothing.
  assert.match(checkSurface({ ...ok, hashes: { '20261102.1': a, '20261102.2': a }, hash: a }).join('\n'), /20261102\.1 and 20261102\.2 share the hash/)
  // An earlier entry whose hash was edited to make the current one fit.
  assert.match(checkSurface({ ...ok, hashes: { '20261102.1': c, '20261102.2': b } }).join('\n'), /entry for 20261102\.1 changed from a+ to c+/)
  // And one that was deleted.
  assert.match(checkSurface({ ...ok, hashes: { '20261102.2': b } }).join('\n'), /entry for 20261102\.1 was removed/)
})

test('the current maps have one entry per version with no two alike', () => {
  for (const map of [CLIENT_SURFACE_HASHES, SERVER_SURFACE_HASHES]) {
    for (const [v, h] of Object.entries(map)) assert.ok(parseVersion(v) && /^[0-9a-f]{64}$/.test(h), `${v}: ${h}`)
    assert.equal(new Set(Object.values(map)).size, Object.keys(map).length)
  }
  // parseHashes reads the same maps out of the source file, which is how history is read.
  const source = readText(join(FUNCTION, 'version.ts'))
  assert.deepEqual(parseHashes(source, 'CLIENT_SURFACE_HASHES'), CLIENT_SURFACE_HASHES)
  assert.deepEqual(parseHashes(source, 'SERVER_SURFACE_HASHES'), SERVER_SURFACE_HASHES)
})

// R31 fix 6.
test('editing a tool description changes the server surface and leaves the client surface alone, so computers do not self-update', () => {
  const tools = [{ name: 'recall', description: 'Search Wen\'s memory.' }]
  const edited = [{ name: 'recall', description: 'Search Wen\'s memory, newest first.' }]
  assert.notEqual(serverSurfaceHash('instructions', tools), serverSurfaceHash('instructions', edited))
  assert.notEqual(serverSurfaceHash('instructions', tools), serverSurfaceHash('other instructions', tools))
  const files = (name: string) => `contents of ${name}`
  const client = clientSurfaceHash(files)
  assert.notEqual(client, clientSurfaceHash((name) => (name === 'install.sh' ? 'changed' : files(name))), 'a client file changes it')
})

test('versions parse only as real dates with a serial, and compare by date then serial', () => {
  for (const bad of ['', 'dev', '2026110.1', '20261302.1', '20260230.1', '20261102', '20261102.', '20261102.1.2', '20261102.x', null, 5]) {
    assert.equal(parseVersion(bad), null, String(bad))
  }
  assert.equal(parseVersion('20261102.12')?.serial, 12)
  assert.ok(compareVersions('20261102.2', '20261102.1') > 0)
  assert.ok(compareVersions('20261102.1', '20261101.9') > 0)
  assert.ok(compareVersions('20261102.9', '20261102.10') < 0, 'the serial compares as a number')
  assert.equal(compareVersions('20261102.1', '20261102.1'), 0)
  assert.ok(reportable('dev') && reportable('20261102.1') && !reportable('20261102') && !reportable(undefined))
})

// R31 fix 5.
test('CLIENT_RELEASES lists every released client version with its date, oldest first, ending at CLIENT_VERSION', () => {
  assert.ok(CLIENT_RELEASES.length > 0)
  for (const r of CLIENT_RELEASES) {
    assert.ok(parseVersion(r.version), r.version)
    assert.match(r.released, /^\d{4}-\d{2}-\d{2}$/)
    assert.ok(!Number.isNaN(Date.parse(r.released)), r.released)
  }
  for (let i = 1; i < CLIENT_RELEASES.length; i++) {
    assert.ok(compareVersions(CLIENT_RELEASES[i].version, CLIENT_RELEASES[i - 1].version) > 0, 'versions ascend')
    assert.ok(CLIENT_RELEASES[i].released >= CLIENT_RELEASES[i - 1].released, 'dates do not go back')
  }
  assert.equal(CLIENT_RELEASES.at(-1)?.version, CLIENT_VERSION)
})

test('a client is expired only when it is behind a version released more than the cutoff ago, never because its own stamp is old', () => {
  const releases = [
    { version: '20250101.1', released: '2025-01-01' },
    { version: '20261001.1', released: '2026-10-01' },
    { version: '20261110.1', released: '2026-11-10' },
  ]
  const now = new Date(Date.UTC(2026, 10, 20))
  // Against this list's own newest release, whatever CLIENT_VERSION is now.
  const status = (v: string | null | undefined, cutoff = 30) => clientStatus(v, cutoff, now, releases, releases.at(-1)!.version)
  assert.equal(status('20261110.1'), 'current')
  assert.equal(status('29991231.1'), 'current', 'newer than the latest counts as current')
  assert.equal(status('dev'), 'current')
  // Behind the latest (released 10 days ago), so it has time, however old its own stamp is.
  assert.equal(status('20261001.1'), 'behind')
  // Behind 20261001.1, released 50 days ago.
  assert.equal(status('20250101.1'), 'expired')
  // Behind only a release from 10 days ago, with a stamp from long before it: still inside the cutoff.
  const young = [{ version: '20250101.1', released: '2025-01-01' }, { version: '20261115.1', released: '2026-11-15' }]
  assert.equal(clientStatus('20250101.1', 30, now, young), 'behind', 'a stamp 2 years old is no reason to expire')
  assert.equal(clientStatus('20200101.1', 30, now, [young[1]]), 'behind', 'nor is one older than every release but the new one')
  // The cutoff counts days since the release that left it behind.
  const edge = [{ version: '20261001.1', released: '2026-10-21' }, { version: '20261102.1', released: '2026-11-02' }]
  assert.equal(clientStatus('20260901.1', 30, now, edge), 'behind', 'released 30 days ago exactly')
  assert.equal(clientStatus('20260901.1', 30, new Date(Date.UTC(2026, 10, 21, 0, 0, 1)), edge), 'expired', 'just past 30')
  assert.equal(status('20261001.1', 5), 'expired', 'the cutoff is configurable')
  assert.equal(status('20261001.1', 60), 'behind')
  for (const none of [null, undefined, '', 'garbage', '20261102']) assert.equal(status(none), 'unknown', String(none))
})

test('the real release list marks today\'s client current and an older one behind until the cutoff passes', () => {
  assert.equal(clientStatus(CLIENT_VERSION, 30), 'current')
  const released = new Date(`${CLIENT_RELEASES.at(-1)!.released}T00:00:00Z`)
  const inside = new Date(released.getTime() + 29 * 86_400_000)
  const outside = new Date(released.getTime() + 31 * 86_400_000)
  // The release before the newest is behind only the newest, so it has until the cutoff from the newest's day.
  const previous = CLIENT_RELEASES.at(-2)?.version ?? '20200101.1'
  assert.equal(clientStatus(previous, 30, inside), 'behind')
  assert.equal(clientStatus(previous, 30, outside), 'expired')
})

test('the installer note goes only to a client with no version, or one that is expired and reports a failed update', () => {
  const table = [
    ['unknown', false, true], ['unknown', true, true],
    ['expired', true, true], ['expired', false, false],
    ['behind', true, false], ['behind', false, false],
    ['current', true, false], ['current', false, false],
  ] as const
  for (const [status, failed, want] of table) {
    assert.equal(installerNote(status, failed) !== '', want, `${status}, update failed: ${failed}`)
  }
  assert.match(installerNote('unknown', false), /Rerun `curl -fsSL https:\/\/heyclyde\.me\/install \| sh`/)
})

// R78 (like-vincent #83): the line says Clyde, never memory, and names the one command.
test('R78 the installer line says Clyde', () => {
  const note = installerNote('unknown', false)
  assert.match(note, /^Clyde: /)
  assert.ok(note.includes('https://heyclyde.me/install'))
  const hook = readText(join(FUNCTION, 'client', 'memory-hook'))
  assert.match(hook, /echo "Clyde: the Clyde client on this computer is out of date/)
  assert.doesNotMatch(hook, /echo "memory: /)
})

// R78: clyde-hook.sh from before 20261117.1 came from the docs and sends no version. It has nothing to update, so a missing
// version from it is no reason to say the client is out of date. A curl-era memory-hook with no version still hears it.
test('R78 an old clyde-hook hears no installer note', () => {
  const note = (ua: string, sent: string | null) => fromClydeHook(ua) && sent === null ? '' : installerNote(clientStatus(sent, 30), false)
  assert.equal(note('Python-urllib/3.9', null), '')
  assert.equal(note('Python-urllib/3.12', null), '')
  assert.equal(note('clyde-hook/dev', null), '')
  assert.notEqual(note('curl/8.7.1', null), '')
  assert.equal(note('Python-urllib/3.9', CLIENT_VERSION), '')
  assert.equal(note('curl/8.7.1', CLIENT_VERSION), '')
})
