#!/usr/bin/env python3
"""Inject bounded faults into the marked local HTTP fixture and emit JSONL.

This adapter is deliberately operational: it restarts only containers whose
labels and names match the checked-in release fixture, then measures health,
CPU, memory, locks, and connections after recovery.  It does not synthesize a
recovery record when Docker, the database identity, or the health endpoint is
unavailable.  ``INBOX_RELEASE_FAULTS`` must be an explicit JSON array; an
empty or omitted list is a blocked run rather than a pass.
"""

from __future__ import annotations

import json
import http.client
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[2]
SOCKET = os.environ.get("INBOX_T2_DOCKER_SOCKET", "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock")
MARKER = "sandra-inbox-release-http-owned-20260917"
DATABASE_MARKER = "sandra-inbox-http-owned-synthetic-20260917"
NETWORK = "sandra-inbox-release-http-20260917"
CONTAINERS = {
    "db": "sandra-inbox-release-http-db-20260917",
    "auth": "sandra-inbox-release-http-auth-20260917",
    "rest": "sandra-inbox-release-http-rest-20260917",
    "gateway": "sandra-inbox-release-http-kong-20260917",
    "realtime": "sandra-inbox-release-http-realtime-20260917",
    "projection": "sandra-inbox-release-http-projection-20260917",
}
HEALTH = {
    "db": ("db", None),
    "auth": ("http", "http://127.0.0.1:54321/auth/v1/health"),
    "rest": ("http", "http://127.0.0.1:54321/rest/v1/"),
    "gateway": ("http", "http://127.0.0.1:54321/auth/v1/health"),
    "realtime": ("http", "http://127.0.0.1:54321/realtime/v1/"),
    "projection": ("http", "http://127.0.0.1:59081/health"),
}
FAULTS = set(CONTAINERS)


def fail(message: str) -> None:
    raise RuntimeError(message)


