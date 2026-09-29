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
                "metric": [{"name": "cpu_percent", "value": 1.0}],
                "recovery": [{"fault": "owned", "recovered": True, "duration_ms": 1.0}],
            },
        }
        status, detail = gate.validate_measurements(
            evidence,
            {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50},
            tier="current",
        )
        self.assertEqual(status, "FAIL")
        self.assertIn("raw sample count", detail)

    def test_stress_measurements_recompute_reported_percentiles(self) -> None:
        evidence = {
            "measurements": {
                event: {"samples": 2, "p95_ms": 999.0, "p99_ms": 999.0}
                for event in ("first_open", "revisit", "selection")
            },
            "bulk_reply_recipient_cap": 50,
            "arrival_rate": {"samples": 1},
            "raw_samples": {
                "timing": [
                    {"event": event, "duration_ms": value}
                    for event in ("first_open", "revisit", "selection")
                    for value in (1.0, 2.0)
                ],
                "metric": [{"name": "cpu_percent", "value": 1.0}],
                "recovery": [{"fault": "owned", "recovered": True, "duration_ms": 1.0}],
            },
        }
        status, detail = gate.validate_measurements(
            evidence,
            {"sample_minimum": 2, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50},
            tier="current",
        )
        self.assertEqual(status, "FAIL")
        self.assertIn("p95 does not match", detail)

    def test_stress_measurements_validate_metric_and_recovery_raw_records(self) -> None:
        evidence = {
            "measurements": {
                event: {"samples": 1, "p95_ms": 1.0, "p99_ms": 1.0}
                for event in ("first_open", "revisit", "selection")
            },
            "bulk_reply_recipient_cap": 50,
            "arrival_rate": {"samples": 1},
            "raw_samples": {
                "timing": [{"event": event, "duration_ms": 1.0} for event in ("first_open", "revisit", "selection")],
                "metric": [{"name": "cpu_percent", "value": "bad"}],
                "recovery": [{"fault": "owned", "recovered": True, "duration_ms": 1.0}],
            },
        }
        status, detail = gate.validate_measurements(
            evidence,
            {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50},
            tier="current",
        )
        self.assertEqual(status, "FAIL")
        self.assertIn("raw_samples.metric", detail)

    def _valid_measurement_evidence(self) -> dict:
        timing = [{"event": event, "duration_ms": 1.0} for event in ("first_open", "revisit", "selection")]
        metric = [
            {"name": "arrival_rate_rps", "value": 1.0},
            {"name": "operator_arrival_rate_rps", "value": 1.0},
            *[{"name": name, "value": 1.0} for name in ("cpu_percent", "memory_bytes", "locks", "connections")],
        ]
        return {
            "measurements": {event: {"samples": 1, "p95_ms": 1.0, "p99_ms": 1.0} for event in ("first_open", "revisit", "selection")},
            "bulk_reply_recipient_cap": 50,
            "arrival_rate": {"samples": 1, "p95_rps": 1.0},
            "operator_arrival_rate": {"samples": 1, "p95_rps": 1.0},
            "system_metrics": {name: {"sample_count": 1, "p95": 1.0} for name in ("cpu_percent", "memory_bytes", "locks", "connections")},
            "raw_samples": {"timing": timing, "metric": metric, "recovery": [{"fault": "owned", "recovered": True, "duration_ms": 1.0}]},
        }

    def test_stress_measurements_reject_empty_metric_and_recovery_backing(self) -> None:
        for field in ("metric", "recovery"):
            evidence = self._valid_measurement_evidence()
            evidence["raw_samples"][field] = []
            status, detail = gate.validate_measurements(evidence, {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50}, tier="current")
            self.assertEqual(status, "FAIL")
            self.assertIn(f"raw_samples.{field} is empty", detail)

    def test_stress_measurements_reject_fabricated_arrival_and_system_summaries(self) -> None:
        evidence = self._valid_measurement_evidence()
        evidence["arrival_rate"]["p95_rps"] = -500
        status, detail = gate.validate_measurements(evidence, {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50}, tier="current")
        self.assertEqual(status, "FAIL")
        self.assertIn("arrival_rate p95", detail)
        evidence = self._valid_measurement_evidence()
        del evidence["system_metrics"]["connections"]
        status, detail = gate.validate_measurements(evidence, {"sample_minimum": 1, "first_open_p95_ms": 1000, "revisit_p95_ms": 200, "selection_p95_ms": 100, "bulk_reply_recipient_cap": 50}, tier="current")
        self.assertEqual(status, "FAIL")
        self.assertIn("system metric connections", detail)

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

    def test_worker_recovery_requires_exact_head_dispatch_boundary_proof(self) -> None:
        sha = "d" * 40
        with tempfile.TemporaryDirectory() as directory:
            evidence_dir = Path(directory)
            path = evidence_dir / f"worker-runtime-proof-{sha[:8]}.json"
            runner = gate.ROOT / "experiments/inbox-reply-send-worker/runtime-proof.py"
            path.write_text(json.dumps({
                "candidate_sha": sha,
                "status": "PASS",
                "proof_groups": 5,
                "killed_after_marker": True,
                "transport_calls_after_redelivery": 1,
                "discovered_tables": 142,
                "cleanup_baseline_content_match": True,
                "runner_path": "experiments/inbox-reply-send-worker/runtime-proof.py",
                "runner_sha256": gate.sha256(runner),
                "checks": [
                    "dispatch_started marker committed and observed before transport returned",
                    "docker kill terminated worker mid-flight before provider result/persist",
                    "worker restart caused same durable invocation to re-enter via claim and settle uncertain",
                    "synthetic transport call count remained exactly 1 across crash/redelivery; no double dispatch",
                    "cleanup removed containers/volume/image/role/schemas and dynamic 142-table baseline check passed",
                ],
            }))
            status, detail, found = gate.validate_worker_send_boundary(evidence_dir, sha)
        self.assertEqual(status, "PASS")
        self.assertIn("dispatch-boundary", detail)
        self.assertEqual(found, path)

    def test_worker_boundary_rejects_negated_double_dispatch_text(self) -> None:
        sha = "b" * 40
        with tempfile.TemporaryDirectory() as directory:
            evidence_dir = Path(directory)
            runner = gate.ROOT / "experiments/inbox-reply-send-worker/runtime-proof.py"
            (evidence_dir / f"worker-runtime-proof-{sha[:8]}.json").write_text(json.dumps({
                "candidate_sha": sha, "status": "PASS", "proof_groups": 5,
                "killed_after_marker": True, "transport_calls_after_redelivery": 2,
                "discovered_tables": 142, "cleanup_baseline_content_match": True,
                "runner_path": "experiments/inbox-reply-send-worker/runtime-proof.py",
                "runner_sha256": gate.sha256(runner),
                "checks": ["transport call count was 2, NOT exactly 1 — a DOUBLE DISPATCH occurred"],
            }))
            status, detail, _ = gate.validate_worker_send_boundary(evidence_dir, sha)
        self.assertEqual(status, "FAIL")
        self.assertIn("exactly one transport call", detail)

    def test_worker_boundary_exercises_each_structured_guard(self) -> None:
        sha = "a" * 40
        runner = gate.ROOT / "experiments/inbox-reply-send-worker/runtime-proof.py"
        base = {
            "candidate_sha": sha, "status": "PASS", "proof_groups": 5,
            "killed_after_marker": True, "transport_calls_after_redelivery": 1,
            "discovered_tables": 142, "cleanup_baseline_content_match": True,
            "runner_path": "experiments/inbox-reply-send-worker/runtime-proof.py",
            "runner_sha256": gate.sha256(runner), "checks": [],
        }
        for field, value, expected in (
            ("killed_after_marker", False, "post-marker worker kill"),
            ("transport_calls_after_redelivery", 2, "exactly one transport call"),
            ("discovered_tables", 0, "positive discovered table count"),
            ("cleanup_baseline_content_match", False, "whole-database baseline"),
        ):
            with self.subTest(field=field), tempfile.TemporaryDirectory() as directory:
                evidence_dir = Path(directory)
                item = dict(base, **{field: value})
                (evidence_dir / f"worker-runtime-proof-{sha[:8]}.json").write_text(json.dumps(item))
                status, detail, _ = gate.validate_worker_send_boundary(evidence_dir, sha)
                self.assertEqual(status, "FAIL")
                self.assertIn(expected, detail)

    def test_worker_recovery_boundary_proof_cannot_be_reused_from_another_head(self) -> None:
        sha = "e" * 40
        with tempfile.TemporaryDirectory() as directory:
            evidence_dir = Path(directory)
            (evidence_dir / "worker-runtime-proof-eeeeeeee.json").write_text(
                json.dumps({"candidate_sha": "f" * 40, "status": "PASS", "proof_groups": 5, "checks": []})
            )
            status, detail, _ = gate.validate_worker_send_boundary(evidence_dir, sha)
        self.assertEqual(status, "FAIL")
        self.assertIn("candidate SHA", detail)

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
