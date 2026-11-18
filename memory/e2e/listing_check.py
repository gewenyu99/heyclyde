#!/usr/bin/env python3
"""R55 (#60): every URL, asset and answer the Claude directory and Google Connected Apps ask for exists.

    python3 memory/e2e/listing_check.py                      # every section, against https://heyclyde.me
    python3 memory/e2e/listing_check.py "icons" "docs pages" # some sections
    python3 memory/e2e/listing_check.py --base http://localhost:8787

Each section prints PASS or FAIL with its reasons. The exit code is the number of failed sections. Only the Python
standard library, so it runs anywhere. The live sections fetch the site; "listing copy" and "submission answers" read
memory/listing/ from this checkout. Add a section by adding a function to SECTIONS.
"""
import io
import json
import re
import struct
import sys
import tarfile
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LISTING = ROOT / "listing"
BASE = "https://heyclyde.me"
CONNECTOR = "https://heyclyde.me/mcp"


def fetch(path, accept="text/html"):
    req = urllib.request.Request(BASE + path, headers={"accept": accept, "user-agent": "clyde-listing-check/1"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read()


def page_text(body):
    html = body.decode("utf-8", "replace")
    html = re.sub(r"<style[\s\S]*?</style>|<script[\s\S]*?</script>", "", html)
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html)).replace("&amp;", "&")


def html_page(path, errs):
    status, ctype, body = fetch(path)
    if status != 200:
        errs.append(f"{path}: status {status}")
    if not ctype.startswith("text/html"):
        errs.append(f"{path}: content-type {ctype!r}")
    return page_text(body)


def needs(errs, where, text, words):
    for w in words:
        if w not in text:
            errs.append(f"{where}: missing {w!r}")


def legal_pages(errs):
    priv = html_page("/privacy", errs)
    needs(errs, "/privacy", priv, ["Supabase", "OpenAI", "Polar", "Resend", "Cloudflare", "export", "delete", "30 days"])
    needs(errs, "/terms", html_page("/terms", errs), ["Ontario", "Quebec"])
    html_page("/docs", errs)


# Support and the Grok guide live on /docs (at #support and #grok), and the papers on /how-it-works. The old addresses
# answer 301 to them.
MOVED = {"/research": "/how-it-works", "/support": "/docs#support", "/docs/grok": "/docs#grok", "/signin": "/docs"}
PAPERS = ["arxiv.org/abs/2607.13591", "alphaxiv.org/abs/2602.22406", "PMC3069643", "NBK3905", "arxiv.org/pdf/2604.27283",
          "arxiv.org/html/2604.00131", "taatgenLebiereAnderson.pdf"]


def docs_pages(errs):
    status, ctype, body = fetch("/docs")
    if status != 200 or not ctype.startswith("text/html"):
        errs.append(f"/docs: status {status}, content-type {ctype!r}")
    html = body.decode("utf-8", "replace")
    needs(errs, "/docs", page_text(body), [CONNECTOR, "Claude", "Gemini", "Grok", "export", "delete", "support@heyclyde.me"])
    needs(errs, "/docs", html, ['id="support"', 'href="mailto:support@heyclyde.me"', 'id="grok"', "grok.com/connectors"])
    status, ctype, body = fetch("/how-it-works")
    if status != 200 or not ctype.startswith("text/html"):
        errs.append(f"/how-it-works: status {status}, content-type {ctype!r}")
    needs(errs, "/how-it-works", body.decode("utf-8", "replace"), PAPERS)
    for old, new in MOVED.items():
        status, location = redirect_of(BASE + old)
        if status != 301 or location != BASE + new:
            errs.append(f"{old}: status {status}, location {location!r}, want 301 to {BASE + new}")


