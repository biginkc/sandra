#!/usr/bin/env python3
"""Mutation-first proof for the Sandra Inbox MARKERS follow-up.

Every case uses a fresh local-env fixture.  The Drips migrations absent from
this branch are loaded from origin/main into that disposable fixture only.
The same assertions run for the baseline and every natural source mutation;
there is no mutation-specific assertion path.
"""

from __future__ import annotations

import hashlib
import json
import os
import difflib
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
LOCAL_ENV = ROOT / "experiments/inbox-reply-send/local-env.py"
MIGRATION = ROOT / "supabase/migrations/20260930040260_inbox_drip_markers.sql"
GOLDEN = ROOT / "experiments/inbox-drip-markers/golden-fixture.json"
LOG = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/dripmarkers-mutation-run-r5.log")
EVIDENCE = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/dripmarkers-evidence-r5.md")
STATE = Path("/tmp/sandra-reply-persist-local-env.json")
PSQL = "/opt/homebrew/bin/psql"

ORG = "10000000-0000-4000-8000-000000000001"
OTHER_ORG = "10000000-0000-4000-8000-000000000099"
USER = "20000000-0000-4000-8000-000000000002"
SESSION = "30000000-0000-4000-8000-000000000003"
FROZEN = {
    "20260930040000_inbox_control_foundation.sql": "a31799ba96e6f7264f062019cc8113a6401719a686cc31e569b10d21064bfbf6",
    "20260930040100_inbox_read_companion.sql": "7a2c5f49fc8fcf58c7f37585c3c347869816912e47e504ec47f9cdac198d3dd7",
    "20260930040200_inbox_backend_operation_reply.sql": "2a4b49d43e67963805d547221d04c84c3f7823f430fd9c0cc9b3f22b36844aad",
    "20260930040250_inbox_reply_message_projection.sql": "2a097587ad59aa913a386ce59b513fcbac8452b0b770477bde16533cb2672112",
}
ORIGIN_MIGRATIONS = [
    "supabase/migrations/20260930035000_drip_reply_failed_send_keeps_flag.sql",
    "supabase/migrations/20260930036000_dialpad_training_projection.sql",
    "supabase/migrations/20260930037000_dialpad_training_playback.sql",
    "supabase/migrations/20260930038000_sequence_canary_controls.sql",
]

golden: dict[str, Any] = json.loads(GOLDEN.read_text(encoding="utf-8"))
evidence: list[dict[str, str]] = []
mutation_results: list[dict[str, str]] = []
vitest_mutation_results: list[dict[str, str]] = []
function_diff_rows: list[dict[str, str]] = []
log_lines: list[str] = []


def emit(line: str) -> None:
    print(line, flush=True)
    log_lines.append(line)


def markdown_cell(value: str) -> str:
    return value.replace("|", "\\|")


def verify_frozen_hashes() -> None:
    for name, expected in FROZEN.items():
        actual = hashlib.sha256((ROOT / "supabase/migrations" / name).read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f"frozen hash mismatch {name}: {actual} != {expected}")
    emit("FROZEN_HASHES_OK 040000 040100 040200 040250")


def function_source(path: Path, marker: str) -> str:
    source = path.read_text(encoding="utf-8")
    start = source.index(marker)
    end = source.index("$$;", start) + 3
    return source[start:end]


def normalized_function_source(source: str) -> str:
    return re.sub(r"^CREATE(?: OR REPLACE)? FUNCTION", "CREATE FUNCTION", source, count=1)


def verify_marker_function_diffs() -> None:
    comparisons = [
        (
            "matching",
            ROOT / "supabase/migrations/20260930040000_inbox_control_foundation.sql",
            "CREATE FUNCTION inbox_bridge.matching(",
            MIGRATION,
            "CREATE OR REPLACE FUNCTION inbox_bridge.matching(",
        ),
        (
            "review_selection",
            ROOT / "supabase/migrations/20260930040100_inbox_read_companion.sql",
            "CREATE OR REPLACE FUNCTION inbox_read.review_selection(",
            MIGRATION,
            "CREATE OR REPLACE FUNCTION inbox_read.review_selection(",
        ),
    ]
    for name, frozen_path, frozen_marker, current_path, current_marker in comparisons:
        frozen = normalized_function_source(function_source(frozen_path, frozen_marker)).splitlines()
        current = normalized_function_source(function_source(current_path, current_marker)).splitlines()
        diff = list(difflib.unified_diff(frozen, current, fromfile=f"frozen:{name}", tofile=f"040260:{name}", lineterm=""))
        changes = [line for line in diff if line and not line.startswith(("---", "+++", "@@")) and line[0] in "+-"]
        if any("MATERIALIZED" in line or "ERRCODE" in line for line in changes):
            raise RuntimeError(f"{name} diff changed MATERIALIZED or ERRCODE")
        for line in changes:
            if name == "matching":
                classification = "marker join plumbing (§2)" if "flagged" in line or "candidates" in line or "drip_flags" in line else "marker branch (§2)"
                allowed = any(token in line for token in ("flagged", "candidates", "drip_flags", "in_drip", "drip_replied"))
            else:
                classification = "marker join plumbing (§2)" if "flagged" in line or "candidates" in line or "drip_flags" in line else "marker branch (§2)"
                allowed = any(token in line for token in ("flagged", "candidates", "drip_flags", "in_drip", "drip_replied"))
            if not allowed:
                raise RuntimeError(f"{name} has an unclassified diff line: {line}")
            function_diff_rows.append({"function": name, "line": line, "classification": classification})
            emit(f"FUNCTION_DIFF|{name}|{classification}|{line}")
        emit(f"FUNCTION_DIFF_OK|{name}|changed_lines={len(changes)}|no_materialized=true|no_errcode_change=true")


def verify_counts_typed_frozen() -> None:
    installed = query("SELECT pg_get_functiondef('inbox_bridge.counts_typed(uuid,uuid,jsonb)'::regprocedure);")
    frozen_source = function_source(
        ROOT / "supabase/migrations/20260930040000_inbox_control_foundation.sql",
        "CREATE FUNCTION inbox_bridge.counts_typed(",
    )
    psql(frozen_source.replace("CREATE FUNCTION inbox_bridge.counts_typed(", "CREATE OR REPLACE FUNCTION inbox_bridge.counts_typed(", 1))
    absent_040260 = query("SELECT pg_get_functiondef('inbox_bridge.counts_typed(uuid,uuid,jsonb)'::regprocedure);")
    if installed != absent_040260:
        details = "\n".join(difflib.unified_diff(installed.splitlines(), absent_040260.splitlines(), fromfile="after-all-migrations", tofile="040260-absent", lineterm=""))
        raise RuntimeError(f"counts_typed frozen equality failed:\n{details}")
    emit("COUNTS_TYPED_FROZEN_EQUAL|pg_get_functiondef=byte-identical|040260_absent=true")


def run(args: list[str], *, input_text: str | None = None, check: bool = True, timeout: int = 240) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        args,
        cwd=ROOT,
        input=input_text,
        text=True,
        capture_output=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        timeout=timeout,
    )
    if check and result.returncode:
        detail = (result.stderr + result.stdout).strip()
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(args)}\n{detail[-5000:]}")
    return result


