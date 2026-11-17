"""The decision model. It filters recalled items (job 1) and spots Wen's pushback on idle (job 2).

Every candidate returns typed answers, never prose, so the working agent never grades itself.
Private entries are redacted before any third-party model sees them.
"""
import argparse
import asyncio
import json
import os
import re
import time
import urllib.request

PUSHBACK = (
    "The text is the latest message Wen sent to an AI assistant. Answer true if he is pushing back: correcting the "
    "assistant, saying it is wrong, rejecting what it did or suggested, or showing frustration with it. Answer false for "
    "new requests, answers to its questions, neutral follow-ups and agreement.")
CAUSE = "If Wen is pushing back, which delivered memory item caused it? Pick none if no delivered item did."
RELEVANT = "Is memory item {n} relevant to the task? Relevant means the agent doing the task needs it or must respect it."
RELEVANT_CRITERIA = {
    "true_description": (
        "An assistant handling the request needs this item to answer accurately (including notes stating something "
        "is undecided/undefined, or covering a broader range or rule that applies to the subject) or must respect it."
    ),
    "false_description": (
        "The item only shares a word or general topic with the request without answering or constraining it."
    ),
}

KEYWORDS = re.compile(
    r"\b(no+|nope|wrong|wron|false|incorrect|stop|garbage|useless|uselss|dumb|stupid|flawed|unacceptable|excessive|"
    r"wtf|fuck\w*|bullshit|scam|bruh|dude|why on earth|why the|not what i|i said|i meant|i mean|look online|"
    r"where is your|where can i find|try again)\b|\?{2,}|!{2,}", re.I)


def redact(item):
    if item.get("sensitivity") == "private":
        return dict(item, body="[private]", evidence="")
    return item


def item_text(n, item):
    item = redact(item)
    return f"[{n}] {item['id']}: {item['title']}. {item.get('body') or ''}".strip()


class Keywords:
    """Baseline: keyword rules. A decision model has to beat this to earn a place."""
    name = "keywords"

    async def pushback(self, message, delivered=()):
        started = time.monotonic()
        hit = bool(KEYWORDS.search(message))
        return {"pushback": hit, "p": 1.0 if hit else 0.0, "cause": None,
                "latency_ms": int((time.monotonic() - started) * 1000)}

    async def relevant(self, task, items):
        raise NotImplementedError("keywords only detect pushback")


class OpenAIDecisions:
    """OpenAI's Decisions API (POST /v1/decisions). gpt-6-luna is the only model it serves today."""

    def __init__(self, model=None, client=None):
        from openai import AsyncOpenAI
        self.model = model or os.environ.get("DECIDER_MODEL", "gpt-6-luna")
        self.name = f"openai:{self.model}"
        key = os.environ.get("OPENAI_API_KEY") or os.environ.get("OPEN_AI")
        self.client = client or AsyncOpenAI(api_key=key)

    async def _decide(self, text, questions):
        started = time.monotonic()
        d = await self.client.decisions.create(model=self.model, input=text, questions=questions)
        return {a.name: a for a in d.answers}, int((time.monotonic() - started) * 1000), d.usage

    async def pushback(self, message, delivered=()):
        questions = [{"type": "predicate", "name": "pushback", "instructions": PUSHBACK}]
        text = f"Wen's message:\n{message}"
        if delivered:
            text += "\n\nMemory items delivered to the assistant this turn:\n" + "\n".join(
                item_text(n, it) for n, it in enumerate(delivered, 1))
            questions.append({"type": "choice", "name": "cause", "instructions": CAUSE,
                              "choices": [{"value": "none"}] + [{"value": it["id"]} for it in delivered]})
        answers, ms, usage = await self._decide(text, questions)
        p = answers["pushback"]
        prob = getattr(p, "probability", None)
        cause = answers.get("cause")
        return {"pushback": prob is not None and prob >= 0.5, "p": prob, "refused": p.type == "refusal",
                "cause": getattr(cause, "choice", None) if cause is not None else None,
                "latency_ms": ms, "input_tokens": usage.input_tokens}

    async def relevant(self, task, items):
        """Probability each item is relevant to the task, keyed by entry id. The filter cuts the ones below its threshold."""
        text = f"Task:\n{task}\n\nMemory items:\n" + "\n".join(item_text(n, it) for n, it in enumerate(items, 1))
        questions = [{"type": "predicate", "name": f"i{n}", "instructions": RELEVANT.format(n=n)}
                     for n in range(1, len(items) + 1)]
        answers, ms, usage = await self._decide(text, questions)
        probs = {it["id"]: getattr(answers.get(f"i{n}"), "probability", None) for n, it in enumerate(items, 1)}
        return {"p": probs, "latency_ms": ms, "input_tokens": usage.input_tokens}