def png_size(body):
    if body[:8] != b"\x89PNG\r\n\x1a\n" or body[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", body[16:24])


def icons(errs):
    for name, side, limit in [("clyde-512.png", 512, 1_048_576), ("clyde-48.png", 48, None)]:
        status, ctype, body = fetch(f"/brand/{name}", "image/png")
        if status != 200 or not ctype.startswith("image/png"):
            errs.append(f"{name}: status {status}, content-type {ctype!r}")
        if png_size(body) != (side, side):
            errs.append(f"{name}: size {png_size(body)}, want {side} x {side}")
        if limit and len(body) > limit:
            errs.append(f"{name}: {len(body)} bytes > {limit}")
    status, ctype, body = fetch("/brand/clyde.svg", "image/svg+xml")
    if status != 200 or not ctype.startswith("image/svg+xml"):
        errs.append(f"clyde.svg: status {status}, content-type {ctype!r}")
        return
    try:
        svg = ET.fromstring(body)
    except ET.ParseError as e:
        errs.append(f"clyde.svg: parse error {e}")
        return
    w, h = (float(re.sub(r"px$", "", svg.get(k, "0"))) for k in ("width", "height"))
    vb = [float(v) for v in svg.get("viewBox", "0 0 0 0").replace(",", " ").split()]
    if not (w == h >= 500):
        errs.append(f"clyde.svg: width {w} x height {h}, want equal and >= 500")
    if len(vb) != 4 or vb[2] != vb[3]:
        errs.append(f"clyde.svg: viewBox {vb} is not square")
        return
    side = vb[2]
    circles = [c for c in svg.iter() if c.tag.endswith("circle")]
    if not any(abs(float(c.get("cx", 0)) - (vb[0] + side / 2)) < 0.01 and abs(float(c.get("cy", 0)) - (vb[1] + side / 2)) < 0.01
               and abs(float(c.get("r", 0)) - side / 2) < 0.01 for c in circles):
        errs.append("clyde.svg: no <circle> centred in the viewBox with r = half its side")


FUNCTION = "https://memory.heyclyde.me"
REVIEWER = "review@heyclyde.me"


def call(method, url, token=None, body=None, apikey=None, form=False):
    """(status, parsed JSON or text). Never prints a token or the password."""
    headers = {"Accept": "application/json", "User-Agent": "clyde-listing-check"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if apikey:
        headers["apikey"] = apikey
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode()
            status = r.status
    except urllib.error.HTTPError as e:
        raw, status = e.read().decode(), e.code
    try:
        return status, json.loads(raw)
    except ValueError:
        return status, raw


def reviewer_account(errs):
    """R55: review@heyclyde.me signs in with its password, has no MFA factor, holds 40 notes, and a deleted one comes back
    with the reseed. The password is ~/.config/memory/review-password (0600, made by memory/seed/reviewer.sh); the reseed
    is triggered with the admin token, as the nightly cron would run it."""
    pw_file = Path.home() / ".config/memory/review-password"
    admin_file = Path.home() / ".config/memory/admin-token"
    if not pw_file.exists():
        errs.append(f"no {pw_file}: the reviewer account isn't made yet (memory/seed/reviewer.sh)")
        return
    status, cfg = call("GET", f"{FUNCTION}/install/config")
    if status != 200:
        errs.append(f"/install/config answered {status}")
        return
    status, session = call("POST", f"{cfg['auth']}/token?grant_type=password", apikey=cfg["key"],
                           body={"email": REVIEWER, "password": pw_file.read_text().strip()})
    if status != 200 or not isinstance(session, dict) or not session.get("access_token"):
        errs.append(f"password sign-in for {REVIEWER} answered {status}")
        return
    token = session["access_token"]
    status, user = call("GET", f"{cfg['auth']}/user", token=token, apikey=cfg["key"])
    factors = (user or {}).get("factors") or [] if isinstance(user, dict) else None
    if status != 200 or factors is None or len(factors) != 0:
        errs.append(f"{REVIEWER} has {len(factors or [])} MFA factors (status {status}), want 0")

    def total():
        s, body = call("GET", f"{FUNCTION}/me/entries", token=token)
        return body.get("total") if s == 200 and isinstance(body, dict) else f"status {s}"

    if total() != 40:
        errs.append(f"/me/entries total is {total()}, want 40")
        return
    s, body = call("GET", f"{FUNCTION}/me/entries", token=token)
    note = next(e["id"] for e in body["entries"] if e["pattern"] != "projects")
    s, _ = call("DELETE", f"{FUNCTION}/me/entries/{note}", token=token)
    if s != 200 or total() != 39:
        errs.append(f"deleting {note} answered {s}, total {total()}, want 39")
    s, _ = call("POST", f"{FUNCTION}/api/v1/reviewer/reseed", token=admin_file.read_text().strip())
    if s != 200 or total() != 40:
        errs.append(f"the reseed answered {s}, total {total()}, want 40")


def words(s):
    return len(s.split())


def listing_copy(errs):
    try:
        d = json.loads((LISTING / "clyde.json").read_text())
    except (OSError, ValueError) as e:
        errs.append(f"clyde.json: {e}")
        return
    c, g = d.get("claude", {}), d.get("google", {})
    checks = [
        (d.get("name") == "Clyde", f"name = {d.get('name')!r}"),
        (0 < words(d.get("short_description", "")) <= 30, "short_description is empty or over 30 words"),
        (len(d.get("positive_tests", [])) == 5, "positive_tests needs exactly 5"),
        (len(d.get("negative_tests", [])) == 3, "negative_tests needs exactly 3"),
        (0 < len(c.get("one_liner", "")) <= 200, "claude.one_liner is empty or over 200 characters"),
        (0 < len(c.get("description", "")) <= 2000, "claude.description is empty or over 2,000 characters"),
        (1 <= len(c.get("categories", [])) <= 5, "claude.categories needs 1 to 5"),
        (len(c.get("use_cases", [])) >= 1, "claude.use_cases needs at least 1"),
    ]
    gd = g.get("description", "")
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", gd.strip()) if s]
    caps, prompts = g.get("capabilities", []), g.get("example_prompts", [])
    checks += [
        (len(sentences) == 1 and 0 < words(gd) < 30, f"google.description must be 1 sentence under 30 words ({words(gd)})"),
        (len(caps) >= 3, "google.capabilities needs at least 3"),
        (not any(re.match(r"\s*\d", x) for x in caps), "a google capability starts with a digit"),
        (len(prompts) >= 3, "google.example_prompts needs at least 3"),
        (sum(p.startswith("@Clyde") for p in prompts) >= 2, "fewer than 2 example prompts start with @Clyde"),
        (any("Clyde" in " ".join(p.split()[1:]) for p in prompts), "no example prompt names Clyde after its first word"),
        (not any(re.search(r"[0-9\"\u201c\u201d]", p) for p in prompts), "an example prompt has a digit or a quotation mark"),
        (bool(str(g.get("category", "")).strip()), "google.category is empty"),
    ]
    errs += [msg for ok, msg in checks if not ok]


def submission_answers(errs):
    try:
        md = (LISTING / "SUBMIT.md").read_text()
    except OSError as e:
        errs.append(f"SUBMIT.md: {e}")
        return
    heads = [h.strip() for h in re.findall(r"^#{1,4} (.+)$", md, re.M)]
    want = ["Claude directory", "Google Connected Apps", "Connection", "Tools", "Listing", "Use cases", "Company",
            "Authentication", "Data handling", "Test & launch", "Preview application", "Connected Console"]
    for w in want:
        if not any(h == w or h.startswith(w + " ") or h.startswith(w + ",") or h.endswith(" " + w) for h in heads):
            errs.append(f"SUBMIT.md: no heading {w!r}")
    for pat in [r"\bsk-[A-Za-z0-9]", r"eyJ[A-Za-z0-9_-]{8}", r"-----BEGIN"]:
        if re.search(pat, md):
            errs.append(f"SUBMIT.md: matches secret pattern {pat}")


# R53 (#58) and R58 (#63): what the MCP clients and Google's review read from the server, on both hosts. These fetch
# absolute URLs and never follow a redirect, since Google wants each file at its own address with 200.
ISSUER = "https://wlhlncmgjqyidosunugv.supabase.co/auth/v1"


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def get_exact(url):
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(urllib.request.Request(url, headers={"user-agent": "clyde-listing-check/1"}), timeout=20) as r:
            return r.status, r.headers.get("content-type", ""), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read().decode("utf-8", "replace")


def redirect_of(url):
    """The status and Location of one request, without following it."""
    opener = urllib.request.build_opener(_NoRedirect)
    try:
        with opener.open(urllib.request.Request(url, headers={"user-agent": "clyde-listing-check/1"}), timeout=20) as r:
            return r.status, r.headers.get("location")
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("location")


def resource_metadata(errs):
    status, _, body = get_exact(f"{ISSUER}/.well-known/oauth-authorization-server")
    if status != 200:
        errs.append(f"auth metadata: status {status}")
        return
    issuer = json.loads(body)["issuer"]
    for host in ("heyclyde.me", "memory.heyclyde.me"):
        status, _, body = get_exact(f"https://{host}/.well-known/oauth-protected-resource")
        if status != 200:
            errs.append(f"{host}: status {status}")
            continue
        meta = json.loads(body)
        if meta.get("resource") != f"https://{host}/mcp":
            errs.append(f"{host}: resource {meta.get('resource')!r}")
        if meta.get("resource_name") != "Clyde":
            errs.append(f"{host}: resource_name {meta.get('resource_name')!r}")
        if (meta.get("authorization_servers") or [None])[0] != issuer:
            errs.append(f"{host}: authorization_servers {meta.get('authorization_servers')!r}, issuer {issuer!r}")


def google_discovery(errs):
    for path in ("/.well-known/oauth-authorization-server", "/.well-known/openid-configuration"):
        status, _, body = get_exact(ISSUER + path)
        if status != 200:
            errs.append(f"{path}: status {status}")
            continue
        meta = json.loads(body)
        for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
            if not str(meta.get(key, "")).startswith("https://"):
                errs.append(f"{path}: {key} {meta.get(key)!r}")
        if "code" not in meta.get("response_types_supported", []):
            errs.append(f"{path}: response_types_supported {meta.get('response_types_supported')!r}")
        if "S256" not in meta.get("code_challenge_methods_supported", []):
            errs.append(f"{path}: code_challenge_methods_supported {meta.get('code_challenge_methods_supported')!r}")


def google_verification_file(errs):
    for host in ("heyclyde.me", "memory.heyclyde.me"):
        status, ctype, _ = get_exact(f"https://{host}/.well-known/google-connected-apps")
        if status != 200 or not ctype.startswith("text/plain"):
            errs.append(f"{host}: status {status}, content-type {ctype!r}")


def openai_verification_file(errs):
    for host in ("heyclyde.me", "memory.heyclyde.me"):
        status, ctype, _ = get_exact(f"https://{host}/.well-known/openai-apps-challenge")
        if status != 200 or not ctype.startswith("text/plain"):
            errs.append(f"{host}: status {status}, content-type {ctype!r}")


PLUGIN_REPO = "gewenyu99/heyclyde"
_RAW_REPO_BASE = None


def raw_repo_base():
    """Resolve current main commit SHA once so raw.githubusercontent.com bypasses branch CDN lag."""
    global _RAW_REPO_BASE
    if _RAW_REPO_BASE is None:
        status, _, body = fetch_raw(
            f"https://api.github.com/repos/{PLUGIN_REPO}/commits/main",
            accept="application/vnd.github.sha",
        )
        sha = body.decode("utf-8", "replace").strip() if status == 200 else ""
        ref = sha if re.fullmatch(r"[0-9a-f]{40}", sha) else "main"
        _RAW_REPO_BASE = f"https://raw.githubusercontent.com/{PLUGIN_REPO}/{ref}"
    return _RAW_REPO_BASE


def fetch_raw(url, accept="*/*"):
    req = urllib.request.Request(url, headers={"accept": accept, "user-agent": "clyde-listing-check/1"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            return r.status, r.headers.get("content-type", ""), r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("content-type", ""), e.read()


def fetch_json(url, errs, label, accept="application/json"):
    status, _, body = fetch_raw(url, accept=accept)
    if status != 200:
        errs.append(f"{label}: status {status}")
        return None
    try:
        return json.loads(body)
    except ValueError as e:
        errs.append(f"{label}: invalid JSON ({e})")
        return None


def gemini_cli_repo(errs):
    raw_base = raw_repo_base()
    repo = fetch_json(f"https://api.github.com/repos/{PLUGIN_REPO}", errs, "github repo", "application/vnd.github+json")
    if repo is not None:
        if repo.get("private", True):
            errs.append(f"{PLUGIN_REPO} is not public")
        if "gemini-cli-extension" not in repo.get("topics", []):
            errs.append(f"{PLUGIN_REPO} missing topic 'gemini-cli-extension'")
    ext = fetch_json(f"{raw_base}/gemini-extension.json", errs, "gemini-extension.json")
    if ext is not None:
        if ext.get("name") != "clyde":
            errs.append(f"gemini-extension.json name={ext.get('name')!r}")
        if ext.get("mcpServers", {}).get("clyde", {}).get("httpUrl") != CONNECTOR:
            errs.append("gemini-extension.json missing clyde httpUrl")


def claude_plugin_bundle(errs):
    raw_base = raw_repo_base()
    manifest = fetch_json(f"{raw_base}/plugins/claude/.claude-plugin/plugin.json", errs, "claude plugin.json")
    if manifest is not None:
        if manifest.get("name") != "clyde":
            errs.append(f"claude plugin.json name={manifest.get('name')!r}")
        if "userConfig" in manifest:
            errs.append("claude plugin.json must omit userConfig (triggers directory policy hold)")
    hook_status, _, _ = fetch_raw(f"{raw_base}/plugins/claude/hooks/hooks.json")
    if hook_status != 404:
        errs.append(f"claude bundle must omit hooks/hooks.json (got status {hook_status})")
    svg_status, _, _ = fetch_raw(f"{raw_base}/plugins/claude/assets/clyde.svg")
    if svg_status != 404:
        errs.append(f"claude bundle must omit assets/clyde.svg (got status {svg_status})")
    mcp = fetch_json(f"{raw_base}/plugins/claude/.mcp.json", errs, "claude .mcp.json")
    if mcp is not None and mcp.get("mcpServers", {}).get("clyde", {}).get("url") != CONNECTOR:
        errs.append("claude .mcp.json missing clyde url")
    mp = fetch_json(f"{raw_base}/.claude-plugin/marketplace.json", errs, "claude marketplace.json")
    if mp is not None and not any(p.get("source") == "./plugins/claude" for p in mp.get("plugins", [])):
        errs.append("claude marketplace.json missing ./plugins/claude")
    status, _, body = fetch_raw(f"{raw_base}/plugins/claude/README.md")
    if status != 200:
        errs.append(f"claude README.md: status {status}")
    else:
        txt = body.decode("utf-8", "replace")
        no_code = re.sub(r"```[\s\S]*?```", " ", txt)
        if words(no_code) < 40:
            errs.append(f"claude README.md has {words(no_code)} non-code words, want >= 40")
        if "/plugin install clyde --marketplace gewenyu99/heyclyde" not in txt:
            errs.append("claude README.md missing install command")
        if "OAuth" not in txt:
            errs.append("claude README.md missing OAuth disclosure")


def antigravity_plugin_bundle(errs):
    raw_base = raw_repo_base()
    manifest = fetch_json(f"{raw_base}/plugins/antigravity/plugin.json", errs, "antigravity plugin.json")
    if manifest is not None:
        desc = manifest.get("description", "")
        if not (120 <= len(desc) <= 160):
            errs.append(f"antigravity description len={len(desc)}, want 120..160")
        if any(desc.startswith(p) for p in ("Antigravity", "Gemini", "Claude", "Cursor")):
            errs.append("antigravity description starts with disallowed product name")
        if any(desc.endswith(s) for s in ("Plugin", "MCP")):
            errs.append("antigravity description ends with disallowed suffix")
        if not manifest.get("$schema"):
            errs.append("antigravity plugin.json missing $schema")
    mcp = fetch_json(f"{raw_base}/plugins/antigravity/mcp_config.json", errs, "antigravity mcp_config.json")
    if mcp is not None and mcp.get("mcpServers", {}).get("clyde", {}).get("serverUrl") != CONNECTOR:
        errs.append("antigravity mcp_config.json missing clyde serverUrl")
    status, _, body = fetch_raw(f"{raw_base}/plugins/antigravity/assets/logo.svg")
    if status != 200:
        errs.append(f"antigravity logo.svg: status {status}")
    else:
        try:
            svg = ET.fromstring(body)
            vb = [float(v) for v in svg.get("viewBox", "0 0 0 0").replace(",", " ").split()]
            if len(vb) != 4 or vb[2] != vb[3]:
                errs.append(f"antigravity logo.svg viewBox {vb} not square")
        except ET.ParseError as e:
            errs.append(f"antigravity logo.svg parse error: {e}")
    status, _, body = fetch_raw(f"{raw_base}/plugins/antigravity/skills/clyde/SKILL.md")
    if status != 200 or not body.decode("utf-8", "replace").startswith("---\nname: clyde\n"):
        errs.append("antigravity SKILL.md missing or bad frontmatter")


def openai_plugin_release(errs):
    rel = fetch_json(f"https://api.github.com/repos/{PLUGIN_REPO}/releases/tags/v1.0.0", errs, "release v1.0.0", "application/vnd.github+json")
    if rel is None:
        return
    assets = {a.get("name"): a.get("browser_download_url") for a in rel.get("assets", [])}
    want_assets = ("clyde-openai-plugin.zip", "clyde.tar.gz", "clyde-claude-plugin.zip", "clyde-antigravity-plugin.zip")
    missing = [a for a in want_assets if a not in assets]
    if missing:
        errs.append(f"release v1.0.0 missing assets: {missing}")
        return
    status, _, zbytes = fetch_raw(assets["clyde-openai-plugin.zip"])
    if status != 200:
        errs.append(f"clyde-openai-plugin.zip: status {status}")
    else:
        with zipfile.ZipFile(io.BytesIO(zbytes)) as zf:
            names = set(zf.namelist())
            if "plugin.json" not in names or "mcp.json" not in names:
                errs.append("clyde-openai-plugin.zip missing root plugin.json or mcp.json")
            if any(n == "hooks.json" or n.startswith("hooks/") for n in names):
                errs.append("clyde-openai-plugin.zip must not contain hooks")
            if "mcp.json" in names:
                mcp = json.loads(zf.read("mcp.json"))
                clyde = mcp.get("mcpServers", {}).get("clyde", {})
                if clyde.get("url") != CONNECTOR:
                    errs.append(f"openai mcp.json url={clyde.get('url')!r}")
    status, _, cbytes = fetch_raw(assets["clyde-claude-plugin.zip"])
    if status != 200:
        errs.append(f"clyde-claude-plugin.zip: status {status}")
    else:
        with zipfile.ZipFile(io.BytesIO(cbytes)) as zf:
            cnames = {n[2:] if n.startswith("./") else n for n in zf.namelist()}
            if ".claude-plugin/plugin.json" not in cnames or ".mcp.json" not in cnames:
                errs.append("clyde-claude-plugin.zip missing .claude-plugin/plugin.json or .mcp.json")
            if any(n == "hooks/hooks.json" or n.startswith("hooks/") for n in cnames):
                errs.append("clyde-claude-plugin.zip must not contain hooks")
            if "assets/clyde.svg" in cnames:
                errs.append("clyde-claude-plugin.zip must not contain assets/clyde.svg")
    status, _, tbytes = fetch_raw(assets["clyde.tar.gz"])
    if status != 200:
        errs.append(f"clyde.tar.gz: status {status}")
    else:
        with tarfile.open(fileobj=io.BytesIO(tbytes), mode="r:gz") as tf:
            tnames = set(tf.getnames())
            if "gemini-extension.json" not in tnames:
                errs.append("clyde.tar.gz missing root gemini-extension.json")


INDEXED = ["/", "/docs", "/how-it-works", "/faq", "/privacy", "/terms"]


def site_seo(errs):
    """R72 (#77): the sitemap, both hosts' robots.txt, and each indexed page's canonical and OG image."""
    status, ctype, body = fetch("/sitemap.xml", "application/xml")
    locs = re.findall(r"<loc>([^<]*)</loc>", body.decode("utf-8", "replace"))
    if status != 200 or not ctype.startswith("application/xml") or locs != [BASE + p for p in INDEXED]:
        errs.append(f"/sitemap.xml: status {status}, content-type {ctype!r}, {len(locs)} urls")
    status, ctype, body = fetch("/robots.txt", "text/plain")
    txt = body.decode("utf-8", "replace")
    # Cloudflare's managed robots.txt may put its own groups first. Only the "User-agent: *" group decides search.
    star = re.search(r"^User-agent: \*\s*$(.*?)(?=^User-agent:|\Z)", txt, re.M | re.S)
    if status != 200 or f"Sitemap: {BASE}/sitemap.xml" not in txt or not star or re.search(r"^Disallow: /\s*$", star.group(1), re.M):
        errs.append(f"/robots.txt: status {status}, or no sitemap line, or it disallows everything")
    api = BASE.replace("://", "://memory.", 1)
    with urllib.request.urlopen(urllib.request.Request(api + "/robots.txt", headers={"user-agent": "clyde-listing-check/1"}), timeout=20) as r:
        if "Disallow: /" not in r.read().decode():
            errs.append(f"{api}/robots.txt doesn't disallow")
    for path in INDEXED:
        status, _, body = fetch(path)
        html = body.decode("utf-8", "replace")
        if f'<link rel="canonical" href="{BASE}{path}">' not in html:
            errs.append(f"{path}: no canonical {BASE}{path}")
        if f'<meta property="og:image" content="{BASE}/brand/og-banner.png">' not in html:
            errs.append(f"{path}: no og:image")
    status, ctype, body = fetch("/brand/og-banner.png", "image/png")
    if status != 200 or png_size(body) != (1200, 630):
        errs.append(f"og-banner.png: status {status}, size {png_size(body)}")



def complaint_sources(errs):
    """R73 (#78): every source on the home page's complaints wall answers 200, and no complaint quotes more than 14 words."""
    src = (ROOT / "proxy" / "site.js").read_text(encoding="utf-8")
    block = src[src.index("const COMPLAINTS"):]
    block = block[:block.index("];")]
    urls = re.findall(r'src: "(https://[^"]+)"', block)
    if len(urls) < 6:
        errs.append(f"COMPLAINTS has {len(urls)} sources, want >= 6")
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={"user-agent": "clyde-listing-check/1"})
            with urllib.request.urlopen(req, timeout=25) as r:
                if r.status != 200:
                    errs.append(f"{url} answered {r.status}")
        except urllib.error.HTTPError as e:
            errs.append(f"{url} answered {e.code}")
    for q in re.findall(r'(?:\\"|“)([^"”\\]+?)(?:\\"|”)', block):
        if len(q.split()) > 14:
            errs.append(f"quote over 14 words: {q}")


def email_images(errs):
    """R76 (#81): email brand PNGs under https://heyclyde.me/brand/email/ answer 200 with image/png."""
    for name in ("clyde-lockup-light@2x.png", "clyde-lockup-dark@2x.png", "clyde-mark@2x.png"):
        status, ctype, body = fetch(f"/brand/email/{name}", "image/png")
        if status != 200 or not ctype.startswith("image/png"):
            errs.append(f"{name}: status {status}, content-type {ctype!r}")
        elif png_size(body) is None:
            errs.append(f"{name}: not a valid PNG")


CRAWLERS = {
    "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "bingbot": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
    "GPTBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
    "OAI-SearchBot": "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
    "ClaudeBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "PerplexityBot": "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
}


def crawlers(errs):
    """R79 (like-vincent #84): search and AI crawlers can read the guides. Cloudflare refuses some user agents (error 1010)."""
    for name, ua in CRAWLERS.items():
        req = urllib.request.Request(BASE + "/guides", headers={"accept": "text/html", "user-agent": ua})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                status = r.status
        except urllib.error.HTTPError as e:
            status = e.code
        if status != 200:
            errs.append(f"{name}: /guides answered {status}")


SECTIONS = {
    "legal pages": legal_pages,
    "docs pages": docs_pages,
    "icons": icons,
    "email_images": email_images,
    "reviewer account": reviewer_account,
    "listing copy": listing_copy,
    "submission answers": submission_answers,
    "resource metadata per host": resource_metadata,
    "google discovery": google_discovery,
    "google verification file": google_verification_file,
    "openai verification file": openai_verification_file,
    "gemini cli repo": gemini_cli_repo,
    "claude plugin bundle": claude_plugin_bundle,
    "antigravity plugin bundle": antigravity_plugin_bundle,
    "crawlers": crawlers,
    "openai plugin release": openai_plugin_release,
    "site seo": site_seo,
    "complaint sources": complaint_sources,
}


def main(argv):
    global BASE
    if "--base" in argv:
        i = argv.index("--base")
        BASE = argv[i + 1].rstrip("/")
        argv = argv[:i] + argv[i + 2:]
    names = argv or list(SECTIONS)
    unknown = [n for n in names if n not in SECTIONS]
    if unknown:
        print(f"unknown sections {unknown}; known: {list(SECTIONS)}")
        return 2
    failed = 0
    for name in names:
        errs = []
        try:
            SECTIONS[name](errs)
        except Exception as e:  # a crash is a failure, with its reason
            errs.append(f"{type(e).__name__}: {e}")
        failed += bool(errs)
        print(f"{'FAIL' if errs else 'PASS'} {name}" + "".join(f"\n  - {e}" for e in errs))
    return failed


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
