#!/usr/bin/env python3
"""Guarded Realtime tenant bootstrap for the owned HTTP fixture.

This is an operator tool, not a production deployer.  The default invocation
is read-only and reports the exact prerequisite state.  ``--apply`` is an
explicit, separately guarded operation for the marked local HTTP fixture:

* the current Realtime container is stopped;
* the pinned Realtime image runs its own migrations once as ``supabase_admin``;
* the long-running Realtime process returns to ``supabase_realtime_admin``;
* that runtime role receives only the capabilities Realtime's CDC path needs
  (logical replication and ``SET log_min_messages``).

Realtime's v2.129.3 documentation requires a superuser for migrations.  The
temporary migration process is therefore deliberately separate from the
runtime process.  We do not make the runtime role superuser or grant it
CREATEDB, CREATEROLE, or BYPASSRLS.  No image pull is attempted; the pinned
image must already exist locally.

The script never discovers a target by a broad name pattern.  It verifies the
database identity and every container/network marker before an apply, and
requires ``INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1`` as a second operator
confirmation.  The private migration env file is passed to Docker without
reading or printing its contents.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time
from typing import Any, Callable, Mapping, Sequence


SOCKET = os.environ.get(
    "INBOX_T2_DOCKER_SOCKET",
    "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock",
)
DOCKER = ("docker", "--host", SOCKET)
ROOT = Path(__file__).resolve().parents[2]

DB_CONTAINER = "sandra-inbox-release-http-db-20260917"
REALTIME_CONTAINER = "sandra-inbox-release-http-realtime-20260917"
NETWORK = "sandra-inbox-release-http-20260917"
MARKER = "sandra-inbox-release-http-owned-20260917"
DB_MARKER = "sandra-inbox-http-owned-synthetic-20260917"
PURPOSE = "sandra-inbox-release-http"
OWNER = "release-infra"
DATABASE = "postgres"
RUNTIME_ROLE = "supabase_realtime_admin"
MIGRATION_ROLE = "supabase_admin"

# v2.129.3 is the reviewed local fixture image.  The digest is checked both
# on the image reference and on the running container's immutable Image ID.
REALTIME_IMAGE_REF = (
    "public.ecr.aws/supabase/realtime:v2.129.3@"
    "sha256:3211f8ebd59edcd0aa772186f1c8249c82c6b1ae5565f40dedb7aa93e951fe37"
)
REALTIME_IMAGE_ID = "sha256:3211f8ebd59edcd0aa772186f1c8249c82c6b1ae5565f40dedb7aa93e951fe37"
EXPECTED_MIGRATION = "20260709120000"
EXPECTED_COLUMNS = ("action_filter", "selected_columns")
TENANT_EXTERNAL_ID = "realtime-dev"
BROADCAST_PUBLICATION = "supabase_realtime_messages_publication"
RPC_READY_MARKER = "realtime_bootstrap_rpc_ready"
RPC_READY_TIMEOUT = 120.0
RPC_READY_INTERVAL = 2.0

MigrationState = Mapping[str, Any]


class BootstrapError(RuntimeError):
    """A fail-closed fixture or migration precondition failure."""


def sanitize_process_detail(value: object, *, limit: int = 800) -> str:
    """Keep bounded diagnostic context while excluding credential-like values."""

    detail = re.sub(r"\s+", " ", str(value or "").strip())
    detail = re.sub(
        r"(?i)\b(password|passwd|secret|token|api[_-]?key|jwt|cookie)\b\s*[:=]\s*[^\s,;}]+",
        r"\1=<redacted>",
        detail,
    )
    detail = re.sub(r"(?i)\b(DB_PASSWORD|DATABASE_URL|SUPABASE_SERVICE_ROLE_KEY)=\S+", r"\1=<redacted>", detail)
    return detail[-limit:]


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    """Run Docker without a shell and never expose command output by default."""

    return subprocess.run(
        [*DOCKER, *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=check,
        timeout=90,
    )


def docker_json(*args: str) -> Any:
    result = docker(*args)
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:  # pragma: no cover - defensive CLI path
        raise BootstrapError(f"Docker returned non-JSON for {' '.join(args)}") from exc


def inspect_container(name: str) -> Mapping[str, Any]:
    inspected = docker_json("inspect", name)
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise BootstrapError(f"Expected one inspected container: {name}")
    value = inspected[0]
    if not isinstance(value, dict):
        raise BootstrapError(f"Invalid container inspection: {name}")
    return value


def inspect_network() -> Mapping[str, Any]:
    inspected = docker_json("network", "inspect", NETWORK)
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise BootstrapError(f"Expected one inspected network: {NETWORK}")
    value = inspected[0]
    if not isinstance(value, dict):
        raise BootstrapError(f"Invalid network inspection: {NETWORK}")
    return value


def labels_for(container: Mapping[str, Any]) -> Mapping[str, str]:
    labels = container.get("Config", {}).get("Labels", {})
    return labels if isinstance(labels, dict) else {}


def require_owned_container(
    container: Mapping[str, Any], *, name: str, component: str | None = None
) -> None:
    labels = labels_for(container)
    expected = {"purpose": PURPOSE, "owner": OWNER, "marker": MARKER}
    for key, value in expected.items():
        if labels.get(key) != value:
            raise BootstrapError(
                f"{name} ownership mismatch for {key}: "
                f"expected {value!r}, got {labels.get(key)!r}"
            )
    if component is not None and labels.get("component") not in {None, component}:
        raise BootstrapError(
            f"{name} component mismatch: expected {component!r}, "
            f"got {labels.get('component')!r}"
        )
    networks = container.get("NetworkSettings", {}).get("Networks", {})
    if NETWORK not in networks:
        raise BootstrapError(f"{name} is not attached to {NETWORK}")


def require_owned_network(network: Mapping[str, Any]) -> None:
    labels = network.get("Labels", {})
    if not isinstance(labels, dict):
        labels = {}
    expected = {"purpose": PURPOSE, "owner": OWNER, "marker": MARKER}
    for key, value in expected.items():
        if labels.get(key) != value:
            raise BootstrapError(
                f"network ownership mismatch for {key}: "
                f"expected {value!r}, got {labels.get(key)!r}"
            )


def require_pinned_image(container: Mapping[str, Any], *, name: str) -> None:
    # Config.Image identifies what the container was created from.  Image is
    # the immutable image ID actually used by that running container; checking
    # only image inspect(Config.Image) would accept a retagged replacement.
    if container.get("Image") != REALTIME_IMAGE_ID:
        raise BootstrapError(
            f"{name} running image drift: expected {REALTIME_IMAGE_ID}, "
            f"got {container.get('Image')!r}"
        )
    configured = container.get("Config", {}).get("Image")
    if not isinstance(configured, str) or not configured:
        raise BootstrapError(f"{name} has no configured image reference")
    image = docker_json("image", "inspect", configured)
    if not isinstance(image, list) or len(image) != 1:
        raise BootstrapError(f"Pinned Realtime image is not cached locally")
    image_record = image[0]
    if image_record.get("Id") != REALTIME_IMAGE_ID:
        raise BootstrapError("Cached Realtime image ID does not match the reviewed digest")
    repo_digests = image_record.get("RepoDigests", [])
    if repo_digests and not any(str(ref).endswith("@" + REALTIME_IMAGE_ID) for ref in repo_digests):
        raise BootstrapError("Cached Realtime image repository digest drift")


def require_runtime_container_role(container: Mapping[str, Any], *, name: str) -> None:
    env = container.get("Config", {}).get("Env", [])
    db_user = next(
        (entry.split("=", 1)[1] for entry in env if entry.startswith("DB_USER=")),
        None,
    )
    if db_user != RUNTIME_ROLE:
        raise BootstrapError(
            f"{name} must retain the constrained Realtime DB_USER; got {db_user!r}"
        )


def read_tenant_runtime_user() -> str:
    """Ask the pinned Realtime release to decrypt its tenant settings.

    SQL can only see the encrypted ``db_user`` value.  This read-only release
    evaluation uses the image's own ``DB_ENC_KEY`` and prints only the
    resulting username, so the post-restart check verifies the effective
    tenant connection identity rather than trusting container environment
    metadata alone.
    """

    expression = (
        f"tenant=Realtime.Api.get_tenant_by_external_id(\"{TENANT_EXTERNAL_ID}\", "
        "use_replica?: false); "
        "case Realtime.Database.from_tenant(tenant, \"realtime_bootstrap_probe\", :stop) do "
        "{:ok, settings} -> IO.puts(settings.username); "
        "_ -> IO.puts(\"ERROR\") end"
    )
    result = docker(
        "exec",
        REALTIME_CONTAINER,
        "/app/bin/realtime",
        # ``eval`` launches a non-booted VM, so Ecto's Repo is unavailable.
        # ``rpc`` executes in the already-booted pinned Realtime process.
        "rpc",
        expression,
    )
    lines = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not lines:
        raise BootstrapError("Realtime tenant identity probe returned no username")
    return lines[-1]


def rpc_probe(container_name: str) -> tuple[bool, str]:
    """Probe the running release node without reading tenant data or secrets."""

    expression = (
        "case Process.whereis(Realtime.Repo) do "
        "nil -> IO.puts(\"realtime_bootstrap_repo_unavailable\"); "
        "_ -> case Realtime.Repo.query(\"SELECT 1\", []) do "
        f"{{:ok, _}} -> IO.puts(\"{RPC_READY_MARKER}\"); "
        "_ -> IO.puts(\"realtime_bootstrap_repo_unavailable\") end end"
    )
    try:
        result = docker(
            "exec",
            container_name,
            "/app/bin/realtime",
            "rpc",
            expression,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return False, sanitize_process_detail(exc)
    output = getattr(result, "stdout", "") or ""
    if result.returncode == 0 and any(line.strip() == RPC_READY_MARKER for line in output.splitlines()):
        return True, ""
    # Keep the explicit Repo-unavailable marker in the bounded diagnostic.  A
    # running container can still be waiting for its Ecto Repo, and dropping
    # stdout here made that ordinary startup state indistinguishable from a
    # transport failure while the caller was retrying.
    detail = "\n".join(
        part for part in (output, getattr(result, "stderr", "") or "") if part
    )
    return False, sanitize_process_detail(detail)


def wait_for_rpc_ready(
    container_name: str,
    *,
    timeout: float = RPC_READY_TIMEOUT,
    interval: float = RPC_READY_INTERVAL,
) -> None:
    """Wait for the BEAM RPC node, not merely Docker's running state."""

    last_detail = ""

    def ready() -> bool:
        nonlocal last_detail
        is_ready, detail = rpc_probe(container_name)
        if detail:
            last_detail = detail
        return is_ready

    try:
        wait_for(ready, timeout=timeout, interval=interval)
    except BootstrapError as exc:
        suffix = f"; last RPC probe: {last_detail}" if last_detail else ""
        raise BootstrapError(f"{exc}{suffix}") from exc


