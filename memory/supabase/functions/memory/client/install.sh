#!/bin/sh
# Clyde's one-command setup. It connects this computer's Claude Code, Codex, Gemini CLI and Antigravity to Clyde, and installs
# the hooks that make Clyde each agent's only memory. No checkout needed:
#   curl -fsSL https://heyclyde.me/install | sh
# (https://memory.heyclyde.me/install serves the same file.) A computer with no token signs in with a link to an allowed
# email, clicked from any device, and gets a token of its own named after this computer (or MEMORY_DEVICE). MEMORY_EMAIL
# names the email, so the installer asks nothing. On a work computer, set MEMORY_HOOKS=metadata so Clyde keeps no prompts or
# tool output from its hooks. Rerun it any time: it replaces only its own entries (the old memory and kb ones too), keeps
# the user's own, and a rerun on a computer that is already set up changes nothing.
#
# What it leaves, in each app it finds:
#   - an MCP server named "clyde" at https://heyclyde.me/mcp, and no "memory" or "kb" one. Claude Code and Codex get the
#     device token in the entry. Gemini CLI (the clyde extension in ~/.gemini/extensions/clyde) and Antigravity
#     (~/.gemini/config/mcp_config.json) sign in through OAuth. MEMORY_CLAUDE=plugin or MEMORY_CLAUDE=connector leaves Claude
#     Code's MCP server to the Clyde plugin or the claude.ai connector, so there is one, and keeps the hooks. The choice is
#     saved in ~/.config/memory/claude-mode, so a plain rerun keeps it.
#   - ~/.config/memory/clyde-hook.sh, and its entries merged into the app's hook config: the recall nudge, the gate (every
#     tool but register_agent or recall is refused while one is owed) and the guard (writes to the app's own memory files are
#     refused). Older memory-hook, kb-hook, gemini-hook, clyde-gate and clyde-guard entries go.
#   - the app's own memory off: Claude Code's autoMemoryEnabled false, Codex's [features] memories = false.
#   - the Clyde rule in ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md and ~/.gemini/GEMINI.md, between clyde:begin and clyde:end
#     markers, so a rerun replaces it instead of adding it twice. An older "## Clyde" section with the old rule goes.
# The token lands in ~/.config/memory/token, ~/.claude.json and ~/.codex/config.toml, all readable by you only.
#
# It also saves Clyde's public signing key to ~/.config/memory/signing-pub.pem and installs memory-hook, the updater. When the
# server says a newer client is out, clyde-hook.sh starts `memory-hook --update`, which installs only files signed by that
# key (R31) and runs `install.sh --update` beside them. That asks nothing and keeps the token: it replaces the scripts and
# merges the hook configs, only for the apps that already have Clyde's hooks. It reads the server from
# ~/.config/memory/url only, and only over https.
set -eu
DIR=$HOME/.config/memory
if [ "${1:-}" = --update ]; then UPDATE=1; else UPDATE=; fi
if [ -n "$UPDATE" ]; then
  URL=$(cat "$DIR/url" 2>/dev/null || true)
  case $URL in https://?*) ;; *) echo "install.sh --update: $DIR/url holds no https server." >&2; exit 1 ;; esac
else
  URL=${MEMORY_URL:-https://memory.heyclyde.me}
fi
# The Supabase function's own address is the same server as memory.heyclyde.me, which every app should name instead (an
# environment that still exports it as MEMORY_URL otherwise wires every app to the raw address).
case $URL in
  https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory|https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory/) URL=https://memory.heyclyde.me ;;
esac
# The MCP URL every app gets. Clyde's own server answers it at heyclyde.me; any other server (a test's) at its own /mcp.
case $URL in
  https://memory.heyclyde.me) MCP_URL=${CLYDE_MCP_URL:-https://heyclyde.me/mcp} ;;
  *) MCP_URL=${CLYDE_MCP_URL:-$URL/mcp} ;;
