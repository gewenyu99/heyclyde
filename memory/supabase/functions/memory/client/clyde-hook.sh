#!/bin/sh
# clyde-hook.sh <client> <event>: Clyde's hook for Antigravity, Claude Code, Codex, and Gemini CLI. It makes Clyde the
# agent's only memory, and the gate makes that stick:
#   - Writes to the app's own memory files are always refused (PreToolUse, BeforeTool).
#   - An agent this app hasn't registered owes a register_agent. Until it calls one, every other tool is refused.
#   - A new task, folder switch or 20m+ idle gap owes a recall. Until the agent calls Clyde recall, every other tool is
#     refused (ToolSearch stays open, to load it).
#   - A debt expires after 20 minutes, so an outage never locks a session.
# Quick follow-ups, mid-turn Antigravity steps and subagents stay quiet. Always exits 0.
client=${1:-claude}
event=${2:-}
fallback() {
  case "$client:$event" in
    antigravity:Stop|antigravity:PreToolUse) printf '{"decision":"allow"}\n' ;;
    antigravity:*|gemini:*|codex:Stop) printf '{}\n' ;;
  esac
  exit 0
}
[ -n "$event" ] && command -v python3 >/dev/null 2>&1 || { cat >/dev/null 2>&1 || true; fallback; }

python3 -c '
import hashlib, json, os, re, subprocess, sys, tempfile, time, urllib.request
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
    "PreToolUse": "PreToolUse", "BeforeTool": "PreToolUse",
    "Stop": "Stop", "AfterAgent": "Stop",
    "PreCompact": "PreCompact", "SessionEnd": "SessionEnd",
}
canon = CANON.get(event, "")
DEBT_TTL = 1200
INSTALL = "curl -fsSL https://heyclyde.me/install | sh"
SCOPE = "Call Clyde recall before acting when the request changes scope or you need information that memory could supply, even after a recent recall. Skip it only when the same task continues unchanged."
SAVE = "Before replying, use Clyde remember to save any new decisions and results with their evidence. If there is nothing new to save, finish the reply."
REGISTER = "register_agent (name, context, surface, description, computer, type, projects)"

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
        elif msg and event in ("SessionStart", "UserPromptSubmit"):
            print(msg)
    elif msg and event in ("SessionStart", "UserPromptSubmit"):
        print(msg)
    sys.exit(0)

def deny(reason):
    if client in ("gemini", "antigravity"):
        print(json.dumps({"decision": "deny", "reason": reason}))
    else:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
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
# Antigravity runs every MCP tool through call_mcp_tool, and the tool itself is in ToolName.
if tname == "call_mcp_tool":
    tname = str(tinput.get("ToolName") or tinput.get("toolName") or tinput.get("tool_name") or tinput.get("name") or tname)

CLYDE_TOOLS = ("recall", "recall_more", "remember", "feedback", "register_agent", "check_messages", "ack_messages",
    "dismiss_messages", "post_message", "post_quest", "list_quests", "claim_quest", "update_quest", "complete_quest",
    "abandon_quest", "get_entry", "get_blob", "upload_blob")
def is_tool(name, *names):
    return any(re.search(r"(^|[_:.])" + n + "$", name) for n in names)

sfile = sdir / f"{sha(client + chr(58) + sid)}.json"
state = load_json(sfile)
regfile = sdir / f"registered-{client}.json"

def mark_registered():
    save_json(regfile, {"at": now})
    if state.pop("register_debt", None) is not None:
        save_json(sfile, state)

