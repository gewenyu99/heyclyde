import asyncio

import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from conftest import compile_seed
from kb import search
from kb.config import config
from kb.decider import Keywords, OpenAIDecisions
from kb.server import BearerAuth


def test_seed_compiles_and_refuses_edited_evidence(seed_dir):
    assert compile_seed(seed_dir).returncode == 0
    assert (seed_dir / "out" / "seed.sql").exists()
    p = seed_dir / "vault" / "decisions" / "tea-oolong-temp.md"
    p.write_text(p.read_text(encoding="utf-8").replace("oolong at 90 from now on", "oolong at 85"), encoding="utf-8")
    r = compile_seed(seed_dir)
    assert r.returncode == 1 and "evidence_sha256 mismatch" in r.stdout


def test_tokens_split_words_and_chinese_bigrams():
    assert search.tokens("Which video models am I using?") == {"video", "models", "am"}
    assert search.tokens("乌龙茶") == {"乌龙", "龙茶"}


def test_rrf_rewards_agreement():
    ranked = search.rrf(["a", "b"], ["b", "c"], [])
    assert ranked[0][0] == "b" and {e for e, _ in ranked} == {"a", "b", "c"}


def row(eid, body="x", sensitivity="normal"):
    return {"id": eid, "title": f"title {eid}", "authority": "approved", "scope": "global", "valid_from": "2026-01-01",
            "body": body, "evidence": "said so", "evidence_kind": "quote", "sensitivity": sensitivity, "superseded_by": None}


def test_pack_stops_at_item_cap():
    ranked = [(f"e{i}", 1.0, None) for i in range(20)]
    delivered, _ = search.pack(ranked, {f"e{i}": row(f"e{i}") for i in range(20)})
    assert len(delivered) == config.packet_items


def test_pack_stops_at_token_budget_but_always_delivers_one():
    big = "word " * 2000
    delivered, _ = search.pack([("a", 1.0, None), ("b", 1.0, None)], {"a": row("a", big), "b": row("b", big)})
    assert delivered == ["a"]


def test_private_entries_are_redacted():
    text = search.render_item(1, row("p", "supplier is secret co", "private"))
    assert "secret co" not in text and "private entry" in text


def test_keywords_spot_pushback():
    k = Keywords()
    assert asyncio.run(k.pushback("No stop fighting me"))["pushback"]
    assert not asyncio.run(k.pushback("Gimme a few reasonable plans"))["pushback"]


def test_bearer_auth_fails_closed():
    inner = Starlette(routes=[Route("/x", lambda r: PlainTextResponse("ok")), Route("/healthz", lambda r: PlainTextResponse("ok"))])
    assert TestClient(BearerAuth(inner, "")).get("/x").status_code == 401
    c = TestClient(BearerAuth(inner, "tok"))
    assert c.get("/x").status_code == 401
    assert c.get("/x", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/x", headers={"Authorization": "Bearer tok"}).status_code == 200
    assert c.get("/healthz").status_code == 200


def test_bearer_auth_checks_the_token_hash():
    import hashlib
    inner = Starlette(routes=[Route("/x", lambda r: PlainTextResponse("ok"))])
    c = TestClient(BearerAuth(inner, "old", hashlib.sha256(b"pw").hexdigest()))
    assert c.get("/x", headers={"Authorization": "Bearer pw"}).status_code == 200
    assert c.get("/x", headers={"Authorization": "Bearer old"}).status_code == 401
    assert c.get("/x", headers={"Authorization": "pw"}).status_code == 401


class FakeDecisions:
    """Stands in for client.decisions and returns SDK-typed answers, so the parsing is checked against the real types."""

    def __init__(self, answers):
        self.answers, self.calls = answers, []

    async def create(self, **kw):
        from openai.types.decision import Decision
        self.calls.append(kw)
        return Decision.model_validate({"model": kw["model"], "answers": self.answers, "usage": {
            "input_tokens": 10, "output_tokens": 0, "total_tokens": 10,
            "input_tokens_details": {"cache_write_tokens": 0, "cached_tokens": 0},
            "output_tokens_details": {"reasoning_tokens": 0}}})


def decider(answers):
    fake = FakeDecisions(answers)
    d = OpenAIDecisions(model="gpt-6-luna", client=type("C", (), {"decisions": fake})())
    return d, fake


def test_openai_pushback_reads_probability_and_cause():
    d, fake = decider([{"type": "predicate", "name": "pushback", "probability": 0.91},
                       {"type": "choice", "name": "cause", "choice": "tea-oolong-old", "confidence": 0.8,
                        "probabilities": [{"value": "tea-oolong-old", "probability": 0.8}]}])
    out = asyncio.run(d.pushback("no, it's 90 now", [row("tea-oolong-old")]))
    assert out["pushback"] and out["cause"] == "tea-oolong-old"
    q = fake.calls[0]["questions"]
    assert [x["type"] for x in q] == ["predicate", "choice"]
    assert {c["value"] for c in q[1]["choices"]} == {"none", "tea-oolong-old"}


def test_openai_refusal_is_not_pushback():
    d, _ = decider([{"type": "refusal", "name": "pushback"}])
    out = asyncio.run(d.pushback("hm"))
    assert out["refused"] and not out["pushback"]


def test_openai_relevance_never_sends_private_text():
    d, fake = decider([{"type": "predicate", "name": "i1", "probability": 0.2}])
    out = asyncio.run(d.relevant("brew tea", [row("p", "supplier is secret co", "private")]))
    assert out["p"] == {"p": 0.2}
    assert "secret co" not in fake.calls[0]["input"]


def test_weighted_rrf_favours_the_weighted_ranker():
    # Each entry tops one list. Unweighted, the tie falls to id order. Weighting the second list decides it.
    assert search.rrf(["a"], ["b"], k=10)[0][0] == "a"
    assert search.rrf(["a"], ["b"], weights=[1, 1.5], k=10)[0][0] == "b"


def test_agent_name_from_client():
    from kb.service import agent_name
    assert agent_name("claude-code") == "claude"
    assert agent_name("codex-mcp-client") == "codex"
    assert agent_name(None) == "agent"
