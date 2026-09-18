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
from urllib.parse import urlparse


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


def run_command(label: str, command: list[str], *, timeout: int = 180, env_overrides: dict[str, str] | None = None) -> dict[str, Any]:
    started = time.perf_counter()
    command_env = os.environ.copy()
    if env_overrides:
        command_env.update(env_overrides)
    result = subprocess.run(
        command,
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
        env=command_env,
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


def git_source_bytes(repository: Path, commit: str, relative_path: str) -> bytes:
    try:
        return subprocess.check_output(
            ["git", "-C", str(repository), "show", f"{commit}:{relative_path}"],
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as exc:
        raise GateError(f"pinned source is unavailable: {repository}@{commit}:{relative_path}: {exc.output[-400:].decode(errors='replace')}") from exc


def verify_backend_source_content(manifest: dict[str, Any], packet: str) -> dict[str, Any]:
    """Verify every packet source against both the pinned commit and its worktree.

    The packet assembler uses ``git show`` intentionally.  This check makes a
    dirty source checkout fail closed as well, so a later build cannot consume
    content different from the reviewed hash while the manifest still looks
    internally consistent.
    """
    repository = Path(str(manifest.get("source_repository", "")))
    commit = str(manifest.get("source_commit", ""))
    if not repository.is_dir() or not commit:
        return result("FAIL", "backend packet source repository/commit is missing")
    try:
        resolved = subprocess.check_output(
            ["git", "-C", str(repository), "rev-parse", f"{commit}^{{commit}}"],
            text=True,
            stderr=subprocess.STDOUT,
        ).strip()
    except subprocess.CalledProcessError as exc:
        return result("FAIL", f"backend packet source commit cannot be resolved: {exc.output.strip()}")
    if resolved != commit:
        return result("FAIL", "backend packet source commit is not exact", expected=commit, actual=resolved)
    mismatches: list[str] = []
    checked = 0
    packet_markers = set(re.findall(r"-- source_sha256=([0-9a-f]{64})", packet))
    for group in ("sql_sources", "runtime_sources"):
        entries = manifest.get(group)
        if not isinstance(entries, list):
            return result("FAIL", f"backend packet {group} inventory is missing")
        for entry in entries:
            if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) or not re.fullmatch(r"[0-9a-f]{64}", str(entry.get("sha256", ""))):
                mismatches.append(f"invalid {group} entry")
                continue
            path = entry["path"]
            expected = entry["sha256"]
            try:
                pinned = git_source_bytes(repository, commit, path)
            except GateError as exc:
                mismatches.append(str(exc))
                continue
            checked += 1
            pinned_hash = hashlib.sha256(pinned).hexdigest()
            if pinned_hash != expected:
                mismatches.append(f"{group}:{path}: pinned hash {pinned_hash} != manifest {expected}")
                continue
            worktree_path = repository / path
            if not worktree_path.is_file():
                mismatches.append(f"{group}:{path}: source worktree file is missing")
            elif sha256(worktree_path) != expected:
                mismatches.append(f"{group}:{path}: source worktree content drifted from reviewed hash")
            if group == "sql_sources" and expected not in packet_markers:
                mismatches.append(f"{group}:{path}: generated packet omits its source hash marker")
    if mismatches:
        return result("FAIL", "backend packet source content drift", checked=checked, mismatches=mismatches)
    return result("PASS", "all backend SQL/runtime sources match pinned commit and clean source worktree", checked=checked, source_commit=commit)


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


def verify_backend_packet() -> dict[str, Any]:
    """Verify the exact-source operation/reply packet without installing it."""
    manifest_path = HERE / "backend-operation-reply-manifest.json"
    try:
        manifest = load_json(manifest_path)
    except GateError as exc:
        return result("FAIL", str(exc))
    if manifest.get("schema_version") != 2 or manifest.get("status") != "PENDING_REVIEW_NO_INSTALL":
        return result("FAIL", "backend packet must remain explicitly pending review")
    packet_info = manifest.get("sql_packet")
    if not isinstance(packet_info, dict):
        return result("FAIL", "backend packet has no generated SQL receipt")
    packet = ROOT / str(packet_info.get("path", ""))
    if not packet.is_file():
        return result("FAIL", f"generated backend packet is missing: {packet}")
    actual_hash = sha256(packet)
    if actual_hash != packet_info.get("sha256"):
        return result("FAIL", "generated backend packet hash drift", expected=packet_info.get("sha256"), actual=actual_hash)
    sql = packet.read_text()
    source_content = verify_backend_source_content(manifest, sql)
    if source_content["status"] != "PASS":
        return source_content
    required = (
        "admit_command('action_prepare')",
        "admit_command('action_accept')",
        "admit_command('action_saved_read')",
        "admit_command('action_saved_write')",
        "admit_command('reply_prepare')",
        "admit_command('reply_accept')",
        "current_database()<>'postgres'",
        "install_fixture.identity",
    )
    missing = [needle for needle in required if needle not in sql]
    if missing:
        return result("FAIL", "backend packet is missing required guarded transforms", missing=missing)
    if "inbox_t2_" in sql or "inbox_fixture.identity" in sql:
        return result("FAIL", "backend packet retains historical fixture references")
    recovery = re.search(r"CREATE FUNCTION inbox_reply_send\.recover\([^$]+?AS \$\$(.*?)(?:\$\$;)", sql, re.S)
    if recovery is None or "require_admission" in recovery.group(1):
        return result("FAIL", "reply recovery is still admission-gated")
    sources = manifest.get("sql_sources")
    runtime = manifest.get("runtime_sources")
    if not isinstance(sources, list) or len(sources) != 26 or not isinstance(runtime, list) or len(runtime) != 15:
        return result("FAIL", "backend packet source inventory is incomplete", sql_sources=len(sources or []), runtime_sources=len(runtime or []))
    source_names = {item.get("name") for item in sources if isinstance(item, dict)}
    required_source_names = {"saved_actions_setup", "saved_actions_public_api", "saved_actions_prepare_reference"}
    if not required_source_names.issubset(source_names):
        return result("FAIL", "saved-action source packet is incomplete", missing=sorted(required_source_names - source_names))
    runtime_names = {item.get("name") for item in runtime if isinstance(item, dict)}
    if "reply_worker_lock" not in runtime_names:
        return result("FAIL", "reply worker package lock is not pinned in the runtime packet")
    if any(isinstance(item, dict) and item.get("local_overlay") for item in runtime):
        return result("FAIL", "runtime packet contains an unreviewed working-tree overlay")
    return result(
        "PASS",
        "exact backend operation/reply packet and source content hashes verified",
        packet_sha256=actual_hash,
        sql_sources=len(sources),
        runtime_sources=len(runtime),
        source_content=source_content,
    )


def verify_execution_stack_manifest() -> dict[str, Any]:
    """Check that every executable service has a pinned source and role order.

    This is intentionally a manifest check, not a build claim.  The current
    worker images are still unbuilt; the exact source commit and all role
    packets must be present before a later build can produce evidence.
    """
    path = HERE / "execution-stack-manifest.json"
    try:
        manifest = load_json(path)
    except GateError as exc:
        return result("FAIL", str(exc))
    services = manifest.get("services")
    source_repository = Path(str(manifest.get("source_repository", "")))
    source_commit = str(manifest.get("source_commit", ""))
    if not source_repository.is_dir() or not source_commit:
        return result("FAIL", "execution stack source repository/commit is missing")
    try:
        resolved_source_commit = subprocess.check_output(
            ["git", "-C", str(source_repository), "rev-parse", f"{source_commit}^{{commit}}"],
            text=True,
            stderr=subprocess.STDOUT,
        ).strip()
    except subprocess.CalledProcessError as exc:
        return result("FAIL", f"execution stack source commit cannot be resolved: {exc.output.strip()}")
    if resolved_source_commit != source_commit:
        return result("FAIL", "execution stack source commit is not exact", expected=source_commit, actual=resolved_source_commit)
    try:
        backend_manifest = load_json(HERE / "backend-operation-reply-manifest.json")
    except GateError as exc:
        return result("FAIL", f"backend operation/reply manifest is unavailable: {exc}")
    backend_source_commit = str(backend_manifest.get("source_commit", ""))
    if backend_source_commit != source_commit:
        return result(
            "FAIL",
            "execution stack and backend packet source commits differ",
            execution_source_commit=source_commit,
            backend_source_commit=backend_source_commit,
        )
    backend_repository = Path(str(backend_manifest.get("source_repository", "")))
    if not backend_repository.is_dir() or backend_repository.resolve() != source_repository.resolve():
        return result(
            "FAIL",
            "execution stack and backend packet source repositories differ",
            execution_source_repository=str(source_repository),
            backend_source_repository=str(backend_repository),
        )
    source_paths = {
        "operation-worker": {
            "Dockerfile": "experiments/inbox-operation-worker/Dockerfile",
            "package.json": "experiments/inbox-operation-worker/package.json",
            "package-lock.json": "experiments/inbox-operation-worker/package-lock.json",
            "core.mjs": "experiments/inbox-operation-worker/core.mjs",
            "server.mjs": "experiments/inbox-operation-worker/server.mjs",
        },
        "reply-send-worker": {
            "Dockerfile": "experiments/inbox-reply-send-worker/Dockerfile",
            "package.json": "experiments/inbox-reply-send-worker/package.json",
            "package-lock.json": "experiments/inbox-reply-send-worker/package-lock.json",
            "core.mjs": "experiments/inbox-reply-send-worker/core.mjs",
            "runner.mjs": "experiments/inbox-reply-send-worker/runner.mjs",
            "server.mjs": "experiments/inbox-reply-send-worker/server.mjs",
            "vendor/reply-provider.mjs": "experiments/inbox-reply-send-worker/vendor/reply-provider.mjs",
            "vendor/test-transport.mjs": "experiments/inbox-reply-send-worker/vendor/test-transport.mjs",
            "worker-role.sql": "experiments/inbox-reply-send-worker/worker-role.sql",
            "worker.sql": "experiments/inbox-reply-send-worker/worker.sql",
        },
        "sync-relay": {
            "Dockerfile": "services/inbox-sync-relay/Dockerfile",
            "server.mjs": "services/inbox-sync-relay/server.mjs",
            "railway.json": "services/inbox-sync-relay/railway.json",
        },
        "projection-worker": {
            "Dockerfile": "services/inbox-projection-worker/Dockerfile",
            "package.json": "services/inbox-projection-worker/package.json",
            "package-lock.json": "services/inbox-projection-worker/package-lock.json",
            "core.mjs": "services/inbox-projection-worker/core.mjs",
            "config.mjs": "services/inbox-projection-worker/config.mjs",
            "server.mjs": "services/inbox-projection-worker/server.mjs",
            "worker-role.sql": "services/inbox-projection-worker/worker-role.sql",
            "config.test.mjs": "services/inbox-projection-worker/config.test.mjs",
        },
    }
    source_drift: list[str] = []
    source_checked = 0
    for service_name, paths in source_paths.items():
        service = services.get(service_name) if isinstance(services, dict) else None
        if not isinstance(service, dict):
            return result("FAIL", f"execution stack service is missing: {service_name}")
        if service.get("source_commit") != source_commit:
            source_drift.append(f"{service_name}: source_commit does not match execution stack source")
        for field, relative in paths.items():
            expected = service.get(field)
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                source_drift.append(f"{service_name}:{field}: missing content hash")
                continue
            try:
                pinned = git_source_bytes(source_repository, source_commit, relative)
            except GateError as exc:
                source_drift.append(str(exc))
                continue
            source_checked += 1
            if hashlib.sha256(pinned).hexdigest() != expected:
                source_drift.append(f"{service_name}:{relative}: pinned content drift")
            worktree = source_repository / relative
            if not worktree.is_file() or sha256(worktree) != expected:
                source_drift.append(f"{service_name}:{relative}: source worktree content drift")
    if source_drift:
        return result("FAIL", "execution stack source content drift", checked=source_checked, mismatches=source_drift)
    overlay_paths = {
        "operation-worker": {
            "core.mjs": "experiments/inbox-operation-worker/core.mjs",
            "core.test.mjs": "experiments/inbox-operation-worker/core.test.mjs",
        },
        "reply-send-worker": {
            "core.mjs": "experiments/inbox-reply-send-worker/core.mjs",
            "core.test.mjs": "experiments/inbox-reply-send-worker/core.test.mjs",
        },
        "projection-worker": {
            "config.mjs": "services/inbox-projection-worker/config.mjs",
            "config.test.mjs": "services/inbox-projection-worker/config.test.mjs",
        },
    }
    overlay_drift: list[str] = []
    for service_name, paths in overlay_paths.items():
        service = services.get(service_name)
        overlay = service.get("release_http_fixture_profile_overlay") if isinstance(service, dict) else None
        if not isinstance(overlay, dict):
            overlay_drift.append(f"{service_name}: release HTTP fixture profile overlay is missing")
            continue
        for field, relative in paths.items():
            expected = overlay.get(field)
            if not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                overlay_drift.append(f"{service_name}: overlay {field} hash is missing")
                continue
            try:
                pinned = git_source_bytes(source_repository, source_commit, relative)
            except GateError as exc:
                overlay_drift.append(str(exc))
                continue
            if hashlib.sha256(pinned).hexdigest() != expected:
                overlay_drift.append(f"{service_name}:{relative}: overlay pinned content drift")
            worktree = source_repository / relative
            if not worktree.is_file() or sha256(worktree) != expected:
                overlay_drift.append(f"{service_name}:{relative}: overlay source worktree content drifted")
    if overlay_drift:
        return result("FAIL", "execution stack fixture overlay content drift", checked=source_checked, mismatches=overlay_drift)
    runtime_services = manifest.get("runtime_definition", {}).get("services")
    if not isinstance(runtime_services, dict):
        return result("FAIL", "execution stack runtime service definitions are missing")
    expected_tag = f"release-{source_commit[:7]}"
    tag_drift: list[str] = []
    for service_name in ("operation-worker", "reply-send-worker", "projection-worker", "relay"):
        service = runtime_services.get(service_name)
        image = service.get("image") if isinstance(service, dict) else None
        image_without_digest = image.split("@", 1)[0] if isinstance(image, str) else ""
        actual_tag = image_without_digest.rsplit(":", 1)[-1] if ":" in image_without_digest else ""
        if actual_tag != expected_tag:
            tag_drift.append(f"{service_name}: expected image tag {expected_tag}, got {actual_tag or '<missing>'}")
    if tag_drift:
        return result("FAIL", "execution stack service image tags do not match source commit", mismatches=tag_drift)
    projection = services.get("projection-worker") if isinstance(services, dict) else None
    if not isinstance(projection, dict):
        return result("FAIL", "execution stack has no pinned projection worker")
    required_files = (
        "Dockerfile",
        "package.json",
        "package-lock.json",
        "core.mjs",
        "config.mjs",
        "server.mjs",
        "worker-role.sql",
        "config.test.mjs",
    )
    invalid = [
        name
        for name in required_files
        if not isinstance(projection.get(name), str) or not re.fullmatch(r"[0-9a-f]{64}", projection[name])
    ]
    if invalid:
        return result("FAIL", "projection worker source hashes are incomplete", missing=invalid)
    overlay = projection.get("release_http_fixture_profile_overlay")
    if not isinstance(overlay, dict) or overlay.get("target") != "127.0.0.1:54322/postgres" or overlay.get("database_marker") != "sandra-inbox-http-owned-synthetic-20260917" or overlay.get("container_label_marker") != "sandra-inbox-release-http-owned-20260917" or overlay.get("login") != "inbox_projection_worker":
        return result("FAIL", "projection worker fixture profile is not pinned to the owned target")
    order = manifest.get("database_role_install_order")
    if not isinstance(order, list):
        return result("FAIL", "database role install order is missing")
    projection_order = next((entry for entry in order if isinstance(entry, dict) and entry.get("service") == "projection-worker"), None)
    if not isinstance(projection_order, dict) or projection_order.get("source") != "services/inbox-projection-worker/worker-role.sql" or projection_order.get("sha256") != projection["worker-role.sql"]:
        return result("FAIL", "projection worker role packet is not pinned in install order")
    role_packet_path = ROOT / str(projection_order.get("packet", ""))
    if not role_packet_path.is_file() or sha256(role_packet_path) != projection_order.get("packet_sha256"):
        return result("FAIL", "projection worker executable role packet is missing or hash-drifted")
    role_packet = role_packet_path.read_text()
    if "current_database()<>'postgres'" not in role_packet or "marker='sandra-inbox-http-owned-synthetic-20260917'" not in role_packet or "CREATE ROLE inbox_projection_worker" not in role_packet or "inbox_t2_" in role_packet:
        return result("FAIL", "projection worker role packet is not release-guarded")
    backend = backend_manifest
    backend_roles = {entry.get("path"): entry.get("sha256") for entry in backend.get("sql_sources", []) if isinstance(entry, dict)}
    for entry in order:
        if not isinstance(entry, dict) or entry.get("service") not in {"operation-worker", "reply-send-worker"}:
            continue
        if entry.get("sha256") != backend_roles.get(entry.get("source")):
            return result("FAIL", f"{entry.get('service')} role hash is not tied to the backend packet")
    electric_order = next((entry for entry in order if isinstance(entry, dict) and entry.get("service") == "electric"), None)
    if not isinstance(electric_order, dict):
        return result("FAIL", "Electric role/publication packet is missing from install order")
    electric_source = ROOT / str(electric_order.get("source", ""))
    if not electric_source.is_file() or sha256(electric_source) != electric_order.get("sha256"):
        return result("FAIL", "Electric role/publication packet is missing or hash-drifted")
    electric_sql = electric_source.read_text()
    for needle in (
        "current_database()",
        "sandra-inbox-http-owned-synthetic-20260917",
        "CREATE ROLE inbox_electric_replication",
        "REPLICATION",
        "GRANT SELECT ON TABLE inbox_bridge.summaries",
        "REPLICA IDENTITY FULL",
        "CREATE PUBLICATION electric_publication_inbox_release_20260917",
    ):
        if needle not in electric_sql:
            return result("FAIL", f"Electric packet is missing required guarded operation: {needle}")
    if "sandra_inbox_install_20260913" in electric_sql or "inbox_t2_" in electric_sql:
        return result("FAIL", "Electric packet retains historical fixture references")
    registration = manifest.get("runtime_definition", {}).get("restate_registration")
    if not isinstance(registration, dict):
        return result("FAIL", "Restate registration procedure is missing")
    registration_path = ROOT / str(registration.get("helper", ""))
    if not registration_path.is_file() or sha256(registration_path) != registration.get("sha256"):
        return result("FAIL", "Restate registration helper is missing or hash-drifted")
    registration_source = registration_path.read_text()
    for needle in ("--register-owned-runtime", "INBOX_RELEASE_ALLOW_RUNTIME_MUTATION", "http://127.0.0.1:9070/deployments", "http://127.0.0.1:9080", "http://127.0.0.1:9081"):
        if needle not in registration_source:
            return result("FAIL", f"Restate registration helper is missing required guard/procedure: {needle}")
    bounds = manifest.get("resource_bounds")
    if not isinstance(bounds, dict) or bounds.get("projection_worker_memory_bytes") != 268435456 or bounds.get("projection_worker_cpus") != 0.25:
        return result("FAIL", "projection worker resource bounds are missing")
    return result("PASS", "projection worker source, role packet, fixture profile, and bounds are pinned", source_commit=projection.get("source_commit"), role_sha256=projection["worker-role.sql"])


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
    auth_upgrade_path = INSTALL / "generated" / "auth-upgrade.sql"
    if not auth_upgrade_path.is_file():
        return result("FAIL", "canonical authorization forward upgrade is missing", commands=commands), commands
    auth_upgrade = auth_upgrade_path.read_text()
    if re.search(r"\bCREATE\s+(?:SCHEMA|TABLE)\b", auth_upgrade, re.IGNORECASE) or "CREATE OR REPLACE FUNCTION inbox_bridge.authorize" not in auth_upgrade:
        return result("FAIL", "canonical authorization forward upgrade is not OR REPLACE-only", commands=commands), commands
    if "sandra_inbox_release_20260917" not in auth_upgrade or "sandra-inbox-release-owned-synthetic" not in auth_upgrade or "current_database()='postgres'" not in auth_upgrade or "sandra-inbox-http-owned-synthetic-20260917" not in auth_upgrade:
        return result("FAIL", "canonical authorization forward upgrade lacks exact target identities", commands=commands), commands
    upgrade_paths = [
        INSTALL / "generated" / "read-upgrade-current.sql",
        INSTALL / "generated" / "read-upgrade-workset-updates.sql",
        INSTALL / "generated" / "read-upgrade-selection-review.sql",
    ]
    for upgrade_path in upgrade_paths:
        if not upgrade_path.is_file():
            return result("FAIL", "existing-schema read upgrade packet is missing", path=str(upgrade_path), commands=commands), commands
        upgrade = upgrade_path.read_text()
        if re.search(r"\bCREATE\s+(?:SCHEMA|TABLE)\b", upgrade, re.IGNORECASE):
            return result("FAIL", "existing-schema read upgrade replays fresh-install DDL", path=str(upgrade_path), commands=commands), commands
        if not re.search(r"\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b", upgrade, re.IGNORECASE):
            return result("FAIL", "existing-schema read upgrade has no replaceable function body", path=str(upgrade_path), commands=commands), commands
        if "current_database()<>'sandra_inbox_release_20260917'" not in upgrade or "marker='sandra-inbox-release-owned-synthetic'" not in upgrade:
            return result("FAIL", "default read upgrade is not guarded to the release rehearsal identity", path=str(upgrade_path), commands=commands), commands
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
    allowed_identities = {(policy.get("release_database"), policy.get("must_have_marker"))}
    http_fixture = policy.get("http_fixture")
    if isinstance(http_fixture, dict):
        database_url = http_fixture.get("database")
        database_name = urlparse(database_url).path.lstrip("/") if isinstance(database_url, str) else ""
        if database_name and http_fixture.get("database_marker"):
            allowed_identities.add((database_name, http_fixture["database_marker"]))
    if (identity.get("database"), identity.get("marker")) not in allowed_identities:
        return "FAIL", f"evidence names an unapproved fixture identity: {path}", evidence
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


def reduce_gate_statuses(results: dict[str, Any], required: list[str]) -> dict[str, str]:
    """Return every decisive status, including checks outside required_gates.

    ``required_gates`` is a contract inventory, not a permission to hide a
    failed prerequisite.  Candidate identity, source-manifest integrity and
    the live rollback probe must remain decisive even if an older manifest
    omitted one of those names.
    """
    decisive = set(required) | {
        "candidate_identity",
        "source_manifest",
        "candidate_package",
        "service_unit_checks",
        "backend_packet",
        "execution_stack",
        "installed_schema_exact",
        "acceptance_matrix",
        "rollback_admission",
        "rollback_receipt_read",
        "release_database_identity",
    }
    return {
        key: value["status"]
        for key, value in results.items()
        if key in decisive and isinstance(value, dict) and isinstance(value.get("status"), str)
    }


def authoritative_rollback_gate(live_probe: dict[str, Any]) -> dict[str, Any]:
    """Keep the live HTTP command/receipt probe authoritative over evidence files."""
    return live_probe


def check_acceptance_matrix(candidate_sha: str) -> dict[str, Any]:
    matrix = ROOT / "docs" / "performance" / "inbox-redesign" / "acceptance-matrix.md"
    if not matrix.is_file():
        return result("FAIL", "acceptance matrix is missing")
    matrix_text = matrix.read_text()
    marker = re.search(r"<!-- acceptance-run candidate_sha: ([0-9a-f]{40}) -->", matrix_text)
    if marker is None:
        return result("BLOCKED", "acceptance matrix is not bound to a candidate SHA")
    if marker.group(1) != candidate_sha:
        return result("BLOCKED", "acceptance matrix candidate SHA does not match HEAD", matrix_candidate_sha=marker.group(1), candidate_sha=candidate_sha)
    rows: list[dict[str, str]] = []
    for line in matrix_text.splitlines():
        if not line.startswith("|") or line.startswith("|---") or line.startswith("| ID |"):
            continue
        parts = [part.strip() for part in line.strip().strip("|").split("|")]
        if len(parts) != 6 or not re.fullmatch(r"[A-Z][0-9]{2}", parts[0]):
            continue
        rows.append({"id": parts[0], "status": parts[4], "evidence": parts[5]})
    if not rows:
        return result("FAIL", "acceptance matrix contains no rows")
    results_file = ROOT / "test-results" / "inbox-acceptance-results.json"
    if not results_file.is_file():
        return result("BLOCKED", "acceptance run result artifact is missing")
    try:
        run_results = load_json(results_file)
    except GateError as exc:
        return result("FAIL", f"acceptance run result artifact is invalid: {exc}")
    if not isinstance(run_results, dict) or run_results.get("candidate_sha") != candidate_sha:
        return result("BLOCKED", "acceptance run result artifact is not bound to HEAD", candidate_sha=candidate_sha)
    if not isinstance(run_results.get("rows"), list):
        return result("FAIL", "acceptance run result artifact has no rows")
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
        backend_result = verify_backend_packet()
        results["candidate_package"] = package_result
        results["service_unit_checks"] = service_result
        results["backend_packet"] = backend_result
        results["execution_stack"] = verify_execution_stack_manifest()
        commands.extend(package_commands + service_commands)
    else:
        results["candidate_package"] = result("BLOCKED", "safe checks not requested")
        results["service_unit_checks"] = result("BLOCKED", "safe checks not requested")
        results["backend_packet"] = result("BLOCKED", "safe checks not requested")
        results["execution_stack"] = result("BLOCKED", "safe checks not requested")

    installed_result, installed_commands = installed_gate(args.run_installed, manifest)
    results["installed_schema_exact"] = installed_result
    commands.extend(installed_commands)
    if args.run_installed:
        release_probe = run_command(
            "release database identity and read rollback probe",
            [sys.executable, str(HERE / "release_db_probe.py")],
            timeout=90,
        )
        commands.append(release_probe)
        if release_probe["returncode"] in (0, 3) and f'"database": "{manifest["fixture_policy"]["release_database"]}"' in release_probe["stdout_tail"] and '"direct_read_rpc": "INBOX_NOT_READY"' in release_probe["stdout_tail"]:
            results["release_database_identity"] = result("PASS", "release database identity and read rollback proof passed", command=release_probe)
        else:
            results["release_database_identity"] = result("FAIL", "release database identity or read rollback proof failed", command=release_probe)

        http_probe = run_command(
            "HTTP runtime command and receipt rollback probe",
            [sys.executable, str(HERE / "release_db_probe.py")],
            timeout=90,
            env_overrides={
                "INBOX_RELEASE_PROBE_TARGET": "http",
                "INBOX_RELEASE_HTTP_DATABASE_MARKER": manifest["fixture_policy"]["http_fixture"]["database_marker"],
            },
        )
        commands.append(http_probe)
        if http_probe["returncode"] == 0:
            results["rollback_admission"] = result("PASS", "HTTP runtime command admission and receipt rollback proof passed", command=http_probe)
        elif http_probe["returncode"] == 3:
            results["rollback_admission"] = result("BLOCKED", "HTTP runtime rollback probe reached the fixture but reviewed command wrappers are not installed", command=http_probe)
        else:
            results["rollback_admission"] = result("FAIL", "HTTP runtime command admission or receipt rollback proof failed", command=http_probe)
    else:
        results["rollback_admission"] = result("BLOCKED", "owned rollback probes not requested")
    # Keep the live HTTP command/receipt probe authoritative. Evidence files
    # can document a separately reproduced fixture check, but they must never
    # turn an unrun or failed live probe into a pass.
    results["rollback_receipt_read"] = authoritative_rollback_gate(results["rollback_admission"])
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
            evidence_result_key = "rollback_receipt_evidence" if gate == "rollback_receipt_read" else gate
            results[evidence_result_key] = result(check.get("status", "FAIL"), check.get("detail", "evidence gate evaluated"), path=check.get("path"))
        else:
            evidence_result_key = "rollback_receipt_evidence" if gate == "rollback_receipt_read" else gate
            results[evidence_result_key] = result("BLOCKED", "evidence gate was not evaluated by the aggregate checker")
    results["pilot_enablement"] = result("BLOCKED", "production deployment and pilot enablement are outside this harness")

    statuses = reduce_gate_statuses(results, manifest["required_gates"])
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
