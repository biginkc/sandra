#!/usr/bin/env python3
"""Disposable PostgreSQL 17 proof for the emergency capture packet.

By default this provisions a private Supabase local stack, copies the current
tree's migrations except the three Inbox migrations, resets that database, and
then applies the three approved Inbox migrations. It never targets the shared
54329 stack. Pass --database-url only to use an explicitly supplied local
disposable database.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from urllib.parse import unquote, urlsplit, urlunsplit


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OFF = HERE / "capture-off.sql"
RESTORE = HERE / "capture-restore.sql"
RUNNER = HERE / "run_capture_packet.py"
PRODUCTION_TARGET_REF = "copflsklaefwzipsrjqz"
LOCAL_TEST_CONTAINER: str | None = None
INVENTORY = json.loads((HERE / "capture-trigger-inventory.json").read_text())
TARGET_MIGRATIONS = [
    ROOT / "supabase/migrations/20261004050000_inbox_control_foundation.sql",
    ROOT / "supabase/migrations/20261004050100_inbox_read_companion.sql",
    ROOT / "supabase/migrations/20261004050200_inbox_backend_operation_reply.sql",
]
TARGET_NAMES = {p.name for p in TARGET_MIGRATIONS}
RECONCILE_CATALOG_SOURCE = Path(
    os.environ.get("INBOX_RECONCILE_SOURCE", ROOT.parent / "rt-reconcile/scripts/inbox-reconcile-completion.mjs")
)

CAPTURE_TARGET_TABLES = (
    "public.inbox_inbound_heads",
    "inbox_message_capture.sender_buckets",
    "inbox_message_capture.sender_groups",
    "inbox_message_capture.dirty",
    "inbox_message_capture.versions",
    "inbox_message_capture.route_edges",
    "inbox_maintained.rows",
    "inbox_maintained.queue",
    "inbox_parent.work",
    "inbox_safety.routes",
    "inbox_backfill.collisions",
    "inbox_policy.versions",
    "inbox_bridge.access_epochs",
    "inbox_bridge.summaries",
    "inbox_bridge.filter_rows",
    "inbox_operation_domain.target_versions",
    "inbox_operation_domain.sms_scopes",
    "inbox_reply_context.versions",
)


def reconcile_catalog_schemas() -> list[str]:
    source = RECONCILE_CATALOG_SOURCE.read_text()
    match = re.search(r"const CATALOG_SCHEMAS = Object\.freeze\(\[(.*?)\]\);", source, flags=re.DOTALL)
    if not match:
        raise RuntimeError(f"could not read CATALOG_SCHEMAS from {RECONCILE_CATALOG_SOURCE}")
    schemas = re.findall(r'"([^"]+)"', match.group(1))
    if not schemas:
        raise RuntimeError("CATALOG_SCHEMAS was empty")
    return schemas


CATALOG_SCHEMAS = reconcile_catalog_schemas()


def run(
    argv: list[str],
    *,
    cwd: Path | None = None,
    input_text: str | None = None,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, input=input_text, text=True, capture_output=True, env=env)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({' '.join(argv)}):\n{result.stdout}\n{result.stderr}")
    return result


def psql(database_url: str, sql: str, *, check: bool = True) -> str:
    safe_url, password = passwordless_url(database_url)
    result = run(
        ["psql", safe_url, "-X", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", sql],
        env={**os.environ, "PGPASSWORD": password},
        check=check,
    )
    return result.stdout.strip()


def psql_result(database_url: str, sql: str) -> subprocess.CompletedProcess[str]:
    safe_url, password = passwordless_url(database_url)
    return run(
        ["psql", safe_url, "-X", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", sql],
        env={**os.environ, "PGPASSWORD": password},
        check=False,
    )


def apply_file(database_url: str, path: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    safe_url, password = passwordless_url(database_url)
    return run(
        ["psql", safe_url, "-X", "-v", "ON_ERROR_STOP=1", "-f", str(path)],
        env={**os.environ, "PGPASSWORD": password},
        check=check,
    )


def passwordless_url(database_url: str) -> tuple[str, str]:
    parsed = urlsplit(database_url)
    if parsed.password is None or parsed.username is None or parsed.hostname is None:
        raise RuntimeError("disposable status URL did not include expected credentials")
    password = unquote(parsed.password)
    host = parsed.hostname
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    authority = f"{parsed.username}@{host}:{parsed.port or 5432}"
    return urlunsplit((parsed.scheme, authority, parsed.path, "", "")), password


def runner_apply(database_url: str, packet_name: str, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    global LOCAL_TEST_CONTAINER
    runner_url, password = passwordless_url(database_url)
    runner_env = {**os.environ, "NODE_ENV": "test", "INBOX_EMERGENCY_DB_PASSWORD": password}
    if LOCAL_TEST_CONTAINER is not None:
        runner_env["INBOX_EMERGENCY_LOCAL_TEST_CONTAINER"] = LOCAL_TEST_CONTAINER
    result = run(
        [
            "python3",
            str(RUNNER),
            "--packet",
            packet_name,
            "--database-url",
            runner_url,
            "--target-ref",
            PRODUCTION_TARGET_REF,
            "--i-understand-production",
            "--local-test",
        ],
        cwd=ROOT,
        env=runner_env,
        check=False,
    )
    # run() intentionally inherits the environment; the runner itself reads
    # this password only from the child environment, never from argv.
    if check and result.returncode:
        raise RuntimeError(f"runner failed for {packet_name}:\n{result.stdout}\n{result.stderr}")
    return result


def apply_packet_text_with_local_identity(
    database_url: str,
    packet: str,
    *,
    prefix: str,
    target_ref: str | None = "local-test",
    local_test: str | None = "on",
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    """Test-only packet executor; generated packets use runner_apply above."""
    descriptor, path_string = tempfile.mkstemp(prefix=prefix, suffix=".sql")
    os.close(descriptor)
    path = Path(path_string)
    try:
        safe_url, password = passwordless_url(database_url)
        input_text = (
            "\\set ON_ERROR_STOP on\n"
            "BEGIN;\n"
        )
        if target_ref is not None:
            input_text += f"SET LOCAL inbox.emergency_target_ref = '{target_ref}';\n"
        if local_test is not None:
            input_text += f"SET LOCAL inbox.emergency_local_test = '{local_test}';\n"
        command = ["psql", safe_url, "-X", "-v", "ON_ERROR_STOP=1", "-f", "-"]
        if LOCAL_TEST_CONTAINER is not None:
            command = [
                "docker",
                "exec",
                "-i",
                LOCAL_TEST_CONTAINER,
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
            input_text += packet + "\n"
        else:
            escaped = str(path).replace("\\", "\\\\").replace("'", "''")
            input_text += f"\\i '{escaped}'\n"
        return run(
            command,
            input_text=input_text,
            env={**os.environ, "PGPASSWORD": password},
            check=check,
        )
    finally:
        path.unlink(missing_ok=True)


def provision_stack() -> tuple[Path, str]:
    project = Path(tempfile.mkdtemp(prefix="sandra-inbox-emergency-stack-"))
    try:
        run(["supabase", "init", "--workdir", str(project)])
        config_path = project / "supabase/config.toml"
        config = config_path.read_text()
        project_id = f"sandra-emergency-{uuid.uuid4().hex[:8]}"
        db_port = 55400 + (uuid.uuid4().int % 200)
        api_port = db_port + 1
        config = re.sub(r'^project_id\s*=.*$', f'project_id = "{project_id}"', config, flags=re.MULTILINE)
        config = re.sub(r'(^\[api\][\s\S]*?^port\s*=\s*)\d+', rf'\g<1>{api_port}', config, count=1, flags=re.MULTILINE)
        config = re.sub(r'(^\[db\][\s\S]*?^port\s*=\s*)\d+', rf'\g<1>{db_port}', config, count=1, flags=re.MULTILINE)
        config_path.write_text(config)
        migrations = project / "supabase/migrations"
        migrations.mkdir(parents=True, exist_ok=True)
        for source in sorted((ROOT / "supabase/migrations").glob("*.sql")):
            if source.name not in TARGET_NAMES:
                shutil.copy2(source, migrations / source.name)
        exclude = "realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"
        run(["supabase", "start", "--workdir", str(project), "--exclude", exclude, "--ignore-health-check", "--yes"])
        status = json.loads(run(["supabase", "status", "--workdir", str(project), "--output", "json"]).stdout)
        database_url = status.get("DB_URL")
        if not isinstance(database_url, str) or "127.0.0.1:54329" in database_url:
            raise RuntimeError(f"unexpected disposable database URL: {database_url!r}")
        run(["supabase", "db", "reset", "--workdir", str(project), "--local", "--no-seed", "--yes"])
        for migration in TARGET_MIGRATIONS:
            apply_file(database_url, migration)
        return project, database_url
    except BaseException:
        run(["supabase", "stop", "--workdir", str(project), "--no-backup", "--yes"], check=False)
        shutil.rmtree(project, ignore_errors=True)
        raise


def body_statement(packet: str, function_name: str) -> str:
    match = re.search(
        rf"CREATE OR REPLACE FUNCTION {re.escape(function_name)}\(\).*?END\s*\$\$;",
        packet,
        flags=re.DOTALL,
    )
    if not match:
        raise RuntimeError(f"function statement not found in packet: {function_name}")
    return match.group(0)


def inbox_counts(database_url: str) -> dict[str, int]:
    result: dict[str, int] = {}
    for table in CAPTURE_TARGET_TABLES:
        result[table] = int(psql(database_url, f"SELECT count(*) FROM {table}"))
    return result


def quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def inbox_content_digests(database_url: str) -> dict[str, str]:
    """Digest every capture target's content, ordered by its primary key."""
    result: dict[str, str] = {}
    for table in CAPTURE_TARGET_TABLES:
        schema, relation = table.split(".", 1)
        pk_sql = f"""SELECT a.attname
  FROM pg_index i
  CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ordinal)
  JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
 WHERE i.indrelid='{schema}.{relation}'::regclass AND i.indisprimary
 ORDER BY k.ordinal"""
        pk_columns = psql(database_url, pk_sql).splitlines()
        if not pk_columns:
            raise RuntimeError(f"capture target has no primary key: {table}")
        order_by = ", ".join(f"t.{quote_ident(column)}" for column in pk_columns)
        result[table] = psql(
            database_url,
            f"SELECT md5(coalesce(string_agg(row_to_json(t)::text, E'\\n' ORDER BY {order_by}), '')) FROM {quote_ident(schema)}.{quote_ident(relation)} AS t",
        )
    return result


