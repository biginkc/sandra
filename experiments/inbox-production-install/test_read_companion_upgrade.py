#!/usr/bin/env python3
"""Source-only checks for the existing-schema read companion path."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import unittest
from unittest import mock

P = Path(__file__).resolve().parent
if str(P) not in sys.path:
    sys.path.insert(0, str(P))


class ReadCompanionUpgradeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        subprocess.run([sys.executable, str(P / "read-companion.py"), "--target", "release-db"], check=True)

    def test_historical_receipt_is_not_current_install_proof(self) -> None:
        receipt = json.loads((P / "read-companion-evidence.json").read_text())
        self.assertEqual(receipt["status"], "HISTORICAL_UNVERIFIED")
        self.assertNotEqual(
            receipt["historical_receipt"]["compiled_sha256"],
            receipt["current_generated"]["compiled_sha256"],
        )
        self.assertEqual(
            receipt["current_generated"]["compiled_sha256"],
            hashlib.sha256((P / "generated" / "read-companion.sql").read_bytes()).hexdigest(),
        )

    def test_current_upgrade_is_forward_only_and_guarded(self) -> None:
        required = {
            "inbox_read.authoritative_context",
            "inbox_read.detail",
            "inbox_read.history_page",
            "public.inbox_create_workset_v2",
            "public.inbox_probe_workset_updates",
            "public.inbox_review_selection",
        }
        for name in ("current", "workset-updates", "selection-review"):
            packet = (P / "generated" / f"read-upgrade-{name}.sql").read_text()
            self.assertNotRegex(packet, r"\bCREATE\s+(?:SCHEMA|TABLE)\b")
            self.assertNotRegex(packet, r"(?<!OR REPLACE )\bCREATE\s+FUNCTION\b")
            self.assertIn("current_database()<>'sandra_inbox_release_20260917'", packet)
            self.assertIn("marker='sandra-inbox-release-owned-synthetic'", packet)
            self.assertIn("SET LOCAL lock_timeout='2s'", packet)
            self.assertIn("SET LOCAL statement_timeout='30s'", packet)
        current = (P / "generated" / "read-upgrade-current.sql").read_text()
        names = set(re.findall(r"CREATE OR REPLACE FUNCTION ([\w.]+)\(", current, re.I))
        self.assertTrue(required.issubset(names), sorted(required - names))

    def test_auth_forward_upgrade_is_generated_without_fresh_ddl(self) -> None:
        packet = (P / "generated" / "auth-upgrade.sql").read_text()
        self.assertNotRegex(packet, r"\bCREATE\s+(?:SCHEMA|TABLE)\b")
        self.assertIn("CREATE OR REPLACE FUNCTION inbox_bridge.authorize", packet)
        self.assertIn("current_database()='sandra_inbox_release_20260917'", packet)
        self.assertIn("marker='sandra-inbox-release-owned-synthetic'", packet)
        self.assertIn("current_database()='postgres'", packet)
        self.assertIn("marker='sandra-inbox-http-owned-synthetic-20260917'", packet)

    def test_http_profile_compiles_an_exact_distinct_guard(self) -> None:
        subprocess.run(
            [sys.executable, str(P / "read-companion.py"), "--target", "http"],
            check=True,
        )
        packet = (P / "generated" / "read-upgrade-current.sql").read_text()
        self.assertIn("current_database()<>'postgres'", packet)
        self.assertIn("marker='sandra-inbox-http-owned-synthetic-20260917'", packet)
        self.assertNotIn("sandra_inbox_release_20260917", packet)
        self.assertNotIn("sandra-inbox-release-owned-synthetic", packet)
        # Restore the checked-in/default release rehearsal packet after this
        # profile-only compile so subsequent tests cannot consume HTTP output.
        subprocess.run([sys.executable, str(P / "read-companion.py"), "--target", "release-db"], check=True)

    def test_installer_requires_explicit_owned_mode(self) -> None:
        result = subprocess.run(
            [sys.executable, str(P / "install-read-upgrade.py")],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--owned-fixture", result.stderr + result.stdout)

    def test_http_installer_compiles_selected_packet_before_apply(self) -> None:
        spec = __import__("importlib.util").util.spec_from_file_location(
            "install_read_upgrade", P / "install-read-upgrade.py"
        )
        installer = __import__("importlib.util").util.module_from_spec(spec)
        spec.loader.exec_module(installer)
        http_db = __import__("http_fixture_db")
        calls = []
        real_run = subprocess.run
        old_profile = os.environ.get("INBOX_RELEASE_TARGET_PROFILE")
        generated = {
            path: path.read_bytes()
            for path in (P / "generated").glob("read-upgrade-*.sql")
        }

        def fake_run(command, *args, **kwargs):
            if str(P / "read-companion.py") in command:
                calls.append(command)
                # Let the compile step produce the target-specific packet;
                # keep the live verifier as a command double.
                if "--verify-only" not in command:
                    return real_run(command, *args, **kwargs)
                return subprocess.CompletedProcess(command, 0, "", "")
            return real_run(command, *args, **kwargs)

        def fake_sql(query, *args, **kwargs):
            if "to_regnamespace('inbox_read')" in query:
                return "t"
            if "serving_enabled" in query:
                return "f"
            return ""

        evidence = P / "read-upgrade-evidence.json"
        old_evidence = evidence.read_bytes() if evidence.exists() else None
        try:
            with mock.patch.object(http_db, "guard"), mock.patch.object(http_db, "sql", side_effect=fake_sql), mock.patch.object(http_db, "ensure_concurrent_index", return_value="idx"), mock.patch.object(installer.subprocess, "run", side_effect=fake_run), mock.patch.object(sys, "argv", [str(P / "install-read-upgrade.py"), "--owned-fixture", "--target", "http"]):
                self.assertEqual(installer.main(), 0)
            self.assertEqual(len(calls), 2)
            self.assertNotIn("--verify-only", calls[0])
            self.assertIn("--verify-only", calls[1])
            self.assertIn("--target", calls[0])
            self.assertEqual(calls[0][calls[0].index("--target") + 1], "http")
            self.assertEqual(calls[1][calls[1].index("--target") + 1], "http")
            packet = (P / "generated" / "read-upgrade-current.sql").read_text()
            self.assertIn("current_database()<>'postgres'", packet)
            self.assertIn("marker='sandra-inbox-http-owned-synthetic-20260917'", packet)
        finally:
            if old_profile is None:
                os.environ.pop("INBOX_RELEASE_TARGET_PROFILE", None)
            else:
                os.environ["INBOX_RELEASE_TARGET_PROFILE"] = old_profile
            for path, content in generated.items():
                path.write_bytes(content)
            if old_evidence is None:
                evidence.unlink(missing_ok=True)
            else:
                evidence.write_bytes(old_evidence)


if __name__ == "__main__":
    unittest.main()
