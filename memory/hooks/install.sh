#!/bin/sh
# Connect this machine's Claude Code and Codex to the memory server. Rerun it after a redeploy or a token change.
#   memory/hooks/install.sh <droplet-ip>
# With KB_TOKEN or mem_pass set it uses that. Otherwise it reads KB_TOKEN over SSH, so your key must be on the Droplet.
# The token goes to ~/.config/kb/token, ~/.claude/settings.json and the claude mcp config. It is never printed.
set -eu
IP=${1:?usage: install.sh <droplet-ip>}
HERE=$(cd "$(dirname "$0")" && pwd)
URL="https://kb.$(echo "$IP" | tr . -).sslip.io"

# A token you already know (KB_TOKEN or mem_pass) skips SSH. Otherwise read it from the Droplet.
TOKEN=${KB_TOKEN:-${mem_pass:-}}
[ -n "$TOKEN" ] || TOKEN=$(ssh ${KB_SSH_KEY:+-i "$KB_SSH_KEY"} -o StrictHostKeyChecking=accept-new "root@$IP" \
  "sed -n 's/^KB_TOKEN=//p' /opt/kb/deploy/.env")
[ -n "$TOKEN" ] || { echo "no KB_TOKEN on $IP" >&2; exit 1; }
code=$(curl -sS -m 10 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$URL/mcp" || true)
case $code in 401|000) echo "$URL refused the token or is down ($code)" >&2; exit 1;; esac

mkdir -p ~/.config/kb ~/.claude ~/.codex
umask 077
printf '%s\n' "$TOKEN" > ~/.config/kb/token
cp "$HERE/kb-hook" ~/.claude/kb-hook && chmod 755 ~/.claude/kb-hook

# Claude Code: the MCP server, plus the hooks and env from claude-settings.json merged into settings.json.
claude mcp remove kb --scope user >/dev/null 2>&1 || true
claude mcp add --transport http kb "$URL/mcp" --header "Authorization: Bearer $TOKEN" --scope user
KB_URL="$URL" KB_TOKEN="$TOKEN" python3 - "$HERE/claude-settings.json" <<'EOF'
import json, os, sys
from pathlib import Path
path = Path.home() / ".claude/settings.json"
cur = json.loads(path.read_text()) if path.exists() else {}
ours = json.loads(Path(sys.argv[1]).read_text())
cur.setdefault("env", {}).update(KB_URL=os.environ["KB_URL"], KB_TOKEN=os.environ["KB_TOKEN"])
hooks = cur.setdefault("hooks", {})
for event, groups in ours["hooks"].items():
    keep = [g for g in hooks.get(event, []) if not any("kb-hook" in h.get("command", "") for h in g.get("hooks", []))]
    hooks[event] = keep + groups
path.write_text(json.dumps(cur, indent=2) + "\n")
path.chmod(0o600)
EOF

# Codex: the MCP block in config.toml, with the token read from KB_TOKEN.
python3 - "$URL" <<'EOF'
import re, sys
from pathlib import Path
path = Path.home() / ".codex/config.toml"
text = path.read_text() if path.exists() else ""
text = re.sub(r"(?ms)^\[mcp_servers\.kb\]\n.*?(?=^\[|\Z)", "", text).rstrip()
block = f'[mcp_servers.kb]\nurl = "{sys.argv[1]}/mcp"\nbearer_token_env_var = "KB_TOKEN"\n'
path.write_text((text + "\n\n" if text else "") + block)
EOF
LINE='export KB_TOKEN="$(cat ~/.config/kb/token 2>/dev/null)"'
for rc in ~/.zshrc ~/.bashrc; do
  [ -f "$rc" ] || [ "$rc" = ~/.zshrc ] || continue
  grep -qF "$LINE" "$rc" 2>/dev/null || printf '\n%s\n' "$LINE" >> "$rc"
done

echo "Connected to $URL. Restart Claude Code and open a new shell for Codex."
