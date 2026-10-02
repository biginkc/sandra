#!/usr/bin/env python3
r"""Apply runtime worker LOGIN roles with three SCRAM verifiers on stdin.

The input is exactly three newline-separated SCRAM-SHA-256 verifiers in action,
reply, projection order. No verifier is accepted as an option or written to a
file. Hosted execution is pinned to an approved direct Supabase host and CA.
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


class PacketError(RuntimeError):
    pass


def connected_project_ref() -> str:
    host = os.environ.get("PGHOST", "")
    match = DIRECT_HOST.fullmatch(host)
    if not match or match.group(1) not in PROJECT_REFS:
        raise PacketError("PGHOST must be the approved direct Supabase host")
    return match.group(1)


def validate_hosted_environment() -> None:
    for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
        if name in os.environ:
            raise PacketError(f"{name} overrides the approved direct host")
    if os.environ.get("PGSSLMODE") != "verify-full":
        raise PacketError("PGSSLMODE must be verify-full for hosted refs")
    rootcert = os.environ.get("PGSSLROOTCERT", "")
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
        raise PacketError("stdin must contain well-formed SCRAM-SHA-256 verifiers")


def psql_set(name: str, value: str) -> str:
    if "\n" in value or "\r" in value:
        raise PacketError(f"{name} must be a single line")
    return f"\\set {name} '{value.replace(chr(39), chr(39) * 2)}'"


def packet_input(verifiers: list[str]) -> str:
    names = ("action_verifier", "reply_verifier", "projection_verifier")
    lines = [psql_set(name, verifier) for name, verifier in zip(names, verifiers)]
    lines.append(f"\\i '{str(HERE / 'runtime-worker-logins.sql').replace(chr(39), chr(39) * 2)}'")
    return "\n".join(lines) + "\n"


def redacted(value: str, verifiers: list[str]) -> str:
    for verifier in verifiers:
        value = value.replace(verifier, "<redacted-scram-verifier>")
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", required=True)
    args = parser.parse_args(argv)
    if args.project_ref not in PROJECT_REFS:
        raise PacketError("project ref is not approved")
    connected_ref = connected_project_ref()
    if args.project_ref != connected_ref:
        raise PacketError("operator project ref does not match the connected database")
    validate_hosted_environment()
    raw = sys.stdin.read()
    if raw.endswith("\n"):
        raw = raw[:-1]
    if raw.endswith("\r"):
        raw = raw[:-1]
    verifiers = raw.split("\n")
    if len(verifiers) != 3 or any("\r" in verifier or not verifier for verifier in verifiers):
        raise PacketError("stdin must contain exactly three verifier lines")
    for verifier in verifiers:
        validate_verifier(verifier)
    psql = os.environ.get("INBOX_RUNTIME_LOGINS_PSQL_BIN", "psql")
    result = subprocess.run(
        [psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        input=packet_input(verifiers),
        text=True,
        capture_output=True,
        check=False,
    )
    sys.stdout.write(redacted(result.stdout, verifiers))
    sys.stderr.write(redacted(result.stderr, verifiers))
    return result.returncode


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PacketError as exc:
        print(f"runtime worker LOGIN packet blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
