#!/usr/bin/env python3
"""Run the reviewed emergency Inbox capture packet through one guarded session.

The SQL files are generated artifacts, not standalone operator entry points.
This runner is the only supported way to execute them.  The connection URL
must not contain a password; the password is read only from
INBOX_EMERGENCY_DB_PASSWORD and is passed to libpq through the child
environment.  Production requires the pinned Supabase CA and verify-full TLS.
"""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit


HERE = Path(__file__).resolve().parent
PRODUCTION_TARGET_REF = "copflsklaefwzipsrjqz"
LOCAL_TEST_TARGET_REF = "local-test"
LOCAL_TEST_PORT_MIN = 55400
LOCAL_TEST_PORT_MAX = 55599
PRODUCTION_DIRECT_HOST = f"db.{PRODUCTION_TARGET_REF}.supabase.co"
PRODUCTION_POOLER_HOSTS = frozenset(
    {
        "aws-0-us-east-1.pooler.supabase.com",
        "aws-1-us-east-1.pooler.supabase.com",
    }
)
PINNED_CA_FILE = HERE.parent / "supabase-prod-ca-2021.crt"
PACKETS = {
    "capture-off": HERE / "capture-off.sql",
    "capture-restore": HERE / "capture-restore.sql",
}


class RunnerError(RuntimeError):
    """A preflight refusal that must happen before opening a database session."""


@dataclass(frozen=True)
class ConnectionTarget:
    host: str
    port: int
    user: str
    database: str
    local_test: bool


def parse_connection_string(value: str, *, local_test: bool) -> ConnectionTarget:
    """Parse a passwordless PostgreSQL URL and validate its effective fields."""

    if not isinstance(value, str) or not value or "?" in value or "#" in value:
        raise RunnerError("connection string options and fragments are refused")
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        port = parsed.port or 5432
    except ValueError as exc:
        raise RunnerError("connection string is malformed") from exc

    if parsed.scheme not in {"postgres", "postgresql"}:
        raise RunnerError("connection string must use postgres:// or postgresql://")
    if not hostname or not parsed.username or parsed.password is not None:
        raise RunnerError("connection string must omit passwords and socket paths")
    # urllib.parse intentionally preserves percent escapes in the authority.
    # Refuse them rather than allowing a second parser (libpq) to reinterpret
    # the target or credentials.
    if "%" in parsed.netloc or "/" in hostname or "\\" in hostname:
        raise RunnerError("percent-encoded hosts and socket paths are refused")
    if parsed.path != "/postgres" or parsed.query or parsed.fragment:
        raise RunnerError("connection string must target the postgres database without options")
    if parsed.username != "postgres" and not parsed.username.startswith("postgres."):
        raise RunnerError("connection user is not an approved Supabase postgres login")

    if local_test:
        if (
            hostname != "127.0.0.1"
            or parsed.username != "postgres"
            or port < LOCAL_TEST_PORT_MIN
            or port > LOCAL_TEST_PORT_MAX
        ):
            raise RunnerError("local-test requires postgres on 127.0.0.1 in the disposable port range")
        if os.environ.get("NODE_ENV") != "test" and os.environ.get("CI", "").lower() not in {"1", "true", "yes"}:
            raise RunnerError("local-test requires NODE_ENV=test or a CI-style test flag")
        return ConnectionTarget(hostname, port, parsed.username, "postgres", True)

    if hostname == PRODUCTION_DIRECT_HOST:
        if parsed.username != "postgres" or port != 5432:
            raise RunnerError("production direct target requires postgres@db.<ref>.supabase.co:5432")
    elif hostname in PRODUCTION_POOLER_HOSTS:
        if parsed.username != f"postgres.{PRODUCTION_TARGET_REF}" or port not in {5432, 6543}:
            raise RunnerError("production pooler target requires postgres.<ref> on port 5432 or 6543")
    else:
        raise RunnerError("connection host is not the pinned Production Supabase endpoint")
    return ConnectionTarget(hostname, port, parsed.username, "postgres", False)


def validate_ca_file() -> Path:
    try:
        path = PINNED_CA_FILE.resolve(strict=True)
        data = path.read_bytes()
    except OSError as exc:
        raise RunnerError("pinned Supabase CA file is unavailable") from exc
    if not path.is_file() or b"-----BEGIN CERTIFICATE-----" not in data or b"-----END CERTIFICATE-----" not in data:
        raise RunnerError("pinned Supabase CA file is invalid")
    return path