FOCUSED_VITEST_MUTATIONS = [
    {
        "name": "real-loader-golden-header-pill",
        "path": ROOT / "src/lib/inbox/drip-context.ts",
        "needle": 'return drip?.replied ? "Replied to drip" : null;',
        "replacement": 'return drip?.replied ? "Reply to drip" : null;',
        "test_file": "src/lib/inbox/drip-context.test.ts",
        "test_name": "produces the golden header/pill and exact history wording from real loader inputs",
    },
    {
        "name": "app-counts-route-drip-branch",
        "path": ROOT / "src/app/api/inbox/counts/route.ts",
        "needle": 'view === "in_drip"',
        "replacement": 'view === "never_in_drip"',
        "test_file": "src/app/api/inbox/counts/route.test.ts",
        "test_name": "uses only the drip counts RPC for drip views",
    },
    {
        "name": "non-drip-counts-nine-key-contract",
        "path": ROOT / "src/lib/inbox/filter-contract.ts",
        "needle": 'export const inboxCountNames = ["all", "mine", "unassigned", "unread", "escalated", "dispo", "needs_outcome", "unknown", "dismissed"] as const;',
        "replacement": 'export const inboxCountNames = ["all", "mine", "unassigned", "unread", "escalated", "dispo", "needs_outcome", "missing", "dismissed"] as const;',
        "test_file": "src/app/api/inbox/counts/route.test.ts",
        "test_name": "parses the real nine-key non-drip counts response",
    },
    {
        "name": "detail-route-maintained-property",
        "path": ROOT / "src/app/api/inbox/conversations/[conversationId]/detail/route.ts",
        "needle": "marker?.propertyId",
        "replacement": "data.propertyId",
        "test_file": "src/app/api/inbox/conversations/[conversationId]/detail/route.test.ts",
        "test_name": "reads detail for an allowed member",
    },
    {
        "name": "stale-response-fencing",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "token !== markerGeneration.current",
        "replacement": "false",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "fences an older marker response after a newer snapshot publishes",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "post-reply-disposition-refresh",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "onCompleted: () => { void refreshAfterAction(); }",
        "replacement": "onCompleted: () => {}",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "T2 uses the same re-walk after a workspace reply/disposition and rereads the open detail",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "legacy-header-maintained-property",
        "path": ROOT / "src/app/(dashboard)/messages/inbox-detail-data.ts",
        "needle": "const dripContext = await loadMessageDripContext(supabase, conversationOrgId, propertyId, messages);",
        "replacement": "const maintainedPropertyId = [...messages].reverse().find((message) => message.property_id !== null)?.property_id ?? null;\n  const dripContext = await loadMessageDripContext(supabase, conversationOrgId, maintainedPropertyId, messages);",
        "test_file": "src/app/(dashboard)/messages/inbox-detail-data.test.ts",
        "test_name": "pins the legacy Messages header to the review-first property choice",
    },
    {
        "name": "M1-reuse-revoked-cursor",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "let cursor: string | null = null;",
        "replacement": "let cursor: string | null = scope.current?.nextCursor ?? null;",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "T1 re-derives the displayed page with fresh cursors and keeps page two visible",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "M2-publish-stale-generation",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "const currentWalk = () => generation === walkGeneration.current;",
        "replacement": "const currentWalk = () => true;",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "T5 fences a stale walk generation when the displayed page changes mid-walk",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "M3-remove-rate-retry",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "if (statusOf(failure) !== 429 || attempt === WORKSET_RETRY_LIMIT - 1) throw failure;",
        "replacement": "if (true) throw failure;",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "T3 paces workset creation and retries a 429 with identical inputs",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "M4-always-restart-at-page-one",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "cursor = value.nextCursor;",
        "replacement": "cursor = null;",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "T1 re-derives the displayed page with fresh cursors and keeps page two visible",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "M5-stale-live-scope-anchor",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "liveScopeId.current = value.scopeId; // walk step anchor",
        "replacement": "// live scope intentionally not advanced",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "T6 surfaces a partial-walk error and recovers from the step-one live scope",
        "config": "vitest.rtl.config.ts",
    },
    {
        "name": "M6-abort-coalesced-walk",
        "path": ROOT / "src/components/inbox-workspace/workspace-client.tsx",
        "needle": "      walkGeneration.current++;\n      return reconciliationPromise.current;",
        "replacement": "      walkGeneration.current++;\n      reconciliationRequest.current?.abort();\n      return reconciliationPromise.current;",
        "test_file": "src/components/inbox-workspace/workspace-client.drip-markers.test.tsx",
        "test_name": "keeps the scope created by a deferred walk step and lets a following filter load succeed",
        "config": "vitest.rtl.config.ts",
    },
]


def focused_vitest(case: dict[str, str]) -> subprocess.CompletedProcess[str]:
    args = ["npx", "vitest", "run"]
    if case.get("config"):
        args.extend(["--config", case["config"]])
    args.extend([case["test_file"], "-t", case["test_name"], "--reporter=dot"])
    return run(args, check=False, timeout=240)


def run_focused_vitest_mutations() -> None:
    for case in FOCUSED_VITEST_MUTATIONS:
        baseline = focused_vitest(case)
        baseline_output = (baseline.stdout + baseline.stderr).strip()
        emit(f"VITEST_BASELINE|{case['name']}|exit={baseline.returncode}")
        if baseline.returncode:
            emit(f"VITEST_BASELINE_OUTPUT|{case['name']}|{baseline_output[-1600:]}")
            raise RuntimeError(f"focused vitest baseline failed: {case['name']}")
        evidence.append({"run": "vitest:baseline", "test": case["name"], "Executed": "yes", "result": "PASS"})
        path = Path(case["path"])
        original = path.read_bytes()
        source = original.decode("utf-8")
        if source.count(case["needle"]) != 1:
            raise RuntimeError(f"focused mutation needle count {case['name']}={source.count(case['needle'])}")
        path.write_text(source.replace(case["needle"], case["replacement"], 1), encoding="utf-8")
        try:
            mutated = focused_vitest(case)
            mutated_output = (mutated.stdout + mutated.stderr).strip()
            emit(f"VITEST_MUTANT|{case['name']}|exit={mutated.returncode}")
            if mutated.returncode == 0:
                raise RuntimeError(f"focused mutation survived: {case['name']}")
            excerpt = mutated_output[-1200:].replace("\n", " ")
            emit(f"VITEST_MUTANT_FAILURE|{case['name']}|{excerpt}")
            evidence.append({"run": "vitest:mutant", "test": case["name"], "Executed": "yes", "result": "FAIL (expected natural mutation)"})
            vitest_mutation_results.append({"mutation": case["name"], "Executed": "yes", "failure": excerpt})
        finally:
            path.write_bytes(original)


def state() -> dict[str, Any]:
    return json.loads(STATE.read_text(encoding="utf-8"))


