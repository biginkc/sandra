"""Validate immutable run records from committed Git blobs only."""
from __future__ import annotations

from datetime import datetime
import hashlib
import json
import math
import ntpath
from pathlib import Path
import posixpath
import re
import subprocess

ROOT = "docs/performance/inbox-redesign/evidence"
TIERS = {"pre-merge", "test-env", "prod-deploy"}
KINDS = {"migration-dry-run", "catalog-fingerprint", "drift-replay", "burst", "perf-120k", "db-contract", "browser", "shared-readonly", "migration-apply", "app-deploy"}
PHASES = {"pre", "post", "n/a"}
TARGETS = {"disposable", "shared-test", "production", "n/a"}
J5A = (
    ("pre-merge", "migration-dry-run", "n/a", "disposable"),
    ("pre-merge", "catalog-fingerprint", "n/a", "disposable"),
    ("pre-merge", "drift-replay", "n/a", "disposable"),
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
MIGRATION_VERSIONS = {"20260930040000", "20260930040100", "20260930040200"}
PROJECT_REFS = {"shared-test": "ncsngxlcyxylaeskiteu", "production": "copflsklaefwzipsrjqz"}
MIGRATION_WORKFLOWS = {"shared-test": ".github/workflows/db-migrate-test.yml", "production": ".github/workflows/db-migrate-prod.yml"}
MIGRATION_APPLY_JOBS = {"shared-test": "Apply migrations to test", "production": "Apply migrations to prod"}
SHA = re.compile(r"[0-9a-f]{40}\Z")
HASH = re.compile(r"[0-9a-f]{64}\Z")
CATALOG_SECTIONS = ("created_objects_present", "extensions", "functions", "index_names", "relations", "schema_migrations", "schemas", "trigger_names", "types")
OPERATOR_LIST = "scripts/inbox-ci/shared-readonly-operators.json"
PLAN_ROLES = ("privileged", "member")
PLAN_SHAPES = ("first", "keyset", "null_tail")
NOT_VERIFIED = "NOT_VERIFIED"
PLATFORM_MAJOR_FIELDS = ("postgres_major", "postgrest_major", "gotrue_major")
PLATFORM_FIELDS = PLATFORM_MAJOR_FIELDS + ("postgrest_reason", "postgrest_observed_major")
POSTGREST_REASONS = {"NAME_UNVERSIONED", "MIXED_NAMES", "NO_CONNECTION"}
CATALOG_FORMAT_VERSION = 2
DRIFT_FIXTURE_VERSION = 1
KNOWN_TARGET_REFS = frozenset(PROJECT_REFS.values())
DRIFT_FIXTURE_ROOT = "experiments/inbox-production-install/drift"
DRIFT_APPROVALS = {
    "idx_message_threads_ai_responder_status": "e419f623f1922466db14dba7aa091cdd4720924e2b97901088af2dc5719b108a",
    "idx_users_name": "4dbc01feffae5acf04236e5aa3611151cc43e1467f84588e05b025dd9fbc7402",
}
OPERATOR_INDEX_NAMES = {
    "inbox_parent_message_property", "inbox_parent_message_contact", "inbox_parent_review_property",
    "inbox_backfill_messages", "inbox_backfill_reviews", "inbox_backfill_threads",
    "inbox_backfill_thread_identity", "inbox_unknown_history_page",
}
def derive_rowtype_tables(sources: list[str]) -> frozenset[str]:
    tables: set[str] = set()
    aliases: dict[str, set[str]] = {}
    qualified = r"((?:public|auth|storage|inbox_[a-z_]+|supabase_migrations)\.[a-z_][a-z_0-9]*)"
    for source in sources:
        tables.update(f"{schema.lower()}.{table.lower()}" for schema, table in re.findall(
            r"\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)%rowtype\b", source, re.I))
        for match in re.finditer(rf"\b(?:FROM|JOIN)\s+{qualified}(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?", source, re.I):
            table = match.group(1).lower()
            alias = (match.group(2) or table.rsplit('.', 1)[-1]).lower()
            aliases.setdefault(alias, set()).add(table)
        for match in re.finditer(rf"\b(?:FROM|JOIN)\s+{qualified}\b", source, re.I):
            table = match.group(1).lower()
            if re.search(rf"\b{re.escape(table.rsplit('.', 1)[-1])}\s*\.\s*\*", source, re.I):
                tables.add(table)
            if re.search(rf"\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+{re.escape(table)}\b", source, re.I):
                tables.add(table)
        for alias, candidates in aliases.items():
            if re.search(rf"\b{re.escape(alias)}\s*\.\s*\*", source, re.I):
                tables.update(candidates)
            if re.search(rf"\bSELECT\s+(?:DISTINCT\s+)?\*\s+FROM\s+{re.escape(alias)}\b", source, re.I):
                tables.update(candidates)
            if re.search(rf"\b(?:SELECT\s+\(?\s*{re.escape(alias)}\s*\)?\s*(?:,|FROM|$)|ROW\s*\(\s*{re.escape(alias)}\s*\))", source, re.I | re.M):
                tables.update(candidates)
    return frozenset(tables)


_migration_dir = Path(__file__).resolve().parents[2] / "supabase/migrations"
ROWTYPE_TABLES = derive_rowtype_tables([p.read_text() for p in _migration_dir.glob("2026093004*.sql")])
J5A_CATALOG_DRIFT_SUMMARY = "TEST matched the disposable baseline except eight pre-existing items not in any migration, listed here. They are recorded and replayed, not explained; owners unknown. Production's drift is not yet observed."


class EvidenceError(RuntimeError):
    pass


def platform_digest(value: dict) -> str:
    canonical = {key: value.get(key) for key in PLATFORM_FIELDS}
    return hashlib.sha256(json.dumps(canonical, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def validate_platform(value: object, *, require_verified: bool = False, label: str = "platform") -> dict:
    if not isinstance(value, dict) or set(value) != {*PLATFORM_FIELDS, "sha256"}:
        raise EvidenceError(f"invalid {label} platform data")
    if any(not isinstance(value[key], str) or not re.fullmatch(r"[0-9]+", value[key]) for key in ("postgres_major", "gotrue_major")):
        raise EvidenceError(f"invalid {label} platform data")
    major = value["postgrest_major"]
    observed = value["postgrest_observed_major"]
    if major == NOT_VERIFIED:
        reason = value["postgrest_reason"]
        if reason not in POSTGREST_REASONS or (reason == "MIXED_NAMES" and (observed is None or not isinstance(observed, str) or not re.fullmatch(r"[0-9]+", observed))) or (reason != "MIXED_NAMES" and observed is not None):
            raise EvidenceError(f"invalid {label} platform data")
        if require_verified:
            raise EvidenceError(f"invalid {label} platform data")
    elif isinstance(major, str) and re.fullmatch(r"[0-9]+", major):
        if value["postgrest_reason"] is not None or (observed is not None and observed != major):
            raise EvidenceError(f"invalid {label} platform data")
    else:
        raise EvidenceError(f"invalid {label} platform data")
    if not isinstance(value["sha256"], str) or not HASH.fullmatch(value["sha256"]) or value["sha256"] != platform_digest(value):
        raise EvidenceError(f"{label} platform digest mismatch")
    return value


def hosted_platform_summary(major: str, reason: str | None) -> str:
    observed = {
        "NAME_UNVERSIONED": "NOT_VERIFIED: the connection name carried no version",
        "MIXED_NAMES": "NOT_VERIFIED: some connections carried a matching version and others none (MIXED_NAMES)",
        "NO_CONNECTION": "NOT_VERIFIED: no PostgREST connection was visible, which does not prove none existed",
    }.get(reason, "NOT_VERIFIED: invalid reason") if major == NOT_VERIFIED else "observed from its connection name and matched"
    return ("Auth health returned 200 with the publishable key; GoTrue major matched. Our publishable-key PostgREST request was rejected. "
            f"PostgREST major was {observed}. On TEST the name carries no version, so this check is waived there in practice; Production is expected to be the same. "
            "Connection names are diagnostic labels, not attestations. Release may proceed with hosted PostgREST compatibility unverified. "
            "Hosted app/SSR/PostgREST behaviour is inferred from same-SHA disposable runs plus catalog and claim-plumbing equality, which cannot establish hosted runtime/configuration equality; "
            "a GoTrue major match does not prove identical hosted claim configuration.")


def catalog_digest(sections: dict) -> dict:
    section_sha256 = {name: hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() for name, value in sorted(sections.items())}
    return {"catalog_format_version": CATALOG_FORMAT_VERSION, "sections": sections, "section_sha256": section_sha256,
            "sha256": hashlib.sha256(json.dumps({"catalog_format_version": CATALOG_FORMAT_VERSION, "section_sha256": section_sha256}, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()}


def validate_catalog_baseline(value: object, label: str = "catalog") -> dict:
    if (not isinstance(value, dict) or value.get("catalog_format_version") != CATALOG_FORMAT_VERSION or not isinstance(value.get("sections"), dict)
            or set(value.get("sections", {})) != set(CATALOG_SECTIONS) or set(value.get("section_sha256", {})) != set(CATALOG_SECTIONS)):
        raise EvidenceError(f"CATALOG_MISMATCH {label} format")
    rebuilt = catalog_digest(value["sections"])
    if rebuilt["section_sha256"] != value["section_sha256"] or rebuilt["sha256"] != value.get("sha256"):
        raise EvidenceError(f"CATALOG_MISMATCH {label} digest")
    return value


def reconstruct_drift_catalog(baseline: dict, record: dict, *, bound_baseline_digest: str | None = None,
                              target_ref: str | None = None, candidate_sha: str | None = None) -> dict:
    validate_catalog_baseline(baseline, "baseline")
    if (not isinstance(record, dict) or set(record) != {"record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items", "sha256"}
            or record["record_version"] != 1 or record["catalog_format_version"] != CATALOG_FORMAT_VERSION
            or not isinstance(record["target_ref"], str) or not record["target_ref"]
            or (target_ref is not None and record["target_ref"] != target_ref)
            or record["baseline_digest"] != (bound_baseline_digest or baseline["sha256"])
            or not SHA.fullmatch(str(record["candidate_sha"])) or (candidate_sha is not None and record["candidate_sha"] != candidate_sha)
            or not HASH.fullmatch(str(record["sha256"]))):
        raise EvidenceError("DRIFT_RECORD_STALE binding")
    payload = {key: record[key] for key in ("record_version", "target_ref", "candidate_sha", "baseline_digest", "catalog_format_version", "items")}
    if hashlib.sha256(json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest() != record["sha256"]:
        raise EvidenceError("DRIFT_RECORD_STALE digest")
    sections = json.loads(json.dumps(baseline["sections"]))
    relations = {row["identity"]: row for row in sections["relations"]}
    seen = set()
    for item in record["items"]:
        if (not isinstance(item, dict) or set(item) != {"object", "attribute", "name", "canonical_definition", "definition_sha256", "classification", "origin", "approval_sha256"}
                or item["attribute"] not in {"columns", "indexes"} or not all(isinstance(item.get(key), str) and item[key] for key in ("object", "name"))
                or not isinstance(item["canonical_definition"], str) or not item["canonical_definition"] or item["canonical_definition"].endswith("\n")
                or not isinstance(item["definition_sha256"], str) or not HASH.fullmatch(item["definition_sha256"])
                or hashlib.sha256(item["canonical_definition"].encode("utf-8")).hexdigest() != item["definition_sha256"]
                or item["object"] not in relations):
            raise EvidenceError("DRIFT_RECORD_STALE item")
        identity = (item["object"], item["attribute"], item["name"])
        if identity in seen:
            raise EvidenceError("DRIFT_RECORD_STALE duplicate")
        seen.add(identity)
        if item["object"] in ROWTYPE_TABLES:
            raise EvidenceError("DRIFT_RECORD_STALE rowtype table")
        c = item["classification"]
        if item["attribute"] == "columns":
            if (set(c) != {"class", "nullable", "default", "attidentity", "attgenerated", "column_acl", "owner"}
                    or c["class"] != "column" or c["nullable"] is not True or c["default"] is not None or c["attidentity"] != "" or c["attgenerated"] != "" or c["column_acl"] is not None
                    or item["origin"] != "unknown" or c["owner"] != relations[item["object"]].get("owner") or item["approval_sha256"] is not None):
                raise EvidenceError("DRIFT_RECORD_STALE column")
        else:
            if (set(c) != {"class", "unique", "primary", "constraint", "valid", "ready", "live", "predicate", "expression", "owner"}
                    or c["class"] != "index" or any(c[key] is not False for key in ("unique", "primary", "constraint"))
                    or any(c[key] is not True for key in ("valid", "ready", "live")) or not isinstance(c["owner"], str) or not c["owner"]
                    or (item["object"] == "auth.users" and c["owner"] != "supabase_auth_admin") or item["name"] in OPERATOR_INDEX_NAMES):
                raise EvidenceError("DRIFT_RECORD_STALE index")
            approval = DRIFT_APPROVALS.get(item["name"]) if c["predicate"] is not None or c["expression"] is True else None
            if ((c["predicate"] is not None or c["expression"] is True) and approval is None) or item["approval_sha256"] != approval:
                raise EvidenceError("DRIFT_RECORD_STALE approval")
            if approval is not None and hashlib.sha256(item["canonical_definition"].encode("utf-8")).hexdigest() != approval:
                raise EvidenceError("DRIFT_RECORD_STALE approval")
            if (item["origin"] != ("platform" if item["object"] == "auth.users" else "unknown")
                    or c["owner"] != relations[item["object"]].get("owner")
                    or (item["object"] == "auth.users" and c["owner"] != "supabase_auth_admin")):
                raise EvidenceError("DRIFT_RECORD_STALE origin")
        bucket = relations[item["object"]][item["attribute"]]
        if any(entry.get("name") == item["name"] for entry in bucket):
            raise EvidenceError("DRIFT_RECORD_STALE collision")
        if item["attribute"] == "columns":
            bucket.append({"name": item["name"], "type": item["canonical_definition"], "not_null": not c["nullable"], "default": c["default"], "acl": c["column_acl"], "attgenerated": c["attgenerated"], "attidentity": c["attidentity"]})
            bucket.sort(key=lambda entry: entry["name"])
        else:
            bucket.append({"name": item["name"], "definition": item["canonical_definition"], "unique": c["unique"], "primary": c["primary"], "constraint": c["constraint"], "valid": c["valid"], "ready": c["ready"], "live": c["live"], "predicate": c["predicate"], "expression": c["expression"], "owner": c["owner"]})
            bucket.sort(key=lambda entry: entry["definition"])
    return catalog_digest(sections)


def _drift_bindings(record: dict) -> set[tuple[str, str, str, str]]:
    return {(item.get("object"), item.get("attribute"), item.get("name"), item.get("definition_sha256"))
            for item in record.get("items", []) if isinstance(item, dict)}


def validate_replacement_drift_record(original: dict, replacement: dict, replay: dict | None = None) -> None:
    original_items = _drift_bindings(original)
    replacement_items = _drift_bindings(replacement)
    if not replacement_items <= original_items:
        raise EvidenceError("replacement drift record item absent from sealed PRE or definition changed")
    if replay is None or replay.get("sha256") != replacement.get("sha256"):
        raise EvidenceError("replacement drift record is not linked to a passing sealed replay")


def drift_fixture_path(target_ref: str) -> str:
    if target_ref not in KNOWN_TARGET_REFS:
        raise EvidenceError(f"unknown drift target ref: {target_ref}")
    return f"{DRIFT_FIXTURE_ROOT}/{target_ref}.items.json"


def read_drift_fixture(repo: Path, commit: str, target_ref: str) -> dict:
    try:
        fixture = json.loads(blob(repo, commit, drift_fixture_path(target_ref)), object_pairs_hook=unique_object_pairs)
    except (EvidenceError, ValueError, UnicodeDecodeError) as exc:
        raise EvidenceError(f"missing or malformed drift fixture for {target_ref}") from exc
    if (not isinstance(fixture, dict) or set(fixture) != {"fixture_version", "items"}
            or fixture["fixture_version"] != DRIFT_FIXTURE_VERSION or not isinstance(fixture["items"], list)):
        raise EvidenceError(f"malformed drift fixture for {target_ref}")
    for item in fixture["items"]:
        if (not isinstance(item, dict)
                or set(item) != {"object", "attribute", "name", "canonical_definition", "definition_sha256", "classification", "origin", "approval_sha256"}
                or not isinstance(item["canonical_definition"], str) or not item["canonical_definition"] or item["canonical_definition"].endswith("\n")
                or not isinstance(item["definition_sha256"], str) or not HASH.fullmatch(item["definition_sha256"])
                or hashlib.sha256(item["canonical_definition"].encode("utf-8")).hexdigest() != item["definition_sha256"]):
            raise EvidenceError(f"malformed drift fixture item for {target_ref}")
    return fixture


def validate_drift_lane(kind: str, artifacts: object) -> None:
    if kind != "drift-replay" and isinstance(artifacts, dict) and any(
            name in {"drift-record.json", "catalog-drift.json"}
            or (isinstance(name, str) and name.startswith("drift-record-") and name.endswith(".json"))
            for name in artifacts):
        raise EvidenceError("drift record is only permitted in replay lane")


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


def artifact_sha256(repo: Path, commit: str, path: str) -> str:
    return hashlib.sha256(blob(repo, commit, path)).hexdigest()


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


def validate_manifest(repo: Path, commit: str, directory: str, paths: set[str], tested_sha: str,
                      *, manifest_reader=None, artifact_hasher=None) -> dict:
    manifest_reader = manifest_reader or parse_manifest
    artifact_hasher = artifact_hasher or artifact_sha256
    parts = directory.split("/")
    if len(parts) != 7 or "/".join(parts[:4]) != ROOT or parts[4] != tested_sha or parts[5] not in TIERS or not re.fullmatch(r"[A-Za-z0-9_-]+", parts[6]):
        raise EvidenceError(f"run filed under wrong SHA or malformed run directory: {directory}")
    # ROOT has four components, followed by SHA, tier and run ID.
    manifest_path = f"{directory}/manifest.json"
    if manifest_path not in paths:
        raise EvidenceError(f"incomplete run: missing manifest at {directory}")
    manifest = manifest_reader(repo, commit, manifest_path)
    if not isinstance(manifest, dict) or manifest.get("tested_sha") != tested_sha or manifest.get("tier") != parts[5] or manifest.get("run_id") != parts[6]:
        raise EvidenceError(f"manifest identity mismatch: {directory}")
    for field, allowed in (("kind", KINDS), ("phase", PHASES), ("target", TARGETS)):
        if manifest.get(field) not in allowed:
            raise EvidenceError(f"missing or unknown {field}: {directory}")
    if manifest["kind"] == "perf-120k":
        if parts[5] != "pre-merge" or manifest["phase"] != "n/a" or manifest["target"] != "disposable":
            raise EvidenceError(f"perf-120k requires phase n/a and target disposable in pre-merge: {directory}")
        if not (str(manifest.get("github_run_id", "")).isdigit()
                and str(manifest.get("github_run_attempt", "")).isdigit()
                and manifest.get("workflow_path") == ".github/workflows/inbox-heavy-verification.yml"
                and manifest.get("workflow_input_sha") == tested_sha
                and manifest.get("event") == "workflow_dispatch"
                and manifest.get("head_branch") == "main"
                and manifest.get("lane") == "perf-120k"):
            raise EvidenceError(f"missing runner provenance: {directory}")
    if manifest["kind"] == "drift-replay" and (parts[5] != "pre-merge" or manifest["phase"] != "n/a" or manifest["target"] != "disposable"):
        raise EvidenceError(f"drift-replay requires phase n/a and target disposable in pre-merge: {directory}")
    if "external_artifacts" in manifest:
        raise EvidenceError(f"external_artifacts forbidden: {directory}")
    if manifest.get("github_run_id"):
        expected_artifact = f"heavy-{manifest.get('lane')}-{tested_sha}-{manifest['github_run_id']}-{manifest.get('github_run_attempt')}"
        if manifest.get("artifact_name") != expected_artifact:
            raise EvidenceError(f"run_attempt/artifact mismatch: {directory}")
    completed = timestamp(manifest.get("completed_at"))
    if timestamp(manifest.get("started_at")) > completed:
        raise EvidenceError(f"completed_at precedes started_at: {directory}")
    if manifest["kind"] == "shared-readonly":
        expected_fields = {"tested_sha", "tier", "kind", "phase", "target", "verdict", "exit_status", "run_id",
                           "started_at", "completed_at", "clean_tree", "artifacts", "target_binding", "inputs",
                           "operator_script_sha256", "event", "workflow_path", "github_run_id", "github_run_attempt", "waived_fields", "waiver_reasons", "items"}
        if set(manifest) != expected_fields:
            raise EvidenceError(f"unexpected shared-readonly manifest field: {directory}")
        completed_text = manifest["completed_at"]
        if (not isinstance(completed_text, str) or not re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", completed_text)
                or manifest["started_at"] != completed_text
                or manifest["run_id"] != "shared-readonly-" + manifest["phase"] + "-" + completed_text.replace("-", "").replace(":", "").replace(".", "")):
            raise EvidenceError(f"shared-readonly run metadata mismatch: {directory}")
        try:
            operator_list = json.loads(blob(repo, tested_sha, OPERATOR_LIST), object_pairs_hook=unique_object_pairs)
        except (ValueError, UnicodeDecodeError) as exc:
            raise EvidenceError(f"invalid operator list: {directory}: {exc}") from exc
        scripts = operator_list.get("operator_scripts") if isinstance(operator_list, dict) and set(operator_list) == {"operator_scripts"} else None
        if (not isinstance(scripts, list) or any(not isinstance(script, str) or not re.fullmatch(r"scripts/[a-z0-9/.-]+", script) or ".." in script for script in scripts)
                or OPERATOR_LIST not in scripts or len(scripts) != len(set(scripts))):
            raise EvidenceError(f"invalid operator list: {directory}")
        operator = manifest.get("operator_script_sha256")
        if (not isinstance(operator, dict) or set(operator) != set(scripts) or any(
                operator[script] != hashlib.sha256(blob(repo, tested_sha, script)).hexdigest() for script in scripts)):
            raise EvidenceError(f"operator provenance mismatch: {directory}")
        if (manifest.get("event") != "operator" or manifest.get("workflow_path") != "" or manifest.get("github_run_id") != "" or manifest.get("github_run_attempt") != ""):
            raise EvidenceError(f"operator event provenance mismatch: {directory}")
    elif (not HASH.fullmatch(str(manifest.get("runner_script_sha256", "")))
          or (manifest["kind"] == "browser" and not HASH.fullmatch(str(manifest.get("fault_proxy_script_sha256", ""))))):
        raise EvidenceError(f"missing runner/proxy hashes: {directory}")
    clean = manifest.get("clean_tree")
    if not isinstance(clean, dict) or (manifest["kind"] == "shared-readonly" and set(clean) != {"start", "end_excluding_run_dir", "excluded_path"}) or clean.get("start") is not True or clean.get("end_excluding_run_dir") is not True or clean.get("excluded_path") != directory:
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
        observed = artifact_hasher(repo, commit, f"{directory}/{relative}")
        if observed != expected:
            raise EvidenceError(f"artifact hash mismatch: {directory}/{relative}")
    try:
        validate_drift_lane(manifest["kind"], artifacts)
    except EvidenceError as exc:
        raise EvidenceError(f"{exc}: {directory}") from exc
    if type(manifest.get("exit_status")) is not int:
        raise EvidenceError(f"missing numeric exit_status: {directory}")
    return {"directory": directory, "tier": parts[5], "key": (parts[5], manifest["kind"], manifest["phase"], manifest["target"]), "commit": commit, "completed_at": completed.isoformat(), "exit_status": manifest.get("exit_status"), "manifest": manifest}


def validate_downloaded_manifest(root: Path, directory: str, paths: set[str], tested_sha: str) -> dict:
    """Apply the sealed gate's per-record rules to a downloaded run directory."""
    root = Path(root)

    def read_manifest(_repo: Path, _commit: str, path: str) -> dict:
        try:
            return json.loads((root / path).read_bytes(), object_pairs_hook=unique_object_pairs)
        except (ValueError, UnicodeDecodeError) as exc:
            raise EvidenceError(f"invalid manifest: {path}: {exc}") from exc

    def hash_artifact(_repo: Path, _commit: str, path: str) -> str:
        return hashlib.sha256((root / path).read_bytes()).hexdigest()

    return validate_manifest(root, "download", directory, paths, tested_sha,
                             manifest_reader=read_manifest, artifact_hasher=hash_artifact)


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


def _require(selected: dict, keys: tuple, repo: Path | None = None) -> dict:
    result = {}
    for key in keys:
        run = selected.get(key)
        if run is None:
            raise EvidenceError(f"missing required check {key}")
        manifest = run["manifest"]
        if run["exit_status"] != 0 or manifest.get("verdict") != "PASS":
            raise EvidenceError(f"latest required check failed {key}: {run['directory']}")
        if key[1] == "shared-readonly":
            if repo is None:
                raise EvidenceError("repository required for shared-test linkage")
            _check_shared_readonly(repo, run, selected)
        if key[1] == "drift-replay":
            if repo is None:
                raise EvidenceError("repository required for drift replay linkage")
            _check_drift_replay(repo, run, selected)
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


def _check_shared_readonly(repo: Path, run: dict, selected: dict) -> None:
    manifest = run["manifest"]
    directory = run["directory"]
    def reject_raw(value: object) -> None:
        if isinstance(value, dict):
            for name, child in value.items():
                if name.lower() in {"sections", "content", "access_token", "refresh_token", "apikey", "service_role"}:
                    raise EvidenceError(f"raw catalog/content or token key: {directory}")
                reject_raw(child)
        elif isinstance(value, list):
            for child in value:
                reject_raw(child)
    reject_raw(manifest)
    if manifest.get("target_binding") != {"project_ref": PROJECT_REFS["shared-test"], "pooler_user": "postgres." + PROJECT_REFS["shared-test"]}:
        raise EvidenceError(f"shared-test project_ref mismatch: {directory}")
    if (not isinstance(manifest.get("waived_fields"), list)
            or any(field != "postgrest_major" for field in manifest["waived_fields"])
            or len(manifest["waived_fields"]) != len(set(manifest["waived_fields"]))
            or not isinstance(manifest.get("waiver_reasons"), dict)
            or set(manifest["waiver_reasons"]) - {"postgrest_major"}):
        raise EvidenceError(f"invalid waived fields: {directory}")
    if set(manifest.get("artifacts", {})) != {"readonly.json"}:
        raise EvidenceError(f"shared-readonly artifact inventory mismatch: {directory}")
    try:
        output = json.loads(blob(repo, run["commit"], directory + "/readonly.json"), object_pairs_hook=unique_object_pairs)
    except (ValueError, UnicodeDecodeError) as exc:
        raise EvidenceError(f"invalid shared-readonly output: {directory}: {exc}") from exc
    if not isinstance(output, dict) or set(output) != {"verdict", "target", "phase", "source_output_sha256", "summary", "platform_config", "plans", "tls", "catalog_indexes_sha256", "comparisons", "items"} or output["verdict"] != "PASS" or output["target"] != "shared-test" or output["phase"] != manifest["phase"]:
        raise EvidenceError(f"raw or malformed shared-readonly output: {directory}")
    reject_raw(output)
    if (not isinstance(output["source_output_sha256"], str) or not HASH.fullmatch(output["source_output_sha256"])
            or not isinstance(output["catalog_indexes_sha256"], str) or not HASH.fullmatch(output["catalog_indexes_sha256"])):
        raise EvidenceError(f"invalid shared-readonly source/index digest: {directory}")
    plans = output["plans"]
    if not isinstance(plans, dict) or set(plans) != set(PLAN_ROLES):
        raise EvidenceError(f"invalid shared-readonly plans: {directory}")
    for role in PLAN_ROLES:
        if not isinstance(plans[role], dict) or set(plans[role]) != set(PLAN_SHAPES):
            raise EvidenceError(f"invalid shared-readonly plans: {directory}")
        for shape in PLAN_SHAPES:
            plan = plans[role][shape]
            if (not isinstance(plan, dict) or set(plan) != {"sha256", "messages_scan", "total_cost"}
                    or not isinstance(plan["sha256"], str) or not HASH.fullmatch(plan["sha256"])
                    or not isinstance(plan["messages_scan"], str) or plan["messages_scan"] not in {"Seq Scan", "Index"}
                    or isinstance(plan["total_cost"], bool) or not isinstance(plan["total_cost"], (int, float))
                    or not math.isfinite(plan["total_cost"])):
                raise EvidenceError(f"invalid shared-readonly plan: {directory}")
    tls = output["tls"]
    pin = "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA"
    fp = re.compile(r"(?:[0-9A-F]{2}:){31}[0-9A-F]{2}\Z")
    if (not isinstance(tls, dict) or set(tls) != {"protocol", "cipher", "leaf_fingerprint", "pinned_ca_fingerprint", "root_in_peer_chain", "upstream_hop_ssl"}
            or tls["protocol"] not in {"TLSv1.2", "TLSv1.3"}
            or not isinstance(tls["cipher"], str) or not tls["cipher"]
            or not isinstance(tls["leaf_fingerprint"], str) or not fp.fullmatch(tls["leaf_fingerprint"])
            or tls["pinned_ca_fingerprint"] != pin or not isinstance(tls["root_in_peer_chain"], bool)
            or (tls["upstream_hop_ssl"] is not None and (not isinstance(tls["upstream_hop_ssl"], dict)
                or set(tls["upstream_hop_ssl"]) != {"ssl", "version", "cipher"}
                or not isinstance(tls["upstream_hop_ssl"]["ssl"], bool)
                or any(tls["upstream_hop_ssl"][key] is not None and not isinstance(tls["upstream_hop_ssl"][key], str)
                       for key in ("version", "cipher"))))):
        raise EvidenceError(f"invalid shared-readonly TLS: {directory}")
    items = output["items"]
    if not isinstance(items, dict) or set(items) - {"queued_invariants"}:
        raise EvidenceError(f"raw or malformed shared-readonly items: {directory}")
    if manifest.get("items") != items:
        raise EvidenceError(f"queued item linkage mismatch: {directory}")
    if "queued_invariants" in items:
        queued = items["queued_invariants"]
        if (not isinstance(queued, dict) or not {"verdict", "diff"} <= set(queued) <= {"verdict", "diff", "stability_probe"}
                or queued.get("verdict") not in {"PASS", "INCONCLUSIVE"} or not isinstance(queued["diff"], str)
                or not HASH.fullmatch(queued["diff"])
                or (queued["verdict"] == "PASS") != (queued["diff"] == hashlib.sha256(b"[]").hexdigest())
                or ("stability_probe" in queued and queued["stability_probe"] != "identical")):
            raise EvidenceError(f"invalid queued digest: {directory}")
    comparisons = output.get("comparisons")
    if (not isinstance(comparisons, dict) or set(comparisons) != {"catalog", "platform"}
            or any(not isinstance(comparisons.get(label), dict) for label in ("catalog", "platform"))
            or set(comparisons["catalog"]) != {"verdict", "input_sha256", "observed_section_sha256", "observed_catalog_sha256", "drift_record_sha256"}
            or set(comparisons["platform"]) != {"verdict", "waived_fields", "waiver_reasons", "input_sha256", "observed_sha256"}):
        raise EvidenceError(f"comparison linkage missing: {directory}")
    for label, key, artifact in (("catalog_record", ("pre-merge", "catalog-fingerprint", "n/a", "disposable"), "catalog-pre.json"),
                                 ("platform_record", ("pre-merge", "db-contract", "pre", "disposable"), "platform-config.json"),
                                 ("drift_record", ("pre-merge", "drift-replay", "n/a", "disposable"), "drift-record-ncsngxlcyxylaeskiteu.json")):
        source = selected.get(key)
        inputs = manifest.get("inputs")
        if not isinstance(inputs, dict) or set(inputs) != {"catalog_record", "platform_record", "drift_record"}:
            raise EvidenceError(f"unexpected shared-readonly input field: {directory}")
        ref = inputs.get(label)
        if source is None or source["manifest"].get("verdict") != "PASS" or source["exit_status"] != 0 or not isinstance(ref, dict) or ref != {"directory": source["directory"], "artifact": artifact, "sha256": source["manifest"].get("artifacts", {}).get(artifact)}:
            raise EvidenceError(f"{label} identity or phase mismatch: {directory}")
        if (source["commit"] == run["commit"] or (manifest["phase"] == "pre" and subprocess.run(["git", "merge-base", "--is-ancestor", source["commit"], run["commit"]], cwd=repo).returncode != 0)
                or not HASH.fullmatch(str(ref["sha256"]))):
            raise EvidenceError(f"{label} not previously sealed: {directory}")
        data = json.loads(blob(repo, source["commit"], source["directory"] + "/" + artifact))
        comparison = output["comparisons"]["catalog" if label in {"catalog_record", "drift_record"} else "platform"]
        if ((label == "catalog_record" and comparison.get("input_sha256") != ref["sha256"])
                or (label == "platform_record" and comparison.get("input_sha256") != ref["sha256"])
                or (label == "drift_record" and comparison.get("drift_record_sha256") != data.get("sha256"))):
            raise EvidenceError(f"{label} consumed hash mismatch: {directory}")
        if label == "catalog_record":
            sections = data.get("section_sha256")
            if (not isinstance(sections, dict) or set(sections) != set(CATALOG_SECTIONS)
                    or any(not isinstance(v, str) or not HASH.fullmatch(v) for v in sections.values())
                    or output["comparisons"]["catalog"].get("verdict") != "PASS"):
                raise EvidenceError(f"catalog mismatch: {directory}")
            validate_catalog_baseline(data, "sealed baseline")
        elif label == "drift_record":
            if data.get("target_ref") != PROJECT_REFS["shared-test"] or data.get("candidate_sha") != run["manifest"].get("tested_sha"):
                raise EvidenceError(f"drift record binding mismatch: {directory}")
            catalog_source = selected.get(("pre-merge", "catalog-fingerprint", "n/a", "disposable"))
            if catalog_source is None:
                raise EvidenceError(f"missing catalog baseline for drift record: {directory}")
            baseline = json.loads(blob(repo, catalog_source["commit"], catalog_source["directory"] + "/catalog-pre.json"))
            reconstructed = reconstruct_drift_catalog(baseline, data)
            if (output["comparisons"]["catalog"].get("observed_section_sha256") != reconstructed["section_sha256"]
                    or output["comparisons"]["catalog"].get("observed_catalog_sha256") != reconstructed["sha256"]):
                raise EvidenceError(f"catalog drift reconstruction mismatch: {directory}")
        else:
            validate_platform(data, require_verified=True, label="consumed")
            observed = output.get("platform_config")
            validate_platform(observed, label="observed")
            platform_comparison = output["comparisons"]["platform"]
            waived_fields = manifest.get("waived_fields")
            waiver_reasons = manifest.get("waiver_reasons")
            expected_waived = ["postgrest_major"] if observed["postgrest_major"] == NOT_VERIFIED else []
            expected_reasons = {"postgrest_major": observed["postgrest_reason"]} if expected_waived else {}
            expected_verdict = "PASS" if not expected_waived else {
                key: NOT_VERIFIED if key in expected_waived else "PASS" for key in PLATFORM_MAJOR_FIELDS
            }
            if (waived_fields != expected_waived or waiver_reasons != expected_reasons
                    or platform_comparison.get("waived_fields") != expected_waived
                    or platform_comparison.get("waiver_reasons") != expected_reasons
                    or platform_comparison.get("verdict") != expected_verdict
                    or manifest.get("waiver_reasons") != expected_reasons
                    or output.get("summary") != hosted_platform_summary(observed["postgrest_major"], observed["postgrest_reason"])):
                raise EvidenceError(f"waived fields mismatch: {directory}")
            if (observed["postgres_major"] != data["postgres_major"]
                    or observed["gotrue_major"] != data["gotrue_major"]
                    or (observed["postgrest_major"] != NOT_VERIFIED and observed["postgrest_major"] != data["postgrest_major"])
                    or (observed["postgrest_observed_major"] is not None and observed["postgrest_observed_major"] != data["postgrest_major"])
                    or platform_comparison.get("observed_sha256") != observed["sha256"]):
                raise EvidenceError(f"platform mismatch: {directory}")


def _check_drift_replay(repo: Path, run: dict, selected: dict) -> None:
    directory = run["directory"]
    manifest = run["manifest"]
    if not isinstance(manifest.get("summary"), dict) or manifest["summary"].get("j5a") != J5A_CATALOG_DRIFT_SUMMARY:
        raise EvidenceError(f"drift replay J5a wording mismatch: {directory}")
    refs = tuple(sorted(KNOWN_TARGET_REFS))
    expected_artifacts = {"catalog-pre.json", "catalog-post.json"}
    for target_ref in refs:
        expected_artifacts.update({
            f"drift-record-{target_ref}.json", f"catalog-pre-{target_ref}.json", f"catalog-post-{target_ref}.json",
            f"pre-readonly-{target_ref}.json", f"post-readonly-{target_ref}.json",
            f"contract-pre-{target_ref}.txt", f"contract-post-{target_ref}.txt",
        })
    if set(manifest.get("artifacts", {})) != expected_artifacts:
        raise EvidenceError(f"drift replay artifact inventory mismatch: {directory}")
    try:
        pre_baseline = json.loads(blob(repo, run["commit"], directory + "/catalog-pre.json"), object_pairs_hook=unique_object_pairs)
        post_baseline = json.loads(blob(repo, run["commit"], directory + "/catalog-post.json"), object_pairs_hook=unique_object_pairs)
    except (ValueError, UnicodeDecodeError) as exc:
        raise EvidenceError(f"invalid drift replay artifact: {directory}") from exc
    def reject_raw_drift(value: object) -> None:
        if isinstance(value, dict):
            for name, child in value.items():
                if name == "canonical_definition":
                    if not isinstance(child, str):
                        raise EvidenceError(f"drift canonical definition must be schema text: {directory}")
                    continue
                if name.lower() in {"sections", "content", "raw_catalog", "access_token", "refresh_token", "apikey", "service_role"}:
                    raise EvidenceError(f"raw catalog/content or token key in drift record: {directory}")
                reject_raw_drift(child)
        elif isinstance(value, list):
            for child in value:
                reject_raw_drift(child)
    validate_catalog_baseline(pre_baseline, "replay PRE baseline")
    validate_catalog_baseline(post_baseline, "replay POST baseline")
    if not SHA.fullmatch(str(manifest.get("tested_sha", ""))):
        raise EvidenceError(f"drift replay candidate binding mismatch: {directory}")
    for target_ref in refs:
        record = json.loads(blob(repo, run["commit"], f"{directory}/drift-record-{target_ref}.json"), object_pairs_hook=unique_object_pairs)
        fixture = read_drift_fixture(repo, run["commit"], target_ref)
        reject_raw_drift(record)
        if record.get("target_ref") != target_ref or record.get("candidate_sha") != manifest.get("tested_sha"):
            raise EvidenceError(f"drift replay item or binding mismatch: {directory} {target_ref}")
        if _drift_bindings(record) != {(item["object"], item["attribute"], item["name"], item["definition_sha256"]) for item in fixture["items"]}:
            raise EvidenceError(f"drift fixture/replay definition mismatch: {directory} {target_ref}")
        reconstructed = reconstruct_drift_catalog(pre_baseline, record, target_ref=target_ref, candidate_sha=manifest["tested_sha"])
        observed_pre = json.loads(blob(repo, run["commit"], f"{directory}/catalog-pre-{target_ref}.json"), object_pairs_hook=unique_object_pairs)
        observed_post = json.loads(blob(repo, run["commit"], f"{directory}/catalog-post-{target_ref}.json"), object_pairs_hook=unique_object_pairs)
        validate_catalog_baseline(observed_pre, f"replay PRE {target_ref}")
        validate_catalog_baseline(observed_post, f"replay POST {target_ref}")
        if reconstructed["sha256"] != observed_pre.get("sha256"):
            raise EvidenceError(f"drift replay PRE mismatch: {directory} {target_ref}")
        reconstructed_post = reconstruct_drift_catalog(post_baseline, record, bound_baseline_digest=pre_baseline["sha256"], target_ref=target_ref, candidate_sha=manifest["tested_sha"])
        if reconstructed_post["sha256"] != observed_post.get("sha256"):
            raise EvidenceError(f"drift replay POST mismatch: {directory} {target_ref}")
        for phase in ("pre", "post"):
            contract = blob(repo, run["commit"], f"{directory}/contract-{phase}-{target_ref}.txt")
            if not contract.strip():
                raise EvidenceError(f"empty real contract evidence: {directory} {target_ref} {phase}")


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
        selected = _require(chain["selected"], APPROVALS["j5a"], repo)
    else:
        if not m or not SHA.fullmatch(m):
            raise EvidenceError("main SHA required for j5b")
        if git(repo, "diff", "--name-only", x_mig, m, "--", "supabase/migrations", "experiments/inbox-production-install").strip():
            raise EvidenceError("migration diff between X_mig and M")
        mig_chain = _find_migration_chain(repo, x_mig)
        main_chain = collect(repo, m, head)
        combined = {key: run for key, run in mig_chain["selected"].items() if key[0] == "pre-merge"}
        combined.update({key: run for key, run in main_chain["selected"].items() if key[0] == "test-env"})
        selected = _require(combined, APPROVALS["j5b"], repo)
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
    def require_job(field: str, name: str, label: str, *, allow_prior_attempt: bool = False) -> None:
        job = workflow.get(field)
        if (not isinstance(job, dict) or job.get("name") != name or job.get("conclusion") != "success"
                or not str(job.get("id", "")).isdigit() or int(job["id"]) <= 0
                or str(job.get("run_id")) != str(workflow["run_id"])
                or not str(job.get("run_attempt", "")).isdigit()
                or int(job["run_attempt"]) < 1
                or (int(job["run_attempt"]) > int(workflow["run_attempt"]) if allow_prior_attempt
                    else int(job["run_attempt"]) != int(workflow["run_attempt"]))):
            raise EvidenceError(f"migration {label} evidence mismatch")

    require_job("apply_job", MIGRATION_APPLY_JOBS[target], "apply job")
    if target == "production":
        require_job("bind_upstream_job", "Bind upstream test run", "bind upstream job", allow_prior_attempt=True)
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
        evidence_chain = _find_migration_chain(Path(repo), x_mig)
        catalog_key = ("pre-merge", "catalog-fingerprint", "n/a", "disposable" if target == "shared-test" else "production")
        replay_key = ("pre-merge", "drift-replay", "n/a", "disposable")
        _require(evidence_chain["selected"], (catalog_key, replay_key), Path(repo))
        pre = evidence_chain["selected"].get(catalog_key)
        if pre is None:
            raise EvidenceError("missing committed target-specific catalog PRE")
        fingerprint_path = pre["manifest"].get("catalog_fingerprint_post_artifact", "catalog-fingerprint-post.json")
        if fingerprint_path not in pre["manifest"]["artifacts"]:
            raise EvidenceError("missing committed catalog fingerprint artifact")
        expected_pre = json.loads(blob(Path(repo), pre["commit"], pre["directory"] + "/catalog-pre.json"))
        expected_base = json.loads(blob(Path(repo), pre["commit"], pre["directory"] + "/" + fingerprint_path))
        observed = manifest.get("catalog_fingerprint_after")
        if not isinstance(observed, dict):
            raise EvidenceError("catalog fingerprint section mismatch")
        pre_chain = evidence_chain["selected"]
        replay = pre_chain.get(replay_key)
        if replay is None:
            raise EvidenceError("missing sealed drift replay for catalog fingerprint")
        if "catalog_drift_record" in manifest:
            raise EvidenceError("migration manifest cannot supply a replacement drift record")
        target_ref = PROJECT_REFS[target]
        drift = json.loads(blob(Path(repo), replay["commit"], f"{replay['directory']}/drift-record-{target_ref}.json"))
        replay_runs = [candidate for candidate in evidence_chain["runs"] if candidate["key"] == replay_key]
        if len(replay_runs) > 1:
            original = json.loads(blob(Path(repo), replay_runs[0]["commit"], f"{replay_runs[0]['directory']}/drift-record-{target_ref}.json"))
            validate_replacement_drift_record(original, drift, replay=drift)
        fixture = read_drift_fixture(Path(repo), replay["commit"], target_ref)
        if _drift_bindings(drift) != {(item["object"], item["attribute"], item["name"], item["definition_sha256"]) for item in fixture["items"]}:
            raise EvidenceError("sealed fixture, replay record, and drift record differ")
        expected = reconstruct_drift_catalog(expected_base, drift, bound_baseline_digest=expected_pre["sha256"], target_ref=target_ref, candidate_sha=x_mig)
        if expected.keys() != observed.keys() or any(expected[k] != observed[k] for k in expected):
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
