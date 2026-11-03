/**
 * R31: memory/deploy.sh signs the client files it bakes, runs the version guard, and stops before deploying when a
 * migration is pending. It runs here on a copy of the client files with a throwaway signing key, and `supabase` and
 * `node` (the guard) replaced by scripts that log their arguments, so nothing is deployed and nothing reaches Supabase.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../../src/config.ts'
import { CLIENT_VERSION } from '../../../memory/supabase/functions/memory/version.ts'
import { tempDir } from '../helpers.ts'
import { otherKey, trustedKey, verifies } from './signing.ts'

const MEMORY = join(repoRoot(), 'memory')
const FUNCTION = join('supabase', 'functions', 'memory')
const CLIENT_FILES = ['memory-hook', 'claude-settings.json', 'codex-hooks.json', 'install.sh', 'signing-pub.pem']
/** What `supabase migration list --linked` prints (CLI 2.122): JSON, an entry per migration, remote empty while it is pending. */
const listing = (entries: [string, string][]) => JSON.stringify({ migrations: entries.map(([local, remote]) => ({ local, remote })), message: 'Migrations listed' })
const APPLIED = listing([['20261101000900', '20261101000900'], ['20261102120000', '20261102120000']])
const PENDING = listing([['20261101000900', '20261101000900'], ['20261102120000', '']])
const MIGRATIONS = ['20261101000900_a.sql', '20261102120000_b.sql']

type Tree = { root: string; log: string; env: Record<string, string>; client: string; run: (args?: string[], env?: Record<string, string>) => { status: number | null; out: string } }

/** A copy of deploy.sh and the client files, with the public half of the trusted test key as signing-pub.pem. */
function tree(migrations = APPLIED): Tree {
  const root = tempDir('memory-deploy-')
  const bin = join(root, 'bin')
  const memory = join(root, 'memory')
  const client = join(memory, FUNCTION, 'client')
  mkdirSync(bin)
  mkdirSync(client, { recursive: true })
  mkdirSync(join(memory, 'supabase', 'migrations'))
  for (const m of MIGRATIONS) writeFileSync(join(memory, 'supabase', 'migrations', m), '-- test migration\n')
  copyFileSync(join(MEMORY, 'deploy.sh'), join(memory, 'deploy.sh'))
  copyFileSync(join(MEMORY, FUNCTION, 'version.ts'), join(memory, FUNCTION, 'version.ts'))
  for (const f of readdirSync(join(MEMORY, FUNCTION, 'client'))) {
    if (f !== 'files.ts') copyFileSync(join(MEMORY, FUNCTION, 'client', f), join(client, f))
  }
  copyFileSync(trustedKey().pub, join(client, 'signing-pub.pem'))
  const log = join(root, 'log')
  writeFileSync(log, '')
  writeFileSync(join(root, 'migrations.txt'), migrations)
  writeFileSync(join(bin, 'supabase'), '#!/bin/sh\necho "supabase $*" >> "$LOG"\n[ "$1 $2" = "migration list" ] && { cat "$MIGRATIONS_OUT"; exit "${MIGRATIONS_EXIT:-0}"; }\nexit 0\n')
  writeFileSync(join(bin, 'node'), '#!/bin/sh\necho "node $* require_deno=${MEMORY_REQUIRE_DENO:-}" >> "$LOG"\nexit "${GUARD_EXIT:-0}"\n')
  chmodSync(join(bin, 'supabase'), 0o755)
  chmodSync(join(bin, 'node'), 0o755)
  const env = {
    PATH: `${bin}:/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin`, HOME: root, LOG: log, MIGRATIONS_OUT: join(root, 'migrations.txt'), MEMORY_SIGNING_KEY: trustedKey().priv,
  }
  return {
    root, log, env, client,
    run: (args = [], extra = {}) => {
      const r = spawnSync('sh', [join(memory, 'deploy.sh'), ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60_000 })
      return { status: r.status, out: `${r.stdout}${r.stderr}` }
    },
  }
}

