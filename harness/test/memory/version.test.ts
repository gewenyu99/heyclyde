/**
 * R31: one server version for the tools, the instructions and the client files, and a client's status against it. The
 * guard runs deno over mcp.ts (surface.ts), so a changed tool list with the old version fails here. No database needed.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { clientStatus, compareVersions, needsInstaller, parseVersion, reportable, SERVER_VERSION, SURFACE_HASH } from '../../../memory/supabase/functions/memory/version.ts'

const DENO = process.env.MEMORY_TEST_DENO || 'deno'
const SKIP_DENO = spawnSync(DENO, ['--version']).status === 0 ? false : 'deno is not installed'

test('SERVER_VERSION is a date and a serial', () => {
  assert.ok(parseVersion(SERVER_VERSION), `${SERVER_VERSION} is not YYYYMMDD.N`)
})

test('the tool list, instructions and client files hash to SURFACE_HASH, so changing one needs a version bump', { skip: SKIP_DENO }, () => {
  const r = spawnSync(DENO, ['run', '-A', '--node-modules-dir=none', join(import.meta.dirname, 'surface.ts')], { encoding: 'utf8', timeout: 120_000 })
  assert.equal(r.status, 0, r.stderr)
  const { version, pinned, hash } = JSON.parse(r.stdout)
  assert.equal(version, SERVER_VERSION)
  assert.equal(pinned, SURFACE_HASH)
  assert.equal(
    hash, SURFACE_HASH,
    `The MCP tools, the server instructions or a client file changed. Bump SERVER_VERSION in memory/supabase/functions/memory/version.ts ` +
      `(now ${SERVER_VERSION}) and set SURFACE_HASH to ${hash}.`,
  )
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

test('a client at N-1 works for the 30 day cutoff, and an older one is told to rerun the installer', () => {
  // The server is at 20261102.1 or later, so every stamp below is behind it.
  const now = new Date(Date.UTC(2026, 10, 20))
  const status = (v: string | null | undefined, cutoff = 30) => clientStatus(v, cutoff, now)
  assert.equal(status(SERVER_VERSION), 'current')
  assert.equal(status('29991231.1'), 'current', 'newer than the server counts as current')
  assert.equal(status('dev'), 'current')
  assert.equal(status('20261101.1'), 'behind', '19 days old')
  assert.equal(status('20261021.1'), 'behind', '30 days old exactly still works')
  assert.equal(status('20261020.1'), 'expired', '31 days old')
  assert.equal(status('20260101.1'), 'expired')
  assert.equal(status('20261020.1', 60), 'behind', 'the cutoff is configurable')
  assert.equal(status('20261101.1', 10), 'expired')
  for (const none of [null, undefined, '', 'garbage', '20261102']) assert.equal(status(none), 'unknown', String(none))
  assert.deepEqual((['current', 'behind', 'expired', 'unknown'] as const).map(needsInstaller), [false, false, true, true])
})