esac
DEVICE=${MEMORY_DEVICE:-$(hostname -s 2>/dev/null | tr 'A-Z' 'a-z' | tr -c 'a-z0-9._\n-' '-')}
FILES="memory-hook claude-settings.json codex-hooks.json signing-pub.pem gemini-hook gemini-hooks.json gemini-extension.json antigravity-mcp.json clyde-hook.sh clyde-gate.sh clyde-rule.md antigravity-hooks.json"
# The files that releases before 20261117.1 didn't have. A memory-hook that old fetches and verifies only the others, so an
# update it runs fetches these itself and checks each against the manifest it verified.
NEWER="clyde-hook.sh clyde-gate.sh clyde-rule.md antigravity-hooks.json"

umask 077
[ -n "$UPDATE" ] || mkdir -p "$DIR" "$HOME/.claude" "$HOME/.codex"

# The files next to this script when it was run by path from a checkout (or by memory-hook, from files it verified), else
# fetched from the server. A script read from stdin, as `curl | sh` does, has no place of its own, and the directory it
# happens to run in is not to be trusted.
HERE=/nonexistent
case ${0##*/} in install.sh) HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo /nonexistent) ;; esac
if [ ! -f "$HERE/memory-hook" ]; then
  # An update installs only the files memory-hook verified and left beside this script, never anything fetched here.
  [ -z "$UPDATE" ] || { echo "install.sh --update: no memory-hook beside it to install." >&2; exit 1; }
  HERE=$(mktemp -d)
  trap 'rm -rf "$HERE"' EXIT
  curl -fsS -m 15 "$URL/install/files/manifest" -o "$HERE/manifest"
  curl -fsS -m 15 "$URL/install/files/manifest.sig" -o "$HERE/manifest.b64"
  for f in $FILES; do
    curl -fsS -m 15 "$URL/install/files/$f" -o "$HERE/$f"
  done
  pub=$HERE/signing-pub.pem
  [ -s "$DIR/signing-pub.pem" ] && pub=$DIR/signing-pub.pem
  openssl base64 -d -A -in "$HERE/manifest.b64" -out "$HERE/manifest.sig" 2>/dev/null &&
    openssl dgst -sha256 -verify "$pub" -signature "$HERE/manifest.sig" "$HERE/manifest" >/dev/null 2>&1 ||
    { echo "install.sh: manifest signature failed to verify." >&2; exit 1; }
  for f in $FILES; do
    [ "$(awk -v n="$f" '$1 == n' "$HERE/manifest" | wc -l)" -eq 1 ] || { echo "install.sh: manifest missing $f." >&2; exit 1; }
    want=$(awk -v n="$f" '$1 == n { print $2 }' "$HERE/manifest")
    [ -n "$want" ] && [ "$(openssl dgst -sha256 "$HERE/$f" 2>/dev/null | awk '{ print $NF }')" = "$want" ] ||
      { echo "install.sh: $f did not match the signed manifest." >&2; exit 1; }
  done
fi

# A line for the person running this: on the terminal, or on stderr when there is none.
say() { { printf '%s\n' "$*" >/dev/tty; } 2>/dev/null || printf '%s\n' "$*" >&2; }

field() { python3 -c 'import json, sys; print(json.load(sys.stdin).get(sys.argv[1]) or "")' "$1"; }

# The HTTP status of an MCP initialize with this token: 200 when it's a live device token.
probe() {
  curl -sS -m 15 -o /dev/null -w '%{http_code}' -X POST "$URL/mcp" -H "Authorization: Bearer $1" \
    -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
    --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"install.sh"}}}' \
    || echo 000
}