const files = (t: Tree): Record<string, string> => {
  const text = readFileSync(join(t.root, 'memory', FUNCTION, 'client', 'files.ts'), 'utf8')
  return JSON.parse(text.slice(text.indexOf('= ') + 2, text.lastIndexOf(';')))
}
const logged = (t: Tree) => readFileSync(t.log, 'utf8')
const baked = (t: Tree) => existsSync(join(t.client, 'files.ts'))
const done = (t: Tree) => rmSync(t.root, { recursive: true, force: true })

test('deploy.sh bakes one manifest of the client files and signs it, and the signature verifies under signing-pub.pem', () => {
  const t = tree()
  try {
    const r = t.run(['--bake'])
    assert.equal(r.status, 0, r.out)
    const baked = files(t)
    for (const f of CLIENT_FILES) assert.ok(baked[f], `${f} is baked`)
    assert.ok(verifies(join(t.client, 'signing-pub.pem'), baked.manifest, baked['manifest.sig']), 'manifest.sig verifies')
    // Signed as served: memory-hook carries the client version, since the manifest hashes exactly these bytes.
    assert.match(baked['memory-hook'], new RegExp(`^VERSION=${CLIENT_VERSION.replace('.', '\\.')}$`, 'm'))
    assert.ok(!baked['memory-hook'].includes('@MEMORY_VERSION@'))
    const lines = baked.manifest.trimEnd().split('\n')
    assert.equal(lines[0], `version=${CLIENT_VERSION}`)
    assert.deepEqual(lines.slice(1).map((l) => l.split(' ')[0]).sort(), [...CLIENT_FILES].sort(), 'a line for every client file, signing-pub.pem included')
    for (const l of lines.slice(1)) {
      const [name, hash] = l.split(' ')
      assert.equal(hash, createHash('sha256').update(baked[name]).digest('hex'), `${name}'s hash`)
    }
    assert.deepEqual(Object.keys(baked).sort(), [...CLIENT_FILES, 'manifest', 'manifest.sig'].sort(), 'no per-file signatures, nothing else')
    assert.ok(!r.out.includes('BEGIN'), 'no key material in the output')
  } finally {
    done(t)
  }
})

test('deploy.sh refuses to bake or deploy with no signing key, or with a key that is not the one signing-pub.pem names', () => {
  const t = tree()
  try {
    const missing = t.run(['--bake'], { MEMORY_SIGNING_KEY: join(t.root, 'no-such-key.pem') })
    assert.notEqual(missing.status, 0)
    assert.match(missing.out, /signing key/i)
    assert.equal(baked(t), false, 'nothing baked without a signature')
    const wrong = t.run([], { MEMORY_SIGNING_KEY: otherKey().priv })
    assert.notEqual(wrong.status, 0)
    assert.match(wrong.out, /signing-pub\.pem/)
    assert.equal(baked(t), false)
    assert.ok(!logged(t).includes('functions deploy'), 'and nothing was deployed')
  } finally {
    done(t)
  }
})

test('deploy.sh refuses to deploy client files that have no valid signature', () => {
  const t = tree()
  // A stand-in openssl whose signing writes an empty file and says it worked. Everything else is the real one.
  const real = spawnSync('sh', ['-c', 'command -v openssl'], { encoding: 'utf8' }).stdout.trim()
  writeFileSync(join(t.root, 'bin', 'openssl'), `#!/bin/sh\ncase "$*" in *" -sign "*) while [ $# -gt 0 ]; do [ "$1" = -out ] && : > "$2"; shift; done; exit 0 ;; esac\nexec ${real} "$@"\n`)
  chmodSync(join(t.root, 'bin', 'openssl'), 0o755)
  try {
    const r = t.run()
    assert.notEqual(r.status, 0, r.out)
    assert.match(r.out, /signature/i)
    assert.ok(!logged(t).includes('functions deploy'))
  } finally {
    done(t)
  }
})

test('during a key rotation, deploy.sh accepts the old key beside the new signing-pub.pem and bakes only the new one', () => {
  const t = tree()
  try {
    // The new public key is the one served; the old key signs this release, and its public half is signing-pub.previous.pem.
    copyFileSync(trustedKey().pub, join(t.client, 'signing-pub.previous.pem'))
    copyFileSync(otherKey().pub, join(t.client, 'signing-pub.pem'))
    const r = t.run(['--bake'])
    assert.equal(r.status, 0, r.out)
    const served = files(t)
    assert.equal(served['signing-pub.pem'], readFileSync(otherKey().pub, 'utf8'))
    assert.ok(!Object.keys(served).some((k) => k.includes('previous')), 'the previous key is not served')
    assert.ok(verifies(trustedKey().pub, served.manifest, served['manifest.sig']), 'the manifest, which lists the new key, is signed by the old')
    assert.ok(served.manifest.includes(createHash('sha256').update(served['signing-pub.pem']).digest('hex')))
  } finally {
    done(t)
  }
})

