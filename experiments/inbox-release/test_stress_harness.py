#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("release_stress", HERE / "run-stress-recovery.py")
assert spec and spec.loader
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

gate_spec = importlib.util.spec_from_file_location("release_gate", HERE / "release_gate.py")
assert gate_spec and gate_spec.loader
gate = importlib.util.module_from_spec(gate_spec)
gate_spec.loader.exec_module(gate)


class StressHarnessTests(unittest.TestCase):
    def test_checked_in_config_is_blocked_until_profile_is_measured(self):
        config, target, release = module.load_config(HERE / "stress-harness-config.json")
        self.assertEqual(config["status"], "HARNESS_ONLY_NO_MEASUREMENTS")
        self.assertEqual(target["marker"], "sandra-inbox-release-http-owned-20260917")
        self.assertEqual(target["database_marker"], "sandra-inbox-http-owned-synthetic-20260917")
        self.assertEqual(release["budgets"]["sample_minimum"], 10)
        with self.assertRaises(module.HarnessBlocked):
            module.profile_dimensions(config, "current")

    def test_complete_observations_do_not_pass_without_unknown_thresholds(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 2, "tenant_count": 3, "history_skew": 0.5}
        records = {"timing": [], "metric": [], "recovery": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]}
        for event in config["required_timing_events"]:
            records["timing"].extend({"type": "timing", "event": event, "duration_ms": 1.0} for _ in range(10))
        for name in config["required_system_metrics"]:
            records["metric"].append({"type": "metric", "name": name, "value": 1.0})
        records["metric"].append({"type": "metric", "name": "arrival_rate_rps", "value": 1.0})
        result = module.validate_records(config, release, "current", records)
        self.assertEqual(result["overall"], "UNJUDGED")
        self.assertEqual(result["timing"]["ingestion"]["status"], "UNJUDGED_NO_THRESHOLD")
        self.assertEqual(result["system_metrics"]["locks"]["status"], "UNJUDGED_NO_THRESHOLD")

    def test_invalid_adapter_record_is_rejected(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        with self.assertRaises(module.HarnessBlocked):
            module.validate_records(config, release, "current", module.parse_records(json.dumps({"type": "timing", "event": "first_open", "duration_ms": -1}), "current"))

    def test_measured_failure_is_not_erased_by_later_unjudged_event(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        records = {"timing": [], "metric": [], "recovery": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]}
        for event in config["required_timing_events"]:
            duration = 100000.0 if event == "first_open" else 1.0
            records["timing"].extend({"type": "timing", "event": event, "duration_ms": duration} for _ in range(10))
        for name in config["required_system_metrics"]:
            records["metric"].append({"type": "metric", "name": name, "value": 1.0})
        result = module.validate_records(config, release, "current", records)
        self.assertEqual(result["timing"]["first_open"]["status"], "FAIL")
        self.assertEqual(result["overall"], "FAIL")

    def test_missing_arrival_measurement_is_blocked(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        records = {"timing": [], "metric": [], "recovery": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]}
        for event in config["required_timing_events"]:
            records["timing"].extend({"type": "timing", "event": event, "duration_ms": 1.0} for _ in range(10))
        for name in config["required_system_metrics"]:
            records["metric"].append({"type": "metric", "name": name, "value": 1.0})
        result = module.validate_records(config, release, "current", records)
        self.assertEqual(result["arrival_rate"]["status"], "BLOCKED")
        self.assertEqual(result["overall"], "BLOCKED")

    def test_release_evidence_serializes_to_gate_contract(self):
        _config, target, release = module.load_config(HERE / "stress-harness-config.json")
        validated = {
            "overall": "PASS",
            "profile": "current",
            "profile_dimensions": {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1},
            "timing": {
                event: {"sample_count": 10, "p95_ms": 1.0, "p99_ms": 1.0, "status": "MEASURED"}
                for event in ("first_open", "revisit", "selection")
            },
            "arrival_rate": {"samples": 10, "p95_rps": 1.0, "status": "MEASURED"},
            "system_metrics": {},
            "recovery": {"status": "MEASURED", "faults": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]},
        }
        evidence = module.release_evidence(target, release, validated)
        with tempfile.TemporaryDirectory() as directory:
            evidence_path = Path(directory) / "synthetic-evidence.json"
            evidence_path.write_text(json.dumps(evidence))
            status, detail, loaded = gate.validate_evidence_file(evidence_path, module.current_candidate_sha(), release["fixture_policy"])
        self.assertEqual(status, "PASS", detail)
        self.assertEqual(loaded, evidence)


if __name__ == "__main__":
    unittest.main()
