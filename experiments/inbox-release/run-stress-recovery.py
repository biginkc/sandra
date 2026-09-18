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
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
import math
import os
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
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


def source_manifest_path(value: str) -> Path:
    if not isinstance(value, str) or not value.strip():
        raise HarnessBlocked("source ID manifest path is required")
    path = Path(value)
    if not path.is_absolute():
        raise HarnessBlocked("source ID manifest path must be absolute")
    return path


def _manifest_cleanup_ids(path: Path) -> list[str]:
    """Best-effort ID extraction used only to retain cleanup context on failure."""
    try:
        value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    messages = value.get("messages") if isinstance(value, dict) else None
    if not isinstance(messages, list):
        return []
    return [
        message["id"]
        for message in messages
        if isinstance(message, dict) and isinstance(message.get("id"), str) and message["id"].strip()
    ]


def _source_manifest_blocked(path: Path, reason: str, cleanup_ids: list[str] | None = None) -> HarnessBlocked:
    ids = cleanup_ids if cleanup_ids is not None else _manifest_cleanup_ids(path)
    retained = json.dumps(ids, separators=(",", ":"))
    return HarnessBlocked(
        f"source manifest blocked: {reason}; cleanup_ids_retained={retained}; manifest={path}"
    )


def validate_source_manifest(path: Path, target: dict[str, Any]) -> dict[str, Any]:
    """Validate the durable source artifact and return its evidence binding."""
    if not path.is_absolute():
        raise _source_manifest_blocked(path, "manifest path must be absolute", [])
    if not path.is_file():
        raise _source_manifest_blocked(path, "manifest was not produced", [])
    try:
        manifest = read_json(path)
    except HarnessBlocked as exc:
        raise _source_manifest_blocked(path, str(exc)) from exc
    cleanup_ids = _manifest_cleanup_ids(path)
    expected = {
        "owner": "release-infra",
        "fixture_database": target.get("database"),
        "database_marker": target.get("database_marker"),
        "database_purpose": target.get("database_purpose"),
    }
    for key, value in expected.items():
        if manifest.get(key) != value:
            raise _source_manifest_blocked(path, f"manifest identity mismatch: {key}", cleanup_ids)
    if manifest.get("schema_version") != 1 or not isinstance(manifest.get("run_id"), str) or not manifest["run_id"].strip():
        raise _source_manifest_blocked(path, "manifest schema or run_id is invalid", cleanup_ids)
    if manifest.get("status") != "observed":
        raise _source_manifest_blocked(path, f"manifest status is {manifest.get('status')!r}", cleanup_ids)
    messages = manifest.get("messages")
    schedule = manifest.get("schedule")
    if not isinstance(messages, list) or not isinstance(schedule, dict):
        raise _source_manifest_blocked(path, "manifest messages or schedule is missing", cleanup_ids)
    count = schedule.get("message_count")
    bound = schedule.get("message_bound")
    if isinstance(count, bool) or not isinstance(count, int) or count <= 0 or isinstance(bound, bool) or not isinstance(bound, int) or bound < count or len(messages) != count:
        raise _source_manifest_blocked(path, "manifest message count/bound is incomplete", cleanup_ids)
    if len(set(cleanup_ids)) != len(cleanup_ids) or len(cleanup_ids) != count:
        raise _source_manifest_blocked(path, "manifest message IDs are missing or duplicated", cleanup_ids)
    observed_ids: list[str] = []
    for message in messages:
        if not isinstance(message, dict) or message.get("status") != "observed":
            raise _source_manifest_blocked(path, "manifest contains uncertain or incomplete source records", cleanup_ids)
        if any(
            isinstance(message.get(key), bool)
            or not isinstance(message.get(key), int)
            or message[key] <= 0
            for key in ("inboundRevision", "sourceCaptureGeneration", "projectedVersion")
        ):
            raise _source_manifest_blocked(path, "observed source record lacks durable projection identities", cleanup_ids)
        observed_ids.append(message["id"])
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        "path": str(path),
        "sha256": digest,
        "run_id": manifest["run_id"],
        "status": manifest["status"],
        "planned_message_count": count,
        "observed_message_count": len(observed_ids),
        "planned_ids": cleanup_ids,
        "observed_ids": observed_ids,
        # Keep every planned ID for bounded post-run cleanup/reconciliation.
        "cleanup_ids": cleanup_ids,
    }


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


