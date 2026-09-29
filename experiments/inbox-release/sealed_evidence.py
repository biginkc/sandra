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
KINDS = {"migration-dry-run", "catalog-fingerprint", "burst", "db-contract", "browser", "shared-readonly", "migration-apply", "app-deploy"}
PHASES = {"pre", "post", "n/a"}
TARGETS = {"disposable", "shared-test", "production", "n/a"}
J5A = (
    ("pre-merge", "migration-dry-run", "n/a", "disposable"),
    ("pre-merge", "catalog-fingerprint", "n/a", "disposable"),
    ("pre-merge", "db-contract", "pre", "disposable"),
    ("pre-merge", "db-contract", "post", "disposable"),
    ("pre-merge", "browser", "pre", "disposable"),
    ("pre-merge", "browser", "post", "disposable"),
    ("pre-merge", "shared-readonly", "pre", "shared-test"),
)
APPROVALS = {
    "j5a": J5A,
    "j5b": J5A + (("pre-merge", "burst", "n/a", "disposable"),
                    ("test-env", "migration-apply", "post", "shared-test"),
                    ("test-env", "shared-readonly", "post", "shared-test")),
}
MIGRATION_VERSIONS = {"20260929000000", "20260929000100", "20260929000200"}
PROJECT_REFS = {"shared-test": "ncsngxlcyxylaeskiteu", "production": "copflsklaefwzipsrjqz"}
MIGRATION_WORKFLOWS = {"shared-test": ".github/workflows/db-migrate-test.yml", "production": ".github/workflows/db-migrate-prod.yml"}
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
    for field, allowed in (("kind", KINDS), ("phase", PHASES), ("target", TARGETS)):
        if manifest.get(field) not in allowed:
            raise EvidenceError(f"missing or unknown {field}: {directory}")
    if "external_artifacts" in manifest:
        raise EvidenceError(f"external_artifacts forbidden: {directory}")
    if manifest.get("github_run_id"):
        expected_artifact = f"heavy-{manifest.get('lane')}-{tested_sha}-{manifest['github_run_id']}-{manifest.get('github_run_attempt')}"
        if manifest.get("artifact_name") != expected_artifact:
            raise EvidenceError(f"run_attempt/artifact mismatch: {directory}")
    completed = timestamp(manifest.get("completed_at"))
    if timestamp(manifest.get("started_at")) > completed:
        raise EvidenceError(f"completed_at precedes started_at: {directory}")
    if (not HASH.fullmatch(str(manifest.get("runner_script_sha256", "")))
            or (manifest.get("lane") == "outbox" and not HASH.fullmatch(str(manifest.get("fault_proxy_script_sha256", ""))))):
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
    return {"directory": directory, "tier": parts[5], "key": (parts[5], manifest["kind"], manifest["phase"], manifest["target"]), "commit": commit, "completed_at": completed.isoformat(), "exit_status": manifest.get("exit_status"), "manifest": manifest}


def collect(repo: Path, tested_sha: str, head: str = "HEAD") -> dict:
    repo = Path(repo)
    if not SHA.fullmatch(tested_sha):
        raise EvidenceError("tested SHA must be a full 40-character commit SHA")
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
        keys_in_commit: set[tuple] = set()
        commit_completed: list[datetime] = []
        for directory, paths in added_by_dir.items():
            check_run_modes(repo, commit, directory, paths)
            run = validate_manifest(repo, commit, directory, paths, tested_sha)
            if run["key"] in keys_in_commit:
                raise EvidenceError(f"ambiguous same-commit run ordering for {run['key']}: {commit}")
            keys_in_commit.add(run["key"])
            completed = timestamp(run["completed_at"])
            if last_commit_completed is not None and completed < last_commit_completed:
                raise EvidenceError(f"completed_at is non-monotonic at {directory}")
            commit_completed.append(completed)
            sealed_dirs.add(directory)
            runs.append(run)
        if commit_completed:
            last_commit_completed = max(commit_completed)
    selected: dict[tuple, dict] = {}
    for run in runs:
        selected[run["key"]] = run
    return {"tested_sha": tested_sha, "head_sha": head_sha, "runs": runs, "selected": selected}


def _require(selected: dict, keys: tuple) -> dict:
    result = {}
    for key in keys:
        run = selected.get(key)
        if run is None:
            raise EvidenceError(f"missing required check {key}")
        manifest = run["manifest"]
        if run["exit_status"] != 0 or manifest.get("verdict") != "PASS":
            raise EvidenceError(f"latest required check failed {key}: {run['directory']}")
        if key[0] == "pre-merge" and key[3] == "disposable":
            if not (str(manifest.get("github_run_id", "")).isdigit()
                    and str(manifest.get("github_run_attempt", "")).isdigit()
                    and manifest.get("workflow_path") == ".github/workflows/inbox-heavy-verification.yml"
                    and manifest.get("workflow_input_sha") == manifest.get("tested_sha")
                    and manifest.get("event") == "workflow_dispatch"
                    and manifest.get("head_branch") == "main"):
                raise EvidenceError(f"missing runner provenance: {run['directory']}")
        queued = manifest.get("items", {}).get("queued_invariants", {})
        if key[1] == "shared-readonly" and queued.get("verdict") == "INCONCLUSIVE":
            if key[3] != "shared-test" or not queued.get("diff") or (key[2] == "post" and queued.get("stability_probe") != "identical"):
                raise EvidenceError(f"unadmitted queued invariants: {run['directory']}")
            result[str(key)] = {"directory": run["directory"], "queued_diff": queued["diff"]}
        else:
            result[str(key)] = {"directory": run["directory"]}
    return result


