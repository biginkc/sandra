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
import re
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
OFF = HERE / "capture-off.sql"
RESTORE = HERE / "capture-restore.sql"
INVENTORY = json.loads((HERE / "capture-trigger-inventory.json").read_text())
TARGET_MIGRATIONS = [
    ROOT / "supabase/migrations/20261002130000_inbox_control_foundation.sql",
    ROOT / "supabase/migrations/20261002130100_inbox_read_companion.sql",
    ROOT / "supabase/migrations/20261002130200_inbox_backend_operation_reply.sql",
]
TARGET_NAMES = {p.name for p in TARGET_MIGRATIONS}


def run(argv: list[str], *, cwd: Path | None = None, input_text: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(argv, cwd=cwd, input=input_text, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(f"command failed ({' '.join(argv)}):\n{result.stdout}\n{result.stderr}")
    return result


def psql(database_url: str, sql: str, *, check: bool = True) -> str:
    result = run(["psql", database_url, "-X", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-At", "-c", sql], check=check)
    return result.stdout.strip()


def apply_file(database_url: str, path: Path, *, check: bool = True) -> subprocess.CompletedProcess[str]:
    return run(["psql", database_url, "-X", "-v", "ON_ERROR_STOP=1", "-f", str(path)], check=check)


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
    tables = [
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
    ]
    result: dict[str, int] = {}
    for table in tables:
        result[table] = int(psql(database_url, f"SELECT count(*) FROM {table}"))
    return result


def fixture_sql() -> tuple[str, dict[str, str]]:
    ids = {key: str(uuid.uuid4()) for key in (
        "org", "org_delete", "user", "user_delete", "session", "session_off", "contact", "contact_delete",
        "property", "property_delete", "conversation", "conversation_delete", "message", "message_delete",
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


def mutate_before_return_null(database_url: str) -> bool:
    statement = body_statement(OFF.read_text(), "public.inbox_guard_inbound_revision")
    mutant = statement.replace("RETURN NEW;", "RETURN NULL;", 1)
    psql(database_url, mutant)
    message_id = str(uuid.uuid4())
    org_id = str(uuid.uuid4())
    psql(database_url, f"INSERT INTO organizations(id,name) VALUES ('{org_id}','before mutant'); INSERT INTO messages(id,org_id,channel,direction,status,body,inbox_inbound_revision) VALUES ('{message_id}','{org_id}','sms','inbound','received','mutant',0)")
    return psql(database_url, f"SELECT count(*) FROM messages WHERE id='{message_id}'") == "0"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database-url")
    args = parser.parse_args()
    project: Path | None = None
    database_url = args.database_url
    try:
        if database_url is None:
            project, database_url = provision_stack()
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

        source_fixture, ids = fixture_sql()
        psql(database_url, source_fixture)
        baseline_counts = inbox_counts(database_url)
        if baseline_counts["inbox_message_capture.dirty"] == 0 or baseline_counts["inbox_bridge.access_epochs"] == 0:
            raise RuntimeError("positive capture control did not produce Inbox rows before capture-off")

        apply_file(database_url, OFF)
        if psql(database_url, "SELECT count(*) FROM inbox_control.capture_off_receipts WHERE action='capture_off'") != "1":
            raise RuntimeError("capture-off did not write exactly one capture-off receipt")
        off_counts = inbox_counts(database_url)
        mutation_sql = f"""BEGIN;
UPDATE ai_disposition_reviews SET ai_reason='updated' WHERE id='{ids['review_delete']}';
DELETE FROM ai_disposition_reviews WHERE id='{ids['review_delete']}';
UPDATE sequence_enrollments SET status='paused' WHERE id='{ids['enrollment_delete']}';
DELETE FROM sequence_enrollments WHERE id='{ids['enrollment_delete']}';
UPDATE message_threads SET ai_responder_status='escalated' WHERE org_id='{ids['org_delete']}' AND property_id='{ids['property_delete']}';
DELETE FROM message_threads WHERE org_id='{ids['org_delete']}' AND property_id='{ids['property_delete']}';
UPDATE messages SET body=body||' updated' WHERE id='{ids['message_delete']}';
DELETE FROM messages WHERE id='{ids['message_delete']}';
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
        if inbox_counts(database_url) != off_counts:
            raise RuntimeError("capture-off source writes changed Inbox capture rows")
        if psql(database_url, f"SELECT count(*) FROM messages WHERE id='{ids['message_delete']}'") != "0":
            raise RuntimeError("capture-off message delete did not persist")

        guard_probe = str(uuid.uuid4())
        guard_message = str(uuid.uuid4())
        psql(database_url, f"INSERT INTO organizations(id,name) VALUES ('{guard_probe}','guard probe'); INSERT INTO messages(id,org_id,channel,direction,status,body,inbox_inbound_revision) VALUES ('{guard_message}','{guard_probe}','sms','inbound','received','guard probe',0)")
        if psql(database_url, f"SELECT count(*) FROM messages WHERE org_id='{guard_probe}'") != "1":
            raise RuntimeError("BEFORE-row no-op did not return NEW")

        apply_file(database_url, RESTORE)
        if psql(database_url, "SELECT count(*) FROM inbox_control.capture_off_receipts WHERE action='capture_restore'") != "1":
            raise RuntimeError("capture-restore did not write exactly one restore receipt")
        names_sql = ",".join("'" + f["name"] + "'" for f in INVENTORY["functions"])
        restored_body_md5 = json.loads(psql(database_url, f"SELECT jsonb_object_agg(n.nspname||'.'||p.proname,md5(p.prosrc)) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE (n.nspname||'.'||p.proname) = ANY(ARRAY[{names_sql}])"))
        expected_md5 = {f["name"]: f["approved_md5_prosrc"] for f in INVENTORY["functions"]}
        if restored_body_md5 != expected_md5:
            raise RuntimeError(f"restore body MD5 mismatch: {restored_body_md5}")
        resume_org = str(uuid.uuid4())
        resume_message = str(uuid.uuid4())
        resume_conversation = str(uuid.uuid4())
        psql(database_url, f"INSERT INTO organizations(id,name) VALUES ('{resume_org}','resume'); INSERT INTO messages(id,org_id,conversation_id,channel,direction,status,body) VALUES ('{resume_message}','{resume_org}','{resume_conversation}','sms','inbound','received','resume')")
        if int(psql(database_url, f"SELECT count(*) FROM inbox_message_capture.dirty WHERE org_id='{resume_org}'")) == 0:
            raise RuntimeError("capture did not resume after restore")

        apply_file(database_url, OFF)
        apply_file(database_url, OFF)
        off_statement = body_statement(OFF.read_text(), "inbox_message_capture.capture")
        drift_statement = off_statement.replace("RETURN NULL;", "RETURN NEW;", 1)
        if drift_statement == off_statement:
            raise RuntimeError("could not construct capture-off body drift mutant")
        psql(database_url, drift_statement)
        drift_result = apply_file(database_url, OFF, check=False)
        if drift_result.returncode == 0 or "INBOX_CAPTURE_OFF_FUNCTION_BODY_DRIFT" not in (drift_result.stdout + drift_result.stderr):
            raise RuntimeError(f"capture-off did not refuse a function-body drift mutant (rc={drift_result.returncode}):\n{drift_result.stdout}\n{drift_result.stderr}")

        restore_statement = body_statement(RESTORE.read_text(), "inbox_message_capture.capture")
        psql(database_url, off_statement.replace("RETURN NEW;", "RETURN NULL;", 1))
        apply_file(database_url, OFF)
        restore_mutant = restore_statement.replace("RETURN NULL;", "RETURN NEW;", 1)
        if restore_mutant == restore_statement:
            raise RuntimeError("could not construct restore body mutant")
        restore_mutant_packet = RESTORE.read_text().replace(restore_statement, restore_mutant, 1)
        restore_mutant_path = Path(tempfile.mkstemp(prefix="capture-restore-mutant-", suffix=".sql")[1])
        restore_mutant_path.write_text(restore_mutant_packet)
        restore_mutant_result = apply_file(database_url, restore_mutant_path, check=False)
        restore_mutant_path.unlink(missing_ok=True)
        if restore_mutant_result.returncode == 0 or "INBOX_CAPTURE_RESTORE_POSTCONDITION_FAILED" not in (restore_mutant_result.stdout + restore_mutant_result.stderr):
            raise RuntimeError("capture-restore did not kill the body-mutant postcondition")

        apply_file(database_url, RESTORE)
        apply_file(database_url, OFF)
        mutant_killed = mutate_before_return_null(database_url)
        if not mutant_killed:
            raise RuntimeError("BEFORE-return-NULL mutant was not killed")

        print(json.dumps({
            "status": "PASS",
            "database": database_url,
            "postgres": postgres_version,
            "main_ancestor": "538d81ed",
            "triggers_verified": len(expected_catalog),
            "functions_verified": len(expected_md5),
            "checks": [
                "all 27 canonical source capture triggers matched disposable catalog",
                "capture-off and capture-restore wrote receipts",
                "all affected source-table writes including auth.sessions insert/update/delete persisted with no Inbox capture deltas",
                "BEFORE-row no-op returned NEW and retained user write",
                "restore MD5 matched migration-extracted bodies and capture resumed",
                "capture-off reapplication was idempotent",
                "mixed function-body drift was refused",
            ],
            "mutants": {
                "before-return-NULL": "KILLED (source row disappears)",
                "function-body-drift": "KILLED (precondition refuses)",
                "restore-body": "KILLED (postcondition refuses)",
            },
        }, indent=2))
    finally:
        if project is not None:
            run(["supabase", "stop", "--workdir", str(project), "--no-backup", "--yes"], check=False)
            shutil.rmtree(project, ignore_errors=True)


if __name__ == "__main__":
    main()
