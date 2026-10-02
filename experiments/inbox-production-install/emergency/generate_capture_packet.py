#!/usr/bin/env python3
"""Generate the emergency Inbox capture-off/restore packet from approved SQL.

This is deliberately source-derived.  The packet must be regenerated from the
three migration files at the approved commit; no function body is hand-copied
into either operational SQL file.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
APPROVED_COMMIT = "4ee23fcb25d05bad77e2cf74189c24bb1f9ea4c2"
PRODUCTION_TARGET_REF = "copflsklaefwzipsrjqz"
LOCAL_TEST_TARGET_REF = "local-test"
MIGRATIONS = [
    ROOT / "supabase/migrations/20261002130000_inbox_control_foundation.sql",
    ROOT / "supabase/migrations/20261002130100_inbox_read_companion.sql",
    ROOT / "supabase/migrations/20261002130200_inbox_backend_operation_reply.sql",
]

# The README/runbook identifies these as the canonical source relations whose
# Inbox capture writes must be bypassable.  Trigger rows themselves are parsed
# from the approved migration SQL below; this list is only the boundary that
# excludes internal Inbox maintenance/immutability triggers.
SOURCE_RELATIONS = {
    "public.messages",
    "public.properties",
    "public.contacts",
    "public.memberships",
    "public.sequence_enrollments",
    "public.message_threads",
    "public.consent_events",
    "public.sms_phone_suppressions",
    "public.ai_disposition_reviews",
    "public.organizations",
    "public.provider_sender_numbers",
    "auth.sessions",
}

# These BEFORE-row triggers protect the server-owned inbound revision column;
# they are integrity guards, not Inbox capture and must remain live during the
# emergency window.
EXCLUDED_FUNCTIONS = {"public.inbox_guard_inbound_revision"}

FUNCTION_START = re.compile(
    r"\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+"
    r"(?P<name>[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*\(\s*\)\s*"
    r"(?P<header>.*?)\bAS\s+(?P<tag>\$[A-Za-z_][\w$]*\$|\$\$)",
    re.IGNORECASE | re.DOTALL,
)
TRIGGER_STATEMENT = re.compile(
    r"\bCREATE\s+TRIGGER\s+(?P<name>[A-Za-z_][\w$]*)\s+"
    r"(?P<timing>BEFORE|AFTER|INSTEAD\s+OF)\s+"
    r"(?P<events>.*?)\s+ON\s+(?P<table>[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s+"
    r"(?P<for_each>FOR\s+EACH\s+(?:ROW|STATEMENT))\s+"
    r"EXECUTE\s+FUNCTION\s+(?P<function>[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)?)\s*\((?P<args>.*?)\)\s*;",
    re.IGNORECASE | re.DOTALL,
)


@dataclass(frozen=True)
class FunctionSource:
    name: str
    migration: str
    statement: str
    body: str
    prefix: str
    suffix: str
    line: int

    @property
    def approved_md5(self) -> str:
        return hashlib.md5(self.body.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class Trigger:
    name: str
    table: str
    function: str
    timing: str
    level: str
    events: tuple[str, ...]
    migration: str
    line: int

    @property
    def identity(self) -> str:
        return f"{self.table}.{self.name}"

    @property
    def tgtype(self) -> int:
        bits = 2 if self.timing == "BEFORE" else 64 if self.timing == "INSTEAD OF" else 0
        bits |= 1 if self.level == "ROW" else 0
        bits |= {"INSERT": 4, "DELETE": 8, "UPDATE": 16, "TRUNCATE": 32}[self.events[0]]
        for event in self.events[1:]:
            bits |= {"INSERT": 4, "DELETE": 8, "UPDATE": 16, "TRUNCATE": 32}[event]
        return bits


def sql_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def parse_function_sources(path: Path) -> list[FunctionSource]:
    text = path.read_text()
    result: list[FunctionSource] = []
    for match in FUNCTION_START.finditer(text):
        tag = match.group("tag")
        body_start = match.end()
        body_end = text.find(tag, body_start)
        if body_end < 0:
            raise RuntimeError(f"unterminated function body in {path}:{text.count(chr(10), 0, match.start()) + 1}")
        statement_end = body_end + len(tag)
        while statement_end < len(text) and text[statement_end].isspace():
            statement_end += 1
        if statement_end >= len(text) or text[statement_end] != ";":
            raise RuntimeError(f"function statement missing semicolon in {path}:{text.count(chr(10), 0, match.start()) + 1}")
        statement_end += 1
        result.append(
            FunctionSource(
                name=match.group("name"),
                migration=path.name,
                statement=text[match.start() : statement_end],
                body=text[body_start:body_end],
                prefix=text[match.start() : body_start],
                suffix=text[body_end:statement_end],
                line=text.count("\n", 0, match.start()) + 1,
            )
        )
    return result


def parse_events(raw: str) -> tuple[str, ...]:
    events = tuple(re.findall(r"\b(INSERT|UPDATE|DELETE|TRUNCATE)\b", raw.upper()))
    if not events:
        raise RuntimeError(f"trigger event list not understood: {raw!r}")
    return events


def parse_triggers(path: Path) -> list[Trigger]:
    text = path.read_text()
    result: list[Trigger] = []
    for match in TRIGGER_STATEMENT.finditer(text):
        table = match.group("table")
        function = match.group("function")
        if table not in SOURCE_RELATIONS or function in EXCLUDED_FUNCTIONS:
            continue
        result.append(
            Trigger(
                name=match.group("name"),
                table=table,
                function=function,
                timing=re.sub(r"\s+", " ", match.group("timing").upper()),
                level="ROW" if match.group("for_each").upper().endswith("ROW") else "STATEMENT",
                events=parse_events(match.group("events")),
                migration=path.name,
                line=text.count("\n", 0, match.start()) + 1,
            )
        )
    return result


def latest_functions(triggers: list[Trigger], sources: dict[str, list[FunctionSource]]) -> dict[str, FunctionSource]:
    found: dict[str, FunctionSource] = {}
    for migration in MIGRATIONS:
        for source in sources[migration.name]:
            if source.name in {trigger.function for trigger in triggers}:
                found[source.name] = source
    missing = sorted({trigger.function for trigger in triggers} - set(found))
    if missing:
        raise RuntimeError(f"missing function source for: {', '.join(missing)}")
    return found


def replace_statement(source: FunctionSource, body: str) -> str:
    statement = source.prefix + body + source.suffix
    return re.sub(r"\bCREATE\s+FUNCTION\b", "CREATE OR REPLACE FUNCTION", statement, count=1, flags=re.IGNORECASE)


def no_op_body(trigger: Trigger) -> str:
    if trigger.level == "STATEMENT" or trigger.timing != "BEFORE":
        return "\nBEGIN\n  RETURN NULL;\nEND\n"
    return "\nBEGIN\n  IF TG_OP = 'DELETE' THEN\n    RETURN OLD;\n  END IF;\n  RETURN NEW;\nEND\n"


def build() -> None:
    sources = {path.name: parse_function_sources(path) for path in MIGRATIONS}
    triggers = [trigger for path in MIGRATIONS for trigger in parse_triggers(path)]
    if len(triggers) != 25:
        raise RuntimeError(f"expected 25 canonical Inbox capture triggers, parsed {len(triggers)}")
    if {trigger.table for trigger in triggers} != SOURCE_RELATIONS:
        raise RuntimeError("parsed trigger relation boundary does not cover the approved source relation set")
    if any(trigger.level != "ROW" for trigger in triggers):
        raise RuntimeError("unexpected statement-level trigger: inspect source before generating packet")
    function_sources = latest_functions(triggers, sources)
    function_triggers: dict[str, list[Trigger]] = {}
    for trigger in triggers:
        function_triggers.setdefault(trigger.function, []).append(trigger)
    if set(function_sources) != set(function_triggers):
        raise RuntimeError("function/trigger inventory mismatch")

    function_records = []
    for name in sorted(function_sources):
        source = function_sources[name]
        attached = function_triggers[name]
        if any(trigger.timing == "BEFORE" for trigger in attached) and any(trigger.timing != "BEFORE" for trigger in attached):
            raise RuntimeError(f"function has mixed BEFORE/AFTER attachments: {name}")
        body = no_op_body(attached[0])
        function_records.append(
            {
                "name": name,
                "migration": source.migration,
                "line": source.line,
                "approved_md5_prosrc": source.approved_md5,
                "no_op_md5_prosrc": hashlib.md5(body.encode("utf-8")).hexdigest(),
                "trigger_identities": [trigger.identity for trigger in attached],
            }
        )

    inventory = {
        "approved_commit": APPROVED_COMMIT,
        "migrations": [path.name for path in MIGRATIONS],
        "source_relations": sorted(SOURCE_RELATIONS),
        "functions": function_records,
        "triggers": [
            {
                "identity": trigger.identity,
                "table": trigger.table,
                "name": trigger.name,
                "function": trigger.function,
                "timing": trigger.timing,
                "level": trigger.level,
                "events": list(trigger.events),
                "tgtype": trigger.tgtype,
                "migration": trigger.migration,
                "line": trigger.line,
            }
            for trigger in sorted(triggers, key=lambda item: item.identity)
        ],
    }
    (OUT / "capture-trigger-inventory.json").write_text(json.dumps(inventory, indent=2) + "\n")

    values = ",\n      ".join(
        f"({sql_literal(record['name'] + '()')}, {sql_literal(record['approved_md5_prosrc'])}, {sql_literal(record['no_op_md5_prosrc'])})"
        for record in function_records
    )
    trigger_values = ",\n      ".join(
        f"({sql_literal(trigger['identity'])}, {sql_literal(trigger['function'] + '()')}, {trigger['tgtype']})"
        for trigger in inventory["triggers"]
    )
    digest_json = json.dumps({record["name"]: record["no_op_md5_prosrc"] for record in function_records}, separators=(",", ":"))
    trigger_json = json.dumps(
        [{"identity": item["identity"], "function": item["function"]} for item in inventory["triggers"]],
        separators=(",", ":"),
    )

    precondition = f"""DO $$
