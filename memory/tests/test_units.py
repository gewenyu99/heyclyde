import asyncio
import importlib.util
import re
from dataclasses import replace
from datetime import date

import httpx
import pytest
from starlette.applications import Starlette
from starlette.responses import PlainTextResponse
from starlette.routing import Route
from starlette.testclient import TestClient

from conftest import MEMORY, compile_seed
from kb import search, server, write
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
    delivered, chunks = search.pack([("a", 1.0, None), ("b", 1.0, None)], {"a": row("a", big), "b": row("b", big)})
    assert delivered == ["a"]
    # An entry far over the budget would otherwise fill the agent's context. It's cut to fit.
    assert search.estimate_tokens(chunks[0]) <= config.packet_tokens and chunks[0].endswith(search.CLIPPED)
    assert chunks[0].startswith("[1] a: title a")


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


# ---------------------------------------------------------------- write validation, no database
def test_write_constants_match_build():
    spec = importlib.util.spec_from_file_location("seed_build", MEMORY / "seed" / "build.py")
    build = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(build)
    for name in ("AUTHORITY", "LINK_TYPES", "PATTERNS", "EVIDENCE_KINDS"):
        assert getattr(write, name) == getattr(build, name), name
    assert write.SCOPE_RE.pattern == build.SCOPE_RE.pattern.replace(")$", "|run:[A-Za-z0-9._-]+)$")


def payload(**change):
    """An entry as lv-flow sends it. agent_payload drops the source, since an agent can't name one."""
    return {"pattern": "observations", "title": "Gate evidence", "body": "pytest passed.", "authority": "draft",
            "scope": "run:abc", "evidence_kind": "summary", "evidence": "30 passed", "project": "run-abc",
            "source": {"kind": "run", "title": "lv run abc"}} | change


def agent_payload(**change):
    return {k: v for k, v in payload().items() if k != "source"} | change


def refusal(p, caller="runtime"):
    with pytest.raises(write.Refused) as exc:
        write.validate(p, caller)
    return str(exc.value)


