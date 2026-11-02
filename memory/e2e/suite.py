#!/usr/bin/env python3
"""memory's end-to-end suite, run by run.sh against a preview branch's memory function. Python stdlib only.

It reads E2E_URL (the branch function), E2E_REF and E2E_WORKDIR (for SQL on the branch through the Supabase CLI) and
E2E_SECRETS (the tokens run.sh seeded). It never prints a token. It writes its exit status to E2E_RC: 0 when every test
passed, counting an expected failure (XFAIL) as passing. E2E_STRICT=1 counts expected failures as failures.
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

URL = os.environ["E2E_URL"].rstrip("/")
REF = os.environ["E2E_REF"]
WORKDIR = os.environ["E2E_WORKDIR"]
SECRETS = dict(l.split("=", 1) for l in Path(os.environ["E2E_SECRETS"]).read_text().splitlines() if "=" in l)
R15_WAIT = int(os.environ.get("E2E_R15_WAIT", "360"))
STRICT = os.environ.get("E2E_STRICT") == "1"
PROD = "wlhlncmgjqyidosunugv"
assert REF != PROD and PROD not in URL, "the suite runs on a branch, never on production"


class Fail(Exception):
    pass


def check(cond, msg):
    if not cond:
        raise Fail(msg)


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def http(method, path, body=None, token=None, headers=None, timeout=60):
    """(status, headers, text). Redirects are returned, not followed."""
    h = {"Accept": "application/json, text/event-stream", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    if token:
        h["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(URL + path, data=data, method=method, headers=h)
    try:
        with OPENER.open(req, timeout=timeout) as r:
            return r.status, r.headers, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read().decode()


def sql(statement):
    """SQL on the branch, through the CLI's login role. The workdir is a scratch copy linked to nothing."""
    r = subprocess.run(["supabase", "db", "query", "--linked", "--project-ref", REF, "--workdir", WORKDIR, statement],
                       capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=120)
    check(r.returncode == 0, f"SQL on the branch failed: {r.stderr.strip()[-300:]}")


class Mcp:
    """One MCP session over streamable HTTP, as a client like Claude Code would hold it."""

    def __init__(self, token, client="e2e"):
        self.token, self.session, self.n = token, None, 0
        status, headers, text = self.call("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": client, "version": "0"}})
        check(status == 200, f"initialize answered {status}: {text[:200]}")
        self.session = headers.get("mcp-session-id")
        check(self.session, "initialize returned no Mcp-Session-Id")

    def call(self, method, params):
        self.n += 1
        h = {"MCP-Protocol-Version": "2025-06-18"}
        if self.session:
            h["Mcp-Session-Id"] = self.session
        return http("POST", "/mcp", {"jsonrpc": "2.0", "id": self.n, "method": method, "params": params}, self.token, h)

    def tool(self, name, **args):
        status, _, text = self.call("tools/call", {"name": name, "arguments": args})
        check(status == 200, f"{name} answered {status}: {text[:200]}")
        result = json.loads(text).get("result") or {}
        out = "\n".join(c.get("text", "") for c in result.get("content", []))
        check(not result.get("isError"), f"{name} failed: {out[:300]}")
        return out