def run_adapters_concurrently(workload_command: str, fault_command: str, env: dict[str, str], source_command: str | None = None) -> tuple[str, str] | tuple[str, str, str]:
    """Run workload, source fixture, and fault/resource adapters together."""
    commands = []
    requested = [(workload_command, "workload")]
    if source_command is not None:
        requested.append((source_command, "source-arrival"))
    requested.append((fault_command, "fault"))
    for command, label in requested:
        try:
            argv = shlex.split(command)
        except ValueError as exc:
            raise HarnessBlocked(f"invalid {label} command") from exc
        if not argv:
            raise HarnessBlocked(f"{label} command is empty")
        commands.append((argv, label))

    processes = []
    executor: ThreadPoolExecutor | None = None
    try:
        for argv, label in commands:
            processes.append((subprocess.Popen(argv, cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True), label))
        # Every child must be drained while the others run.  Waiting on the
        # workload first can leave a source/fault child blocked on its pipe's
        # finite buffer, which in turn changes the observation window and can
        # deadlock a child that is waiting for a marker from the blocked one.
        executor = ThreadPoolExecutor(max_workers=len(processes), thread_name_prefix="stress-drain")
        futures = {
            executor.submit(process.communicate, timeout=3600): (process, label)
            for process, label in processes
        }
        outputs_by_label: dict[str, str] = {}
        for future, (_process, label) in futures.items():
            try:
                stdout, stderr = future.result()
            except subprocess.TimeoutExpired as exc:
                raise HarnessBlocked(f"{label} command exceeded the one-hour bound") from exc
            process = next(process for process, process_label in processes if process_label == label)
            if process.returncode != 0:
                detail = stderr.strip()[-1000:]
                raise HarnessBlocked(f"{label} command failed with {process.returncode}: {detail}")
            outputs_by_label[label] = stdout
        outputs = [outputs_by_label[label] for _process, label in processes]
        if source_command is None:
            return outputs[0], outputs[1]
        return outputs[0], outputs[1], outputs[2]
    finally:
        for process, _label in processes:
            if process.poll() is None:
                process.kill()
        if executor is not None:
            executor.shutdown(wait=True, cancel_futures=True)
        for process, _label in processes:
            if process.poll() is None:
                process.communicate()


def current_candidate_sha() -> str:
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True, stderr=subprocess.STDOUT).strip()
    except subprocess.CalledProcessError as exc:
        raise HarnessBlocked(f"cannot resolve candidate SHA: {exc.output.strip()}") from exc


