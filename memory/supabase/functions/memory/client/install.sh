#!/bin/sh
# Connect this computer's Claude Code and Codex to Wen's memory server. No checkout needed:
#   curl -fsSL https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/install | sh
# memory is allowlist only. A computer with no token signs in with a link to an allowlisted email, clicked from any
# device, and gets a token of its own named after this computer (or MEMORY_DEVICE). On a work computer, set
# MEMORY_HOOKS=metadata so memory keeps no prompts or tool output from its hooks. Rerun it any time: it replaces only
# its own entries, the old kb ones too.
# The token lands in ~/.config/memory/token, ~/.claude.json and ~/.codex/config.toml, all readable by you only.
# It also saves memory's public signing key to ~/.config/memory/signing-pub.pem. memory-hook installs an update only if
# every file in it is signed by that key, so the key a computer has is the one it trusts until a file signed by it brings
# a new one. Rerunning this installer is how a computer that lost its key, or never had one, gets it again.
# `install.sh --update` is what memory-hook runs to update itself (R31), from files it has already verified. It asks
# nothing and keeps the token: it only merges the hook config and replaces memory-hook and the key, and only for the
# clients that already have a memory hook. It reads the server from ~/.config/memory/url only, and only over https.
set -eu
DIR=$HOME/.config/memory
if [ "${1:-}" = --update ]; then UPDATE=1; else UPDATE=; fi
if [ -n "$UPDATE" ]; then
  URL=$(cat "$DIR/url" 2>/dev/null || true)
  case $URL in https://?*) ;; *) echo "install.sh --update: $DIR/url holds no https server." >&2; exit 1 ;; esac
else
  URL=${MEMORY_URL:-https://memory.heyclyde.me}
fi
DEVICE=${MEMORY_DEVICE:-$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._\n-' '-')}

umask 077
[ -n "$UPDATE" ] || mkdir -p "$DIR" "$HOME/.claude" "$HOME/.codex"

# The files next to this script when run from a checkout, else fetched from the function.
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /nonexistent)
if [ ! -f "$HERE/memory-hook" ]; then
  HERE=$(mktemp -d)
  trap 'rm -rf "$HERE"' EXIT
  for f in memory-hook claude-settings.json codex-hooks.json signing-pub.pem; do
    curl -fsS -m 15 "$URL/install/files/$f" -o "$HERE/$f"
  done
fi

field() { python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1]) or "")' "$1"; }

# The HTTP status of an MCP initialize with this token: 200 when it's a live device token.
probe() {
  curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "$URL/mcp" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install.sh"}}}' \
    || echo 000
}