DECLARE approved_count integer; no_op_count integer; total_count integer; attached_count integer;
BEGIN
  -- EMERGENCY_TARGET_IDENTITY_GUARD_BEGIN
  IF coalesce(current_setting('inbox.emergency_target_ref', true), '') = {sql_literal(PRODUCTION_TARGET_REF)} THEN
    IF coalesce(current_setting('inbox.emergency_local_test', true), '') <> 'off' THEN
      RAISE EXCEPTION 'INBOX_EMERGENCY_PRODUCTION_LOCAL_TEST_REFUSED';
    END IF;
    IF current_database() <> 'postgres' THEN
      RAISE EXCEPTION 'INBOX_EMERGENCY_DATABASE_NAME_REFUSED';
    END IF;
  ELSIF coalesce(current_setting('inbox.emergency_target_ref', true), '') = {sql_literal(LOCAL_TEST_TARGET_REF)} THEN
    IF coalesce(current_setting('inbox.emergency_local_test', true), '') <> 'on'
       OR current_database() <> 'postgres'
       OR inet_server_addr() IS NULL
       OR inet_server_addr() NOT IN ('127.0.0.1'::inet, '::1'::inet) THEN
      RAISE EXCEPTION 'INBOX_EMERGENCY_LOCAL_TEST_IDENTITY_REFUSED';
    END IF;
  ELSE
    RAISE EXCEPTION 'INBOX_EMERGENCY_TARGET_REF_REQUIRED';
  END IF;
  -- EMERGENCY_TARGET_IDENTITY_GUARD_END
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_ROLE_REQUIRED';
  END IF;
  IF NOT has_table_privilege('postgres', 'auth.sessions', 'SELECT')
     OR NOT has_table_privilege('postgres', 'auth.sessions', 'TRIGGER') THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_AUTH_SESSIONS_PRIVILEGE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='inbox_bridge' AND p.proname='capture_access'
        AND pg_get_userbyid(p.proowner)='postgres') <> 1 THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_AUTH_FUNCTION_OWNER_DRIFT';
  END IF;
  WITH expected(name, approved_md5, no_op_md5) AS (VALUES
      {values}
  )
  SELECT count(*) FILTER (WHERE p.oid IS NULL),
         count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.approved_md5),
         count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.no_op_md5),
         count(*)
    INTO total_count, approved_count, no_op_count, attached_count
    FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.name);
  IF total_count <> 0 THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_FUNCTION_MISSING'; END IF;
  IF approved_count <> {len(function_records)} AND no_op_count <> {len(function_records)} THEN
    RAISE EXCEPTION 'INBOX_CAPTURE_OFF_FUNCTION_BODY_DRIFT';
  END IF;
  WITH expected(identity, function_name, tgtype) AS (VALUES
      {trigger_values}
  )
  SELECT count(*) INTO attached_count
    FROM expected e
    JOIN pg_trigger t ON NOT t.tgisinternal AND t.tgname = split_part(e.identity, '.', 3)
    JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace cn ON cn.oid=c.relnamespace
      AND cn.nspname||'.'||c.relname = split_part(e.identity, '.', 1)||'.'||split_part(e.identity, '.', 2)
    WHERE t.tgfoid=to_regprocedure(e.function_name) AND t.tgtype=e.tgtype AND t.tgenabled='O';
  IF attached_count <> {len(triggers)} THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_TRIGGER_CATALOG_DRIFT'; END IF;