def validate_records(
    config: dict[str, Any],
    release: dict[str, Any],
    profile: str,
    records: dict[str, list[dict[str, Any]]],
    source_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    required_timing = config["required_timing_events"]
    required_metrics = config["required_system_metrics"]
    by_event: dict[str, list[float]] = {event: [] for event in required_timing}
    planned_source_ids = set(source_manifest.get("planned_ids", ())) if source_manifest else set()
    observed_source_ids: list[str] = []
    for record in records["timing"]:
        event = record.get("event")
        value = record.get("duration_ms")
        if event not in by_event or isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise HarnessBlocked(f"invalid timing record for {event!r}")
        if event == "ingestion":
            sample = record.get("sample")
            if not isinstance(sample, dict) or sample.get("boundary") != "source_arrival_to_exact_projected_version":
                raise HarnessBlocked("ingestion timing must identify source arrival and the exact projected version")
            for key in ("targetId", "sourceMessageId"):
                if not isinstance(sample.get(key), str) or not sample[key].strip():
                    raise HarnessBlocked(f"ingestion timing is missing {key}")
            if source_manifest is not None:
                source_message_id = sample["sourceMessageId"]
                if source_message_id not in planned_source_ids:
                    raise HarnessBlocked(f"ingestion timing references an unplanned source ID: {source_message_id}")
                if source_message_id in observed_source_ids:
                    raise HarnessBlocked(f"ingestion timing duplicates source ID: {source_message_id}")
                observed_source_ids.append(source_message_id)
            inbound_revision = sample.get("inboundRevision")
            if not isinstance(inbound_revision, int) or isinstance(inbound_revision, bool) or inbound_revision <= 0:
                raise HarnessBlocked("ingestion timing needs the positive server-owned inbound revision identity")
            source_capture_generation = sample.get("sourceCaptureGeneration")
            if not isinstance(source_capture_generation, int) or isinstance(source_capture_generation, bool) or source_capture_generation <= 0:
                raise HarnessBlocked("ingestion timing needs the positive post-commit source capture generation")
            arrival_at = sample.get("arrivalAtMs")
            observed_at = sample.get("observedAtMs")
            version = sample.get("projectedVersion")
            if any(isinstance(item, bool) or not isinstance(item, (int, float)) or not math.isfinite(item) for item in (arrival_at, observed_at)):
                raise HarnessBlocked("ingestion timing needs finite source arrival and projection observation timestamps")
            if observed_at <= arrival_at or not isinstance(version, int) or isinstance(version, bool) or version <= 0:
                raise HarnessBlocked("ingestion timing needs a delayed observation at a positive projected version")
            if not math.isclose(float(value), float(observed_at - arrival_at), rel_tol=0, abs_tol=1e-6):
                raise HarnessBlocked("ingestion timing duration does not match source arrival to projection observation")
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

    metric_values: dict[str, list[float]] = {}
    for record in records["metric"]:
        name = record.get("name")
        if name not in set(required_metrics) | {"arrival_rate_rps", "operator_arrival_rate_rps"}:
            raise HarnessBlocked(f"unknown system metric: {name}")
        if name == "arrival_rate_rps":
            sample = record.get("sample")
            if not isinstance(sample, dict) or sample.get("basis") != "source_fixture_arrival_intervals" or not isinstance(sample.get("sourceMessageId"), str) or not sample["sourceMessageId"].strip():
                raise HarnessBlocked("source arrival rate must identify source-fixture arrival intervals")
            if source_manifest is not None and sample["sourceMessageId"] not in planned_source_ids:
                raise HarnessBlocked("source arrival rate references an unplanned source ID")
        value = record.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value < 0:
            raise HarnessBlocked(f"invalid system metric: {name}")
        metric_values.setdefault(name, []).append(float(value))

    metrics: dict[str, Any] = {}
    metric_status = "MEASURED"
    for name in required_metrics:
        values = metric_values.get(name, [])
        metrics[name] = {"sample_count": len(values), "p95": percentile(values, .95) if values else None, "status": "UNJUDGED_NO_THRESHOLD" if values else "MISSING"}
        metric_status = merge_status(metric_status, "UNJUDGED" if values else "BLOCKED")

    arrival_values = metric_values.get("arrival_rate_rps", [])
    arrival_status = "MEASURED" if arrival_values else "BLOCKED"
    arrival_rate = {
        "samples": len(arrival_values),
        "p95_rps": percentile(arrival_values, .95) if arrival_values else None,
        "status": arrival_status,
    }
    operator_arrival_values = metric_values.get("operator_arrival_rate_rps", [])
    operator_arrival_rate = {
        "samples": len(operator_arrival_values),
        "p95_rps": percentile(operator_arrival_values, .95) if operator_arrival_values else None,
        "status": "MEASURED" if operator_arrival_values else "MISSING",
        "basis": "operator_cycle_start_interval",
    }

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
    for status in (timing_status, metric_status, arrival_status, recovery_status):
        aggregate_status = merge_status(aggregate_status, status)
    if source_manifest is not None and set(observed_source_ids) != planned_source_ids:
        missing = sorted(planned_source_ids - set(observed_source_ids))
        raise HarnessBlocked(
            "source manifest is incomplete in timing evidence; "
            f"missing source IDs are retained in {source_manifest['path']}: {','.join(missing)}"
        )
    overall = {0: "PASS", 1: "UNJUDGED", 2: "BLOCKED", 3: "FAIL"}[STATUS_RANK[aggregate_status]]
    return {"profile": profile, "profile_dimensions": profile_dimensions(config, profile), "overall": overall, "timing": timing, "system_metrics": metrics, "arrival_rate": arrival_rate, "operator_arrival_rate": operator_arrival_rate, "recovery": {"status": recovery_status, "faults": recovery}}


def release_evidence(
    target: dict[str, Any],
    release: dict[str, Any],
    validated: dict[str, Any],
    source_manifest: dict[str, Any],
) -> dict[str, Any]:
    """Adapt measured runner output to the release gate's evidence contract."""
    measurements: dict[str, Any] = {}
    for event in ("first_open", "revisit", "selection"):
        stats = validated["timing"].get(event, {})
        measurements[event] = {
            "samples": stats.get("sample_count", 0),
            "p95_ms": stats.get("p95_ms"),
            "p99_ms": stats.get("p99_ms"),
            "status": stats.get("status", "MISSING"),
        }
    policy = release["fixture_policy"]
    return {
        "schema_version": 1,
        "status": validated["overall"],
        "candidate_sha": current_candidate_sha(),
        "fixture": {"database": target["database"], "marker": target["database_marker"]},
        "profile": validated["profile"],
        "profile_dimensions": validated["profile_dimensions"],
        "measurements": measurements,
        "bulk_reply_recipient_cap": release["budgets"]["bulk_reply_recipient_cap"],
        "arrival_rate": validated["arrival_rate"],
        "operator_arrival_rate": validated["operator_arrival_rate"],
        "system_metrics": validated["system_metrics"],
        "recovery": validated["recovery"],
        "source_manifest": source_manifest,
        "target_marker": target["marker"],
        "database_marker": target["database_marker"],
        "captured_at_unix": time.time(),
        "provider_traffic": policy["http_fixture"].get("provider_traffic", "forbidden"),
        "customer_sends": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    parser.add_argument("--profile", choices=("current", "three_x"))
    parser.add_argument("--workload-command", help="adapter command emitting timing and metric JSONL")
    parser.add_argument("--source-arrival-command", help="owned source-fixture adapter command emitting source arrival/projection JSONL")
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
        if not args.profile or not args.workload_command or not args.source_arrival_command or not args.fault_command:
            raise HarnessBlocked("--run requires --profile, --workload-command, --source-arrival-command, and --fault-command")
        if os.environ.get("INBOX_RELEASE_SOURCE_FIXTURE_ENABLED") != "1":
            raise HarnessBlocked("source-arrival measurement requires explicit INBOX_RELEASE_SOURCE_FIXTURE_ENABLED=1")
        source_manifest = os.environ.get("INBOX_RELEASE_SOURCE_ID_MANIFEST")
        if not source_manifest:
            raise HarnessBlocked("source-arrival measurement requires INBOX_RELEASE_SOURCE_ID_MANIFEST")
        source_manifest_file = source_manifest_path(source_manifest)
        if source_manifest_file.exists():
            raise _source_manifest_blocked(source_manifest_file, "manifest already exists before the run")
        dimensions = profile_dimensions(config, args.profile)
        if os.environ.get("INBOX_RELEASE_TARGET_PROBED") != "true":
            raise HarnessBlocked("independent owned-target probe evidence is required")
        if os.environ.get("INBOX_RELEASE_TARGET_CONTAINER_MARKER") != target["marker"] or os.environ.get("INBOX_RELEASE_TARGET_DATABASE_MARKER") != target["database_marker"]:
            raise HarnessBlocked("target probe markers do not match the checked-in container/database identities")
        if os.environ.get("INBOX_RELEASE_TARGET_DATABASE_PURPOSE") != target["database_purpose"]:
            raise HarnessBlocked("target probe database purpose does not match the checked-in fixture identity")
        if os.environ.get("INBOX_RELEASE_PROVIDER_TRAFFIC", "false") != "false":
            raise HarnessBlocked("provider traffic must remain disabled")
        sampling = config.get("resource_sampling")
        if not isinstance(sampling, dict):
            raise HarnessBlocked("resource sampling contract is missing")
        interval_ms = positive_number(sampling.get("interval_ms"), "resource_sampling.interval_ms")
        window_ms = positive_number(sampling.get("window_ms"), "resource_sampling.window_ms")
        if window_ms < interval_ms:
            raise HarnessBlocked("resource sampling window must contain at least one interval")
        adapter_env = os.environ.copy()
        adapter_env.update({"INBOX_NO_PROVIDER": "1", "INBOX_STRESS_PROFILE": args.profile, "INBOX_STRESS_TARGET_API": target["endpoints"]["supabase_url"], "INBOX_RELEASE_FIXTURE_API_URL": target["endpoints"]["supabase_url"], "INBOX_RELEASE_TARGET_DATABASE_PURPOSE": target["database_purpose"], **{f"INBOX_STRESS_{key.upper()}": str(value) for key, value in dimensions.items()}})
        adapter_env.update({
            "INBOX_RELEASE_FULL_RUNTIME": "1",
            "INBOX_RELEASE_SOURCE_FIXTURE_ENABLED": "1",
            "INBOX_RELEASE_SOURCE_ID_MANIFEST": str(source_manifest_file),
            "INBOX_RELEASE_RESOURCE_SAMPLE_INTERVAL_MS": str(interval_ms),
            "INBOX_RELEASE_RESOURCE_SAMPLE_WINDOW_MS": str(window_ms),
        })
        ready_fd, ready_path = tempfile.mkstemp(prefix=f"sandra-inbox-release-{args.profile}-", suffix=".workload-ready")
        os.close(ready_fd)
        os.unlink(ready_path)
        adapter_env["INBOX_RELEASE_WORKLOAD_READY_FILE"] = ready_path
        try:
            try:
                workload_output, source_output, fault_output = run_adapters_concurrently(args.workload_command, args.fault_command, adapter_env, args.source_arrival_command)
            except HarnessBlocked as exc:
                raise HarnessBlocked(
                    f"{exc}; source manifest retained at {source_manifest_file}; "
                    f"cleanup_ids_retained={json.dumps(_manifest_cleanup_ids(source_manifest_file), separators=(',', ':'))}"
                ) from exc
        finally:
            try:
                os.unlink(ready_path)
            except FileNotFoundError:
                pass
        workload = parse_records(workload_output, args.profile)
        source = parse_records(source_output, args.profile)
        fault = parse_records(fault_output, args.profile)
        source_artifact = validate_source_manifest(source_manifest_file, target)
        for kind in ("timing", "metric"):
            workload[kind].extend(source[kind])
            workload[kind].extend(fault[kind])
        workload["recovery"].extend(fault["recovery"])
        validated = validate_records(config, release, args.profile, workload, source_artifact)
        result = release_evidence(target, release, validated, source_artifact)
        if args.evidence_out:
            args.evidence_out.parent.mkdir(parents=True, exist_ok=True)
            args.evidence_out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0 if result["status"] == "PASS" else 2
    except HarnessBlocked as exc:
        print(json.dumps({"status": "BLOCKED", "reason": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
