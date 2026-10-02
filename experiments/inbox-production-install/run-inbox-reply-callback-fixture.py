#!/usr/bin/env python3
"""Run the reviewed R11 callback fixture and record post-commit trigger state.

The SQL packet owns one transaction. This wrapper opens a new libpq connection
after that transaction commits, asserts all three immutable-ledger triggers are
enabled, and records that observation in the 0600 receipt.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


HERE = Path(__file__).resolve().parent
PACKET = HERE / "inbox-reply-callback-fixture.sql"
TRIGGERS = (
    ("inbox_reply_send", "attempts", "guard_reply_send_attempt"),
    ("inbox_reply_send", "operations", "immutable_reply_send_operation"),
    ("inbox_reply_review", "preparations", "immutable_reply_preparation"),
)
REQUIRED_RECEIPT_KEYS = {
    "marker", "org_id", "requester_id", "preparation_id", "operation_id",
    "idempotency_key", "item_a", "item_b", "attempt_a", "attempt_b",
    "contact_a", "contact_b", "reference_a", "reference_b",
}


class FixtureError(RuntimeError):
    pass


def load_receipt(path: Path) -> dict[str, str]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise FixtureError("fixture receipt is unreadable") from exc
    if not isinstance(value, dict) or not REQUIRED_RECEIPT_KEYS.issubset(value):
        raise FixtureError("fixture receipt is missing required IDs")
    if any(not isinstance(value[key], str) or not value[key] for key in REQUIRED_RECEIPT_KEYS):
        raise FixtureError("fixture receipt values must be non-empty strings")
    return {key: value[key] for key in REQUIRED_RECEIPT_KEYS}


def write_receipt(path: Path, receipt: dict[str, object]) -> None:
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False) as handle:
        temporary = Path(handle.name)
        json.dump(receipt, handle, indent=2, sort_keys=True)
        handle.write("\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def psql_args(binary: str) -> list[str]:
    return [binary, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"]


def run_packet(binary: str, values: dict[str, str], create: bool) -> None:
    args = psql_args(binary) + ["-f", str(PACKET), "-v", f"fixture_create={'true' if create else 'false'}", "-v", f"fixture_action={'create' if create else 'remove'}"]
    args.extend(item for key, value in values.items() for item in ("-v", f"fixture_{key}={value}"))
    result = subprocess.run(args, text=True, capture_output=True, env={**os.environ, "LC_ALL": "C"}, check=False)
    if result.returncode:
        raise FixtureError(result.stderr.strip() or "R11 fixture packet failed")


def assert_triggers_from_fresh_connection(binary: str) -> list[dict[str, str]]:
    expected = ",".join(f"('{schema}','{table}','{trigger}')" for schema, table, trigger in TRIGGERS)
    query = (
        "SELECT n.nspname||'.'||c.relname||'.'||t.tgname||'|'||t.tgenabled::text "
        "FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
        "JOIN pg_namespace n ON n.oid=c.relnamespace "
        f"WHERE (n.nspname,c.relname,t.tgname) IN (VALUES {expected}) ORDER BY 1"
    )
    result = subprocess.run(psql_args(binary) + ["-c", query], text=True, capture_output=True, env={**os.environ, "LC_ALL": "C"}, check=False)
    if result.returncode:
        raise FixtureError(result.stderr.strip() or "fresh trigger-state query failed")
    rows = [line.split("|", 1) for line in result.stdout.splitlines() if line]
    if len(rows) != len(TRIGGERS) or any(len(row) != 2 or row[1] != "O" for row in rows):
        raise FixtureError(f"R11 trigger state is not restored: {result.stdout.strip()}")
    return [{"trigger": row[0], "tgenabled": row[1]} for row in rows]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--action", choices=("create", "remove"), required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--psql", default="psql")
    args = parser.parse_args(argv)
    values = load_receipt(args.receipt)
    run_packet(args.psql, values, args.action == "create")
    states = assert_triggers_from_fresh_connection(args.psql)
    receipt = json.loads(args.receipt.read_text(encoding="utf-8"))
    receipt["last_action"] = args.action
    receipt["triggers_after_commit"] = states
    receipt["trigger_check_connection"] = "fresh"
    write_receipt(args.receipt, receipt)
    print(json.dumps({"action": args.action, "triggers_after_commit": states}, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except FixtureError as exc:
        print(f"R11 callback fixture blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
