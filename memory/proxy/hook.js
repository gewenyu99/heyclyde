// Clyde's cross-client lifecycle hook script and per-app hook configs, served at https://heyclyde.me/clyde-hook.sh
// and rendered on https://heyclyde.me/docs so humans and local setup agents share one tested source of truth.

export const HOOK_PATH = "~/.config/memory/clyde-hook.sh";
export const HOOK_URL = "https://heyclyde.me/clyde-hook.sh";
export const HOOK_INSTALL = `mkdir -p ~/.config/memory && curl -fsSL ${HOOK_URL} -o ${HOOK_PATH} && chmod 700 ${HOOK_PATH}`;

export const CLYDE_HOOK_SH = `#!/bin/sh
# clyde-hook.sh <client> <event>: task-shift hook for Antigravity, Claude Code, Codex, and Gemini CLI.
# Nudges Clyde recall on new tasks, folder switches, and 20m+ idle gaps. Stays silent on quick follow-ups,
# mid-turn Antigravity PreInvocation tool loops, and subagents. Always exits 0 so it never blocks a run.
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

python3 -c '
import hashlib, json, os, re, sys, tempfile, time, urllib.request
from pathlib import Path

client, event = sys.argv[1], sys.argv[2]
now = float(os.environ.get("CLYDE_HOOK_NOW") or time.time())
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
    "Stop": "Stop", "AfterAgent": "Stop",
    "PreToolUse": "PreToolUse", "PreCompact": "PreCompact", "SessionEnd": "SessionEnd",
}
canon = CANON.get(event, "")

def emit(msg="", raw_json=""):
    if raw_json:
        print(raw_json)
    elif client == "antigravity":
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
    elif client == "codex":
        if event == "Stop":
            print("{}")
        elif msg:
            print(msg)
    elif msg and event in ("SessionStart", "UserPromptSubmit"):
        print(msg)
    sys.exit(0)

if not canon:
    emit()

cfg = Path(os.environ.get("CLYDE_CONFIG_DIR") or (Path.home() / ".config/memory"))
sdir = Path(os.environ.get("CLYDE_HOOK_STATE_DIR") or (cfg / "hook-state"))
try:
    sdir.mkdir(parents=True, exist_ok=True)
    sdir.chmod(0o700)
except Exception:
    sdir = Path(tempfile.gettempdir()) / f"clyde-hook-{os.getuid()}"
    sdir.mkdir(parents=True, exist_ok=True)

def sha(s):
    return hashlib.sha256(s.encode("utf-8", "ignore")).hexdigest()[:24]

def load_json(p):
    try:
        return json.loads(p.read_text()) if p.exists() else {}
    except Exception:
        return {}

def save_json(p, obj):
    try:
        tmp = p.with_name(f".{p.name}.{os.getpid()}")
        tmp.write_text(json.dumps(obj))
        tmp.chmod(0o600)
        os.replace(tmp, p)
    except Exception:
        pass

sid = str(data.get("conversationId") or data.get("session_id") or data.get("conversation_id") or "default")
wpaths = data.get("workspacePaths") or data.get("workspace_roots") or []
cwd = str(data.get("cwd") or (wpaths[0] if isinstance(wpaths, list) and wpaths else "") or "")
prompt = str(data.get("prompt") or data.get("lastUserInput") or "")
tc = data.get("toolCall") if isinstance(data.get("toolCall"), dict) else {}
tname = str(data.get("tool_name") or tc.get("name") or "")
tinput = data.get("tool_input") if isinstance(data.get("tool_input"), dict) else (tc.get("args") if isinstance(tc.get("args"), dict) else {})

sub_file = sdir / "subagents.json"
if canon == "PreToolUse":
    if tname == "invoke_subagent":
        subs = load_json(sub_file)
        items = [x for x in (subs.get("items") or []) if isinstance(x, dict) and now - float(x.get("t", 0)) < 300]
        for spec in (tinput.get("Subagents") or []):
            if isinstance(spec, dict) and spec.get("Prompt"):
                items.append({"h": sha(str(spec["Prompt"]).strip()), "t": now})
        save_json(sub_file, {"items": items[-40:]})
    emit()

sfile = sdir / f"{sha(client + chr(58) + sid)}.json"
state = load_json(sfile)
phash = sha(prompt.strip()) if prompt.strip() else ""

if client == "antigravity":
    if state.get("subagent"):
        emit()
    subs = [x for x in (load_json(sub_file).get("items") or []) if isinstance(x, dict) and now - float(x.get("t", 0)) < 300]
    if phash and any(x.get("h") == phash for x in subs):
        state["subagent"] = True
        save_json(sfile, state)
        emit()
    if event == "SessionStart" and not phash and any(now - float(x.get("t", 0)) < 10 for x in subs):
        emit()
    if event == "PreInvocation":
        if not phash:
            emit()
        if phash == state.get("last_prompt_hash", "") and (not cwd or cwd == state.get("cwd", "")):
            emit()

STOP = {
    "the", "and", "for", "that", "this", "with", "from", "your", "have", "what", "when", "where",
    "into", "about", "then", "than", "them", "they", "there", "here", "just", "please", "can", "you",
    "could", "would", "should", "let", "lets", "make", "also", "some", "more", "only", "still",
}
FOLLOW_RE = re.compile(
    r"^(y|yes|yep|yeah|ok|okay|sure|k|kk|thanks|thank you|thx|ty|cool|nice|great|good|lgtm|"
    r"ship it|push|push it|push up|commit|commit it|commit and push|merge it|deploy|deploy it|"
    r"do it|go ahead|proceed|continue|keep going|try again|retry|rerun|run it|test it|fix it|revert|undo|stop)\\b",
    re.I,
)
TWEAK_RE = re.compile(r"\\b(fix line \\d+|line \\d+|typo|screenshot|show me a screenshot|same thing|as above)\\b", re.I)
GREET_RE = re.compile(r"^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)[!.?]*$", re.I)
SHIFT_RE = re.compile(r"\\b(new task|new goal|switch to|switching to|different repo|another repo|another project|unrelated|moving on to)\\b", re.I)

def words(text):
    out = []
    for w in re.findall(r"[a-z0-9][a-z0-9_-]{2,}", text.lower()):
        if w not in STOP and w not in out:
            out.append(w)
    return out[:24]

def is_followup(text):
    t = text.strip()
    if not t or t.startswith("/") or GREET_RE.match(t):
        return True
    wc = len(t.split())
    if FOLLOW_RE.match(t) and wc <= 7:
        return True
    if TWEAK_RE.search(t) and wc <= 10:
        return True
    return wc <= 3 and len(t) < 24 and not SHIFT_RE.search(t)

local_msg = ""
should_nudge = False

if canon == "SessionStart":
    state["started"] = True
    if cwd:
        state["cwd"] = cwd
    local_msg = "Clyde (top-level session only, skip in subagents): once this session, call register_agent and check_messages, then ack_messages once handled."
    if phash and not is_followup(prompt):
        state["last_prompt_hash"] = phash
        state["last_prompt_at"] = now
        state["last_nudge_at"] = now
        state["task_words"] = words(prompt)
        should_nudge = True
        local_msg += " Call recall for this task before guessing past decisions or preferences, then call feedback on what helped."
elif canon == "UserPromptSubmit":
    t = prompt.strip()
    prev_cwd = state.get("cwd", "")
    cwd_shifted = bool(cwd and prev_cwd and cwd != prev_cwd)
    if GREET_RE.match(t) and not cwd_shifted:
        if phash:
            state["last_prompt_hash"] = phash
        save_json(sfile, state)
        emit()
    first_task = not state.get("last_prompt_at")
    idle_gap = bool(state.get("last_prompt_at") and (now - float(state["last_prompt_at"])) >= 1200)
    pwords = words(prompt)
    twords = set(state.get("task_words") or [])
    recalled_recently = bool(state.get("last_recall_at") and (now - float(state["last_recall_at"])) < 120)
    cooled_down = (now - float(state.get("last_nudge_at") or 0)) >= 30
    topic_shifted = bool(SHIFT_RE.search(t)) or (len(pwords) >= 6 and bool(twords) and not (set(pwords) & twords) and cooled_down)
    if t.startswith("/"):
        should_nudge = False
    elif cwd_shifted:
        should_nudge = True
    elif first_task and t:
        should_nudge = True
    elif is_followup(t) or recalled_recently:
        should_nudge = False
    elif idle_gap or topic_shifted:
        should_nudge = True
    if phash:
        state["last_prompt_hash"] = phash
    if cwd:
        state["cwd"] = cwd
    if t or cwd_shifted:
        state["last_prompt_at"] = now
    if should_nudge:
        state["last_nudge_at"] = now
        if pwords:
            state["task_words"] = pwords
        local_msg = "Clyde (skip in subagents): new task or scope shift, so call recall before guessing past decisions or preferences, then call feedback on what helped."
    elif pwords:
        state["task_words"] = list(dict.fromkeys((state.get("task_words") or []) + pwords))[:24]
elif canon == "PostToolUse":
    if "recall" in tname.lower():
        state["last_recall_at"] = now
        qw = words(" ".join(str(tinput.get(k) or "") for k in ("query", "task")))
        if qw:
            state["task_words"] = list(dict.fromkeys(qw + (state.get("task_words") or [])))[:24]

save_json(sfile, state)

def read_txt(p):
    try:
        return p.read_text().strip() if p.exists() else ""
    except Exception:
        return ""

token = os.environ.get("MEMORY_TOKEN") or read_txt(cfg / "token")
url = (os.environ.get("MEMORY_URL") or read_txt(cfg / "url") or "https://memory.heyclyde.me").rstrip("/")
hmode = os.environ.get("MEMORY_HOOKS") or read_txt(cfg / "hooks") or "full"

server_msg = ""
inbox_msg = ""
if token and url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
    if hmode == "metadata":
        sbody = {"session_id": sid, "cwd": cwd, "hook_event_name": canon}
        for k in ("tool_name", "matcher", "source", "reason"):
            if k in data:
                sbody[k] = data[k]
        if tname and "tool_name" not in sbody:
            sbody["tool_name"] = tname
    else:
        sbody = dict(data)
        sbody.update({"session_id": sid, "cwd": cwd, "hook_event_name": canon})
        if prompt and "prompt" not in sbody:
            sbody["prompt"] = prompt
        if tname and "tool_name" not in sbody:
            sbody["tool_name"] = tname
        if tinput and "tool_input" not in sbody:
            sbody["tool_input"] = tinput
        if canon == "Stop" and "prompt_response" in data and "last_assistant_message" not in sbody:
            sbody["last_assistant_message"] = data["prompt_response"]
    try:
        req = urllib.request.Request(
            f"{url}/hooks/{canon}?agent={client}",
            data=json.dumps(sbody).encode("utf-8"),
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            if 200 <= resp.status < 300:
                server_msg = resp.read(8192).decode("utf-8", "ignore").strip()
    except Exception:
        pass
    if server_msg.startswith("{") and canon == "Stop" and client == "claude":
        emit(raw_json=server_msg)
    if canon == "SessionStart" or (canon == "UserPromptSubmit" and (should_nudge or server_msg)):
        try:
            mreq = urllib.request.Request(f"{url}/messages/{client}", headers={"Authorization": f"Bearer {token}"})
            with urllib.request.urlopen(mreq, timeout=2.5) as mresp:
                if 200 <= mresp.status < 300:
                    inbox_msg = mresp.read(8192).decode("utf-8", "ignore").strip()
        except Exception:
            pass

parts = []
if server_msg and not server_msg.startswith("{"):
    parts.append(server_msg)
if local_msg and not (server_msg and "recall" in server_msg and canon == "UserPromptSubmit"):
    parts.append(local_msg)
if inbox_msg:
    parts.append(inbox_msg)
emit("\\n".join(parts))
' "$client" "$event" || fallback
`;

