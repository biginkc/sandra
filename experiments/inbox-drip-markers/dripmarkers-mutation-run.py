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
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[2]
LOCAL_ENV = ROOT / "experiments/inbox-reply-send/local-env.py"
MIGRATION = ROOT / "supabase/migrations/20260930040260_inbox_drip_markers.sql"
GOLDEN = ROOT / "experiments/inbox-drip-markers/golden-fixture.json"
LOG = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/dripmarkers-mutation-run-r1.log")
EVIDENCE = Path("/Users/jarradhenry/Sites/BMH apps/Sandra-inbox-tmp/notes/dripmarkers-evidence-r1.md")
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
}
ORIGIN_MIGRATIONS = [
    "supabase/migrations/20260930035000_drip_reply_failed_send_keeps_flag.sql",
    "supabase/migrations/20260930036000_dialpad_training_projection.sql",
    "supabase/migrations/20260930037000_dialpad_training_playback.sql",
    "supabase/migrations/20260930038000_sequence_canary_controls.sql",
]

golden: dict[str, Any] = json.loads(GOLDEN.read_text(encoding="utf-8"))
evidence: list[dict[str, str]] = []
log_lines: list[str] = []


def emit(line: str) -> None:
    print(line, flush=True)
    log_lines.append(line)


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


def state() -> dict[str, Any]:
    return json.loads(STATE.read_text(encoding="utf-8"))


def psql(statement: str, *, role: str | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
    s = state()
    prefix = ""
    if role == "authenticated":
        claims = json.dumps({"sub": USER, "role": "authenticated", "session_id": SESSION, "exp": 4102444800}, separators=(",", ":"))
        prefix = f"SET ROLE authenticated; SET request.jwt.claim.sub='{USER}'; SET request.jwt.claim.role='authenticated'; SET request.jwt.claims='{claims}';\n"
    return run([
        PSQL, "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", str(s["socket"]), "-p", str(s["port"]),
        "-U", "postgres", "-d", "postgres",
    ], input_text=prefix + statement, check=check)


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
    searched = json_query(f"SELECT public.inbox_drip_counts_v1('{ORG}'::uuid,'{{\"view\":\"in_drip\",\"hide_noise\":false,\"search\":\"drip\"}}'::jsonb);", role="authenticated")
    if searched["counts"]["in_drip"] != 4:
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
    if page.get("drip_reply_label") != golden["labels"]["80000000-0000-4000-8000-000000000002"]["drip_reply_label"]:
        raise AssertionError(f"nearest lookbehind label mismatch: {page}")
    if not any(row["id"] == "70000000-0000-4000-8000-000000000002" and row["is_page"] is False for row in label["messages"]):
        raise AssertionError("label response omitted the nearest lookbehind row")
    out = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000002'::uuid]);", role="authenticated")
    out_page = next(row for row in out["messages"] if row["id"] == "70000000-0000-4000-8000-000000000002")
    if out_page.get("drip_label") != golden["labels"]["70000000-0000-4000-8000-000000000002"]["drip_label"]:
        raise AssertionError(f"drip label mismatch: {out_page}")
    if any(row["is_page"] is False for row in out["messages"]):
        raise AssertionError("oldest page did not avoid an unnecessary lookbehind")
    combined = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000002'::uuid,'{inbound}'::uuid]);", role="authenticated")
    combined_page = {row["id"]: row for row in combined["messages"] if row["is_page"]}
    if combined_page[inbound].get("drip_reply_label") != page.get("drip_reply_label") or combined_page["70000000-0000-4000-8000-000000000002"].get("drip_label") != out_page.get("drip_label"):
        raise AssertionError("concatenated page labels changed attribution")
    tied = json_query(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['{inbound}'::uuid,'70000000-0000-4000-8000-000000000012'::uuid]);", role="authenticated")
    tied_page = [row for row in tied["messages"] if row["is_page"]]
    if [row["id"] for row in tied_page] != [inbound, "70000000-0000-4000-8000-000000000012"] or tied_page[1].get("drip_reply_label") is not None:
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


def test_authorization_and_grants() -> None:
    expect_error(f"SELECT public.inbox_drip_markers_v1('{OTHER_ORG}'::uuid,ARRAY['80000000-0000-4000-8000-000000000001'::uuid]);", "INBOX_ORG_DENIED")
    foreign = json_query(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid,ARRAY['80000000-0000-4000-8000-000000000001'::uuid]);", role="authenticated")
    if foreign["rows"][0]["property_id"] != golden["markerRows"]["80000000-0000-4000-8000-000000000001"]["property_id"]:
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
    psql("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;")
    expect_error(f"SELECT public.inbox_drip_label_inputs_v1('{ORG}'::uuid,'80000000-0000-4000-8000-000000000002'::uuid,ARRAY['70000000-0000-4000-8000-000000000003'::uuid]);", "INBOX_NOT_READY")
    psql("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton;")
    psql("UPDATE auth.sessions SET not_after=clock_timestamp()-interval '1 second' WHERE id='" + SESSION + "';")
    expect_error(f"SELECT public.inbox_drip_markers_v1('{ORG}'::uuid,ARRAY['80000000-0000-4000-8000-000000000001'::uuid]);", "INBOX_SESSION_REVOKED")


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
    ("fixture matrix: sibling property, review-property divergence and pause reasons", test_fixture_case_matrix),
    ("labels, nearest lookbehind, skipped AI and concatenation", test_labels_and_long_skip),
    ("clearing events, failed sends and campaign exemption", test_clearing_events_and_campaign_exemption),
    ("authorization denial, revocation and grants", test_authorization_and_grants),
    ("convergence and workset rate-limit acceptance", test_consistency_and_rate_limit),
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
    if len(TESTS) != 7:
        raise RuntimeError("unexpected NOT RUN: test inventory changed")
    return failures


MUTATIONS = [
    ("failed-send-clearing-predicate", "and action.status is distinct from 'failed'", "and true"),
    ("page-in-drip-branch", " WHEN 'in_drip' THEN predicate:=known||' AND EXISTS(SELECT 1 FROM inbox_maintained.rows maintained LEFT JOIN LATERAL inbox_bridge.drip_flags($1,(maintained.summary->>''property_id'')::uuid) flags ON true WHERE maintained.org_id=$1 AND maintained.target_kind=r.target_kind AND maintained.target_id=r.target_id AND coalesce(flags.in_drip,false))';\n", " WHEN 'in_drip' THEN predicate:='FALSE';\n"),
    ("review-selection-else-true", "   WHEN 'in_drip' THEN coalesce(c.in_drip,false)\n", ""),
    ("marker-tenant-qualification", "ON maintained.org_id=$1\n", "ON TRUE\n"),
]


def run_one(label: str) -> list[str]:
    reset_fixture()
    return run_suite(label)


def main() -> int:
    original = MIGRATION.read_bytes()
    try:
        emit("RUNNER_START mutation-first=true origin_fixture=035000-038000")
        baseline_failures = run_one("baseline")
        if baseline_failures:
            emit(f"BASELINE_FAIL {baseline_failures}")
            return 2
        for name, needle, replacement in MUTATIONS:
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
            finally:
                MIGRATION.write_bytes(original)
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
        EVIDENCE.write_text("\n".join(lines) + "\n", encoding="utf-8")
        emit(f"EVIDENCE {EVIDENCE}")
        emit(f"RAW_LOG {LOG}")
        LOG.write_text("\n".join(log_lines) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