def child_environment(target: ConnectionTarget, password: str) -> dict[str, str]:
    if not password or "\x00" in password:
        raise RunnerError("INBOX_EMERGENCY_DB_PASSWORD must be a non-empty environment value")
    child = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
    child.update(
        {
            "PGHOST": target.host,
            "PGPORT": str(target.port),
            "PGUSER": target.user,
            "PGDATABASE": target.database,
            "PGPASSWORD": password,
            "LC_ALL": "C",
        }
    )
    if target.local_test:
        child["PGSSLMODE"] = "disable"
    else:
        child["PGSSLMODE"] = "verify-full"
        child["PGSSLROOTCERT"] = str(validate_ca_file())
        child["PGGSSENCMODE"] = "disable"
    return child


def psql_path(path: Path) -> str:
    escaped = str(path).replace("\\", "\\\\").replace("'", "''")
    return f"\\i '{escaped}'"


def runner_input(packet: Path, *, local_test: bool, inline_packet: bool = False) -> str:
    target_ref = LOCAL_TEST_TARGET_REF if local_test else PRODUCTION_TARGET_REF
    local_flag = "on" if local_test else "off"
    lines = [
        "\\set ON_ERROR_STOP on",
        # The outer transaction intentionally wraps the generated packet so
        # SET LOCAL target identity is established before the packet's own
        # BEGIN. PostgreSQL treats that inner BEGIN as a warning/no-op and
        # the packet COMMIT closes this same transaction.
        "BEGIN;",
        f"SET LOCAL inbox.emergency_target_ref = '{target_ref}';",
        f"SET LOCAL inbox.emergency_local_test = '{local_flag}';",
    ]
    lines.append(packet.read_text() if inline_packet else psql_path(packet))
    lines.append("")
    return "\n".join(lines)


def run_packet(packet_name: str, database_url: str, *, local_test: bool) -> int:
    packet = PACKETS.get(packet_name)
    if packet is None:
        raise RunnerError("unknown emergency packet")
    if not packet.is_file():
        raise RunnerError("generated emergency packet is unavailable")
    target = parse_connection_string(database_url, local_test=local_test)
    password = os.environ.get("INBOX_EMERGENCY_DB_PASSWORD")
    if password is None:
        raise RunnerError("INBOX_EMERGENCY_DB_PASSWORD is required and is never accepted in argv")
    environment = child_environment(target, password)
    psql_command = ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"]
    local_container = os.environ.get("INBOX_EMERGENCY_LOCAL_TEST_CONTAINER") if local_test else None
    if local_container:
        if not re.fullmatch(r"supabase_db_sandra-emergency-[a-z0-9]+", local_container):
            raise RunnerError("local-test container is not an owned disposable database container")
        state = subprocess.run(
            ["docker", "inspect", "--type", "container", "--format", "{{.State.Running}}", local_container],
            text=True,
            capture_output=True,
            check=False,
        )
        if state.returncode != 0 or state.stdout.strip() != "true":
            raise RunnerError("local-test disposable database container is not running")
        psql_command = [
            "docker",
            "exec",
            "-i",
            local_container,
            "psql",
            "-h",
            "127.0.0.1",
            "-p",
            "5432",
            "-U",
            "postgres",
            "-d",
            "postgres",
            "-X",
            "-v",
            "ON_ERROR_STOP=1",
            "-f",
            "-",
        ]
    packet_input = runner_input(packet, local_test=local_test, inline_packet=local_container is not None)
    result = subprocess.run(
        psql_command,
        input=packet_input,
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )
    # The password is not part of the command line or SQL input.  Redact it
    # defensively if libpq or a local wrapper ever echoes it.
    sys.stdout.write(result.stdout.replace(password, "<redacted-password>"))
    sys.stderr.write(result.stderr.replace(password, "<redacted-password>"))
    return result.returncode


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", choices=tuple(PACKETS), required=True)
    parser.add_argument("--database-url", required=True)
    parser.add_argument("--target-ref", required=True)
    parser.add_argument("--i-understand-production", action="store_true", required=True)
    parser.add_argument("--local-test", action="store_true")
    args = parser.parse_args(argv)

    if args.target_ref != PRODUCTION_TARGET_REF:
        raise RunnerError("--target-ref must be the pinned Production project ref")
    if args.local_test:
        # The operator still acknowledges the pinned Production target on the
        # command line; only the transaction-local SQL target becomes local-test.
        pass
    return run_packet(args.packet, args.database_url, local_test=args.local_test)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RunnerError as exc:
        print(f"emergency capture packet blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
