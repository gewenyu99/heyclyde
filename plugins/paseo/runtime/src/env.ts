/** The environment a worker gets: an allowlist of the daemon's, never all of it. */
import { join } from 'node:path'
import { clydeHome } from './config.ts'

const NAMES = new Set([
  'HOME', 'PATH', 'USER', 'SHELL', 'LANG', 'TERM', 'TMPDIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'XAI_API_KEY',
  'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_OFFLINE', 'PI_SKIP_VERSION_CHECK', 'PI_TELEMETRY', 'MEMORY_URL', 'MEMORY_TOKEN', 'CLAUDE_PLUGIN_ROOT',
  // Claude Code refuses bypassPermissions as root unless the user marked the box a sandbox.
  'IS_SANDBOX',
])

// MEMORY_RUNTIME_TOKEN writes above draft, and CLAUDE_CODE_* makes a child claude reuse the parent's session id.
const NEVER = (name: string) => name === 'MEMORY_RUNTIME_TOKEN' || name.startsWith('CLAUDE_CODE_')

export function allowed(name: string): boolean {
  return !NEVER(name) && (NAMES.has(name) || name.startsWith('CLYDE_'))
}

/** The allowlisted base plus extra. An undefined value in extra removes that name, so the daemon's own CLYDE_* can't leak. */
export function workerEnv(extra: Record<string, string | undefined>, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (v !== undefined && allowed(k)) env[k] = v
  // A worker's paseo commands reach an empty home with no daemon, never Wen's Paseo. Its experiments made sidebar junk.
  env.PASEO_HOME = join(clydeHome(), 'tmp', 'paseo-sandbox')
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k]
    else if (!NEVER(k)) env[k] = v
  }
  return env
}