// R31 fix 7.
test('deploy.sh runs the version guard first, with deno required, and deploys nothing when it fails', () => {
  const t = tree()
  try {
    const failed = t.run([], { GUARD_EXIT: '1' })
    assert.notEqual(failed.status, 0)
    assert.match(logged(t), /node --test .*version\.test\.ts require_deno=1/)
    assert.equal(baked(t), false, 'the guard runs before anything is baked')
    assert.ok(!logged(t).includes('supabase'), 'and before supabase is touched')
    const passed = t.run()
    assert.equal(passed.status, 0, passed.out)
    assert.ok(logged(t).includes('functions deploy memory'))
  } finally {
    done(t)
  }
})

// R31 fix 4.
test('deploy.sh stops before deploying when a migration is pending, and says to push it first', () => {
  const t = tree(PENDING)
  try {
    const r = t.run()
    assert.notEqual(r.status, 0)
    assert.match(r.out, /20261102120000/)
    assert.match(r.out, /supabase db push/)
    assert.match(logged(t), /supabase migration list --linked/)
    assert.ok(!logged(t).includes('functions deploy'), 'the function was not deployed')
  } finally {
    done(t)
  }
})

test('deploy.sh stops when it cannot tell whether migrations are pending', () => {
  const t = tree()
  try {
    const r = t.run([], { MIGRATIONS_EXIT: '1' })
    assert.notEqual(r.status, 0)
    assert.ok(!logged(t).includes('functions deploy'))
  } finally {
    done(t)
  }
})

test('deploy.sh stops on migration output it cannot read, or one that lists nothing while migration files exist', () => {
  for (const [what, out] of [
    ['text, not JSON', '   Local | Remote\n   20261102120000 | \n'],
    ['an error object', '{"_tag":"Error","error":{"code":"ProjectRefNotLinkedError"}}'],
    ['an empty list', JSON.stringify({ migrations: [], message: 'Migrations listed' })],
    ['nothing at all', ''],
    ['a migrations value that is not a list', '{"migrations":{"local":"1","remote":"1"}}'],
  ]) {
    const t = tree(out)
    try {
      const r = t.run()
      assert.notEqual(r.status, 0, `${what}: ${r.out}`)
      assert.ok(!logged(t).includes('functions deploy'), what)
    } finally {
      done(t)
    }
  }
})

test('deploy.sh passes the migration guard when every local migration is on the remote, and fails once a new file is added', () => {
  const t = tree(APPLIED)
  try {
    assert.equal(t.run().status, 0)
    writeFileSync(join(t.root, 'memory', 'supabase', 'migrations', '20261103000000_new.sql'), '-- new\n')
    // The CLI now lists the new local file with no remote.
    writeFileSync(join(t.root, 'migrations.txt'), listing([['20261101000900', '20261101000900'], ['20261102120000', '20261102120000'], ['20261103000000', '']]))
    const r = t.run()
    assert.notEqual(r.status, 0)
    assert.match(r.out, /20261103000000/)
  } finally {
    done(t)
  }
})

test('deploy.sh deploys once every migration is applied, checking them first', () => {
  const t = tree(APPLIED)
  try {
    const r = t.run()
    assert.equal(r.status, 0, r.out)
    const lines = logged(t).split('\n')
    const check = lines.findIndex((l) => l.startsWith('supabase migration list'))
    const deploy = lines.findIndex((l) => l === 'supabase functions deploy memory --project-ref wlhlncmgjqyidosunugv --no-verify-jwt --use-api')
    assert.ok(check >= 0 && deploy > check, `migrations checked, then deployed:\n${logged(t)}`)
    assert.equal(baked(t), true)
  } finally {
    done(t)
  }
})