sub_file = sdir / "subagents.json"
if canon == "PreToolUse":
    if tname == "invoke_subagent":
        subs = load_json(sub_file)
        items = [x for x in (subs.get("items") or []) if isinstance(x, dict) and now - float(x.get("t", 0)) < 300]
        for spec in (tinput.get("Subagents") or []):
            if isinstance(spec, dict) and spec.get("Prompt"):
                h = sha(str(spec["Prompt"]).strip())
                if not any(x.get("h") == h for x in items):
                    items.append({"h": h, "t": now})
        save_json(sub_file, {"items": items[-40:]})
    # Never the memory files of the app itself: Claude Code auto memory, Codex memories, Antigravity knowledge, Gemini save_memory.
    seen = []
    for k, v in (tinput or {}).items():
        if isinstance(v, str):
            if re.search(r"path|file|command|cmd|target|notebook|cwd|dir", k, re.I):
                seen.append(v)
            elif re.search(r"patch|^input$", k, re.I):
                seen += re.findall(r"(?m)^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$", v)
        elif isinstance(v, list) and re.search(r"command|cmd|args|path|file", k, re.I):
            seen += [str(x) for x in v if isinstance(x, (str, int))]
    if is_tool(tname, "save_memory") or re.search(
            r"/\.claude/projects/[^ ]*/memory/|/\.claude/memory/|MEMORY\.md|/\.codex/memories|/\.gemini/antigravity/knowledge/",
            " ".join(seen)):
        deny("Clyde is the only memory for this agent, so the memory files of this app are off. Save it with Clyde remember, and recall from Clyde.")
    if state.get("subagent"):
        emit()
    if is_tool(tname, "register_agent"):
        mark_registered()
        emit()
    owed = state.get("register_debt")
    if isinstance(owed, dict):
        if now - float(owed.get("at", 0)) > DEBT_TTL or regfile.exists():
            state.pop("register_debt", None)
            save_json(sfile, state)
        elif tname != "ToolSearch":
            deny(f"Register with Clyde first. Call Clyde {REGISTER} before anything else (load it with ToolSearch if it is deferred), then carry on.")
    debt = state.get("debt")
    if isinstance(debt, dict):
        if is_tool(tname, "recall", "recall_more") or now - float(debt.get("at", 0)) > DEBT_TTL:
            state.pop("debt", None)
            save_json(sfile, state)
        elif tname != "ToolSearch":
            q = str(debt.get("query") or "").strip() or "this task"
            deny(f"Clyde recall comes first on a new task. Call Clyde recall with query \"{q}\" (load it with ToolSearch if it is deferred), then carry on.")
    emit()

if canon == "PostToolUse" and not is_tool(tname, *CLYDE_TOOLS):
    emit()

phash = sha(prompt.strip()) if prompt.strip() else ""

if canon == "UserPromptSubmit" and (data.get("stop_hook_active") or prompt.strip() == SAVE):
    emit()
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
    r"do it|go ahead|proceed|continue|keep going|try again|retry|rerun|run it|test it|fix it|revert|undo|stop)\b",
    re.I,
)
TWEAK_RE = re.compile(r"(?:fix line \d+(?: and show me a screenshot)?|show me a screenshot|same thing|as above|looks good|run the tests)", re.I)
GREET_RE = re.compile(r"^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening)[!.?]*$", re.I)
SHIFT_RE = re.compile(r"\b(new task|new goal|switch to|switching to|different repo|another repo|another project|unrelated|moving on to)\b", re.I)

def words(text):
    out = []
    for w in re.findall(r"[a-z0-9][a-z0-9_-]{2,}", text.lower()):
        if w not in STOP and w not in out:
            out.append(w)
    return out[:24]

def is_followup(text):
    t = text.strip()
    if not t or GREET_RE.match(t):
        return True
    t = t.rstrip(".!?").lower()
    return bool(FOLLOW_RE.fullmatch(t) or TWEAK_RE.fullmatch(t))

local_msg = ""
should_nudge = False
pwords = []
ONLY = "Clyde is the only memory for this agent: never use the built-in memory or memory files of this app."
BUSY = "Clyde: Clyde is busy right now and did not answer, so nothing is blocked. Carry on without him. Check on him at https://memory.heyclyde.me/healthz or email support@heyclyde.me."
RECALL = "Clyde: new task, so recall comes first. Call Clyde recall before anything else (other tools are refused until you do), then call feedback on what helped."

