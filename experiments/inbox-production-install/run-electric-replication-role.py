#!/usr/bin/env python3
r"""Run a production Electric packet without putting its verifier in argv.

The role verifier is the only stdin payload.  This helper derives the
connected project ref from PGHOST, emits psql ``\set`` directives followed by
``\i`` on psql's stdin, and redacts the verifier from any child output.
Connection credentials remain in libpq's normal environment/PGPASSFILE
channels; this helper never accepts a password or a DSN argument.
"""

from __future__ import annotations

import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys


HERE = Path(__file__).resolve().parent
PROJECT_REFS = {"ncsngxlcyxylaeskiteu", "copflsklaefwzipsrjqz"}
DIRECT_HOST = re.compile(r"^db\.([a-z0-9]{20})\.supabase\.co$")
SCRAM_VERIFIER = re.compile(
    r"^SCRAM-SHA-256\$([1-9][0-9]{0,9}):([A-Za-z0-9+/]{22}==)\$"
    r"([A-Za-z0-9+/]{43}=):([A-Za-z0-9+/]{43}=)$"
)
PINNED_CA_FILE = HERE / "supabase-prod-ca-2021.crt"
PINNED_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
HOSTED_PG_OVERRIDE_VARS = ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")


class PacketError(RuntimeError):
    pass


def connected_project_ref() -> str:
    host = os.environ.get("PGHOST", "")
    match = DIRECT_HOST.fullmatch(host)
    if not match or match.group(1) not in PROJECT_REFS:
        raise PacketError("PGHOST must be the approved direct Supabase host")
    return match.group(1)


def validate_hosted_connection_environment() -> None:
    for name in HOSTED_PG_OVERRIDE_VARS:
        if name in os.environ:
            raise PacketError(f"{name} overrides the approved direct host")
    if os.environ.get("PGSSLMODE") != "verify-full":
        raise PacketError("PGSSLMODE must be verify-full for hosted refs")
    rootcert = os.environ.get("PGSSLROOTCERT", "")
    if not rootcert:
        raise PacketError("PGSSLROOTCERT must point to the pinned Supabase CA")
    try:
        rootcert_path = Path(rootcert).resolve(strict=True)
        pinned_path = PINNED_CA_FILE.resolve(strict=True)
        digest = hashlib.sha256(rootcert_path.read_bytes()).hexdigest()
    except OSError as exc:
        raise PacketError("PGSSLROOTCERT must point to the pinned Supabase CA") from exc
    if rootcert_path != pinned_path or digest != PINNED_CA_SHA256:
        raise PacketError("PGSSLROOTCERT is not the pinned Supabase CA")


def validate_verifier(value: str) -> None:
    match = SCRAM_VERIFIER.fullmatch(value)
    if not match or int(match.group(1)) < 4096:
        raise PacketError("stdin must contain a well-formed SCRAM-SHA-256 verifier")


def psql_set(name: str, value: str) -> str:
    if "\n" in value or "\r" in value:
        raise PacketError(f"{name} must be a single line")
    return f"\\set {name} '{value.replace(chr(39), chr(39) * 2)}'"


def packet_input(
    packet: Path,
    project_ref: str,
    connected_ref: str,
    verifier: str | None,
    prior_identity: str | None,
    prior_index: str | None,
    replication_slot: str | None,
) -> str:
    lines = [
        psql_set("project_ref", project_ref),
        psql_set("connection_project_ref", connected_ref),
    ]
    if verifier is not None:
        lines.append(psql_set("electric_password", verifier))
    if prior_identity is not None:
        lines.append(psql_set("prior_replica_identity", prior_identity))
        lines.append(psql_set("prior_replica_identity_index", prior_index or ""))
    if replication_slot is not None:
        lines.append(psql_set("replication_slot_name", replication_slot))
    escaped_packet = str(packet).replace("'", "''")
    lines.append(f"\\i '{escaped_packet}'")
    return "\n".join(lines) + "\n"


def redacted(value: str, verifier: str | None) -> str:
    return value.replace(verifier, "<redacted-scram-verifier>") if verifier else value


def hosted_child_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for name in HOSTED_PG_OVERRIDE_VARS:
        environment.pop(name, None)
    return environment


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--packet", choices=("install", "teardown"), required=True)
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--prior-replica-identity")
    parser.add_argument("--prior-replica-identity-index", default="")
    parser.add_argument("--replication-slot")
    args = parser.parse_args(argv)

    if args.project_ref not in PROJECT_REFS:
        raise PacketError("project ref is not approved")
    connected_ref = connected_project_ref()
    if args.project_ref != connected_ref:
        raise PacketError("operator project ref does not match PGHOST")
    validate_hosted_connection_environment()
    if args.packet == "teardown" and args.prior_replica_identity not in {"d", "n", "f", "i"}:
        raise PacketError("teardown requires a recorded replica identity")
    if args.packet == "teardown" and not re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", args.replication_slot or ""):
        raise PacketError("teardown requires a valid replication slot name")

    verifier = None
    if args.packet == "install":
        verifier = sys.stdin.read()
        if verifier.endswith("\n"):
            verifier = verifier[:-1]
        if verifier.endswith("\r"):
            verifier = verifier[:-1]
        if any(character in verifier for character in "\r\n"):
            raise PacketError("stdin must contain exactly one verifier line")
        validate_verifier(verifier)

    packet = HERE / (
        "electric-replication-role.production.sql"
        if args.packet == "install"
        else "electric-replication-role.production-teardown.sql"
    )
    psql = os.environ.get("INBOX_ELECTRIC_PSQL_BIN", "psql")
    result = subprocess.run(
        [psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        input=packet_input(
            packet,
            args.project_ref,
            connected_ref,
            verifier,
            args.prior_replica_identity,
            args.prior_replica_identity_index,
            args.replication_slot,
        ),
        text=True,
        capture_output=True,
        env=hosted_child_environment(),
        check=False,
    )
    sys.stdout.write(redacted(result.stdout, verifier))
    sys.stderr.write(redacted(result.stderr, verifier))
    return result.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PacketError as exc:
        print(f"electric packet blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
