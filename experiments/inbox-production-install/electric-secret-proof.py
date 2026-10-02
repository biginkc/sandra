#!/usr/bin/env python3
"""Exercise the relay/Electric secret boundary with disposable containers.

The Electric container must be the exact candidate digest.  A denied pinned
pull is recorded as PINNED_PULL_DENIED and is never replaced with a source
build or another image.  The proof owns only its generated container, network,
and relay image; it does not use the Homebrew PostgreSQL service.
"""

from __future__ import annotations

import base64
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
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
    load_electric_pin,
    verify_attestation_json,
    verify_labels_json,
    verify_run_evidence_json,
    verify_workflow_text,
)


POSTGRES_IMAGE = "postgres:17"
POSTGRES_PASSWORD = "sandra-electric-secret-proof-password"
RELAY_TOKEN = "sandra-electric-secret-proof-relay-token"
ELECTRIC_SECRET = "sandra-electric-secret-proof-electric-secret"
WRONG_ELECTRIC_SECRET = "sandra-electric-secret-proof-wrong-secret"
STREAM = "inbox_secretproof"
PROJECTION = "inbox_bridge.projection"
EVIDENCE_PATH = HERE / "electric-secret-evidence.json"


class ProofError(RuntimeError):
    pass


def redact(text: str) -> str:
    return text.replace(RELAY_TOKEN, "<redacted-relay-token>").replace(ELECTRIC_SECRET, "<redacted-electric-secret>").replace(WRONG_ELECTRIC_SECRET, "<redacted-wrong-secret>").replace(POSTGRES_PASSWORD, "<redacted-postgres-password>")


def run(args: list[str], *, check: bool = True, timeout: int = 120, text: bool = True) -> subprocess.CompletedProcess:
    result = subprocess.run(args, text=text, capture_output=True, timeout=timeout, check=False)
    if check and result.returncode:
        raise ProofError(f"command failed ({result.returncode}): {redact(' '.join(args))}\n{redact((result.stderr + result.stdout)[-4000:])}")
    return result


def docker(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run(["docker", *args], check=check, timeout=timeout)


def docker_text(*args: str, check: bool = True, timeout: int = 120) -> str:
    return docker(*args, check=check, timeout=timeout).stdout.strip()


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
        raise ProofError(f"EIMG_ATTESTATION_FAILED: {redact((result.stderr + result.stdout)[-4000:])}")
    try:
        payload = json.loads(result.stdout)
        return verify_attestation_json(pin, payload)
    except (json.JSONDecodeError, CandidateError) as exc:
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
        return verify_labels_json(json.loads(result.stdout))
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
            raise ProofError(f"Postgres exited before readiness:\n{docker_text('logs', container, check=False)[-4000:]}")
        if docker("exec", container, "pg_isready", "-U", "postgres", check=False, timeout=10).returncode == 0:
            return
        time.sleep(1)
    raise ProofError("Postgres did not become ready")


def psql(container: str, sql: str) -> str:
    return docker_text("exec", container, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql, timeout=30)


def electric_port(container: str) -> int:
    return int(docker_text("port", container, "3000/tcp").rsplit(":", 1)[-1])


def health(port: int) -> tuple[int | None, str]:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=2) as response:
            return response.status, response.read(4096).decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, error.read(4096).decode("utf-8", "replace")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return None, str(error)


def wait_active(port: int) -> tuple[int | None, str]:
    deadline = time.monotonic() + 90
    result = health(port)
    while time.monotonic() < deadline:
        result = health(port)
        try:
            active = result[0] == 200 and json.loads(result[1]).get("status") == "active"
        except (json.JSONDecodeError, AttributeError):
            active = False
        if active:
            return result
        time.sleep(1)
    return result


def request(base: str, path: str, token: str | None) -> tuple[int, dict[str, str], bytes]:
    headers = {"Authorization": f"Bearer {token}"} if token is not None else {}
    try:
        with urllib.request.urlopen(urllib.request.Request(base + path, headers=headers), timeout=16) as response:
            return response.status, dict(response.headers.items()), response.read(2_100_000)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers.items()), error.read(2_100_000)