# Sign in with a link to Wen's email and trade it for this computer's token. The link lands its PKCE code on the
# function. Only this script holds the verifier, so the code alone signs nobody in.
sign_in() {
  conf=$(curl -fsS -m 15 "$URL/install/config")
  auth=$(printf '%s' "$conf" | field auth); key=$(printf '%s' "$conf" | field key)
  printf 'Your email: ' >/dev/tty; read -r email </dev/tty
  # memory is allowlist only. Anyone else stops here, before any email is sent.
  python3 -c 'import json, sys; print(json.dumps({"email": sys.argv[1]}))' "$email" |
    curl -sS -m 15 -X POST "$URL/install/check" -H "Content-Type: application/json" --data-binary @- |
    python3 -c 'import json, sys; d = json.load(sys.stdin); sys.exit(0 if d.get("allowed") else d.get("error") or "not allowed")'
  set -- $(python3 -c 'import base64, hashlib, secrets
v = secrets.token_urlsafe(48)
print(v, base64.urlsafe_b64encode(hashlib.sha256(v.encode()).digest()).rstrip(b"=").decode(), secrets.token_urlsafe(24))')
  verifier=$1 challenge=$2 claim=$3
  redirect=$(python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$URL/install/approve?claim=$claim")
  python3 -c 'import json, sys; print(json.dumps({"email": sys.argv[1], "create_user": False, "code_challenge": sys.argv[2], "code_challenge_method": "s256"}))' \
    "$email" "$challenge" | curl -fsS -m 15 -o /dev/null -X POST "$auth/otp?redirect_to=$redirect" \
    -H "apikey: $key" -H "Content-Type: application/json" --data-binary @-
  echo "Check $email and click the sign-in link, from any device. Waiting..." >/dev/tty
  code=
  for _ in $(seq 1 300); do
    got=$(curl -sS -m 10 "$URL/install/claim/$claim" || true)
    code=$(printf '%s' "$got" | field auth_code 2>/dev/null || true)
    [ -n "$code" ] && break
    sleep 3
  done
  [ -n "$code" ] || { echo "No click within 15 minutes. Run it again." >&2; exit 1; }
  jwt=$(python3 -c 'import json, sys; print(json.dumps({"auth_code": sys.argv[1], "code_verifier": sys.argv[2]}))' "$code" "$verifier" |
    curl -fsS -m 15 -X POST "$auth/token?grant_type=pkce" -H "apikey: $key" -H "Content-Type: application/json" --data-binary @- |
    field access_token)
  curl -sS -m 15 -X POST "$URL/devices/claim" -H "Authorization: Bearer $jwt" -H "Content-Type: application/json" \
    --data "{\"name\": \"$DEVICE\", \"hooks\": \"${MEMORY_HOOKS:-full}\"}" | python3 -c 'import json, sys; d = json.load(sys.stdin); print(d.get("token") or ""); sys.exit(0 if d.get("token") else d.get("error") or "that email can'"'"'t connect a computer")'
}

# memory-hook, moved into place in one step, so a hook running now never reads half a file. A checkout's copy has no
# version yet, so it gets the newest client version. A fetched one was stamped when the server baked it.
put_hook() {
  new=$DIR/.memory-hook.$$
  if grep -q '^VERSION=@MEMORY_VERSION@$' "$HERE/memory-hook"; then
    ver=$(curl -fsS -m 10 "$URL/healthz" 2>/dev/null | field client_version 2>/dev/null || true)
    case $ver in ''|*[!0-9.]*) ver=@MEMORY_VERSION@ ;; esac
    sed "s/^VERSION=@MEMORY_VERSION@\$/VERSION=$ver/" "$HERE/memory-hook" > "$new"
  else
    cp "$HERE/memory-hook" "$new"
  fi
  chmod 700 "$new" && mv -f "$new" "$DIR/memory-hook"
}

# The public key memory-hook verifies updates against, moved into place the same way.
put_pub() {
  new=$DIR/.signing-pub.$$
  cp "$HERE/signing-pub.pem" "$new" && chmod 600 "$new" && mv -f "$new" "$DIR/signing-pub.pem"
}

if [ -z "$UPDATE" ]; then
  TOKEN=${MEMORY_TOKEN:-$(cat "$DIR/token" 2>/dev/null || true)}
  if [ -n "$TOKEN" ] && [ "$(probe "$TOKEN")" = 200 ]; then
    echo "This computer is already connected as $DEVICE, so no sign-in. Refreshing its Claude Code and Codex setup."
  else
    TOKEN=$(sign_in)
  fi
  case $(probe "$TOKEN") in
    200) ;;
    401) echo "$URL refused the token" >&2; exit 1 ;;
    000) echo "$URL is unreachable" >&2; exit 1 ;;
    *) echo "$URL answered $(probe "$TOKEN")" >&2; exit 1 ;;
  esac

  printf '%s\n' "$URL" > "$DIR/url"
  printf '%s\n' "$TOKEN" > "$DIR/token"
  put_hook
  put_pub
fi

