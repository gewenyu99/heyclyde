/**
 * Prints the version and the hash that guards it, run with deno: `deno run -A --node-modules-dir=none harness/test/memory/surface.ts`.
 * The hash covers everything a client sees: the MCP tools, the server instructions, and the files memory-hook updates
 * itself from. version.test.ts fails when it no longer matches SURFACE_HASH in memory/supabase/functions/memory/version.ts.
 */
import { INSTRUCTIONS, TOOLS } from '../../../memory/supabase/functions/memory/mcp.ts'
import { SERVER_VERSION, SURFACE_HASH } from '../../../memory/supabase/functions/memory/version.ts'

const CLIENT = new URL('../../../memory/supabase/functions/memory/client/', import.meta.url)
const FILES = ['claude-settings.json', 'codex-hooks.json', 'install.sh', 'memory-hook']

const client: Record<string, string> = {}
for (const name of FILES) client[name] = await Deno.readTextFile(new URL(name, CLIENT))
const bytes = new TextEncoder().encode(JSON.stringify({ instructions: INSTRUCTIONS, tools: TOOLS, client }))
const digest = await crypto.subtle.digest('SHA-256', bytes)
const hash = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
console.log(JSON.stringify({ version: SERVER_VERSION, pinned: SURFACE_HASH, hash }))