# Sign in with a link to the person's email and trade it for this computer's token. The link lands its PKCE code on the
# server. Only this script holds the verifier, so the code alone signs nobody in.
sign_in() {
  conf=$(curl -fsS -m 15 "$URL/install/config")
  auth=$(printf '%s' "$conf" | field auth); key=$(printf '%s' "$conf" | field key)
  if [ -n "${MEMORY_EMAIL:-}" ]; then
    email=$MEMORY_EMAIL
  else
    printf 'Your email: ' >/dev/tty; read -r email </dev/tty
  fi
  # Anyone not allowed stops here, before any email is sent.
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

# memory-hook, moved into place in one step, so a hook running now never reads half a file, and left alone when it already
# has these bytes. A checkout's copy has no version yet, so it gets the newest client version. A fetched one was stamped
# when the server baked it.
put_hook() {
  new=$(mktemp "$DIR/.memory-hook.XXXXXX") || return 1
  if grep -q '^VERSION=@MEMORY_VERSION@$' "$HERE/memory-hook"; then
    ver=$(curl -fsS -m 10 "$URL/healthz" 2>/dev/null | field client_version 2>/dev/null || true)
    case $ver in ''|*[!0-9.]*) ver=@MEMORY_VERSION@ ;; esac
    sed "s/^VERSION=@MEMORY_VERSION@\$/VERSION=$ver/" "$HERE/memory-hook" > "$new" || { rm -f "$new"; return 1; }
  else
    cp "$HERE/memory-hook" "$new" || { rm -f "$new"; return 1; }
  fi
  if cmp -s "$new" "$DIR/memory-hook" 2>/dev/null; then rm -f "$new"; return 0; fi
  chmod 700 "$new" && mv -f "$new" "$DIR/memory-hook" || { rm -f "$new"; return 1; }
}

# The public key memory-hook verifies updates against, moved into place the same way.
put_pub() {
  new=$(mktemp "$DIR/.signing-pub.XXXXXX") || return 1
  cp "$HERE/signing-pub.pem" "$new" && chmod 600 "$new" && mv -f "$new" "$DIR/signing-pub.pem" || { rm -f "$new"; return 1; }
}

# put <source> <target> <mode>: the target becomes the source's bytes, moved into place in one step, and is not touched
# when it already has them.
put() {
  cmp -s "$1" "$2" 2>/dev/null && return 0
  mkdir -p "$(dirname "$2")" || return 1
  tmp=$(mktemp "$(dirname "$2")/.$(basename "$2").XXXXXX") || return 1
  cp "$1" "$tmp" && chmod "$3" "$tmp" && mv -f "$tmp" "$2" || { rm -f "$tmp"; return 1; }
}

# clyde-hook.sh, the hook every app runs, and the clyde-gate.sh shim for settings that still name the old gate script.
put_scripts() {
  put "$HERE/clyde-hook.sh" "$DIR/clyde-hook.sh" 700 &&
    { [ ! -e "$DIR/clyde-gate.sh" ] || put "$HERE/clyde-gate.sh" "$DIR/clyde-gate.sh" 700; }
}

# The Python the merges share: our entries, told apart from the user's by the script they run, and a file written whole.
PYLIB='
import json, os, re, sys, tempfile
from pathlib import Path

OURS = re.compile(r"memory-hook|kb-hook|gemini-hook|clyde-hook|clyde-gate|clyde-guard|curl[^\n]*/messages/codex")

def ours(h):
    return isinstance(h, dict) and bool(OURS.search(str(h.get("command", ""))))

def mine(g):
    """A group made of nothing but our entries, or one of our flat handlers (Antigravity)."""
    if ours(g):
        return True
    return isinstance(g, dict) and isinstance(g.get("hooks"), list) and bool(g["hooks"]) and all(ours(h) for h in g["hooks"])

def strip(groups):
    """Each group minus our entries. A group goes only when that leaves it empty."""
    kept = []
    for g in groups:
        if ours(g):
            continue
        if isinstance(g, dict) and isinstance(g.get("hooks"), list):
            left = [h for h in g["hooks"] if not ours(h)]
            if g["hooks"] and not left:
                continue
            g = {**g, "hooks": left}
        kept.append(g)
    return kept