def require_fixture_identity(sql_value: str) -> None:
    expected = f"{DATABASE}|{DB_MARKER}"
    if sql_value.strip() != expected:
        raise BootstrapError(
            f"HTTP fixture database identity mismatch: expected {expected!r}, "
            f"got {sql_value.strip()!r}"
        )


def sql_query(query: str, *, user: str = "postgres") -> str:
    result = docker(
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-XqAt",
        "-U",
        user,
        "-d",
        DATABASE,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        query,
    )
    return result.stdout.strip()


def read_identity() -> str:
    return sql_query(
        "SELECT current_database() || '|' || "
        "(SELECT marker FROM install_fixture.identity);"
    )


def read_tenant_state() -> dict[str, Any]:
    """Read metadata without decrypting or exposing tenant credentials.

    Realtime stores CDC settings encrypted in ``public.extensions``.  The
    fingerprint proves the migration rehearsal did not rewrite the tenant's
    encrypted connection settings (notably ``db_user``); the key's presence
    and the running container's constrained DB_USER are checked separately.
    The ciphertext is never printed.
    """

    raw = sql_query(
        "SELECT json_build_object("
        "'tenant_exists', EXISTS(SELECT 1 FROM public.tenants "
        f"WHERE external_id='{TENANT_EXTERNAL_ID}'), "
        "'migrations_ran', COALESCE((SELECT migrations_ran FROM public.tenants "
        f"WHERE external_id='{TENANT_EXTERNAL_ID}'), -1), "
        "'settings_fingerprint', COALESCE((SELECT md5(settings::text) "
        f"FROM public.extensions WHERE tenant_external_id='{TENANT_EXTERNAL_ID}' "
        "AND type='postgres_cdc_rls'), ''), "
        "'settings_has_db_user', COALESCE((SELECT settings ? 'db_user' "
        f"FROM public.extensions WHERE tenant_external_id='{TENANT_EXTERNAL_ID}' "
        "AND type='postgres_cdc_rls'), false));"
    )
    try:
        state = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise BootstrapError("Realtime tenant catalog query returned invalid JSON") from exc
    if not isinstance(state, dict):
        raise BootstrapError("Realtime tenant catalog query returned an invalid object")
    if not state.get("tenant_exists") or not state.get("settings_has_db_user"):
        raise BootstrapError(
            f"Realtime tenant {TENANT_EXTERNAL_ID} is missing its encrypted "
            "postgres_cdc_rls db_user setting"
        )
    return state