def function_body_digests(database_url: str) -> dict[str, str]:
    names_sql = ",".join("'" + f["name"] + "'" for f in INVENTORY["functions"])
    return json.loads(
        psql(
            database_url,
            f"SELECT jsonb_object_agg(n.nspname||'.'||p.proname,md5(p.prosrc)) "
            f"FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
            f"WHERE (n.nspname||'.'||p.proname) = ANY(ARRAY[{names_sql}])",
        )
    )


def catalog_fingerprint(database_url: str) -> dict[str, object]:
    schemas_sql = ",".join("'" + schema.replace("'", "''") + "'" for schema in CATALOG_SCHEMAS)
    schema_array = f"ARRAY[{schemas_sql}]::text[]"
    queries = {
        "relations": f"""SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind) ORDER BY n.nspname,c.oid), '[]'::jsonb)
FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname=ANY({schema_array})""",
        "functions": f"""SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.oid::regprocedure::text) ORDER BY n.nspname,p.oid), '[]'::jsonb)
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
WHERE n.nspname=ANY({schema_array})""",
        "types": f"""SELECT coalesce(jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname,'kind',t.typtype) ORDER BY n.nspname,t.oid), '[]'::jsonb)
FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
WHERE n.nspname=ANY({schema_array})""",
    }
    return {key: json.loads(psql(database_url, query)) for key, query in queries.items()}


