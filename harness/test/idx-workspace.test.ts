/**
 * Quest #9: Firebase Studio (.idx/dev.nix) workspace and scripts/idx-tier3.sh runner for Tier 3.
 * Pins rootless Docker, Deno, Node, Chromium, Postgres 17 client tools, Python 3, OpenSSL and curl, keeps the
 * supabase/postgres image tag locked to .github/workflows/harness.yml, and runs either the full Tier 3 suite or a
 * single test file against a warm container.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { repoRoot } from '../src/config.ts'
import { tempDir } from './helpers.ts'

const ROOT = repoRoot()
const DEV_NIX = join(ROOT, '.idx', 'dev.nix')
const TIER3_SH = join(ROOT, 'scripts', 'idx-tier3.sh')
const WORKFLOW = join(ROOT, '.github', 'workflows', 'harness.yml')
const UI_HOST = join(ROOT, 'harness', 'test', 'memory', 'ui-host.ts')

/** Strips Nix `#` line comments, `"..."` strings and `''...''` multiline strings so structural checks read tokens only. */
function stripNixCommentsAndStrings(src: string): string {
  let out = ''
  for (let i = 0; i < src.length; ) {
    if (src[i] === '#') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (src[i] === '"') {
      out += '""'
      i++
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i += 2
        else if (src[i] === '$' && src[i + 1] === '{') {
          i += 2
          let depth = 1
          while (i < src.length && depth > 0) {
            if (src[i] === '{') depth++
            else if (src[i] === '}') depth--
            i++
          }
        } else i++
      }
      i++
    } else if (src[i] === "'" && src[i + 1] === "'") {
      out += "''''"
      i += 2
      while (i < src.length && !(src[i] === "'" && src[i + 1] === "'")) i++
      i += 2
    } else {
      out += src[i++]
    }
  }
  return out
}

function assertBalancedDelimiters(nix: string): void {
  const clean = stripNixCommentsAndStrings(nix)
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' }
  const closers = new Set(Object.values(pairs))
  const stack: string[] = []
  for (const ch of clean) {
    if (pairs[ch]) stack.push(pairs[ch])
    else if (closers.has(ch)) assert.equal(stack.pop(), ch, `unbalanced '${ch}' in .idx/dev.nix`)
  }
  assert.deepEqual(stack, [], `unclosed delimiters in .idx/dev.nix: ${stack.join('')}`)
}

