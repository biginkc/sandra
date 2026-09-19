#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_db_probe", HERE / "release_db_probe.py")
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseDbProbeTests(unittest.TestCase):
    def test_targets_are_explicitly_separated(self):
        self.assertEqual(module.EXPECTED_DATABASE, "sandra_inbox_release_20260917")
        self.assertEqual(module.EXPECTED_MARKER, "sandra-inbox-release-owned-synthetic")
        self.assertEqual(module.EXPECTED_PURPOSE, "sandra-inbox-projection-t2")

    def test_http_read_probe_records_observed_sqlstate_and_message(self):
        source = (HERE / "release_db_probe.py").read_text()
        self.assertIn("observed_state||'|'||observed_message", source)
        self.assertNotIn('SELECT \'INBOX_NOT_READY\'', source)

    def test_http_probe_normalizes_owned_fixture_before_identity_check(self):
        source = (HERE / "release_db_probe.py").read_text()
        self.assertIn('if TARGET == "http":', source)
        self.assertIn("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton", source)
    def test_privileged_fixture_setup_precedes_authenticated_role(self):
        script = module.receipt_probe_sql(
            "11111111-1111-4111-8111-111111111111",
            "22222222-2222-4222-8222-222222222222",
            "33333333-3333-4333-8333-333333333333",
            "SELECT public.inbox_operation_status(gen_random_uuid());",
        )
        self.assertLess(
            script.index("UPDATE inbox_control.rollout SET serving_enabled=false"),
            script.index("SET LOCAL ROLE authenticated"),
        )
        self.assertLess(
            script.index("SET LOCAL ROLE authenticated"),
            script.index("SELECT public.inbox_operation_status"),
        )

    def test_permission_denied_before_wrapper_is_not_a_pass(self):
        with self.assertRaises(module.ReceiptProbeError):
            module.classify_receipt_probe(
                "public.inbox_operation_status(uuid)",
                1,
                "",
                "ERROR: permission denied for table rollout",
            )

    def test_expected_missing_reference_proves_wrapper_reached(self):
        result = module.classify_receipt_probe(
            "public.inbox_operation_status(uuid)",
            1,
            "",
            "ERROR: INBOX_ACTION_OPERATION_UNAVAILABLE",
        )
        self.assertIn("expected outcome", result)

    def test_not_ready_and_unexpected_success_are_rejected(self):
        with self.assertRaises(module.ReceiptProbeError):
            module.classify_receipt_probe(
                "public.inbox_operation_status(uuid)",
                1,
                "",
                "ERROR: INBOX_NOT_READY",
            )
        with self.assertRaises(module.ReceiptProbeError):
            module.classify_receipt_probe("public.inbox_operation_status(uuid)", 0, "{}", "")


if __name__ == "__main__":
    unittest.main()