def psql(statement: str, *, role: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    s = state()
    prefix = ""
    if role in {"authenticated", "authenticated_bypass_rls"}:
        claims = json.dumps({"sub": USER, "role": "authenticated", "session_id": SESSION, "exp": 4102444800}, separators=(",", ":"))
        set_role = "SET ROLE authenticated; " if role == "authenticated" else ""
        prefix = f"{set_role}SET request.jwt.claim.sub='{USER}'; SET request.jwt.claim.role='authenticated'; SET request.jwt.claims='{claims}';\n"
    return run([
        PSQL, "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", str(s["socket"]), "-p", str(s["port"]),
        "-U", "postgres", "-d", "postgres",
    ], input_text=prefix + statement, check=check)


def psql_process(statement: str, *, role: str | None = None) -> subprocess.Popen[str]:
    s = state()
    prefix = ""
    if role in {"authenticated", "authenticated_bypass_rls"}:
        claims = json.dumps({"sub": USER, "role": "authenticated", "session_id": SESSION, "exp": 4102444800}, separators=(",", ":"))
        set_role = "SET ROLE authenticated; " if role == "authenticated" else ""
        prefix = f"{set_role}SET request.jwt.claim.sub='{USER}'; SET request.jwt.claim.role='authenticated'; SET request.jwt.claims='{claims}';\n"
    process = subprocess.Popen([
        PSQL, "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", str(s["socket"]), "-p", str(s["port"]),
        "-U", "postgres", "-d", "postgres",
    ], cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
       env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    assert process.stdin is not None
    process.stdin.write(prefix + statement)
    process.stdin.close()
    return process


def query(statement: str, *, role: str | None = None) -> str:
    result = psql(statement, role=role)
    return result.stdout.strip()


def json_query(statement: str, *, role: str | None = None) -> Any:
    output = query(statement, role=role)
    if not output:
        raise AssertionError("empty SQL result")
    return json.loads(output.splitlines()[-1])


def down() -> None:
    run(["python3", str(LOCAL_ENV), "down"], check=False, timeout=60)


def up() -> None:
    run(["python3", str(LOCAL_ENV), "up"], timeout=240)
    verify_counts_typed_frozen()
    for path in ORIGIN_MIGRATIONS:
        source = run(["git", "show", f"origin/main:{path}"], timeout=60).stdout
        psql(source)
        emit(f"ORIGIN_FIXTURE_OK {path}")


def seed() -> None:
    psql(r"""
BEGIN;
INSERT INTO inbox_control.rollout(singleton,schema_version,serving_enabled,backfill_complete,reconciliation_complete)
VALUES(true,1,true,true,true)
ON CONFLICT(singleton) DO UPDATE SET serving_enabled=true,backfill_complete=true,reconciliation_complete=true;
INSERT INTO public.organizations(id,name) VALUES
 ('10000000-0000-4000-8000-000000000001','Drip Fixture'),('10000000-0000-4000-8000-000000000099','Other Fixture')
ON CONFLICT(id) DO NOTHING;
INSERT INTO auth.users(id,email) VALUES ('20000000-0000-4000-8000-000000000002','drip-owner@example.test') ON CONFLICT(id) DO NOTHING;
INSERT INTO auth.sessions(id,user_id,not_after) VALUES ('30000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','2099-01-01') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.memberships(id,user_id,org_id,role,access_status,acquisitions_enabled)
VALUES ('31000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','owner','active',false)
ON CONFLICT(id) DO NOTHING;
INSERT INTO inbox_bridge.access_epochs(user_id,revision) VALUES ('20000000-0000-4000-8000-000000000002',1) ON CONFLICT(user_id) DO NOTHING;
INSERT INTO public.contacts(id,org_id,contact_type,first_name,last_name) VALUES ('50000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','person','Drip','Tester') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.properties(id,org_id,address,state,status) SELECT x.id::uuid,'10000000-0000-4000-8000-000000000001',x.address,'TX','new_lead' FROM (VALUES
 ('40000000-0000-4000-8000-000000000001','1 Active Way'),('40000000-0000-4000-8000-000000000002','2 Reply Lane'),
 ('40000000-0000-4000-8000-000000000003','3 Failed Lane'),('40000000-0000-4000-8000-000000000004','4 Empty Street'),
 ('40000000-0000-4000-8000-000000000005','5 Completed Lane'),('40000000-0000-4000-8000-000000000007','7 Archived Lane'),
 ('40000000-0000-4000-8000-000000000009','9 Sibling Lane'),('40000000-0000-4000-8000-000000000010','10 Review Lane'),
 ('40000000-0000-4000-8000-000000000011','11 Manual Pause Lane'),('40000000-0000-4000-8000-000000000099','99 Other Lane')) x(id,address) ON CONFLICT(id) DO NOTHING;
INSERT INTO public.campaigns(id,org_id,name,created_by) VALUES
 ('90000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Fixture Campaign','20000000-0000-4000-8000-000000000002')
ON CONFLICT(id) DO NOTHING;
INSERT INTO public.sequences(id,org_id,name,created_by,archived_at) VALUES
 ('60000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Fixture Drip','20000000-0000-4000-8000-000000000002',NULL),
 ('60000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','Archived Fixture Drip','20000000-0000-4000-8000-000000000002','2026-08-01') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.sequence_steps(id,sequence_id,step_index,action_type,template_body) SELECT ('61000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'60000000-0000-4000-8000-000000000001',n-1,'send_sms','Fixture text '||n FROM generate_series(1,3) n ON CONFLICT(id) DO NOTHING;
INSERT INTO public.sequence_steps(id,sequence_id,step_index,action_type,template_body) VALUES ('61000000-0000-4000-8000-000000000007','60000000-0000-4000-8000-000000000007',0,'send_sms','Archived text') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.sequence_enrollments(id,org_id,sequence_id,property_id,status,current_step_index,enrolled_at,pause_reason) VALUES
 ('62000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001','active',1,'2026-08-20 10:00+00',NULL),
 ('62000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','paused',0,'2026-08-21 10:00+00','inbound_reply'),
 ('62000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000003','paused',0,'2026-08-22 10:00+00','rep_sms_human_takeover'),
 ('62000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000005','completed',0,'2026-08-23 10:00+00',NULL),
 ('62000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000007','40000000-0000-4000-8000-000000000007','active',0,'2026-08-24 10:00+00',NULL),
 ('62000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000011','paused',0,'2026-08-25 10:00+00','manual')
ON CONFLICT(id) DO NOTHING;
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id) VALUES
 ('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','2026-09-01 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000001','+15550000099','+15550000001','Active drip text','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001','2026-09-01 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000099','+15550000001','Reply drip text','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','2026-09-02 10:00+00','sms','inbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000001','+15550000099','Customer replied','received','{}',NULL),
 ('70000000-0000-4000-8000-000000000012','10000000-0000-4000-8000-000000000001','2026-09-02 10:00+00','sms','inbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000001','+15550000099','Customer follow-up','received','{}',NULL),
 ('70000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','2026-09-01 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000003','+15550000099','+15550000001','Failed drip text','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','2026-09-02 10:00+00','sms','inbound','40000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000003','+15550000001','+15550000099','Customer replied failed lane','received','{}',NULL),
 ('70000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','2026-09-03 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000003','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000003','+15550000099','+15550000001','Provider failed follow-up','failed','{}',NULL),
 ('70000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','2026-09-01 09:00+00','sms','outbound','40000000-0000-4000-8000-000000000004','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000004','+15550000099','+15550000001','No drip','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000008','10000000-0000-4000-8000-000000000001','2026-09-01 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000005','+15550000099','+15550000001','Completed drip','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000009','10000000-0000-4000-8000-000000000001','2026-09-02 10:00+00','email','inbound','40000000-0000-4000-8000-000000000005','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000005','owner@example.test','drip@example.test','Email reply','received','{}',NULL),
 ('70000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','2026-09-01 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000007','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000007','+15550000099','+15550000001','Archived drip','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000011','10000000-0000-4000-8000-000000000001','2026-09-01 09:00+00','sms','inbound',NULL,'50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000008','+15550000001','+15550000099','No property','received','{}',NULL),
 ('70000000-0000-4000-8000-000000000013','10000000-0000-4000-8000-000000000001','2026-01-01 09:00+00','sms','outbound','40000000-0000-4000-8000-000000000009','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000009','+15550000099','+15550000001','Sibling property conversation','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000014','10000000-0000-4000-8000-000000000001','2026-01-01 09:00+00','sms','inbound','40000000-0000-4000-8000-000000000010','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000010','+15550000001','+15550000099','Review property differs from newest message','received','{}',NULL),
 ('70000000-0000-4000-8000-000000000015','10000000-0000-4000-8000-000000000001','2026-01-01 09:00+00','sms','outbound','40000000-0000-4000-8000-000000000011','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000011','+15550000099','+15550000001','Manual pause drip text','sent','{}',NULL),
 ('70000000-0000-4000-8000-000000000099','10000000-0000-4000-8000-000000000099','2026-09-01 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000099',NULL,'80000000-0000-4000-8000-000000000001','+15550000099','+15550000001','Foreign collision','sent','{}',NULL)
ON CONFLICT(id) DO NOTHING;
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id)
SELECT gen_random_uuid(),'10000000-0000-4000-8000-000000000001','2026-09-01 12:00+00'::timestamptz + make_interval(secs => n),'sms','outbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000099','+15550000001','AI skipped '||n,'sent','{"generated_by":"ai_responder_v1"}',NULL FROM generate_series(1,201) n;
INSERT INTO public.sequence_step_runs(id,enrollment_id,step_id,message_id,scheduled_for,run_at) VALUES
 ('63000000-0000-4000-8000-000000000001','62000000-0000-4000-8000-000000000001','61000000-0000-4000-8000-000000000002','70000000-0000-4000-8000-000000000001','2026-09-01 09:59+00','2026-09-01 10:00+00'),
 ('63000000-0000-4000-8000-000000000002','62000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002','2026-09-01 09:59+00','2026-09-01 10:00+00'),
 ('63000000-0000-4000-8000-000000000003','62000000-0000-4000-8000-000000000003','61000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000004','2026-09-01 09:59+00','2026-09-01 10:00+00'),
 ('63000000-0000-4000-8000-000000000005','62000000-0000-4000-8000-000000000005','61000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000008','2026-09-01 09:59+00','2026-09-01 10:00+00'),
 ('63000000-0000-4000-8000-000000000007','62000000-0000-4000-8000-000000000007','61000000-0000-4000-8000-000000000007','70000000-0000-4000-8000-000000000010','2026-09-01 09:59+00','2026-09-01 10:00+00'),
 ('63000000-0000-4000-8000-000000000011','62000000-0000-4000-8000-000000000011','61000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000015','2026-01-01 08:59+00','2026-01-01 09:00+00') ON CONFLICT(id) DO NOTHING;
INSERT INTO public.ai_disposition_reviews(id,org_id,property_id,conversation_id,source_inbound_message_id,disposition,ai_reason)
VALUES ('91000000-0000-4000-8000-000000000010','10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002','80000000-0000-4000-8000-000000000010','70000000-0000-4000-8000-000000000014','not_interested','fixture review property')
ON CONFLICT(id) DO NOTHING;
INSERT INTO inbox_maintained.rows(org_id,target_kind,target_id,revision,source_generation,summary)
SELECT v.org_id,'known_conversation',v.id,1,1,jsonb_build_object('target_kind','known_conversation','target_id',v.id,'exists',true,'property_id',v.property_id,'last_message_at',v.latest_at,'has_recent',true,'is_noise',false,'contact_id','50000000-0000-4000-8000-000000000001','property_status','new_lead','assigned_user_id',NULL,'unread_count',1,'ai_responder_status',NULL,'needs_outcome',false,'ai_disposition_review_id',NULL,'is_test_traffic',false)
FROM (VALUES
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000001'::uuid,'40000000-0000-4000-8000-000000000001'::uuid,'2026-09-01 10:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,'40000000-0000-4000-8000-000000000002'::uuid,'2026-09-02 10:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000003'::uuid,'40000000-0000-4000-8000-000000000003'::uuid,'2026-09-03 10:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000004'::uuid,'40000000-0000-4000-8000-000000000004'::uuid,'2026-09-01 09:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000005'::uuid,'40000000-0000-4000-8000-000000000005'::uuid,'2026-09-02 10:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000007'::uuid,'40000000-0000-4000-8000-000000000007'::uuid,'2026-09-01 10:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000008'::uuid,NULL,'2026-09-01 09:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000009'::uuid,'40000000-0000-4000-8000-000000000002'::uuid,'2026-01-01 09:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000010'::uuid,'40000000-0000-4000-8000-000000000004'::uuid,'2026-01-01 09:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000001'::uuid,'80000000-0000-4000-8000-000000000011'::uuid,'40000000-0000-4000-8000-000000000011'::uuid,'2026-01-01 09:00+00'::timestamptz),
 ('10000000-0000-4000-8000-000000000099'::uuid,'80000000-0000-4000-8000-000000000001'::uuid,'40000000-0000-4000-8000-000000000099'::uuid,'2026-09-01 10:00+00'::timestamptz)
) v(org_id,id,property_id,latest_at) ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET summary=excluded.summary,revision=excluded.revision;
UPDATE inbox_maintained.rows SET summary=summary||jsonb_build_object('has_recent',false)
WHERE target_kind='known_conversation' AND target_id IN ('80000000-0000-4000-8000-000000000009','80000000-0000-4000-8000-000000000010','80000000-0000-4000-8000-000000000011');
INSERT INTO inbox_bridge.filter_rows(org_id,target_kind,target_id,revision,latest_at,contact_id,has_recent,is_noise,assignable,assigned_user_id,unread,escalated,needs_outcome,review,unknown_active,unknown_dismissed)
SELECT r.org_id,'known_conversation',r.target_id,1,(r.summary->>'last_message_at')::timestamptz,(r.summary->>'contact_id')::uuid,coalesce((r.summary->>'has_recent')::boolean,false),coalesce((r.summary->>'is_noise')::boolean,false),true,NULL,true,false,false,coalesce((r.summary->>'ai_disposition_review_id') IS NOT NULL,false),false,false FROM inbox_maintained.rows r WHERE r.target_kind='known_conversation'
ON CONFLICT(org_id,target_kind,target_id) DO UPDATE SET latest_at=excluded.latest_at,revision=excluded.revision;
UPDATE inbox_bridge.filter_rows SET has_recent=false
WHERE target_id IN ('80000000-0000-4000-8000-000000000009','80000000-0000-4000-8000-000000000010','80000000-0000-4000-8000-000000000011');
COMMIT;
""")


def reset_fixture() -> None:
    down()
    up()
    seed()


def marker_json() -> dict[str, Any]:
    ids = list(golden["markerRows"])
    literal = ",".join(f"'{value}'::uuid" for value in ids)
    return json_query(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid, ARRAY[{literal}]);", role="authenticated")


def marker_for(conversation_id: str) -> dict[str, Any]:
    return json_query(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid, ARRAY['{conversation_id}'::uuid]);", role="authenticated")["rows"][0]


def reset_workset_fixture() -> None:
    psql("""
UPDATE public.sequence_enrollments SET status='active',pause_reason=NULL,completed_at=NULL
WHERE id='62000000-0000-4000-8000-000000000001';
UPDATE public.sequence_enrollments SET status='completed',pause_reason=NULL,completed_at='2026-09-03 00:00+00'
WHERE id='62000000-0000-4000-8000-000000000005';
UPDATE inbox_bridge.filter_rows SET latest_at=CASE target_id
 WHEN '80000000-0000-4000-8000-000000000001' THEN '2026-09-01 10:00+00'::timestamptz
 WHEN '80000000-0000-4000-8000-000000000005' THEN '2026-09-02 10:00+00'::timestamptz
 ELSE latest_at END;
DELETE FROM inbox_bridge.cursors;
DELETE FROM inbox_bridge.worksets;
""")


def permit_next_workset() -> None:
    psql("UPDATE inbox_bridge.worksets SET created_at=clock_timestamp()-interval '2 seconds';")


def workset(view: str, limit: int, *, cursor: str | None = None, replaces: str | None = None) -> dict[str, Any]:
    cursor_sql = "NULL" if cursor is None else f"'{cursor}'::uuid"
    replaces_sql = "NULL" if replaces is None else f"'{replaces}'::uuid"
    return json_query(f"SELECT public.inbox_create_workset_v2('{ORG}'::uuid,'{{\"view\":\"{view}\",\"hide_noise\":false}}'::jsonb,{limit},{replaces_sql},{cursor_sql});", role="authenticated")


def expect_error(statement: str, message: str, *, role: str = "authenticated") -> None:
    result = psql(statement, role=role, check=False)
    combined = result.stdout + result.stderr
    if result.returncode == 0 or message not in combined:
        raise AssertionError(f"expected {message!r}, got rc={result.returncode}: {combined[-1000:]}")


def test_golden_marker_and_oracle() -> None:
    value = marker_json()
    if value["org_id"] != ORG or not value.get("as_of"):
        raise AssertionError("marker envelope is not tenant/as-of qualified")
    observed = {row["conversation_id"]: {key: row.get(key) for key in ("property_id", "in_drip", "drip_replied", "drip_name")} for row in value["rows"]}
    if observed != golden["markerRows"]:
        raise AssertionError(f"golden marker mismatch: {json.dumps(observed, sort_keys=True)}")
    # 2026-09-30 as-of minus the ruling's 2160-hour recent window.
    oracle = json_query(f"SELECT public.sms_inbox_thread_page_snapshot('2026-06-30 00:00+00'::timestamptz,'all',NULL,NULL,false,200,0,NULL);", role="authenticated")
    oracle_rows = {row.get("thread_id"): row for row in oracle.get("rows", []) if row.get("thread_id") in golden["markerRows"]}
    for conversation_id, expected in golden["markerRows"].items():
        row = oracle_rows.get(conversation_id)
        if row is None:
            raise AssertionError(f"legacy oracle omitted {conversation_id}")
        for key in ("property_id", "in_drip", "drip_replied", "drip_name"):
            if row.get(key) != expected[key]:
                raise AssertionError(f"oracle parity {conversation_id}/{key}: {row.get(key)!r} != {expected[key]!r}")
    for view, expected_ids in {
        "in_drip": {conversation_id for conversation_id, row in golden["markerRows"].items() if row["in_drip"]},
        "drip_replied": {conversation_id for conversation_id, row in golden["markerRows"].items() if row["drip_replied"]},
    }.items():
        filtered_oracle = json_query(f"SELECT public.sms_inbox_thread_page_snapshot('2026-06-30 00:00+00'::timestamptz,'{view}',NULL,NULL,false,200,0,NULL);", role="authenticated")
        oracle_ids = {row["thread_id"] for row in filtered_oracle["rows"]}
        if oracle_ids != expected_ids:
            raise AssertionError(f"legacy {view} membership mismatch: {oracle_ids}")
        page_ids = json_query(f"SELECT coalesce(jsonb_agg(target_id ORDER BY latest_at DESC NULLS LAST,target_kind,target_id),'[]'::jsonb) FROM inbox_bridge.page('{ORG}'::uuid,NULL,'{{\"view\":\"{view}\",\"hide_noise\":false,\"search\":null}}'::jsonb,NULL,NULL,NULL,false,500);")
        if set(page_ids) != expected_ids:
            raise AssertionError(f"new {view} membership mismatch: {set(page_ids)}")
    searched = json_query(f"SELECT public.inbox_drip_counts_v1('{ORG}'::uuid,'{{\"view\":\"in_drip\",\"hide_noise\":false,\"search\":\"Active\"}}'::jsonb);", role="authenticated")
    if searched["counts"]["in_drip"] != 1:
        raise AssertionError(f"search changed drip membership: {searched}")
    psql("UPDATE inbox_bridge.filter_rows SET is_noise=true WHERE org_id='" + ORG + "' AND target_id='80000000-0000-4000-8000-000000000001';")
    hidden = json_query(f"SELECT public.inbox_drip_counts_v1('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":true}}'::jsonb);", role="authenticated")
    shown = json_query(f"SELECT public.inbox_drip_counts_v1('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":false}}'::jsonb);", role="authenticated")
    psql("UPDATE inbox_bridge.filter_rows SET is_noise=false WHERE org_id='" + ORG + "' AND target_id='80000000-0000-4000-8000-000000000001';")
    if hidden["counts"]["in_drip"] != 3 or shown["counts"]["in_drip"] != 4:
        raise AssertionError(f"noise visibility mismatch: hidden={hidden} shown={shown}")
    context = json_query(f"""
SELECT jsonb_build_object(
 '80000000-0000-4000-8000-000000000001',jsonb_build_object('header','In '||seq.name||' · text '||(enrollment.current_step_index+1)||' of '||(SELECT count(*) FROM public.sequence_steps step WHERE step.sequence_id=enrollment.sequence_id),'pill',NULL),
 '80000000-0000-4000-8000-000000000002',jsonb_build_object('header','Was in '||seq.name||' · stopped '||to_char((SELECT max(created_at) FROM public.messages reply WHERE reply.property_id=enrollment2.property_id AND reply.direction='inbound'),'Mon FMDD')||' when they replied','pill','Replied to drip'))
FROM public.sequence_enrollments enrollment
JOIN public.sequences seq ON seq.id=enrollment.sequence_id
JOIN public.sequence_enrollments enrollment2 ON enrollment2.id='62000000-0000-4000-8000-000000000002'
WHERE enrollment.id='62000000-0000-4000-8000-000000000001';
""")
    if context != golden["threadContext"]:
        raise AssertionError(f"golden header/pill mismatch: {context}")


