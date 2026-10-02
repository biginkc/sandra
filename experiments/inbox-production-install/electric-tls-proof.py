#!/usr/bin/env python3
"""Prove Electric 1.8.1 TLS, readiness, and slot provenance locally.

The sealed path uses the exact image digest in deployment/inbox/candidate.json.
If Docker denies that pull, a source-built image may exercise the harness but
the receipt is explicitly UNSEALED and the command exits with PINNED_PULL_DENIED.
Every disposable container, network, and image pulled/built by this process is
removed in finally; no existing container or Homebrew PostgreSQL service is
touched.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))
from electric_image_contract import (  # noqa: E402
    CandidateError,
    ElectricImagePin,
    EIMG_SIGNER_WORKFLOW,
    EIMG_SOURCE_REF,
    EIMG_WORKFLOW_PATH,
    ROOT,
    verify_attestation_json,
    verify_labels_json,
    verify_run_evidence_json,
    verify_workflow_text,
    load_electric_pin,
)


ELECTRIC_SOURCE_IMAGE = "sandra-r1-electric:1.8.1-source"
ELECTRIC_SOURCE_REF = "@core/sync-service@1.8.1"
POSTGRES_IMAGE = "postgres:17"
CA_CONTAINER_PATH = "/etc/sandra-inbox/supabase-prod-ca-2021.crt"
ELECTRIC_SECRET = "sandra-electric-proof-shape-secret"
POSTGRES_PASSWORD = "sandra-electric-proof-password"
EVIDENCE_PATH = HERE / "electric-tls-evidence.json"


class ProofError(RuntimeError):
    pass


def redact(text: str) -> str:
    return text.replace(ELECTRIC_SECRET, "<redacted-electric-secret>").replace(POSTGRES_PASSWORD, "<redacted-postgres-password>")


def run(args: list[str], *, check: bool = True, timeout: int = 120, text: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(args, text=text, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise ProofError(f"command failed ({result.returncode}): {redact(' '.join(args))}\n{redact((result.stderr + result.stdout)[-5000:])}")
    return result


def docker(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run(["docker", *args], check=check, timeout=timeout)


def docker_text(*args: str, check: bool = True, timeout: int = 120) -> str:
    return docker(*args, check=check, timeout=timeout).stdout.strip()


def openssl(*args: str) -> None:
    run(["openssl", *args], timeout=60)


def image_exists(image: str) -> bool:
    return docker("image", "inspect", image, check=False, timeout=20).returncode == 0


def inspect_repo_digest(image: str, expected_repo_digest: str) -> str:
    result = docker("image", "inspect", "--format", "{{index .RepoDigests 0}}", image, check=False, timeout=20)
    if result.returncode:
        raise ProofError(f"docker inspect could not read RepoDigest for {image}: {(result.stderr + result.stdout).strip()}")
    digest = result.stdout.strip()
    if digest != expected_repo_digest:
        raise ProofError(f"PINNED_REPO_DIGEST_MISMATCH: docker inspect returned {digest!r}, expected {expected_repo_digest!r}")
    return digest


def ensure_pinned_image(pin: ElectricImagePin) -> tuple[str | None, bool, str | None]:
    existed = image_exists(pin.image)
    if not existed:
        pulled = docker("pull", pin.image, check=False, timeout=900)
        if pulled.returncode:
            return None, False, (pulled.stderr + pulled.stdout).strip()
    try:
        digest = inspect_repo_digest(pin.image, pin.repository_digest)
    except Exception:
        if not existed:
            docker("image", "rm", pin.image, check=False, timeout=120)
        raise
    return pin.image, not existed, digest


def verify_attestation(pin: ElectricImagePin) -> dict[str, object]:
    result = run(
        [
            "gh",
            "attestation",
            "verify",
            pin.oci_uri,
            "--owner",
            "biginkc",
            "--signer-workflow",
            EIMG_SIGNER_WORKFLOW,
            "--source-ref",
            EIMG_SOURCE_REF,
            "--deny-self-hosted-runners",
            "--format",
            "json",
        ],
        check=False,
        timeout=120,
    )
    if result.returncode:
        raise ProofError(f"EIMG_ATTESTATION_FAILED: {redact((result.stderr + result.stdout)[-5000:])}")
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProofError(f"EIMG_ATTESTATION_INVALID_JSON: {exc}") from exc
    try:
        return verify_attestation_json(pin, payload)
    except CandidateError as exc:
        raise ProofError(str(exc)) from exc


def verify_workflow_at_commit(attestation: dict[str, object], workflow_text: str | bytes | None = None) -> dict[str, str]:
    source_commit = attestation.get("source_repository_digest")
    if not isinstance(source_commit, str):
        raise ProofError("EIMG_WORKFLOW_FAILED: attestation did not provide source commit S")
    workflow_source = "provided workflow text"
    if workflow_text is None:
        result = run(["git", "-C", str(ROOT), "show", f"{source_commit}:{EIMG_WORKFLOW_PATH}"], check=False, timeout=30, text=False)
        if result.returncode == 0:
            workflow_text = result.stdout
            workflow_source = "local git show"
        else:
            result = run(
                [
                    "gh",
                    "api",
                    f"repos/biginkc/sandra/contents/{EIMG_WORKFLOW_PATH}?ref={source_commit}",
                    "--jq",
                    ".content",
                ],
                check=False,
                timeout=60,
            )
            if result.returncode:
                raise ProofError(f"EIMG_WORKFLOW_FAILED: workflow at S was not found: {redact((result.stderr + result.stdout)[-4000:])}")
            try:
                workflow_text = base64.b64decode(result.stdout.strip(), validate=True)
                workflow_text.decode("utf-8")
                workflow_source = "gh api"
            except (ValueError, UnicodeDecodeError) as exc:
                raise ProofError(f"EIMG_WORKFLOW_FAILED: workflow contents at S are not valid base64 or UTF-8 bytes: {exc}") from exc
    try:
        verified = verify_workflow_text(workflow_text)
    except CandidateError as exc:
        raise ProofError(str(exc)) from exc
    return {**verified, "workflow_source": workflow_source}


def _gh_json(args: list[str], *, timeout: int = 60) -> object:
    result = run(args, check=False, timeout=timeout)
    if result.returncode:
        raise ProofError(f"EIMG_RUN_EVIDENCE_FAILED: gh query failed: {redact((result.stderr + result.stdout)[-4000:])}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise ProofError(f"EIMG_RUN_EVIDENCE_FAILED: gh query returned invalid JSON: {exc}") from exc


def _download_evidence_artifact(run_id: int, artifact_name: str) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix=".sandra-r1-electric-evidence-") as temp:
        result = run(
            [
                "gh",
                "run",
                "download",
                str(run_id),
                "--repo",
                "biginkc/sandra",
                "--name",
                artifact_name,
                "--dir",
                temp,
            ],
            check=False,
            timeout=120,
        )
        if result.returncode:
            raise ProofError(f"EIMG_RUN_EVIDENCE_FAILED: evidence artifact download failed: {redact((result.stderr + result.stdout)[-4000:])}")
        files = sorted(path for path in Path(temp).rglob("*") if path.is_file())
        if len(files) != 1:
            raise ProofError("EIMG_RUN_EVIDENCE_FAILED: evidence artifact did not contain exactly one file")
        try:
            value = json.loads(files[0].read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise ProofError(f"EIMG_RUN_EVIDENCE_FAILED: evidence artifact is not valid JSON: {exc}") from exc
        if not isinstance(value, dict):
            raise ProofError("EIMG_RUN_EVIDENCE_FAILED: evidence artifact JSON is not an object")
        value = dict(value)
        value["name"] = artifact_name
        return value


def verify_run_evidence(pin: ElectricImagePin, attestation: dict[str, object], *, run_payload: object | None = None, artifact_payload: object | None = None) -> dict[str, object]:
    run_id = attestation.get("run_id")
    if not isinstance(run_id, int) or isinstance(run_id, bool):
        raise ProofError("EIMG_RUN_EVIDENCE_FAILED: attestation did not provide run R")
    if run_payload is None:
        run_payload = _gh_json(["gh", "api", f"repos/biginkc/sandra/actions/runs/{run_id}"])
    if artifact_payload is None:
        artifacts_payload = _gh_json(["gh", "api", f"repos/biginkc/sandra/actions/runs/{run_id}/artifacts"])
        artifacts = artifacts_payload.get("artifacts") if isinstance(artifacts_payload, dict) else None
        artifact_name = f"inbox-electric-image-evidence-{run_id}"
        matching = next((item for item in artifacts or [] if isinstance(item, dict) and item.get("name") == artifact_name), None)
        if matching is None:
            raise ProofError("EIMG_RUN_EVIDENCE_FAILED: workflow evidence artifact is absent")
        artifact_payload = _download_evidence_artifact(run_id, artifact_name)
    try:
        return verify_run_evidence_json(pin, attestation, run_payload, artifact_payload)
    except CandidateError as exc:
        raise ProofError(str(exc)) from exc


def verify_labels(pin: ElectricImagePin, image: str) -> dict[str, str]:
    result = docker("image", "inspect", "--format", "{{json .Config.Labels}}", image, check=False, timeout=20)
    if result.returncode:
        raise ProofError(f"EIMG_LABELS_UNREADABLE: {(result.stderr + result.stdout).strip()}")
    try:
        labels = json.loads(result.stdout)
        return verify_labels_json(labels)
    except (json.JSONDecodeError, CandidateError) as exc:
        raise ProofError(str(exc)) from exc


def ensure_image(image: str) -> bool:
    if image_exists(image):
        return False
    docker("pull", image, timeout=900)
    return True


def wait_postgres(container: str) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        state = docker_text("inspect", "-f", "{{.State.Status}}", container, check=False, timeout=10)
        if state in {"exited", "dead"}:
            raise ProofError(f"Postgres exited before readiness:\n{docker_text('logs', container, check=False)[-5000:]}")
        if docker("exec", container, "pg_isready", "-U", "postgres", check=False, timeout=10).returncode == 0:
            return
        time.sleep(1)
    raise ProofError("Postgres did not become ready")


def electric_port(container: str) -> int:
    return int(docker_text("port", container, "3000/tcp").rsplit(":", 1)[-1])


def health(port: int) -> dict[str, object]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=2) as response:
            body = response.read(4096).decode("utf-8", "replace")
            status = response.status
    except urllib.error.HTTPError as error:
        body, status = error.read(4096).decode("utf-8", "replace"), error.code
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return {"status_code": None, "body": str(error)}
    try:
        parsed = json.loads(body)
    except json.JSONDecodeError:
        parsed = None
    return {"status_code": status, "body": body, "json": parsed}


def wait_active(port: int, seconds: int = 90) -> dict[str, object]:
    deadline = time.monotonic() + seconds
    last = health(port)
    while time.monotonic() < deadline:
        last = health(port)
        if last.get("status_code") == 200 and isinstance(last.get("json"), dict) and last["json"].get("status") == "active":
            return last
        time.sleep(1)
    return last


def certs(root: Path) -> tuple[Path, Path]:
    ca_key, ca_crt = root / "ca.key", root / "ca.crt"
    server_key, server_csr, server_crt = root / "server.key", root / "server.csr", root / "server.crt"
    wrong_ca_key, wrong_ca = root / "wrong-ca.key", root / "wrong-ca.crt"
    extensions = root / "server.ext"
    extensions.write_text("subjectAltName=DNS:postgres\n", encoding="utf-8")
    openssl("genrsa", "-out", str(ca_key), "2048")
    openssl("req", "-x509", "-new", "-nodes", "-key", str(ca_key), "-sha256", "-days", "1", "-subj", "/CN=Sandra Electric proof CA", "-out", str(ca_crt))
    openssl("genrsa", "-out", str(server_key), "2048")
    openssl("req", "-new", "-key", str(server_key), "-subj", "/CN=postgres", "-out", str(server_csr))
    openssl("x509", "-req", "-in", str(server_csr), "-CA", str(ca_crt), "-CAkey", str(ca_key), "-CAcreateserial", "-out", str(server_crt), "-days", "1", "-sha256", "-extfile", str(extensions))
    openssl("genrsa", "-out", str(wrong_ca_key), "2048")
    openssl("req", "-x509", "-new", "-nodes", "-key", str(wrong_ca_key), "-sha256", "-days", "1", "-subj", "/CN=Wrong CA", "-out", str(wrong_ca))
    server_key.chmod(0o600)
    for path in (ca_crt, server_crt, wrong_ca):
        path.chmod(0o644)
    return ca_crt, wrong_ca


def build_official_electric(root: Path) -> None:
    archive = root / "electric.tar.gz"
    request = urllib.request.Request("https://github.com/electric-sql/electric/archive/refs/tags/%40core/sync-service%401.8.1.tar.gz", headers={"user-agent": "sandra-r1-electric-tls-proof"})
    with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as handle:
        shutil.copyfileobj(response, handle)
    source_parent = root / "source"
    source_parent.mkdir()
    run(["tar", "-xzf", str(archive), "-C", str(source_parent)], timeout=120)
    extracted = next(source_parent.iterdir())
    sync_service = extracted / "packages/sync-service"
    shutil.copytree(extracted / "packages/electric-telemetry", sync_service / "electric-telemetry")
    dockerfile = sync_service / "Dockerfile"
    dockerfile.write_text(dockerfile.read_text(encoding="utf-8").replace("COPY --from=electric-telemetry / /builder/electric-telemetry", "COPY electric-telemetry /builder/electric-telemetry"), encoding="utf-8")
    docker("build", "--build-arg", "ELECTRIC_VERSION=1.8.1", "-t", ELECTRIC_SOURCE_IMAGE, "-f", str(dockerfile), str(sync_service), timeout=1800)


def psql(container: str, sql: str) -> str:
    return docker_text("exec", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql, timeout=30)


def slots(container: str) -> list[dict[str, str]]:
    raw = psql(container, "SELECT slot_name, COALESCE(plugin,''), COALESCE(database::text,''), active::text FROM pg_replication_slots ORDER BY slot_name;")
    result = []
    for line in raw.splitlines():
        fields = line.split("|")
        if len(fields) != 4:
            raise ProofError(f"unexpected replication-slot output: {raw}")
        result.append({"slot_name": fields[0], "plugin": fields[1], "database": fields[2], "active": fields[3]})
    return result


def ssl_backend_count(container: str, stream: str) -> int:
    slot_name = "electric_slot_" + stream
    return int(psql(container, f"SELECT count(*) FROM pg_replication_slots r JOIN pg_stat_ssl s ON s.pid = r.active_pid WHERE r.slot_name='{slot_name}' AND r.active_pid IS NOT NULL AND s.ssl = true;") or "0")


def tls_error(logs: str, expected_token: str) -> bool:
    return expected_token in logs


def start_electric(container: str, image: str, network: str, ca: Path, database_host: str, stream: str) -> int:
    database_url = f"postgresql://postgres:{POSTGRES_PASSWORD}@{database_host}:5432/postgres?sslmode=require"
    docker("run", "-d", "--name", container, "--network", network, "-p", "127.0.0.1::3000", "-e", "DATABASE_URL=" + database_url, "-e", "ELECTRIC_DATABASE_CA_CERTIFICATE_FILE=" + CA_CONTAINER_PATH, "-e", "ELECTRIC_SECRET=" + ELECTRIC_SECRET, "-e", "ELECTRIC_MANUAL_TABLE_PUBLISHING=true", "-e", "ELECTRIC_REPLICATION_STREAM_ID=" + stream, "-e", "ELECTRIC_TELEMETRY=false", "-e", "ELECTRIC_LONG_POLL_TIMEOUT=8000", "-v", f"{ca}:{CA_CONTAINER_PATH}:ro", image, timeout=180)
    return electric_port(container)


def assert_new_slot(before: list[dict[str, str]], after: list[dict[str, str]], stream: str) -> dict[str, str]:
    baseline_names = {row["slot_name"] for row in before}
    new_slots = [row for row in after if row["slot_name"] not in baseline_names]
    expected = "electric_slot_" + stream
    if len(new_slots) != 1 or new_slots[0]["slot_name"] != expected or new_slots[0]["plugin"] != "pgoutput" or new_slots[0]["database"] != "postgres":
        raise ProofError(f"expected exactly one new pgoutput slot {expected}, found {new_slots}")
    return new_slots[0]


def stop_container(container: str) -> None:
    docker("rm", "-f", container, check=False, timeout=60)


def run_contract(image: str, ca_crt: Path, wrong_ca: Path, network: str, postgres: str, names: list[str], status: dict[str, object]) -> None:
    streams = ["inbox_tlsproof_right", "inbox_tlsproof_wrong_ca", "inbox_tlsproof_wrong_hostname", "inbox_tlsproof_wrong_ca_fixed", "inbox_tlsproof_wrong_hostname_fixed"]
    psql(postgres, "CREATE SCHEMA inbox_bridge; CREATE TABLE inbox_bridge.projection(org_id uuid NOT NULL, target_kind text NOT NULL, target_id uuid NOT NULL, name text, context text, preview text, time_label text, outcome_label text, assigned_label text, unread boolean, PRIMARY KEY(org_id,target_kind,target_id));")
    for stream in streams:
        psql(postgres, f"CREATE PUBLICATION electric_publication_{stream} FOR TABLE inbox_bridge.projection;")

    right, right_stream = names[0], streams[0]
    before = slots(postgres)
    port = start_electric(right, image, network, ca_crt, "postgres", right_stream)
    right_health = wait_active(port)
    # Capture the log while the backend/slot are still observable. The log is
    # the proof that the negative cases failed in TLS, not merely in startup.
    right_logs = redact(docker_text("logs", right, check=False)[-5000:])
    right_slot = assert_new_slot(before, slots(postgres), right_stream)
    right_ssl = ssl_backend_count(postgres, right_stream)
    status["right_ca"] = {"health": right_health, "slot": right_slot, "pg_stat_ssl_backend_count": right_ssl, "logs_tail": right_logs}
    if right_health.get("status_code") != 200 or not isinstance(right_health.get("json"), dict) or right_health["json"].get("status") != "active":
        raise ProofError(f"right-CA health did not reach 200 active: {right_health}")
    if right_ssl < 1:
        raise ProofError("Electric has no pg_stat_ssl ssl=t backend")
    stop_container(right)

    negative_cases = [
        (names[1], streams[1], wrong_ca, "postgres", "unknown_ca", "wrong_ca"),
        (names[2], streams[2], ca_crt, "electric-dsn-mismatch", "hostname_check_failed", "wrong_hostname"),
    ]
    for container, stream, ca, host, expected_tls_token, key in negative_cases:
        port = start_electric(container, image, network, ca, host, stream)
        result = wait_active(port, seconds=20)
        logs = redact(docker_text("logs", container, check=False)[-5000:])
        running = docker_text("inspect", "-f", "{{.State.Running}}", container, check=False) == "true"
        expected_name = "electric_slot_" + stream
        present = any(row["slot_name"] == expected_name for row in slots(postgres))
        has_tls_error = tls_error(logs, expected_tls_token)
        status[key] = {"health": result, "running_after_timeout": running, "slot_present": present, "tls_error_token": expected_tls_token, "tls_error_in_logs": has_tls_error, "logs_tail": logs}
        if result.get("status_code") == 200 and isinstance(result.get("json"), dict) and result["json"].get("status") == "active":
            raise ProofError(f"{key} unexpectedly reached active")
        if present or not has_tls_error:
            raise ProofError(f"{key} did not fail as a TLS negative")
        stop_container(container)

    # Natural negative mutations: replacing the wrong CA/hostname with the
    # reviewed value must make the corresponding control pass.
    controls = [
        (names[3], streams[3], ca_crt, "postgres", "wrong_ca_mutation_fixed"),
        (names[4], streams[4], ca_crt, "postgres", "wrong_hostname_mutation_fixed"),
    ]
    for container, stream, ca, host, key in controls:
        before = slots(postgres)
        port = start_electric(container, image, network, ca, host, stream)
        result = wait_active(port)
        slot = assert_new_slot(before, slots(postgres), stream)
        ssl_count = ssl_backend_count(postgres, stream)
        status[key] = {"health": result, "slot": slot, "pg_stat_ssl_backend_count": ssl_count}
        if result.get("status_code") != 200 or not isinstance(result.get("json"), dict) or result["json"].get("status") != "active" or ssl_count < 1:
            raise ProofError(f"mutation control {key} did not pass: {result}")
        stop_container(container)
    psql(postgres, "DROP SCHEMA inbox_bridge CASCADE;")


def main() -> int:
    suffix = uuid.uuid4().hex[:12]
    network = f"sandra-r1-electric-tls-{suffix}"
    postgres = f"sandra-r1-electric-tls-postgres-{suffix}"
    names = [
        f"sandra-r1-electric-tls-electric-right-{suffix}",
        f"sandra-r1-electric-tls-electric-wrong-ca-{suffix}",
        f"sandra-r1-electric-tls-electric-wrong-hostname-{suffix}",
        f"sandra-r1-electric-tls-electric-wrong-ca-fixed-{suffix}",
        f"sandra-r1-electric-tls-electric-wrong-hostname-fixed-{suffix}",
    ]
    evidence_path = EVIDENCE_PATH
    pin = load_electric_pin()
    status: dict[str, object] = {"published_electric_image": pin.image, "pinned_repo_digest": pin.repository_digest, "source_commit": pin.source_commit, "attestation": pin.attestation, "electric_source_ref": ELECTRIC_SOURCE_REF, "postgres_image": POSTGRES_IMAGE, "ca_env": "ELECTRIC_DATABASE_CA_CERTIFICATE_FILE", "ca_container_path": CA_CONTAINER_PATH, "network": network, "seal_status": "UNSEALED"}
    created_network = False
    created_postgres_image = False
    created_electric_image = False
    active_image: str | None = None
    try:
        with tempfile.TemporaryDirectory(prefix=".sandra-r1-electric-tls-", dir=HERE) as temp:
            root = Path(temp)
            ca_crt, wrong_ca = certs(root)
            try:
                pin.require_ready()
            except CandidateError as exc:
                raise ProofError(str(exc)) from exc
            active_image, created_electric_image, repo_digest = ensure_pinned_image(pin)
            status["docker_inspect_repo_digest"] = repo_digest
            if active_image is None:
                pull_error = repo_digest or "pinned Electric image pull was denied"
                status["pinned_pull_error"] = pull_error
                status["pinned_pull_verdict"] = "PINNED_PULL_DENIED"
                try:
                    if image_exists(ELECTRIC_SOURCE_IMAGE):
                        raise ProofError(f"refusing to overwrite pre-existing source image {ELECTRIC_SOURCE_IMAGE}")
                    build_official_electric(root)
                    created_electric_image = True
                    active_image = ELECTRIC_SOURCE_IMAGE
                    status["source_harness"] = "UNSEALED"
                    docker("network", "create", network)
                    created_network = True
                    created_postgres_image = ensure_image(POSTGRES_IMAGE)
                    docker("run", "-d", "--name", postgres, "--network", network, "--network-alias", "postgres", "--network-alias", "electric-dsn-mismatch", "-e", "POSTGRES_PASSWORD=" + POSTGRES_PASSWORD, "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", "-v", f"{root}:/input:ro", POSTGRES_IMAGE, "bash", "-c", "cp /input/server.crt /var/lib/postgresql/server.crt && cp /input/server.key /var/lib/postgresql/server.key && cp /input/ca.crt /var/lib/postgresql/ca.crt && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key /var/lib/postgresql/ca.crt && chmod 600 /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key -c ssl_ca_file=/var/lib/postgresql/ca.crt -c wal_level=logical -c max_replication_slots=12", timeout=180)
                    wait_postgres(postgres)
                    run_contract(active_image, ca_crt, wrong_ca, network, postgres, names, status)
                except Exception as source_error:
                    status["source_harness_error"] = redact(str(source_error))
                evidence_path.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                evidence_path.chmod(0o600)
                print(json.dumps(status, indent=2, sort_keys=True))
                raise ProofError(f"PINNED_PULL_DENIED: {pull_error}")

            attestation = verify_attestation(pin)
            status["attestation"] = attestation
            status["workflow"] = verify_workflow_at_commit(attestation)
            status["run_evidence"] = verify_run_evidence(pin, attestation)
            status["oci_labels"] = verify_labels(pin, active_image)
            status["source_harness"] = "not-used"
            docker("network", "create", network)
            created_network = True
            created_postgres_image = ensure_image(POSTGRES_IMAGE)
            docker("run", "-d", "--name", postgres, "--network", network, "--network-alias", "postgres", "--network-alias", "electric-dsn-mismatch", "-e", "POSTGRES_PASSWORD=" + POSTGRES_PASSWORD, "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", "-v", f"{root}:/input:ro", POSTGRES_IMAGE, "bash", "-c", "cp /input/server.crt /var/lib/postgresql/server.crt && cp /input/server.key /var/lib/postgresql/server.key && cp /input/ca.crt /var/lib/postgresql/ca.crt && chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key /var/lib/postgresql/ca.crt && chmod 600 /var/lib/postgresql/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key -c ssl_ca_file=/var/lib/postgresql/ca.crt -c wal_level=logical -c max_replication_slots=12", timeout=180)
            wait_postgres(postgres)
            run_contract(active_image, ca_crt, wrong_ca, network, postgres, names, status)
            status["evidence_bar"] = {"health": "200 active", "new_slot": "exactly one per passing stream, pgoutput/postgres", "pg_stat_ssl": "ssl=t backend required", "timeout_202": "fail"}
            status["seal_status"] = "SEALED"
            evidence_path.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            evidence_path.chmod(0o600)
            print(json.dumps(status, indent=2, sort_keys=True))
            return 0
    except Exception as exc:
        status["error"] = redact(str(exc))
        status["seal_status"] = "UNSEALED"
        evidence_path.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        evidence_path.chmod(0o600)
        raise
    finally:
        if created_network or active_image or created_postgres_image or created_electric_image:
            for container in reversed(names + [postgres]):
                stop_container(container)
        if created_network:
            docker("network", "rm", network, check=False, timeout=60)
        if created_electric_image and active_image:
            docker("image", "rm", active_image, check=False, timeout=120)
        if created_postgres_image:
            docker("image", "rm", POSTGRES_IMAGE, check=False, timeout=120)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProofError, OSError, subprocess.SubprocessError) as exc:
        print(f"Electric TLS proof failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
