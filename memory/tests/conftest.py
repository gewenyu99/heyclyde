"""Fixtures: a small made-up vault (never Wen's data) and, when KB_TEST_DATABASE_URL is set, a fresh database loaded from it.

  KB_TEST_DATABASE_URL=postgresql://postgres@/postgres?host=/tmp&port=55432 pytest memory/tests
"""
import hashlib
import os
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

MEMORY = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(MEMORY / "api"))
# Ollama on a dead port: A1 must answer with keyword ranks alone.
os.environ["OLLAMA_URL"] = "http://127.0.0.1:9"

SOURCES = [{"id": "src-a", "kind": "claude_chat", "title": "Test chat", "uri": "https://example.com/a", "date": "2026-09-01"},
           {"id": "src-b", "kind": "claude_session", "title": "Later session", "uri": "https://example.com/b", "date": "2026-10-02"}]
ENTRIES = [
    ("proj-tea", "projects", "Tea brewing", "approved", "quote", "i brew tea every morning", "normal", [], "Daily tea brewing."),
    ("tea-oolong-temp", "decisions", "Brew oolong at 90C", "approved", "quote", "oolong at 90 from now on", "normal",
     [{"type": "part_of", "to": "proj-tea"}, {"type": "supersedes", "to": "tea-oolong-old"}], "Oolong water temperature is 90C."),
    ("tea-oolong-old", "decisions", "Brew oolong at 100C", "approved", "quote", "boiling water for oolong", "normal",
     [{"type": "part_of", "to": "proj-tea"}], "Oolong water temperature was 100C."),
    ("tea-draft-cold", "recommendations", "Try cold-brew oolong", "draft", "assistant", "You could cold-brew it", "normal",
     [{"type": "part_of", "to": "proj-tea"}], "Claude suggested cold brew; never confirmed."),
    ("tea-supplier", "observations", "Buys oolong from a private supplier", "observed", "quote", "my supplier is secret co",
     "private", [{"type": "part_of", "to": "proj-tea"}], "Supplier name and pricing."),
    ("tea-zh", "preferences", "喜欢乌龙茶", "approved", "quote", "我最喜欢乌龙茶", "normal",
     [{"type": "part_of", "to": "proj-tea"}, {"type": "relates", "to": "tea-oolong-temp"}], "偏好乌龙茶，不加糖。"),
]
QUERIES = [{"id": "q1", "text": "what temperature for oolong?", "qtype": "superseded", "gold": ["tea-oolong-temp"],
            "must_not": ["tea-oolong-old"], "origin": "derived"}]
PROBES = [{"id": "p1", "task": "Brew oolong", "governing": ["tea-oolong-temp"], "checks": [{"kind": "present", "pattern": "90"}]}]


def write_vault(root):
    vault = root / "vault"
    (vault / "_meta").mkdir(parents=True)
    for name, data in (("sources", SOURCES), ("queries", QUERIES), ("probes", PROBES)):
        (vault / "_meta" / f"{name}.yaml").write_text(yaml.safe_dump(data, allow_unicode=True), encoding="utf-8")
    for eid, pattern, title, authority, kind, evidence, sens, links, body in ENTRIES:
        fm = {"id": eid, "pattern": pattern, "title": title, "authority": authority, "scope": "domain:tea",
              "sensitivity": sens, "lang": "en", "valid_from": "2026-09-01",
              "source": "src-b" if eid == "tea-oolong-temp" else "src-a", "evidence_kind": kind, "evidence": evidence,
              "evidence_sha256": hashlib.sha256(evidence.encode()).hexdigest(), "links": links}
        (vault / pattern).mkdir(exist_ok=True)
        (vault / pattern / f"{eid}.md").write_text(
            "---\n" + yaml.safe_dump(fm, allow_unicode=True, sort_keys=False) + "---\n\n" + body + "\n", encoding="utf-8")
    return root


def compile_seed(root):
    return subprocess.run([sys.executable, str(MEMORY / "seed" / "build.py"), "compile"],
                          env=dict(os.environ, PKG_SEED_DIR=str(root)), capture_output=True, text=True)


@pytest.fixture
def seed_dir(tmp_path):
    return write_vault(tmp_path)


@pytest.fixture(scope="session")
def db_url(tmp_path_factory):
    admin = os.environ.get("KB_TEST_DATABASE_URL")
    if not admin:
        pytest.skip("set KB_TEST_DATABASE_URL to run database tests")
    import psycopg
    from psycopg.conninfo import make_conninfo
    root = write_vault(tmp_path_factory.mktemp("seed"))
    assert compile_seed(root).returncode == 0
    with psycopg.connect(admin, autocommit=True) as c:
        c.execute("drop database if exists kb_pytest")
        c.execute("create database kb_pytest")
    url = make_conninfo(admin, dbname="kb_pytest")
    with psycopg.connect(url, autocommit=True) as c:
        c.execute((root / "out" / "seed.sql").read_text(encoding="utf-8"))
        c.execute((MEMORY / "db" / "schema.sql").read_text(encoding="utf-8"))
    return url


@pytest.fixture
async def conn(db_url):
    import psycopg
    from psycopg.rows import dict_row
    async with await psycopg.AsyncConnection.connect(db_url, row_factory=dict_row) as c:
        yield c