def test_filter_counts_page_and_review() -> None:
    counts = json_query(f"SELECT public.inbox_drip_counts_v1('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":false}}'::jsonb);", role="authenticated")
    if counts["counts"] != {"in_drip": 4, "drip_replied": 3}:
        raise AssertionError(f"unexpected drip counts: {counts}")
    workset = json_query(f"SELECT public.inbox_create_workset_v2('{ORG}'::uuid,'{{\"view\":\"in_drip\",\"hide_noise\":false}}'::jsonb,500,NULL,NULL);", role="authenticated")
    page_ids = {target["id"] for target in workset["targets"]}
    if page_ids != {"80000000-0000-4000-8000-000000000001", "80000000-0000-4000-8000-000000000002", "80000000-0000-4000-8000-000000000003", "80000000-0000-4000-8000-000000000007"}:
        raise AssertionError(f"in_drip page mismatch: {page_ids}")
    review = json_query(f"SELECT public.inbox_review_selection('{ORG}'::uuid,'{{\"view\":\"in_drip\",\"hide_noise\":false}}'::jsonb,'[{{\"kind\":\"conversation\",\"id\":\"80000000-0000-4000-8000-000000000001\"}},{{\"kind\":\"conversation\",\"id\":\"80000000-0000-4000-8000-000000000004\"}}]'::jsonb);", role="authenticated")
    statuses = {item["id"]: item["status"] for item in review["items"]}
    if statuses != {"80000000-0000-4000-8000-000000000001": "matching", "80000000-0000-4000-8000-000000000004": "outside_filter"}:
        raise AssertionError(f"review selection admitted non-match: {statuses}")


