// Local hook script and workspace agent rule templates (loopback/custom URL, zero cloud dependencies).

export function buildHookScript(defaultUrl = "http://127.0.0.1:8787"): string {
  return `#!/bin/sh
# clyde-hook.sh <client> <event>: Connects coding agents to your local Clyde memory daemon.
client=\${1:-claude}
event=\${2:-}
fallback() {
  case "$client:$event" in
    antigravity:Stop|antigravity:PreToolUse) printf '{"decision":"allow"}\\n' ;;
    antigravity:*|gemini:*|codex:Stop) printf '{}\\n' ;;
  esac
  exit 0
}
[ -n "$event" ] && command -v python3 >/dev/null 2>&1 || { cat >/dev/null 2>&1 || true; fallback; }

CLYDE_DEFAULT_URL="${defaultUrl}" python3 -c '
import json, os, re, sys, time, urllib.request
from pathlib import Path

client, event = sys.argv[1], sys.argv[2]
cfg_dir = Path.home() / ".config" / "clyde"
url = os.environ.get("CLYDE_URL") or ((cfg_dir / "url").read_text().strip() if (cfg_dir / "url").exists() else os.environ.get("CLYDE_DEFAULT_URL", "http://127.0.0.1:8787"))
token = os.environ.get("CLYDE_TOKEN") or ((cfg_dir / "token").read_text().strip() if (cfg_dir / "token").exists() else "")

raw = sys.stdin.read()
try:
    data = json.loads(raw) if raw.strip() else {}
except Exception:
    data = {}
if not isinstance(data, dict):
    data = {}

CANON = {
    "SessionStart": "SessionStart",
    "UserPromptSubmit": "UserPromptSubmit", "BeforeAgent": "UserPromptSubmit", "PreInvocation": "UserPromptSubmit",
    "PostToolUse": "PostToolUse", "AfterTool": "PostToolUse",
    "PreToolUse": "PreToolUse", "BeforeTool": "PreToolUse",
    "Stop": "Stop", "AfterAgent": "Stop",
}
canon = CANON.get(event, "")
if not canon:
    sys.exit(0)

def emit(msg=""):
    if client == "antigravity":
        if event in ("Stop", "PreToolUse"):
            print(json.dumps({"decision": "allow"}))
        elif event in ("SessionStart", "PreInvocation") and msg:
            print(json.dumps({"injectSteps": [{"ephemeralMessage": msg}]}))
        else:
            print("{}")
    elif client == "gemini":
        if event in ("SessionStart", "BeforeAgent") and msg:
            print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": msg}}))
        else:
            print("{}")
    elif msg:
        print(msg)

headers = {"content-type": "application/json", "user-agent": "clyde-local-hook/0.1"}
if token:
    headers["authorization"] = f"Bearer {token}"

try:
    req = urllib.request.Request(
        f"{url.rstrip(\"/\")}/hooks/{canon}?agent={client}",
        data=json.dumps(data).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=3) as resp:
        body = resp.read().decode("utf-8", errors="ignore").strip()
        emit(body)
except Exception:
    emit("")
' "$client" "$event" || fallback
`;
}

export const LOCAL_CLYDE_RULE = `<!-- clyde:begin -->
## Clyde Local Memory

Clyde is your shared memory across sessions and tools.
- Never use built-in client memory files. Save decisions, preferences, and verified findings with Clyde \`remember\`. Keep notes concise and never store secrets.
- Call \`register_agent\` first in a new session, then \`check_messages\`.
- Call \`recall\` when starting a new task or switching projects, and log outcomes with \`feedback\`.
<!-- clyde:end -->
`;
