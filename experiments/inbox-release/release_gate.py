#!/usr/bin/env python3
"""Fail-closed package, acceptance, load and recovery release gate.

The default mode only runs read-only local compiler/unit checks. Installed
database checks are opt-in and require the separately owned release database.
This module intentionally treats absent evidence as a blocker; it never fills
in pass values from a template or from a prior run.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from typing import Any


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DEFAULT_MANIFEST = HERE / "release-manifest.json"
INSTALL = ROOT / "experiments" / "inbox-production-install"

FORBIDDEN_MARKERS = re.compile(
    r"(?:placeholder|synthetic[-_ ]pass|not[-_ ]run|unknown|todo|fake|invented)",
    re.IGNORECASE,
)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise GateError(f"missing JSON evidence: {path}")
    try:
        value = json.loads(path.read_text())
    except json.JSONDecodeError as exc:
        raise GateError(f"invalid JSON evidence {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise GateError(f"JSON evidence must be an object: {path}")
    return value


class GateError(RuntimeError):
    pass


def git_sha() -> str:
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode:
        raise GateError(f"cannot resolve candidate SHA: {result.stderr.strip()}")
    return result.stdout.strip()


def run_command(label: str, command: list[str], *, timeout: int = 180) -> dict[str, Any]:
    started = time.perf_counter()
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
        env=os.environ.copy(),
    )
    elapsed = (time.perf_counter() - started) * 1000
    return {
        "label": label,
        "command": command,
        "returncode": result.returncode,
        "duration_ms": round(elapsed, 3),
        "stdout_tail": result.stdout[-4000:],
        "stderr_tail": result.stderr[-4000:],
    }


def result(status: str, detail: str, **extra: Any) -> dict[str, Any]:
    return {"status": status, "detail": detail, **extra}


def validate_manifest(manifest: dict[str, Any]) -> None:
    if manifest.get("schema_version") != 1:
        raise GateError("unsupported release manifest schema")
    candidate = manifest.get("candidate")
    if not isinstance(candidate, dict):
        raise GateError("manifest candidate section is missing")
    if candidate.get("serving_enabled") is not False:
        raise GateError("release manifest must keep serving_enabled=false")
    if candidate.get("provider_traffic") != "forbidden":
        raise GateError("release manifest must forbid provider traffic")
    if candidate.get("deployment") != "forbidden":
        raise GateError("release manifest must forbid deployment")
    review = manifest.get("review_requirements")
    if review != {
        "exact_head_approval": "Opus 5",
        "reset_on_new_commit": True,
        "coordinator_gate_required": True,
    }:
        raise GateError("release requires exact-head Opus 5 approval and coordinator gate")
    required = manifest.get("required_gates")
    if not isinstance(required, list) or not required:
        raise GateError("manifest required_gates must be non-empty")
    policy = manifest.get("fixture_policy")
    if not isinstance(policy, dict):
        raise GateError("manifest fixture_policy is missing")
    for key in ("original_database", "release_database", "must_have_marker"):
        if not isinstance(policy.get(key), str) or not policy[key]:
            raise GateError(f"fixture policy missing {key}")
    if policy.get("must_not_reset_existing_database") is not True:
        raise GateError("fixture policy must prohibit reset of existing database")


def verify_source_manifest() -> dict[str, Any]:
    manifest_path = INSTALL / "source-manifest.json"
    source_manifest = load_json(manifest_path)
    mismatches: list[str] = []
    checked = 0
    for relative, expected in source_manifest.items():
        if not isinstance(relative, str) or not isinstance(expected, str):
            mismatches.append(f"invalid source-manifest entry: {relative!r}")
            continue
        path = INSTALL / relative
        if not path.is_file():
            mismatches.append(f"missing pinned source: {relative}")
            continue
        checked += 1
        actual = sha256(path)
        if actual != expected:
            mismatches.append(f"hash drift {relative}: expected {expected}, got {actual}")
    if mismatches:
        return result("FAIL", "source manifest drift", checked=checked, mismatches=mismatches)
    return result("PASS", "all source-manifest hashes match", checked=checked)


def verify_compiled_package() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    commands = [
        run_command(
            "compile production candidate",
            [sys.executable, str(INSTALL / "build.py")],
        ),
        run_command(
            "compile read/history companion",
            [sys.executable, str(INSTALL / "read-companion.py")],
        ),
    ]
    failed = [c for c in commands if c["returncode"] != 0]
    if failed:
        return result("FAIL", "candidate compiler failed", commands=commands), commands
    receipt_path = INSTALL / "generated" / "build-receipt.json"
    candidate_path = INSTALL / "generated" / "install-candidate.sql"
    companion_path = INSTALL / "generated" / "read-companion.sql"
    if not (receipt_path.is_file() and candidate_path.is_file() and companion_path.is_file()):
        return result("FAIL", "compiler did not emit complete package", commands=commands), commands
    receipt = load_json(receipt_path)
    if receipt.get("serving_enabled") is not False:
        return result("FAIL", "compiled package enables serving", commands=commands), commands
    if receipt.get("canonical_concurrent_indexes") != 7:
        return result("FAIL", "compiled package index count differs from reviewed candidate", commands=commands), commands
    return (
        result(
            "PASS",
            "candidate package rebuilt from pinned sources",
            commands=commands,
            install_candidate_sha256=sha256(candidate_path),
            read_companion_sha256=sha256(companion_path),
            build_receipt_sha256=sha256(receipt_path),
        ),
        commands,
    )


def run_service_checks() -> tuple[dict[str, Any], list[dict[str, Any]]]:
    commands = [
        run_command(
            "projection worker unit checks",
            [
                "node",
                "--test",
                "services/inbox-projection-worker/core.test.mjs",
                "services/inbox-projection-worker/server.test.mjs",
                "services/inbox-projection-worker/config.test.mjs",
            ],
            timeout=240,
        ),
        run_command(
            "sync relay unit checks",
            ["node", "--test", "services/inbox-sync-relay/server.test.mjs"],
            timeout=240,
        ),
    ]
    failed = [c for c in commands if c["returncode"] != 0]
    if failed:
        return result("FAIL", "service unit checks failed", commands=commands), commands
    return result("PASS", "projection worker and sync relay unit checks passed", commands=commands), commands


def validate_evidence_file(path: Path, candidate_sha: str, policy: dict[str, Any]) -> tuple[str, str, dict[str, Any] | None]:
    try:
        evidence = load_json(path)
    except GateError as exc:
        return "FAIL", str(exc), None
    serialized = json.dumps(evidence, sort_keys=True)
    if FORBIDDEN_MARKERS.search(serialized):
        return "FAIL", f"forbidden placeholder marker in evidence: {path}", evidence
    if str(evidence.get("status", "")).upper() != "PASS":
        return "BLOCKED", f"evidence is not PASS: {path}", evidence
    if evidence.get("candidate_sha") != candidate_sha:
        return "FAIL", f"candidate SHA mismatch in evidence: {path}", evidence
    identity = evidence.get("fixture")
    if not isinstance(identity, dict):
        return "FAIL", f"missing fixture identity in evidence: {path}", evidence
    if identity.get("database") != policy.get("release_database"):
        return "FAIL", f"evidence names the wrong release database: {path}", evidence
    if identity.get("marker") != policy.get("must_have_marker"):
        return "FAIL", f"evidence names the wrong fixture marker: {path}", evidence
    return "PASS", "verified evidence", evidence


def validate_measurements(
    evidence: dict[str, Any], budgets: dict[str, Any], *, tier: str
) -> tuple[str, str]:
    measurements = evidence.get("measurements")
    if not isinstance(measurements, dict):
        return "FAIL", f"{tier} evidence has no measurements"
    minimum = int(budgets.get("sample_minimum", 10))
    for metric, budget_key in (
        ("first_open", "first_open_p95_ms"),
        ("revisit", "revisit_p95_ms"),
        ("selection", "selection_p95_ms"),
    ):
        item = measurements.get(metric)
        if not isinstance(item, dict):
            return "FAIL", f"{tier} evidence missing {metric} measurement"
        samples = item.get("samples")
        p95 = item.get("p95_ms")
        p99 = item.get("p99_ms")
        if not isinstance(samples, int) or samples < minimum:
            return "FAIL", f"{tier} {metric} sample count is below {minimum}"
        if not isinstance(p95, (int, float)) or not math.isfinite(float(p95)):
            return "FAIL", f"{tier} {metric} p95 is not a finite measured value"
        if not isinstance(p99, (int, float)) or not math.isfinite(float(p99)):
            return "FAIL", f"{tier} {metric} p99 is not a finite measured value"
        target = budgets[budget_key]
        if float(p95) > float(target):
            return "FAIL", f"{tier} {metric} p95={p95}ms exceeds approved target {target}ms"
    cap = evidence.get("bulk_reply_recipient_cap")
    if cap != budgets.get("bulk_reply_recipient_cap"):
        return "FAIL", f"{tier} bulk reply cap is not the approved server cap"
    arrivals = evidence.get("arrival_rate")
    if not isinstance(arrivals, dict) or not isinstance(arrivals.get("samples"), int) or arrivals["samples"] <= 0:
        return "FAIL", f"{tier} evidence lacks a real sustained-arrival sample"
    return "PASS", f"{tier} measurements meet approved latency targets"


def check_evidence(
    evidence_dir: Path | None,
    candidate_sha: str,
    manifest: dict[str, Any],
) -> dict[str, Any]:
    policy = manifest["fixture_policy"]
    budgets = manifest["budgets"]
    required_files = {
        "current_volume_stress": "current-volume-stress.json",
        "three_x_volume_stress": "three-x-volume-stress.json",
        "worker_recovery": "worker-recovery.json",
        "relay_parity": "relay-parity.json",
        "rollback_receipt_read": "rollback-receipts.json",
    }
    if evidence_dir is None:
        return result("BLOCKED", "no evidence directory supplied; measurements and recovery are required")
    checks: dict[str, Any] = {}
    overall = "PASS"
    for gate, filename in required_files.items():
        path = evidence_dir / filename
        status, detail, evidence = validate_evidence_file(path, candidate_sha, policy)
        if status == "PASS" and evidence is not None and gate.endswith("stress"):
            tier = "current" if gate == "current_volume_stress" else "three_x"
            status, detail = validate_measurements(evidence, budgets, tier=tier)
        checks[gate] = {"status": status, "detail": detail, "path": str(path)}
        if status == "FAIL":
            overall = "FAIL"
        elif status == "BLOCKED" and overall == "PASS":
            overall = "BLOCKED"
    return result(overall, "required stress/recovery evidence evaluated", checks=checks)


def check_acceptance_matrix(candidate_sha: str) -> dict[str, Any]:
    matrix = ROOT / "docs" / "performance" / "inbox-redesign" / "acceptance-matrix.md"
    if not matrix.is_file():
        return result("FAIL", "acceptance matrix is missing")
    rows: list[dict[str, str]] = []
    for line in matrix.read_text().splitlines():
        if not line.startswith("|") or line.startswith("|---") or "ID" in line:
            continue
        parts = [part.strip() for part in line.strip().strip("|").split("|")]
        if len(parts) != 6 or not re.fullmatch(r"[A-Z][0-9]{2}", parts[0]):
            continue
        rows.append({"id": parts[0], "status": parts[4], "evidence": parts[5]})
    if not rows:
        return result("FAIL", "acceptance matrix contains no rows")
    blocked = [row for row in rows if row["status"].lower().startswith(("blocked", "not run", "fail"))]
    invalid_evidence = [
        row
        for row in rows
        if row["status"].lower().startswith("pass")
        and (row["evidence"] in {"Not run", ""} or not any(ROOT.joinpath(part).is_file() for part in re.findall(r"[A-Za-z0-9_./-]+", row["evidence"])))
    ]
    if blocked:
        return result(
            "BLOCKED",
            f"{len(blocked)} acceptance rows are blocked, not run, or failing",
            rows=len(rows),
            blocked_ids=[row["id"] for row in blocked],
            invalid_evidence=[row["id"] for row in invalid_evidence],
            candidate_sha=candidate_sha,
        )
    if invalid_evidence:
        return result("FAIL", "passing acceptance rows lack real artifacts", invalid_evidence=invalid_evidence)
    return result("PASS", "all acceptance rows have passing artifact-backed outcomes", rows=len(rows), candidate_sha=candidate_sha)


def installed_gate(run_installed: bool, manifest: dict[str, Any]) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    if not run_installed:
        return result("BLOCKED", "installed proof not requested; live catalog proof is required"), []
    policy = manifest["fixture_policy"]
    requested_database = os.environ.get("INBOX_RELEASE_DATABASE", "")
    if requested_database != policy["release_database"]:
        return result("BLOCKED", f"INBOX_RELEASE_DATABASE must equal {policy['release_database']}; refusing any other database"), []
    if os.environ.get("INBOX_RELEASE_FIXTURE_MARKER") != policy["must_have_marker"]:
        return result("BLOCKED", "release fixture marker was not explicitly confirmed"), []
    if os.environ.get("INBOX_RELEASE_SERVING_ENABLED", "false").lower() != "false":
        return result("FAIL", "release fixture reports serving enabled"), []
    commands = [
        run_command(
            "installed read companion verification",
            [sys.executable, str(INSTALL / "read-companion.py"), "--owned-fixture", "--verify-only"],
            timeout=600,
        ),
        run_command(
            "installed catalog verifier",
            [sys.executable, str(INSTALL / "verify.py"), "--installed"],
            timeout=600,
        ),
        run_command(
            "installed mutation harness",
            [sys.executable, str(INSTALL / "verify-mutation-harness.py"), "--owned-fixture"],
            timeout=900,
        ),
        run_command(
            "installed bounded worker rehearsal",
            [sys.executable, str(INSTALL / "worker-step.py"), "--owned-fixture", "--rounds", "10"],
            timeout=600,
        ),
        run_command(
            "installed canonical smoke rehearsal",
            [sys.executable, str(INSTALL / "smoke.py"), "--owned-fixture"],
            timeout=600,
        ),
    ]
    failed = [command for command in commands if command["returncode"] != 0]
    if failed:
        return result("FAIL", "installed catalog or mutation proof failed", commands=commands), commands
    return result("PASS", "installed catalog and mutation proof passed", commands=commands), commands


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument("--run-safe", action="store_true", help="run compiler and service unit checks")
    parser.add_argument("--run-installed", action="store_true", help="run opt-in checks on the release DB")
    parser.add_argument("--write", type=Path, required=True, help="write the JSON readiness packet")
    args = parser.parse_args()

    manifest = load_json(args.manifest)
    validate_manifest(manifest)
    candidate_sha = git_sha()
    results: dict[str, Any] = {}
    commands: list[dict[str, Any]] = []

    base_commit = manifest["candidate"]["base_commit"]
    base_check = run_command("candidate ancestry", ["git", "merge-base", "--is-ancestor", base_commit, "HEAD"])
    commands.append(base_check)
    results["candidate_identity"] = result(
        "PASS" if base_check["returncode"] == 0 else "FAIL",
        "candidate contains the reviewed base commit" if base_check["returncode"] == 0 else "candidate is missing reviewed base commit",
        sha=candidate_sha,
        reviewed_base=base_commit,
        command=base_check,
    )

    results["source_manifest"] = verify_source_manifest()
    if args.run_safe:
        package_result, package_commands = verify_compiled_package()
        service_result, service_commands = run_service_checks()
        results["candidate_package"] = package_result
        results["service_unit_checks"] = service_result
        commands.extend(package_commands + service_commands)
    else:
        results["candidate_package"] = result("BLOCKED", "safe checks not requested")
        results["service_unit_checks"] = result("BLOCKED", "safe checks not requested")

    installed_result, installed_commands = installed_gate(args.run_installed, manifest)
    results["installed_schema_exact"] = installed_result
    commands.extend(installed_commands)
    if args.run_installed:
        probe = run_command(
            "release database identity and rollback admission probe",
            [sys.executable, str(HERE / "release_db_probe.py")],
            timeout=90,
        )
        commands.append(probe)
        if probe["returncode"] == 0:
            results["rollback_admission"] = result("PASS", "release database identity and serving-disabled direct RPC proof passed", command=probe)
        elif probe["returncode"] == 3:
            results["rollback_admission"] = result("BLOCKED", "direct rollback proof passed but operation receipt wrappers are not installed", command=probe)
        else:
            results["rollback_admission"] = result("FAIL", "release database identity or rollback admission proof failed", command=probe)
    else:
        results["rollback_admission"] = result("BLOCKED", "release database probe not requested")
    # Keep the manifest key stable even though the implementation probe also
    # reports command-admission status; otherwise a required gate could be
    # accidentally omitted from the final status reduction.
    results["rollback_receipt_read"] = results["rollback_admission"]
    results["acceptance_matrix"] = check_acceptance_matrix(candidate_sha)
    evidence_result = check_evidence(args.evidence_dir, candidate_sha, manifest)
    results["evidence"] = evidence_result
    # Promote each evidence gate into the required-gate reduction.  Keeping
    # only the aggregate `evidence` result would silently omit current/3x
    # stress and recovery gates when the manifest names them individually.
    evidence_gates = (
        "current_volume_stress",
        "three_x_volume_stress",
        "worker_recovery",
        "relay_parity",
        "rollback_receipt_read",
    )
    evidence_checks = evidence_result.get("checks", {})
    for gate in evidence_gates:
        check = evidence_checks.get(gate)
        if isinstance(check, dict):
            results[gate] = result(check.get("status", "FAIL"), check.get("detail", "evidence gate evaluated"), path=check.get("path"))
        else:
            results[gate] = result("BLOCKED", "evidence gate was not evaluated by the aggregate checker")
    results["pilot_enablement"] = result("BLOCKED", "production deployment and pilot enablement are outside this harness")

    required = set(manifest["required_gates"])
    statuses = {
        key: value["status"]
        for key, value in results.items()
        if key in required or key in {"candidate_package", "service_unit_checks", "installed_schema_exact", "acceptance_matrix"}
    }
    failures = sorted(key for key, status in statuses.items() if status == "FAIL")
    blockers = sorted(key for key, status in statuses.items() if status == "BLOCKED")
    overall = "READY" if not failures and not blockers else ("FAIL" if failures else "BLOCKED")
    packet = {
        "schema_version": 1,
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "status": overall,
        "candidate_sha": candidate_sha,
        "manifest_sha256": sha256(args.manifest),
        "provider_traffic": "forbidden",
        "deployment": "forbidden",
        "results": results,
        "commands": commands,
        "failures": failures,
        "blockers": blockers,
    }
    args.write.parent.mkdir(parents=True, exist_ok=True)
    args.write.write_text(json.dumps(packet, indent=2) + "\n")
    print(json.dumps({"status": overall, "failures": failures, "blockers": blockers, "output": str(args.write)}, indent=2))
    return 0 if overall == "READY" else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (GateError, subprocess.TimeoutExpired) as exc:
        print(f"release gate error: {exc}", file=sys.stderr)
        raise SystemExit(2)
