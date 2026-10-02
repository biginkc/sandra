#!/usr/bin/env python3
"""Run the Electric 1.8.1 CA-positive/CA-negative proof locally.

The proof owns only containers and a network whose names carry this process's
unique suffix.  It never touches the Homebrew PostgreSQL service or any
existing container.  The Postgres container is TLS-enabled with a self-signed
CA; Electric must become healthy with that CA and must fail with another CA.
"""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
import urllib.error
import uuid


HERE = Path(__file__).resolve().parent
PUBLISHED_ELECTRIC_IMAGE = "electricsql/electric:1.8.1@sha256:efb6fa43859d67cb8c73439e0c8bc0f7a3daa467500fb06f2a924bcb2070c139"
ELECTRIC_SOURCE_REF = "@core/sync-service@1.8.1"
ELECTRIC_IMAGE = "sandra-r1-electric:1.8.1-source"
POSTGRES_IMAGE = "postgres:17"
CA_CONTAINER_PATH = "/etc/sandra-inbox/supabase-prod-ca-2021.crt"


class ProofError(RuntimeError):
    pass


def run(args: list[str], *, check: bool = True, timeout: int = 120, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
    capture = args[:2] != ["docker", "build"]
    result = subprocess.run(args, input=input_text, text=True, capture_output=capture, timeout=timeout, check=False)
    if check and result.returncode:
        details = "" if not capture else (result.stderr + result.stdout)[-5000:]
        raise ProofError(f"command failed ({result.returncode}): {' '.join(args)}\n{details}")
    return result


def docker(*args: str, check: bool = True, timeout: int = 120) -> subprocess.CompletedProcess[str]:
    return run(["docker", *args], check=check, timeout=timeout)


def openssl(*args: str) -> None:
    run(["openssl", *args], timeout=60)


def wait_postgres(container: str) -> None:
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        state = docker("inspect", "-f", "{{.State.Status}}", container, check=False, timeout=10).stdout.strip()
        if state in {"exited", "dead"}:
            logs = docker("logs", container, check=False).stdout + docker("logs", container, check=False).stderr
            raise ProofError(f"Postgres container exited before readiness:\n{logs[-5000:]}")
        result = docker("exec", container, "pg_isready", "-U", "postgres", check=False, timeout=10)
        if result.returncode == 0:
            return
        time.sleep(1)
    logs = docker("logs", container, check=False).stdout + docker("logs", container, check=False).stderr
    raise ProofError(f"Postgres did not become ready:\n{logs[-5000:]}")


def electric_port(container: str) -> int:
    value = docker("port", container, "3000/tcp").stdout.strip().rsplit(":", 1)[-1]
    return int(value)


def health(port: int) -> int | None:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/health", timeout=2) as response:
            response.read(4096)
            return response.status
    except urllib.error.HTTPError as error:
        return error.code
    except (urllib.error.URLError, TimeoutError, OSError):
        return None


def wait_healthy(port: int, seconds: int = 90) -> int | None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        status = health(port)
        if status is not None and 200 <= status < 300:
            return status
        time.sleep(1)
    return health(port)


def certs(root: Path) -> tuple[Path, Path]:
    ca_key = root / "ca.key"
    ca_crt = root / "ca.crt"
    server_key = root / "server.key"
    server_csr = root / "server.csr"
    server_crt = root / "server.crt"
    wrong_ca_key = root / "wrong-ca.key"
    wrong_ca = root / "wrong-ca.crt"
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
    source_url = "https://github.com/electric-sql/electric/archive/refs/tags/%40core/sync-service%401.8.1.tar.gz"
    with archive.open("wb") as handle:
        request = urllib.request.Request(source_url, headers={"user-agent": "sandra-r1-electric-tls-proof"})
        with urllib.request.urlopen(request, timeout=60) as response:
            shutil.copyfileobj(response, handle)
    source_parent = root / "source"
    source_parent.mkdir()
    run(["tar", "-xzf", str(archive), "-C", str(source_parent)], timeout=120)
    extracted = next(source_parent.iterdir())
    sync_service = extracted / "packages/sync-service"
    telemetry = extracted / "packages/electric-telemetry"
    # The official Dockerfile uses BuildKit's named context.  This machine has
    # only Docker's legacy builder, so copy that exact official context into
    # the temporary build context and change only the COPY spelling.
    shutil.copytree(telemetry, sync_service / "electric-telemetry")
    dockerfile = sync_service / "Dockerfile"
    dockerfile.write_text(dockerfile.read_text(encoding="utf-8").replace(
        "COPY --from=electric-telemetry / /builder/electric-telemetry",
        "COPY electric-telemetry /builder/electric-telemetry",
    ), encoding="utf-8")
    docker("build", "--build-arg", "ELECTRIC_VERSION=1.8.1", "-t", ELECTRIC_IMAGE, "-f", str(dockerfile), str(sync_service), timeout=1800)


def main() -> int:
    suffix = uuid.uuid4().hex[:12]
    network = f"sandra-r1-electric-tls-{suffix}"
    postgres = f"sandra-r1-electric-tls-postgres-{suffix}"
    electric = f"sandra-r1-electric-tls-electric-{suffix}"
    wrong_electric = f"sandra-r1-electric-tls-wrong-ca-{suffix}"
    evidence_path = HERE / "electric-tls-evidence.json"
    status: dict[str, object] = {
        "electric_image": ELECTRIC_IMAGE,
        "published_electric_image": PUBLISHED_ELECTRIC_IMAGE,
        "electric_source_ref": ELECTRIC_SOURCE_REF,
        "postgres_image": POSTGRES_IMAGE,
        "ca_env": "ELECTRIC_DATABASE_CA_CERTIFICATE_FILE",
        "ca_container_path": CA_CONTAINER_PATH,
        "network": network,
    }
    created = False
    built_image = False
    try:
        # Colima does not expose macOS /var/folders mounts to containers by
        # default.  Keep the disposable certificate directory under the
        # shared /Users tree so the local Postgres container can read it.
        with tempfile.TemporaryDirectory(prefix=".sandra-r1-electric-tls-", dir=HERE) as temp:
            root = Path(temp)
            ca_crt, wrong_ca = certs(root)
            build_official_electric(root)
            built_image = True
            docker("network", "create", network)
            created = True
            password = "sandra-electric-proof-password"
            docker(
                "run", "-d", "--name", postgres, "--network", network, "--network-alias", "postgres",
                "-e", "POSTGRES_PASSWORD=" + password, "-e", "POSTGRES_HOST_AUTH_METHOD=scram-sha-256",
                "-v", f"{root}:/input:ro", POSTGRES_IMAGE, "bash", "-c",
                "cp /input/server.crt /var/lib/postgresql/server.crt && "
                "cp /input/server.key /var/lib/postgresql/server.key && "
                "cp /input/ca.crt /var/lib/postgresql/ca.crt && "
                "chown postgres:postgres /var/lib/postgresql/server.crt /var/lib/postgresql/server.key /var/lib/postgresql/ca.crt && "
                "chmod 600 /var/lib/postgresql/server.key && "
                "exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt "
                "-c ssl_key_file=/var/lib/postgresql/server.key -c ssl_ca_file=/var/lib/postgresql/ca.crt "
                "-c wal_level=logical -c max_replication_slots=4",
                timeout=180,
            )
            wait_postgres(postgres)
            docker("exec", postgres, "psql", "-U", "postgres", "-c", "CREATE PUBLICATION electric_publication_inbox_tlsproof;")
            database_url = f"postgresql://postgres:{password}@postgres:5432/postgres?sslmode=require"
            docker(
                "run", "-d", "--name", electric, "--network", network, "-p", "127.0.0.1::3000",
                "-e", "DATABASE_URL=" + database_url,
                "-e", "ELECTRIC_DATABASE_CA_CERTIFICATE_FILE=" + CA_CONTAINER_PATH,
                "-e", "ELECTRIC_SECRET=sandra-electric-proof-secret",
                "-e", "ELECTRIC_MANUAL_TABLE_PUBLISHING=true",
                "-e", "ELECTRIC_REPLICATION_STREAM_ID=inbox_tlsproof",
                "-e", "ELECTRIC_TELEMETRY=false", "-e", "ELECTRIC_LONG_POLL_TIMEOUT=8000",
                "-v", f"{ca_crt}:{CA_CONTAINER_PATH}:ro", ELECTRIC_IMAGE,
                timeout=180,
            )
            right_port = electric_port(electric)
            right_status = wait_healthy(right_port)
            right_log_result = docker("logs", electric, check=False)
            right_logs = (right_log_result.stdout + right_log_result.stderr)[-4000:]
            right_healthy = right_status is not None and 200 <= right_status < 300
            status["right_ca"] = {"container": electric, "host_port": right_port, "health_status": right_status, "outcome": "healthy" if right_healthy else "failed", "logs_tail": right_logs}
            if right_status is None or not 200 <= right_status < 300:
                state = docker("inspect", "-f", "{{.State.Status}} exit={{.State.ExitCode}} error={{.State.Error}}", electric, check=False, timeout=10).stdout.strip()
                raise ProofError(f"Electric 1.8.1 did not become healthy with the right CA (status={right_status}, {state}):\n{right_logs}")

            docker(
                "run", "-d", "--name", wrong_electric, "--network", network, "-p", "127.0.0.1::3000",
                "-e", "DATABASE_URL=" + database_url,
                "-e", "ELECTRIC_DATABASE_CA_CERTIFICATE_FILE=" + CA_CONTAINER_PATH,
                "-e", "ELECTRIC_SECRET=sandra-electric-proof-secret",
                "-e", "ELECTRIC_MANUAL_TABLE_PUBLISHING=true",
                "-e", "ELECTRIC_REPLICATION_STREAM_ID=inbox_tlsproof_wrong_ca",
                "-e", "ELECTRIC_TELEMETRY=false", "-v", f"{wrong_ca}:{CA_CONTAINER_PATH}:ro", ELECTRIC_IMAGE,
                timeout=180,
            )
            wrong_port = electric_port(wrong_electric)
            wrong_status = wait_healthy(wrong_port, seconds=20)
            running = docker("inspect", "-f", "{{.State.Running}}", wrong_electric, check=False).stdout.strip() == "true"
            wrong_log_result = docker("logs", wrong_electric, check=False)
            wrong_logs = (wrong_log_result.stdout + wrong_log_result.stderr)[-4000:]
            wrong_tls_error = any(token in wrong_logs.lower() for token in ("unknown ca", "tls client", "ssl connect"))
            wrong_failed = wrong_tls_error or (not running and wrong_status is None)
            status["wrong_ca"] = {"container": wrong_electric, "host_port": wrong_port, "health_status": wrong_status, "running_after_timeout": running, "outcome": "failed as expected" if wrong_failed else "unexpectedly healthy", "logs_tail": wrong_logs}
            if not wrong_failed:
                raise ProofError(f"Electric 1.8.1 unexpectedly accepted the wrong CA:\n{wrong_logs}")
            evidence_path.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            evidence_path.chmod(0o600)
            print(json.dumps(status, indent=2, sort_keys=True))
            return 0
    finally:
        for container in (wrong_electric, electric, postgres):
            docker("rm", "-f", container, check=False, timeout=60)
        if created:
            docker("network", "rm", network, check=False, timeout=60)
        if built_image:
            docker("image", "rm", ELECTRIC_IMAGE, check=False, timeout=120)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (ProofError, OSError, subprocess.SubprocessError) as exc:
        print(f"Electric TLS proof failed: {exc}", file=sys.stderr)
        raise SystemExit(2)
