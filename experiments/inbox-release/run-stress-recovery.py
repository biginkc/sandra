#!/usr/bin/env python3
"""Run the bounded current/3x Inbox workload and recovery adapters.

This is an execution harness, not a result fixture.  It refuses to run without
an explicit profile, an independently probed owned target, and two adapter
commands that emit measured JSONL.  Missing workload dimensions, system
thresholds, or recovery observations remain unjudged and cannot become a
release pass by omission.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_CONFIG = ROOT / "experiments/inbox-release/stress-harness-config.json"


class HarnessBlocked(RuntimeError):
    pass


# Keep the worst observed state when combining independent measurements.  A
# later event with no approved threshold must not erase a measured failure
# from an earlier event (the old last-write-wins assignment did exactly that).
STATUS_RANK = {
    "MEASURED": 0,
    "UNJUDGED": 1,
    "BLOCKED": 2,
    "FAIL": 3,
}


def merge_status(current: str, candidate: str) -> str:
    if candidate not in STATUS_RANK:
        raise HarnessBlocked(f"unknown aggregate status: {candidate}")
    if current not in STATUS_RANK:
        raise HarnessBlocked(f"unknown aggregate status: {current}")
    return candidate if STATUS_RANK[candidate] > STATUS_RANK[current] else current


def read_json(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise HarnessBlocked(f"cannot read JSON manifest: {path}") from exc
    if not isinstance(value, dict):
        raise HarnessBlocked(f"JSON manifest must be an object: {path}")
    return value


def positive_number(value: Any, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise HarnessBlocked(f"missing or invalid positive profile dimension: {label}")
    return float(value)


def load_config(path: Path) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    config = read_json(path)
    target_path = (ROOT / config["target_manifest"]).resolve()
    target = read_json(target_path)
    release = read_json(ROOT / "experiments/inbox-release/release-manifest.json")
    identity = config.get("target_identity")
    if not isinstance(identity, dict):
        raise HarnessBlocked("target identity contract is missing")
    expected = {
        "owner": target.get("owner"),
        "container_label_marker": target.get("marker"),
        "database_marker": target.get("database_marker"),
        "database_purpose": target.get("database_purpose"),
    }
    for key, value in expected.items():
        if not value or identity.get(key) != value:
            raise HarnessBlocked(f"target identity mismatch: {key}")
    if identity.get("provider_traffic") is not False or identity.get("customer_sends") is not False:
        raise HarnessBlocked("provider traffic and customer sends must be forbidden")
    if target.get("provider_traffic") != "forbidden" or target.get("safety", {}).get("new_spending") is not False:
        raise HarnessBlocked("target manifest is not a no-provider/no-spending fixture")
    return config, target, release


def profile_dimensions(config: dict[str, Any], name: str) -> dict[str, float]:
    profile = config.get("profiles", {}).get(name)
    if not isinstance(profile, dict):
        raise HarnessBlocked(f"profile is missing: {name}")
    dimensions = {}
    for key in ("arrival_rate_rps", "concurrency", "tenant_count", "history_skew"):
        dimensions[key] = positive_number(profile.get(key), f"{name}.{key}")
    return dimensions


def percentile(values: list[float], fraction: float) -> float:
    if not values:
        raise HarnessBlocked("cannot calculate percentile without samples")
    ordered = sorted(values)
    position = (len(ordered) - 1) * fraction
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def parse_records(output: str, profile: str) -> dict[str, list[dict[str, Any]]]:
    records: dict[str, list[dict[str, Any]]] = {"timing": [], "metric": [], "recovery": []}
    for line_number, line in enumerate(output.splitlines(), 1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            raise HarnessBlocked(f"adapter emitted non-JSONL output at line {line_number}") from exc
        if not isinstance(record, dict) or record.get("profile", profile) != profile:
            raise HarnessBlocked(f"adapter emitted an invalid or cross-profile record at line {line_number}")
        kind = record.get("type")
        if kind not in records:
            raise HarnessBlocked(f"adapter emitted unknown record type at line {line_number}: {kind!r}")
        records[kind].append(record)
    if not any(records.values()):
        raise HarnessBlocked("adapters emitted no measurements")
    return records


def run_adapter(command: str, env: dict[str, str], label: str) -> str:
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise HarnessBlocked(f"invalid {label} command") from exc
    if not argv:
        raise HarnessBlocked(f"{label} command is empty")
    completed = subprocess.run(argv, cwd=ROOT, env=env, capture_output=True, text=True, timeout=3600)
    if completed.returncode != 0:
        detail = completed.stderr.strip()[-1000:]
        raise HarnessBlocked(f"{label} command failed with {completed.returncode}: {detail}")
    return completed.stdout


def validate_records(config: dict[str, Any], release: dict[str, Any], profile: str, records: dict[str, list[dict[str, Any]]]) -> dict[str, Any]:
    required_timing = config["required_timing_events"]
    required_metrics = config["required_system_metrics"]
    by_event: dict[str, list[float]] = {event: [] for event in required_timing}
    for record in records["timing"]:
        event = record.get("event")
        value = record.get("duration_ms")
        if event not in by_event or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise HarnessBlocked(f"invalid timing record for {event!r}")
        by_event[event].append(float(value))
    min_samples = int(release.get("budgets", {}).get("sample_minimum", 0))
    timing: dict[str, Any] = {}
    timing_status = "MEASURED"
    for event, values in by_event.items():
        if not values:
            timing[event] = {"status": "MISSING", "sample_count": 0}
            timing_status = merge_status(timing_status, "BLOCKED")
            continue
        stats: dict[str, Any] = {"status": "MEASURED", "sample_count": len(values), "p95_ms": percentile(values, .95), "p99_ms": percentile(values, .99)}
        budget_key = f"{event}_p95_ms"
        budget = release.get("budgets", {}).get(budget_key)
        if event in {"first_open", "revisit", "selection"} and isinstance(budget, (int, float)):
            stats["threshold_p95_ms"] = budget
            stats["exceedances_p95"] = sum(value > budget for value in values)
            if len(values) < min_samples:
                stats["status"] = "INSUFFICIENT_SAMPLES"
                timing_status = merge_status(timing_status, "BLOCKED")
            elif stats["p95_ms"] > budget:
                stats["status"] = "FAIL"
                timing_status = merge_status(timing_status, "FAIL")
        else:
            stats["status"] = "UNJUDGED_NO_THRESHOLD"
            timing_status = merge_status(timing_status, "UNJUDGED")
        timing[event] = stats

    metrics: dict[str, Any] = {}
    metric_status = "MEASURED"
    for name in required_metrics:
        values = []
        for record in records["metric"]:
            if record.get("name") != name:
                continue
            value = record.get("value")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
                raise HarnessBlocked(f"invalid system metric: {name}")
            values.append(float(value))
        metrics[name] = {"sample_count": len(values), "p95": percentile(values, .95) if values else None, "status": "UNJUDGED_NO_THRESHOLD" if values else "MISSING"}
        metric_status = merge_status(metric_status, "UNJUDGED" if values else "BLOCKED")

    recovery = []
    for record in records["recovery"]:
        if not isinstance(record.get("fault"), str) or not record["fault"] or record.get("recovered") is not True:
            raise HarnessBlocked("recovery adapter must report recovered=true for every injected fault")
        duration = record.get("duration_ms")
        if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration <= 0:
            raise HarnessBlocked("recovery record needs a positive duration_ms")
        recovery.append({"fault": record["fault"], "recovered": True, "duration_ms": duration})
    recovery_status = "MEASURED" if recovery else "BLOCKED"
    aggregate_status = "MEASURED"
    for status in (timing_status, metric_status, recovery_status):
        aggregate_status = merge_status(aggregate_status, status)
    overall = {0: "PASS", 1: "UNJUDGED", 2: "BLOCKED", 3: "FAIL"}[STATUS_RANK[aggregate_status]]
    return {"profile": profile, "profile_dimensions": profile_dimensions(config, profile), "overall": overall, "timing": timing, "system_metrics": metrics, "recovery": {"status": recovery_status, "faults": recovery}}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--profile", choices=("current", "three_x"))
    parser.add_argument("--workload-command", help="adapter command emitting timing and metric JSONL")
    parser.add_argument("--fault-command", help="adapter command injecting owned faults and emitting recovery JSONL")
    parser.add_argument("--evidence-out", type=Path)
    parser.add_argument("--validate-config", action="store_true")
    args = parser.parse_args()
    try:
        config, target, release = load_config(args.config.resolve())
        if args.validate_config:
            missing = []
            for profile in ("current", "three_x"):
                for key in ("arrival_rate_rps", "concurrency", "tenant_count", "history_skew"):
                    if config.get("profiles", {}).get(profile, {}).get(key) is None:
                        missing.append(f"{profile}.{key}")
            print(json.dumps({"status": "BLOCKED_UNJUDGED", "missing_profile_dimensions": missing, "target": target["marker"]}, sort_keys=True))
            return 2 if missing else 0
        if not args.profile or not args.workload_command or not args.fault_command:
            raise HarnessBlocked("--run requires --profile, --workload-command, and --fault-command")
        dimensions = profile_dimensions(config, args.profile)
        if os.environ.get("INBOX_RELEASE_TARGET_PROBED") != "true":
            raise HarnessBlocked("independent owned-target probe evidence is required")
        if os.environ.get("INBOX_RELEASE_TARGET_CONTAINER_MARKER") != target["marker"] or os.environ.get("INBOX_RELEASE_TARGET_DATABASE_MARKER") != target["database_marker"]:
            raise HarnessBlocked("target probe markers do not match the checked-in container/database identities")
        if os.environ.get("INBOX_RELEASE_PROVIDER_TRAFFIC", "false") != "false":
            raise HarnessBlocked("provider traffic must remain disabled")
        adapter_env = os.environ.copy()
        adapter_env.update({"INBOX_NO_PROVIDER": "1", "INBOX_STRESS_PROFILE": args.profile, "INBOX_STRESS_TARGET_API": target["endpoints"]["supabase_url"], **{f"INBOX_STRESS_{key.upper()}": str(value) for key, value in dimensions.items()}})
        workload = parse_records(run_adapter(args.workload_command, adapter_env, "workload"), args.profile)
        fault = parse_records(run_adapter(args.fault_command, adapter_env, "fault"), args.profile)
        for kind in ("timing", "metric"):
            workload[kind].extend(fault[kind])
        workload["recovery"].extend(fault["recovery"])
        result = {"schema_version": 1, "target_marker": target["marker"], "database_marker": target["database_marker"], "captured_at_unix": time.time(), **validate_records(config, release, args.profile, workload)}
        if args.evidence_out:
            args.evidence_out.parent.mkdir(parents=True, exist_ok=True)
            args.evidence_out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["overall"] == "PASS" else 2
    except HarnessBlocked as exc:
        print(json.dumps({"status": "BLOCKED", "reason": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
