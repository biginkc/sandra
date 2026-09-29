#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import shlex
import sys
import tempfile
import textwrap
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
    @staticmethod
    def timing_records(event, duration=1.0, count=10):
        rows = []
        for index in range(count):
            record = {"type": "timing", "event": event, "duration_ms": duration}
            if event == "ingestion":
                arrival = 1_000.0 + index
                record["sample"] = {
                    "boundary": "source_arrival_to_exact_projected_version",
                    "targetId": "00000000-0000-4000-8000-000000000001",
                    "sourceMessageId": f"00000000-0000-4000-8000-{index + 2:012d}",
                    "inboundRevision": index + 1,
                    "sourceCaptureGeneration": index + 1,
                    "arrivalAtMs": arrival,
                    "observedAtMs": arrival + duration,
                    "projectedVersion": 1,
                }
            rows.append(record)
        return rows

    def test_checked_in_config_is_blocked_until_profile_is_measured(self):
        config, target, release = module.load_config(HERE / "stress-harness-config.json")
        self.assertEqual(config["status"], "HARNESS_ONLY_NO_MEASUREMENTS")
        self.assertEqual(target["marker"], "sandra-inbox-release-http-owned-20260917")
        self.assertEqual(target["database_marker"], "sandra-inbox-http-owned-synthetic-20260917")
        self.assertEqual(release["budgets"]["sample_minimum"], 10)
        self.assertEqual(config["resource_sampling"]["synchronized_with_workload"], True)
        self.assertGreater(config["resource_sampling"]["window_ms"], config["resource_sampling"]["interval_ms"])
        with self.assertRaises(module.HarnessBlocked):
            module.profile_dimensions(config, "current")

    def test_complete_observations_do_not_pass_without_unknown_thresholds(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 2, "tenant_count": 3, "history_skew": 0.5}
        records = {"timing": [], "metric": [], "recovery": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]}
        for event in config["required_timing_events"]:
            records["timing"].extend(self.timing_records(event))
        for name in config["required_system_metrics"]:
            records["metric"].append({"type": "metric", "name": name, "value": 1.0})
        records["metric"].append({"type": "metric", "name": "arrival_rate_rps", "value": 1.0, "sample": {"basis": "source_fixture_arrival_intervals", "sourceMessageId": "00000000-0000-4000-8000-000000000002"}})
        result = module.validate_records(config, release, "current", records)
        self.assertEqual(result["overall"], "UNJUDGED")
        self.assertEqual(result["timing"]["ingestion"]["status"], "UNJUDGED_NO_THRESHOLD")
        self.assertEqual(result["system_metrics"]["locks"]["status"], "UNJUDGED_NO_THRESHOLD")

    def test_invalid_adapter_record_is_rejected(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        with self.assertRaises(module.HarnessBlocked):
            module.validate_records(config, release, "current", module.parse_records(json.dumps({"type": "timing", "event": "first_open", "duration_ms": -1}), "current"))

    def test_workload_and_fault_adapters_run_in_one_observation_window(self):
        workload, fault = module.run_adapters_concurrently(
            f'{sys.executable} -c "print(\\\"workload\\\")"',
            f'{sys.executable} -c "print(\\\"fault\\\")"',
            {**module.os.environ, "INBOX_STRESS_PROFILE": "current"},
        )
        self.assertEqual(workload.strip(), "workload")
        self.assertEqual(fault.strip(), "fault")

    def test_source_workload_and_fault_adapters_share_one_observation_window(self):
        workload, source, fault = module.run_adapters_concurrently(
            f'{sys.executable} -c "print(\\"workload\\")"',
            f'{sys.executable} -c "print(\\"fault\\")"',
            {**module.os.environ, "INBOX_STRESS_PROFILE": "current"},
            f'{sys.executable} -c "print(\\"source\\")"',
        )
        self.assertEqual(workload.strip(), "workload")
        self.assertEqual(source.strip(), "source")
        self.assertEqual(fault.strip(), "fault")

    def test_adapter_pipes_are_drained_concurrently_before_dependent_marker(self):
        # The fault child fills its stdout pipe before publishing the marker
        # the workload child needs. Sequential communicate() deadlocks here;
        # concurrent drains let the marker arrive and preserve one window.
        with tempfile.TemporaryDirectory() as directory:
            marker = Path(directory) / "fault-ready"
            fault_code = textwrap.dedent(
                """
                import pathlib, sys
                sys.stdout.write('x' * (1024 * 1024))
                sys.stdout.flush()
                pathlib.Path(sys.argv[1]).write_text('ready')
                print('fault-complete')
                """
            )
            workload_code = textwrap.dedent(
                """
                import pathlib, sys, time
                deadline = time.monotonic() + 2
                marker = pathlib.Path(sys.argv[1])
                while time.monotonic() < deadline and not marker.exists():
                    time.sleep(0.01)
                if not marker.exists():
                    raise SystemExit(7)
                print('workload-after-marker')
                """
            )
            command = lambda code: f"{shlex.quote(sys.executable)} -c {shlex.quote(code)} {shlex.quote(str(marker))}"
            workload, fault = module.run_adapters_concurrently(
                command(workload_code),
                command(fault_code),
                {**module.os.environ, "INBOX_STRESS_PROFILE": "current"},
            )
        self.assertIn("workload-after-marker", workload)
        self.assertIn("fault-complete", fault)

    def test_source_manifest_requires_absolute_path_and_observed_records(self):
        _config, target, _release = module.load_config(HERE / "stress-harness-config.json")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "source-manifest.json"
            manifest = {
                "schema_version": 1,
                "owner": "release-infra",
                "fixture_database": target["database"],
                "database_marker": target["database_marker"],
                "database_purpose": target["database_purpose"],
                "run_id": "run-1",
                "status": "observed",
                "schedule": {"message_count": 1, "message_bound": 1},
                "messages": [
                    {
                        "id": "00000000-0000-4000-8000-000000000001",
                        "status": "uncertain",
                    }
                ],
            }
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(module.HarnessBlocked, "cleanup_ids_retained"):
                module.validate_source_manifest(path, target)
            with self.assertRaises(module.HarnessBlocked):
                module.source_manifest_path("relative/source-manifest.json")

    def test_ingestion_evidence_must_bind_to_every_planned_source_id(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        source_manifest = {
            "path": "/tmp/source-manifest.json",
            "planned_ids": ["source-1", "source-2"],
        }
        records = {
            "timing": [
                {
                    "type": "timing",
                    "event": "ingestion",
                    "duration_ms": 2.0,
                    "sample": {
                        "boundary": "source_arrival_to_exact_projected_version",
                        "targetId": "target-1",
                        "sourceMessageId": "source-1",
                        "inboundRevision": 1,
                        "sourceCaptureGeneration": 1,
                        "arrivalAtMs": 1.0,
                        "observedAtMs": 3.0,
                        "projectedVersion": 1,
                    },
                }
            ],
            "metric": [],
            "recovery": [],
        }
        with self.assertRaisesRegex(module.HarnessBlocked, "source-2"):
            module.validate_records(config, release, "current", records, source_manifest)

    def test_release_evidence_binds_manifest_path_hash_and_cleanup_ids(self):
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
            "operator_arrival_rate": {"samples": 10, "p95_rps": 1.0, "status": "MEASURED", "basis": "operator_cycle_start_interval"},
            "system_metrics": {},
            "raw_samples": {"timing": [{"event": "first_open", "duration_ms": 1.0}], "metric": [], "recovery": []},
            "recovery": {"status": "MEASURED", "faults": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]},
        }
        manifest = {
            "path": "/tmp/source-manifest.json",
            "sha256": "a" * 64,
            "run_id": "run-1",
            "status": "observed",
            "planned_message_count": 1,
            "observed_message_count": 1,
            "planned_ids": ["source-1"],
            "observed_ids": ["source-1"],
            "cleanup_ids": ["source-1"],
        }
        evidence = module.release_evidence(target, release, validated, manifest)
        self.assertEqual(evidence["source_manifest"], manifest)
        self.assertEqual(evidence["raw_samples"]["timing"][0]["event"], "first_open")

    def test_measured_failure_is_not_erased_by_later_unjudged_event(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        records = {"timing": [], "metric": [], "recovery": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]}
        for event in config["required_timing_events"]:
            duration = 100000.0 if event == "first_open" else 1.0
            records["timing"].extend(self.timing_records(event, duration=duration))
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
            records["timing"].extend(self.timing_records(event))
        for name in config["required_system_metrics"]:
            records["metric"].append({"type": "metric", "name": name, "value": 1.0})
        result = module.validate_records(config, release, "current", records)
        self.assertEqual(result["arrival_rate"]["status"], "BLOCKED")
        self.assertEqual(result["overall"], "BLOCKED")

    def test_preexisting_row_cannot_be_reported_as_ingestion(self):
        config, _target, release = module.load_config(HERE / "stress-harness-config.json")
        config["profiles"]["current"] = {"arrival_rate_rps": 1, "concurrency": 1, "tenant_count": 1, "history_skew": 1}
        records = {"timing": [{"type": "timing", "event": "ingestion", "duration_ms": 2.0, "sample": {"boundary": "authenticated_workset_row_ready"}}], "metric": [], "recovery": []}
        with self.assertRaises(module.HarnessBlocked):
            module.validate_records(config, release, "current", records)

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
            "operator_arrival_rate": {"samples": 10, "p95_rps": 1.0, "status": "MEASURED", "basis": "operator_cycle_start_interval"},
            "system_metrics": {},
            "recovery": {"status": "MEASURED", "faults": [{"fault": "projection_restart", "recovered": True, "duration_ms": 12.0}]},
        }
        evidence = module.release_evidence(
            target,
            release,
            validated,
            {
                "path": "/tmp/source-manifest.json",
                "sha256": "a" * 64,
                "run_id": "run-1",
                "status": "observed",
                "planned_message_count": 1,
                "observed_message_count": 1,
                "planned_ids": ["source-1"],
                "observed_ids": ["source-1"],
                "cleanup_ids": ["source-1"],
            },
        )
        with tempfile.TemporaryDirectory() as directory:
            evidence_path = Path(directory) / "synthetic-evidence.json"
            evidence_path.write_text(json.dumps(evidence))
            status, detail, loaded = gate.validate_evidence_file(evidence_path, module.current_candidate_sha(), release["fixture_policy"])
        self.assertEqual(status, "PASS", detail)
        self.assertEqual(loaded, evidence)


if __name__ == "__main__":
    unittest.main()