if canon == "SessionStart":
    state["started"] = True
    if cwd:
        state["cwd"] = cwd
    local_msg = ONLY + " Top-level session only (skip in subagents): once this session, call check_messages, then ack_messages once handled. " + SCOPE + " " + SAVE
    if phash and not is_followup(prompt):
        state["last_prompt_hash"] = phash
        state["last_prompt_at"] = now
        state["last_nudge_at"] = now
        state["task_words"] = pwords = words(prompt)
        should_nudge = True
        local_msg += " " + RECALL
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
    cooled_down = (now - float(state.get("last_nudge_at") or 0)) >= 30
    topic_shifted = bool(SHIFT_RE.search(t)) or (len(pwords) >= 6 and bool(twords) and not (set(pwords) & twords) and cooled_down)
    followup = is_followup(t)
    should_nudge = cwd_shifted or bool(t and (first_task or (not followup and (idle_gap or topic_shifted))))
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
        local_msg = RECALL
    elif t and not followup:
        local_msg = SCOPE
        state["task_words"] = list(dict.fromkeys((state.get("task_words") or []) + pwords))[:24]
elif canon == "PostToolUse":
    if is_tool(tname, "register_agent"):
        mark_registered()
    if is_tool(tname, "recall", "recall_more"):
        state.pop("debt", None)
        qw = words(" ".join(str(tinput.get(k) or "") for k in ("query", "task")))
        if qw:
            state["task_words"] = list(dict.fromkeys(qw + (state.get("task_words") or [])))[:24]

save_json(sfile, state)

def read_txt(p):
    try:
        return p.read_text().strip() if p.exists() else ""
    except Exception:
        return ""

def isver(v):
    return bool(re.fullmatch(r"\d{8}\.\d+", v or ""))

def vkey(v):
    a, b = v.split(".")
    return (int(a), int(b))

# The installed client version is the stamp in memory-hook, which the signed self-update moves. A hook with no memory-hook
# beside it (copied from the docs) is "dev", which the server counts as current.
ver = "dev"
for line in read_txt(cfg / "memory-hook").splitlines():
    if line.startswith("VERSION="):
        ver = line[8:].strip() if isver(line[8:].strip()) else "dev"
        break
failed_file = cfg / "update-failed"
# A User-Agent of its own: Cloudflare in front of memory.heyclyde.me refuses the default Python-urllib one (error 1010).
vheaders = {"x-memory-client-version": ver, "User-Agent": f"clyde-hook/{ver}"}
if failed_file.exists():
    vheaders["x-memory-update-failed"] = "1"

token = os.environ.get("MEMORY_TOKEN") or read_txt(cfg / "token")
# The Supabase function itself is the same server as memory.heyclyde.me.
RAW = "https://wlhlncmgjqyidosunugv.supabase.co/functions/v1/memory"
def server(u):
    u = u.rstrip("/")
    return "https://memory.heyclyde.me" if u == RAW else u
url = server(os.environ.get("MEMORY_URL") or read_txt(cfg / "url") or "https://memory.heyclyde.me")
pinned = server(read_txt(cfg / "url"))
hmode = os.environ.get("MEMORY_HOOKS") or read_txt(cfg / "hooks") or "full"

