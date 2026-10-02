#!/usr/bin/env python3
"""Record and verify the one Electric logical slot created by a start.

Run ``before`` immediately before Electric starts, ``after`` immediately after
its health check, and retain the receipt. ``cleanup`` is intentionally
receipt-driven: it can inspect/drop only the slot name recorded by ``before``
and confirmed by ``after``.
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
import tempfile


HERE = Path(__file__).resolve().parent
PROJECT_REFS = {"ncsngxlcyxylaeskiteu", "copflsklaefwzipsrjqz"}
DIRECT_HOST = re.compile(r"^db\.([a-z0-9]{20})\.supabase\.co$")
STREAM_ID = re.compile(r"^inbox_[a-z0-9]{20}$")
SLOT_NAME = re.compile(r"^electric_slot_inbox_[a-z0-9]{20}$")
PINNED_CA_FILE = HERE / "supabase-prod-ca-2021.crt"
PINNED_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
HOSTED_PG_OVERRIDE_VARS = ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE")


class ProvenanceError(RuntimeError):
    pass


def hosted_environment(project_ref: str) -> None:
    match = DIRECT_HOST.fullmatch(os.environ.get("PGHOST", ""))
    if not match or match.group(1) != project_ref:
        raise ProvenanceError("PGHOST must be the selected direct Supabase host")
    for name in HOSTED_PG_OVERRIDE_VARS:
        if name in os.environ:
            raise ProvenanceError(f"{name} overrides the approved direct host")
    if os.environ.get("PGSSLMODE") != "verify-full":
        raise ProvenanceError("PGSSLMODE must be verify-full")
    try:
        rootcert = Path(os.environ["PGSSLROOTCERT"]).resolve(strict=True)
        digest = hashlib.sha256(rootcert.read_bytes()).hexdigest()
    except (KeyError, OSError) as exc:
        raise ProvenanceError("PGSSLROOTCERT must point to the pinned Supabase CA") from exc
    if rootcert != PINNED_CA_FILE.resolve(strict=True) or digest != PINNED_CA_SHA256:
        raise ProvenanceError("PGSSLROOTCERT is not the pinned Supabase CA")


def local_environment() -> None:
    host = os.environ.get("PGHOST", "")
    if not host or not (host.startswith("/") or host in {"127.0.0.1", "localhost"}):
        raise ProvenanceError("--local-disposable requires an explicit local PGHOST")
    if os.environ.get("PGDATABASE", "postgres") != "postgres" or os.environ.get("PGUSER", "postgres") != "postgres":
        raise ProvenanceError("--local-disposable requires PGUSER/PGDATABASE postgres")


def psql(sql: str, local: bool) -> list[str]:
    if local:
        local_environment()
    binary = os.environ.get("INBOX_SLOT_PSQL_BIN", "psql")
    environment = os.environ.copy()
    if not local:
        for name in HOSTED_PG_OVERRIDE_VARS:
            environment.pop(name, None)
    result = subprocess.run(
        [binary, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-F", "\t", "-c", sql],
        text=True,
        capture_output=True,
        env=environment,
        check=False,
    )
    if result.returncode != 0:
        raise ProvenanceError(result.stderr.strip() or "psql failed")
    return result.stdout.splitlines()


def list_slots(local: bool) -> list[dict[str, object]]:
    rows = psql(
        "SELECT slot_name, COALESCE(plugin, ''), COALESCE(database::text, ''), active::text "
        "FROM pg_replication_slots ORDER BY slot_name;",
        local,
    )
    slots: list[dict[str, object]] = []
    for row in rows:
        fields = row.split("\t")
        if len(fields) != 4:
            raise ProvenanceError("unexpected pg_replication_slots output")
        slots.append({"slot_name": fields[0], "plugin": fields[1], "database": fields[2], "active": fields[3] == "t"})
    return slots


def write_receipt(path: Path, receipt: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(receipt, handle, indent=2, sort_keys=True)
        handle.write("\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def read_receipt(path: Path) -> dict[str, object]:
    try:
        receipt = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise ProvenanceError("slot provenance receipt is unreadable") from exc
    if not isinstance(receipt, dict):
        raise ProvenanceError("slot provenance receipt must be an object")
    return receipt


def selected_contract(args: argparse.Namespace) -> tuple[str, str, str]:
    if args.project_ref not in PROJECT_REFS:
        raise ProvenanceError("project ref is not approved")
    stream_id = args.stream_id or os.environ.get("ELECTRIC_REPLICATION_STREAM_ID") or f"inbox_{args.project_ref}"
    if not STREAM_ID.fullmatch(stream_id) or not stream_id.endswith(args.project_ref):
        raise ProvenanceError("stream id must be inbox_<selected project ref>")
    slot_name = f"electric_slot_{stream_id}"
    if not SLOT_NAME.fullmatch(slot_name):
        raise ProvenanceError("derived slot name is invalid")
    return stream_id, slot_name, args.database


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("before", "after", "cleanup"))
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--stream-id")
    parser.add_argument("--database", default="postgres")
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--local-disposable", action="store_true")
    args = parser.parse_args(argv)
    if args.local_disposable:
        local_environment()
    else:
        hosted_environment(args.project_ref)
    if args.database != "postgres":
        raise ProvenanceError("Electric provenance requires database postgres")
    stream_id, expected_slot, expected_database = selected_contract(args)

    if args.phase == "before":
        if args.receipt.exists():
            raise ProvenanceError("refusing to overwrite an existing provenance receipt")
        baseline = list_slots(args.local_disposable)
        if any(slot["slot_name"] == expected_slot for slot in baseline):
            raise ProvenanceError("expected Electric slot already exists in the baseline")
        write_receipt(args.receipt, {
            "version": 1,
            "phase": "before",
            "project_ref": args.project_ref,
            "stream_id": stream_id,
            "expected_slot_name": expected_slot,
            "expected_plugin": "pgoutput",
            "expected_database": expected_database,
            "baseline_slots": baseline,
        })
        return 0

    receipt = read_receipt(args.receipt)
    if receipt.get("project_ref") != args.project_ref or receipt.get("stream_id") != stream_id or receipt.get("expected_slot_name") != expected_slot:
        raise ProvenanceError("receipt contract does not match the selected project and stream")
    if receipt.get("expected_plugin") != "pgoutput" or receipt.get("expected_database") != expected_database:
        raise ProvenanceError("receipt expected plugin/database is invalid")

    if args.phase == "after":
        if receipt.get("phase") != "before":
            raise ProvenanceError("after requires a before receipt")
        baseline = receipt.get("baseline_slots")
        if not isinstance(baseline, list):
            raise ProvenanceError("receipt baseline is invalid")
        after = list_slots(args.local_disposable)
        baseline_names = {slot.get("slot_name") for slot in baseline if isinstance(slot, dict)}
        new_slots = [slot for slot in after if slot.get("slot_name") not in baseline_names]
        if len(new_slots) != 1:
            raise ProvenanceError(f"expected exactly one new replication slot, found {len(new_slots)}")
        new_slot = new_slots[0]
        if new_slot != {"slot_name": expected_slot, "plugin": "pgoutput", "database": expected_database, "active": new_slot["active"]}:
            raise ProvenanceError("new replication slot does not match the expected Electric contract")
        receipt.update({"phase": "after", "after_slots": after, "new_slot": new_slot})
        write_receipt(args.receipt, receipt)
        return 0

    if receipt.get("phase") != "after":
        raise ProvenanceError("cleanup requires a completed after receipt")
    current = list_slots(args.local_disposable)
    matches = [slot for slot in current if slot.get("slot_name") == expected_slot]
    if len(matches) != 1:
        raise ProvenanceError("cleanup found no uniquely matching receipt slot")
    slot = matches[0]
    if slot.get("plugin") != "pgoutput" or slot.get("database") != expected_database or slot.get("active") is not False:
        raise ProvenanceError("cleanup slot is not the inactive receipt slot")
    escaped = expected_slot.replace("'", "''")
    psql(f"SELECT pg_drop_replication_slot('{escaped}');", args.local_disposable)
    if any(slot.get("slot_name") == expected_slot for slot in list_slots(args.local_disposable)):
        raise ProvenanceError("receipt slot remains after cleanup")
    receipt.update({"phase": "cleaned", "cleanup": {"slot_name": expected_slot, "status": "dropped"}})
    write_receipt(args.receipt, receipt)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvenanceError as exc:
        print(f"Electric slot provenance blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
