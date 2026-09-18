"""Guarded SQL adapter for the separately owned local HTTP fixture.

This adapter is intentionally independent of fixture_db.py: the latter is
restricted to the release rehearsal database in the backend-owned T2
container.  Every call here rechecks the HTTP database container's ownership
label before allowing a psql command.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import time

SOCKET = os.environ.get(
    "INBOX_T2_DOCKER_SOCKET",
    "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock",
)
CONTAINER = "sandra-inbox-release-http-db-20260917"
DATABASE = "postgres"
MARKER = "sandra-inbox-http-owned-synthetic-20260917"
CONTAINER_MARKER = "sandra-inbox-release-http-owned-20260917"
NETWORK = "sandra-inbox-release-http-20260917"
DOCKER = ["docker", "--host", SOCKET]


def _inspect() -> dict:
    try:
        rows = json.loads(subprocess.check_output(DOCKER + ["inspect", CONTAINER], text=True))
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        raise RuntimeError("owned HTTP fixture database container is unavailable") from exc
    if len(rows) != 1:
        raise RuntimeError("expected one owned HTTP fixture database container")
    row = rows[0]
    labels = row.get("Config", {}).get("Labels", {})
    if labels.get("purpose") != "sandra-inbox-release-http" or labels.get("owner") != "release-infra" or labels.get("marker") != CONTAINER_MARKER:
        raise RuntimeError("HTTP fixture database ownership marker mismatch")
    if row.get("State", {}).get("Status") != "running":
        raise RuntimeError("HTTP fixture database is not running")
    if row.get("HostConfig", {}).get("NetworkMode") != NETWORK:
        raise RuntimeError("HTTP fixture database network identity drift")
    bindings = row.get("HostConfig", {}).get("PortBindings", {}).get("5432/tcp", [])
    if bindings != [{"HostIp": "127.0.0.1", "HostPort": "54322"}]:
        raise RuntimeError("HTTP fixture database host binding drift")
    return row


def sql(query: str, role: str = "postgres", retry: bool = False) -> str:
    _inspect()
    attempts = 3 if retry else 1
    for attempt in range(attempts):
        result = subprocess.run(
            DOCKER + [
                "exec", "-i", CONTAINER, "psql", "-XqAt", "-U", role,
                "-d", DATABASE, "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose",
            ],
            input="SET statement_timeout='30s';SET lock_timeout='2s';" + query,
            text=True,
            capture_output=True,
            timeout=40,
        )
        if result.returncode == 0:
            return result.stdout.strip()
        if not retry or attempt == attempts - 1 or not any(code in result.stderr for code in ("40P01", "40001", "55P03")):
            raise RuntimeError(result.stderr.strip()[-2000:])
        time.sleep(0.05 * (attempt + 1))
    raise RuntimeError("HTTP fixture SQL retry exhausted")


def guard() -> None:
    _inspect()
    actual = sql("SELECT current_database()||'|'||(SELECT marker FROM install_fixture.identity);")
    expected = f"{DATABASE}|{MARKER}"
    if actual != expected:
        raise RuntimeError(f"HTTP fixture identity mismatch: {actual!r}")


def ensure_concurrent_index(query: str) -> str:
    match = re.match(r"CREATE INDEX CONCURRENTLY (\w+) ON public\.", query)
    if not match:
        raise RuntimeError("expected separately compiled canonical concurrent index")
    name = match.group(1)
    rows = json.loads(sql(f"SELECT coalesce(jsonb_agg(jsonb_build_object('valid',i.indisvalid,'ready',i.indisready,'definition',pg_get_indexdef(i.indexrelid))),'[]') FROM pg_index i WHERE i.indexrelid=to_regclass('public.{name}')"))
    if not rows:
        sql(query)
        return ensure_concurrent_index(query)
    compact = lambda value: re.sub(r"[\s();]", "", value.replace("CONCURRENTLY ", "").replace(" USING btree ", " ").replace("::text", ""))
    if len(rows) != 1 or not rows[0]["valid"] or not rows[0]["ready"] or compact(rows[0]["definition"]) != compact(query):
        raise RuntimeError("invalid or different owned concurrent index: " + name)
    return name
