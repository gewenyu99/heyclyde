/**
 * Prints the server surface's version and hash, run with deno: `deno run -A --node-modules-dir=none harness/test/memory/surface.ts`.
 * The server surface is the MCP tools and the server instructions. version.test.ts fails when its hash is not the entry
 * for SERVER_VERSION in SERVER_SURFACE_HASHES (memory/supabase/functions/memory/version.ts). The client surface, the
 * files computers update themselves from, is hashed in node by surface-hash.ts and pinned to CLIENT_VERSION.
 */
import { INSTRUCTIONS, TOOLS } from '../../../memory/supabase/functions/memory/mcp.ts'
import { SERVER_VERSION } from '../../../memory/supabase/functions/memory/version.ts'
import { serverSurfaceHash } from './surface-hash.ts'

console.log(JSON.stringify({ version: SERVER_VERSION, hash: serverSurfaceHash(INSTRUCTIONS, TOOLS) }))