export const ANTIGRAVITY_HOOKS_JSON = `{
  "clyde": {
    "SessionStart": [{ "type": "command", "command": "${HOOK_PATH} antigravity SessionStart", "timeout": 5 }],
    "PreInvocation": [{ "type": "command", "command": "${HOOK_PATH} antigravity PreInvocation", "timeout": 5 }],
    "PreToolUse": [{ "matcher": "invoke_subagent", "hooks": [{ "type": "command", "command": "${HOOK_PATH} antigravity PreToolUse", "timeout": 5 }] }],
    "PostToolUse": [{ "matcher": "^(mcp_+)?(clyde|memory)[_:\\\\.].*", "hooks": [{ "type": "command", "command": "${HOOK_PATH} antigravity PostToolUse", "timeout": 5 }] }],
    "Stop": [{ "type": "command", "command": "${HOOK_PATH} antigravity Stop", "timeout": 5 }]
  }
}`;

export const CLAUDE_HOOKS_JSON = `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} claude SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} claude UserPromptSubmit" }] }],
    "PostToolUse": [{ "matcher": "mcp__(plugin_clyde_)?(clyde|memory)__.*", "hooks": [{ "type": "command", "command": "${HOOK_PATH} claude PostToolUse" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} claude Stop" }] }],
    "PreCompact": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} claude PreCompact" }] }],
    "SessionEnd": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} claude SessionEnd" }] }]
  }
}`;