test('.idx/dev.nix configures Docker, runtimes and headless Chrome for Tiers 1 to 3', () => {
  assert.ok(existsSync(DEV_NIX), '.idx/dev.nix exists')
  const nix = readFileSync(DEV_NIX, 'utf8')
  assertBalancedDelimiters(nix)

  const clean = stripNixCommentsAndStrings(nix)
  assert.match(clean, /^\s*\{\s*pkgs\s*,/, '.idx/dev.nix starts with { pkgs, ... }:')
  assert.match(nix, /channel\s*=\s*"(stable-\d{2}\.\d{2}|unstable)"\s*;/, 'declares a nixpkgs channel')
  assert.match(clean, /services\.docker\.enable\s*=\s*true\s*;|services\s*=\s*\{[^}]*docker\.enable\s*=\s*true\s*;/s, 'enables rootless Docker')

  for (const pkg of ['pkgs.nodejs_24', 'pkgs.deno', 'pkgs.chromium', 'pkgs.postgresql_17', 'pkgs.python3', 'pkgs.jq', 'pkgs.openssl', 'pkgs.curl', 'pkgs.git']) {
    assert.ok(clean.includes(pkg) || (pkg === 'pkgs.nodejs_24' && clean.includes('pkgs.nodejs_22')), `.idx/dev.nix includes ${pkg}`)
  }

  // ui-host.ts looks up process.env.CHROME first, since Nix puts chromium under /nix/store rather than /usr/bin/chromium.
  const uiHost = readFileSync(UI_HOST, 'utf8')
  assert.match(uiHost, /process\.env\.CHROME\b/, 'ui-host.ts still reads process.env.CHROME')
  assert.match(nix, /\bCHROME\s*=\s*"\$\{pkgs\.chromium\}\/bin\/chromium"\s*;/, 'sets CHROME to Nix chromium')
  assert.match(nix, /\bCHROME_BIN\s*=\s*"\$\{pkgs\.chromium\}\/bin\/chromium"\s*;/, 'sets CHROME_BIN to Nix chromium')
  assert.match(nix, /\bMEMORY_REQUIRE_DENO\s*=\s*"1"\s*;/, 'sets MEMORY_REQUIRE_DENO=1')
})

test('scripts/idx-tier3.sh is executable, valid bash, and locks supabase/postgres to harness.yml', () => {
  assert.ok(existsSync(TIER3_SH), 'scripts/idx-tier3.sh exists')
  const mode = statSync(TIER3_SH).mode & 0o777
  assert.equal(mode & 0o111, 0o111, `scripts/idx-tier3.sh is executable (got 0${mode.toString(8)})`)

  const syntax = spawnSync('bash', ['-n', TIER3_SH], { encoding: 'utf8' })
  assert.equal(syntax.status, 0, syntax.stderr)

  const workflow = readFileSync(WORKFLOW, 'utf8')
  const ciImage = /^\s*image:\s*(supabase\/postgres:[^\s#]+)/m.exec(workflow)?.[1]
  assert.ok(ciImage, 'harness.yml names a supabase/postgres image')

  const script = readFileSync(TIER3_SH, 'utf8')
  const scriptImages = [...script.matchAll(/supabase\/postgres:[0-9a-zA-Z._-]+/g)].map((m) => m[0])
  assert.ok(scriptImages.length >= 1, 'scripts/idx-tier3.sh pins supabase/postgres:<tag>')
  for (const img of scriptImages) {
    assert.equal(img, ciImage, `scripts/idx-tier3.sh image (${img}) matches harness.yml (${ciImage})`)
  }
})

type Harness = {
  dir: string
  logFile: string
  stateFile: string
  run: (args?: string[], extraEnv?: Record<string, string>) => { status: number | null; out: string; log: string[] }
  close: () => void
}

/** A fake PATH so scripts/idx-tier3.sh runs its container, readiness and runner logic with no Docker daemon. */
function fakeTier3Env(initialContainer = ''): Harness {
  const dir = tempDir('idx-tier3-')
  const bin = join(dir, 'bin')
  mkdirSync(bin, { recursive: true })
  const logFile = join(dir, 'calls.log')
  const stateFile = join(dir, 'container.state')
  const readyCount = join(dir, 'ready.count')
  writeFileSync(logFile, '')
  writeFileSync(stateFile, initialContainer)
  writeFileSync(readyCount, '0')

  const writeBin = (name: string, body: string) => {
    const p = join(bin, name)
    writeFileSync(p, `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`)
    chmodSync(p, 0o755)
  }

  writeBin('docker', `
echo "docker $*" >> "$TEST_LOG"
cmd="\${1:-}"
shift || true
case "$cmd" in
  info) exit 0 ;;
  inspect)
    state="$(cat "$TEST_STATE")"
    [ -n "$state" ] || exit 1
    if [[ "$*" == *"State.Running"* ]] && [[ "$*" == *"Config.Image"* ]]; then
      echo "$state"
    elif [[ "$*" == *"State.Running"* ]]; then
      echo "\${state%% *}"
    elif [[ "$*" == *"Config.Image"* ]]; then
      echo "\${state#* }"
    else
      echo "$state"
    fi
    ;;
  rm)
    echo "" > "$TEST_STATE"
    ;;
  start)
    cur="$(cat "$TEST_STATE")"
    img="\${cur#* }"
    echo "true $img" > "$TEST_STATE"
    ;;
  run)
    img="\${!#}"
    echo "true $img" > "$TEST_STATE"
    echo "fake-container-id"
    ;;
  exec)
    echo "1"
    ;;
esac
`)

  writeBin('pg_isready', `
n="$(cat "$TEST_READY")"
n=$((n + 1))
echo "$n" > "$TEST_READY"
echo "pg_isready $* (try=$n)" >> "$TEST_LOG"
[ "$n" -ge 2 ]
`)

  writeBin('psql', `
echo "psql $*" >> "$TEST_LOG"
echo "1"
`)

  writeBin('chromium', `echo "chromium $*" >> "$TEST_LOG"`)
  writeBin('deno', `echo "deno $* db=\${MEMORY_TEST_DATABASE_URL:-} db_short=\${MEMORY_TEST_DB_URL:-} req_deno=\${MEMORY_REQUIRE_DENO:-}" >> "$TEST_LOG"`)
  writeBin('python3', `echo "python3 $*" >> "$TEST_LOG"`)
  writeBin('npm', `echo "npm $* db=\${MEMORY_TEST_DATABASE_URL:-} db_short=\${MEMORY_TEST_DB_URL:-} req_deno=\${MEMORY_REQUIRE_DENO:-} chrome=\${CHROME:-}" >> "$TEST_LOG"`)
  writeBin('node', `echo "node $* cwd=$(pwd) db=\${MEMORY_TEST_DATABASE_URL:-} db_short=\${MEMORY_TEST_DB_URL:-} req_deno=\${MEMORY_REQUIRE_DENO:-} chrome=\${CHROME:-}" >> "$TEST_LOG"`)

  return {
    dir,
    logFile,
    stateFile,
    run: (args = [], extraEnv = {}) => {
      writeFileSync(logFile, '')
      const env: Record<string, string> = {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: dir,
        TEST_LOG: logFile,
        TEST_STATE: stateFile,
        TEST_READY: readyCount,
        MEMORY_TEST_PG_POLL_SEC: '0',
        ...extraEnv,
      }
      const r = spawnSync('bash', [TIER3_SH, ...args], { env, encoding: 'utf8', timeout: 15_000 })
      const log = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
      return { status: r.status, out: `${r.stdout}${r.stderr}`, log }
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('scripts/idx-tier3.sh cold-starts supabase/postgres, waits for pg_isready, exports env vars and runs Tier 3', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const ciImage = /^\s*image:\s*(supabase\/postgres:[^\s#]+)/m.exec(workflow)![1]
  const h = fakeTier3Env('')
  try {
    const r = h.run([])
    assert.equal(r.status, 0, r.out)
    assert.ok(r.log.some((l) => l.startsWith('docker run ') && l.includes(ciImage) && l.includes('POSTGRES_PASSWORD=postgres')), `docker run missing in:\n${r.log.join('\n')}`)
    assert.ok(r.log.filter((l) => l.startsWith('pg_isready ')).length >= 2, 'polled pg_isready across retry until ready')
    const npmLine = r.log.find((l) => l.startsWith('npm ') && l.includes('run test:memory'))
    assert.ok(npmLine, `expected npm run test:memory in:\n${r.log.join('\n')}`)
    assert.match(npmLine, /db=postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres\b/)
    assert.match(npmLine, /db_short=postgresql:\/\/postgres:postgres@127\.0\.0\.1:5432\/postgres\b/)
    assert.match(npmLine, /req_deno=1\b/)
    assert.match(npmLine, /chrome=.*\/bin\/chromium\b/)
  } finally {
    h.close()
  }
})

test('scripts/idx-tier3.sh reuses a warm container for single-file runs and replaces drifted images', () => {
  const workflow = readFileSync(WORKFLOW, 'utf8')
  const ciImage = /^\s*image:\s*(supabase\/postgres:[^\s#]+)/m.exec(workflow)![1]
  const h = fakeTier3Env(`true ${ciImage}`)
  try {
    // Warm single-file run with path relative to harness/
    const single = h.run(['test/memory/entitlement.test.ts'])
    assert.equal(single.status, 0, single.out)
    assert.ok(!single.log.some((l) => l.startsWith('docker run ')), `reused running container:\n${single.log.join('\n')}`)
    assert.ok(!single.log.some((l) => l.startsWith('npm ')), 'single-file run skips full npm glob')
    const nodeLine = single.log.find((l) => l.startsWith('node --test --test-concurrency=1 test/memory/entitlement.test.ts'))
    assert.ok(nodeLine, `ran single test file directly:\n${single.log.join('\n')}`)
    assert.match(nodeLine, /req_deno=1\b/)

    // Repo-root-prefixed path normalizes to harness-relative too
    const prefixed = h.run(['harness/test/memory/entitlement.test.ts'])
    assert.equal(prefixed.status, 0, prefixed.out)
    assert.ok(prefixed.log.some((l) => l.startsWith('node --test --test-concurrency=1 test/memory/entitlement.test.ts')), prefixed.log.join('\n'))

    // Drifted container image gets replaced automatically
    writeFileSync(h.stateFile, 'true supabase/postgres:17.0.0-stale')
    const drifted = h.run(['--db-only'])
    assert.equal(drifted.status, 0, drifted.out)
    assert.ok(drifted.log.some((l) => l.startsWith('docker rm -f ')), 'removed stale container')
    assert.ok(drifted.log.some((l) => l.startsWith('docker run ') && l.includes(ciImage)), 'started pinned image')
  } finally {
    h.close()
  }
})
