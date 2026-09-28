#!/usr/bin/env python3
"""Validate an already-installed candidate in an explicitly owned native DB.

This is a test-only adapter for a disposable PostgreSQL cluster.  It never
changes ``fixture_db.py`` or the HTTP fixture guard.  The candidate and read
companion must already be installed with serving disabled; the script then
runs the real source verifier and catalog-pin generator through a narrowly
scoped ``fixture_db`` module injected into ``sys.modules``.  It also grants a
single column privilege, proves both checks reject that drift, revokes it, and
proves the clean catalog passes again.

Example (after installing the generated candidate/read companion into the
owned native cluster):

  NATIVE_PG_SOCKET=/tmp/native/socket NATIVE_PG_PORT=59318 \
  NATIVE_PG_DB=sandra_inbox_native \
  python3 native-disposable-validation.py --evidence /tmp/native-proof.json
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import types
from contextlib import contextmanager


P = pathlib.Path(__file__).resolve().parent


class NativeDatabase:
    def __init__(self, socket: str, port: str, database: str, marker: str):
        self.socket = socket
        self.port = port
        self.database = database
        self.marker = marker

    def sql(self, query: str, role: str = "postgres") -> str:
        result = subprocess.run(
            [
                "psql",
                "-h",
                self.socket,
                "-p",
                self.port,
                "-U",
                role,
                "-d",
                self.database,
                "-X",
                "-qAt",
                "-v",
                "ON_ERROR_STOP=1",
            ],
            input=query,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "native SQL failed")
        return result.stdout.strip()

    def guard(self) -> None:
        identity = self.sql("SELECT current_database() || ':' || current_user")
        if identity != f"{self.database}:postgres":
            raise RuntimeError(f"native fixture identity mismatch: {identity!r}")
        if self.sql(
            "SELECT marker FROM install_fixture.identity WHERE marker="
            + self.literal(self.marker)
        ) != self.marker:
            raise RuntimeError("native fixture marker missing")

    @staticmethod
    def literal(value: str) -> str:
        return "'" + value.replace("'", "''") + "'"


def adapter_for(db: NativeDatabase) -> types.ModuleType:
    adapter = types.ModuleType("fixture_db")
    adapter.guard = db.guard
    adapter.sql = db.sql
    adapter.literal = db.literal
    return adapter


def run_installer_script(db: NativeDatabase, name: str, *args: str) -> None:
    script = P / name
    adapter = adapter_for(db)
    previous = sys.modules.get("fixture_db")
    sys.modules["fixture_db"] = adapter
    try:
        sys.argv = [str(script), *args]
        runpy.run_path(str(script), run_name="__main__")
    finally:
        if previous is None:
            sys.modules.pop("fixture_db", None)
        else:
            sys.modules["fixture_db"] = previous


@contextmanager
def preserve_catalog_evidence():
    path = P / "catalog-evidence.json"
    original = path.read_bytes() if path.exists() else None
    try:
        yield
    finally:
        if original is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(original)


def run_generator(db: NativeDatabase, output_dir: pathlib.Path) -> dict:
    run_installer_script(
        db,
        "generate-catalog-pins.py",
        "--owned-fixture",
        "--write",
        "--output-dir",
        str(output_dir),
    )
    return json.loads((output_dir / "catalog-pin-provenance.json").read_text())


def expected_drift(db: NativeDatabase, script: str, expected: str, *args: str) -> str:
    try:
        run_installer_script(db, script, *args)
    except RuntimeError as error:
        message = str(error)
        if expected not in message:
            raise RuntimeError(f"unexpected negative-control error: {message}") from error
        return message
    raise RuntimeError(f"negative control unexpectedly passed: {script}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", type=pathlib.Path, required=True)
    parser.add_argument("--socket", default=os.environ.get("NATIVE_PG_SOCKET"))
    parser.add_argument("--port", default=os.environ.get("NATIVE_PG_PORT", "5432"))
    parser.add_argument("--database", default=os.environ.get("NATIVE_PG_DB"))
    parser.add_argument(
        "--marker",
        default=os.environ.get("NATIVE_PG_MARKER", "native-disposable-candidate-a09291ac"),
    )
    args = parser.parse_args()
    if not args.socket or not args.database:
        parser.error("--socket/--database or NATIVE_PG_SOCKET/NATIVE_PG_DB are required")

    db = NativeDatabase(args.socket, args.port, args.database, args.marker)
    db.guard()
    baseline = {}
    with tempfile.TemporaryDirectory(prefix="inbox-native-pins-") as output:
        output_dir = pathlib.Path(output)
        with preserve_catalog_evidence():
            run_installer_script(db, "verify.py", "--installed")
            baseline["generator"] = run_generator(db, output_dir)

            db.sql("GRANT SELECT (org_id) ON inbox_bridge.summaries TO anon")
            try:
                baseline["verify_column_drift"] = expected_drift(
                    db, "verify.py", "Column ACL drift", "--installed"
                )
                baseline["generator_column_drift"] = expected_drift(
                    db,
                    "generate-catalog-pins.py",
                    "Column ACL drift",
                    "--owned-fixture",
                    "--write",
                    "--output-dir",
                    str(output_dir / "drift"),
                )
            finally:
                db.sql("REVOKE SELECT (org_id) ON inbox_bridge.summaries FROM anon")

            run_installer_script(db, "verify.py", "--installed")
            baseline["generator_after_revoke"] = run_generator(db, output_dir / "after-revoke")

    result = {
        "database": args.database,
        "port": int(args.port),
        "marker": args.marker,
        "candidate_sha256": baseline["generator"]["candidate_sha256"],
        "generator": baseline["generator"],
        "column_acl_negative_control": {
            "mutation": "GRANT SELECT (org_id) ON inbox_bridge.summaries TO anon",
            "verify_rejected": baseline["verify_column_drift"],
            "generator_rejected": baseline["generator_column_drift"],
            "restored": baseline["generator_after_revoke"],
        },
        "scope": "Owned disposable native catalog; serving remains disabled; no HTTP fixture or production DB.",
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(json.dumps(result, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
