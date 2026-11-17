"""retrieval_eval.py reads the test split only once the knobs are frozen (R35, #39): --split test or all exits 2 before any request
unless MEMORY_EVAL_FREEZE=1, and a frozen read asks the server with freeze=1, which audits it.

  python3 -m unittest memory/eval/test_retrieval_eval.py
"""
import io
import json
import os
import sys
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import retrieval_eval  # noqa: E402


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def answer(req, timeout=60):
    url = req.full_url
    if "/eval/questions" in url:
        return Answer(json.dumps([]).encode())
    raise AssertionError(f"unexpected request {url}")


class SplitFreeze(unittest.TestCase):
    def run_main(self, *argv, freeze=None):
        env = {k: v for k, v in os.environ.items() if k != "MEMORY_EVAL_FREEZE"}
        if freeze is not None:
            env["MEMORY_EVAL_FREEZE"] = freeze
        env["MEMORY_ADMIN_TOKEN"] = "test-token"
        with mock.patch.dict(os.environ, env, clear=True), mock.patch.object(sys, "argv", ["retrieval_eval.py", *argv]), \
                mock.patch("urllib.request.urlopen", side_effect=answer) as urlopen, redirect_stderr(io.StringIO()):
            try:
                retrieval_eval.main()
                code = 0
            except SystemExit as e:
                code = e.code
        return code, urlopen

    def test_split_test_needs_freeze(self):
        for split in ("test", "all"):
            for freeze in (None, "0", "true", ""):
                code, urlopen = self.run_main("--split", split, freeze=freeze)
                self.assertEqual(code, 2, (split, freeze))
                self.assertEqual(urlopen.call_count, 0, (split, freeze))

    def test_frozen_read_asks_with_freeze(self):
        code, urlopen = self.run_main("--split", "test", "--arms", "hybrid", freeze="1")
        self.assertEqual(code, 0)
        urls = [c.args[0].full_url for c in urlopen.call_args_list]
        self.assertEqual(len(urls), 1)
        self.assertIn("split=test", urls[0])
        self.assertIn("freeze=1", urls[0])

    def test_train_needs_no_freeze(self):
        code, urlopen = self.run_main("--split", "train", "--arms", "hybrid")
        self.assertEqual(code, 0)
        self.assertNotIn("freeze", urlopen.call_args_list[0].args[0].full_url)


if __name__ == "__main__":
    unittest.main()