@pytest.mark.parametrize("change, message", [
    ({"pattern": "notes"}, "pattern must be one of"),
    ({"title": "  "}, "title is required."),
    ({"body": None}, "body is required."),
    ({"title": "t" * 301}, "title is 301 characters. The limit is 300, so put long material in a blob."),
    ({"body": "b" * 4001}, "body is 4001 characters. The limit is 4000"),
    ({"evidence": "e" * 20001}, "evidence is 20001 characters. The limit is 20000"),
    ({"authority": "confirmed"}, "authority must be draft, observed or approved."),
    ({"scope": "team:x"}, "scope 'team:x' must be global, domain:<x>, repo:<x> or run:<id>."),
    ({"scope": "run:"}, "must be global, domain:<x>, repo:<x> or run:<id>."),
    ({"scope": "run:abc\n"}, "scope 'run:abc\\n' must be global"),
    ({"sensitivity": "secret"}, "sensitivity must be normal or private."),
    ({"evidence_kind": "vibes"}, "evidence_kind must be one of"),
    ({"evidence": " "}, "evidence is required and can't be empty."),
    ({"evidence_kind": "quote"}, "A quote of Wen can't back a draft."),
    ({"project": None}, "project is required unless pattern is projects. It's the id of the projects entry this "
                        "belongs to. For a run, create its projects entry in scope run:abc first."),
    ({"project": ["run-abc"]}, "project must be an entry id."),
    ({"valid_from": "last tuesday"}, "valid_from 'last tuesday' must be a YYYY-MM-DD date."),
    ({"source": None}, "source is required"),
    ({"source": {"kind": "run"}}, "A new source needs a kind and a title."),
    ({"source": {"id": "src-a\n"}}, "source.id must be letters, digits"),
    ({"links": [{"type": "part_of", "to": "proj-tea"}]}, "Set part_of with project, not links."),
    ({"links": [{"type": "supersedes", "to": "x"}]}, "Set supersedes with supersedes, not links."),
    ({"links": [{"type": "likes", "to": "x"}]}, "link type 'likes' must be one of"),
    ({"links": [{"type": "relates"}]}, "Every link needs a `to` entry id."),
    ({"links": "proj-tea"}, "links must be a list of {type, to}."),
    ({"supersedes": "old-id"}, "supersedes must be a list of entry ids."),
    ({"id": "e1", "project": "e1"}, "An entry can't be part of itself."),
    ({"id": "e1", "links": [{"type": "relates", "to": "e1"}]}, "An entry can't link to itself."),
    ({"id": "e1", "supersedes": ["e1"]}, "An entry can't supersede itself."),
    ({"id": "has space"}, "id must be letters, digits"),
    ({"id": "x\n"}, "id must be letters, digits"),
    ({"supersede": ["old-id"]}, "Unknown field supersede."),
    ({"title": "captured \x00 output"}, "title has a NUL character, which kb can't store."),
    ({"source": {"kind": "run", "title": "lv\x00"}}, "source.title has a NUL character"),
    ({"links": [{"type": "relates", "to": "x\x00"}]}, "links[0].to has a NUL character"),
    ({"evidence": "half an emoji \ud83d"}, "evidence has a lone surrogate, half of a character. Send valid UTF-8."),
    ({"blobs": [{"name": "log", "text": "\ud83d"}]}, "blobs[0].text has a lone surrogate"),
    ({"blobs": [{"name": "log"}]}, "Blob log needs text or base64, not both or neither."),
    ({"blobs": [{"name": "log", "text": "a", "base64": "YQ=="}]}, "Blob log needs text or base64"),
    ({"blobs": [{"name": "log", "text": 5}]}, "Blob log has text that isn't a string."),
    ({"blobs": [{"name": "log", "base64": "not base64!"}]}, "Blob log has base64 that doesn't decode."),
    ({"blobs": [{"name": "log", "base64": "日志"}]}, "Blob log has base64 that doesn't decode."),
    ({"blobs": [{"name": "log", "text": "a"}, {"name": "log", "text": "b"}]}, "Two blobs are named log."),
    ({"blobs": [{"text": "a"}]}, "Every blob needs a name."),
    ({"blobs": [{"name": "log", "text": "a", "media_type": ""}]}, "Blob log needs a media_type"),
    ({"blobs": [{"name": "log", "text": "a", "media_type": "text/plain\nX: y"}]}, "Blob log needs a media_type like"),
    ({"blobs": [{"name": "log", "text": "a", "media_type": "texte/plaîn"}]}, "Blob log needs a media_type like"),
    ({"blobs": [{"name": f"b{i}", "text": "a"} for i in range(17)]}, "An entry has 17 blobs. The limit is 16."),
])
def test_validate_refuses(change, message):
    assert message in refusal(payload(**change))


def test_validate_refuses_a_non_object_and_lists_every_problem():
    assert refusal(["not", "a", "dict"]) == "An entry is a JSON object."
    text = refusal(payload(pattern="notes", evidence=""))
    assert "pattern must be one of" in text and "evidence is required" in text and len(text.splitlines()) == 2


def test_validate_holds_an_agent_to_drafts_in_a_run():
    """Every agent session holds KB_TOKEN, so an agent's write can't outrank, outlast or impersonate lv-flow's."""
    for change, message in [({"authority": "observed"}, "authority observed is above draft, the most this caller may write."),
                            ({"scope": "global"}, "An agent writes only in a run scope, run:<id>, not global."),
                            ({"source": {"kind": "chat", "title": "Wen, claude.ai chat"}}, "An agent can't name a source."),
                            ({"id": "tea-oolong-temp-2026"}, "An agent can't choose an id.")]:
        assert message in refusal(agent_payload(**change), "agent")
    e = write.validate(agent_payload(), "agent")
    assert e["source"]["kind"] == "session" and e["id"].startswith("run-abc-gate-evidence-")
    assert write.validate(agent_payload(id=""), "agent")["id"] == e["id"]


def test_validate_stores_what_postgres_can():
    blob = write.validate(payload(blobs=[{"name": "log", "text": "a\x00b", "media_type": "Text/Markdown"}]), "runtime")["blobs"][0]
    assert (blob["content"], blob["media_type"]) == (b"a\x00b", "text/markdown")  # blob text is stored as bytes