def docker(*args: str, timeout: int = 30) -> str:
    result = subprocess.run(["docker", "--host", SOCKET, *args], cwd=ROOT, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        fail(f"docker command failed: {result.stderr.strip()[-1000:]}")
    return result.stdout.strip()


def inspect(name: str) -> dict:
    rows = json.loads(docker("inspect", name))
    if len(rows) != 1:
        fail(f"expected one owned container: {name}")
    row = rows[0]
    labels = row.get("Config", {}).get("Labels", {})
    if labels.get("purpose") != "sandra-inbox-release-http" or labels.get("owner") != "release-infra" or labels.get("marker") != MARKER:
        fail(f"ownership marker mismatch: {name}")
    if row.get("State", {}).get("Status") != "running":
        fail(f"container is not running: {name}")
    return row


def verify_target() -> None:
    if os.environ.get("INBOX_RELEASE_TARGET_PROBED") != "true":
        fail("independent target probe is required")
    if os.environ.get("INBOX_RELEASE_TARGET_CONTAINER_MARKER") != MARKER or os.environ.get("INBOX_RELEASE_TARGET_DATABASE_MARKER") != DATABASE_MARKER:
        fail("target probe markers do not match the owned fixture")
    if os.environ.get("INBOX_RELEASE_PROVIDER_TRAFFIC", "false") != "false" or os.environ.get("INBOX_NO_PROVIDER") != "1":
        fail("provider traffic is not explicitly disabled")
    for name in CONTAINERS.values():
        inspect(name)
    db = CONTAINERS["db"]
    identity = docker("exec", db, "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT current_database()||'|'||(SELECT marker FROM install_fixture.identity)||'|'||(SELECT serving_enabled FROM inbox_control.rollout);")
    if identity != f"postgres|{DATABASE_MARKER}|true":
        fail(f"owned HTTP database identity mismatch: {identity!r}")


def wait_http(url: str, timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as response:
                response.read(512)
                if response.status == 200:
                    return
        except (OSError, urllib.error.HTTPError):
            pass
        time.sleep(0.25)
    fail(f"health endpoint did not recover: {url}")


def wait_realtime_websocket(timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        connection = http.client.HTTPConnection("127.0.0.1", 54321, timeout=2)
        try:
            connection.request("GET", "/realtime/v1/websocket?vsn=1.0.0", headers={
                "Connection": "Upgrade",
                "Upgrade": "websocket",
                "Sec-WebSocket-Version": "13",
                "Sec-WebSocket-Key": secrets.token_urlsafe(16),
            })
            response = connection.getresponse()
            response.read(256)
            if response.status == 101:
                return
        except OSError:
            pass
        finally:
            connection.close()
        time.sleep(0.25)
    fail("Realtime WebSocket did not recover")


def wait_db(timeout: float = 30.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            db = CONTAINERS["db"]
            if docker("exec", db, "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT current_database()||'|'||(SELECT marker FROM install_fixture.identity);", timeout=5) == f"postgres|{DATABASE_MARKER}":
                return
        except (RuntimeError, subprocess.TimeoutExpired):
            pass
        time.sleep(0.25)
    fail("database identity did not recover")


def bytes_value(value: str) -> int:
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z]+)\s*", value)
    if not match:
        fail(f"unsupported Docker memory value: {value!r}")
    number, unit = match.groups()
    scale = {"B": 1, "kB": 1000, "KB": 1000, "KiB": 1024, "MB": 1000**2, "MiB": 1024**2, "GB": 1000**3, "GiB": 1024**3}
    if unit not in scale:
        fail(f"unsupported Docker memory unit: {unit}")
    return int(float(number) * scale[unit])


def resources() -> list[dict]:
    stats = json.loads("[" + ",".join(docker("stats", "--no-stream", "--format", "{{json .}}", name).splitlines()[0] for name in CONTAINERS.values()) + "]")
    cpu = 0.0
    memory = 0
    for row in stats:
        cpu += float(row["CPUPerc"].rstrip("%"))
        memory += bytes_value(row["MemUsage"].split("/")[0].strip())
    db = CONTAINERS["db"]
    connections, locks = docker("exec", db, "psql", "-XqAt", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", "SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database())||'|'||(SELECT count(*) FROM pg_locks l JOIN pg_database d ON d.oid=l.database WHERE d.datname=current_database());").split("|")
    profile = os.environ.get("INBOX_STRESS_PROFILE", "")
    return [
        {"type": "metric", "profile": profile, "name": "cpu_percent", "value": cpu},
        {"type": "metric", "profile": profile, "name": "memory_bytes", "value": memory},
        {"type": "metric", "profile": profile, "name": "connections", "value": float(connections)},
        {"type": "metric", "profile": profile, "name": "locks", "value": float(locks)},
    ]


def recover(kind: str) -> None:
    service = kind[:-8] if kind.endswith("_restart") else kind
    if service not in FAULTS:
        fail(f"unsupported fault: {kind}")
    container = CONTAINERS[service]
    inspect(container)
    started = time.monotonic()
    docker("restart", container, timeout=45)
    check, url = HEALTH[service]
    if check == "db":
        wait_db()
    elif service == "realtime":
        wait_realtime_websocket()
    else:
        assert url is not None
        wait_http(url)
    # Re-inspect after health; a replacement with a different label must not
    # be reported as recovery for the owned fixture.
    inspect(container)
    duration_ms = (time.monotonic() - started) * 1000
    profile = os.environ.get("INBOX_STRESS_PROFILE", "")
    print(json.dumps({"type": "recovery", "profile": profile, "fault": kind if kind.endswith("_restart") else f"{kind}_restart", "recovered": True, "duration_ms": duration_ms}, sort_keys=True), flush=True)
    for record in resources():
        print(json.dumps(record, sort_keys=True), flush=True)


def main() -> int:
    try:
        verify_target()
        raw = os.environ.get("INBOX_RELEASE_FAULTS", "")
        if not raw:
            fail("INBOX_RELEASE_FAULTS must explicitly name real fixture faults")
        faults = json.loads(raw)
        if not isinstance(faults, list) or not faults or len(faults) > 8 or any(not isinstance(value, str) for value in faults):
            fail("INBOX_RELEASE_FAULTS must be a non-empty array of at most eight fault names")
        for kind in faults:
            recover(kind)
        return 0
    except (RuntimeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(json.dumps({"status": "BLOCKED", "reason": str(exc)}), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