export const CODEX_HOOKS_JSON = `{
  "hooks": {
    "SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "${HOOK_PATH} codex SessionStart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} codex UserPromptSubmit" }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} codex Stop" }] }]
  }
}`;

export const GEMINI_HOOKS_JSON = `{
  "hooks": {
    "SessionStart": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} gemini SessionStart", "timeout": 5000 }] }],
    "BeforeAgent": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} gemini BeforeAgent", "timeout": 5000 }] }],
    "AfterTool": [{ "matcher": "mcp_+(clyde|memory)_.*|(clyde|memory)__.*", "hooks": [{ "type": "command", "command": "${HOOK_PATH} gemini AfterTool", "timeout": 5000 }] }],
    "AfterAgent": [{ "hooks": [{ "type": "command", "command": "${HOOK_PATH} gemini AfterAgent", "timeout": 5000 }] }]
  }
}`;

export const CLYDE_RULE = `Use Clyde MCP tools for shared memory across sessions and apps:
- Once per session, call register_agent and check_messages, then ack_messages once handled.
- On a new task, new goal, or repo/topic shift, call recall before guessing past decisions or preferences, then call feedback on what helped.
- Skip recall on quick follow-ups to the same task (typos, small tweaks, screenshots, "push it"), and skip Clyde inside subagents.
- When I state a lasting decision, preference, or correction, save it with remember under 500 characters. Never store secrets.`;