class GeminiDecisions:
    """Google's Gemini Decisions API (POST /v1beta/decisions) with gemini-decision-1."""

    def __init__(self, model=None, api_key=None, base_url=None, criteria=False):
        self.model = model or os.environ.get("GEMINI_DECIDER_MODEL", "gemini-decision-1")
        self.criteria = criteria
        self.name = f"gemini-criteria:{self.model}" if criteria else f"gemini:{self.model}"
        self.api_key = api_key or os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
        self.base_url = (base_url or os.environ.get("MEMORY_GEMINI_URL")
                         or "https://generativelanguage.googleapis.com/v1beta").rstrip("/")

    def _post(self, payload):
        if not self.api_key:
            raise RuntimeError("GEMINI_API_KEY (or GOOGLE_API_KEY) is required for GeminiDecisions")
        req = urllib.request.Request(
            f"{self.base_url}/decisions",
            data=json.dumps(payload).encode("utf-8"),
            headers={"x-goog-api-key": self.api_key, "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.load(resp)

    async def _decide(self, text, questions):
        started = time.monotonic()
        d = await asyncio.to_thread(self._post, {"model": self.model, "input": text, "questions": questions})
        ms = int((time.monotonic() - started) * 1000)
        usage = d.get("usage") or {}
        tokens = usage.get("total_input_tokens") or usage.get("total_tokens") or usage.get("input_tokens") or 0
        return d.get("answers") or {}, ms, tokens

    async def pushback(self, message, delivered=()):
        questions = {"pushback": {"type": "noul", "instructions": PUSHBACK}}
        text = f"Wen's message:\n{message}"
        if delivered:
            text += "\n\nMemory items delivered to the assistant this turn:\n" + "\n".join(
                item_text(n, it) for n, it in enumerate(delivered, 1))
            criteria = {str(i): f"[{i + 1}] {it['id']}: {it['title']}" for i, it in enumerate(delivered)}
            criteria["none"] = "No delivered memory item caused the pushback."
            questions["cause"] = {"type": "choice", "instructions": CAUSE, "criteria": criteria}
        answers, ms, tokens = await self._decide(text, questions)
        p = answers.get("pushback") or {}
        prob = p.get("noul")
        choice = (answers.get("cause") or {}).get("choice")
        cause = None
        if isinstance(choice, str) and choice.isascii() and choice.isdigit():
            idx = int(choice)
            if 0 <= idx < len(delivered):
                cause = delivered[idx]["id"]
        return {"pushback": prob is not None and prob >= 0.5, "p": prob, "refused": p.get("type") == "refusal",
                "cause": cause, "latency_ms": ms, "input_tokens": tokens}

    async def relevant(self, task, items):
        text = f"Task:\n{task}\n\nMemory items:\n" + "\n".join(item_text(n, it) for n, it in enumerate(items, 1))
        questions = {}
        for n in range(1, len(items) + 1):
            q = {"type": "noul", "instructions": RELEVANT.format(n=n)}
            if self.criteria:
                q["criteria"] = RELEVANT_CRITERIA
            questions[f"i{n}"] = q
        answers, ms, tokens = await self._decide(text, questions)
        probs = {it["id"]: (answers.get(f"i{n}") or {}).get("noul") for n, it in enumerate(items, 1)}
        return {"p": probs, "latency_ms": ms, "input_tokens": tokens}


CANDIDATES = {
    "keywords": Keywords,
    "openai": OpenAIDecisions,
    "gemini": GeminiDecisions,
    "gemini-criteria": lambda **kw: GeminiDecisions(criteria=True, **kw),
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--judge", default="gemini", choices=sorted(CANDIDATES))
    ap.add_argument("--message", help="check pushback on a message")
    ap.add_argument("--task", help="score relevance of --items JSON for a task")
    ap.add_argument("--items", default="[]", help="JSON array of {id, title, body?, sensitivity?}")
    a = ap.parse_args()
    judge = CANDIDATES[a.judge]()
    items = json.loads(a.items)
    if a.task is not None:
        out = asyncio.run(judge.relevant(a.task, items))
    else:
        out = asyncio.run(judge.pushback(a.message or "", items))
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
