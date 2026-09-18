#!/usr/bin/env python3
"""Regression tests for fail-closed release status reduction."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("release_gate_status", HERE / "release_gate.py")
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class ReleaseGateStatusTests(unittest.TestCase):
    def test_unlisted_integrity_failure_is_decisive(self) -> None:
        statuses = gate.reduce_gate_statuses(
            {
                "candidate_identity": {"status": "PASS"},
                "source_manifest": {"status": "FAIL"},
                "candidate_package": {"status": "PASS"},
            },
            ["candidate_package"],
        )
        self.assertEqual(statuses["source_manifest"], "FAIL")

    def test_fixture_evidence_cannot_replace_unrun_release_probe(self) -> None:
        live = {"status": "BLOCKED", "detail": "release database probe not requested"}
        self.assertIs(gate.authoritative_rollback_gate(live), live)

    def test_acceptance_gate_requires_candidate_binding(self) -> None:
        result = gate.check_acceptance_matrix("0" * 40)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("candidate SHA", result["detail"])

    def test_acceptance_gate_rejects_empty_result_rows_even_with_current_sha(self) -> None:
        sha = "a" * 40
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            matrix = root / "docs/performance/inbox-redesign/acceptance-matrix.md"
            evidence = root / "test-results/inbox-acceptance-evidence/F01.png"
            matrix.parent.mkdir(parents=True)
            evidence.parent.mkdir(parents=True)
            evidence.write_bytes(b"owned evidence")
            matrix.write_text(
                f"<!-- acceptance-run candidate_sha: {sha} -->\n"
                "| ID | A | B | C | Status | Evidence |\n"
                "|---|---|---|---|---|---|\n"
                "| F01 | x | x | x | pass (run) | test-results/inbox-acceptance-evidence/F01.png |\n"
            )
            (root / "test-results/inbox-acceptance-results.json").write_text(
                f'{{"candidate_sha":"{sha}","rows":[]}}\n'
            )
            old_root = gate.ROOT
            gate.ROOT = root
            try:
                result = gate.check_acceptance_matrix(sha)
            finally:
                gate.ROOT = old_root
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("cover the matrix exactly", result["detail"])


if __name__ == "__main__":
    unittest.main()
