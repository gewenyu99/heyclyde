#!/bin/sh
# Connect this computer's Claude Code, Codex, Gemini CLI and Antigravity to Wen's memory server. No checkout needed:
#   curl -fsSL https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/install | sh
# memory is allowlist only. A computer with no token signs in with a link to an allowlisted email, clicked from any
# device, and gets a token of its own named after this computer (or MEMORY_DEVICE). MEMORY_EMAIL names the email, so the
# installer asks nothing, which is how the Claude Code plugin's /memory:connect runs it with no terminal. On a work
# computer, set MEMORY_HOOKS=metadata so memory keeps no prompts or tool output from its hooks. Rerun it any time: it
# replaces only its own entries, the old kb ones too.
# The token lands in ~/.config/memory/token, ~/.claude.json and ~/.codex/config.toml, all readable by you only. Gemini CLI
# (an extension in ~/.gemini/extensions/memory) and Antigravity (an entry in ~/.gemini/config/mcp_config.json) sign in to
# memory's MCP server through OAuth, so neither gets the token; Gemini CLI's hooks reach memory through gemini-hook, which
# forwards through memory-hook. MEMORY_CLAUDE=plugin leaves Claude Code to the memory plugin, which brings the MCP server
# and the hooks itself, and takes out the installer's own Claude Code entries so nothing is there twice.
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

