#!/usr/bin/env python3
"""Regression tests for fail-closed release status reduction."""
from __future__ import annotations

import importlib.util
from pathlib import Path
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


if __name__ == "__main__":
    unittest.main()