def test_loader_rpc_visibility_parity() -> None:
    foreign_message = "70000000-0000-4000-8000-000000000098"
    conversation = "80000000-0000-4000-8000-000000000002"
    psql(f"""
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id)
VALUES ('{foreign_message}','{OTHER_ORG}','2026-09-02 11:00+00','sms','inbound','40000000-0000-4000-8000-000000000099',NULL,'{conversation}','+15550000001','+15550000099','Foreign visibility probe','received','{{}}',NULL)
ON CONFLICT(id) DO NOTHING;
""")
    try:
        requested = ["70000000-0000-4000-8000-000000000002", "70000000-0000-4000-8000-000000000003", "70000000-0000-4000-8000-000000000012", foreign_message]
        literal = ",".join(f"'{value}'::uuid" for value in requested)
        # Bypass table RLS in this disposable fixture while retaining the real JWT
        # claims, so this parity check exercises the function's explicit tenant
        # qualification rather than being vacuously protected by RLS.
        loader_visible = set(json.loads(query(f"SELECT coalesce(jsonb_agg(id ORDER BY id),'[]'::jsonb) FROM public.messages WHERE org_id='{ORG}'::uuid AND conversation_id='{conversation}'::uuid AND channel='sms' AND id = ANY(ARRAY[{literal}]);", role="authenticated_bypass_rls")))
        rpc = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'{conversation}'::uuid,ARRAY[{literal}]);", role="authenticated_bypass_rls")
        rpc_visible = {row["id"] for row in rpc["messages"] if row["is_page"]}
        if loader_visible != rpc_visible or foreign_message in rpc_visible:
            raise AssertionError(f"loader/RPC visibility diverged: loader={loader_visible} rpc={rpc_visible}")
    finally:
        psql(f"DELETE FROM public.messages WHERE id='{foreign_message}';")


def test_fixture_case_matrix() -> None:
    sibling = marker_for("80000000-0000-4000-8000-000000000009")
    review_property = marker_for("80000000-0000-4000-8000-000000000010")
    manual_pause = marker_for("80000000-0000-4000-8000-000000000011")
    if sibling["property_id"] != "40000000-0000-4000-8000-000000000002" or not sibling["in_drip"] or not sibling["drip_replied"]:
        raise AssertionError(f"two-conversations-per-property case diverged: {sibling}")
    if review_property["property_id"] != "40000000-0000-4000-8000-000000000004" or review_property["in_drip"] or review_property["drip_replied"]:
        raise AssertionError(f"review property overrode newest message property: {review_property}")
    if not manual_pause["in_drip"] or manual_pause["drip_replied"]:
        raise AssertionError(f"non-reply pause reason changed marker semantics: {manual_pause}")


