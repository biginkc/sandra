#!/usr/bin/env python3
"""Regression tests for fail-closed release status reduction."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("release_gate_status", HERE / "release_gate.py")
assert SPEC and SPEC.loader
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)


class ReleaseGateStatusTests(unittest.TestCase):
    def test_stress_measurements_require_recomputable_raw_samples(self) -> None:
        evidence = {
            "measurements": {
                event: {"samples": 1, "p95_ms": 1.0, "p99_ms": 1.0}
                for event in ("first_open", "revisit", "selection")
            },
            "bulk_reply_recipient_cap": 50,
            "arrival_rate": {"samples": 1},
        }
        status, detail = gate.validate_measurements(
            evidence,
            {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50},
            tier="current",
        )
        self.assertEqual(status, "FAIL")
        self.assertIn("raw_samples", detail)

    def test_stress_measurements_require_raw_counts_to_match(self) -> None:
        evidence = {
            "measurements": {
                event: {"samples": 1, "p95_ms": 1.0, "p99_ms": 1.0}
                for event in ("first_open", "revisit", "selection")
            },
            "bulk_reply_recipient_cap": 50,
            "arrival_rate": {"samples": 1},
            "raw_samples": {
                "timing": [
                    {"event": "first_open", "duration_ms": 1.0},
                    {"event": "revisit", "duration_ms": 1.0},
                    {"event": "selection", "duration_ms": 1.0},
                    {"event": "selection", "duration_ms": 1.0},
                ],
                "metric": [],
                "recovery": [],
            },
        }
        status, detail = gate.validate_measurements(
            evidence,
            {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50},
            tier="current",
        )
        self.assertEqual(status, "FAIL")
        self.assertIn("raw sample count", detail)

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

    def test_whole_database_cleanup_is_a_decisive_evidence_gate(self) -> None:
        sha = "c" * 40
        fixture = {"database": "postgres", "marker": "http-marker"}
        manifest = {
            "fixture_policy": {
                "release_database": "release-db",
                "must_have_marker": "release-marker",
                "http_fixture": {
                    "database": "postgresql://localhost/postgres",
                    "database_marker": "http-marker",
                },
            },
            "budgets": {"sample_minimum": 1},
        }
        with tempfile.TemporaryDirectory() as directory:
            evidence_dir = Path(directory)
            for filename in (
                "current-volume-stress.json",
                "three-x-volume-stress.json",
                "worker-recovery.json",
                "relay-parity.json",
                "rollback-receipts.json",
                "whole-db-cleanup.json",
            ):
                (evidence_dir / filename).write_text(
                    json.dumps({"status": "BLOCKED", "candidate_sha": sha, "fixture": fixture})
                )
            result = gate.check_evidence(evidence_dir, sha, manifest)
        self.assertEqual(result["status"], "BLOCKED")
        self.assertEqual(result["checks"]["whole_db_cleanup"]["status"], "BLOCKED")

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
                f'{{"candidate_sha":"{sha}","cleanup_ok":true,"rows":[]}}\n'
            )
            old_root = gate.ROOT
            gate.ROOT = root
            try:
                result = gate.check_acceptance_matrix(sha)
            finally:
                gate.ROOT = old_root
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("cover the matrix exactly", result["detail"])

    def test_acceptance_gate_rejects_unproven_fixture_cleanup(self) -> None:
        sha = "b" * 40
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
                f'{{"candidate_sha":"{sha}","cleanup_ok":false,"rows":[{{"id":"F01","status":"pass","evidence":"test-results/inbox-acceptance-evidence/F01.png"}}]}}\n'
            )
            old_root = gate.ROOT
            gate.ROOT = root
            try:
                result = gate.check_acceptance_matrix(sha)
            finally:
                gate.ROOT = old_root
        self.assertEqual(result["status"], "BLOCKED")
        self.assertIn("cleanup", result["detail"])


if __name__ == "__main__":
    unittest.main()
