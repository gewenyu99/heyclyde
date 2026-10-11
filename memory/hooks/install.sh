#!/bin/sh
# Connect this machine's Claude Code and Codex to the memory server. Rerun it after a redeploy or a token change.
#   mem_pass=<the agents' token> memory/hooks/install.sh <droplet-ip>
# The token is KB_TOKEN, never the console's admin token. It comes from KB_INSTALL_TOKEN or mem_pass, else from the
# Droplet over SSH. It is never printed.
# It lands in ~/.config/kb/token, ~/.claude.json and ~/.codex/config.toml, all readable by you only.
set -eu
IP=${1:?usage: install.sh <droplet-ip>}
HERE=$(cd "$(dirname "$0")" && pwd)
URL="https://kb.$(echo "$IP" | tr . -).sslip.io"
KB=$HOME/.config/kb

TOKEN=${KB_INSTALL_TOKEN:-${mem_pass:-}}
[ -n "$TOKEN" ] || TOKEN=$(ssh ${KB_SSH_KEY:+-i "$KB_SSH_KEY"} -o StrictHostKeyChecking=accept-new "root@$IP" \
  "sed -n 's/^KB_TOKEN=//p' /opt/kb/deploy/.env")
[ -n "$TOKEN" ] || { echo "no token: set mem_pass or KB_INSTALL_TOKEN" >&2; exit 1; }
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$URL/mcp" || true)
case $code in 401) echo "$URL refused the token" >&2; exit 1;; 000) echo "$URL is down" >&2; exit 1;; esac

umask 077
mkdir -p "$KB" "$HOME/.claude" "$HOME/.codex"
printf '%s\n' "$URL" > "$KB/url"
printf '%s\n' "$TOKEN" > "$KB/token"
cp "$HERE/kb-hook" "$KB/kb-hook" && chmod 700 "$KB/kb-hook"

# Merge a {"hooks": {...}} snippet into a client's hooks file. Earlier kb entries go, the user's own hooks stay.
merge() {
  python3 - "$@" <<'PY'
import json, sys
from pathlib import Path
path, ours = Path(sys.argv[1]).expanduser(), json.loads(Path(sys.argv[2]).read_text())["hooks"]
doc = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}

def stale(h):
    """Ours: a kb-hook entry, or a hand-written curl to /messages/codex from before kb-hook read Codex messages."""
    c = h.get("command", "") if isinstance(h, dict) else ""
    return "kb-hook" in c or ("curl" in c and "/messages/codex" in c)

def strip(groups):
    """Each group minus our entries. A group goes only when that leaves it empty."""
    kept = []
    for g in groups:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            left = [h for h in g["hooks"] if not stale(h)]
            if g["hooks"] and not left:
                continue
            g["hooks"] = left
        kept.append(g)
    return kept

def clean(table, events):
    """Strip our entries from these events. An event goes only when that leaves it empty."""
    for event in events:
        if isinstance(table.get(event), list):
            left = strip(table[event])
            if left or not table[event]:
                table[event] = left
            else:
                del table[event]

clean(doc, ours)  # the old installer left Codex groups at the top level, where Codex never looks
hooks = doc.setdefault("hooks", {})
clean(hooks, list(hooks))
for event, groups in ours.items():
    hooks[event] = hooks.get(event, []) + groups
path.write_text(json.dumps(doc, indent=2) + "\n")
path.chmod(0o600)
PY
}

# Claude Code's CLI. The Claude desktop app bundles its own and keeps it off PATH, so fall back to its newest version.
claude_cli() {
  command -v claude && return
  app="$HOME/Library/Application Support/Claude/claude-code"
  for v in $(ls "$app" 2>/dev/null | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
    for bin in "$app/$v"/*/claude.app/Contents/MacOS/claude; do
      [ -x "$bin" ] && { echo "$bin"; return; }
    done
  done
  return 1
}

if CLAUDE=$(claude_cli); then
  "$CLAUDE" mcp remove kb --scope user >/dev/null 2>&1 || true
  "$CLAUDE" mcp add --transport http --scope user kb "$URL/mcp" --header "Authorization: Bearer $TOKEN"
  merge ~/.claude/settings.json "$HERE/claude-settings.json"
  echo "Claude Code: connected. Restart it to load the hooks."
else
  echo "Claude Code: claude CLI not found, skipped."
fi

# Codex: hooks in ~/.codex/hooks.json, and the MCP server in config.toml with the header inline.
merge ~/.codex/hooks.json "$HERE/codex-hooks.json"
python3 - "$URL" "$TOKEN" <<'PY'
import json, re, sys
from pathlib import Path
path = Path.home() / ".codex/config.toml"
text = path.read_text() if path.exists() else ""
# Drop any earlier [mcp_servers.kb] table and its subtables, up to the next unrelated table.
text = re.sub(r"(?ms)^\[mcp_servers\.kb(\.[^\]]*)?\][^\n]*\n.*?(?=^\[(?!mcp_servers\.kb[\].])|\Z)", "", text).rstrip()
block = f'[mcp_servers.kb]\nurl = {json.dumps(sys.argv[1] + "/mcp")}\nhttp_headers = {{ Authorization = {json.dumps("Bearer " + sys.argv[2])} }}\n'
text = (text + "\n\n" if text else "") + block
try:
    import tomllib
    tomllib.loads(text)
except ImportError:
    pass
path.write_text(text)
path.chmod(0o600)
PY
echo "Codex: connected. Run /hooks in the Codex CLI once to trust the two kb-hook entries."