END $$;"""

    replacements_off = "\n\n".join(
        replace_statement(function_sources[name], no_op_body(function_triggers[name][0]))
        for name in sorted(function_sources)
    )
    replacements_restore = "\n\n".join(
        replace_statement(function_sources[name], function_sources[name].body)
        for name in sorted(function_sources)
    )
    post_assert = f"""DO $$
DECLARE bad text;
BEGIN
  WITH expected(name, expected_md5) AS (VALUES
      {',\n      '.join(f"({sql_literal(record['name'] + '()')}, {sql_literal(record['no_op_md5_prosrc'])})" for record in function_records)}
  )
  SELECT e.name INTO bad FROM expected e JOIN pg_proc p ON p.oid=to_regprocedure(e.name) WHERE md5(p.prosrc)<>e.expected_md5 LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'INBOX_CAPTURE_OFF_POSTCONDITION_FAILED: %', bad; END IF;
END $$;"""
    restore_post_assert = f"""DO $$
DECLARE bad text;
BEGIN
  WITH expected(name, expected_md5) AS (VALUES
      {',\n      '.join(f"({sql_literal(record['name'] + '()')}, {sql_literal(record['approved_md5_prosrc'])})" for record in function_records)}
  )
  SELECT e.name INTO bad FROM expected e JOIN pg_proc p ON p.oid=to_regprocedure(e.name) WHERE md5(p.prosrc)<>e.expected_md5 LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'INBOX_CAPTURE_RESTORE_POSTCONDITION_FAILED: %', bad; END IF;