def migration_state_advanced(before: MigrationState, after: MigrationState) -> bool:
    """Prove progress in the authoritative tenant schema migration ledger.

    ``public.tenants.migrations_ran`` is cluster metadata and can be reset by
    Realtime startup after a restore.  The tenant database's
    ``realtime.schema_migrations`` row count is the durable migration evidence
    that survives that reset.
    """

    before_count = int(before.get("migration_count", -1))
    after_count = int(after.get("migration_count", -1))
    return before_count >= 0 and after_count > before_count


def require_tenant_settings_unchanged(before: MigrationState, after: MigrationState) -> None:
    if before.get("settings_fingerprint") != after.get("settings_fingerprint"):
        raise BootstrapError(
            "Realtime migration changed encrypted tenant connection settings; "
            "refusing to claim the constrained db_user was preserved"
        )


def read_migration_state() -> dict[str, Any]:
    latest = sql_query(
        "SELECT COALESCE(max(version)::text, '') FROM realtime.schema_migrations;"
    )
    migration_count = sql_query(
        "SELECT count(*)::text FROM realtime.schema_migrations;"
    )
    columns = sql_query(
        "SELECT COALESCE(string_agg(column_name, ',' ORDER BY column_name), '') "
        "FROM information_schema.columns "
        "WHERE table_schema='realtime' AND table_name='subscription' "
        "AND column_name IN ('action_filter','selected_columns');"
    )
    role = sql_query(
        "SELECT json_build_object("
        "'rolcanlogin', r.rolcanlogin, "
        "'rolreplication', r.rolreplication, "
        "'rolsuper', r.rolsuper, "
        "'rolcreatedb', r.rolcreatedb, "
        "'rolcreaterole', r.rolcreaterole, "
        "'rolbypassrls', r.rolbypassrls, "
        "'authenticated_member', pg_has_role('supabase_realtime_admin', 'authenticated', 'MEMBER'), "
        "'set_log_min_messages', has_parameter_privilege("
        "'supabase_realtime_admin', 'log_min_messages', 'SET')) "
        "FROM pg_roles r WHERE r.rolname='supabase_realtime_admin';"
    )
    ledger_select = sql_query(
        "SELECT has_table_privilege('supabase_realtime_admin', "
        "'realtime.schema_migrations', 'SELECT');"
    )
    try:
        role_data = json.loads(role)
    except json.JSONDecodeError as exc:
        raise BootstrapError("Realtime role catalog query returned invalid JSON") from exc
    try:
        migration_count_value = int(migration_count)
    except ValueError as exc:
        raise BootstrapError("Realtime schema migration ledger returned an invalid count") from exc
    return {
        "latest_migration": latest,
        "migration_count": migration_count_value,
        "columns": tuple(filter(None, columns.split(","))),
        "schema_migrations_select": ledger_select.strip() == "t",
        "role": role_data,
    }