def main() -> int:
    suffix = uuid.uuid4().hex[:12]
    network = f"sandra-r1-electric-secret-{suffix}"
    postgres = f"sandra-r1-electric-secret-postgres-{suffix}"
    electric = f"sandra-r1-electric-secret-electric-{suffix}"
    relay = f"sandra-r1-electric-secret-relay-{suffix}"
    wrong_relay = f"sandra-r1-electric-secret-wrong-relay-{suffix}"
    relay_image = f"sandra-r1-electric-secret-relay-image:{suffix}"
    evidence_path = EVIDENCE_PATH
    pin = load_electric_pin()
    status: dict[str, object] = {
        "published_electric_image": pin.image,
        "pinned_repo_digest": pin.repository_digest,
        "source_commit": pin.source_commit,
        "attestation": pin.attestation,
        "stream": STREAM,
        "projection": PROJECTION,
        "seal_status": "UNSEALED",
    }
    created_network = False
    created_postgres_image = False
    created_electric_image = False
    created_relay_image = False
    active_image: str | None = None
    try:
        try:
            pin.require_ready()
        except CandidateError as exc:
            raise ProofError(str(exc)) from exc
        active_image, created_electric_image, repo_digest = ensure_pinned_image(pin)
        status["docker_inspect_repo_digest"] = repo_digest
        if active_image is None:
            error = repo_digest or "pinned Electric image pull was denied"
            status["pinned_pull_error"] = error
            status["pinned_pull_verdict"] = "PINNED_PULL_DENIED"
            evidence_path.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            evidence_path.chmod(0o600)
            print(json.dumps(status, indent=2, sort_keys=True))
            raise ProofError(f"PINNED_PULL_DENIED: {error}")

        inspect_repo_digest(active_image, pin.repository_digest)
        attestation = verify_attestation(pin)
        status["attestation"] = attestation
        status["workflow"] = verify_workflow_at_commit(attestation)
        status["run_evidence"] = verify_run_evidence(pin, attestation)
        status["oci_labels"] = verify_labels(pin, active_image)
        created_postgres_image = ensure_image(POSTGRES_IMAGE)
        docker("network", "create", network)
        created_network = True
        docker(
            "run", "-d", "--name", postgres, "--network", network,
            "--network-alias", "postgres", "-e", f"POSTGRES_PASSWORD={POSTGRES_PASSWORD}",
            "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256", POSTGRES_IMAGE,
            "postgres", "-c", "wal_level=logical", "-c", "max_replication_slots=4",
        )
        wait_postgres(postgres)
        psql(postgres, f"CREATE SCHEMA inbox_bridge; CREATE TABLE {PROJECTION}(org_id uuid NOT NULL,target_kind text NOT NULL,target_id uuid NOT NULL,name text,context text,preview text,time_label text,outcome_label text,assigned_label text,unread boolean,PRIMARY KEY(org_id,target_kind,target_id)); ALTER TABLE {PROJECTION} REPLICA IDENTITY FULL; CREATE PUBLICATION electric_publication_{STREAM} FOR TABLE {PROJECTION};")
        docker("build", "-t", relay_image, str(HERE.parent.parent / "services/inbox-sync-relay"), timeout=600)
        created_relay_image = True
        docker(
            "run", "-d", "--name", electric, "--network", network,
            "--network-alias", "electric.railway.internal", "-p", "127.0.0.1::3000",
            "-e", f"DATABASE_URL=postgresql://postgres:{POSTGRES_PASSWORD}@postgres:5432/postgres?sslmode=disable",
            "-e", f"ELECTRIC_SECRET={ELECTRIC_SECRET}", "-e", "ELECTRIC_MANUAL_TABLE_PUBLISHING=true",
            "-e", f"ELECTRIC_REPLICATION_STREAM_ID={STREAM}", "-e", "ELECTRIC_TELEMETRY=false",
            "-e", "ELECTRIC_LONG_POLL_TIMEOUT=8000", active_image,
        )
        electric_status = wait_active(electric_port(electric))
        status["electric_health"] = {"status_code": electric_status[0], "body": electric_status[1]}
        if electric_status[0] != 200 or json.loads(electric_status[1]).get("status") != "active":
            raise ProofError(f"Electric did not become active: {electric_status}")

        def start_relay(container: str, secret: str) -> str:
            docker(
                "run", "-d", "--name", container, "--network", network,
                "-p", "127.0.0.1::3000", "-e", "INBOX_RELAY_UPSTREAM=http://electric.railway.internal:3000/",
                "-e", f"INBOX_RELAY_TOKEN={RELAY_TOKEN}", "-e", f"INBOX_ELECTRIC_SECRET={secret}",
                "-e", f"INBOX_RELAY_PROJECTION_TABLE={PROJECTION}", relay_image,
            )
            port = docker_text("port", container, "3000/tcp").rsplit(":", 1)[-1]
            return f"http://127.0.0.1:{port}"

        relay_base = start_relay(relay, ELECTRIC_SECRET)
        for _ in range(30):
            if request(relay_base, "/health", None)[0] == 200:
                break
            time.sleep(0.25)
        else:
            raise ProofError("relay readiness failed")
        query = urllib.parse.urlencode({"table": PROJECTION, "columns": "org_id,target_kind,target_id,name,context,preview,time_label,outcome_label,assigned_label,unread", "replica": "default", "offset": "-1"})
        direct_status, _, _ = request(f"http://127.0.0.1:{electric_port(electric)}", f"/v1/shape?{query}", None)
        if direct_status != 401:
            raise ProofError(f"direct Electric request without secret was not rejected: {direct_status}")
        relay_status, relay_headers, relay_body = request(relay_base, f"/v1/shape?{query}", RELAY_TOKEN)
        header_names = {name.lower() for name in relay_headers}
        if relay_status != 200 or not {"electric-offset", "electric-handle"}.issubset(header_names):
            raise ProofError(f"relay shape did not return Electric response headers: {relay_status}, {sorted(header_names)}")
        if any(secret.encode() in relay_body for secret in (RELAY_TOKEN, ELECTRIC_SECRET, WRONG_ELECTRIC_SECRET)):
            raise ProofError("secret appeared in successful relay body")

        docker("network", "disconnect", network, relay)
        client_secret_status, _, client_secret_body = request(relay_base, f"/v1/shape?{query}&secret=client-visible-secret", RELAY_TOKEN)
        if client_secret_status != 400 or client_secret_body:
            raise ProofError(f"client secret was not rejected before upstream: {client_secret_status}")
        docker("network", "connect", network, relay)

        wrong_base = start_relay(wrong_relay, WRONG_ELECTRIC_SECRET)
        wrong_status, _, wrong_body = request(wrong_base, f"/v1/shape?{query}", RELAY_TOKEN)
        if wrong_status not in (401, 502) or any(secret.encode() in wrong_body for secret in (RELAY_TOKEN, ELECTRIC_SECRET, WRONG_ELECTRIC_SECRET)):
            raise ProofError(f"wrong Electric secret was not rejected without leakage: {wrong_status}")
        relay_logs = docker_text("logs", relay, check=False)
        wrong_relay_logs = docker_text("logs", wrong_relay, check=False)
        electric_logs = docker_text("logs", electric, check=False)
        if any(secret in relay_logs + wrong_relay_logs + electric_logs for secret in (RELAY_TOKEN, ELECTRIC_SECRET, WRONG_ELECTRIC_SECRET)):
            raise ProofError("secret appeared in relay or Electric logs")
        status.update({
            "checks": {
                "relay_bearer_and_electric_headers": True,
                "direct_electric_without_secret_401": True,
                "client_secret_rejected_before_upstream": True,
                "wrong_electric_secret_rejected_without_leak": True,
                "logs_redacted": True,
            },
            "client_secret_status": client_secret_status,
            "wrong_secret_status": wrong_status,
        })
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
        if created_network or active_image or created_postgres_image or created_electric_image or created_relay_image:
            for container in (wrong_relay, relay, electric, postgres):
                docker("rm", "-f", container, check=False, timeout=60)
        if created_network:
            docker("network", "rm", network, check=False, timeout=60)
        if created_relay_image:
            docker("image", "rm", relay_image, check=False, timeout=120)
        if created_electric_image and active_image:
            docker("image", "rm", active_image, check=False, timeout=120)
        if created_postgres_image:
            docker("image", "rm", POSTGRES_IMAGE, check=False, timeout=120)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProofError, OSError, subprocess.SubprocessError) as exc:
        print(f"Electric secret proof failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
