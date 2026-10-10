"""The decision model. It filters recalled items (job 1) and spots Wen's pushback on idle (job 2).

Every candidate returns typed answers, never prose, so the working agent never grades itself.
Private entries are redacted before any third-party model sees them.
"""
import os
import re
import time

PUSHBACK = (
    "The text is the latest message Wen sent to an AI assistant. Answer true if he is pushing back: correcting the "
    "assistant, saying it is wrong, rejecting what it did or suggested, or showing frustration with it. Answer false for "
    "new requests, answers to its questions, neutral follow-ups and agreement.")
CAUSE = "If Wen is pushing back, which delivered memory item caused it? Pick none if no delivered item did."
RELEVANT = "Is memory item {n} relevant to the task? Relevant means the agent doing the task needs it or must respect it."

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


CANDIDATES = {"keywords": Keywords, "openai": OpenAIDecisions}
