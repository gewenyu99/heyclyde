"""research.py holds the research token and nothing else (R35, #39): with no research token it exits 2 before any request, every
request it makes carries the research token, its train eval reads the train split only, and its log comment carries the run marker.

  python3 -m unittest memory/research/test_research.py
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import research  # noqa: E402


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


QUESTIONS = [{"id": "q1", "text": "oolong water", "qtype": "fact", "split": "train", "gold": ["tea-oolong-temp"], "must_not": ["tea-oolong-old"]},
             {"id": "q2", "text": "cold brew", "qtype": "fact", "split": "train", "gold": ["tea-draft-cold"], "must_not": []}]


def server(seen):
    def answer(req, timeout=60):
        seen.append(req)
        url = req.full_url
        if "/eval/questions" in url:
            return Answer(json.dumps(QUESTIONS).encode())
        if "/param-sets/" in url:
            return Answer(json.dumps({"id": "hybrid.r1", "arm": "hybrid"}).encode())
        if url.endswith("/eval/rank"):
            q = json.loads(req.data)["query"]
            hit = ["tea-oolong-temp", "tea-oolong-old"] if q == "oolong water" else ["proj-tea"]
            return Answer(json.dumps({"candidates": hit + ["tea-draft-cold"], "delivered": hit, "degraded": None, "parts": None}).encode())
        return Answer(b"{}")
    return answer


class Research(unittest.TestCase):
    def run_cli(self, *argv, token="research-test-token"):
        seen = []
        with tempfile.TemporaryDirectory() as home:
            env = {k: v for k, v in os.environ.items() if not k.startswith("MEMORY_")}
            env["HOME"] = home
            if token:
                env["MEMORY_RESEARCH_TOKEN"] = token
            out = io.StringIO()
            with mock.patch.dict(os.environ, env, clear=True), mock.patch("urllib.request.urlopen", side_effect=server(seen)), \
                    redirect_stdout(out), redirect_stderr(io.StringIO()):
                try:
                    research.main(list(argv))
                    code = 0
                except SystemExit as e:
                    code = e.code
        return code, seen, out.getvalue()

    def test_no_research_token_exits_before_any_request(self):
        code, seen, _ = self.run_cli("bundle", token=None)
        self.assertEqual(code, 2)
        self.assertEqual(seen, [])

    def test_every_request_carries_the_research_token(self):
        code, seen, _ = self.run_cli("train", "hybrid.r1")
        self.assertEqual(code, 0)
        self.assertTrue(seen)
        for req in seen:
            self.assertEqual(req.get_header("Authorization"), "Bearer research-test-token")

    def test_train_reads_the_train_split_only_and_reports_hits_leaks_and_mrr(self):
        code, seen, out = self.run_cli("train", "hybrid.r1")
        self.assertEqual(code, 0)
        questions = [r.full_url for r in seen if "/eval/questions" in r.full_url]
        self.assertEqual(len(questions), 1)
        self.assertTrue(questions[0].endswith("split=train"), questions[0])
        report = json.loads(out)
        self.assertEqual(report["param_set"], "hybrid.r1")
        self.assertEqual([report["gold_hits"], report["n"], report["leaks"]], [1, 2, 1])
        self.assertAlmostEqual(report["mrr"], (1 + 1 / 2) / 2)
        self.assertEqual([m["id"] for m in report["misses"]], ["q2"])

    def test_log_comment_carries_the_run_marker_once(self):
        self.assertEqual(research.with_marker("## Inputs\n", "S1").count("<!-- research-memory run S1 -->"), 1)
        marked = research.with_marker("<!-- research-memory run S1 -->\n## Inputs\n", "S1")
        self.assertEqual(marked.count("<!-- research-memory run S1 -->"), 1)


if __name__ == "__main__":
    unittest.main()
