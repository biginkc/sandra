#!/usr/bin/env python3
"""Rebuild derived Inbox state after a logical restore of the owned HTTP DB.

This is an offline-fixture recovery tool.  It is deliberately opt-in: without
``--apply`` it performs only guarded reads and prints a bounded plan.  It never
enables Inbox serving or command admission, never touches canonical operation
or provider state, and never uses replica mode or TRUNCATE.  A logical restore
is a capture-generation break because the source rows were loaded outside the
normal row-level capture path; this tool creates a new generation, invalidates
ephemeral read scopes, and replays the reviewed bounded backfill/parent/summary
primitives against the current canonical source tables.

The database name is an explicit argument because the restored verification
database may be a separate database in the same guarded container.  The same
owned marker must be present in either database.  No application URL or worker
configuration is changed here.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from typing import Any, Iterable


SOCKET = os.environ.get(
    "INBOX_T2_DOCKER_SOCKET",
    "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock",
)
CONTAINER = "sandra-inbox-release-http-db-20260917"
MARKER = "sandra-inbox-http-owned-synthetic-20260917"
CONTAINER_MARKER = "sandra-inbox-release-http-owned-20260917"
NETWORK = "sandra-inbox-release-http-20260917"
DOCKER = ["docker", "--host", SOCKET]
DATABASE_RE = re.compile(r"^[a-z][a-z0-9_]{0,62}$")

# These tables are durable authority or accepted/provider evidence.  The
# mutating SQL below intentionally does not name any of them.  A deterministic
# per-column content fingerprint (including keys and counters) is captured
# before and after recovery while writers are stopped.
PROTECTED_RELATIONS = (
    "bus.bus_messages",
    "public.messages",
    "public.inbox_inbound_heads",
    "inbox_message_capture.versions",
    "inbox_bridge.access_epochs",
    "inbox_policy.versions",
    "inbox_operations.operations",
    "inbox_operations.preparations",
    "inbox_operations.items",
    "inbox_operations.steps",
    "inbox_operations.item_steps",
    "inbox_operations.receipts",
    "inbox_operations.dispatch_outbox",
    "inbox_operation_domain.shared_sms_receipts",
    "inbox_operation_domain.sms_scopes",
    "inbox_operation_domain.target_versions",
    "inbox_reply_context.versions",
    "inbox_reply_review.preparations",
    "inbox_reply_review.admission",
    "inbox_reply_send.operations",
    "inbox_reply_send.attempts",
    "inbox_reply_send.dispatch_outbox",
    "inbox_reply_send.callback_receipts",
    "inbox_reply_send.unmatched_callbacks",
    "public.provider_sender_numbers",
)

REQUIRED_RELATIONS = (
    "install_fixture.identity",
    "inbox_control.rollout",
    "inbox_control.command_admission",
    "inbox_capture_boundary.generation",
    "inbox_message_capture.sender_groups",
    "inbox_message_capture.sender_buckets",
    "inbox_message_capture.dirty",
    "inbox_message_capture.route_edges",
    "inbox_maintained.rows",
    "inbox_maintained.queue",
    "inbox_parent.work",
    "inbox_backfill.jobs",
    "inbox_backfill.collisions",
    "inbox_safety.routes",
    "inbox_bridge.summaries",
    "inbox_bridge.filter_rows",
    "inbox_bridge.worksets",
    "inbox_bridge.cursors",
    "inbox_read.boundaries",
    "inbox_read.receipts",
    "inbox_read.history_cursors",
    "inbox_read.unknown_history_cursors",
)

ALLOWED_IDLE_APPLICATIONS = {"pg_net 0.20.4", "pg_cron scheduler"}


def sql_literal(value: Any) -> str:
    """Quote a value already returned by PostgreSQL for a follow-up query."""

    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def json_rows(raw: str) -> list[dict[str, Any]]:
    if not raw:
        return []
    value = json.loads(raw)
    if not isinstance(value, list):
        raise RuntimeError("expected a JSON array from the guarded fixture")
    return value


@dataclass
class OwnedHttpDb:
    """Minimal target-aware copy of the reviewed HTTP fixture adapter."""

    database: str
    role: str = "supabase_admin"

    def inspect(self) -> dict[str, Any]:
        try:
            rows = json.loads(subprocess.check_output(DOCKER + ["inspect", CONTAINER], text=True))
        except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
            raise RuntimeError("owned HTTP fixture database container is unavailable") from exc
        if len(rows) != 1:
            raise RuntimeError("expected exactly one owned HTTP fixture database container")
        row = rows[0]
        labels = row.get("Config", {}).get("Labels", {})
        if labels.get("purpose") != "sandra-inbox-release-http" or labels.get("owner") != "release-infra" or labels.get("marker") != CONTAINER_MARKER:
            raise RuntimeError("HTTP fixture database ownership marker mismatch")
        if row.get("State", {}).get("Status") != "running":
            raise RuntimeError("HTTP fixture database is not running")
        if row.get("HostConfig", {}).get("NetworkMode") != NETWORK:
            raise RuntimeError("HTTP fixture database network identity drift")
        bindings = row.get("HostConfig", {}).get("PortBindings", {}).get("5432/tcp", [])
        if bindings != [{"HostIp": "127.0.0.1", "HostPort": "54322"}]:
            raise RuntimeError("HTTP fixture database host binding drift")
        return row

    def sql(self, query: str, *, role: str | None = None, retry: bool = False) -> str:
        self.inspect()
        attempts = 3 if retry else 1
        db_role = role or self.role
        for attempt in range(attempts):
            result = subprocess.run(
                DOCKER
                + [
                    "exec",
                    "-i",
                    CONTAINER,
                    "psql",
                    "-XqAt",
                    "-U",
                    db_role,
                    "-d",
                    self.database,
                    "-v",
                    "ON_ERROR_STOP=1",
                    "-v",
                    "VERBOSITY=verbose",
                ],
                input="SET statement_timeout='30s';SET lock_timeout='2s';" + query,
                text=True,
                capture_output=True,
                timeout=40,
            )
            if result.returncode == 0:
                return result.stdout.strip()
            if not retry or attempt == attempts - 1 or not any(code in result.stderr for code in ("40P01", "40001", "55P03")):
                raise RuntimeError(result.stderr.strip()[-2000:])
            time.sleep(0.05 * (attempt + 1))
        raise RuntimeError("HTTP fixture SQL retry exhausted")

    def scalar(self, query: str, *, role: str | None = None) -> str:
        return self.sql(query, role=role)

    def guard(self) -> None:
        self.inspect()
        if not DATABASE_RE.fullmatch(self.database):
            raise RuntimeError("invalid restore target database name")
        actual = self.scalar(
            "SELECT current_database()||'|'||(SELECT marker FROM install_fixture.identity);"
        )
        expected = f"{self.database}|{MARKER}"
        if actual != expected:
            raise RuntimeError(f"HTTP fixture identity mismatch for selected database: {actual!r}")


def required_relation_guard(db: OwnedHttpDb) -> None:
    names = ",".join(sql_literal(value) for value in (*REQUIRED_RELATIONS, *PROTECTED_RELATIONS))
    raw = db.scalar(
        f"""
        SELECT coalesce(string_agg(x.name, ',' ORDER BY x.name),'')
        FROM unnest(ARRAY[{names}]::text[]) AS x(name)
        WHERE to_regclass(x.name) IS NULL
        """
    )
    if raw:
        raise RuntimeError(f"owned HTTP recovery schema is incomplete: {raw}")


def preflight(db: OwnedHttpDb) -> dict[str, Any]:
    db.guard()
    required_relation_guard(db)
    state = json.loads(
        db.scalar(
            """
            SELECT jsonb_build_object(
              'serving_enabled',(SELECT serving_enabled FROM inbox_control.rollout WHERE singleton),
              'admission_total',(SELECT count(*) FROM inbox_control.command_admission),
              'admission_enabled',(SELECT count(*) FROM inbox_control.command_admission WHERE enabled),
              'generation',(SELECT generation::text FROM inbox_capture_boundary.generation WHERE singleton),
              'read_boundaries',(SELECT count(*) FROM inbox_read.boundaries),
              'read_history_cursors',(SELECT count(*) FROM inbox_read.history_cursors),
              'read_unknown_cursors',(SELECT count(*) FROM inbox_read.unknown_history_cursors),
              'maintained',(SELECT count(*) FROM inbox_maintained.rows),
              'summaries',(SELECT count(*) FROM inbox_bridge.summaries),
              'filters',(SELECT count(*) FROM inbox_bridge.filter_rows),
              'queue',(SELECT count(*) FROM inbox_maintained.queue),
              'backfill_pending',(SELECT count(*) FROM inbox_backfill.jobs WHERE stream <> 'done' OR claim_token IS NOT NULL),
              'parent_pending',(SELECT count(*) FROM inbox_parent.work WHERE generation > ack OR claim_token IS NOT NULL),
              'safety_pending',(SELECT count(*) FROM inbox_safety.routes WHERE generation > ack OR claim_token IS NOT NULL),
              'collision_pending',(SELECT count(*) FROM inbox_backfill.collisions WHERE generation > ack)
            )
            """
        )
    )
    if state["serving_enabled"] is not False:
        raise RuntimeError("refusing recovery while inbox_control.rollout.serving_enabled is true")
    if int(state["admission_enabled"]) != 0:
        raise RuntimeError("refusing recovery while command admission is enabled")
    sessions = json_rows(
        db.scalar(
            """
            SELECT coalesce(jsonb_agg(jsonb_build_object('application',application_name,'user',usename,'state',state)),'[]'::jsonb)
            FROM pg_stat_activity
            WHERE datname=current_database() AND pid<>pg_backend_pid()
              AND backend_type='client backend'
              AND application_name NOT IN ('pg_net 0.20.4','pg_cron scheduler')
            """
        )
    )
    if sessions:
        apps = sorted({str(row.get("application", "")) for row in sessions})
        raise RuntimeError(f"refusing recovery with non-quiesced database sessions: {apps}")
    async_tables = json.loads(
        db.scalar(
            """
            SELECT jsonb_build_object(
              'http_queue',to_regclass('net.http_request_queue') IS NOT NULL,
              'cron_jobs',to_regclass('cron.job') IS NOT NULL
            )
            """
        )
    )
    if async_tables["http_queue"]:
        async_tables["http_pending"] = int(db.scalar("SELECT count(*) FROM net.http_request_queue"))
    else:
        async_tables["http_pending"] = 0
    if async_tables["cron_jobs"]:
        async_tables["cron_enabled"] = int(db.scalar("SELECT count(*) FROM cron.job WHERE active"))
    else:
        async_tables["cron_enabled"] = 0
    if async_tables["http_pending"] or async_tables["cron_enabled"]:
        raise RuntimeError("refusing recovery while pg_net/pg_cron may produce asynchronous writes")
    protected = protected_snapshot(db)
    return {"state": state, "protected_snapshot": protected, "async": async_tables}


def quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def protected_snapshot(db: OwnedHttpDb) -> dict[str, dict[str, Any]]:
    """Return order-independent native-column content fingerprints.

    Each column is rendered by its own ``::text`` output and encoded with an
    explicit length/null marker.  Primary keys remain part of each row hash,
    so a count-preserving swap is detected without printing any row content.
    """

    result: dict[str, dict[str, Any]] = {}
    for relation in PROTECTED_RELATIONS:
        schema, table = relation.split(".", 1)
        columns = [
            row
            for row in db.sql(
                f"""
                SELECT a.attname
                FROM pg_attribute a
                JOIN pg_class c ON c.oid=a.attrelid
                JOIN pg_namespace n ON n.oid=c.relnamespace
                WHERE c.relkind='r' AND n.nspname={sql_literal(schema)}
                  AND c.relname={sql_literal(table)}
                  AND a.attnum>0 AND NOT a.attisdropped
                ORDER BY a.attnum
                """
            ).splitlines()
            if row
        ]
        if not columns:
            raise RuntimeError(f"protected relation has no discoverable columns: {relation}")
        encoded = ",".join(
            "CASE WHEN t.%s IS NULL THEN 'N' ELSE length(t.%s::text)::text || ':' || t.%s::text END"
            % (quote_ident(column), quote_ident(column), quote_ident(column))
            for column in columns
        )
        digest = db.scalar(
            f"""
            SELECT md5(coalesce(string_agg(h,',' ORDER BY h),''))
            FROM (
              SELECT md5(array_to_string(ARRAY[{encoded}],'')) AS h
              FROM {quote_ident(schema)}.{quote_ident(table)} t
            ) rows
            """
        )
        result[relation] = {
            "count": int(db.scalar(f"SELECT count(*) FROM {quote_ident(schema)}.{quote_ident(table)}")),
            "hash": digest,
        }
    return result


def plan(db: OwnedHttpDb) -> dict[str, Any]:
    return json.loads(
        db.scalar(
            """
            SELECT jsonb_build_object(
              'organizations',(SELECT count(*) FROM public.organizations),
              'sms_messages',(SELECT count(*) FROM public.messages WHERE channel='sms'),
              'known_targets',(SELECT count(*) FROM (SELECT DISTINCT org_id,conversation_id FROM public.messages WHERE channel='sms' AND conversation_id IS NOT NULL) q),
              'unknown_source_senders',(SELECT count(*) FROM (SELECT DISTINCT org_id,from_address FROM public.messages WHERE channel='sms' AND direction='inbound' AND contact_id IS NULL AND from_address IS NOT NULL AND from_address<>'') q),
              'properties',(SELECT count(*) FROM public.properties),
              'contacts',(SELECT count(*) FROM public.contacts),
              'read_boundaries',(SELECT count(*) FROM inbox_read.boundaries),
              'protected_relations',jsonb_build_object('count',24)
            )
            """
        )
    )


def apply_break(db: OwnedHttpDb) -> None:
    """Atomically mark the restore break and enqueue every canonical source."""

    db.sql(
        """
        BEGIN;
        SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s';
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM inbox_control.rollout
            WHERE singleton AND serving_enabled IS FALSE
            FOR UPDATE
          ) THEN
            RAISE EXCEPTION 'owned HTTP recovery requires a single serving-disabled rollout row';
          END IF;
          IF EXISTS (SELECT 1 FROM inbox_control.command_admission WHERE enabled) THEN
            RAISE EXCEPTION 'owned HTTP recovery requires command admission to remain disabled';
          END IF;
        END $$;
        UPDATE inbox_control.rollout
          SET serving_enabled=false,backfill_complete=false,reconciliation_complete=false
          WHERE singleton;
        UPDATE inbox_capture_boundary.generation SET generation=gen_random_uuid() WHERE singleton;

        -- A capture-generation break invalidates ephemeral read state only.
        -- inbox_read.receipts are read-window receipts; canonical
        -- public.messages.read_at and all operation/reply/provider receipts
        -- remain untouched.
        DELETE FROM inbox_read.history_cursors;
        DELETE FROM inbox_read.unknown_history_cursors;
        DELETE FROM inbox_read.receipts;
        DELETE FROM inbox_read.boundaries;

        -- Scope/cursor state is derived and must not survive a restored source
        -- snapshot.  Preserve the workset generation history and only revoke.
        DELETE FROM inbox_bridge.cursors;
        UPDATE inbox_bridge.worksets SET revoked=true,expires_at=clock_timestamp()
          WHERE revoked IS NOT TRUE;

        -- Preserve every counter; increment private generations to force a
        -- fresh source pass and clear only abandoned worker leases/cursors.
        UPDATE inbox_message_capture.dirty
          SET generation=generation+1;
        UPDATE inbox_parent.work
          SET generation=generation+1,claim_token=NULL,lease_until=NULL,
              scan_generation=NULL,stream=NULL,cursor=NULL,available_at=clock_timestamp();
        UPDATE inbox_safety.routes
          SET generation=generation+1,claim_token=NULL,lease_until=NULL,
              scan_generation=NULL,cursor=NULL,available_at=clock_timestamp();
        UPDATE inbox_backfill.jobs
          SET revision=revision+1,stream='messages',cursor=NULL,claim_token=NULL,
              lease_until=NULL,available_at=clock_timestamp(),completed_at=NULL;

        INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation)
        SELECT DISTINCT m.org_id,'known_conversation',m.conversation_id,1
        FROM public.messages m
        WHERE m.channel='sms' AND m.conversation_id IS NOT NULL
        ON CONFLICT(org_id,target_kind,target_id)
        DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;

        -- Preserve maintained tombstones for source targets that disappeared
        -- in the restored snapshot.  Re-dirtying every existing maintained
        -- key makes the reviewed snapshot/publish protocol recompute it and
        -- lets the bridge trigger remove stale summaries and filter rows;
        -- deleting a maintained row would reset its revision on recreation.
        INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation)
        SELECT r.org_id,r.target_kind,r.target_id,1
        FROM inbox_maintained.rows r
        ON CONFLICT(org_id,target_kind,target_id)
        DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;

        INSERT INTO inbox_parent.work(org_id,kind,entity_id,generation)
        SELECT p.org_id,'property',p.id,1 FROM public.properties p
        ON CONFLICT(org_id,kind,entity_id) DO NOTHING;
        INSERT INTO inbox_parent.work(org_id,kind,entity_id,generation)
        SELECT c.org_id,'contact',c.id,1 FROM public.contacts c
        ON CONFLICT(org_id,kind,entity_id) DO NOTHING;
        INSERT INTO inbox_safety.routes(org_id,phone_e164,generation)
        SELECT DISTINCT s.org_id,s.phone_e164,1 FROM public.sms_phone_suppressions s
        WHERE s.channel='sms'
        ON CONFLICT(org_id,phone_e164)
        DO UPDATE SET generation=inbox_safety.routes.generation+1;

        DO $$ DECLARE o uuid;
        BEGIN
          FOR o IN SELECT org_row.id FROM public.organizations org_row
                   WHERE NOT EXISTS (SELECT 1 FROM inbox_backfill.jobs j WHERE j.org_id=org_row.id)
                   ORDER BY id LOOP
            PERFORM inbox_backfill.start(o);
          END LOOP;
        END $$;
        COMMIT;
        """,
        retry=True,
    )


def ensure_sender_groups(db: OwnedHttpDb, batch_size: int, max_batches: int) -> int:
    created = 0
    rounds = 0
    while rounds < max_batches:
        missing = int(
            db.scalar(
                f"""
                SELECT count(*) FROM (
                  SELECT DISTINCT m.org_id,m.from_address
                  FROM public.messages m
                  WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
                    AND m.from_address IS NOT NULL AND m.from_address<>''
                    AND NOT EXISTS (
                      SELECT 1 FROM inbox_message_capture.sender_groups g
                      WHERE g.org_id=m.org_id AND g.raw_sender COLLATE \"C\"=m.from_address COLLATE \"C\"
                    )
                  LIMIT {batch_size}
                ) q
                """
            )
        )
        if missing == 0:
            return created
        db.sql(
            f"""
            SELECT inbox_message_capture.sender_id(q.org_id,q.raw_sender)
            FROM (
              SELECT DISTINCT m.org_id,m.from_address AS raw_sender
              FROM public.messages m
              WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
                AND m.from_address IS NOT NULL AND m.from_address<>''
                AND NOT EXISTS (
                  SELECT 1 FROM inbox_message_capture.sender_groups g
                  WHERE g.org_id=m.org_id AND g.raw_sender COLLATE \"C\"=m.from_address COLLATE \"C\"
                )
              ORDER BY m.org_id,m.from_address COLLATE \"C\"
              LIMIT {batch_size}
            ) q
            """,
            retry=True,
        )
        created += missing
        rounds += 1
    raise RuntimeError(f"sender-group reconciliation exceeded bounded batch budget ({max_batches})")


def enqueue_unknown_targets(db: OwnedHttpDb) -> None:
    db.sql(
        """
        INSERT INTO inbox_message_capture.dirty(org_id,target_kind,target_id,generation)
        SELECT DISTINCT m.org_id,'unknown_sender',g.sender_group_id,1
        FROM public.messages m
        JOIN inbox_message_capture.sender_groups g
          ON g.org_id=m.org_id AND g.raw_sender COLLATE "C"=m.from_address COLLATE "C"
        WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
          AND m.from_address IS NOT NULL AND m.from_address<>''
        ON CONFLICT(org_id,target_kind,target_id)
        DO UPDATE SET generation=inbox_message_capture.dirty.generation+1;
        """,
        retry=True,
    )


def claim_rows(db: OwnedHttpDb, function: str, limit: int, lease: int) -> list[dict[str, Any]]:
    return json_rows(db.scalar(f"SELECT coalesce(jsonb_agg(to_jsonb(x)),'[]'::jsonb) FROM {function}({limit},{lease}) x"))


def drain_backfill(db: OwnedHttpDb, batch_size: int, max_batches: int) -> int:
    batches = 0
    idle_rounds = 0
    while batches < max_batches:
        jobs = claim_rows(db, "inbox_backfill.claim", min(100, batch_size), 300)
        if not jobs:
            pending = int(db.scalar("SELECT count(*) FROM inbox_backfill.jobs WHERE stream<>'done' OR claim_token IS NOT NULL"))
            if pending == 0:
                return batches
            idle_rounds += 1
            if idle_rounds >= 20:
                raise RuntimeError("backfill claims remained unavailable within the bounded idle budget")
            time.sleep(0.05)
            continue
        idle_rounds = 0
        for job in jobs:
            result = json.loads(
                db.scalar(
                    "SELECT inbox_backfill.batch(%s,%s,%d)"
                    % (sql_literal(job["org_id"]), sql_literal(job["claim_token"]), batch_size)
                )
            )
            if result.get("result") == "stale_claim":
                raise RuntimeError("backfill claim became stale during quiesced recovery")
            batches += 1
            if batches >= max_batches:
                break
    raise RuntimeError(f"backfill exceeded bounded batch budget ({max_batches})")


def inspect_collisions(db: OwnedHttpDb, max_batches: int) -> int:
    """Acknowledge every bounded collision probe, but fail on real duplicates."""

    batches = 0
    idle_rounds = 0
    while batches < max_batches:
        orgs = json_rows(
            db.scalar(
                """
                SELECT coalesce(jsonb_agg(jsonb_build_object('org_id',org_id)),'[]'::jsonb)
                FROM (
                  SELECT org_id FROM inbox_backfill.collisions
                  WHERE generation>ack GROUP BY org_id ORDER BY org_id LIMIT 100
                ) pending
                """
            )
        )
        if not orgs:
            duplicates = int(
                db.scalar(
                    "SELECT count(*) FROM inbox_backfill.collisions WHERE cardinality(duplicate_thread_ids)=2"
                )
            )
            if duplicates:
                raise RuntimeError(f"canonical duplicate thread identities remain after collision inspection: {duplicates}")
            return batches
        progressed = 0
        for row in orgs:
            processed = int(
                db.scalar(
                    "SELECT inbox_backfill.inspect_collisions(%s,500)"
                    % sql_literal(row["org_id"])
                )
            )
            progressed += processed
            batches += 1
            if batches >= max_batches:
                break
        if progressed == 0:
            idle_rounds += 1
            if idle_rounds >= 20:
                raise RuntimeError("collision inspection made no bounded progress")
        else:
            idle_rounds = 0
    raise RuntimeError(f"collision inspection exceeded bounded batch budget ({max_batches})")


def drain_parent(db: OwnedHttpDb, batch_size: int, max_batches: int) -> int:
    batches = 0
    idle_rounds = 0
    while batches < max_batches:
        jobs = claim_rows(db, "inbox_parent.claim", min(100, batch_size), 300)
        if not jobs:
            pending = int(db.scalar("SELECT count(*) FROM inbox_parent.work WHERE generation>ack OR claim_token IS NOT NULL"))
            if pending == 0:
                return batches
            idle_rounds += 1
            if idle_rounds >= 20:
                raise RuntimeError("parent claims remained unavailable within the bounded idle budget")
            time.sleep(0.05)
            continue
        idle_rounds = 0
        for job in jobs:
            result = json.loads(
                db.scalar(
                    "SELECT inbox_parent.batch(%s,%s,%s,%s,%d)"
                    % (
                        sql_literal(job["org_id"]),
                        sql_literal(job["kind"]),
                        sql_literal(job["entity_id"]),
                        sql_literal(job["claim_token"]),
                        batch_size,
                    )
                )
            )
            if result.get("result") == "stale_claim":
                raise RuntimeError("parent claim became stale during quiesced recovery")
            batches += 1
            if batches >= max_batches:
                break
    raise RuntimeError(f"parent reconciliation exceeded bounded batch budget ({max_batches})")


def drain_safety(db: OwnedHttpDb, batch_size: int, max_batches: int) -> int:
    batches = 0
    idle_rounds = 0
    while batches < max_batches:
        jobs = claim_rows(db, "inbox_safety.claim", min(100, batch_size), 300)
        if not jobs:
            pending = int(db.scalar("SELECT count(*) FROM inbox_safety.routes WHERE generation>ack OR claim_token IS NOT NULL"))
            if pending == 0:
                return batches
            idle_rounds += 1
            if idle_rounds >= 20:
                raise RuntimeError("safety claims remained unavailable within the bounded idle budget")
            time.sleep(0.05)
            continue
        idle_rounds = 0
        for job in jobs:
            result = json.loads(
                db.scalar(
                    "SELECT inbox_safety.batch(%s,%s,%s,%d)"
                    % (
                        sql_literal(job["org_id"]),
                        sql_literal(job["phone_e164"]),
                        sql_literal(job["claim_token"]),
                        batch_size,
                    )
                )
            )
            if result.get("result") == "stale_claim":
                raise RuntimeError("safety claim became stale during quiesced recovery")
            batches += 1
            if batches >= max_batches:
                break
    raise RuntimeError(f"safety reconciliation exceeded bounded batch budget ({max_batches})")


def prune_orphan_queue(db: OwnedHttpDb) -> None:
    # Keep queue entries for maintained tombstones: they must be recomputed so
    # the bridge removes their live projections without resetting revisions.
    db.sql(
        """
        WITH targets AS (
          SELECT DISTINCT org_id,'known_conversation'::text AS target_kind,conversation_id AS target_id
          FROM public.messages WHERE channel='sms' AND conversation_id IS NOT NULL
          UNION
          SELECT DISTINCT m.org_id,'unknown_sender'::text,g.sender_group_id
          FROM public.messages m JOIN inbox_message_capture.sender_groups g
            ON g.org_id=m.org_id AND g.raw_sender COLLATE "C"=m.from_address COLLATE "C"
          WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
            AND m.from_address IS NOT NULL AND m.from_address<>''
        )
        DELETE FROM inbox_maintained.queue q
        WHERE NOT EXISTS (
          SELECT 1 FROM targets t
          WHERE t.org_id=q.org_id AND t.target_kind=q.target_kind AND t.target_id=q.target_id
        ) AND NOT EXISTS (
          SELECT 1 FROM inbox_maintained.rows r
          WHERE r.org_id=q.org_id AND r.target_kind=q.target_kind AND r.target_id=q.target_id
        );
        """,
        retry=True,
    )


def drain_maintained(db: OwnedHttpDb, batch_size: int, max_batches: int) -> int:
    batches = 0
    idle_rounds = 0
    while batches < max_batches:
        jobs = claim_rows(db, "inbox_maintained.claim_work", min(100, batch_size), 300)
        if not jobs:
            pending = int(db.scalar("SELECT count(*) FROM inbox_maintained.queue"))
            if pending == 0:
                return batches
            idle_rounds += 1
            if idle_rounds >= 20:
                raise RuntimeError("maintained claims remained unavailable within the bounded idle budget")
            time.sleep(0.05)
            continue
        idle_rounds = 0
        for job in jobs:
            candidate = db.scalar(
                "SELECT inbox_maintained.snapshot(%s,%s,%s,clock_timestamp())"
                % (
                    sql_literal(job["org_id"]),
                    sql_literal(job["target_kind"]),
                    sql_literal(job["target_id"]),
                )
            )
            if not candidate:
                raise RuntimeError("canonical target disappeared before maintained snapshot; recovery is not safe to continue")
            result = db.scalar(
                "SELECT inbox_maintained.finish_work(%s,%s::jsonb)"
                % (sql_literal(job["claim_token"]), sql_literal(candidate))
            )
            if result in {"stale_claim", "missing_target", "projection_conflict", "invalid_generation"}:
                raise RuntimeError(f"maintained projection did not apply: {result}")
            batches += 1
            if batches >= max_batches:
                break
    raise RuntimeError(f"maintained reconciliation exceeded bounded batch budget ({max_batches})")


def remove_stale_derived(db: OwnedHttpDb) -> None:
    """Remove only derived rows whose authoritative source target is gone.

    The maintained worker publishes ``exists=false`` for a source target that
    remains in ``dirty``.  The tombstone remains authoritative so its revision
    cannot restart at one.  Bridge summaries and filter rows are removed after
    the tombstone is published; orphan bridge rows with no maintained key are
    also safe to remove.  Counter-bearing source, operation, reply, provider,
    epoch, and policy tables are never named.
    """

    db.sql(
        """
        DELETE FROM inbox_bridge.filter_rows f
        WHERE NOT EXISTS (
          SELECT 1 FROM inbox_maintained.rows r
          WHERE r.org_id=f.org_id AND r.target_kind=f.target_kind AND r.target_id=f.target_id
            AND coalesce((r.summary->>'exists')::boolean,false)
        );
        DELETE FROM inbox_bridge.summaries s
        WHERE NOT EXISTS (
          SELECT 1 FROM inbox_maintained.rows r
          WHERE r.org_id=s.org_id AND r.target_kind=s.target_kind AND r.target_id=s.target_id
            AND coalesce((r.summary->>'exists')::boolean,false)
        );

        DELETE FROM inbox_message_capture.route_edges e
        WHERE NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.id=e.message_id AND m.org_id=e.org_id);
        """,
        retry=True,
    )


def verify_reconciled(db: OwnedHttpDb, before_protected: dict[str, dict[str, Any]]) -> dict[str, Any]:
    after_protected = protected_snapshot(db)
    changed = {
        name: (before_protected[name], after_protected[name])
        for name in before_protected
        if before_protected[name] != after_protected[name]
    }
    if changed:
        raise RuntimeError(f"protected durable content changed during recovery: {changed}")
    result = json.loads(
        db.scalar(
            """
            SELECT jsonb_build_object(
              'serving_enabled',(SELECT serving_enabled FROM inbox_control.rollout WHERE singleton),
              'admission_enabled',(SELECT count(*) FROM inbox_control.command_admission WHERE enabled),
              'generation',(SELECT generation::text FROM inbox_capture_boundary.generation WHERE singleton),
              'backfill_pending',(SELECT count(*) FROM inbox_backfill.jobs WHERE stream<>'done' OR claim_token IS NOT NULL),
              'parent_pending',(SELECT count(*) FROM inbox_parent.work WHERE generation>ack OR claim_token IS NOT NULL),
              'safety_pending',(SELECT count(*) FROM inbox_safety.routes WHERE generation>ack OR claim_token IS NOT NULL),
              'queue_pending',(SELECT count(*) FROM inbox_maintained.queue),
              'collisions_pending',(SELECT count(*) FROM inbox_backfill.collisions WHERE generation>ack),
              'duplicate_threads',(SELECT count(*) FROM inbox_backfill.collisions WHERE cardinality(duplicate_thread_ids)=2),
              'read_boundaries',(SELECT count(*) FROM inbox_read.boundaries),
              'history_cursors',(SELECT count(*) FROM inbox_read.history_cursors),
              'unknown_cursors',(SELECT count(*) FROM inbox_read.unknown_history_cursors),
              'maintained_tombstones',(SELECT count(*) FROM inbox_maintained.rows r WHERE coalesce((r.summary->>'exists')::boolean,false) IS NOT TRUE),
              'maintained_missing_dirty',(SELECT count(*) FROM inbox_maintained.rows r WHERE NOT EXISTS (SELECT 1 FROM inbox_message_capture.dirty d WHERE d.org_id=r.org_id AND d.target_kind=r.target_kind AND d.target_id=r.target_id)),
              'tombstone_summaries',(SELECT count(*) FROM inbox_bridge.summaries s JOIN inbox_maintained.rows r USING(org_id,target_kind,target_id) WHERE coalesce((r.summary->>'exists')::boolean,false) IS NOT TRUE),
              'tombstone_filters',(SELECT count(*) FROM inbox_bridge.filter_rows f JOIN inbox_maintained.rows r USING(org_id,target_kind,target_id) WHERE coalesce((r.summary->>'exists')::boolean,false) IS NOT TRUE),
              'live_targets_missing_maintained',(SELECT count(*) FROM (
                SELECT DISTINCT m.org_id,'known_conversation'::text AS target_kind,m.conversation_id AS target_id
                FROM public.messages m WHERE m.channel='sms' AND m.conversation_id IS NOT NULL
                UNION
                SELECT DISTINCT m.org_id,'unknown_sender'::text,g.sender_group_id
                FROM public.messages m JOIN inbox_message_capture.sender_groups g
                  ON g.org_id=m.org_id AND g.raw_sender COLLATE "C"=m.from_address COLLATE "C"
                WHERE m.channel='sms' AND m.direction='inbound' AND m.contact_id IS NULL
                  AND m.from_address IS NOT NULL AND m.from_address<>''
              ) t WHERE NOT EXISTS (
                SELECT 1 FROM inbox_maintained.rows r
                WHERE r.org_id=t.org_id AND r.target_kind=t.target_kind AND r.target_id=t.target_id
                  AND coalesce((r.summary->>'exists')::boolean,false)
              )),
              'missing_summaries',(SELECT count(*) FROM inbox_maintained.rows r WHERE coalesce((r.summary->>'exists')::boolean,false) AND NOT EXISTS (SELECT 1 FROM inbox_bridge.summaries s WHERE s.org_id=r.org_id AND s.target_kind=r.target_kind AND s.target_id=r.target_id)),
              'missing_filters',(SELECT count(*) FROM inbox_maintained.rows r WHERE coalesce((r.summary->>'exists')::boolean,false) AND NOT EXISTS (SELECT 1 FROM inbox_bridge.filter_rows f WHERE f.org_id=r.org_id AND f.target_kind=r.target_kind AND f.target_id=r.target_id)),
              'orphan_summaries',(SELECT count(*) FROM inbox_bridge.summaries s WHERE NOT EXISTS (SELECT 1 FROM inbox_maintained.rows r WHERE r.org_id=s.org_id AND r.target_kind=s.target_kind AND r.target_id=s.target_id AND coalesce((r.summary->>'exists')::boolean,false))),
              'orphan_filters',(SELECT count(*) FROM inbox_bridge.filter_rows f WHERE NOT EXISTS (SELECT 1 FROM inbox_maintained.rows r WHERE r.org_id=f.org_id AND r.target_kind=f.target_kind AND r.target_id=f.target_id AND coalesce((r.summary->>'exists')::boolean,false)))
            )
            """
        )
    )
    if result["serving_enabled"] is not False or int(result["admission_enabled"]) != 0:
        raise RuntimeError("recovery unexpectedly enabled serving or command admission")
    for key in ("backfill_pending", "parent_pending", "safety_pending", "queue_pending", "collisions_pending", "duplicate_threads", "read_boundaries", "history_cursors", "unknown_cursors", "maintained_missing_dirty", "tombstone_summaries", "tombstone_filters", "live_targets_missing_maintained", "missing_summaries", "missing_filters", "orphan_summaries", "orphan_filters"):
        if int(result[key]) != 0:
            raise RuntimeError(f"reconciliation incomplete: {key}={result[key]}")
    return result


def mark_complete_without_serving(db: OwnedHttpDb) -> None:
    db.sql(
        """
        UPDATE inbox_control.rollout
        SET backfill_complete=true,reconciliation_complete=true,serving_enabled=false
        WHERE singleton;
        """,
        retry=True,
    )


def run(args: argparse.Namespace) -> dict[str, Any]:
    if not DATABASE_RE.fullmatch(args.database):
        raise SystemExit("invalid --database; use a simple database identifier")
    if args.batch_size < 1 or args.batch_size > 500:
        raise SystemExit("--batch-size must be between 1 and 500")
    if args.max_batches < 1 or args.max_batches > 100000:
        raise SystemExit("--max-batches must be between 1 and 100000")
    db = OwnedHttpDb(args.database)
    before = preflight(db)
    result: dict[str, Any] = {
        "database": args.database,
        "fixture_marker": MARKER,
        "mode": "apply" if args.apply else "dry-run",
        "plan": plan(db),
        "preflight": before,
        "external_cache_invalidation_required": True,
    }
    if not args.apply:
        return result

    apply_break(db)
    created = ensure_sender_groups(db, args.batch_size, args.max_batches)
    enqueue_unknown_targets(db)
    backfill_batches = drain_backfill(db, args.batch_size, args.max_batches)
    collision_batches = inspect_collisions(db, args.max_batches)
    parent_batches = drain_parent(db, args.batch_size, args.max_batches)
    safety_batches = drain_safety(db, args.batch_size, args.max_batches)
    prune_orphan_queue(db)
    maintained_batches = drain_maintained(db, args.batch_size, args.max_batches)
    remove_stale_derived(db)
    verified = verify_reconciled(db, before["protected_snapshot"])
    mark_complete_without_serving(db)
    result["created_sender_mappings"] = created
    result["batches"] = {"backfill": backfill_batches, "collisions": collision_batches, "parent": parent_batches, "safety": safety_batches, "maintained": maintained_batches}
    result["verified"] = verified
    return result


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", default=os.environ.get("INBOX_HTTP_RECOVERY_DATABASE", "postgres"))
    parser.add_argument("--batch-size", type=int, default=500)
    parser.add_argument("--max-batches", type=int, default=10000)
    parser.add_argument("--apply", action="store_true", help="mutate the explicitly guarded owned fixture")
    args = parser.parse_args(list(argv) if argv is not None else None)
    try:
        print(json.dumps(run(args), sort_keys=True, indent=2))
    except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError) as exc:
        print(f"RECOVERY_BLOCKED: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
