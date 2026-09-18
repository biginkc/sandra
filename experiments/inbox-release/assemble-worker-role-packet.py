#!/usr/bin/env python3
"""Assemble and optionally apply the reviewed projection worker role packet.

The source commit and release database are explicit.  Assembly never opens a
database connection.  Applying is a separate opt-in operation that accepts
only the dedicated release database and its marker; it never targets the
backend-owned install fixture.
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


ROOT = Path(__file__).resolve().parents[2]
HERE = ROOT / "experiments" / "inbox-release"
OUTPUT = HERE / "generated" / "projection-worker-role.sql"
RECEIPT = HERE / "generated" / "projection-worker-role-manifest.json"
SOURCE_PATH = "services/inbox-projection-worker/worker-role.sql"
SOURCE_COMMIT = "fcffde3827da164df85c6ef2e2b4a094f79b512c"
RELEASE_DATABASE = "sandra_inbox_release_20260917"
RELEASE_MARKER = "sandra-inbox-release-owned-synthetic"


def git_show(repo: Path, commit: str, path: str) -> bytes:
    try:
        return subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:{path}"])
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Pinned source missing at {commit}: {path}") from exc


def compile_packet(raw: bytes) -> str:
    source = raw.decode()
    if "inbox_t2_" in source or "install_fixture.identity" in source:
        raise RuntimeError("projection worker role contains an unreviewed fixture reference")
    # The reviewed role source is itself transactional.  Remove only its
    # outer envelope so the release identity guard and role packet execute as
    # one transaction when this generated packet is applied.
    body = re.sub(r"(?m)^\s*BEGIN;\s*", "", source, count=1)
    body = re.sub(r"(?m)^\s*COMMIT;\s*$", "", body, count=1)
    if "CREATE ROLE inbox_projection_worker" not in body:
        raise RuntimeError("projection worker role source drifted")
    guard = f"""DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'{RELEASE_DATABASE}' OR NOT EXISTS(
  SELECT 1 FROM install_fixture.identity WHERE marker='{RELEASE_MARKER}'
 ) THEN RAISE EXCEPTION 'Owned release fixture required'; END IF;
END $$;"""
    return """-- GENERATED PROJECTION WORKER ROLE PACKET. No production execution authorization.
-- Apply only after the release database marker and role review are confirmed.
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='30s';
""" + guard + "\n" + body.strip() + "\nCOMMIT;\n"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", type=Path, required=True)
    parser.add_argument("--commit", default=SOURCE_COMMIT)
    parser.add_argument("--apply", action="store_true", help="apply to the explicitly marked release database")
    args = parser.parse_args()
    repo = args.source_repo.resolve()
    actual = subprocess.check_output(["git", "-C", str(repo), "rev-parse", f"{args.commit}^{{commit}}"], text=True).strip()
    raw = git_show(repo, actual, SOURCE_PATH)
    packet = compile_packet(raw)
    packet_hash = hashlib.sha256(packet.encode()).hexdigest()
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(packet)
    RECEIPT.write_text(json.dumps({
        "schema_version": 1,
        "status": "SOURCE_ONLY_UNINSTALLED",
        "source_repository": str(repo),
        "source_commit": actual,
        "source_path": SOURCE_PATH,
        "source_sha256": hashlib.sha256(raw).hexdigest(),
        "packet_path": "experiments/inbox-release/generated/projection-worker-role.sql",
        "packet_sha256": packet_hash,
        "database": RELEASE_DATABASE,
        "marker": RELEASE_MARKER,
        "apply_requires": ["INBOX_RELEASE_DATABASE", "INBOX_RELEASE_FIXTURE_MARKER", "INBOX_RELEASE_SERVING_ENABLED=false"],
    }, indent=2) + "\n")
    if not args.apply:
        print(json.dumps({"status": "SOURCE_ONLY_UNINSTALLED", "source_commit": actual, "packet_sha256": packet_hash}, indent=2))
        return 0
    if os.environ.get("INBOX_RELEASE_DATABASE") != RELEASE_DATABASE or os.environ.get("INBOX_RELEASE_FIXTURE_MARKER") != RELEASE_MARKER or os.environ.get("INBOX_RELEASE_SERVING_ENABLED", "false").lower() != "false":
        raise RuntimeError("--apply requires the dedicated release database marker and serving_enabled=false")
    sys.path.insert(0, str(ROOT / "experiments" / "inbox-production-install"))
    from fixture_db import guard, sql
    guard()
    sql(packet)
    RECEIPT.write_text(RECEIPT.read_text().replace('"status": "SOURCE_ONLY_UNINSTALLED"', '"status": "INSTALLED_RELEASE_DATABASE"'))
    print(json.dumps({"status": "INSTALLED_RELEASE_DATABASE", "packet_sha256": packet_hash}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
