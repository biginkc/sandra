#!/usr/bin/env python3
"""Assemble the reviewed operation/reply SQL packet without a database.

The source checkout and commit are explicit inputs. The script reads files with
``git show`` so a dirty working tree or an unreviewed branch cannot silently
enter the release packet. It only writes generated SQL and a receipt under
``experiments/inbox-release``; it never starts a service or connects to a DB.
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
MANIFEST = HERE / "backend-operation-reply-manifest.json"
sys.path.insert(0, str(ROOT / "experiments" / "inbox-projection" / "fixture"))
from transaction_envelope import normalize

RELEASE_DATABASE = "sandra_inbox_release_20260917"
RELEASE_MARKER = "sandra-inbox-release-owned-synthetic"
SOURCE_COMMIT = "4850f8ceb6e993a9573639580dfe53cbfb86e5dd"  # coordinator integration exact snapshot

SQL_SOURCES = [
    ("operation_foundation", "experiments/inbox-operation-acceptance/setup.sql"),
    ("saved_actions_setup", "experiments/inbox-saved-actions/setup.sql"),
    ("saved_actions_public_api", "experiments/inbox-saved-actions/public-api.sql"),
    ("operation_domain_setup", "experiments/inbox-operation-domain/setup.sql"),
    ("operation_domain_scope", "experiments/inbox-operation-domain/restrictive-scope.sql"),
    ("operation_domain_effect", "experiments/inbox-operation-domain/restrictive-effect.sql"),
    ("operation_domain_apply", "experiments/inbox-operation-domain/restrictive-apply.sql"),
    ("operation_setup", "experiments/inbox-operation-preparation/setup.sql"),
    ("saved_actions_prepare_reference", "experiments/inbox-saved-actions/action-prepare-saved-reference.sql"),
    ("operation_worker", "experiments/inbox-operation-preparation/worker.sql"),
    ("operation_accept", "experiments/inbox-operation-preparation/accept.sql"),
    ("operation_public_api", "experiments/inbox-operation-preparation/public-api.sql"),
    ("operation_review_recovery", "experiments/inbox-operation-preparation/review.sql"),
    ("operation_worker_role", "experiments/inbox-operation-preparation/worker-role.sql"),
    ("reply_context", "experiments/inbox-reply-boundary/context.sql"),
    ("reply_recipient", "experiments/inbox-reply-preparation/recipient.sql"),
    ("reply_batch", "experiments/inbox-reply-preparation/batch.sql"),
    ("reply_review_setup", "experiments/inbox-reply-review/setup.sql"),
    ("reply_source_operation", "experiments/inbox-reply-review/source-operation.sql"),
    ("reply_review_public_api", "experiments/inbox-reply-review/public-api.sql"),
    ("reply_attempts", "experiments/inbox-reply-send/attempts.sql"),
    ("reply_accept_recovery", "experiments/inbox-reply-send/accept.sql"),
    ("reply_callback", "experiments/inbox-reply-send/callback.sql"),
    ("reply_public_api", "experiments/inbox-reply-send/public-api.sql"),
    ("reply_worker", "experiments/inbox-reply-send-worker/worker.sql"),
    ("reply_worker_role", "experiments/inbox-reply-send-worker/worker-role.sql"),
]

RUNTIME_SOURCES = [
    ("operation_worker_Dockerfile", "experiments/inbox-operation-worker/Dockerfile"),
    ("operation_worker_package", "experiments/inbox-operation-worker/package.json"),
    ("operation_worker_lock", "experiments/inbox-operation-worker/package-lock.json"),
    ("operation_worker_core", "experiments/inbox-operation-worker/core.mjs"),
    ("operation_worker_server", "experiments/inbox-operation-worker/server.mjs"),
    ("reply_worker_Dockerfile", "experiments/inbox-reply-send-worker/Dockerfile"),
    ("reply_worker_package", "experiments/inbox-reply-send-worker/package.json"),
    ("reply_worker_lock", "experiments/inbox-reply-send-worker/package-lock.json"),
    ("reply_worker_core", "experiments/inbox-reply-send-worker/core.mjs"),
    ("reply_worker_runner", "experiments/inbox-reply-send-worker/runner.mjs"),
    ("reply_worker_server", "experiments/inbox-reply-send-worker/server.mjs"),
    ("reply_provider_adapter", "experiments/inbox-reply-send-worker/vendor/reply-provider.mjs"),
    ("sync_relay_Dockerfile", "services/inbox-sync-relay/Dockerfile"),
    ("sync_relay_server", "services/inbox-sync-relay/server.mjs"),
    ("sync_relay_railway", "services/inbox-sync-relay/railway.json"),
]

GUARD = f"""DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'{RELEASE_DATABASE}' OR NOT EXISTS(SELECT 1 FROM install_fixture.identity WHERE marker='{RELEASE_MARKER}') THEN RAISE EXCEPTION 'Owned release fixture required';END IF;
END $$;"""


def git_show(repo: Path, commit: str, path: str) -> bytes:
    try:
        return subprocess.check_output(["git", "-C", str(repo), "show", f"{commit}:{path}"])
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"Pinned source missing at {commit}: {path}") from exc


def transform_sql(raw: str, path: str) -> tuple[str, int]:
    guards = [m for m in re.finditer(r"DO \$\$.*?END \$\$;", raw, re.S) if "inbox_t2_fixture.identity" in m.group()]
    if len(guards) > 1:
        raise RuntimeError(f"Multiple historical guards need review: {path}")
    if guards:
        g = guards[0]
        raw = raw[: g.start()] + GUARD + raw[g.end() :]
    transformed = raw.replace("inbox_t2_", "inbox_")
    body, removed = normalize(transformed)
    if removed not in (0, 2):
        raise RuntimeError(f"Unexpected transaction envelope ({removed}) in {path}")
    if "inbox_t2_" in body or "inbox_fixture.identity" in body:
        raise RuntimeError(f"Historical fixture reference remains in {path}")
    return body, removed


def remove_recovery_admission(sql: str) -> str:
    """Keep reply review admission on accept/claim, while recovery stays readable."""
    match = re.search(
        r"(CREATE FUNCTION inbox_reply_send\.recover\([^$]+?AS \$\$)(.*?)(\$\$;)",
        sql,
        re.S,
    )
    if not match:
        raise RuntimeError("Reply recovery function not found")
    body = match.group(2)
    body, count = re.subn(r"\n\s*PERFORM inbox_reply_review\.require_admission\(\);", "", body, count=1)
    if count != 1:
        raise RuntimeError("Reply recovery admission gate drifted")
    return sql[: match.start(2)] + body + sql[match.end(2) :]


ADMISSION_OVERLAY = """
-- Release overlay: session authority stays available for status/recovery while
-- new command families require server-derived actor/org admission.
CREATE OR REPLACE FUNCTION public.inbox_prepare_action(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_prepare');
 RETURN inbox_action_api.prepare_review(canonical_input,idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_accept_action(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_accept');
 RETURN inbox_action_api.accept(preparation_id,idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_capture_reply_recipients(conversation_ids uuid[]) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('reply_prepare');
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.capture(conversation_ids);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_freeze_reply_review(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('reply_prepare');
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.freeze(canonical_input,idempotency_key);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_reply_source_context(source_operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('reply_prepare');
 PERFORM inbox_reply_review.require_admission();
 RETURN inbox_reply_review.source_context(source_operation_id);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_accept_reply(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
DECLARE a jsonb;
BEGIN
 PERFORM inbox_control.admit_command('reply_accept');
 a:=inbox_action_api.authorize(NULL);
 RETURN inbox_reply_send.accept((a->>'org_id')::uuid,(a->>'user_id')::uuid,idempotency_key,preparation_id);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_create(name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_write');
 RETURN inbox_saved_actions.create_for_session(name,definition);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_update(id uuid,name text,definition jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_write');
 RETURN inbox_saved_actions.update_for_session(id,name,definition);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_deactivate(id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_write');
 RETURN inbox_saved_actions.deactivate_for_session(id);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_list() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_read');
 RETURN inbox_saved_actions.list_for_session();
END $$;
CREATE OR REPLACE FUNCTION public.inbox_saved_action_get(id uuid,version integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET lock_timeout='3s' SET statement_timeout='15s' AS $$
BEGIN
 PERFORM inbox_control.admit_command('action_saved_read');
 RETURN inbox_saved_actions.get_for_session(id,version);
END $$;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid),public.inbox_reply_source_context(uuid),public.inbox_accept_reply(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_capture_reply_recipients(uuid[]),public.inbox_freeze_reply_review(text,uuid),public.inbox_reply_source_context(uuid),public.inbox_accept_reply(uuid,uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_saved_action_create(text,jsonb),public.inbox_saved_action_update(uuid,text,jsonb),public.inbox_saved_action_deactivate(uuid),public.inbox_saved_action_list(),public.inbox_saved_action_get(uuid,integer) TO authenticated;
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-repo", type=Path, required=True)
    parser.add_argument("--commit", default=SOURCE_COMMIT)
    args = parser.parse_args()
    repo = args.source_repo.resolve()
    actual = subprocess.check_output(["git", "-C", str(repo), "rev-parse", f"{args.commit}^{{commit}}"], text=True).strip()
    if not actual.startswith(args.commit):
        raise RuntimeError(f"Cannot resolve exact source commit: {args.commit}")

    source_entries = []
    sql_parts = []
    for name, path in SQL_SOURCES:
        raw_bytes = git_show(repo, actual, path)
        raw = raw_bytes.decode()
        body, _ = transform_sql(raw, path)
        if name == "reply_accept_recovery":
            body = remove_recovery_admission(body)
        source_hash = hashlib.sha256(raw_bytes).hexdigest()
        transformed_hash = hashlib.sha256(body.encode()).hexdigest()
        source_entries.append({"name": name, "kind": "sql", "path": path, "sha256": source_hash, "bytes": len(raw_bytes), "transformed_sha256": transformed_hash})
        sql_parts.append(f"-- Pinned {name}: {path}\n-- source_sha256={source_hash}\n{body}\n")

    runtime_entries = []
    for name, path in RUNTIME_SOURCES:
        raw = git_show(repo, actual, path)
        entry = {"name": name, "kind": "runtime", "path": path, "sha256": hashlib.sha256(raw).hexdigest(), "bytes": len(raw)}
        runtime_entries.append(entry)

    packet = """-- GENERATED RELEASE OPERATION/REPLY PACKET. No production execution authorization.\n-- Target is the explicitly marked release database only.\nBEGIN;\nSET LOCAL lock_timeout='2s';\nSET LOCAL statement_timeout='30s';\n""" + "\n".join(sql_parts) + ADMISSION_OVERLAY + "\nCOMMIT;\n"
    packet_hash = hashlib.sha256(packet.encode()).hexdigest()
    out = HERE / "generated"
    out.mkdir(exist_ok=True)
    (out / "backend-operation-reply.sql").write_text(packet)

    manifest = {
        "schema_version": 2,
        "status": "PENDING_REVIEW_NO_INSTALL",
        "source_repository": str(repo),
        "source_commit": actual,
        "source_commit_role": "coordinator integration exact snapshot; read with git show; no branch import",
        "sql_packet": {"path": "experiments/inbox-release/generated/backend-operation-reply.sql", "sha256": packet_hash},
        "sql_sources": source_entries,
        "runtime_sources": runtime_entries,
        "install_order": [name for name, _ in SQL_SOURCES] + ["admission_overlay"],
        "compiler_transforms_required": [
            "replace historical inbox_t2_fixture guards with the marked release database identity",
            "replace inbox_t2_ namespaces with inbox_",
            "gate authenticated action prepare/accept, saved CRUD and reply prepare/accept wrappers with inbox_control.admit_command",
            "retain inbox_reply_review.require_admission as an additional reply gate",
            "remove the existing reply-review admission check from private reply recovery only so authenticated receipt recovery survives rollback",
            "leave action/reply status and recovery wrappers session-authorized and available with serving disabled",
        ],
        "required_proofs_before_install_receipt": [
            "operation/reply source and generated packet hashes match this manifest",
            "authenticated direct action/reply prepare/accept deny with INBOX_COMMAND_DISABLED after rollback",
            "authenticated action/reply status and recovery reads remain available after rollback",
            "reply admission remains independently closed unless explicitly enabled in a reviewed pilot",
            "worker roles and runtime images are built from these exact sources",
            "no customer sends or provider traffic",
        ],
        "runtime": {
            "operation_worker": "experiments/inbox-operation-worker",
            "reply_worker": "experiments/inbox-reply-send-worker",
            "sync_relay": "services/inbox-sync-relay",
            "projection": "services/inbox-projection-worker",
            "local_release_fixture_profile": "SOURCE_ONLY_READY_UNBUILT: operation/reply adapters accept only marked 127.0.0.1:54322/postgres with constrained worker logins; production TLS and historical aliases remain unchanged",
            "provider_traffic": False,
            "customer_sends": False,
        },
        "safety": {"release_db": RELEASE_DATABASE, "release_marker": RELEASE_MARKER, "production_install": False, "provider_traffic": False, "customer_sends": False},
    }
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"status": manifest["status"], "source_commit": actual, "sql_sources": len(source_entries), "runtime_sources": len(runtime_entries), "packet_sha256": packet_hash}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
