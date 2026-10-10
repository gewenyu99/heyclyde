#!/bin/sh
# Connect this machine's Claude Code and Codex to the memory server. Rerun it after a redeploy or a token change.
#   mem_pass=<your password> memory/hooks/install.sh <droplet-ip>
# The token comes from KB_INSTALL_TOKEN or mem_pass, else from the Droplet over SSH. It is never printed.
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

# Merge our hooks into a hooks map, replacing only earlier kb-hook entries and leaving the rest of each group alone.
merge() {
  python3 - "$@" <<'PY'
import json, sys
from pathlib import Path
path, ours, nested = Path(sys.argv[1]).expanduser(), json.loads(Path(sys.argv[2]).read_text()), sys.argv[3] == "nested"
doc = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}
hooks = doc.setdefault("hooks", {}) if nested else doc
for event, groups in ours.items():
    kept = []
    for g in hooks.get(event, []):
        g["hooks"] = [h for h in g.get("hooks", []) if "kb-hook" not in h.get("command", "")]
        if g["hooks"]:
            kept.append(g)
    hooks[event] = kept + groups
path.write_text(json.dumps(doc, indent=2) + "\n")
path.chmod(0o600)
PY
}

if command -v claude >/dev/null 2>&1; then
  claude mcp remove kb --scope user >/dev/null 2>&1 || true
  claude mcp add --transport http --scope user kb "$URL/mcp" --header "Authorization: Bearer $TOKEN"
  python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["hooks"]))' "$HERE/claude-settings.json" > "$KB/claude-hooks.json"
  merge ~/.claude/settings.json "$KB/claude-hooks.json" nested
  echo "Claude Code: connected. Restart it to load the hooks."
else
  echo "Claude Code: claude CLI not found, skipped."
fi

# Codex: hooks in ~/.codex/hooks.json, and the MCP server in config.toml with the header inline.
merge ~/.codex/hooks.json "$HERE/codex-hooks.json" flat
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