def migration_complete(state: MigrationState) -> bool:
    return (
        state.get("latest_migration") == EXPECTED_MIGRATION
        and set(EXPECTED_COLUMNS).issubset(set(state.get("columns", ())))
    )


def runtime_role_sql() -> str:
    """Return the bounded runtime grants; no superuser or broad ACL changes."""

    return (
        "BEGIN;\n"
        "ALTER ROLE supabase_realtime_admin WITH REPLICATION;\n"
        "GRANT authenticated TO supabase_realtime_admin WITH INHERIT FALSE, SET TRUE;\n"
        "GRANT SELECT ON TABLE realtime.schema_migrations TO supabase_realtime_admin;\n"
        "GRANT SET ON PARAMETER log_min_messages TO supabase_realtime_admin;\n"
        "COMMIT;"
    )


def apply_runtime_role() -> None:
    """Restore the bounded CDC role grants after Realtime migrations run."""

    docker(
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-XqAt",
        "-U",
        MIGRATION_ROLE,
        "-d",
        DATABASE,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        runtime_role_sql(),
    )


def broadcast_publication_sql() -> str:
    """Return the narrow owner-side repair for Realtime's broadcast publication.

    Realtime v2.129.3 creates this publication from the constrained tenant
    connection when it is absent.  That connection cannot CREATE on the
    database after the hardening migration, so the reviewed migration role
    creates the exact one-table publication ahead of the runtime restart.
    """

    return (
        "DO $$\n"
        "BEGIN\n"
        f"  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = '{BROADCAST_PUBLICATION}') THEN\n"
        f"    EXECUTE 'CREATE PUBLICATION {BROADCAST_PUBLICATION} FOR TABLE realtime.messages';\n"
        "  END IF;\n"
        "END;\n"
        "$$;"
    )