def test_labels_and_long_skip() -> None:
    inbound = "70000000-0000-4000-8000-000000000003"
    label = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['{inbound}'::uuid]);", role="authenticated")
    page = next(row for row in label["messages"] if row["id"] == inbound)
    if page.get("drip_name") is not None or page.get("drip_step") is not None or page.get("drip_steps_total") is not None or page.get("previous_drip_step") != 1:
        raise AssertionError(f"nearest lookbehind facts mismatch: {page}")
    if not any(row["id"] == "70000000-0000-4000-8000-000000000002" and row["is_page"] is False for row in label["messages"]):
        raise AssertionError("label response omitted the nearest lookbehind row")
    out = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000002'::uuid]);", role="authenticated")
    out_page = next(row for row in out["messages"] if row["id"] == "70000000-0000-4000-8000-000000000002")
    if (out_page.get("drip_name"), out_page.get("drip_step"), out_page.get("drip_steps_total"), out_page.get("previous_drip_step")) != ("Fixture Drip", 1, 3, None):
        raise AssertionError(f"drip label facts mismatch: {out_page}")
    if any(row["is_page"] is False for row in out["messages"]):
        raise AssertionError("oldest page did not avoid an unnecessary lookbehind")
    combined = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000002'::uuid,'{inbound}'::uuid]);", role="authenticated")
    combined_page = {row["id"]: row for row in combined["messages"] if row["is_page"]}
    if combined_page[inbound].get("previous_drip_step") != page.get("previous_drip_step") or combined_page["70000000-0000-4000-8000-000000000002"].get("drip_name") != out_page.get("drip_name"):
        raise AssertionError("concatenated page labels changed attribution")
    tied = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['{inbound}'::uuid,'70000000-0000-4000-8000-000000000012'::uuid]);", role="authenticated")
    tied_page = [row for row in tied["messages"] if row["is_page"]]
    if [row["id"] for row in tied_page] != [inbound, "70000000-0000-4000-8000-000000000012"] or tied_page[1].get("previous_drip_step") is not None:
        raise AssertionError(f"tied/consecutive inbound attribution mismatch: {tied_page}")


def test_clearing_events_and_campaign_exemption() -> None:
    conversation = "80000000-0000-4000-8000-000000000002"
    if marker_for(conversation)["drip_replied"] is not True:
        raise AssertionError("fixture reply was not initially pending")
    psql("""
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id)
VALUES ('70000000-0000-4000-8000-000000000020','10000000-0000-4000-8000-000000000001','2026-09-03 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000099','+15550000001','Campaign follow-up','sent','{}','90000000-0000-4000-8000-000000000001');
""")
    if marker_for(conversation)["drip_replied"] is not True:
        raise AssertionError("campaign outbound incorrectly cleared drip reply")
    psql("DELETE FROM public.messages WHERE id='70000000-0000-4000-8000-000000000020';")
    psql("""
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id)
VALUES ('70000000-0000-4000-8000-000000000021','10000000-0000-4000-8000-000000000001','2026-09-03 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000099','+15550000001','Failed follow-up','failed','{}',NULL);
""")
    if marker_for(conversation)["drip_replied"] is not True:
        raise AssertionError("failed outbound incorrectly cleared drip reply")
    psql("DELETE FROM public.messages WHERE id='70000000-0000-4000-8000-000000000021';")
    psql("""
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id)
VALUES ('70000000-0000-4000-8000-000000000022','10000000-0000-4000-8000-000000000001','2026-09-03 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','80000000-0000-4000-8000-000000000002','+15550000099','+15550000001','Human follow-up','sent','{}',NULL);
""")
    if marker_for(conversation)["drip_replied"] is not False:
        raise AssertionError("human outbound did not clear drip reply")
    psql("DELETE FROM public.messages WHERE id='70000000-0000-4000-8000-000000000022';")
    for event_id, event_type, payload in [
        ("92000000-0000-4000-8000-000000000001", "dispo_set", "{}"),
        ("92000000-0000-4000-8000-000000000002", "my_leads_workflow", '{"operation":"log_acquisition_attempt"}'),
    ]:
        psql(f"INSERT INTO public.lead_events(id,org_id,property_id,actor_type,actor_id,event_type,payload,created_at) VALUES ('{event_id}','{ORG}','40000000-0000-4000-8000-000000000002','user','{USER}','{event_type}','{payload}'::jsonb,'2026-09-03 10:00+00');")
        if marker_for(conversation)["drip_replied"] is not False:
            raise AssertionError(f"{event_type} did not clear drip reply")
        psql(f"DELETE FROM public.lead_events WHERE id='{event_id}';")
    psql(f"""
INSERT INTO public.acquisition_attempts(id,org_id,property_id,actor_user_id,attempt_kind,source,outcome,occurred_at,recorded_at,idempotency_key)
VALUES ('93000000-0000-4000-8000-000000000001','{ORG}','40000000-0000-4000-8000-000000000002','{USER}','outreach','manual','reached','2026-09-03 10:00+00','2026-09-03 10:00+00','94000000-0000-4000-8000-000000000001');
""")
    if marker_for(conversation)["drip_replied"] is not False:
        raise AssertionError("acquisition attempt did not clear drip reply")
    psql("DELETE FROM public.acquisition_attempts WHERE id='93000000-0000-4000-8000-000000000001';")


def test_label_convergence_after_write() -> None:
    conversation = "80000000-0000-4000-8000-000000000002"
    inbound = "70000000-0000-4000-8000-000000000031"
    outbound = "70000000-0000-4000-8000-000000000030"
    run_id = "63000000-0000-4000-8000-000000000030"
    before = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'{conversation}'::uuid,ARRAY['{inbound}'::uuid]);", role="authenticated")
    if before["messages"]:
        raise AssertionError("label RPC returned a message before the write")
    psql(f"""
INSERT INTO public.messages(id,org_id,created_at,channel,direction,property_id,contact_id,conversation_id,from_address,to_address,body,status,metadata,campaign_id)
VALUES ('{outbound}','{ORG}','2026-09-04 10:00+00','sms','outbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','{conversation}','+15550000099','+15550000001','New drip text','sent','{{}}',NULL),
 ('{inbound}','{ORG}','2026-09-04 10:01+00','sms','inbound','40000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000001','{conversation}','+15550000001','+15550000099','New reply','received','{{}}',NULL);
INSERT INTO public.sequence_step_runs(id,enrollment_id,step_id,message_id,scheduled_for,run_at)
VALUES ('{run_id}','62000000-0000-4000-8000-000000000002','61000000-0000-4000-8000-000000000002','{outbound}','2026-09-04 09:59+00','2026-09-04 10:00+00');
""")
    after = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'{conversation}'::uuid,ARRAY['{inbound}'::uuid]);", role="authenticated")
    row = next(row for row in after["messages"] if row["id"] == inbound)
    if row.get("previous_drip_step") != 2:
        raise AssertionError(f"label inputs did not converge after write: {row}")
    psql(f"DELETE FROM public.sequence_step_runs WHERE id='{run_id}'; DELETE FROM public.messages WHERE id IN ('{outbound}','{inbound}');")