server_msg = ""
down = False
inbox_msg = ""
status = ""
registered = None
if token and url.startswith(("https://", "http://127.0.0.1", "http://localhost")):
    git_remote = ""
    if canon == "SessionStart" and cwd and cwd != "/":
        try:
            gr = subprocess.run(["git", "-C", cwd, "config", "--get", "remote.origin.url"], capture_output=True, text=True, timeout=1.0)
            if gr.returncode == 0:
                git_remote = (gr.stdout or "").strip()
        except Exception:
            git_remote = ""
    if hmode == "metadata":
        sbody = {"session_id": sid, "cwd": cwd, "hook_event_name": canon}
        if git_remote:
            sbody["git_remote"] = git_remote
        for k in ("tool_name", "matcher", "source", "reason"):
            if k in data:
                sbody[k] = data[k]
        if tname and "tool_name" not in sbody:
            sbody["tool_name"] = tname
    else:
        sbody = dict(data)
        sbody.update({"session_id": sid, "cwd": cwd, "hook_event_name": canon})
        if git_remote and "git_remote" not in sbody:
            sbody["git_remote"] = git_remote
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
            headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json", **vheaders},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=2.5) as resp:
            latest = resp.headers.get("x-memory-client-latest") or ""
            status = resp.headers.get("x-memory-client-status") or ""
            reg = resp.headers.get("x-clyde-registered") or ""
            registered = True if reg == "1" else (False if reg == "0" else None)
            if 200 <= resp.status < 300:
                server_msg = resp.read(8192).decode("utf-8", "ignore").strip()
        # Self-update, only on the word of the server in the url file, over https, through the signed memory-hook.
        if pinned and url == pinned and pinned.startswith("https://") and isver(latest) and isver(ver):
            if vkey(latest) > vkey(ver):
                recent = failed_file.exists() and time.time() - failed_file.stat().st_mtime < 600
                if os.access(cfg / "memory-hook", os.X_OK) and not recent:
                    subprocess.Popen([str(cfg / "memory-hook"), "--update"], stdin=subprocess.DEVNULL,
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            elif failed_file.exists():
                failed_file.unlink()
    except Exception:
        down = True
    if server_msg.startswith("{") and canon == "Stop" and client == "claude":
        emit(raw_json=server_msg)
    if not down and (canon == "SessionStart" or (canon == "UserPromptSubmit" and (should_nudge or server_msg))):
        try:
            mreq = urllib.request.Request(f"{url}/messages/{client}", headers={"Authorization": f"Bearer {token}", **vheaders})
            with urllib.request.urlopen(mreq, timeout=2.5) as mresp:
                if 200 <= mresp.status < 300:
                    inbox_msg = mresp.read(8192).decode("utf-8", "ignore").strip()
        except Exception:
            pass

# Stop never blocks: a block makes the agent reply a second time. The save reminder rides on the prompt instead.
parts = []
owes_recall = False
if down and canon in ("SessionStart", "UserPromptSubmit"):
    state.pop("debt", None)
    state.pop("register_debt", None)
    save_json(sfile, state)
    if not state.get("subagent"):
        parts.append(BUSY)
elif canon == "SessionStart" and not state.get("subagent"):
    if registered is True:
        save_json(regfile, {"at": now})
    elif not regfile.exists():
        state["register_debt"] = {"at": now}
        parts.append(f"Clyde: this agent is not registered. Call Clyde {REGISTER} before anything else (other tools are refused until you do).")
if canon in ("SessionStart", "UserPromptSubmit") and not state.get("subagent") and not down:
    owes_recall = should_nudge or (canon == "UserPromptSubmit" and "recall" in server_msg and not server_msg.startswith("{"))
    if owes_recall:
        m = re.search(r"recall\(\"([^\"]*)\"\)", server_msg)
        state["debt"] = {"at": now, "query": m.group(1) if m else " ".join(pwords[:5])}
    if owes_recall or "register_debt" in state:
        save_json(sfile, state)
if server_msg and not server_msg.startswith("{"):
    parts.append(server_msg)
if local_msg and not down and not (server_msg and "recall" in server_msg and canon == "UserPromptSubmit"):
    parts.append(local_msg)
elif owes_recall:
    parts.append("Clyde: other tools are refused until that call is made.")
if canon == "UserPromptSubmit" and parts and not down and not state.get("subagent"):
    parts.append(SAVE)
if status == "expired" and failed_file.exists() and pinned and canon in ("SessionStart", "UserPromptSubmit"):
    parts.append(f"Clyde: the Clyde client on this computer is out of date. Rerun `{INSTALL}`, which needs no new sign-in.")
if inbox_msg:
    parts.append(inbox_msg)
emit("\n".join(parts))
' "$client" "$event" || fallback