def apply_broadcast_publication() -> None:
    """Create the exact broadcast publication using the owner-side role."""

    docker(
        "exec",
        "-i",
        DB_CONTAINER,
        "psql",
        "-XqAt",
        "-U",
        MIGRATION_ROLE,
        "-d",
        DATABASE,
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        broadcast_publication_sql(),
    )


def read_broadcast_publication_state() -> bool:
    """Return whether the broadcast publication has only its expected tables."""

    value = sql_query(
        "SELECT ("
        f"EXISTS (SELECT 1 FROM pg_publication WHERE pubname = '{BROADCAST_PUBLICATION}') "
        "AND EXISTS (SELECT 1 FROM pg_publication_tables "
        f"WHERE pubname = '{BROADCAST_PUBLICATION}' "
        "AND schemaname = 'realtime' AND tablename = 'messages') "
        "AND NOT EXISTS (SELECT 1 FROM pg_publication_tables "
        f"WHERE pubname = '{BROADCAST_PUBLICATION}' "
        "AND (schemaname <> 'realtime' OR (tablename <> 'messages' "
        "AND tablename NOT LIKE 'messages\\_%' ESCAPE '\\')))"
        ")::text;"
    )
    return value.strip() == "t"


def require_runtime_role_minimum(state: MigrationState) -> None:
    role = state.get("role")
    if not isinstance(role, dict):
        raise BootstrapError("Realtime runtime role is missing")
    if not role.get("rolcanlogin"):
        raise BootstrapError("Realtime runtime role must be LOGIN")
    prohibited = ("rolsuper", "rolcreatedb", "rolcreaterole", "rolbypassrls")
    if any(role.get(key) for key in prohibited):
        raise BootstrapError("Realtime runtime role has an unsafe elevated attribute")
    if not role.get("authenticated_member"):
        raise BootstrapError("Realtime runtime role cannot SET ROLE authenticated")
    if not role.get("rolreplication"):
        raise BootstrapError("Realtime runtime role lacks logical replication privilege")
    if not role.get("set_log_min_messages"):
        raise BootstrapError("Realtime runtime role lacks SET log_min_messages privilege")
    if not state.get("schema_migrations_select"):
        raise BootstrapError("Realtime runtime role lacks SELECT on realtime.schema_migrations")