def clean(table, events):
    """Strip our entries from these events. An event goes only when that leaves it empty."""
    for event in list(events):
        if isinstance(table.get(event), list):
            left = strip(table[event])
            if left or not table[event]:
                table[event] = left
            else:
                del table[event]

def settled(table, want):
    """True when our groups are in table exactly as want has them, wherever the user entries sit, and nothing of ours is
    anywhere else."""
    if not isinstance(table, dict) or any(event not in table for event in want):
        return False
    for event, groups in table.items():
        if not isinstance(groups, list):
            if event in want:
                return False
            continue
        if any(not mine(g) and isinstance(g, dict) and isinstance(g.get("hooks"), list) and any(ours(h) for h in g["hooks"]) for g in groups):
            return False
        if [g for g in groups if mine(g)] != want.get(event, []):
            return False
    return True

def load(path):
    text = path.read_text() if path.exists() else ""
    return json.loads(text) if text.strip() else {}

def write(path, text, mode=None):
    """Written to a file of its own beside the target and moved over it, so a reader never sees half of it, readable by
    the user only unless mode says otherwise. Not written at all when the file already says exactly this."""
    if path.exists() and path.read_text() == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "w") as out:
            out.write(text)
        os.chmod(tmp, mode if mode is not None else 0o600)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    return True

def dump(doc):
    return json.dumps(doc, indent=2) + "\n"

CLYDE_URLS = ("https://heyclyde.me/mcp", "https://memory.heyclyde.me/mcp")

def oauth_mcp(mcp, current, token_files):
    """Keep an existing Clyde OAuth URL (or the one the app token file holds) so a rerun never logs the app out."""
    if mcp not in CLYDE_URLS:
        return mcp
    tokens = []
    for p in token_files:
        if not p.exists():
            continue
        try:
            raw = p.read_text()
            for u in CLYDE_URLS:
                if u in raw and u not in tokens:
                    tokens.append(u)
        except OSError:
            pass
    for u in current:
        if u in tokens:
            return u
    if tokens:
        return tokens[0]
    for u in current:
        if u in CLYDE_URLS:
            return u
    return mcp
'

# merge <hooks file> <snippet>: our entries from the snippet ({"hooks": {...}} plus any top-level settings beside it, such
# as Claude Code's autoMemoryEnabled) merged into the file. Earlier Clyde, memory and kb entries go, the user's own stay,
# and ours go after theirs. Prints "changed" or "unchanged". A file whose entries are already exactly these is not touched,
# so a client that trusts hooks by their content (Codex) has nothing to trust again.
merge() {
  python3 -c "$PYLIB"'
path, snippet = Path(sys.argv[1]).expanduser(), json.loads(Path(sys.argv[2]).read_text())
doc = load(path)
if not isinstance(doc, dict):
    sys.exit(f"{path} is not a JSON object")
want = snippet.get("hooks") or {}
extra = {k: v for k, v in snippet.items() if k != "hooks"}
if settled(doc.get("hooks"), want) and not any(event in doc for event in want) and all(doc.get(k) == v for k, v in extra.items()):
    print("unchanged")
    sys.exit(0)
clean(doc, want)  # an old installer left Codex groups at the top level, where Codex never looks
hooks = doc.setdefault("hooks", {})
if not isinstance(hooks, dict):
    sys.exit(f"{path} has a hooks entry that is not an object")
clean(hooks, list(hooks))
for event, groups in want.items():
    hooks[event] = hooks.get(event, []) + groups
doc.update(extra)
print("changed" if write(path, dump(doc)) else "unchanged")
' "$1" "$2"
}