def _find_migration_chain(repo: Path, x_mig: str) -> dict:
    refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes").decode().splitlines()
    chains = []
    for ref in refs:
        if subprocess.run(["git", "merge-base", "--is-ancestor", x_mig, ref], cwd=repo).returncode == 0:
            try:
                chain = collect(repo, x_mig, ref)
                if chain["runs"]:
                    chains.append(chain)
            except EvidenceError:
                continue
    if not chains:
        raise EvidenceError(f"no sealed migration evidence chain at {x_mig}")
    unique = {chain["head_sha"]: chain for chain in chains}
    if len(unique) != 1:
        raise EvidenceError(f"ambiguous sealed migration evidence chains at {x_mig}")
    return next(iter(unique.values()))


def evaluate(repo: Path, approval: str, x_mig: str | None = None, m: str | None = None, head: str = "HEAD") -> dict:
    """Evaluate required checks at X; J5b also reads the M-keyed evidence branch."""
    repo = Path(repo)
    if approval not in APPROVALS:
        # Legacy release gate entrypoint: inspect every latest check in the tier.
        tested_sha, tier = approval, x_mig
        if m is not None and head == "HEAD":
            head = m
        if tier not in TIERS:
            raise EvidenceError(f"unknown approval or tier: {approval}")
        chain = collect(repo, tested_sha, head)
        keys = tuple(key for key in chain["selected"] if key[0] == tier)
        if not keys:
            raise EvidenceError(f"no sealed run for {tested_sha} and {tier}")
        selected = _require(chain["selected"], keys)
        return {"status": "PASS", "scope": "sealed-evidence-only", "deployment": "forbidden", "tested_sha": tested_sha,
                "head_sha": chain["head_sha"], "runs": [{k: v for k, v in run.items() if k != "manifest"} for run in chain["runs"]],
                "selected": {tier: list(selected.values())[-1]["directory"]}}
    if not x_mig or not SHA.fullmatch(x_mig):
        raise EvidenceError("migration SHA required")
    if approval == "j5a":
        chain = collect(repo, x_mig, head)
        selected = _require(chain["selected"], APPROVALS["j5a"])
    else:
        if not m or not SHA.fullmatch(m):
            raise EvidenceError("main SHA required for j5b")
        if git(repo, "diff", "--name-only", x_mig, m, "--", "supabase/migrations", "experiments/inbox-production-install").strip():
            raise EvidenceError("migration diff between X_mig and M")
        mig_chain = _find_migration_chain(repo, x_mig)
        main_chain = collect(repo, m, head)
        combined = {key: run for key, run in mig_chain["selected"].items() if key[0] == "pre-merge"}
        combined.update({key: run for key, run in main_chain["selected"].items() if key[0] == "test-env"})
        selected = _require(combined, APPROVALS["j5b"])
        evaluate_migration(repo, m, "shared-test", head=head, x_mig=x_mig)
    return {"status": "PASS", "approval": approval, "selected": selected}


def evaluate_migration(repo: Path, m: str, target: str, head: str = "HEAD", x_mig: str | None = None) -> dict:
    if target not in MIGRATION_WORKFLOWS:
        raise EvidenceError("unknown migration target")
    chain = collect(Path(repo), m, head)
    key = ("test-env" if target == "shared-test" else "prod-deploy", "migration-apply", "post", target)
    selected = _require(chain["selected"], (key,))
    run = chain["selected"][key]
    manifest = run["manifest"]
    if manifest.get("target_binding", {}).get("project_ref") != PROJECT_REFS[target]:
        raise EvidenceError("migration target binding mismatch")
    workflow = manifest.get("workflow_run", {})
    if workflow.get("workflow_path") != MIGRATION_WORKFLOWS[target] or workflow.get("head_sha") != m or workflow.get("conclusion") != "success" or not str(workflow.get("run_id", "")).isdigit() or not str(workflow.get("run_attempt", "")).isdigit():
        raise EvidenceError("migration workflow identity mismatch")
    before = set(map(str, manifest.get("schema_migrations_before", [])))
    after = set(map(str, manifest.get("schema_migrations_after", [])))
    if (len(before) != len(manifest.get("schema_migrations_before", [])) or len(after) != len(manifest.get("schema_migrations_after", []))
            or after - before != MIGRATION_VERSIONS or before - after):
        raise EvidenceError("migration ledger versions mismatch")
    bound_x = manifest.get("migration_head_sha")
    if not isinstance(bound_x, str) or not SHA.fullmatch(bound_x) or (x_mig and bound_x != x_mig):
        raise EvidenceError("migration head binding mismatch")
    x_mig = bound_x
    if x_mig:
        pre = _find_migration_chain(Path(repo), x_mig)["selected"].get(("pre-merge", "catalog-fingerprint", "n/a", "disposable"))
        if pre is None:
            raise EvidenceError("missing committed catalog fingerprint")
        fingerprint_path = pre["manifest"].get("catalog_fingerprint_post_artifact", "catalog-fingerprint-post.json")
        if fingerprint_path not in pre["manifest"]["artifacts"]:
            raise EvidenceError("missing committed catalog fingerprint artifact")
        expected = json.loads(blob(Path(repo), pre["commit"], pre["directory"] + "/" + fingerprint_path))
        observed = manifest.get("catalog_fingerprint_after")
        if not isinstance(expected, dict) or not isinstance(observed, dict) or expected.keys() != observed.keys() or any(expected[k] != observed[k] for k in expected):
            raise EvidenceError("catalog fingerprint section mismatch")
    return {"status": "PASS", "selected": selected}


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