END $$;"""

    receipt_ddl = """CREATE SCHEMA IF NOT EXISTS inbox_emergency AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA inbox_emergency FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS inbox_emergency.capture_off_receipts (
  receipt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action text NOT NULL CHECK (action IN ('capture_off', 'capture_off_idempotent', 'capture_restore')),
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  approved_migration_commit text NOT NULL,
  trigger_count integer NOT NULL,
  function_bodies_md5 jsonb NOT NULL,
  trigger_inventory jsonb NOT NULL
);
ALTER TABLE inbox_emergency.capture_off_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON inbox_emergency.capture_off_receipts FROM PUBLIC, anon, authenticated, service_role;"""
    receipt_insert = f"""WITH expected(name, no_op_md5) AS (VALUES
      {',\n      '.join(f"({sql_literal(record['name'] + '()')}, {sql_literal(record['no_op_md5_prosrc'])})" for record in function_records)}
  )
INSERT INTO inbox_emergency.capture_off_receipts(action, approved_migration_commit, trigger_count, function_bodies_md5, trigger_inventory)
SELECT CASE WHEN count(*) FILTER (WHERE p.oid IS NOT NULL AND md5(p.prosrc)=e.no_op_md5) = {len(function_records)}
            THEN 'capture_off_idempotent' ELSE 'capture_off' END,
       {sql_literal(APPROVED_COMMIT)}, {len(triggers)}, {sql_literal(digest_json)}::jsonb, {sql_literal(trigger_json)}::jsonb
  FROM expected e LEFT JOIN pg_proc p ON p.oid=to_regprocedure(e.name);"""
    restore_receipt_insert = f"""DO $$ BEGIN
  IF to_regclass('inbox_emergency.capture_off_receipts') IS NOT NULL THEN
    INSERT INTO inbox_emergency.capture_off_receipts(action, approved_migration_commit, trigger_count, function_bodies_md5, trigger_inventory)
    VALUES ('capture_restore', {sql_literal(APPROVED_COMMIT)}, {len(triggers)}, {sql_literal(json.dumps({record['name']: record['approved_md5_prosrc'] for record in function_records}, separators=(',', ':')))}::jsonb, {sql_literal(trigger_json)}::jsonb);
  END IF;
END $$;"""

    capture_off = f"""-- GENERATED FILE. Source: {', '.join(path.name for path in MIGRATIONS)} at {APPROVED_COMMIT}.
-- Tooling-only emergency packet; never place this file in supabase/migrations.
-- Canonical source-capture trigger inventory is in capture-trigger-inventory.json.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';

{precondition}

{receipt_ddl}

{receipt_insert}

{replacements_off}

{post_assert}
COMMIT;
"""
    capture_restore = f"""-- GENERATED FILE. Source: {', '.join(path.name for path in MIGRATIONS)} at {APPROVED_COMMIT}.
-- Tooling-only emergency restore packet; never place this file in supabase/migrations.
\\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout='2s';
SET LOCAL statement_timeout='10s';

{precondition}

{replacements_restore}

{restore_post_assert}
{restore_receipt_insert}
COMMIT;
"""
    (OUT / "capture-off.sql").write_text(capture_off)
    (OUT / "capture-restore.sql").write_text(capture_restore)


if __name__ == "__main__":
    build()