export const ANTIGRAVITY_RULE = `---
trigger: model_decision
description: Apply when starting a new goal, switching repos or topics, or saving a lasting decision or correction in Clyde. Skip on quick follow-ups to the same task and inside subagents.
---
${CLYDE_RULE}`;

// Confirms MCP auth, calls register_agent, and writes a first setup memory over HTTPS before a CLI restarts.
export const CLYDE_VERIFY_SH = `python3 - <<'PY'
import json, os, pathlib, platform, socket, urllib.request
cfg = pathlib.Path(os.environ.get("CLYDE_CONFIG_DIR") or pathlib.Path.home().joinpath(".config/memory"))
tok = (os.environ.get("MEMORY_TOKEN") or cfg.joinpath("token").read_text()).strip()
host = socket.gethostname().split(".")[0].lower() or "local"
url = (os.environ.get("MEMORY_URL") or "https://memory.heyclyde.me").rstrip("/") + "/mcp"
sid = None
def rpc(rid, method, params):
    global sid
    hdrs = {"Authorization": f"Bearer {tok}", "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if sid: hdrs["Mcp-Session-Id"] = sid
    req = urllib.request.Request(url, data=json.dumps({"jsonrpc": "2.0", "id": rid, "method": method, "params": params}).encode(), headers=hdrs)
    with urllib.request.urlopen(req, timeout=15) as r:
        sid = r.headers.get("mcp-session-id") or sid
        return json.loads(r.read().decode())
rpc(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "clyde-setup", "version": "1.0"}})
reg = rpc(2, "tools/call", {"name": "register_agent", "arguments": {
    "name": f"setup-{host}"[:32], "context": "work", "surface": "cli-setup",
    "description": f"Local coding agent on {host}.", "computer": host, "type": "coding",
}})
note = rpc(3, "tools/call", {"name": "remember", "arguments": {
    "pattern": "observations", "title": f"Connected {host} to Clyde",
    "body": f"Registered local coding agent on {host} ({platform.system()}) and verified Clyde MCP + task-shift hooks.",
    "evidence": f"Verified via clyde-setup on {host}", "computer": host,
}})
print("register_agent:", json.dumps(reg.get("result", reg)))
print("first_memory:", json.dumps(note.get("result", note)))
PY`;