# Antigravity keeps hook groups by name at the top of ~/.gemini/config/hooks.json. Each Clyde group names its action. Our entries anywhere
# else go, and the user's groups stay as they are.
merge_antigravity() {
  python3 -c "$PYLIB"'
path, snippet = Path(sys.argv[1]).expanduser(), json.loads(Path(sys.argv[2]).read_text())
doc = load(path)
if not isinstance(doc, dict):
    sys.exit(f"{path} is not a JSON object")
for name in list(doc):
    if isinstance(doc[name], dict):
        clean(doc[name], list(doc[name]))
        if not doc[name]:
            del doc[name]
for name, events in snippet.items():
    group = doc.setdefault(name, {})
    for event, handlers in events.items():
        group.setdefault(event, []).extend(handlers)
print("changed" if write(path, dump(doc)) else "unchanged")
' "$1" "$2"
}

# The Clyde rule in an app's rule file, between markers. An older "## Clyde" section that carries the old rule goes.
put_rule() {
  python3 -c "$PYLIB"'
path, rule = Path(sys.argv[1]).expanduser(), Path(sys.argv[2]).read_text().strip()
BEGIN, END = "<!-- clyde:begin -->", "<!-- clyde:end -->"
block = f"{BEGIN}\n## Clyde\n\n{rule}\n{END}\n"
text = path.read_text() if path.exists() else ""
if BEGIN in text and END in text and text.index(BEGIN) < text.index(END):
    a, b = text.index(BEGIN), text.index(END) + len(END)
    rest = text[b:]
    text = text[:a] + block + (rest[1:] if rest.startswith("\n") else rest)
else:
    old = re.compile(r"(?ms)^## Clyde[ \t]*\n(?:(?!^#{1,2} ).)*")
    text = old.sub(lambda m: "" if "Clyde MCP tools" in m.group(0) or "Clyde is your only memory" in m.group(0) else m.group(0), text)
    text = text.rstrip("\n")
    text = (text + "\n\n" if text else "") + block
write(path, text, path.stat().st_mode & 0o777 if path.exists() else 0o644)
' "$1" "$HERE/clyde-rule.md"
}

# An update from a memory-hook that predates these files fetches them here and checks each against the manifest that
# memory-hook verified and left beside this script. Anything that doesn't match stops the update.
fetch_newer() {
  for f in $NEWER; do
    [ -f "$HERE/$f" ] && continue
    [ -f "$HERE/manifest" ] || return 1
    want=$(awk -v n="$f" '$1 == n { print $2 }' "$HERE/manifest")
    [ -n "$want" ] || return 1
    curl -fsS -m 15 --proto '=https' --proto-redir '=https' "$URL/install/files/$f" -o "$HERE/$f" 2>/dev/null || return 1
    [ "$(openssl dgst -sha256 "$HERE/$f" 2>/dev/null | awk '{ print $NF }')" = "$want" ] || { rm -f "$HERE/$f"; return 1; }
  done
}

GEMINI_EXT=$HOME/.gemini/extensions/clyde
# Gemini CLI: the clyde extension, which is all ours (its manifest, with the MCP server Gemini CLI signs in to through OAuth,
# and its hooks). The old memory extension goes, and so do our hooks and servers in ~/.gemini/settings.json, so nothing
# runs twice.
put_gemini() {
  python3 -c "$PYLIB"'
home, mcp, here = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3])
ext = home / ".gemini/extensions/clyde"
old = home / ".gemini/extensions/memory"
cur = []
for p, k in ((ext / "gemini-extension.json", "clyde"), (old / "gemini-extension.json", "memory")):
    try:
        cur.append(json.loads(p.read_text()).get("mcpServers", {}).get(k, {}).get("httpUrl"))
    except (OSError, ValueError, AttributeError):
        pass
mcp = oauth_mcp(mcp, cur, [home / ".gemini/mcp-oauth-tokens.json", home / ".gemini/mcp-oauth-tokens-v2.json"])
manifest = json.loads((here / "gemini-extension.json").read_text())
for server in manifest.get("mcpServers", {}).values():
    server["httpUrl"] = mcp