def test_validate_caps_blob_size(monkeypatch):
    monkeypatch.setattr(write, "MAX_BLOB_BYTES", 4)
    assert "Blob log is 5 bytes. The limit is 4." in refusal(payload(blobs=[{"name": "log", "text": "12345"}]))
    monkeypatch.setattr(write, "MAX_BLOBS_BYTES", 6)
    two = [{"name": "a", "text": "1234"}, {"name": "b", "text": "5678"}]
    assert "The blobs add up to 8 bytes. The limit for one entry is 6." in refusal(payload(blobs=two))


def test_the_request_cap_fits_an_entry_with_every_blob_it_may_carry():
    assert server.MAX_REQUEST_BYTES > write.MAX_BLOBS_BYTES * 4 / 3 + sum(write.MAX_CHARS.values()) * 6


def test_validate_lets_a_trusted_caller_write_approved_quotes():
    e = write.validate(payload(authority="approved", evidence_kind="quote"), "runtime")
    assert e["authority"] == "approved"


def test_validate_fills_defaults():
    e = write.validate(payload(pattern="projects", project=None), "runtime")
    assert (e["sensitivity"], e["lang"], e["valid_from"], e["project"]) == ("normal", "en", date.today(), None)
    assert e["blobs"] == [] and e["links"] == [] and e["supersedes"] == []
    blob = write.validate(payload(blobs=[{"name": "b", "base64": "AAE="}]), "runtime")["blobs"][0]
    assert (blob["media_type"], blob["content"]) == ("application/octet-stream", b"\x00\x01")


def test_generated_ids_are_stable_readable_and_distinct():
    a, b = write.validate(payload(), "runtime"), write.validate(payload(), "runtime")
    assert a["id"] == b["id"] and a["digest"] == write.digest(payload())
    assert re.fullmatch(r"run-abc-gate-evidence-[0-9a-f]{8}", a["id"])
    assert write.validate(payload(body="pytest failed."), "runtime")["id"] != a["id"]
    assert write.validate(payload(title="喜欢乌龙茶"), "runtime")["id"].startswith("run-abc-")
    assert write.validate(payload(id="my-id"), "runtime")["id"] == "my-id"
    assert write.validate(payload(id="my-id"), "runtime")["digest"] == a["digest"]  # the id isn't part of the payload


# ---------------------------------------------------------------- server: roles and the embedding sync
def test_bearer_auth_gives_each_token_its_role():
    inner = Starlette(routes=[Route("/x", lambda r: PlainTextResponse(r.scope["kb_role"]))])
    c = TestClient(BearerAuth(inner, "tok", "rt"))
    assert c.get("/x", headers={"Authorization": "Bearer tok"}).text == "agent"
    assert c.get("/x", headers={"Authorization": "Bearer rt"}).text == "runtime"
    assert TestClient(BearerAuth(inner, "tok")).get("/x", headers={"Authorization": "Bearer rt"}).status_code == 401
    assert TestClient(BearerAuth(inner, "", "")).get("/x", headers={"Authorization": "Bearer "}).status_code == 401


def test_build_app_refuses_one_token_for_both_roles(monkeypatch):
    monkeypatch.setattr(server, "config", replace(config, token="same", runtime_token="same"))
    with pytest.raises(SystemExit, match="KB_RUNTIME_TOKEN must differ from KB_TOKEN"):
        server.build_app()


async def test_the_embedding_sync_runs_again_after_a_failure(monkeypatch):
    """Ollama restarting fails a write's embedding. A later pass embeds the entry, rather than the next deploy."""
    calls = []

    async def pull_model():
        calls.append("pull")

    async def sync_embeddings(pool):
        calls.append("sync")
        if calls.count("sync") == 1:
            raise httpx.ConnectError("Ollama is restarting")
        raise asyncio.CancelledError  # the second pass ran, so stop the loop here
    monkeypatch.setattr(server, "pull_model", pull_model)
    monkeypatch.setattr(server, "sync_embeddings", sync_embeddings)
    monkeypatch.setattr(server, "config", replace(config, embed_sync_seconds=0))
    with pytest.raises(asyncio.CancelledError):
        await server._embed_in_background()
    assert calls == ["pull", "sync", "sync"]