# The files next to this script when it was run by path from a checkout (or by memory-hook, from files it verified), else
# fetched from the function. A script read from stdin, as `curl | sh` does, has no place of its own, and the directory it
# happens to run in is not to be trusted.
HERE=/nonexistent
case ${0##*/} in install.sh) HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /nonexistent) ;; esac
if [ ! -f "$HERE/memory-hook" ]; then
  # An update installs only the files memory-hook verified and left beside this script, never anything fetched here.
  [ -z "$UPDATE" ] || { echo "install.sh --update: no memory-hook beside it to install." >&2; exit 1; }
  HERE=$(mktemp -d)
  trap 'rm -rf "$HERE"' EXIT
  for f in memory-hook claude-settings.json codex-hooks.json signing-pub.pem gemini-hook gemini-hooks.json gemini-extension.json antigravity-mcp.json; do
    curl -fsS -m 15 "$URL/install/files/$f" -o "$HERE/$f"
  done
fi

# A line for the person running this: on the terminal, or on stderr when there is none (the plugin's /memory:connect).
say() { { printf '%s\n' "$*" >/dev/tty; } 2>/dev/null || printf '%s\n' "$*" >&2; }

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
  if [ -n "${MEMORY_EMAIL:-}" ]; then
    email=$MEMORY_EMAIL
  else
    printf 'Your email: ' >/dev/tty; read -r email </dev/tty
  fi
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
  say "Check $email and click the sign-in link, from any device. Waiting..."
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

# put <source> <target> <mode>: the target becomes the source's bytes, moved into place in one step, and is not touched
# when it already has them.
put() {
  cmp -s "$1" "$2" 2>/dev/null && return 0
  mkdir -p "$(dirname "$2")" && cp "$1" "$2.new.$$" && chmod "$3" "$2.new.$$" && mv -f "$2.new.$$" "$2"
}

# Gemini CLI: gemini-hook beside memory-hook, and the memory extension, which is all ours: its manifest, with the MCP
# server Gemini CLI signs in to through OAuth, and its hooks.
GEMINI_EXT=$HOME/.gemini/extensions/memory
put_gemini() {
  put "$HERE/gemini-hook" "$DIR/gemini-hook" 700 &&
    put "$HERE/gemini-extension.json" "$GEMINI_EXT/gemini-extension.json" 644 &&
    put "$HERE/gemini-hooks.json" "$GEMINI_EXT/hooks/hooks.json" 644
}

# Antigravity: memory's entry merged into ~/.gemini/config/mcp_config.json beside the other servers, which stay as they
# are. A file that already has exactly this entry is not written, and one that won't parse is left alone.
put_antigravity() {
  python3 - "$HOME/.gemini/config/mcp_config.json" "$HERE/antigravity-mcp.json" <<'PY'
import json, os, stat, sys, tempfile
from pathlib import Path
path, entry = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text())["mcpServers"]["memory"]
text = path.read_text() if path.exists() else ""
doc = json.loads(text) if text.strip() else {}
servers = doc.setdefault("mcpServers", {}) if isinstance(doc, dict) else None
if not isinstance(servers, dict):
    sys.exit(f"{path} has no mcpServers object")
if text.strip() and servers.get("memory") == entry:
    sys.exit(0)
servers["memory"] = entry
path.parent.mkdir(parents=True, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
try:
    with os.fdopen(fd, "w") as out:
        out.write(json.dumps(doc, indent=2) + "\n")
    if path.exists():
        os.chmod(tmp, stat.S_IMODE(path.stat().st_mode))
    os.replace(tmp, path)
except BaseException:
    if os.path.exists(tmp):
        os.unlink(tmp)
    raise
PY
}

if [ -z "$UPDATE" ]; then
  TOKEN=${MEMORY_TOKEN:-$(cat "$DIR/token" 2>/dev/null || true)}
  if [ -n "$TOKEN" ] && [ "$(probe "$TOKEN")" = 200 ]; then
    echo "This computer is already connected as $DEVICE, so no sign-in. Refreshing its apps' setup."
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
  # Gemini CLI, only where its extension is, and only from a release that has the files: a memory-hook from before R45
  # fetches only the five files it knows, and this runs beside those.
  if [ -d "$GEMINI_EXT" ] && [ -f "$HERE/gemini-hook" ]; then
    put_gemini || failed=1
  fi
  newpub=$DIR/.signing-pub.$$
  cp "$HERE/signing-pub.pem" "$newpub" && chmod 600 "$newpub" || failed=1
  # The key moves in only after memory-hook did, so a key never arrives without the client that came with it.
  if put_hook; then
    mv -f "$newpub" "$DIR/signing-pub.pem" || failed=1
  else
    failed=1
    rm -f "$newpub"
  fi
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

# Which apps are here, decided before anything below writes to ~/.gemini.
GEMINI= ANTIGRAVITY=
if command -v gemini >/dev/null 2>&1 || [ -d "$HOME/.gemini" ]; then GEMINI=1; fi
if [ -d "$HOME/.gemini/config" ] || command -v antigravity >/dev/null 2>&1 || command -v agy >/dev/null 2>&1; then ANTIGRAVITY=1; fi

if [ "${MEMORY_CLAUDE:-}" = plugin ]; then
  # The plugin brings the MCP server and the hooks, so the installer's own come out: no second server, no event twice.
  if CLAUDE=$(claude_cli); then
    for old in kb memory; do "$CLAUDE" mcp remove "$old" --scope user >/dev/null 2>&1 || true; done
  fi
  if grep -qs memory-hook "$HOME/.claude/settings.json"; then
    none=$(mktemp)
    echo '{"hooks": {}}' > "$none"
    merge ~/.claude/settings.json "$none" >/dev/null
    rm -f "$none"
  fi
  echo "Claude Code: the memory plugin brings the MCP server and the hooks, which forward through memory-hook as $DEVICE."
elif CLAUDE=$(claude_cli); then
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

if [ -n "$GEMINI" ]; then
  put_gemini
  echo "Gemini CLI: the memory extension is in ~/.gemini/extensions/memory. Sign in when Gemini CLI asks, or run /mcp auth memory in it."
else
  echo "Gemini CLI: not found, skipped."
fi
if [ -n "$ANTIGRAVITY" ]; then
  if put_antigravity; then
    echo "Antigravity: memory is in ~/.gemini/config/mcp_config.json. Sign in when Antigravity asks."
  else
    echo "Antigravity: couldn't read ~/.gemini/config/mcp_config.json, so it was left as it was." >&2
  fi
else
  echo "Antigravity: not found, skipped."
fi