write(ext / "gemini-extension.json", dump(manifest), 0o644)
write(ext / "hooks/hooks.json", (here / "gemini-hooks.json").read_text(), 0o644)
try:
    if json.loads((old / "gemini-extension.json").read_text()).get("name") == "memory":
        import shutil
        shutil.rmtree(old)
except (OSError, ValueError):
    pass
settings = home / ".gemini/settings.json"
doc = load(settings) if settings.exists() else None
if isinstance(doc, dict):
    if isinstance(doc.get("hooks"), dict):
        clean(doc["hooks"], list(doc["hooks"]))
        if not doc["hooks"]:
            del doc["hooks"]
    servers = doc.get("mcpServers")
    if isinstance(servers, dict):
        for name in ("clyde", "memory", "kb"):
            s = servers.get(name)
            if isinstance(s, dict) and re.search(r"heyclyde\.me|/functions/v1/memory", json.dumps(s)):
                del servers[name]
    write(settings, dump(doc))
' "$HOME" "$MCP_URL" "$HERE"
}

# Antigravity: clyde merged into ~/.gemini/config/mcp_config.json beside the other servers, which stay as they are, with the
# old memory and kb entries gone; and the clyde hook group in ~/.gemini/config/hooks.json. A file that won't parse is left
# alone.
put_antigravity() {
  python3 -c "$PYLIB"'
path, entry, mcp = Path(sys.argv[1]), json.loads(Path(sys.argv[2]).read_text())["mcpServers"]["clyde"], sys.argv[3]
doc = load(path)
servers = doc.setdefault("mcpServers", {}) if isinstance(doc, dict) else None
if not isinstance(servers, dict):
    sys.exit(f"{path} has no mcpServers object")
cur = [servers.get(k, {}).get("serverUrl") for k in ("clyde", "memory") if isinstance(servers.get(k), dict)]
mcp = oauth_mcp(mcp, cur, [Path.home() / ".gemini/antigravity/mcp_oauth_tokens.json"])
entry = {**entry, "serverUrl": mcp}
for old in ("memory", "kb"):
    servers.pop(old, None)
servers["clyde"] = entry
write(path, dump(doc))
' "$HOME/.gemini/config/mcp_config.json" "$HERE/antigravity-mcp.json" "$MCP_URL" &&
    merge_antigravity "$HOME/.gemini/config/hooks.json" "$HERE/antigravity-hooks.json" >/dev/null
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

  [ "$(cat "$DIR/url" 2>/dev/null)" = "$URL" ] || printf '%s\n' "$URL" > "$DIR/url"
  [ "$(cat "$DIR/token" 2>/dev/null)" = "$TOKEN" ] || printf '%s\n' "$TOKEN" > "$DIR/token"
  if [ -n "${MEMORY_HOOKS:-}" ]; then printf '%s\n' "$MEMORY_HOOKS" > "$DIR/hooks"; fi
  cmp -s "$HERE/signing-pub.pem" "$DIR/signing-pub.pem" 2>/dev/null || put_pub
  put_hook
  put_scripts
fi

# A self-update stops here. Each app's hook config is merged on its own, so a file that won't parse stops only that app's,
# and its file is left exactly as it was. Then the key, and memory-hook last, since its new version stamp is what says the
# update is done. Codex re-trusts hooks it has seen change, so a changed hooks.json leaves a note for the hook to print once.
# The exit status says whether anything failed.
if [ -n "$UPDATE" ]; then
  failed=0
  # Without the newer files there is nothing whole to install, so memory-hook stays as it is and the next call tries again.
  fetch_newer || { echo "install.sh --update: the files this release adds didn't verify." >&2; exit 1; }
  put_scripts || failed=1
  if grep -qs 'memory-hook\|clyde-hook\|clyde-gate' "$HOME/.claude/settings.json"; then
    merge ~/.claude/settings.json "$HERE/claude-settings.json" >/dev/null || failed=1
  fi
  if grep -qs 'memory-hook\|clyde-hook' "$HOME/.codex/hooks.json"; then
    if merged=$(merge ~/.codex/hooks.json "$HERE/codex-hooks.json"); then
      if [ "$merged" = changed ]; then : > "$DIR/codex-retrust"; fi
    else
      failed=1
    fi
  fi
  if [ -d "$GEMINI_EXT" ] || [ -d "$HOME/.gemini/extensions/memory" ]; then
    put_gemini || failed=1
  fi
  if grep -qs 'memory-hook\|clyde-hook' "$HOME/.gemini/config/hooks.json"; then
    merge_antigravity "$HOME/.gemini/config/hooks.json" "$HERE/antigravity-hooks.json" >/dev/null || failed=1
  fi
  newpub=$(mktemp "$DIR/.signing-pub.XXXXXX") || { failed=1; newpub=; }
  if [ -n "$newpub" ]; then
    cp "$HERE/signing-pub.pem" "$newpub" && chmod 600 "$newpub" || { failed=1; rm -f "$newpub"; newpub=; }
  fi
  # The key moves in only after memory-hook did, so a key never arrives without the client that came with it.
  if [ -n "$newpub" ] && put_hook; then
    mv -f "$newpub" "$DIR/signing-pub.pem" || { failed=1; rm -f "$newpub"; }
  else
    failed=1
    [ -z "$newpub" ] || rm -f "$newpub"
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

# claude_mcp <local|none> <check|write>: Claude Code's user-scope MCP servers in ~/.claude.json. check prints "settled" when
# clyde is exactly ours (local) or absent (none), and no memory or kb entry is there. write makes it so.
claude_mcp() {
  python3 -c "$PYLIB"'
path, want, mcp, token, act = Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
doc = load(path) if path.exists() else {}
servers = doc.get("mcpServers") if isinstance(doc, dict) else None
servers = servers if isinstance(servers, dict) else {}
entry = {"type": "http", "url": mcp, "headers": {"Authorization": f"Bearer {token}"}}
ok = not any(k in servers for k in ("memory", "kb")) and (servers.get("clyde") == entry if want == "local" else "clyde" not in servers)
if act == "check":
    print("settled" if ok else "")
    sys.exit(0)
for k in ("memory", "kb", "clyde"):
    servers.pop(k, None)
if want == "local":
    servers["clyde"] = entry
doc["mcpServers"] = servers
write(path, dump(doc))
' "$HOME/.claude.json" "$1" "$MCP_URL" "$TOKEN" "$2"
}

# Which apps are here, decided before anything below writes to ~/.gemini.
GEMINI= ANTIGRAVITY=
if command -v gemini >/dev/null 2>&1 || [ -d "$HOME/.gemini" ]; then GEMINI=1; fi
if [ -d "$HOME/.gemini/config" ] || command -v antigravity >/dev/null 2>&1 || command -v agy >/dev/null 2>&1; then ANTIGRAVITY=1; fi

# Claude Code: one MCP server named clyde (ours, the plugin's or the claude.ai connector's), the hooks, auto memory off, and
# the rule.
if [ -n "${MEMORY_CLAUDE:-}" ]; then printf '%s\n' "$MEMORY_CLAUDE" > "$DIR/claude-mode"; fi
MODE=${MEMORY_CLAUDE:-$(cat "$DIR/claude-mode" 2>/dev/null || true)}
case $MODE in plugin|connector) want=none ;; *) want=local ;; esac
if [ -z "$(claude_mcp "$want" check)" ]; then
  if CLAUDE=$(claude_cli); then
    for old in kb memory clyde; do "$CLAUDE" mcp remove "$old" --scope user >/dev/null 2>&1 || true; done
    if [ "$want" = local ]; then
      "$CLAUDE" mcp add --transport http --scope user clyde "$MCP_URL" --header "Authorization: Bearer $TOKEN" >/dev/null 2>&1 || true
    fi
  fi
  # Without the CLI, or when it wrote something else, the file gets exactly ours.
  [ -n "$(claude_mcp "$want" check)" ] || claude_mcp "$want" write