def apply_packet_text(database_url: str, packet: str, *, prefix: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    descriptor, path_string = tempfile.mkstemp(prefix=prefix, suffix=".sql")
    os.close(descriptor)
    path = Path(path_string)
    try:
        path.write_text(packet)
        return apply_file(database_url, path, check=check)
    finally:
        path.unlink(missing_ok=True)


def migration_function_statement(function_name: str) -> str:
    for migration in TARGET_MIGRATIONS:
        text = migration.read_text()
        match = re.search(rf"CREATE FUNCTION {re.escape(function_name)}\(\).*?END \$\$;", text, flags=re.DOTALL)
        if match:
            return match.group(0).replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)
    raise RuntimeError(f"migration function not found: {function_name}")


def migration_trigger_statements(function_name: str) -> str:
    statements: list[str] = []
    for migration in TARGET_MIGRATIONS:
        text = migration.read_text()
        for match in re.finditer(
            r"CREATE\s+TRIGGER\b[^;]*?EXECUTE\s+FUNCTION\s+" + re.escape(function_name) + r"\(\)\s*;",
            text,
            flags=re.DOTALL,
        ):
            statements.append(match.group(0))
    if not statements:
        raise RuntimeError(f"migration triggers not found: {function_name}")
    return "\n".join(statements)


def fixture_sql() -> tuple[str, dict[str, str]]:
    ids = {key: str(uuid.uuid4()) for key in (
        "org", "org_delete", "user", "user_delete", "session", "session_off", "contact", "contact_delete",
        "property", "property_delete", "conversation", "conversation_delete", "message", "message_delete",
        "window_message", "window_conversation",
        "sequence", "sequence_delete", "enrollment", "enrollment_delete", "thread", "thread_delete",
        "consent", "consent_delete", "suppression", "suppression_delete", "review",
        "review_delete", "sender", "sender_delete",
    )}
    sql = f"""BEGIN;
INSERT INTO organizations(id,name) VALUES ('{ids['org']}','Emergency source org'),('{ids['org_delete']}','Org to delete');
INSERT INTO auth.users(id,email) VALUES ('{ids['user']}','{ids['user']}@example.invalid'),('{ids['user_delete']}','{ids['user_delete']}@example.invalid');
INSERT INTO auth.sessions(id,user_id,not_after) VALUES ('{ids['session']}','{ids['user']}',clock_timestamp()+interval '1 hour');
INSERT INTO memberships(org_id,user_id,role,access_status) VALUES ('{ids['org']}','{ids['user']}','owner','active'),('{ids['org']}','{ids['user_delete']}','member','active');
INSERT INTO contacts(id,org_id,first_name) VALUES ('{ids['contact']}','{ids['org']}','Emergency'),('{ids['contact_delete']}','{ids['org_delete']}','Delete');
INSERT INTO properties(id,org_id,address,state,status,homeowner_contact_id) VALUES ('{ids['property']}','{ids['org']}','Emergency address','MO','new_lead','{ids['contact']}'),('{ids['property_delete']}','{ids['org_delete']}','Delete address','MO','new_lead','{ids['contact_delete']}');
INSERT INTO sequences(id,org_id,name) VALUES ('{ids['sequence']}','{ids['org']}','Emergency sequence'),('{ids['sequence_delete']}','{ids['org_delete']}','Delete sequence');
INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES ('{ids['message']}','{ids['org']}','{ids['conversation']}','{ids['contact']}','{ids['property']}','sms','inbound','received','Emergency message','+18165550101','+18162804181'),('{ids['message_delete']}','{ids['org_delete']}',NULL,'{ids['contact_delete']}','{ids['property_delete']}','sms','outbound','queued','Delete message','+18165550102','+18162804182');
INSERT INTO sequence_enrollments(id,org_id,sequence_id,property_id,status,next_run_at) VALUES ('{ids['enrollment']}','{ids['org']}','{ids['sequence']}','{ids['property']}','active',clock_timestamp()),('{ids['enrollment_delete']}','{ids['org_delete']}','{ids['sequence_delete']}','{ids['property_delete']}','active',clock_timestamp());
INSERT INTO consent_events(id,org_id,contact_id,channel,event_type,source) VALUES ('{ids['consent']}','{ids['org']}','{ids['contact']}','sms','opt_out','emergency'),('{ids['consent_delete']}','{ids['org_delete']}','{ids['contact_delete']}','sms','opt_out','emergency');
INSERT INTO sms_phone_suppressions(id,org_id,phone_e164,source) VALUES ('{ids['suppression']}','{ids['org']}','+18165550103','emergency'),('{ids['suppression_delete']}','{ids['org_delete']}','+18165550104','emergency');
INSERT INTO ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason) VALUES ('{ids['review']}','{ids['org']}','{ids['property']}','{ids['conversation']}','{ids['message']}','not_interested','emergency'),('{ids['review_delete']}','{ids['org_delete']}','{ids['property_delete']}','{ids['conversation_delete']}','{ids['message_delete']}','not_interested','emergency');
INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES ('{ids['sender']}','{ids['org']}','sendillo','+18165550105','active'),('{ids['sender_delete']}','{ids['org_delete']}','sendillo','+18165550106','active');
COMMIT;"""
    return sql, ids