def build_migration_run_args(
    *,
    env_file: Path,
    temp_name: str = "sandra-inbox-release-realtime-migration-20260917",
) -> list[str]:
    """Build a no-pull, exact-image migration container command.

    ``env_file`` must be a private ignored file containing DB_PASSWORD and the
    other Realtime secrets.  It is never read by this process and never
    printed.  The explicit DB_USER override is the only identity difference:
    v2.129.3 documents a superuser for its migrations.
    """

    if not env_file.is_file():
        raise BootstrapError(f"Realtime migration env file is missing: {env_file}")
    if env_file.stat().st_mode & 0o077:
        raise BootstrapError("Realtime migration env file must be owner-readable only")
    return [
        *DOCKER,
        "run",
        "-d",
        "--name",
        temp_name,
        "--label",
        f"purpose={PURPOSE}",
        "--label",
        f"owner={OWNER}",
        "--label",
        f"marker={MARKER}",
        "--label",
        "component=realtime-migration",
        "--network",
        NETWORK,
        "--network-alias",
        "realtime-dev",
        "--memory",
        "384m",
        "--cpus",
        "0.5",
        "--env-file",
        str(env_file),
        "--env",
        "DB_HOST=db",
        "--env",
        "DB_PORT=5432",
        "--env",
        "DB_NAME=postgres",
        "--env",
        "DB_USER=supabase_admin",
        "--env",
        "DB_SSL=false",
        "--env",
        "PORT=4100",
        "--env",
        # Existing tenant metadata is authoritative.  Seeding here can
        # rewrite encrypted db_user settings from the migration identity.
        "SEED_SELF_HOST=false",
        "--env",
        "SELF_HOST_TENANT_NAME=realtime-dev",
        "--env",
        "APP_NAME=realtime",
        "--env",
        "RUN_JANITOR=false",
        REALTIME_IMAGE_REF,
        "/app/bin/server",
    ]


def invoke_tenant_migrations(container_name: str) -> str:
    """Explicitly ask the pinned release to run the existing tenant ledger."""

    expression = (
        f"tenant=Realtime.Api.get_tenant_by_external_id(\"{TENANT_EXTERNAL_ID}\", "
        "use_replica?: false); "
        # The migration module connects through the tenant's encrypted
        # extension settings, so DB_USER on the temporary process alone does
        # not select the administrative identity.  Replace only the in-memory
        # settings passed to the migration worker; the catalog is untouched.
        "tenant=%{tenant | extensions: Enum.map(tenant.extensions, fn extension -> "
        "if extension.type == \"postgres_cdc_rls\" do "
        "settings=Map.merge(extension.settings, %{\"db_user\" => "
        "Realtime.Crypto.encrypt!(\"supabase_admin\"), \"db_password\" => "
        "Realtime.Crypto.encrypt!(System.fetch_env!(\"DB_PASSWORD\"))}); "
        "%{extension | settings: settings}; else extension end end)}; "
        "case Realtime.Tenants.Migrations.run_migrations(tenant) do "
        ":ok -> IO.puts(\"started\"); :noop -> IO.puts(\"already_complete\"); "
        "_other -> raise \"tenant migration returned an unexpected status\" end"
    )
    try:
        result = docker(
            "exec",
            container_name,
            "/app/bin/realtime",
            # The migration process is booted by /app/bin/server; use its remote
            # node so the Ecto repo and tenant migration application are running.
            "rpc",
            expression,
        )
    except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError) as exc:
        detail = sanitize_process_detail(getattr(exc, "stderr", "") or exc)
        raise BootstrapError(f"Realtime tenant migration RPC failed: {detail}") from exc
    status = next(
        (line.strip() for line in reversed(result.stdout.splitlines()) if line.strip()),
        "",
    )
    if status not in {"started", "already_complete"}:
        raise BootstrapError(
            "Realtime tenant migration RPC returned an unexpected status: "
            + sanitize_process_detail(status)
        )
    return status


def require_mutation_confirmation() -> None:
    if os.environ.get("INBOX_RELEASE_ALLOW_RUNTIME_MUTATION") != "1":
        raise BootstrapError(
            "Refusing mutation: set INBOX_RELEASE_ALLOW_RUNTIME_MUTATION=1 "
            "for the owned local fixture only"
        )