def test_authorization_and_grants() -> None:
    # The collision is deliberately present in both tenant rows; a tenant-less
    # join must therefore return two rows and fail this assertion directly.
    psql(f"""
INSERT INTO inbox_maintained.rows(org_id,target_kind,target_id,revision,source_generation,summary)
VALUES ('{OTHER_ORG}'::uuid,'known_conversation','80000000-0000-4000-8000-000000000001'::uuid,1,1,
 jsonb_build_object('target_kind','known_conversation','target_id','80000000-0000-4000-8000-000000000001','exists',true,'property_id','40000000-0000-4000-8000-000000000099'))
ON CONFLICT(org_id,target_kind,target_id) DO NOTHING;
""")
    expect_error(f"SELECT public.inbox_drip_markers_v1('{OTHER_ORG}'::uuid,ARRAY['80000000-0000-4000-8000-000000000001'::uuid]);", "INBOX_ORG_DENIED")
    foreign = json_query(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid,ARRAY['80000000-0000-4000-8000-000000000001'::uuid]);", role="authenticated")
    if len(foreign["rows"]) != 1 or foreign["rows"][0]["property_id"] != golden["markerRows"]["80000000-0000-4000-8000-000000000001"]["property_id"]:
        raise AssertionError("same conversation id leaked across organizations")
    labels = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000003'::uuid,'70000000-0000-4000-8000-000000000099'::uuid]);", role="authenticated")
    if {row["id"] for row in labels["messages"] if row["is_page"]} != {"70000000-0000-4000-8000-000000000003"}:
        raise AssertionError("foreign label message was visible")
    grants = query("""
SELECT has_function_privilege('authenticated','public.inbox_drip_markers_v1(uuid,uuid[])','EXECUTE')
 AND has_function_privilege('anon','public.inbox_drip_markers_v1(uuid,uuid[])','EXECUTE') IS FALSE
 AND has_function_privilege('authenticated','inbox_bridge.drip_flags(uuid,uuid)','EXECUTE') IS FALSE
 AND has_function_privilege('authenticated','public.inbox_drip_label_inputs_v1(uuid,uuid,uuid[])','EXECUTE');
""")
    if grants != "t":
        raise AssertionError(f"grant boundary mismatch: {grants}")
    expect_error(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid,ARRAY(SELECT gen_random_uuid() FROM generate_series(1,501)));", "INBOX_INVALID_MARKER_IDS")
    expect_error(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY(SELECT gen_random_uuid() FROM generate_series(1,51)));", "INBOX_INVALID_LABEL_INPUTS")
    psql("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;")
    expect_error(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000003'::uuid]);", "INBOX_NOT_READY")
    psql("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton;")
    psql("UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='" + SESSION + "';")
    expect_error(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid,ARRAY['80000000-0000-4000-8000-000000000001'::uuid]);", "INBOX_SESSION_REVOKED")
    expect_error(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000003'::uuid]);", "INBOX_SESSION_REVOKED")


def test_mid_request_access_epoch_fence() -> None:
    # Add only a disposable-fixture delay to the live drip query so the access
    # epoch writer overlaps the real marker RPC; this does not alter the marker
    # result or its authorization state.
    psql("UPDATE auth.sessions SET not_after='2099-01-01' WHERE id='" + SESSION + "';")
    source = MIGRATION.read_text(encoding="utf-8")
    start = source.index("CREATE FUNCTION inbox_bridge.drip_flags")
    end = source.index("$$;", start) + 3
    slow_flags = source[start:end].replace("CREATE FUNCTION inbox_bridge.drip_flags", "CREATE OR REPLACE FUNCTION inbox_bridge.drip_flags", 1)
    if slow_flags.count("from public.sequence_enrollments enrollment") != 1:
        raise AssertionError("test delay anchor changed")
    slow_flags = slow_flags.replace(
        "from public.sequence_enrollments enrollment",
        "from public.sequence_enrollments enrollment cross join lateral (select pg_sleep(0.001)) delay",
        1,
    )
    psql(slow_flags)
    psql(f"""
INSERT INTO inbox_maintained.rows(org_id,target_kind,target_id,revision,source_generation,summary)
SELECT '{ORG}'::uuid,'known_conversation',('81000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,1,1,
 jsonb_build_object('target_kind','known_conversation','target_id',('81000000-0000-4000-8000-'||lpad(n::text,12,'0')),'exists',true,'property_id','40000000-0000-4000-8000-000000000001','last_message_at','2026-09-01 00:00:00+00','has_recent',false)
FROM generate_series(1,500) n
ON CONFLICT(org_id,target_kind,target_id) DO NOTHING;
""")
    marker_ids = ",".join(f"'81000000-0000-4000-8000-{n:012d}'::uuid" for n in range(1, 501))
    marker = psql_process(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid,ARRAY[{marker_ids}]);", role="authenticated")
    time.sleep(0.02)
    writer = psql_process("SELECT pg_sleep(0.05); UPDATE inbox_bridge.access_epochs SET revision=revision+1 WHERE user_id='" + USER + "'::uuid;")
    stdout, stderr = marker.communicate(timeout=30)
    try:
        writer.communicate(timeout=10)
    except subprocess.TimeoutExpired:
        writer.terminate()
        writer.wait(timeout=10)
    combined = stdout + stderr
    if marker.returncode == 0 or "INBOX_ACCESS_CHANGED" not in combined:
        raise AssertionError(f"mid-request revocation was not fenced: rc={marker.returncode} output={combined[-1000:]}")


def test_consistency_and_rate_limit() -> None:
    # A fixture write changes the marker without changing the membership or
    # projection row; the next read must converge to the new flag.
    psql("UPDATE auth.sessions SET not_after='2099-01-01' WHERE id='" + SESSION + "';")
    before = marker_json()["rows"]
    psql("UPDATE public.sequence_enrollments SET status='completed',completed_at='2026-09-04 00:00+00' WHERE id='62000000-0000-4000-8000-000000000001';")
    after = marker_json()["rows"]
    b = next(row for row in before if row["conversation_id"] == "80000000-0000-4000-8000-000000000001")
    a = next(row for row in after if row["conversation_id"] == "80000000-0000-4000-8000-000000000001")
    if b["in_drip"] is not True or a["in_drip"] is not False:
        raise AssertionError("marker did not converge after enrollment write")
    # Workset generation has a deliberate one-second rate limit. The first
    # immediate retry must fail, then a fresh cursor-free request is accepted.
    psql("DELETE FROM inbox_bridge.cursors; DELETE FROM inbox_bridge.worksets;")
    first = json_query(f"SELECT public.inbox_create_workset_v2('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":false}}'::jsonb,500,NULL,NULL);", role="authenticated")
    expect_error(f"SELECT public.inbox_create_workset_v2('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":false}}'::jsonb,500,NULL,NULL);", "INBOX_GENERATION_RATE")
    time.sleep(1.1)
    second = json_query(f"SELECT public.inbox_create_workset_v2('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":false}}'::jsonb,500,NULL,NULL);", role="authenticated")
    if first["generation"] == second["generation"]:
        raise AssertionError("cursor-free workset did not advance after rate-limit window")
    # Count-preserving swap: the first page is retained, one unloaded row stops
    # matching, and another unloaded row starts matching before page two reads.
    reset_workset_fixture()
    first = workset("in_drip", 2)
    first_ids = {target["id"] for target in first["targets"]}
    if first_ids != {"80000000-0000-4000-8000-000000000003", "80000000-0000-4000-8000-000000000002"}:
        raise AssertionError(f"unexpected first cursor page: {first_ids}")
    psql("""
UPDATE public.sequence_enrollments SET status='completed',completed_at='2026-09-04 00:00+00' WHERE id='62000000-0000-4000-8000-000000000001';
UPDATE public.sequence_enrollments SET status='active',completed_at=NULL WHERE id='62000000-0000-4000-8000-000000000005';
""")
    permit_next_workset()
    swapped = workset("in_drip", 2, cursor=first["next_cursor"], replaces=first["id"])
    swapped_ids = {target["id"] for target in swapped["targets"]}
    if swapped_ids != {"80000000-0000-4000-8000-000000000005", "80000000-0000-4000-8000-000000000007"}:
        raise AssertionError(f"count-preserving cursor swap missed a row: {swapped_ids}")
    if json_query(f"SELECT public.inbox_drip_counts_v1('{ORG}'::uuid,'{{\"view\":\"all\",\"hide_noise\":false}}'::jsonb);", role="authenticated")["counts"]["in_drip"] != 4:
        raise AssertionError("count-preserving swap changed population count")
    # Unloaded match moves ahead of page one. The old cursor must not reveal it;
    # the cursor-free replacement must re-derive page one and include it.
    reset_workset_fixture()
    first = workset("in_drip", 2)
    psql("""
UPDATE public.sequence_enrollments SET status='active',completed_at=NULL WHERE id='62000000-0000-4000-8000-000000000005';
UPDATE inbox_bridge.filter_rows SET latest_at='2026-09-04 12:00+00' WHERE target_id='80000000-0000-4000-8000-000000000005';
""")
    permit_next_workset()
    stale = workset("in_drip", 2, cursor=first["next_cursor"], replaces=first["id"])
    if "80000000-0000-4000-8000-000000000005" in {target["id"] for target in stale["targets"]}:
        raise AssertionError("stale cursor incorrectly surfaced a match moved ahead of page one")
    permit_next_workset()
    fresh = workset("in_drip", 2, replaces=stale["id"])
    if fresh["targets"][0]["id"] != "80000000-0000-4000-8000-000000000005":
        raise AssertionError(f"cursor-free reconciliation did not recover moved match: {fresh['targets']}")