def main() -> None:
    global LOCAL_TEST_CONTAINER
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url")
    args = parser.parse_args()
    project: Path | None = None
    database_url = args.database_url
    try:
        if database_url is None:
            project, database_url = provision_stack()
            project_config = (project / "supabase/config.toml").read_text()
            project_match = re.search(r'^project_id\s*=\s*"([a-z0-9-]+)"$', project_config, flags=re.MULTILINE)
            if not project_match:
                raise RuntimeError("disposable project id was not found")
            LOCAL_TEST_CONTAINER = f"supabase_db_{project_match.group(1)}"
        assert database_url is not None
        if "127.0.0.1:54329" in database_url:
            raise RuntimeError("shared 54329 is forbidden")
        postgres_version = psql(database_url, "SHOW server_version")
        if not postgres_version.startswith("17."):
            raise RuntimeError(f"disposable proof requires PostgreSQL 17, got {postgres_version}")

        run(["git", "merge-base", "--is-ancestor", "538d81ed", "HEAD"], cwd=ROOT)
        inventory_json = json.dumps([{"identity": t["identity"], "function": t["function"], "tgtype": t["tgtype"]} for t in INVENTORY["triggers"]])
        inventory_json_sql = "'" + inventory_json.replace("'", "''") + "'"
        trigger_catalog = json.loads(psql(database_url, "SELECT coalesce(jsonb_agg(jsonb_build_object('identity',n.nspname||'.'||c.relname||'.'||t.tgname,'function',pn.nspname||'.'||p.proname,'tgtype',t.tgtype) ORDER BY 1),'[]') FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid JOIN pg_namespace pn ON pn.oid=p.pronamespace WHERE NOT t.tgisinternal AND n.nspname||'.'||c.relname||'.'||t.tgname IN (SELECT value->>'identity' FROM jsonb_array_elements(%s::jsonb))" % inventory_json_sql))
        expected_catalog = [{"identity": t["identity"], "function": t["function"], "tgtype": t["tgtype"]} for t in INVENTORY["triggers"]]
        if sorted(trigger_catalog, key=lambda row: row["identity"]) != sorted(expected_catalog, key=lambda row: row["identity"]):
            raise RuntimeError(f"disposable catalog trigger inventory mismatch: {trigger_catalog}")
        expected_md5 = {f["name"]: f["approved_md5_prosrc"] for f in INVENTORY["functions"]}
        guard_md5_query = "SELECT md5(p.prosrc) FROM pg_proc p WHERE p.oid=to_regprocedure('public.inbox_guard_inbound_revision()')"
        guard_enabled_query = """SELECT coalesce(string_agg(t.tgenabled, ',' ORDER BY t.tgname),'')
FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
WHERE n.nspname='public' AND c.relname='messages' AND t.tgname LIKE 'zzz_inbox_guard_inbound_revision%'"""
        guard_md5_before = psql(database_url, guard_md5_query)
        guard_enabled_before = psql(database_url, guard_enabled_query)
        baseline_catalog = catalog_fingerprint(database_url)
        baseline_function_bodies = function_body_digests(database_url)
        mutants: dict[str, str] = {}

        # (b) With no GUCs at all, both generated packets must refuse before
        # any receipt DDL or function replacement.
        for packet_path in (OFF, RESTORE):
            direct_result = apply_file(database_url, packet_path, check=False)
            direct_output = direct_result.stdout + direct_result.stderr
            if direct_result.returncode == 0 or "INBOX_EMERGENCY_TARGET_REF_REQUIRED" not in direct_output:
                raise RuntimeError(f"direct psql did not refuse {packet_path.name}:\n{direct_output}")
            if catalog_fingerprint(database_url) != baseline_catalog or function_body_digests(database_url) != baseline_function_bodies:
                raise RuntimeError(f"direct psql changed the database for {packet_path.name}")
            if psql(database_url, "SELECT to_regclass('inbox_emergency.capture_off_receipts')") != "":
                raise RuntimeError(f"direct psql created a receipt for {packet_path.name}")

        # (a) A local-test target without the second GUC must refuse before
        # touching either the catalog or any capture function body.
        single_guc_result = apply_packet_text_with_local_identity(
            database_url,
            OFF.read_text(),
            prefix="capture-local-test-missing-flag-",
            local_test=None,
            check=False,
        )
        single_guc_output = single_guc_result.stdout + single_guc_result.stderr
        if single_guc_result.returncode == 0 or "INBOX_EMERGENCY_LOCAL_TEST_IDENTITY_REFUSED" not in single_guc_output:
            raise RuntimeError(f"local-test target without second GUC did not refuse:\n{single_guc_output}")
        if catalog_fingerprint(database_url) != baseline_catalog or function_body_digests(database_url) != baseline_function_bodies:
            raise RuntimeError("local-test target without second GUC changed the database")

        # Production identity also requires an explicit non-local-test flag;
        # an unset flag must not be treated as safe by NULL propagation.
        production_unset_result = apply_packet_text_with_local_identity(
            database_url,
            OFF.read_text(),
            prefix="capture-production-missing-flag-",
            target_ref=PRODUCTION_TARGET_REF,
            local_test=None,
            check=False,
        )
        production_unset_output = production_unset_result.stdout + production_unset_result.stderr
        if production_unset_result.returncode == 0 or "INBOX_EMERGENCY_PRODUCTION_LOCAL_TEST_REFUSED" not in production_unset_output:
            raise RuntimeError(f"production target without second GUC did not refuse:\n{production_unset_output}")
        if catalog_fingerprint(database_url) != baseline_catalog or function_body_digests(database_url) != baseline_function_bodies:
            raise RuntimeError("production target without second GUC changed the database")

        # Mutant: remove only the second-GUC clause. The preceding single-GUC
        # case must then go red by changing the function bodies.
        second_guc_clause = "IF coalesce(current_setting('inbox.emergency_local_test', true), '') <> 'on'"
        second_guc_mutant = OFF.read_text().replace(second_guc_clause, "IF false", 1)
        if second_guc_mutant == OFF.read_text():
            raise RuntimeError("could not construct local-test second-GUC mutant")
        second_guc_mutant_result = apply_packet_text_with_local_identity(
            database_url,
            second_guc_mutant,
            prefix="capture-local-test-second-guc-mutant-",
            local_test=None,
            check=False,
        )
        if second_guc_mutant_result.returncode != 0 or function_body_digests(database_url) == baseline_function_bodies:
            raise RuntimeError("removing the local-test second-GUC clause did not make case (a) go red")
        mutants["local-test-second-guc"] = "KILLED (single-GUC case mutated without the clause)"
        runner_apply(database_url, "capture-restore")
        psql(database_url, "DROP SCHEMA inbox_emergency CASCADE")

        # Removing only the generated identity guard must make the direct-psql
        # test go red.  Restore and drop its out-of-band receipt afterward.
        identity_start = "  -- EMERGENCY_TARGET_IDENTITY_GUARD_BEGIN\n"
        identity_end = "  -- EMERGENCY_TARGET_IDENTITY_GUARD_END\n"
        identity_mutant = re.sub(
            re.escape(identity_start) + r".*?" + re.escape(identity_end),
            "",
            OFF.read_text(),
            count=1,
            flags=re.DOTALL,
        )
        if identity_mutant == OFF.read_text():
            raise RuntimeError("could not construct target-GUC mutant")
        identity_mutant_result = apply_packet_text(database_url, identity_mutant, prefix="capture-target-guc-mutant-", check=False)
        if identity_mutant_result.returncode != 0 or function_body_digests(database_url) == baseline_function_bodies:
            raise RuntimeError("removing the target-GUC guard did not make direct psql mutate")
        mutants["transaction-local-target-guc"] = "KILLED (direct psql mutant mutated without the guard)"
        runner_apply(database_url, "capture-restore")
        psql(database_url, "DROP SCHEMA inbox_emergency CASCADE")

        # The runner's operator checks must fail before psql is reached.
        runner_url, _ = passwordless_url(database_url)
        runner_cases = [
            ("wrong-ref", {"--target-ref": "ncsngxlcyxylaeskiteu"}),
            ("wrong-host", {"--database-url": runner_url.replace("127.0.0.1", "192.0.2.1")}),
            ("wrong-user", {"--database-url": runner_url.replace("postgres@", "postgres.wrongref@")}),
        ]
        for label, overrides in runner_cases:
            command = [
                "python3",
                str(RUNNER),
                "--packet",
                "capture-off",
                "--database-url",
                runner_url,
                "--target-ref",
                PRODUCTION_TARGET_REF,
                "--i-understand-production",
                "--local-test",
            ]
            for option, value in overrides.items():
                command[command.index(option) + 1] = value
            result = run(
                command,
                cwd=ROOT,
                env={**os.environ, "NODE_ENV": "test", "INBOX_EMERGENCY_DB_PASSWORD": "postgres"},
                check=False,
            )
            output = result.stdout + result.stderr
            if result.returncode == 0 or "emergency capture packet blocked:" not in output or "connection to server" in output:
                raise RuntimeError(f"runner {label} did not refuse before connect:\n{output}")
            mutants[f"runner-{label}"] = "KILLED (preflight refused before psql)"

        production_url = f"postgresql://postgres@db.{PRODUCTION_TARGET_REF}.supabase.co:5432/postgres"
        production_preflight_cases = [
            ("wrong-host", runner_url),
            ("password-in-url", production_url.replace("postgres@", "postgres:postgres@")),
            ("query-option", f"{production_url}?sslmode=verify-full"),
        ]
        for label, value in production_preflight_cases:
            result = run(
                [
                    "python3",
                    str(RUNNER),
                    "--packet",
                    "capture-off",
                    "--database-url",
                    value,
                    "--target-ref",
                    PRODUCTION_TARGET_REF,
                    "--i-understand-production",
                ],
                cwd=ROOT,
                env={**os.environ, "INBOX_EMERGENCY_DB_PASSWORD": "postgres"},
                check=False,
            )
            output = result.stdout + result.stderr
            if result.returncode == 0 or "emergency capture packet blocked:" not in output or "connection to server" in output:
                raise RuntimeError(f"production runner {label} did not refuse before connect:\n{output}")
            mutants[f"runner-production-{label}"] = "KILLED (preflight refused before psql)"

        missing_test_env = {key: value for key, value in os.environ.items() if key not in {"NODE_ENV", "CI"}}
        missing_test_env["INBOX_EMERGENCY_DB_PASSWORD"] = "postgres"
        missing_test_env_result = run(
            [
                "python3",
                str(RUNNER),
                "--packet",
                "capture-off",
                "--database-url",
                runner_url,
                "--target-ref",
                PRODUCTION_TARGET_REF,
                "--i-understand-production",
                "--local-test",
            ],
            cwd=ROOT,
            env=missing_test_env,
            check=False,
        )
        missing_test_env_output = missing_test_env_result.stdout + missing_test_env_result.stderr
        if missing_test_env_result.returncode == 0 or "local-test requires NODE_ENV=test or a CI-style test flag" not in missing_test_env_output:
            raise RuntimeError(f"runner missing test/env flag did not refuse before connect:\n{missing_test_env_output}")
        mutants["runner-missing-test-env"] = "KILLED (preflight refused before psql)"

        non_loopback_packet = OFF.read_text().replace(
            "inet_server_addr() NOT IN ('127.0.0.1'::inet, '::1'::inet)",
            "'203.0.113.10'::inet NOT IN ('127.0.0.1'::inet, '::1'::inet)",
            1,
        )
        non_loopback_result = apply_packet_text_with_local_identity(
            database_url,
            non_loopback_packet,
            prefix="capture-local-non-loopback-mutant-",
            check=False,
        )
        non_loopback_output = non_loopback_result.stdout + non_loopback_result.stderr
        if non_loopback_result.returncode == 0 or "INBOX_EMERGENCY_LOCAL_TEST_IDENTITY_REFUSED" not in non_loopback_output:
            raise RuntimeError(f"local-test packet did not refuse the simulated non-loopback server:\n{non_loopback_output}")
        if catalog_fingerprint(database_url) != baseline_catalog or function_body_digests(database_url) != baseline_function_bodies:
            raise RuntimeError("simulated non-loopback local-test packet changed the database")
        mutants["local-test-server-address"] = "KILLED (non-loopback inet_server_addr refused)"

        catalog_mutant_packet = OFF.read_text().replace("inbox_emergency", "inbox_control")
        apply_packet_text_with_local_identity(database_url, catalog_mutant_packet, prefix="capture-catalog-mutant-")
        runner_apply(database_url, "capture-restore")
        if catalog_fingerprint(database_url) == baseline_catalog:
            raise RuntimeError("CATALOG_SCHEMAS fingerprint did not kill the in-catalog receipt mutant")
        mutants["receipt-schema-catalog-boundary"] = "KILLED (inbox_control relation detected)"
        psql(database_url, "DROP TABLE inbox_control.capture_off_receipts")
        if catalog_fingerprint(database_url) != baseline_catalog:
            raise RuntimeError("catalog mutant cleanup changed the PR #725 fingerprint")

        source_fixture, ids = fixture_sql()
        psql(database_url, source_fixture)
        baseline_counts = inbox_counts(database_url)
        if baseline_counts["inbox_message_capture.dirty"] == 0 or baseline_counts["inbox_bridge.access_epochs"] == 0:
            raise RuntimeError("positive capture control did not produce Inbox rows before capture-off")

        runner_apply(database_url, "capture-off")
        receipt_actions = psql(database_url, "SELECT coalesce(string_agg(action||':'||count::text, ',' ORDER BY action),'') FROM (SELECT action,count(*) FROM inbox_emergency.capture_off_receipts GROUP BY action) AS counts(action,count)")
        if receipt_actions != "capture_off:1":
            raise RuntimeError(f"capture-off receipt classification mismatch: {receipt_actions}")
        if psql(database_url, "SELECT relrowsecurity FROM pg_class WHERE oid='inbox_emergency.capture_off_receipts'::regclass") != "t":
            raise RuntimeError("capture-off receipt table did not enable row-level security")
        if psql(database_url, guard_md5_query) != guard_md5_before or psql(database_url, guard_enabled_query) != guard_enabled_before:
            raise RuntimeError("capture-off altered the live inbound-revision integrity guard")
        off_digests = inbox_content_digests(database_url)
        mutation_sql = f"""BEGIN;
UPDATE ai_disposition_reviews SET ai_reason='updated' WHERE id='{ids['review_delete']}';
DELETE FROM ai_disposition_reviews WHERE id='{ids['review_delete']}';
UPDATE sequence_enrollments SET status='paused' WHERE id='{ids['enrollment_delete']}';
DELETE FROM sequence_enrollments WHERE id='{ids['enrollment_delete']}';
UPDATE message_threads SET ai_responder_status='escalated' WHERE org_id='{ids['org_delete']}' AND property_id='{ids['property_delete']}';
DELETE FROM message_threads WHERE org_id='{ids['org_delete']}' AND property_id='{ids['property_delete']}';
UPDATE messages SET body=body||' updated' WHERE id='{ids['message_delete']}';
DELETE FROM messages WHERE id='{ids['message_delete']}';
INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body) VALUES ('{ids['window_message']}','{ids['org']}','{ids['window_conversation']}','sms','inbound','received','window inbound');
UPDATE properties SET address=address||' updated' WHERE id='{ids['property_delete']}';
DELETE FROM properties WHERE id='{ids['property_delete']}';
UPDATE contacts SET first_name='updated' WHERE id='{ids['contact_delete']}';
DELETE FROM contacts WHERE id='{ids['contact_delete']}';
INSERT INTO auth.sessions(id,user_id,not_after) VALUES ('{ids['session_off']}','{ids['user']}',clock_timestamp()+interval '1 hour');
UPDATE auth.sessions SET not_after=clock_timestamp()+interval '2 hours' WHERE id='{ids['session_off']}';
DELETE FROM auth.sessions WHERE id='{ids['session_off']}';
UPDATE memberships SET access_status='suspended' WHERE org_id='{ids['org']}' AND user_id='{ids['user_delete']}';
DELETE FROM memberships WHERE org_id='{ids['org']}' AND user_id='{ids['user_delete']}';
UPDATE consent_events SET source='updated' WHERE id='{ids['consent_delete']}';
DELETE FROM consent_events WHERE id='{ids['consent_delete']}';
UPDATE sms_phone_suppressions SET source='updated' WHERE id='{ids['suppression_delete']}';
DELETE FROM sms_phone_suppressions WHERE id='{ids['suppression_delete']}';
UPDATE organizations SET name='updated' WHERE id='{ids['org_delete']}';
DELETE FROM organizations WHERE id='{ids['org_delete']}';
UPDATE provider_sender_numbers SET status='paused' WHERE id='{ids['sender_delete']}';
DELETE FROM provider_sender_numbers WHERE id='{ids['sender_delete']}';
UPDATE auth.sessions SET not_after=clock_timestamp()+interval '2 hours' WHERE id='{ids['session']}';
DELETE FROM auth.sessions WHERE id='{ids['session']}';
COMMIT;"""
        psql(database_url, mutation_sql)
        if inbox_content_digests(database_url) != off_digests:
            raise RuntimeError("capture-off source writes changed Inbox capture-target content")
        if psql(database_url, f"SELECT count(*) FROM messages WHERE id='{ids['message_delete']}'") != "0":
            raise RuntimeError("capture-off message delete did not persist")
        if psql(database_url, f"SELECT inbox_inbound_revision FROM messages WHERE id='{ids['window_message']}'") != "0":
            raise RuntimeError("window inbound message did not retain permanent revision zero")

        invalid_guard_org = str(uuid.uuid4())
        invalid_guard_message = str(uuid.uuid4())
        guard_result = psql_result(database_url, f"INSERT INTO organizations(id,name) VALUES ('{invalid_guard_org}','guard probe'); INSERT INTO messages(id,org_id,channel,direction,status,body,inbox_inbound_revision) VALUES ('{invalid_guard_message}','{invalid_guard_org}','sms','inbound','received','guard probe',7)")
        if guard_result.returncode == 0 or "INBOX_REVISION_SERVER_OWNED" not in (guard_result.stdout + guard_result.stderr):
            raise RuntimeError("live inbound-revision guard did not reject a fabricated revision")
        guard_original_statement = migration_function_statement("public.inbox_guard_inbound_revision")
        guard_noop_statement = """CREATE OR REPLACE FUNCTION public.inbox_guard_inbound_revision()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
  RETURN NEW;
END $$;"""
        psql(database_url, guard_noop_statement)
        mutant_guard_org = str(uuid.uuid4())
        mutant_guard_message = str(uuid.uuid4())
        guard_mutant_result = psql_result(database_url, f"INSERT INTO organizations(id,name) VALUES ('{mutant_guard_org}','guard mutant'); INSERT INTO messages(id,org_id,channel,direction,status,body,inbox_inbound_revision) VALUES ('{mutant_guard_message}','{mutant_guard_org}','sms','inbound','received','guard mutant',7)")
        if guard_mutant_result.returncode != 0:
            raise RuntimeError("guard-neutralization mutant did not bypass the guard")
        mutants["integrity-guard-exclusion"] = "KILLED (fabricated revision accepted only by live-guard mutant)"
        psql(database_url, guard_original_statement)

        runner_apply(database_url, "capture-restore")
        if psql(database_url, "SELECT count(*) FROM inbox_emergency.capture_off_receipts WHERE action='capture_restore'") != "1":
            raise RuntimeError("capture-restore did not write exactly one restore receipt")
        names_sql = ",".join("'" + f["name"] + "'" for f in INVENTORY["functions"])
        restored_body_md5 = json.loads(psql(database_url, f"SELECT jsonb_object_agg(n.nspname||'.'||p.proname,md5(p.prosrc)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname||'.'||p.proname) = ANY(ARRAY[{names_sql}])"))
        if restored_body_md5 != expected_md5:
            raise RuntimeError(f"restore body MD5 mismatch: {restored_body_md5}")
        if catalog_fingerprint(database_url) != baseline_catalog:
            raise RuntimeError("capture-off plus restore changed a PR #725 CATALOG_SCHEMAS relation/function/type")
        if psql(database_url, guard_md5_query) != guard_md5_before or psql(database_url, guard_enabled_query) != guard_enabled_before:
            raise RuntimeError("restore altered the live inbound-revision integrity guard")
        resume_org = str(uuid.uuid4())
        resume_message = str(uuid.uuid4())
        resume_conversation = str(uuid.uuid4())
        psql(database_url, f"INSERT INTO organizations(id,name) VALUES ('{resume_org}','resume'); INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body) VALUES ('{resume_message}','{resume_org}','{resume_conversation}','sms','inbound','received','resume')")
        if int(psql(database_url, f"SELECT count(*) FROM inbox_message_capture.dirty WHERE org_id='{resume_org}'")) == 0:
            raise RuntimeError("capture did not resume after restore")

        # A count would miss a live capture_access update to an existing row.
        runner_apply(database_url, "capture-off")
        access_off_statement = body_statement(OFF.read_text(), "inbox_bridge.capture_access")
        access_restore_statement = body_statement(RESTORE.read_text(), "inbox_bridge.capture_access")
        psql(database_url, access_restore_statement)
        access_before = inbox_content_digests(database_url)
        psql(database_url, f"UPDATE memberships SET hugo_config='{{\"digest_mutant\":true}}'::jsonb WHERE org_id='{ids['org']}' AND user_id='{ids['user']}'")
        if inbox_content_digests(database_url) == access_before:
            raise RuntimeError("per-table content digest did not kill the live capture_access mutant")
        mutants["live-capture_access-digest"] = "KILLED (existing access_epochs content changed)"
        psql(database_url, access_off_statement)
        runner_apply(database_url, "capture-restore")

        idempotent_before = int(psql(database_url, "SELECT count(*) FROM inbox_emergency.capture_off_receipts WHERE action='capture_off_idempotent'"))
        runner_apply(database_url, "capture-off")
        runner_apply(database_url, "capture-off")
        idempotent_after = int(psql(database_url, "SELECT count(*) FROM inbox_emergency.capture_off_receipts WHERE action='capture_off_idempotent'"))
        capture_off_count = int(psql(database_url, "SELECT count(*) FROM inbox_emergency.capture_off_receipts WHERE action='capture_off'"))
        if capture_off_count != 3 or idempotent_after != idempotent_before + 1:
            raise RuntimeError(f"capture-off re-run receipt mismatch: capture_off={capture_off_count}, idempotent_before={idempotent_before}, idempotent_after={idempotent_after}")
        idempotent_action_mutant = OFF.read_text().replace("THEN 'capture_off_idempotent' ELSE 'capture_off'", "THEN 'capture_off' ELSE 'capture_off'", 1)
        apply_packet_text_with_local_identity(database_url, idempotent_action_mutant, prefix="capture-off-idempotent-action-mutant-")
        if psql(database_url, "SELECT count(*) FROM inbox_emergency.capture_off_receipts WHERE action='capture_off'") != "4":
            raise RuntimeError("idempotent action mutant was not detected")
        mutants["idempotent-receipt-action"] = "KILLED (re-run action mutant recorded capture_off)"

        runner_apply(database_url, "capture-restore")
        psql(database_url, "ALTER TABLE public.messages DISABLE TRIGGER zzzzz_inbox_message_direct")
        disabled_restore_result = runner_apply(database_url, "capture-restore", check=False)
        if disabled_restore_result.returncode == 0 or "INBOX_CAPTURE_OFF_TRIGGER_CATALOG_DRIFT" not in (disabled_restore_result.stdout + disabled_restore_result.stderr):
            raise RuntimeError("capture-restore did not refuse a DISABLE TRIGGER drift")
        disabled_check_mutant = RESTORE.read_text().replace(" AND t.tgenabled='O'", "", 1)
        disabled_check_result = apply_packet_text_with_local_identity(database_url, disabled_check_mutant, prefix="capture-restore-disabled-check-mutant-", check=False)
        if disabled_check_result.returncode != 0:
            raise RuntimeError("tgenabled mutant did not bypass the disabled-trigger refusal")
        mutants["restore-tgenabled-check"] = "KILLED (disabled trigger would restore only with check removed)"
        psql(database_url, "ALTER TABLE public.messages ENABLE TRIGGER zzzzz_inbox_message_direct")
        runner_apply(database_url, "capture-restore")

        off_statement = body_statement(OFF.read_text(), "inbox_message_capture.capture")
        drift_statement = off_statement.replace("RETURN NULL;", "RETURN NEW;", 1)
        if drift_statement == off_statement:
            raise RuntimeError("could not construct capture-off body drift mutant")
        psql(database_url, drift_statement)
        drift_result = runner_apply(database_url, "capture-off", check=False)
        if drift_result.returncode == 0 or "INBOX_CAPTURE_OFF_FUNCTION_BODY_DRIFT" not in (drift_result.stdout + drift_result.stderr):
            raise RuntimeError(f"capture-off did not refuse a function-body drift mutant (rc={drift_result.returncode}):\n{drift_result.stdout}\n{drift_result.stderr}")

        restore_statement = body_statement(RESTORE.read_text(), "inbox_message_capture.capture")
        psql(database_url, restore_statement)
        runner_apply(database_url, "capture-off")
        restore_mutant = restore_statement.replace("RETURN NULL;", "RETURN NEW;", 1)
        if restore_mutant == restore_statement:
            raise RuntimeError("could not construct restore body mutant")
        restore_mutant_packet = RESTORE.read_text().replace(restore_statement, restore_mutant, 1)
        restore_mutant_result = apply_packet_text_with_local_identity(database_url, restore_mutant_packet, prefix="capture-restore-mutant-", check=False)
        if restore_mutant_result.returncode == 0 or "INBOX_CAPTURE_RESTORE_POSTCONDITION_FAILED" not in (restore_mutant_result.stdout + restore_mutant_result.stderr):
            raise RuntimeError("capture-restore did not kill the body-mutant postcondition")
        runner_apply(database_url, "capture-restore")

        missing_function_name = "inbox_operation_domain.capture_target"
        missing_function = f"{missing_function_name}()"
        psql(database_url, f"DROP FUNCTION {missing_function} CASCADE")
        regprocedure_mutant_packet = OFF.read_text().replace("to_regprocedure(e.name)", "e.name::regprocedure")
        regprocedure_mutant_result = apply_packet_text_with_local_identity(database_url, regprocedure_mutant_packet, prefix="capture-missing-regprocedure-mutant-", check=False)
        regprocedure_mutant_output = regprocedure_mutant_result.stdout + regprocedure_mutant_result.stderr
        if regprocedure_mutant_result.returncode == 0 or "INBOX_CAPTURE_OFF_FUNCTION_MISSING" in regprocedure_mutant_output:
            raise RuntimeError("regprocedure mutant was not killed before the named missing-function refusal")
        mutants["missing-function-to_regprocedure"] = "KILLED (cast mutant raises instead of reaching named refusal)"
        missing_result = runner_apply(database_url, "capture-off", check=False)
        missing_output = missing_result.stdout + missing_result.stderr
        if missing_result.returncode == 0 or "INBOX_CAPTURE_OFF_FUNCTION_MISSING" not in missing_output:
            raise RuntimeError("capture-off did not refuse a dropped function with INBOX_CAPTURE_OFF_FUNCTION_MISSING")

        # The dropped function cascades to its two source triggers. Recreate
        # both from the approved migration before reporting PASS so even a
        # database-url caller is not left with a broken disposable database.
        psql(
            database_url,
            migration_function_statement(missing_function_name) + "\n" + migration_trigger_statements(missing_function_name),
        )
        if psql(database_url, f"SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgfoid=to_regprocedure('{missing_function}')") != "2":
            raise RuntimeError("harness did not recreate capture_target() and its two triggers before PASS")

        print(json.dumps({
            "status": "PASS",
            "database": passwordless_url(database_url)[0],
            "postgres": postgres_version,
            "main_ancestor": "538d81ed",
            "triggers_verified": len(expected_catalog),
            "functions_verified": len(expected_md5),
            "catalog_schemas_source": str(RECONCILE_CATALOG_SOURCE),
            "checks": [
                "no-GUC direct psql refused for both packets; local-test target without its second GUC refused without catalog/function change",
                "production target without an explicit off flag refused; replacing the local-test second-GUC clause with IF false made the single-GUC case mutate",
                "direct-psql identity-guard removal mutated and was killed",
                "runner rejected wrong ref, host, and user before opening psql; local-test runner execution succeeded on loopback",
                "production runner rejected wrong host, password-in-URL, query-option, and missing test/env flag before opening psql",
                "local-test refused the simulated non-loopback inet_server_addr and the receipt table enabled row-level security",
                "all 25 canonical source capture triggers matched disposable catalog; the two revision guards stayed live",
                "capture-off and capture-restore wrote receipts in inbox_emergency",
                "all affected source-table writes including auth.sessions insert/update/delete persisted with unchanged per-table Inbox content digests",
                "window inbound messages retained inbox_inbound_revision zero unless later re-routed, and fabricated revisions were refused",
                "capture-off plus restore changed no relation/function/type in the PR #725 CATALOG_SCHEMAS list",
                "restore MD5 matched migration-extracted bodies and capture resumed",
                "capture-off reapplication emitted capture_off_idempotent",
                "restore refused a DISABLE TRIGGER tgenabled drift",
                "dropped function reached INBOX_CAPTURE_OFF_FUNCTION_MISSING via to_regprocedure",
                "mixed function-body drift was refused",
                "capture_target() and both source triggers were recreated before PASS",
            ],
            "mutants": {**mutants, "function-body-drift": "KILLED (precondition refuses)", "restore-body": "KILLED (postcondition refuses)"},
        }, indent=2))
    finally:
        if project is not None:
            run(["supabase", "stop", "--workdir", str(project), "--no-backup", "--yes"], check=False)
            shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
    main()