# Merge a {"hooks": {...}} snippet into a client's hooks file, and say "changed" or "unchanged". Earlier memory and kb
# entries go, the user's own stay. A file whose memory entries are already exactly these is not touched, so a client that
# trusts hooks by their content (Codex) has nothing to trust again.
merge() {
  python3 - "$@" <<'PY'
import json, os, sys, tempfile
from pathlib import Path
path, ours = Path(sys.argv[1]).expanduser().resolve(), json.loads(Path(sys.argv[2]).read_text())["hooks"]
doc = json.loads(path.read_text()) if path.exists() and path.read_text().strip() else {}

def stale(h):
    """Ours: a memory-hook or kb-hook entry, or a hand-written curl to /messages/codex from before either existed."""
    c = h.get("command", "") if isinstance(h, dict) else ""
    return "memory-hook" in c or "kb-hook" in c or ("curl" in c and "/messages/codex" in c)

def mine(g):
    """A group made of nothing but our entries."""
    return isinstance(g, dict) and isinstance(g.get("hooks"), list) and bool(g["hooks"]) and all(stale(h) for h in g["hooks"])

def settled(doc):
    """True when our groups are in doc exactly as `ours` has them, wherever the user's own sit, and nothing of ours is anywhere else."""
    hooks = doc.get("hooks") if isinstance(doc, dict) else None
    if not isinstance(hooks, dict) or any(event in doc for event in ours):
        return False
    if any(event not in hooks for event in ours):
        return False
    for event, groups in hooks.items():
        if not isinstance(groups, list):
            if event in ours:
                return False
            continue
        if any(isinstance(g, dict) and isinstance(g.get("hooks"), list) and any(stale(h) for h in g["hooks"]) for g in groups if not mine(g)):
            return False
        if [g for g in groups if mine(g)] != ours.get(event, []):
            return False
    return True

if settled(doc):
    print("unchanged")
    sys.exit(0)

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

clean(doc, ours)  # an old installer left Codex groups at the top level, where Codex never looks
hooks = doc.setdefault("hooks", {})
clean(hooks, list(hooks))
for event, groups in ours.items():
    hooks[event] = hooks.get(event, []) + groups
# Written to a file of its own beside the target and moved over it, so a client reading the target never sees half of it
# and two writers at once never share a temp file. mkstemp makes it private (0600) with a name nobody else has.
fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
try:
    with os.fdopen(fd, "w") as out:
        out.write(json.dumps(doc, indent=2) + "\n")
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
print("changed")
PY
}

# A self-update stops here. Each client's hook config is merged on its own, so a file that won't parse stops only that
# client's, and its file is left exactly as it was. Then the key, and memory-hook last, since its new version stamp is what
# says the update is done. Codex re-trusts hooks it has seen change, so a changed hooks.json leaves a note for memory-hook
# to print once. The exit status says whether anything failed.
if [ -n "$UPDATE" ]; then
  failed=0
  if grep -qs memory-hook "$HOME/.claude/settings.json"; then
    merge ~/.claude/settings.json "$HERE/claude-settings.json" >/dev/null || failed=1
  fi
  if grep -qs memory-hook "$HOME/.codex/hooks.json"; then
    if merged=$(merge ~/.codex/hooks.json "$HERE/codex-hooks.json"); then
      if [ "$merged" = changed ]; then : > "$DIR/codex-retrust"; fi
    else
      failed=1
    fi
  fi
  newpub=$DIR/.signing-pub.$$
  cp "$HERE/signing-pub.pem" "$newpub" && chmod 600 "$newpub" || failed=1
  put_hook || failed=1
  mv -f "$newpub" "$DIR/signing-pub.pem" || failed=1
  exit "$failed"
fi

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
  for old in kb memory; do "$CLAUDE" mcp remove "$old" --scope user >/dev/null 2>&1 || true; done
  "$CLAUDE" mcp add --transport http --scope user memory "$URL/mcp" --header "Authorization: Bearer $TOKEN"
  merge ~/.claude/settings.json "$HERE/claude-settings.json" >/dev/null
  echo "Claude Code: connected as $DEVICE. Restart it to load the hooks."
else
  echo "Claude Code: claude CLI not found, skipped."
fi

# Codex: hooks in ~/.codex/hooks.json, and the MCP server in config.toml with the header inline, since the Codex
# desktop and IDE apps don't read your shell profile.
merge ~/.codex/hooks.json "$HERE/codex-hooks.json" >/dev/null
python3 - "$URL" "$TOKEN" <<'PY'
import json, re, sys
from pathlib import Path
path = Path.home() / ".codex/config.toml"
text = path.read_text() if path.exists() else ""
# Drop any earlier [mcp_servers.kb] or [mcp_servers.memory] table and its subtables, up to the next unrelated table.
text = re.sub(r"(?ms)^\[mcp_servers\.(kb|memory)(\.[^\]]*)?\][^\n]*\n.*?(?=^\[(?!mcp_servers\.(kb|memory)[\].])|\Z)", "", text).rstrip()
block = f'[mcp_servers.memory]\nurl = {json.dumps(sys.argv[1] + "/mcp")}\nhttp_headers = {{ Authorization = {json.dumps("Bearer " + sys.argv[2])} }}\n'
text = (text + "\n\n" if text else "") + block
try:
    import tomllib
    tomllib.loads(text)
except ImportError:
    pass
path.write_text(text)
path.chmod(0o600)
PY
echo "Codex: connected as $DEVICE. Run /hooks in the Codex CLI once to trust the two memory-hook entries."
