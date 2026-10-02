#!/usr/bin/env python3
"""Collect a read-only recovery inventory from Postgres and Restate.

The database connection comes from libpq's environment so credentials never
appear in argv. Restate's POST is the Admin API's read-only SQL query endpoint;
this tool never calls a mutating endpoint.
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
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin, urlparse
from urllib.request import Request, urlopen


HERE = Path(__file__).resolve().parent
PROJECT_REFS = {"ncsngxlcyxylaeskiteu", "copflsklaefwzipsrjqz"}
DIRECT_HOST = re.compile(r"^db\.([a-z0-9]{20})\.supabase\.co$")
PINNED_CA_FILE = HERE / "supabase-prod-ca-2021.crt"
PINNED_CA_SHA256 = "700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7"
REPLY_STATES = ("approved", "claimed", "dispatch_started", "provider_accepted", "uncertain")
TERMINAL_STEP_STATES = ("succeeded", "failed", "conflicted", "blocked", "cancelled")


class InventoryError(RuntimeError):
    pass


RECOVERY_SQL = f"""
BEGIN TRANSACTION READ ONLY;
WITH metadata AS (
  SELECT o.org_id, o.id, o.requester_id, o.created_at,
    (SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id', s.id, 'effect_key', s.effect_key, 'ordinal', s.ordinal,
      'action', s.action, 'state', s.state, 'generation', s.generation,
      'lease_until', s.lease_until, 'receipt_version', s.receipt_version
    ) ORDER BY s.ordinal, s.id), '[]'::jsonb)
     FROM inbox_operations.steps s
     WHERE s.org_id=o.org_id AND s.operation_id=o.id) AS steps,
    (EXISTS (SELECT 1 FROM inbox_operations.steps s WHERE s.org_id=o.org_id AND s.operation_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM inbox_operations.steps s WHERE s.org_id=o.org_id AND s.operation_id=o.id AND s.state NOT IN {TERMINAL_STEP_STATES!r})) AS all_steps_terminal,
    (EXISTS (SELECT 1 FROM inbox_operations.dispatch_outbox d WHERE d.org_id=o.org_id AND d.operation_id=o.id)
      AND NOT EXISTS (SELECT 1 FROM inbox_operations.dispatch_outbox d WHERE d.org_id=o.org_id AND d.operation_id=o.id AND d.acknowledged_at IS NULL)) AS all_dispatch_ack
  FROM inbox_operations.operations o
)
SELECT jsonb_build_object(
  'reply_attempts', coalesce((SELECT jsonb_agg(jsonb_build_object(
    'org_id', a.org_id, 'id', a.id, 'operation_id', a.operation_id,
    'preparation_id', a.preparation_id, 'item_id', a.item_id,
    'state', a.state, 'generation', a.generation, 'lease_until', a.lease_until,
    'dispatch_started_at', a.dispatch_started_at, 'receipt_version', a.receipt_version,
    'provider_reference', a.provider_reference, 'provider_status', a.provider_status,
    'evidence', a.evidence
  ) ORDER BY a.created_at, a.id)
    FROM inbox_reply_send.attempts a WHERE a.state IN {REPLY_STATES!r}), '[]'::jsonb),
  'metadata_operations', coalesce((SELECT jsonb_agg(
    (to_jsonb(m) - 'all_steps_terminal' - 'all_dispatch_ack') ORDER BY m.created_at, m.id
  ) FROM metadata m WHERE NOT (m.all_steps_terminal AND m.all_dispatch_ack)), '[]'::jsonb)
);
ROLLBACK;
"""


def validate_hosted_environment(project_ref: str) -> None:
    match = DIRECT_HOST.fullmatch(os.environ.get("PGHOST", ""))
    if not match or match.group(1) != project_ref:
        raise InventoryError("PGHOST must be the selected direct Supabase host")
    for name in ("PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE"):
        if name in os.environ:
            raise InventoryError(f"{name} overrides the approved direct host")
    if os.environ.get("PGSSLMODE") != "verify-full":
        raise InventoryError("PGSSLMODE must be verify-full")
    try:
        rootcert = Path(os.environ["PGSSLROOTCERT"]).resolve(strict=True)
        digest = hashlib.sha256(rootcert.read_bytes()).hexdigest()
    except (KeyError, OSError) as exc:
        raise InventoryError("PGSSLROOTCERT must point to the pinned Supabase CA") from exc
    if rootcert != PINNED_CA_FILE.resolve(strict=True) or digest != PINNED_CA_SHA256:
        raise InventoryError("PGSSLROOTCERT is not the pinned Supabase CA")


def validate_local_environment() -> None:
    if not os.environ.get("PGHOST", "").startswith("/"):
        raise InventoryError("--local-disposable requires an explicit local socket PGHOST")
    if os.environ.get("PGUSER", "postgres") != "postgres" or os.environ.get("PGDATABASE", "postgres") != "postgres":
        raise InventoryError("--local-disposable requires PGUSER/PGDATABASE postgres")


def database_inventory(local: bool) -> dict[str, object]:
    if local:
        validate_local_environment()
    binary = os.environ.get("INBOX_RECOVERY_PSQL_BIN", "psql")
    result = subprocess.run(
        [binary, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At", "-c", RECOVERY_SQL],
        env=os.environ.copy(),
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        raise InventoryError(result.stderr.strip() or "read-only recovery query failed")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    if len(lines) != 1:
        raise InventoryError("recovery query did not return exactly one JSON row")
    try:
        value = json.loads(lines[0])
    except json.JSONDecodeError as exc:
        raise InventoryError("recovery query returned invalid JSON") from exc
    if not isinstance(value, dict) or not isinstance(value.get("reply_attempts"), list) or not isinstance(value.get("metadata_operations"), list):
        raise InventoryError("recovery query JSON shape is invalid")
    return value


def restate_url(admin_url: str, path: str) -> str:
    parsed = urlparse(admin_url)
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise InventoryError("Restate admin URL must be an origin without credentials or query parameters")
    return urljoin(admin_url.rstrip("/") + "/", path.lstrip("/"))


def http_json(url: str, method: str = "GET", payload: dict[str, object] | None = None) -> object:
    body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
    request = Request(url, method=method, data=body, headers={"accept": "application/json", **({"content-type": "application/json"} if body else {})})
    try:
        with urlopen(request, timeout=10) as response:
            raw = response.read(2_000_001)
            if len(raw) > 2_000_000:
                raise InventoryError("Restate response exceeded the inventory limit")
            status = response.status
    except (HTTPError, URLError, TimeoutError) as exc:
        raise InventoryError(f"Restate read failed: {exc}") from exc
    if status != 200:
        raise InventoryError(f"Restate read returned HTTP {status}")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise InventoryError("Restate read returned invalid JSON") from exc


def deployment_rows(registry: object) -> list[dict[str, object]]:
    if not isinstance(registry, dict) or not isinstance(registry.get("deployments"), list):
        raise InventoryError("Restate deployment registry JSON shape is invalid")
    rows = [deployment for deployment in registry["deployments"] if isinstance(deployment, dict)]
    for deployment in rows:
        deployment_id = deployment.get("id")
        if not isinstance(deployment_id, str) or not deployment_id or "'" in deployment_id:
            raise InventoryError("Restate deployment has an unsafe or missing id")
    return rows


def restate_inventory(admin_url: str) -> list[dict[str, object]]:
    registry = http_json(restate_url(admin_url, "/deployments"))
    deployments = deployment_rows(registry)
    inventory = []
    for deployment in deployments:
        deployment_id = deployment["id"]
        query = (
            "SELECT id, status, service_name, handler_name, service_key, created_at, modified_at, deployment_id "
            "FROM sys_invocation WHERE status <> 'completed' AND deployment_id = '"
            + str(deployment_id).replace("'", "''")
            + "' ORDER BY created_at, id"
        )
        response = http_json(restate_url(admin_url, "/query"), method="POST", payload={"query": query})
        if isinstance(response, dict) and isinstance(response.get("rows"), list):
            invocations = response["rows"]
            columns = response.get("columns")
            if isinstance(columns, list) and all(isinstance(column, (str, dict)) for column in columns):
                names = [column if isinstance(column, str) else column.get("name") for column in columns]
                if all(isinstance(name, str) and name for name in names) and all(isinstance(row, list) for row in invocations):
                    invocations = [dict(zip(names, row)) for row in invocations]
        elif isinstance(response, list):
            invocations = response
        else:
            raise InventoryError("Restate invocation query JSON shape is invalid")
        inventory.append({"deployment": deployment, "query": query, "invocations": invocations})
    return inventory


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-ref", required=True)
    parser.add_argument("--restate-admin-url", required=True)
    parser.add_argument("--local-disposable", action="store_true")
    parser.add_argument("--write", type=Path)
    args = parser.parse_args(argv)
    if args.project_ref not in PROJECT_REFS:
        raise InventoryError("project ref is not approved")
    if args.local_disposable:
        validate_local_environment()
    else:
        validate_hosted_environment(args.project_ref)
    # Validate the admin origin before opening the database subprocess so a
    # credential-bearing URL is rejected without touching either endpoint.
    restate_url(args.restate_admin_url, "/deployments")
    report = {
        "version": 1,
        "project_ref": args.project_ref,
        "read_only": True,
        "database": database_inventory(args.local_disposable),
        "restate": restate_inventory(args.restate_admin_url),
    }
    rendered = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.write:
        args.write.parent.mkdir(parents=True, exist_ok=True)
        args.write.write_text(rendered)
        args.write.chmod(0o600)
    sys.stdout.write(rendered)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except InventoryError as exc:
        print(f"Recovery inventory blocked: {exc}", file=sys.stderr)
        raise SystemExit(3)