fi
merge ~/.claude/settings.json "$HERE/claude-settings.json" >/dev/null
put_rule ~/.claude/CLAUDE.md
case $want in
  local) echo "Claude Code: Clyde is connected as $DEVICE, with its hooks. Restart Claude Code to load them." ;;
  *) echo "Claude Code: the Clyde $MODE brings the MCP server. The hooks are in ~/.claude/settings.json. Restart Claude Code to load them." ;;
esac

# Codex: hooks in ~/.codex/hooks.json; the MCP server in config.toml with the header inline, since the Codex desktop and IDE
# apps don't read your shell profile; and Codex's own memories off.
merge ~/.codex/hooks.json "$HERE/codex-hooks.json" >/dev/null
python3 -c "$PYLIB"'
mcp, token = sys.argv[1], sys.argv[2]
path = Path.home() / ".codex/config.toml"
text = path.read_text() if path.exists() else ""
# Drop any earlier [mcp_servers.kb], [mcp_servers.memory] or [mcp_servers.clyde] table and its subtables, up to the next table.
names = r"(kb|memory|clyde)"
text = re.sub(r"(?ms)^\[mcp_servers\." + names + r"(\.[^\]]*)?\][^\n]*\n.*?(?=^\[(?!mcp_servers\." + names + r"[\].])|\Z)", "", text)
# Codex memories off: memories = false under [features].
lines = text.rstrip("\n").split("\n") if text.strip() else []
at = next((i for i, l in enumerate(lines) if l.strip() == "[features]"), None)
if at is None:
    lines += ["", "[features]", "memories = false"]
