#!/usr/bin/env python3
"""R55 (#60): every URL, asset and answer the Claude directory and Google Connected Apps ask for exists.

    python3 memory/e2e/listing_check.py                      # every section, against https://heyclyde.me
    python3 memory/e2e/listing_check.py "icons" "docs pages" # some sections
    python3 memory/e2e/listing_check.py --base http://localhost:8787

Each section prints PASS or FAIL with its reasons. The exit code is the number of failed sections. Only the Python
standard library, so it runs anywhere. The live sections fetch the site; "listing copy" and "submission answers" read
memory/listing/ from this checkout. Add a section by adding a function to SECTIONS.
"""
import json
import re
import struct
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LISTING = ROOT / "listing"
MCP_TS = ROOT / "supabase" / "functions" / "memory" / "mcp.ts"
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
    html_page("/support", errs)


def tool_names():
    src = MCP_TS.read_text()
    block = src[src.index("export const TOOLS"):]
    return re.findall(r'^    name: "([a-z_]+)"', block, re.M)


def docs_pages(errs):
    tools = tool_names()
    if len(tools) < 10:
        errs.append(f"read only {len(tools)} tool names from mcp.ts")
    needs(errs, "/docs", html_page("/docs", errs), [CONNECTOR, "Claude", "Gemini", "export", "delete", *tools])
    needs(errs, "/support", html_page("/support", errs), ["support@heyclyde.me"])
    needs(errs, "/docs/grok", html_page("/docs/grok", errs), ["Grok", CONNECTOR])


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


def reviewer_account(errs):
    errs.append("not built: review@heyclyde.me waits on tenancy (R48 to R50) and memory/seed/reviewer.sql")


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


SECTIONS = {
    "legal pages": legal_pages,
    "docs pages": docs_pages,
    "icons": icons,
    "reviewer account": reviewer_account,
    "listing copy": listing_copy,
    "submission answers": submission_answers,
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