TESTS: list[tuple[str, Callable[[], None]]] = [
    ("golden fixture + legacy 035000 oracle parity", test_golden_marker_and_oracle),
    ("filters, counts, page and review_selection", test_filter_counts_page_and_review),
    ("loader and label-RPC visibility parity", test_loader_rpc_visibility_parity),
    ("fixture matrix: sibling property, review-property divergence and pause reasons", test_fixture_case_matrix),
    ("label facts, nearest lookbehind, skipped AI and concatenation", test_labels_and_long_skip),
    ("clearing events, failed sends and campaign exemption", test_clearing_events_and_campaign_exemption),
    ("label convergence after a write boundary", test_label_convergence_after_write),
    ("authorization denial, foreign IDs, revoked-session labels, cap and grants", test_authorization_and_grants),
    ("mid-request revocation is fenced with INBOX_ACCESS_CHANGED", test_mid_request_access_epoch_fence),
    ("freshness with projection worker stopped and workset reconciliation", test_consistency_and_rate_limit),
]


def run_suite(label: str) -> list[str]:
    failures: list[str] = []
    for name, test in TESTS:
        executed = "yes"
        try:
            test()
            result = "PASS"
            emit(f"TEST_PASS|{label}|{name}")
        except Exception as error:  # noqa: BLE001 - evidence runner must continue to enumerate cases.
            result = "FAIL"
            failures.append(name)
            emit(f"TEST_FAIL|{label}|{name}|{error}")
        evidence.append({"run": label, "test": name, "Executed": executed, "result": result})
    if len(TESTS) != 10:
        raise RuntimeError("unexpected NOT RUN: test inventory changed")
    return failures


MUTATIONS = [
    ("failed-send-clearing-predicate", "and action.status is distinct from 'failed'", "and true"),
    ("page-in-drip-branch", " WHEN 'in_drip' THEN predicate:=known||' AND EXISTS(SELECT 1 FROM inbox_maintained.rows maintained LEFT JOIN LATERAL inbox_bridge.drip_flags($1,(maintained.summary->>''property_id'')::uuid) flags ON true WHERE maintained.org_id=$1 AND maintained.target_kind=r.target_kind AND maintained.target_id=r.target_id AND coalesce(flags.in_drip,false))';\n", " WHEN 'in_drip' THEN predicate:='FALSE';\n"),
    ("review-selection-else-true", "   WHEN 'in_drip' THEN coalesce(c.in_drip,false)\n", ""),
    ("marker-tenant-qualification", "JOIN inbox_maintained.rows maintained\n     ON maintained.org_id=$1\n", "JOIN inbox_maintained.rows maintained\n     ON TRUE\n"),
    ("marker-access-epoch-fence", ") INTO result;\n after_access:=inbox_bridge.authorize_serving($1);\n IF (after_access->>'user_id',after_access->>'session_id',after_access->>'org_id',after_access->>'access_epoch') IS DISTINCT FROM\n", ") INTO result;\n after_access:=a;\n IF (after_access->>'user_id',after_access->>'session_id',after_access->>'org_id',after_access->>'access_epoch') IS DISTINCT FROM\n"),
    ("label-raw-facts", "     'previous_drip_step',CASE WHEN is_page THEN previous_drip_step END\n", "     'previous_drip_step',NULL\n"),
    ("label-input-cap", " IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR cardinality($3)>50 OR\n", " IF $1 IS NULL OR $2 IS NULL OR $3 IS NULL OR cardinality($3)>500 OR\n"),
    ("counts-search-filter", "m.fts @@ public.search_prefix_tsquery(f->>'search')", "TRUE"),
    ("counts-noise-filter", "AND (NOT (f->>'hide_noise')::boolean OR NOT is_noise) AND in_drip", "AND TRUE AND in_drip"),
    ("label-input-org-qualification", "JOIN requested r ON r.id=m.id\n   WHERE m.org_id=$1 AND m.conversation_id=$2 AND m.channel='sms'", "JOIN requested r ON r.id=m.id\n   WHERE TRUE AND m.conversation_id=$2 AND m.channel='sms'"),
]


def run_one(label: str) -> list[str]:
    reset_fixture()
    return run_suite(label)


def main() -> int:
    original = MIGRATION.read_bytes()
    try:
        emit("RUNNER_START mutation-first=true origin_fixture=035000-038000")
        verify_frozen_hashes()
        verify_marker_function_diffs()
        run_focused_vitest_mutations()
        if len(MUTATIONS) != 10:
            raise RuntimeError("unexpected NOT RUN: mutation inventory changed")
        baseline_failures = run_one("baseline")
        if baseline_failures:
            emit(f"BASELINE_FAIL {baseline_failures}")
            return 2
        for name, needle, replacement in MUTATIONS:
            verify_frozen_hashes()
            source = original.decode("utf-8")
            if source.count(needle) != 1:
                emit(f"ENV_FAIL mutation needle count {name}={source.count(needle)}")
                return 3
            MIGRATION.write_text(source.replace(needle, replacement), encoding="utf-8")
            try:
                failures = run_one("mutant:" + name)
                if not failures:
                    emit(f"SURVIVED|{name}")
                    return 4
                emit(f"MUTANT_KILLED|{name}|{failures}")
                mutation_results.append({"mutation": name, "Executed": "yes", "failure": "; ".join(failures)})
            finally:
                MIGRATION.write_bytes(original)
                verify_frozen_hashes()
        emit("RUNNER_RESULT PASS")
        return 0
    except Exception as error:  # noqa: BLE001 - top-level evidence must report environment failures.
        emit(f"ENV_FAIL|{error}")
        return 5
    finally:
        MIGRATION.write_bytes(original)
        down()
        LOG.parent.mkdir(parents=True, exist_ok=True)
        LOG.write_text("\n".join(log_lines) + "\n", encoding="utf-8")
        lines = ["# Drip markers mutation evidence", "", "| Run | Test | Executed | Result |", "|---|---|---:|---|"]
        lines.extend(f"| {row['run']} | {row['test']} | {row['Executed']} | {row['result']} |" for row in evidence)
        lines.extend(["", "## Natural mutation kills", "", "| Mutation | Executed | Natural mutated failure |", "|---|---:|---|"])
        lines.extend(f"| {row['mutation']} | {row['Executed']} | {row['failure']} |" for row in mutation_results)
        lines.extend(["", "## Focused Vitest natural mutation kills", "", "| Mutation | Executed | Natural mutated failure |", "|---|---:|---|"])
        lines.extend(f"| {row['mutation']} | {row['Executed']} | {row['failure']} |" for row in vitest_mutation_results)
        lines.extend(["", "## Frozen function proof", "", "- counts_typed: `pg_get_functiondef` after all migrations equaled the 040260-absent simulation byte-for-byte.", "", "| Function | Differing line | Classification |", "|---|---|---|"])
        lines.extend(f"| {row['function']} | `{markdown_cell(row['line'])}` | {row['classification']} |" for row in function_diff_rows)
        EVIDENCE.write_text("\n".join(lines) + "\n", encoding="utf-8")
        emit(f"EVIDENCE {EVIDENCE}")
        emit(f"RAW_LOG {LOG}")
        LOG.write_text("\n".join(log_lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