else:
    end = next((i for i in range(at + 1, len(lines)) if lines[i].lstrip().startswith("[")), len(lines))
    hit = next((i for i in range(at + 1, end) if re.match(r"\s*memories\s*=", lines[i])), None)
    if hit is None:
        lines.insert(at + 1, "memories = false")
    else:
        lines[hit] = "memories = false"
text = re.sub(r"\n{3,}", "\n\n", "\n".join(lines).strip("\n"))
auth = json.dumps("Bearer " + token)
block = f"[mcp_servers.clyde]\nurl = {json.dumps(mcp)}\nhttp_headers = {{ Authorization = {auth} }}\n"
text = (text + "\n\n" if text else "") + block
try:
    import tomllib
    tomllib.loads(text)
except ImportError:
    pass
write(path, text, 0o600)
' "$MCP_URL" "$TOKEN"
put_rule ~/.codex/AGENTS.md
echo "Codex: Clyde is connected as $DEVICE, with its hooks. Run /hooks in Codex once to trust them."

if [ -n "$GEMINI" ]; then
  put_gemini
  echo "Gemini CLI: the clyde extension is in ~/.gemini/extensions/clyde, with its hooks. Sign in when Gemini CLI asks, or run /mcp auth clyde in it."
else
  echo "Gemini CLI: not found, skipped."
fi
if [ -n "$ANTIGRAVITY" ]; then
  if put_antigravity; then
    echo "Antigravity: clyde is in ~/.gemini/config/mcp_config.json and its hooks in ~/.gemini/config/hooks.json. Sign in when Antigravity asks."
  else
    echo "Antigravity: couldn't read ~/.gemini/config, so it was left as it was." >&2
  fi
else
  echo "Antigravity: not found, skipped."
fi
if [ -n "$GEMINI" ] || [ -n "$ANTIGRAVITY" ]; then put_rule ~/.gemini/GEMINI.md; fi
echo "Done. Each app's own memory is off, and Clyde's hooks make register_agent and recall come first."
