/**
 * Prints the server surface's version and hash, run with deno: `deno run -A --node-modules-dir=none harness/test/memory/surface.ts`.
 * The server surface is the MCP tools and the server instructions. version.test.ts fails when its hash is not the entry
 * for SERVER_VERSION in SERVER_SURFACE_HASHES (memory/supabase/functions/memory/version.ts). The client surface, the
 * files computers update themselves from, is hashed in node by surface-hash.ts and pinned to CLIENT_VERSION. Since R67 the
 * server surface also holds what chat apps that render cards read.
 */
import { INSTRUCTIONS, TOOLS } from '../../../memory/supabase/functions/memory/mcp.ts'
import { uiSurface } from '../../../memory/supabase/functions/memory/ui/apps.ts'
import { SERVER_VERSION } from '../../../memory/supabase/functions/memory/version.ts'
import { serverSurfaceHash } from './surface-hash.ts'

// --dump prints what a coding client reads (R67's apps.test.ts holds it equal to what one gets). Otherwise the hash, which
// also covers what a card-rendering chat app reads: the tools with their card links, the card resources and their HTML.
if (Deno.args.includes('--dump')) console.log(JSON.stringify({ instructions: INSTRUCTIONS, tools: TOOLS }))
else console.log(JSON.stringify({ version: SERVER_VERSION, hash: serverSurfaceHash(INSTRUCTIONS, TOOLS, uiSurface(TOOLS)) }))