def wait_for(
    predicate: Callable[[], bool], *, timeout: float = 120.0, interval: float = 2.0
) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(interval)
    raise BootstrapError(f"Timed out after {timeout:.0f}s waiting for Realtime migration state")


def cleanup_migration_container(temp_name: str) -> None:
    """Remove the helper and always attempt to restore the long-running node."""

    cleanup_error: Exception | None = None
    try:
        docker("rm", "-f", temp_name, check=False)
    except Exception as exc:  # Docker timeout/transport failure must not skip restart.
        cleanup_error = exc

    try:
        # A failed start must be visible to the caller; check=False would leave
        # the fixture down and defer the error to an unrelated later probe.
        docker("start", REALTIME_CONTAINER)
        wait_for_rpc_ready(REALTIME_CONTAINER)
    except Exception as exc:
        if cleanup_error is not None:
            raise BootstrapError(
                "Failed to remove the temporary Realtime migration container and "
                "failed to restore the long-running Realtime container"
            ) from exc
        raise

    if cleanup_error is not None:
        raise BootstrapError(
            "Temporary Realtime migration container cleanup failed after the "
            "long-running Realtime container was restored"
        ) from cleanup_error


def validate_fixture(*, require_running: bool = True) -> Mapping[str, Any]:
    network = inspect_network()
    require_owned_network(network)
    db = inspect_container(DB_CONTAINER)
    require_owned_container(db, name=DB_CONTAINER)
    if require_running and db.get("State", {}).get("Status") != "running":
        raise BootstrapError("Owned HTTP database is not running")
    realtime = inspect_container(REALTIME_CONTAINER)
    require_owned_container(realtime, name=REALTIME_CONTAINER, component="realtime")
    require_pinned_image(realtime, name=REALTIME_CONTAINER)
    require_runtime_container_role(realtime, name=REALTIME_CONTAINER)
    if require_running and realtime.get("State", {}).get("Status") != "running":
        raise BootstrapError("Owned Realtime container is not running")
    require_fixture_identity(read_identity())
    read_tenant_state()
    return realtime