# ---------------------------------------------------------------- tests
def test_r7_mcp_challenge():
    """R7: /mcp with no token is a 401 that points the client at how to sign in."""
    status, headers, _ = http("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
    check(status == 401, f"expected 401, got {status}")
    challenge = headers.get("www-authenticate") or ""
    check(challenge.startswith("Bearer ") and "resource_metadata=" in challenge,
          f"WWW-Authenticate was {challenge!r}")
    meta = challenge.split('resource_metadata="', 1)[1].split('"', 1)[0]
    check(meta.startswith(URL), f"resource_metadata {meta} isn't on the branch")
    return f"401, WWW-Authenticate: {challenge}"


def test_r7_oauth_wait():
    """R7: the waiting window refreshes while nobody has clicked, and moves on with a 302 once the click lands."""
    aid = "e2e-" + secrets.token_hex(8)
    target = f"https://claude.ai/api/mcp/auth_callback?code=e2e-{secrets.token_hex(4)}"
    sql(f"insert into memory.oauth_consent (authorization_id, code_verifier) values ('{aid}', 'e2e-verifier')")
    status, headers, text = http("GET", f"/oauth/wait?authorization_id={aid}")
    check(status == 200, f"waiting: expected 200, got {status}: {text[:200]}")
    refresh = headers.get("refresh") or ""
    check(refresh.startswith("3;") and f"authorization_id={aid}" in refresh, f"Refresh header was {refresh!r}")
    sql(f"update memory.oauth_consent set redirect_url = '{target}' where authorization_id = '{aid}'")
    status, headers, _ = http("GET", f"/oauth/wait?authorization_id={aid}")
    check(status == 302, f"after the click: expected 302, got {status}")
    check(headers.get("location") == target, f"Location was {headers.get('location')!r}")
    status, _, _ = http("GET", f"/oauth/wait?authorization_id={aid}")
    check(status == 410, f"a used consent should be gone (410), got {status}")
    return "200 + Refresh while waiting, 302 to the client once redirect_url is set, 410 after"


def test_admin_token():
    """The seeded admin token opens /api/v1, and a wrong one doesn't."""
    status, _, text = http("GET", "/api/v1/devices", token=SECRETS["ADMIN_TOKEN"])
    check(status == 200, f"expected 200, got {status}: {text[:200]}")
    names = {d.get("name") for d in json.loads(text)}
    check({"e2e-a", "e2e-b", "e2e-install"} <= names, f"devices listed: {sorted(n for n in names if n)}")
    status, _, _ = http("GET", "/api/v1/devices", token="wrong-" + secrets.token_hex(8))
    check(status == 401, f"a wrong admin token got {status}")
    return "200 with the three seeded devices, 401 for a wrong token"


def claude_cli():
    """Claude Code's CLI, from PATH or the desktop app's bundle, the same places install.sh looks."""
    found = shutil.which("claude")
    if found:
        return found
    app = Path.home() / "Library/Application Support/Claude/claude-code"
    versions = sorted(app.glob("*/*/claude.app/Contents/MacOS/claude"),
                      key=lambda p: [int(x) if x.isdigit() else 0 for x in p.parts[-6].split(".")], reverse=True)
    return str(versions[0]) if versions else None


def test_r5_installer():
    """R5: the installer the branch serves connects a computer that already holds a token, with no email step."""
    status, _, script = http("GET", "/install")
    check(status == 200 and script.startswith("#!/bin/sh"), f"/install answered {status}")
    cli = claude_cli()
    check(cli, "no Claude Code CLI on this computer, so the installer would skip ~/.claude.json")
    home = Path(tempfile.mkdtemp(prefix="memory-e2e-home."))
    try:
        bin_dir = home / "bin"
        bin_dir.mkdir()
        (bin_dir / "claude").symlink_to(cli)
        (home / "install.sh").write_text(script)
        # A clean environment: nothing from the Claude session running this, so the CLI can only write under HOME.
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("CLAUDE", "ANTHROPIC", "XDG_", "CODEX", "MEMORY_", "E2E_"))}
        env.update(HOME=str(home), PATH=f"{bin_dir}:{env.get('PATH', '/usr/bin:/bin')}", MEMORY_URL=URL,
                   MEMORY_TOKEN=SECRETS["INSTALL_TOKEN"], MEMORY_DEVICE="e2e-install")
        r = subprocess.run(["sh", str(home / "install.sh")], env=env, cwd=home, capture_output=True, text=True,
                           stdin=subprocess.DEVNULL, timeout=180)
        check(r.returncode == 0, f"install.sh exited {r.returncode}: {(r.stderr or r.stdout).strip()[-400:]}")
        check("Claude Code: connected as e2e-install" in r.stdout, f"install.sh said: {r.stdout.strip()[-300:]}")
        conf = json.loads((home / ".claude.json").read_text())
        entry = (conf.get("mcpServers") or {}).get("memory")
        check(entry, f"~/.claude.json has no memory MCP server (has {sorted(conf.get('mcpServers') or {})})")
        check(entry.get("url") == f"{URL}/mcp", f"memory's url is {entry.get('url')}")
        auth = (entry.get("headers") or {}).get("Authorization", "")
        check(auth == f"Bearer {SECRETS['INSTALL_TOKEN']}", "memory's Authorization header isn't the device token")
        token = (home / ".config/memory/token").read_text().strip()
        check(token == SECRETS["INSTALL_TOKEN"], "~/.config/memory/token isn't the device token")
        status, _, text = http("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "e2e"}}}, token)
        check(status == 200, f"initialize with the installed token answered {status}: {text[:200]}")
        codex = (home / ".codex/config.toml").read_text()
        check("[mcp_servers.memory]" in codex, "~/.codex/config.toml has no [mcp_servers.memory]")
        return "install.sh exit 0; ~/.claude.json memory -> branch /mcp; initialize with its token 200; Codex configured"
    finally:
        shutil.rmtree(home, ignore_errors=True)


def test_r15_cross_session_recall():
    """R15: a note one session remembers reaches another session's unscoped recall within 6 minutes."""
    nonce = secrets.token_hex(4)
    word = f"canary{nonce}"
    run = f"run:e2e-{nonce}"
    a = Mcp(SECRETS["DEVICE_TOKEN_A"], "claude-code")
    out = a.tool("remember", pattern="projects", title=f"e2e run {nonce}", body=f"The e2e suite's run {nonce}.",
                 scope=run, evidence="Written by memory/e2e/suite.py.", evidence_kind="summary", authority="draft")
    project = out.split("Remembered ", 1)[1].split(".\n", 1)[0].rstrip(".")
    out = a.tool("remember", pattern="observations", title=f"The {word} note",
                 body=f"The e2e {word} note: session A wrote this so session B can recall it.", scope=run,
                 evidence="Written by memory/e2e/suite.py.", evidence_kind="summary", authority="draft", project=project)
    entry = out.split("Remembered ", 1)[1].split(".\n", 1)[0].rstrip(".")
    b = Mcp(SECRETS["DEVICE_TOKEN_B"], "codex-mcp-client")
    started = time.time()
    tries = 0
    while True:
        tries += 1
        packet = b.tool("recall", query=f"the {word} note", task="checking what another session remembered")
        if word in packet or entry in packet:
            return f"session B recalled {entry} after {int(time.time() - started)} s ({tries} recalls)"
        if time.time() - started >= R15_WAIT:
            first = packet.splitlines()[2] if len(packet.splitlines()) > 2 else packet
            raise Fail(f"session B's unscoped recall never returned {entry} in {R15_WAIT} s ({tries} recalls); "
                       f"last packet: {first[:160]!r}")
        time.sleep(30)


TESTS = [
    ("R7  /mcp 401 + WWW-Authenticate", test_r7_mcp_challenge, False),
    ("R7  /oauth/wait Refresh, then 302", test_r7_oauth_wait, False),
    ("    admin token on /api/v1", test_admin_token, False),
    ("R5  installer with MEMORY_TOKEN", test_r5_installer, False),
    # Expected to fail until R15 lands: an agent's notes live in a run scope, which unscoped recall leaves out.
    ("R15 cross-session recall", test_r15_cross_session_recall, True),
]


def main():
    failed = 0
    rows = []
    for name, fn, expected_fail in TESTS:
        t = time.time()
        try:
            detail = fn()
            verdict = "XPASS" if expected_fail else "PASS"
        except Exception as e:  # noqa: BLE001 - every error is a test result here
            detail = f"{type(e).__name__}: {e}" if not isinstance(e, Fail) else str(e)
            verdict = "XFAIL" if expected_fail and not STRICT else "FAIL"
        if verdict == "FAIL":
            failed += 1
        rows.append((verdict, name))
        print(f"{verdict:5} {name} ({time.time() - t:.0f} s): {detail}", flush=True)
    print("\nsummary: " + ", ".join(f"{n.strip()} {v}" for v, n in rows))
    if any(v == "XPASS" for v, _ in rows):
        print("An expected failure passed. Mark it as expected to pass in suite.py.")
    Path(os.environ.get("E2E_RC", os.devnull)).write_text(str(1 if failed else 0))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
