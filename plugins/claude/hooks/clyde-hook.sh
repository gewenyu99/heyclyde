#!/bin/sh
# Self-contained optional Clyde hook forwarder for Claude Code.
# Off by default: exits 0 with zero stdout and zero network calls unless the user sets
# CLAUDE_PLUGIN_OPTION_HOOK_MODE to "metadata" or "full" AND provides CLAUDE_PLUGIN_OPTION_DEVICE_TOKEN.
mode=${CLAUDE_PLUGIN_OPTION_HOOK_MODE:-off}
token=${CLAUDE_PLUGIN_OPTION_DEVICE_TOKEN:-}
event=${1:-}

case "$mode" in
  metadata|full) ;;
  *) cat >/dev/null; exit 0 ;;
esac

if [ -z "$token" ] || [ -z "$event" ]; then
  cat >/dev/null
  exit 0
fi

case "$event" in
  SessionStart|UserPromptSubmit|PostToolUse|Stop|PreCompact|SessionEnd) ;;
  *) cat >/dev/null; exit 0 ;;
esac

if ! command -v curl >/dev/null 2>&1; then
  cat >/dev/null
  exit 0
fi

url="https://memory.heyclyde.me"
payload_file=$(mktemp 2>/dev/null) || { cat >/dev/null; exit 0; }
body_file=$(mktemp 2>/dev/null) || { rm -f "$payload_file"; cat >/dev/null; exit 0; }
trap 'rm -f "$payload_file" "$body_file"' EXIT HUP INT TERM

if [ "$mode" = "metadata" ]; then
  if command -v python3 >/dev/null 2>&1; then
    python3 -c '
import json, sys
KEYS = ("session_id", "cwd", "hook_event_name", "tool_name", "matcher", "source", "reason")
try:
    raw = json.load(sys.stdin)
except Exception:
    raw = {}
out = {k: raw[k] for k in KEYS if isinstance(raw, dict) and k in raw} if isinstance(raw, dict) else {}
json.dump(out, sys.stdout)
' >"$payload_file" 2>/dev/null || printf '{}' >"$payload_file"
  else
    cat >/dev/null
    printf '{}' >"$payload_file"
  fi
else
  cat >"$payload_file"
fi

code=$(curl -sS -m 3 -o "$body_file" -w '%{http_code}' -X POST "$url/hooks/$event?agent=claude"   -H "Authorization: Bearer $token"   -H "Content-Type: application/json"   --data-binary @"$payload_file" 2>/dev/null) || code=000

is_json=""
case "$event" in
  SessionStart|UserPromptSubmit|Stop)
    case "$code" in
      2??)
        if [ -s "$body_file" ]; then
          head -c 8192 "$body_file"
          [ "$(head -c 8192 "$body_file" | tr -d ' 	
' | head -c 1)" = '{' ] && is_json=1
        fi
        ;;
    esac
    ;;
esac

if [ -z "$is_json" ]; then
  case "$event" in
    SessionStart|UserPromptSubmit)
      curl -fsS -m 3 -H "Authorization: Bearer $token" "$url/messages/claude" 2>/dev/null || true
      ;;
  esac
fi

exit 0
