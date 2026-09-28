#!/usr/bin/env python3
"""Apply a guarded read-companion forward packet to an owned exact target.

The fresh installer deliberately refuses an existing read schema.  This path
is the reviewed alternative for an existing schema: it accepts only the
separately owned release rehearsal database or HTTP fixture profile, keeps
serving disabled, applies OR REPLACE function bodies plus the additive
workset/selection functions, and delegates catalog proof to
read-companion.py before emitting a receipt.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys

P = Path(__file__).resolve().parent
# fixture_db has an allowlist, but setting these before import makes the
# installer's target explicit and prevents its historical install-DB default
# from being selected by an omitted shell variable.
os.environ.setdefault("INBOX_RELEASE_DATABASE", "sandra_inbox_release_20260917")
os.environ.setdefault("INBOX_RELEASE_FIXTURE_MARKER", "sandra-inbox-release-owned-synthetic")

UPGRADES = {
    "current": P / "generated" / "read-upgrade-current.sql",
    "workset-updates": P / "generated" / "read-upgrade-workset-updates.sql",
    "selection-review": P / "generated" / "read-upgrade-selection-review.sql",
}
TARGETS = {
    "release-db": ("sandra_inbox_release_20260917", "sandra-inbox-release-owned-synthetic"),
    "http": ("postgres", "sandra-inbox-http-owned-synthetic-20260917"),
}


def fail_if_fresh_install_ddl(packet: str, database: str, marker: str) -> None:
    # Existing-schema forward packets may add guarded columns/constraints, but
    # must never replay the fresh install's namespace/table creation.
    if re.search(r"\bCREATE\s+(?:SCHEMA|TABLE)\b", packet, re.IGNORECASE):
        raise RuntimeError("existing-schema read upgrade contains fresh-install CREATE SCHEMA/TABLE")
    if not re.search(r"\bCREATE\s+OR\s+REPLACE\s+FUNCTION\b", packet, re.IGNORECASE):
        raise RuntimeError("existing-schema read upgrade has no replaceable function body")
    if f"current_database()<>'{database}'" not in packet:
        raise RuntimeError("read upgrade is not guarded to the selected database")
    if f"marker='{marker}'" not in packet:
        raise RuntimeError("read upgrade is not guarded to the selected fixture marker")


def validate_auth_upgrade(packet: str, database: str, marker: str) -> None:
    if re.search(r"\bCREATE\s+(?:SCHEMA|TABLE)\b", packet, re.IGNORECASE):
        raise RuntimeError("authorization forward upgrade contains fresh-install DDL")
    if "CREATE OR REPLACE FUNCTION inbox_bridge.authorize" not in packet:
        raise RuntimeError("authorization forward upgrade does not replace authorize")
    if f"current_database()='{database}'" not in packet or f"marker='{marker}'" not in packet:
        raise RuntimeError("authorization forward upgrade does not include the selected exact identity")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--owned-fixture", action="store_true")
    parser.add_argument("--upgrade", choices=sorted(UPGRADES), default="current")
    parser.add_argument("--target", choices=sorted(TARGETS), default=os.environ.get("INBOX_RELEASE_TARGET_PROFILE", "release-db"))
    args = parser.parse_args()
    if not args.owned_fixture:
        raise SystemExit("Explicit --owned-fixture is required")

    database, marker = TARGETS[args.target]
    os.environ["INBOX_RELEASE_TARGET_PROFILE"] = args.target
    os.environ["INBOX_RELEASE_DATABASE"] = database
    os.environ["INBOX_RELEASE_FIXTURE_MARKER"] = marker
    if args.target == "http":
        from http_fixture_db import guard, sql, ensure_concurrent_index
    else:
        from fixture_db import guard, sql, ensure_concurrent_index
    guard()
    if sql("SELECT to_regnamespace('inbox_read') IS NOT NULL") != "t":
        raise RuntimeError("existing read schema is required; use read-companion.py for a fresh install")
    if sql("SELECT serving_enabled FROM inbox_control.rollout WHERE singleton") != "f":
        raise RuntimeError("forward read upgrade requires serving_enabled=false")

    # Regenerate the packet for the selected exact identity before reading or
    # applying it.  A prior release-db compile must never be reused for the
    # HTTP target (and vice versa).
    subprocess.run(
        [sys.executable, str(P / "read-companion.py"), "--target", args.target],
        check=True,
        env=os.environ.copy(),
    )
    packet_path = UPGRADES[args.upgrade]
    packet = packet_path.read_text()
    fail_if_fresh_install_ddl(packet, database, marker)
    auth_packet_path = P / "generated" / "auth-upgrade.sql"
    auth_packet = auth_packet_path.read_text()
    validate_auth_upgrade(auth_packet, database, marker)
    sql(auth_packet)
    sql(packet)
    for statement in json.loads((P / "generated" / "read-indexes.json").read_text()):
        ensure_concurrent_index(statement)
    sql("NOTIFY pgrst,'reload schema'")

    # This verifier re-derives expected bodies from the freshly compiled
    # companion and writes a receipt only after querying the live catalog.
    subprocess.run(
        [sys.executable, str(P / "read-companion.py"), "--owned-fixture", "--verify-only", "--target", args.target],
        check=True,
        env=os.environ.copy(),
    )
    evidence = {
        "status": "INSTALLED_CURRENT_SCHEMA_UPGRADE",
        "upgrade": args.upgrade,
        "packet_sha256": hashlib.sha256(packet.encode()).hexdigest(),
        "packet_path": str(packet_path.relative_to(P.parent.parent)),
        "auth_upgrade_sha256": hashlib.sha256(auth_packet.encode()).hexdigest(),
        "auth_upgrade_path": str(auth_packet_path.relative_to(P.parent.parent)),
        "database": database,
        "marker": marker,
        "serving_enabled": False,
        "scope": f"Live owned {args.target} catalog proof after guarded existing-schema read upgrade; no production claim.",
    }
    (P / "read-upgrade-evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps(evidence, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