def apply_bootstrap(env_file: Path) -> dict[str, Any]:
    require_mutation_confirmation()
    realtime = validate_fixture(require_running=True)
    # Validate the private env file and construct the complete migration
    # argv before touching the database or stopping Realtime.
    migration_args = build_migration_run_args(env_file=env_file)
    before_state = read_migration_state()
    before_tenant = read_tenant_state()
    # Docker's running state is not the Realtime node's readiness boundary.
    # The first tenant identity RPC below must use the same bounded Repo probe
    # as the migration invocation; otherwise a restart race fails immediately
    # and bypasses the retry/diagnostic path.
    wait_for_rpc_ready(REALTIME_CONTAINER)
    if read_tenant_runtime_user() != RUNTIME_ROLE:
        raise BootstrapError(
            "Realtime tenant realtime-dev currently resolves to a different DB user; "
            "refusing to rewrite encrypted settings"
        )
    # A pre-existing migration helper must never be adopted or overwritten.
    temp_name = "sandra-inbox-release-realtime-migration-20260917"
    existing = docker("inspect", temp_name, check=False)
    if existing.returncode == 0:
        raise BootstrapError(f"Refusing to adopt existing migration container: {temp_name}")

    # Grant the runtime capability only after all ownership checks.  The
    # migration process itself is run as the documented superuser and is
    # removed after the schema reaches the pinned image's catalog version.
    apply_runtime_role()
    migration_needed = not migration_complete(before_state)
    migration_rpc_status = "not_needed"
    if migration_needed:
        docker("stop", REALTIME_CONTAINER)
        migration_succeeded = False
        try:
            subprocess.run(
                migration_args,
                cwd=ROOT,
                check=True,
                text=True,
                capture_output=True,
                timeout=90,
            )

            def migration_container_running() -> bool:
                status = inspect_container(temp_name).get("State", {}).get("Status")
                if status == "exited":
                    raise BootstrapError(
                        "Realtime migration container exited before explicit tenant invocation"
                    )
                return status == "running"

            wait_for(migration_container_running, timeout=30)
            # Docker reports `running` while /app/run.sh is still executing
            # the image's startup migration.  Do not invoke the tenant ledger
            # until the remote BEAM node has accepted an RPC.
            wait_for_rpc_ready(temp_name)
            migration_rpc_status = invoke_tenant_migrations(temp_name)

            def ready() -> bool:
                try:
                    return migration_complete(read_migration_state())
                except (subprocess.CalledProcessError, BootstrapError):
                    return False

            wait_for(ready)
            migration_succeeded = True
        finally:
            # Restore the owned service even when a migration fails.  Cleanup
            # errors cannot skip this restoration attempt. The pinned schema
            # hardening migration may revoke the CDC ledger grant, so restore
            # it before reconnecting the long-running constrained process.
            try:
                if migration_succeeded:
                    apply_runtime_role()
                    apply_broadcast_publication()
            finally:
                cleanup_migration_container(temp_name)
        if not migration_succeeded:
            raise BootstrapError("Realtime migration process did not reach the pinned schema")
        wait_for(
            lambda: inspect_container(REALTIME_CONTAINER).get("State", {}).get("Status") == "running",
            timeout=30,
        )
    else:
        # Idempotent already-complete runs still repair the explicit ledger
        # grant if a prior hardening/restart removed it.
        apply_runtime_role()
        apply_broadcast_publication()
    state = read_migration_state()
    tenant = read_tenant_state()
    require_tenant_settings_unchanged(before_tenant, tenant)
    if read_tenant_runtime_user() != RUNTIME_ROLE:
        raise BootstrapError(
            "Realtime tenant realtime-dev did not restore its constrained DB user"
        )
    if migration_needed and migration_rpc_status != "started":
        raise BootstrapError(
            "Realtime schema was incomplete but the tenant migration RPC did not start a migration"
        )
    if migration_needed and not migration_state_advanced(before_state, state):
        raise BootstrapError(
            "Realtime schema reached the pinned columns without advancing the authoritative schema migration ledger; "
            "an actual tenant migration invocation was not proven"
        )
    require_runtime_role_minimum(state)
    if not read_broadcast_publication_state():
        raise BootstrapError(
            f"Realtime broadcast publication {BROADCAST_PUBLICATION} is missing or has unexpected tables"
        )
    if not migration_complete(state):
        raise BootstrapError(f"Realtime schema is not at the pinned migration level: {state!r}")
    return {
        "status": "BOOTSTRAPPED",
        "database": DATABASE,
        "database_marker": DB_MARKER,
        "runtime_role": RUNTIME_ROLE,
        "migration_role": MIGRATION_ROLE,
        "migration": state["latest_migration"],
        "migration_count": state["migration_count"],
        "migration_rpc_status": migration_rpc_status,
        "columns": list(state["columns"]),
        "realtime_container": REALTIME_CONTAINER,
        "image_id": realtime.get("Image"),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apply the guarded local bootstrap")
    parser.add_argument(
        "--migration-env-file",
        type=Path,
        help="private owner-readable env file containing the Realtime migration secrets",
    )
    args = parser.parse_args(argv)
    try:
        if args.apply:
            if args.migration_env_file is None:
                raise BootstrapError("--apply requires --migration-env-file")
            result = apply_bootstrap(args.migration_env_file)
        else:
            realtime = validate_fixture(require_running=False)
            state = read_migration_state()
            result = {
                "status": "READY_TO_APPLY" if not migration_complete(state) else "ALREADY_COMPLETE",
                "database": DATABASE,
                "database_marker": DB_MARKER,
                "runtime_role": RUNTIME_ROLE,
                "migration_role": MIGRATION_ROLE,
                "migration": state["latest_migration"],
                "columns": list(state["columns"]),
                "runtime_role_catalog": state["role"],
                "realtime_running": realtime.get("State", {}).get("Status"),
                "next_step": "--apply --migration-env-file <private-file>" if not migration_complete(state) else "none",
            }
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (BootstrapError, subprocess.CalledProcessError) as exc:
        print(f"BLOCKED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
