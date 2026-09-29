"""Validate immutable run records from committed Git blobs only."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import ntpath
from pathlib import Path
import posixpath
import re
import subprocess

ROOT = "docs/performance/inbox-redesign/evidence"
TIERS = {"pre-merge", "test-env", "prod-deploy"}
SHA = re.compile(r"[0-9a-f]{40}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")


class EvidenceError(RuntimeError):
    pass


def unique_object_pairs(pairs: list[tuple[str, object]]) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def parse_manifest(repo: Path, commit: str, path: str) -> dict:
    try:
        return json.loads(blob(repo, commit, path), object_pairs_hook=unique_object_pairs)
    except (ValueError, UnicodeDecodeError) as exc:
        raise EvidenceError(f"invalid manifest: {path}: {exc}") from exc


def git(repo: Path, *args: str) -> bytes:
    proc = subprocess.run(["git", *args], cwd=repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if proc.returncode:
        raise EvidenceError(f"git {' '.join(args)}: {proc.stderr.decode(errors='replace').strip()}")
    return proc.stdout


def blob(repo: Path, commit: str, path: str) -> bytes:
    return git(repo, "show", f"{commit}:{path}")


def check_run_modes(repo: Path, commit: str, directory: str, added_paths: set[str]) -> None:
    """Require every committed run entry to be a regular Git blob."""
    entries = git(repo, "ls-tree", "-r", "-z", commit, "--", directory)
    tree_paths: set[str] = set()
    for entry in entries.split(b"\0"):
        if not entry:
            continue
        metadata, path = entry.split(b"\t", 1)
        mode, kind, _ = metadata.split(b" ", 2)
        name = path.decode("utf-8", errors="surrogateescape")
        tree_paths.add(name)
        if mode not in (b"100644", b"100755") or kind != b"blob":
            raise EvidenceError(f"non-regular evidence entry: {name} (mode {mode.decode()})")
    if tree_paths != added_paths:
        raise EvidenceError(f"run tree differs from added paths: {directory}")


def timestamp(value: object) -> datetime:
    if not isinstance(value, str) or not value:
        raise EvidenceError("missing or invalid completed_at")
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise EvidenceError("invalid completed_at") from exc
    if result.tzinfo is None:
        raise EvidenceError("completed_at lacks timezone")
    return result


def validate_manifest(repo: Path, commit: str, directory: str, paths: set[str], tested_sha: str) -> dict:
    parts = directory.split("/")
    if len(parts) != 7 or "/".join(parts[:4]) != ROOT or parts[4] != tested_sha or parts[5] not in TIERS or not re.fullmatch(r"[A-Za-z0-9_-]+", parts[6]):
        raise EvidenceError(f"run filed under wrong SHA or malformed run directory: {directory}")
    # ROOT has four components, followed by SHA, tier and run ID.
    manifest_path = f"{directory}/manifest.json"
    if manifest_path not in paths:
        raise EvidenceError(f"incomplete run: missing manifest at {directory}")
    manifest = parse_manifest(repo, commit, manifest_path)
    if not isinstance(manifest, dict) or manifest.get("tested_sha") != tested_sha or manifest.get("tier") != parts[5] or manifest.get("run_id") != parts[6]:
        raise EvidenceError(f"manifest identity mismatch: {directory}")
    completed = timestamp(manifest.get("completed_at"))
    if timestamp(manifest.get("started_at")) > completed:
        raise EvidenceError(f"completed_at precedes started_at: {directory}")
    if not HASH.fullmatch(str(manifest.get("runner_script_sha256", ""))) or not HASH.fullmatch(str(manifest.get("fault_proxy_script_sha256", ""))):
        raise EvidenceError(f"missing runner/proxy hashes: {directory}")
    clean = manifest.get("clean_tree")
    if not isinstance(clean, dict) or clean.get("start") is not True or clean.get("end_excluding_run_dir") is not True or clean.get("excluded_path") != directory:
        raise EvidenceError(f"invalid collection clean-tree attestation: {directory}")
    artifacts = manifest.get("artifacts")
    if not isinstance(artifacts, dict) or not artifacts:
        raise EvidenceError(f"missing artifact hashes: {directory}")
    normalized_paths: set[str] = set()
    for relative, expected in artifacts.items():
        if (not isinstance(relative, str) or relative in ("", ".") or posixpath.isabs(relative)
                or ntpath.isabs(relative) or ".." in relative or "\\" in relative
                or posixpath.normpath(relative) != relative
                or relative in normalized_paths or not HASH.fullmatch(str(expected))):
            raise EvidenceError(f"invalid artifact entry: {directory}/{relative}")
        normalized_paths.add(relative)
    actual_paths = {p.removeprefix(directory + "/") for p in paths if p != manifest_path}
    if normalized_paths != actual_paths:
        raise EvidenceError(f"artifact inventory mismatch: {directory}")
    for relative, expected in artifacts.items():
        observed = hashlib.sha256(blob(repo, commit, f"{directory}/{relative}")).hexdigest()
        if observed != expected:
            raise EvidenceError(f"artifact hash mismatch: {directory}/{relative}")
    if type(manifest.get("exit_status")) is not int:
        raise EvidenceError(f"missing numeric exit_status: {directory}")
    return {"directory": directory, "tier": parts[5], "commit": commit, "completed_at": completed.isoformat(), "exit_status": manifest.get("exit_status"), "manifest": manifest}


def evaluate(repo: Path, tested_sha: str, tier: str | None = None, head: str = "HEAD") -> dict:
    repo = Path(repo)
    if not SHA.fullmatch(tested_sha):
        raise EvidenceError("tested SHA must be a full 40-character commit SHA")
    if tier is not None and tier not in TIERS:
        raise EvidenceError(f"unknown tier: {tier}")
    if git(repo, "status", "--porcelain", "--untracked-files=all").strip():
        raise EvidenceError("working tree and index must be fully clean at evaluation")
    head_sha = git(repo, "rev-parse", f"{head}^{{commit}}").decode().strip()
    candidate = git(repo, "rev-parse", f"{tested_sha}^{{commit}}").decode().strip()
    if candidate != tested_sha:
        raise EvidenceError("tested SHA does not resolve exactly")
    if subprocess.run(["git", "merge-base", "--is-ancestor", tested_sha, head_sha], cwd=repo).returncode:
        raise EvidenceError(f"tested SHA {tested_sha} is not an ancestor of HEAD {head_sha}")
    commits = git(repo, "rev-list", "--reverse", "--topo-order", f"{tested_sha}..{head_sha}").decode().splitlines()
    seen_paths: set[str] = set()
    sealed_dirs: set[str] = set()
    runs: list[dict] = []
    last_commit_completed: datetime | None = None
    for commit in commits:
        parents = git(repo, "rev-list", "--parents", "-n", "1", commit).decode().split()
        if len(parents) != 2:
            raise EvidenceError(f"merge/root commit in evidence chain: {commit}")
        changes = git(repo, "diff-tree", "--no-commit-id", "--name-status", "-r", parents[1], commit).decode().splitlines()
        if not changes:
            raise EvidenceError(f"empty evidence commit: {commit}")
        added_by_dir: dict[str, set[str]] = {}
        for line in changes:
            status, *names = line.split("\t")
            path = names[-1] if names else ""
            if status != "A" or not path.startswith(ROOT + "/"):
                raise EvidenceError(f"evidence commit has non-addition or non-evidence path: {commit} {line}")
            if path in seen_paths:
                raise EvidenceError(f"record path touched twice: {path}")
            parts = path.split("/")
            if len(parts) < 8:
                raise EvidenceError(f"malformed evidence path: {path}")
            directory = "/".join(parts[:7])
            if directory in sealed_dirs:
                raise EvidenceError(f"addition inside already sealed run dir: {path}")
            added_by_dir.setdefault(directory, set()).add(path)
            seen_paths.add(path)
        tiers_in_commit: set[str] = set()
        commit_completed: list[datetime] = []
        for directory, paths in added_by_dir.items():
            check_run_modes(repo, commit, directory, paths)
            run = validate_manifest(repo, commit, directory, paths, tested_sha)
            if run["tier"] in tiers_in_commit:
                raise EvidenceError(f"ambiguous same-commit run ordering for {run['tier']}: {commit}")
            tiers_in_commit.add(run["tier"])
            completed = timestamp(run["completed_at"])
            if last_commit_completed is not None and completed < last_commit_completed:
                raise EvidenceError(f"completed_at is non-monotonic at {directory}")
            commit_completed.append(completed)
            sealed_dirs.add(directory)
            runs.append(run)
        if commit_completed:
            last_commit_completed = max(commit_completed)
    selected: dict[str, dict] = {}
    for run in runs:
        selected[run["tier"]] = run
    required = [tier] if tier else sorted(TIERS)
    if not any(t in selected for t in required):
        raise EvidenceError(f"no sealed run for tested SHA {tested_sha} and tier {tier or 'any'}")
    failures = [f"latest {t} run failed: {selected[t]['directory']}" for t in required if t in selected and selected[t]["exit_status"] != 0]
    if failures:
        raise EvidenceError("; ".join(failures))
    return {"status": "PASS", "scope": "sealed-evidence-only", "deployment": "forbidden", "tested_sha": tested_sha, "head_sha": head_sha, "runs": [{k: v for k, v in run.items() if k != "manifest"} for run in runs], "selected": {t: selected[t]["directory"] for t in required if t in selected}}


def evaluate_deploy(repo: Path, tested_sha: str, tier: str, head: str = "HEAD") -> dict:
    if tier not in {"test-env", "prod-deploy"}:
        raise EvidenceError("deploy entrypoint requires test-env or prod-deploy tier")
    sealed = evaluate(repo, tested_sha, tier, head)
    directory = sealed["selected"][tier]
    run = next(run for run in sealed["runs"] if run["directory"] == directory)
    manifest = parse_manifest(Path(repo), run["commit"], directory + "/manifest.json")
    observed = manifest.get("observed_deployment")
    if not isinstance(observed, dict) or not all(isinstance(observed.get(key), str) and observed[key] for key in ("vercel_git_commit_sha", "railway_git_commit_sha", "railway_deployment_id")):
        raise EvidenceError(f"deploy tier {tier} lacks observed Vercel/Railway commit identities and Railway deployment ID: {directory}")
    if observed["vercel_git_commit_sha"] != tested_sha or observed["railway_git_commit_sha"] != tested_sha:
        raise EvidenceError(f"deploy tier {tier} observed commit mismatch: {directory}")
    # Source-file hashes, schema fingerprint and authenticated observation
    # are not implemented yet. A shaped manifest cannot grant deployment.
    raise EvidenceError(f"deploy tier {tier} awaits authenticated source and schema verification: {directory}")
