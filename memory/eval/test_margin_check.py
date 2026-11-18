import contextlib
import io
import unittest

from memory.eval.margin_check import evaluate, load_free_plan, load_pro_quotas, main


class MarginCheckTest(unittest.TestCase):
    def test_parses_pro_quotas_and_free_plan(self):
        quotas = load_pro_quotas()
        self.assertEqual(quotas["database"], 8_000_000_000)
        self.assertEqual(quotas["storage"], 100_000_000_000)
        self.assertEqual(quotas["egress"], 250_000_000_000)
        self.assertEqual(quotas["invocations"], 2_000_000)
        self.assertEqual(quotas["mau"], 100_000)

        plan = load_free_plan()
        self.assertEqual(plan["seats"], 1000)
        self.assertEqual(plan["entries_total"], 100)
        self.assertEqual(plan["recalls_month"], 300)
        self.assertEqual(plan["remembers_month"], 50)
        self.assertEqual(plan["blob_bytes_total"], 0)
        self.assertEqual(plan["openai_tokens_month"], 250_000)

    def test_1000_free_accounts_fit_pro(self):
        ok, report = evaluate(1000)
        self.assertTrue(ok)
        self.assertTrue(all(m["ok"] for m in report["metrics"].values()))
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--free", "1000", "--json"]), 0)

    def test_excess_free_accounts_fail_pro_quotas(self):
        ok, report = evaluate(2500)
        self.assertFalse(ok)
        self.assertFalse(report["metrics"]["database"]["ok"])
        self.assertFalse(report["metrics"]["invocations"]["ok"])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--free", "2500"]), 1)


if __name__ == "__main__":
    unittest.main()
