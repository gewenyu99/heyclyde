// Copies Clyde's hook script, gate shim, hook configs and rule from memory/proxy/hook.js (the docs' source) into the
// installer's bundle in supabase/functions/memory/client/, and the Antigravity plugin's copies into plugins/antigravity/, so
// the docs, /clyde-hook.sh, the plugin and `curl | sh` ship the same bytes.
// deploy.sh runs it before it bakes. `node sync-client.mjs --check` exits 1, naming the files, when the bundle has drifted.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as hook from "./proxy/hook.js";

const here = dirname(fileURLToPath(import.meta.url));
const client = join(here, "supabase/functions/memory/client");
const plugin = join(here, "../plugins/antigravity");
// The plugin runs the script from its own folder.
const pluginHooks = JSON.stringify(JSON.parse(hook.ANTIGRAVITY_HOOKS_JSON.replaceAll(hook.HOOK_PATH, "sh ./scripts/clyde-hook.sh")), null, 2) + "\n";
export const SYNCED = {
  "clyde-hook.sh": hook.CLYDE_HOOK_SH,
  "clyde-gate.sh": hook.CLYDE_GATE_SH,
  "clyde-rule.md": hook.CLYDE_RULE + "\n",
  "claude-settings.json": hook.CLAUDE_HOOKS_JSON + "\n",
  "codex-hooks.json": hook.CODEX_HOOKS_JSON + "\n",
  "gemini-hooks.json": hook.GEMINI_HOOKS_JSON + "\n",
  "antigravity-hooks.json": hook.ANTIGRAVITY_HOOKS_JSON + "\n",
};
const PLUGIN = {
  "scripts/clyde-hook.sh": hook.CLYDE_HOOK_SH,
  "rules/clyde.md": hook.ANTIGRAVITY_RULE + "\n",
  "hooks.json": pluginHooks,
};
const check = process.argv.includes("--check");
const drift = [];
for (const [dir, files] of [[client, SYNCED], [plugin, PLUGIN]]) {
  for (const [name, text] of Object.entries(files)) {
    let have = null;
    try { have = readFileSync(join(dir, name), "utf8"); } catch { /* missing */ }
    if (have === text) continue;
    drift.push(name);
    if (!check) writeFileSync(join(dir, name), text, { mode: name.endsWith(".sh") ? 0o755 : 0o644 });
  }
}
if (check && drift.length) {
  console.error(`client files out of sync with memory/proxy/hook.js: ${drift.join(", ")}. Run node memory/sync-client.mjs.`);
  process.exit(1);
}
