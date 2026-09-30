#!/usr/bin/env python3
"""Behavioural, rollback-oriented proof harness for reply persistence v5.

The harness connects only to PROJECTION_PGHOST/PROJECTION_PGPORT. Normal cases
run inside a transaction and roll back. The four lock cases use committed,
uniquely-keyed fixtures because they need several real PostgreSQL sessions;
they clean their rows and restore any mutation before returning.

This file does not inspect catalog function text. The source extractor is only
a mutation installer; assertions inspect database rows, states, SQLSTATEs and
lock observations.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20260930040250_inbox_reply_message_projection.sql"
PGHOST = os.environ.get("PROJECTION_PGHOST", "/tmp/sandra-reply-persist-pg.pPmk5e/socket")
PGPORT = os.environ.get("PROJECTION_PGPORT", "55436")
MUTATION_VARIANT = os.environ.get("PROJECTION_MUTATION_VARIANT", "")


def psql(sql: str, timeout: int = 30, *, check: bool = False) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(
        ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", PGHOST, "-p", PGPORT, "-U", "postgres", "-d", "postgres"],
        input=sql,
        text=True,
        capture_output=True,
        timeout=timeout,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if check and result.returncode:
        raise AssertionError((result.stderr + result.stdout).strip())
    return result


def output(result: subprocess.CompletedProcess[str]) -> str:
    return (result.stderr + result.stdout).strip()


def merged_drips_migration() -> str:
    result = subprocess.run(
        [
            "git",
            "show",
            "880c8dfd0de9168374e7ed23b04ce42a866c4e88:supabase/migrations/20260930035000_drip_reply_failed_send_keeps_flag.sql",
        ],
        text=True,
        capture_output=True,
        check=True,
    )
    return result.stdout


def fn_body(name: str) -> str:
    """Return a function definition solely for installing a test mutation."""
    source = MIGRATION.read_text()
    match = re.search(rf"CREATE(?: OR REPLACE)? FUNCTION {re.escape(name)}\(.*?END \$\$;", source, re.S)
    if not match:
        raise RuntimeError(f"could not extract mutation target {name}")
    return re.sub(r"^CREATE(?: OR REPLACE)? ", "CREATE OR REPLACE ", match.group(0))


def install_mutated_function(name: str, old: str, new: str) -> str:
    body = fn_body(name)
    if old not in body:
        raise RuntimeError(f"mutation target not found in {name}")
    return body.replace(old, new, 1)


def mutate_chain(name: str, replacements: list[tuple[str, str]]) -> str:
    body = fn_body(name)
    for old, new in replacements:
        if old not in body:
            raise RuntimeError(f"mutation target not found in {name}")
        body = body.replace(old, new, 1)
    return body


def ids(n: int) -> dict[str, str]:
    tail = f"{n:02x}"
    return {
        "o": f"11111111-0000-4000-8000-0000000000{tail}",
        "c": f"22222222-0000-4000-8000-0000000000{tail}",
        "p": f"33333333-0000-4000-8000-0000000000{tail}",
        "i": f"44444444-0000-4000-8000-0000000000{tail}",
        "prep": f"55555555-0000-4000-8000-0000000000{tail}",
        "op": f"66666666-0000-4000-8000-0000000000{tail}",
        "a": f"77777777-0000-4000-8000-0000000000{tail}",
        "conv": f"88888888-0000-4000-8000-0000000000{tail}",
        "token": f"99999999-0000-4000-8000-0000000000{tail}",
    }


def second_ids(n: int) -> dict[str, str]:
    x, y = ids(n), ids(n + 1)
    return {"o": x["o"], "c": x["c"], "p": x["p"], "prep": x["prep"], "op": x["op"],
            "i": y["i"], "a": y["a"], "conv": y["conv"], "token": y["token"]}


def item_values(n: int, items: int) -> str:
    x = ids(n)
    values = []
    for offset in range(items):
        item = f"{n + offset:02x}"
        phone = "101" if offset == 0 else f"{n + offset:03d}"
        values.append(
            f"jsonb_build_object('id','44444444-0000-4000-8000-0000000000{item}'::uuid,"
            f"'target',jsonb_build_object('kind','conversation','id','88888888-0000-4000-8000-0000000000{item}'::uuid),"
            f"'recipient',jsonb_build_object('contactId','{x['c']}'::uuid,'from','+12025550001','to','+1202555{phone.zfill(4)}',"
            f"'propertyId','{x['p']}'::uuid,'renderedBody','hello-{n}'),"
            "'validUntil','2999-01-01T00:00:00Z','state','MO','dependencies',jsonb_build_object('head',1))"
        )
    return "jsonb_build_array(" + ",".join(values) + ")"


def fixture(n: int, body: str, *, items: int = 1, seed_attempt: bool = True) -> str:
    x = ids(n)
    operation = f"INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key) VALUES('{x['o']}','{x['op']}','{x['c']}','{x['prep']}',gen_random_uuid());" if seed_attempt else ""
    attempt = f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{x['o']}','{x['a']}','{x['op']}','{x['prep']}','{x['i']}',1,'{x['c']}','+12025550001','+12025550101',inbox_reply_send.body_hash('hello-{n}','+12025550001','+12025550101'),'approved');" if seed_attempt else ""
    return f"""
BEGIN;
SET LOCAL client_min_messages='warning';
INSERT INTO organizations(id,name) VALUES('{x['o']}','projection-test-{n}');
INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{x['c']}','{x['o']}','Projection','+12025550101','mobile');
INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{x['o']}','{x['c']}','sms','opt_in_marketing_written','projection-test');
INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{x['p']}','{x['o']}','Projection Test {n}','MO','{x['c']}');
INSERT INTO inbox_reply_review.preparations(id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at)
VALUES('{x['prep']}','{x['o']}','{x['c']}',gen_random_uuid(),'x','{{}}',{item_values(n, items)},clock_timestamp()+interval '1 hour');
{operation}
{attempt}
{body}
ROLLBACK;
"""


def started(n: int, *, attempt: dict[str, str] | None = None) -> str:
    x = attempt or ids(n)
    return f"""
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute'
 WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL
 WHERE org_id='{x['o']}' AND id='{x['a']}';
"""


def accepted(n: int, reference: str, *, attempt: dict[str, str] | None = None) -> str:
    x = attempt or ids(n)
    return f"UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='{reference}',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';\n"


def common_project_state(n: int, state: str, *, reference: str = "ext-1", evidence: str = "provider_rejected") -> str:
    x = ids(n)
    if state == "uncertain":
        fields = "state='uncertain',evidence='transport_timeout'"
    elif state == "provider_accepted":
        fields = f"state='provider_accepted',provider_reference='{reference}',provider_status='sent'"
    elif state == "delivered":
        fields = f"state='delivered',provider_reference='{reference}',provider_status='delivered'"
    elif state == "delivery_failed":
        fields = f"state='delivery_failed',provider_reference='{reference}',provider_status='failed',evidence='{evidence}'"
    else:
        raise ValueError(state)
    return started(n) + f"UPDATE inbox_reply_send.attempts SET {fields},receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';\n"


def drip_fixture(n: int) -> str:
    x = ids(n)
    seq = f"aaaaaaaa-0000-4000-8000-0000000000{n:02x}"
    step = f"bbbbbbbb-0000-4000-8000-0000000000{n:02x}"
    enrollment = f"cccccccc-0000-4000-8000-0000000000{n:02x}"
    prior = f"dddddddd-0000-4000-8000-0000000000{n:02x}"
    inbound = f"eeeeeeee-0000-4000-8000-0000000000{n:02x}"
    # T24-T26 are activated only after the merged Drips migration is loaded
    # verbatim by run_case; this fixture supplies its real rows and predicate.
    return f"""
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT EXECUTE ON FUNCTION public.sms_inbox_thread_page_snapshot(timestamptz,text,uuid,uuid,boolean,integer,integer,text),public.inbox_reply_reconcile_callback(text,text,text,jsonb) TO authenticated;
INSERT INTO auth.users(id,email) VALUES('{x['c']}','projection-{n}@example.test');
INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{x['token']}','{x['c']}','2999-01-01T00:00:00Z');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{x['c']}','{x['o']}','owner','active');
INSERT INTO sequences(id,org_id,name) VALUES('{seq}','{x['o']}','Projection Drip');
INSERT INTO sequence_steps(id,sequence_id,step_index,action_type,template_body) VALUES('{step}','{seq}',0,'send_sms','Drip body');
INSERT INTO sequence_enrollments(id,org_id,sequence_id,property_id,contact_id,status,pause_reason) VALUES('{enrollment}','{x['o']}','{seq}','{x['p']}','{x['c']}','paused','inbound_reply');
INSERT INTO public.messages(id,org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,from_address,to_address,created_at,sent_at)
VALUES('{prior}','{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','outbound','sent','sendillo','Drip prior','+12025550001','+12025550101','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO sequence_step_runs(id,enrollment_id,step_id,message_id,scheduled_for,run_at) VALUES(gen_random_uuid(),'{enrollment}','{step}','{prior}','2026-09-01T00:00:00Z','2026-09-01T00:00:00Z');
INSERT INTO public.messages(id,org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,from_address,to_address,created_at)
VALUES('{inbound}','{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','inbound','received','sendillo','Customer reply','+12025550101','+12025550001','2026-09-02T00:00:00Z');
"""


def assert_case(n: int, body: str, mutation: str = "", *, items: int = 1) -> tuple[str, str]:
    return fixture(n, body, items=items), mutation


def test_sql(n: int) -> tuple[str, str]:
    x = ids(n)
    if n == 1:
        body = started(n) + f"""
DO $$ DECLARE c integer; s text; e text; se timestamptz; de timestamptz; fe timestamptz; md jsonb;
BEGIN SELECT count(*),max(status),max(external_id),max(sent_at),max(delivered_at),max(failed_at),max(metadata::text)::jsonb INTO c,s,e,se,de,fe,md FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}';
 IF c<>1 OR s<>'pending' OR e IS NOT NULL OR se IS NOT NULL OR de IS NOT NULL OR fe IS NOT NULL OR md IS DISTINCT FROM jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')) THEN RAISE EXCEPTION 'T1 pending marker shape mismatch'; END IF; END $$;"""
        return assert_case(n, body, "DROP TRIGGER inbox_reply_message_projection ON inbox_reply_send.attempts;")
    if n == 2:
        body = f"""
CREATE TEMP TABLE transport_calls(c integer NOT NULL); INSERT INTO transport_calls VALUES(0);
{started(n)} UPDATE transport_calls SET c=c+1; UPDATE inbox_reply_review.admission SET enabled=true; SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}',60);
DO $$ DECLARE s text; m jsonb; c integer;
BEGIN SELECT status,metadata INTO s,m FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}'; SELECT transport_calls.c INTO c FROM transport_calls;
 IF s<>'failed' OR m->>'providerOutcome'<>'provider_unknown' OR c<>1 THEN RAISE EXCEPTION 'T2 crash re-entry mismatch'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message", "WHEN 'uncertain' THEN 'failed'", "WHEN 'uncertain' THEN 'sent'"))
    if n == 3:
        body = f"""
CREATE SCHEMA IF NOT EXISTS inbox_reply_test;
CREATE OR REPLACE FUNCTION inbox_reply_test.persist_call(o uuid,a uuid,t uuid,r jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT inbox_reply_send.worker_persist_result(o,a,t,r) $$;
-- MUTATION_POINT
{started(n)} SELECT inbox_reply_test.persist_call('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch'));
DO $$ DECLARE r jsonb; BEGIN SELECT inbox_reply_test.persist_call('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch')) INTO r; IF r->>'state' IS DISTINCT FROM 'confirmed_not_submitted' OR (SELECT state FROM inbox_reply_send.attempts WHERE id='{x['a']}')<>'confirmed_not_submitted' THEN RAISE EXCEPTION 'T3 wrapper replay mismatch'; END IF; END $$;"""
        return assert_case(n, body, "CREATE OR REPLACE FUNCTION inbox_reply_test.persist_call(o uuid,a uuid,t uuid,r jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT inbox_reply_send.worker_persist(o,a,t,r) $$;")
    if n == 4:
        body = f"""
CREATE SCHEMA IF NOT EXISTS inbox_reply_test; CREATE SEQUENCE inbox_reply_test.persist_fault; CREATE TEMP TABLE transport_calls(c integer NOT NULL); INSERT INTO transport_calls VALUES(0);
CREATE OR REPLACE FUNCTION inbox_reply_test.persist_fault() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF nextval('inbox_reply_test.persist_fault')=1 THEN RAISE EXCEPTION 'fixture persist rollback'; END IF; RETURN NEW; END $$;
CREATE TRIGGER persist_fault BEFORE UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW WHEN (NEW.state='provider_accepted') EXECUTE FUNCTION inbox_reply_test.persist_fault();
{started(n)} UPDATE transport_calls SET c=c+1;
DO $$ BEGIN BEGIN PERFORM inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','accepted','externalId','ext-4','status','sent')); EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'fixture persist rollback' THEN RAISE; END IF; END; END $$;
SELECT inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','accepted','externalId','ext-4','status','sent'));
DO $$ DECLARE s text; e text; c integer; BEGIN SELECT state,provider_reference INTO s,e FROM inbox_reply_send.attempts WHERE id='{x['a']}'; SELECT transport_calls.c INTO c FROM transport_calls; IF s<>'provider_accepted' OR e<>'ext-4' OR c<>1 OR (SELECT status FROM public.messages WHERE idempotency_key='{x['a']}')<>'sent' THEN RAISE EXCEPTION 'T4 recovery mismatch'; END IF; END $$;"""
        mutation = """CREATE OR REPLACE FUNCTION inbox_reply_send.worker_persist_result(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 RETURN jsonb_build_object('state','uncertain');
END $$;"""
        return assert_case(n, body, mutation)
    if n == 5:
        body = f"{common_project_state(n,'uncertain')} DO $$ DECLARE r jsonb; BEGIN SELECT inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch')) INTO r; IF r->>'state' IS DISTINCT FROM 'uncertain' THEN RAISE EXCEPTION 'T5 uncertain replay mismatch'; END IF; END $$;"
        return assert_case(n, body, install_mutated_function("inbox_reply_send.worker_persist_result", "ELSIF row.state='uncertain' AND kind='not_attempted' THEN", "ELSIF false THEN"))
    if n == 6:
        body = f"""
CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.cancel_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture cancel' USING ERRCODE='57014'; END$$;
CREATE TRIGGER projection_cancel BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId' IS NOT NULL) EXECUTE FUNCTION inbox_reply_test.cancel_projection();
{common_project_state(n,'provider_accepted',reference='ext-6')}
DO $$ DECLARE s text; c integer; BEGIN SELECT state INTO s FROM inbox_reply_send.attempts WHERE id='{x['a']}'; SELECT count(*) INTO c FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}'; IF s<>'provider_accepted' OR c<>1 THEN RAISE EXCEPTION 'T6 cancellation boundary mismatch'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "EXCEPTION WHEN query_canceled OR others THEN", "EXCEPTION WHEN others THEN"))
    if n == 7:
        body = f"""
CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_backlog() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture backlog failure'; END$$;
CREATE TRIGGER backlog_fail BEFORE INSERT ON inbox_reply_send.message_projection_backlog FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.fail_backlog();
{started(n)} DO $$ BEGIN BEGIN {accepted(n,'ext-7')} EXCEPTION WHEN OTHERS THEN NULL; END; END $$;
DO $$ BEGIN IF (SELECT state FROM inbox_reply_send.attempts WHERE id='{x['a']}')='provider_accepted' THEN RAISE EXCEPTION 'T7 backlog fault was swallowed'; END IF; END $$;
DROP TRIGGER backlog_fail ON inbox_reply_send.message_projection_backlog; {accepted(n,'ext-7')}
DO $$ BEGIN IF (SELECT state FROM inbox_reply_send.attempts WHERE id='{x['a']}')<>'provider_accepted' OR (SELECT status FROM public.messages WHERE idempotency_key='{x['a']}')<>'sent' THEN RAISE EXCEPTION 'T7 retry mismatch'; END IF; END $$;"""
        upsert = """INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version)
 VALUES(NEW.org_id,NEW.id,NEW.receipt_version)
 ON CONFLICT(org_id,attempt_id) DO UPDATE SET wanted_version=EXCLUDED.wanted_version;"""
        swallowed = """BEGIN
  INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version)
   VALUES(NEW.org_id,NEW.id,NEW.receipt_version)
   ON CONFLICT(org_id,attempt_id) DO UPDATE SET wanted_version=EXCLUDED.wanted_version;
 EXCEPTION WHEN others THEN NULL;
 END;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", upsert, swallowed))
    if n == 8:
        y = second_ids(n)
        body = f"""
CREATE SCHEMA inbox_reply_test;
CREATE FUNCTION inbox_reply_test.fail_acceptance_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture acceptance projection fault'; END$$;
{started(n)}
CREATE TRIGGER fail_acceptance_projection BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId'='{x['a']}' AND NEW.status='sent') EXECUTE FUNCTION inbox_reply_test.fail_acceptance_projection();
{accepted(n,'ext-8')}
DO $$ DECLARE s text; b integer; BEGIN SELECT state INTO s FROM inbox_reply_send.attempts WHERE id='{x['a']}'; SELECT count(*) INTO b FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}'; IF s<>'provider_accepted' OR b<>1 THEN RAISE EXCEPTION 'T8 faulted acceptance did not retain ledger/backlog'; END IF; END $$;
DROP TRIGGER fail_acceptance_projection ON public.messages;
SELECT inbox_reply_send.reconcile_delivery('{x['o']}','sendillo','ext-8','delivered','{{}}'::jsonb);
DO $$ DECLARE m public.messages; BEGIN SELECT * INTO m FROM public.messages WHERE idempotency_key='{x['a']}'; IF m.status IS DISTINCT FROM 'delivered' OR m.external_id IS DISTINCT FROM 'ext-8' OR m.sent_at IS NULL OR m.delivered_at IS NULL THEN RAISE EXCEPTION 'T8 acceptance-then-delivery mismatch'; END IF; END $$;
INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{y['o']}','{y['a']}','{y['op']}','{y['prep']}','{y['i']}',1,'{y['c']}','+12025550001','+12025550009',inbox_reply_send.body_hash('hello-{n}','+12025550001','+12025550009'),'approved');
{started(n,attempt=y)} UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='transport_timeout',receipt_version=receipt_version+1 WHERE org_id='{y['o']}' AND id='{y['a']}';
SELECT inbox_reply_send.worker_persist_result('{y['o']}','{y['a']}','{y['token']}',jsonb_build_object('kind','accepted','externalId','ext-8-late','status','sent'));
DO $$ DECLARE m public.messages; BEGIN SELECT * INTO m FROM public.messages WHERE idempotency_key='{y['a']}'; IF m.status IS DISTINCT FROM 'sent' OR m.external_id IS DISTINCT FROM 'ext-8-late' OR m.failed_at IS NOT NULL OR m.error_message IS NOT NULL OR m.metadata ? 'providerOutcome' THEN RAISE EXCEPTION 'T8 late acceptance snapshot mismatch'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message", "projected_external_id:=CASE WHEN row.state IN ('provider_accepted','delivered','delivery_failed') THEN row.provider_reference ELSE NULL END;", "projected_external_id:=NULL;"), items=2)
    if n in {9,10,11,13}:
        return concurrency_case(n)
    if n == 12:
        body = f"""
{started(n)} DELETE FROM public.messages WHERE idempotency_key='{x['a']}'; {accepted(n,'ext-12')}
DO $$ DECLARE t integer; c text; r jsonb; BEGIN
 SELECT tries,last_code INTO t,c FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}';
 IF NOT FOUND OR t<>0 OR c IS NOT NULL THEN RAISE EXCEPTION 'T12 pre-drain state wrong'; END IF;
 SELECT inbox_reply_send.drain_message_projection_one() INTO r;
 IF r->>'projected'<>'false' OR NOT EXISTS(SELECT 1 FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}' AND tries=1 AND last_code='P0001') THEN RAISE EXCEPTION 'T12 retry mismatch: %',r; END IF;
END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message", "IF changed<>1 THEN", "IF false THEN"))
    if n == 14:
        body = f"""
INSERT INTO public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,idempotency_key,metadata,from_address,to_address) VALUES('{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','outbound','pending','sendillo','existing','{x['a']}',jsonb_build_object('fixture',true),'+12025550001','+12025550101');
DO $$ BEGIN BEGIN {started(n)} EXCEPTION WHEN unique_violation THEN NULL; END; IF (SELECT state FROM inbox_reply_send.attempts WHERE id='{x['a']}')<>'approved' THEN RAISE EXCEPTION 'T14 marker conflict did not abort'; END IF; END $$;"""
        return assert_case(n, body, "DROP INDEX public.messages_outbound_sms_idempotency_idx;")
    if n == 15:
        d = ids(n + 1)
        body = f"""
CREATE TEMP TABLE decoy_before AS SELECT id,to_jsonb(m) AS row FROM public.messages m WHERE false;
{started(n)}
INSERT INTO organizations(id,name) VALUES('{d['o']}','projection-decoy-org');
INSERT INTO public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,idempotency_key,metadata,from_address,to_address) VALUES
('{x['o']}','{x['c']}','{x['p']}','{d['conv']}','email','outbound','pending','sendillo','email-decoy','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550001','+12025550101'),
('{x['o']}','{x['c']}','{x['p']}','{d['conv']}','sms','inbound','received','sendillo','inbound-decoy','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550001','+12025550101'),
('{d['o']}','{x['c']}','{x['p']}','{d['conv']}','sms','outbound','pending','sendillo','org-decoy','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550001','+12025550101');
INSERT INTO decoy_before SELECT id,to_jsonb(m) FROM public.messages m WHERE m.idempotency_key='{x['a']}' AND NOT (m.org_id='{x['o']}' AND m.channel='sms' AND m.direction='outbound');
{accepted(n,'ext-15')}
DO $$ DECLARE reply_status text; changed integer; BEGIN SELECT status INTO reply_status FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}' AND channel='sms' AND direction='outbound'; SELECT count(*) INTO changed FROM decoy_before d JOIN public.messages m ON m.id=d.id WHERE d.row IS DISTINCT FROM to_jsonb(m); IF reply_status<>'sent' OR changed<>0 THEN RAISE EXCEPTION 'T15 scoped projection mismatch'; END IF; END $$;"""
        variant = MUTATION_VARIANT or "channel"
        if variant == "org": mutation = install_mutated_function("inbox_reply_send.project_message", "WHERE m.org_id=o", "WHERE true")
        elif variant == "direction": mutation = install_mutated_function("inbox_reply_send.project_message", "AND m.direction='outbound'", "")
        else: mutation = install_mutated_function("inbox_reply_send.project_message", "AND m.channel='sms'", "")
        return assert_case(n, body, mutation)
    if n == 16:
        y = ids(n + 1)
        body = f"""
CREATE SCHEMA inbox_reply_test;
SELECT public.inbox_reply_reconcile_callback('sendillo','ext-16','delivered',jsonb_build_object('kind','delivered'));
SELECT public.inbox_reply_reconcile_callback('sendillo','ext-16','delivery_failed',jsonb_build_object('kind','failed'));
{started(n)} {accepted(n,'ext-16')}
INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
VALUES('{x['o']}','{y['a']}','{x['op']}','{x['prep']}','{y['i']}',1,'{x['c']}','+12025550001','+12025550017',inbox_reply_send.body_hash('hello-{n}','+12025550001','+12025550017'),'approved');
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{y['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{y['token']}',generation=1,lease_until=NULL WHERE org_id='{x['o']}' AND id='{y['a']}';
UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='ext-16-fault',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{y['a']}';
CREATE FUNCTION inbox_reply_test.fail_t16_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture T16 projection failure'; END$$;
CREATE TRIGGER fail_t16_projection BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId'='{y['a']}') EXECUTE FUNCTION inbox_reply_test.fail_t16_projection();
SELECT public.inbox_reply_reconcile_callback('sendillo','ext-16-fault','delivered',jsonb_build_object('kind','delivered'));
SELECT public.inbox_reply_reconcile_callback('sendillo','ext-16-fault','delivery_failed',jsonb_build_object('kind','failed')) INTO TEMP TABLE t16_loser;
DROP TRIGGER fail_t16_projection ON public.messages;
SELECT inbox_reply_send.sweep_unmatched_callbacks(10);
SELECT inbox_reply_send.drain_message_projection_one();
DO $$ DECLARE s text; ms text; ys text; yms text; held integer; backlog integer; loser jsonb; BEGIN
 SELECT state INTO s FROM inbox_reply_send.attempts WHERE id='{x['a']}'; SELECT status INTO ms FROM public.messages WHERE idempotency_key='{x['a']}';
 SELECT state INTO ys FROM inbox_reply_send.attempts WHERE id='{y['a']}'; SELECT status INTO yms FROM public.messages WHERE idempotency_key='{y['a']}';
 SELECT count(*) INTO held FROM inbox_reply_send.unmatched_callbacks WHERE provider_reference='ext-16'; SELECT count(*) INTO backlog FROM inbox_reply_send.message_projection_backlog WHERE attempt_id IN ('{x['a']}','{y['a']}'); SELECT * INTO loser FROM t16_loser;
 IF s<>'delivered' OR ms<>'delivered' OR ys<>'delivered' OR yms<>'delivered' OR held<>0 OR backlog<>0 OR loser->>'kind'<>'rejected' THEN RAISE EXCEPTION 'T16 hold/fault/settlement mismatch: %/%/%/%/%/%/%',s,ms,ys,yms,held,backlog,loser; END IF;
END $$;"""
        return assert_case(n, body, "", items=2)
    if n == 17:
        raise RuntimeError("T17 is exercised by the application status-events test")
    if n == 18:
        body = f"{started(n)} DO $$ DECLARE m jsonb; BEGIN SELECT metadata INTO m FROM public.messages WHERE idempotency_key='{x['a']}'; IF m ? 'providerAttempt' OR m->'inboxReply'->>'attemptId' IS DISTINCT FROM '{x['a']}' THEN RAISE EXCEPTION 'T18 reply marker has stale provider attempt'; END IF; END $$;"
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "jsonb_build_object('inboxReply',jsonb_build_object('attemptId',NEW.id,'operationId',NEW.operation_id))", "jsonb_build_object('inboxReply',jsonb_build_object('attemptId',NEW.id,'operationId',NEW.operation_id),'providerAttempt',jsonb_build_object('pendingAt',clock_timestamp()::text))"))
    if n == 19:
        body = f"""
CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture projection failure'; END$$;
CREATE TRIGGER projection_fail BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId' IS NOT NULL) EXECUTE FUNCTION inbox_reply_test.fail_projection();
{started(n)} {accepted(n,'ext-19')} SELECT public.inbox_reply_reconcile_callback('sendillo','ext-19','delivered',jsonb_build_object('kind','delivered'));
DO $$ BEGIN IF (SELECT state FROM inbox_reply_send.attempts WHERE id='{x['a']}')<>'delivered' OR (SELECT count(*) FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}')<>1 THEN RAISE EXCEPTION 'T19 ledger edge did not commit'; END IF; END $$;
DROP TRIGGER projection_fail ON public.messages; SELECT inbox_reply_send.drain_message_projection_one(); DO $$ BEGIN IF (SELECT status FROM public.messages WHERE idempotency_key='{x['a']}')<>'delivered' THEN RAISE EXCEPTION 'T19 drain parity mismatch'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "EXCEPTION WHEN query_canceled OR others THEN", "EXCEPTION WHEN query_canceled OR others THEN RAISE;"))
    if n == 20:
        body = """
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES ('service_role'),('anon'),('authenticated'),('inbox_reply_send_worker')) AS roles(name) WHERE has_function_privilege(name,'inbox_reply_send.project_message(uuid,uuid)','EXECUTE') OR has_function_privilege(name,'inbox_reply_send.project_message_trigger()','EXECUTE') OR has_function_privilege(name,'inbox_reply_send.drain_message_projection_one()','EXECUTE')) THEN RAISE EXCEPTION 'T20 inner privilege'; END IF;
 IF NOT has_function_privilege('service_role','public.inbox_reply_drain_message_projection_one()','EXECUTE') OR has_function_privilege('anon','public.inbox_reply_drain_message_projection_one()','EXECUTE') THEN RAISE EXCEPTION 'T20 public drain grant'; END IF;
 IF has_function_privilege('service_role','inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb)','EXECUTE') OR NOT has_function_privilege('inbox_reply_send_worker','inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'T20 wrapper grants'; END IF;
END $$;"""
        return assert_case(n, body, "GRANT EXECUTE ON FUNCTION inbox_reply_send.project_message(uuid,uuid) TO service_role;")
    if n == 21:
        y = second_ids(n)
        body = f"""
CREATE SCHEMA inbox_reply_test;
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$ BEGIN IF EXISTS(SELECT 1 FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}') THEN RAISE EXCEPTION 'T21 claimed edge fabricated a marker'; END IF; END $$;
INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{y['o']}','{y['a']}','{y['op']}','{y['prep']}','{y['i']}',1,'{y['c']}','+12025550001','+12025550022',inbox_reply_send.body_hash('hello-{n}','+12025550001','+12025550022'),'approved');
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{y['o']}' AND id='{y['a']}';
UPDATE public.contacts SET phone_2='+12025550022',phone_2_type='mobile' WHERE id='{y['c']}';
INSERT INTO public.inbox_inbound_heads(org_id,conversation_id,revision) VALUES('{y['o']}','{y['conv']}',1);
INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{x['p']}','{x['o']}','sendillo','+12025550001','active');
UPDATE inbox_reply_review.admission SET enabled=true;
CREATE FUNCTION inbox_reply_test.disable_sender_after_marker() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN UPDATE public.provider_sender_numbers SET status='inactive' WHERE org_id=NEW.org_id AND provider='sendillo' AND phone_e164=NEW.from_e164; RETURN NEW; END$$;
CREATE TRIGGER zzz_t21_disable_sender_after_marker AFTER UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW WHEN (NEW.id='{y['a']}' AND NEW.state='dispatch_started') EXECUTE FUNCTION inbox_reply_test.disable_sender_after_marker();
SELECT inbox_reply_send.start_dispatch('{y['o']}','{y['a']}',1);
DROP TRIGGER zzz_t21_disable_sender_after_marker ON inbox_reply_send.attempts;
DO $$ DECLARE s text; e text; BEGIN SELECT state,evidence INTO s,e FROM inbox_reply_send.attempts WHERE id='{y['a']}'; IF s<>'skipped_ineligible' OR e<>'sender_unavailable' OR EXISTS(SELECT 1 FROM public.messages WHERE idempotency_key='{y['a']}') THEN RAISE EXCEPTION 'T21 IR001 recheck mismatch: %/%',s,e; END IF; END $$;"""
        mutation = mutate_chain("inbox_reply_send.project_message_trigger", [("IF NEW.state='dispatch_started' THEN", "IF NEW.state IN ('dispatch_started','claimed') THEN")])
        mutation += f""" DROP TRIGGER inbox_reply_message_projection ON inbox_reply_send.attempts; CREATE TRIGGER inbox_reply_message_projection AFTER UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW WHEN (NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN ('dispatch_started','claimed','provider_accepted','uncertain','confirmed_not_submitted','rejected_unsent','delivered','delivery_failed')) EXECUTE FUNCTION inbox_reply_send.project_message_trigger();"""
        return assert_case(n, body, mutation, items=2)
    if n == 22:
        older = ids(n + 1)
        body = f"""
{common_project_state(n,'uncertain')} INSERT INTO public.messages(id,org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,from_address,to_address,created_at)
VALUES('{older['i']}','{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','outbound','bounced','sendillo','older bounced','+12025550001','+12025550101','2026-01-01T00:00:00Z');
INSERT INTO auth.users(id,email) VALUES('{x['c']}','history-{n}@example.test'); INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{x['c']}','{x['o']}','owner','active'); SELECT set_config('request.jwt.claim.role','authenticated',true); SELECT set_config('request.jwt.claim.sub','{x['c']}',true);
DO $$ DECLARE d jsonb; v jsonb; BEGIN
 SELECT inbox_authenticated_detail.detail('{x['o']}','{x['conv']}') INTO d;
 IF jsonb_array_length(d->'history')<>2 OR d->'history'->0->>'status' NOT IN ('failed','bounced') OR d->'history'->0->>'delivery' IS DISTINCT FROM 'not_confirmed' OR d->'history'->1->>'status' IS DISTINCT FROM 'bounced' OR d->'history'->1->>'delivery' IS DISTINCT FROM 'failed' THEN RAISE EXCEPTION 'T22 detail ordering/mapping mismatch: %',d; END IF;
 SELECT inbox_authenticated_detail.detail_v2('{x['o']}','{x['conv']}') INTO v;
 IF jsonb_array_length(v->'history')<>2 OR v->'history'->0->>'delivery' IS DISTINCT FROM 'not_confirmed' OR v->'history'->1->>'delivery' IS DISTINCT FROM 'failed' THEN RAISE EXCEPTION 'T22 detail_v2 mapping mismatch: %',v; END IF;
END $$;"""
        delivery_projection = """'status',b.status,'delivery',
   CASE WHEN b.direction='inbound' THEN 'delivered'
    WHEN b.status IN ('pending','queued') THEN 'sending'
    WHEN b.status='failed' AND b.metadata->>'providerOutcome'='provider_unknown' THEN 'not_confirmed'
    WHEN b.status IN ('sent','delivered') THEN b.status
    WHEN b.status IN ('failed','bounced') THEN 'failed'
    ELSE 'failed' END)"""
        detail_body = fn_body("inbox_authenticated_detail.detail")
        if delivery_projection not in detail_body:
            raise RuntimeError("T22 delivery projection mutation target not found")
        return assert_case(n, body, detail_body.replace(delivery_projection, "'status',b.status)", 1))
    if n == 23:
        body = f"""
{started(n)} DO $$ DECLARE m jsonb; BEGIN SELECT metadata INTO m FROM public.messages WHERE idempotency_key='{x['a']}'; IF m IS DISTINCT FROM jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')) THEN RAISE EXCEPTION 'T23 pending metadata parity mismatch'; END IF; END $$;
{accepted(n,'ext-23')} DO $$ DECLARE m jsonb; BEGIN SELECT metadata INTO m FROM public.messages WHERE idempotency_key='{x['a']}'; IF m IS DISTINCT FROM jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}'),'providerStatus','sent') THEN RAISE EXCEPTION 'T23 accepted metadata parity mismatch'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message", "jsonb_build_object('inboxReply',marker)", "jsonb_build_object('inboxReply',marker,'generated_by','reply')"))
    if n in {24,25,26,27}:
        return drip_case(n)
    raise KeyError(n)


def drip_snapshot(n: int, x: dict[str, str]) -> str:
    return f"SET LOCAL ROLE authenticated; SELECT set_config('request.jwt.claim.role','authenticated',true); SELECT set_config('request.jwt.claim.sub','{x['c']}',true); SELECT (public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,null)->'rows'->0->>'drip_replied')::boolean; RESET ROLE;"


def drip_flag_assert(n: int, x: dict[str, str], expected: str, label: str) -> str:
    return f"""
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','{x['c']}',true);
DO $$ DECLARE flag boolean; BEGIN
 SELECT (public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,null)->'rows'->0->>'drip_replied')::boolean INTO flag;
 IF flag IS DISTINCT FROM {expected} THEN RAISE EXCEPTION '{label}: %',flag; END IF;
END $$;
RESET ROLE;
"""


def workspace_send(n: int, reference: str) -> str:
    x = ids(n)
    return f"""
CREATE TEMP TABLE transport_calls(c integer NOT NULL);
INSERT INTO transport_calls VALUES(0);
UPDATE inbox_reply_review.admission SET enabled=true;
UPDATE inbox_control.command_admission SET enabled=true,cohort_mode='all' WHERE command_family='reply_accept';
SELECT set_config('request.jwt.claims',jsonb_build_object('sub','{x['c']}','role','authenticated','session_id','{x['token']}','exp','4102444800')::text,true);
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','{x['c']}',true);
INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{x['p']}','{x['o']}','sendillo','+12025550001','active');
DO $$ DECLARE prep_key uuid; accepted_row jsonb; op uuid; att uuid; claim jsonb; dispatch jsonb; persisted jsonb; calls integer;
BEGIN
 SELECT request_key INTO prep_key FROM inbox_reply_review.preparations WHERE id='{x['prep']}';
 accepted_row:=public.inbox_accept_reply('{x['prep']}',prep_key);
 op:=(accepted_row->>'operation_id')::uuid;
 SELECT id INTO att FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND operation_id=op ORDER BY attempt_ordinal,item_id LIMIT 1;
 SELECT inbox_reply_send.worker_claim('{x['o']}',att,60) INTO claim;
 SELECT inbox_reply_send.worker_start_dispatch('{x['o']}',att,(claim->>'generation')::bigint) INTO dispatch;
 IF dispatch->>'kind' IS DISTINCT FROM 'dispatch' THEN RAISE EXCEPTION 'workspace send did not dispatch: %',dispatch; END IF;
 UPDATE transport_calls SET c=c+1;
 SELECT inbox_reply_send.worker_persist_result('{x['o']}',att,(dispatch->>'token')::uuid,jsonb_build_object('kind','accepted','externalId','{reference}','status','sent')) INTO persisted;
 SELECT c INTO calls FROM transport_calls;
 IF persisted->>'state' IS DISTINCT FROM 'provider_accepted' OR calls<>1 THEN RAISE EXCEPTION 'workspace send persistence mismatch: %/%',persisted,calls; END IF;
END $$;
"""


def drip_case(n: int) -> tuple[str, str]:
    x = ids(n)
    if n == 24:
        body = drip_fixture(n) + workspace_send(n, 'ext-24') + drip_flag_assert(n,x,'false','T24 pending send did not clear drip flag') + """SELECT public.inbox_reply_reconcile_callback('sendillo','ext-24','delivery_failed',jsonb_build_object('kind','failed')); DO $$ DECLARE flag boolean; BEGIN SELECT (public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,null)->'rows'->0->>'drip_replied')::boolean INTO flag; IF flag IS DISTINCT FROM true THEN RAISE EXCEPTION 'T24 failure did not restore drip flag'; END IF; END $$;"""
        return fixture(n, body, seed_attempt=False), install_mutated_function("inbox_reply_send.project_message", "WHEN 'delivery_failed' THEN 'failed'", "WHEN 'delivery_failed' THEN 'sent'")
    if n == 25:
        body = drip_fixture(n) + common_project_state(n,'uncertain') + f"""SELECT set_config('request.jwt.claim.role','authenticated',true); SELECT set_config('request.jwt.claim.sub','{x['c']}',true); SELECT public.inbox_reply_reconcile_callback('sendillo','unknown-25','delivered',jsonb_build_object('kind','delivered')); DO $$ DECLARE s text; flag boolean; BEGIN SELECT state INTO s FROM inbox_reply_send.attempts WHERE id='{x['a']}'; SELECT (public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,null)->'rows'->0->>'drip_replied')::boolean INTO flag; IF s<>'uncertain' OR flag IS DISTINCT FROM true THEN RAISE EXCEPTION 'T25 uncertain callback promoted'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.project_message", "WHEN 'uncertain' THEN 'failed'", "WHEN 'uncertain' THEN 'pending'"))
    if n == 26:
        body = drip_fixture(n) + common_project_state(n,'uncertain') + f"""SELECT set_config('request.jwt.claim.role','authenticated',true); SELECT set_config('request.jwt.claim.sub','{x['c']}',true); SELECT inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','accepted','externalId','ext-26','status','sent')); SELECT public.inbox_reply_reconcile_callback('sendillo','ext-26','delivered',jsonb_build_object('kind','delivered')); DO $$ DECLARE s text; flag boolean; BEGIN SELECT state INTO s FROM inbox_reply_send.attempts WHERE id='{x['a']}'; SELECT (public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,null)->'rows'->0->>'drip_replied')::boolean INTO flag; IF s<>'delivered' OR flag IS DISTINCT FROM false THEN RAISE EXCEPTION 'T26 accepted callback mismatch'; END IF; END $$;"""
        return assert_case(n, body, install_mutated_function("inbox_reply_send.worker_persist_result", "ELSIF row.state='uncertain' AND kind='not_attempted' THEN", "ELSIF row.state='uncertain' AND kind IN ('not_attempted','accepted') THEN"))
    body = drip_fixture(n) + workspace_send(n, 'ext-27') + f"""DO $$ DECLARE flag boolean; c integer; BEGIN SELECT (public.sms_inbox_thread_page_snapshot(now()-interval '90 days','all',null,null,false,500,0,null)->'rows'->0->>'drip_replied')::boolean INTO flag; SELECT count(*) INTO c FROM public.messages WHERE org_id='{x['o']}' AND metadata->'inboxReply'->>'attemptId' IS NOT NULL; IF c<>1 OR flag IS NOT FALSE THEN RAISE EXCEPTION 'T27 workspace-send gate mismatch'; END IF; END $$;"""
    return fixture(n, body, seed_attempt=False), "DROP TRIGGER inbox_reply_message_projection ON inbox_reply_send.attempts;"


def concurrency_setup(n: int) -> str:
    x = ids(n)
    if n == 9:
        body = f"""
CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_once() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture projection fault'; END$$;
CREATE TRIGGER fail_once BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId'='{x['a']}') EXECUTE FUNCTION inbox_reply_test.fail_once();
{started(n)}{accepted(n,'ext-9')} DROP TRIGGER fail_once ON public.messages;
CREATE FUNCTION inbox_reply_test.pause_message() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(9009); RETURN NEW; END$$;
CREATE TRIGGER pause_message BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId'='{x['a']}') EXECUTE FUNCTION inbox_reply_test.pause_message();
"""
        return fixture(n,body).replace("ROLLBACK;","COMMIT;")
    if n == 10:
        body = f"""
CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture persistent projection fault'; END$$;
CREATE TRIGGER fail_projection BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId'='{x['a']}') EXECUTE FUNCTION inbox_reply_test.fail_projection();
{started(n)}{accepted(n,'ext-10')} DROP TRIGGER fail_projection ON public.messages; DELETE FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}';
CREATE FUNCTION inbox_reply_test.pause_backlog() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(9010); RETURN NEW; END$$;
CREATE TRIGGER pause_backlog BEFORE UPDATE ON inbox_reply_send.message_projection_backlog FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.pause_backlog();"""
        return fixture(n,body).replace("ROLLBACK;","COMMIT;")
    y = second_ids(n)
    if n == 11:
        body = f"""
CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture projection fault'; END$$;
CREATE TRIGGER fail_projection BEFORE UPDATE OF status ON public.messages FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.fail_projection();
INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{y['o']}','{y['a']}','{y['op']}','{y['prep']}','{y['i']}',1,'{y['c']}','+12025550001','+1202555{n+1:04d}',inbox_reply_send.body_hash('hello-{n}','+12025550001','+1202555{n+1:04d}'),'approved');
{started(n)}{accepted(n,'ext-11-a')}{started(n,attempt=y)}{accepted(n,'ext-11-b',attempt=y)} DROP TRIGGER fail_projection ON public.messages;
CREATE FUNCTION inbox_reply_test.pause_second() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN PERFORM pg_advisory_xact_lock(9011); RETURN NEW; END$$;
CREATE TRIGGER pause_second BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId'='{y['a']}') EXECUTE FUNCTION inbox_reply_test.pause_second();"""
        return fixture(n,body,items=2).replace("ROLLBACK;","COMMIT;")
    body = f"""
INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{y['o']}','{y['a']}','{y['op']}','{y['prep']}','{y['i']}',1,'{y['c']}','+12025550001','+1202555{n+1:04d}',inbox_reply_send.body_hash('hello-{n}','+12025550001','+1202555{n+1:04d}'),'approved');
{started(n)}{accepted(n,'ext-13-a')}{started(n,attempt=y)}{accepted(n,'ext-13-b',attempt=y)} DELETE FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}';
INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version,tries,next_try_at) VALUES('{x['o']}','{x['a']}',1,1,clock_timestamp()+interval '1 hour'),('{y['o']}','{y['a']}',1,0,clock_timestamp());"""
    return fixture(n,body,items=2).replace("ROLLBACK;","COMMIT;")


def session(app: str, sql: str) -> subprocess.Popen[str]:
    proc = subprocess.Popen(["psql","-XqAt","-v","ON_ERROR_STOP=1","-h",PGHOST,"-p",PGPORT,"-U","postgres","-d","postgres"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1, env={**os.environ,"PYTHONDONTWRITEBYTECODE":"1","PGAPPNAME":app})
    assert proc.stdin
    proc.stdin.write(sql + "\n")
    proc.stdin.flush()
    return proc


def finish_session(proc: subprocess.Popen[str], commit: bool = True) -> str:
    assert proc.stdin
    proc.stdin.write(("COMMIT;" if commit else "ROLLBACK;") + "\n\\q\n")
    proc.stdin.flush()
    stdout, stderr = proc.communicate(timeout=30)
    return (stderr + stdout).strip()


def wait_activity(app: str, *, wait_event: str | None = None) -> tuple[int, str]:
    deadline = time.time() + 5
    while time.time() < deadline:
        row = psql(f"SELECT pid || '|' || coalesce(backend_xid::text,'') || '|' || coalesce(wait_event_type,'') || '|' || coalesce(wait_event,'') FROM pg_stat_activity WHERE application_name='{app}' AND pid<>pg_backend_pid();")
        value = row.stdout.strip()
        if value:
            parts = value.split("|", 3)
            observed = f"{parts[2]}/{parts[3]}"
            if wait_event is None or observed == wait_event or parts[2] == wait_event or parts[3] == wait_event:
                return int(parts[0]), parts[1]
        time.sleep(.05)
    raise AssertionError(f"session {app} did not reach activity state {wait_event!r}")


def wait_advisory(app: str, key: int) -> None:
    deadline = time.time() + 5
    while time.time() < deadline:
        row = psql(f"SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='{app}' AND l.locktype='advisory' AND l.granted AND l.objid={key};")
        if row.stdout.strip() == "1": return
        time.sleep(.05)
    raise AssertionError(f"session {app} did not acquire advisory lock {key}")


def cleanup(n: int) -> None:
    x = ids(n)
    extra_owner = f" DELETE FROM auth.users WHERE id='{ids(n + 1)['c']}';" if n == 13 else ""
    psql(f"""
DROP SCHEMA IF EXISTS inbox_reply_test CASCADE;
SET session_replication_role='replica';
DELETE FROM inbox_reply_send.message_projection_backlog WHERE org_id='{x['o']}';
DELETE FROM inbox_reply_send.dispatch_outbox WHERE org_id='{x['o']}';
DELETE FROM inbox_reply_send.callback_receipts WHERE org_id='{x['o']}';
DELETE FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND (provider_reference LIKE 'ext-{n}-%' OR provider_reference='ext-{n}');
DELETE FROM inbox_reply_send.attempts WHERE org_id='{x['o']}'; DELETE FROM inbox_reply_send.operations WHERE org_id='{x['o']}'; DELETE FROM inbox_reply_review.preparations WHERE org_id='{x['o']}';
DELETE FROM inbox_inbound_heads WHERE org_id='{x['o']}';
DELETE FROM public.messages WHERE org_id='{x['o']}'; DELETE FROM public.memberships WHERE org_id='{x['o']}'; DELETE FROM provider_sender_numbers WHERE org_id='{x['o']}'; DELETE FROM sequence_enrollments WHERE org_id='{x['o']}'; DELETE FROM sequences WHERE org_id='{x['o']}'; DELETE FROM public.properties WHERE org_id='{x['o']}'; DELETE FROM consent_events WHERE contact_id='{x['c']}'; DELETE FROM public.contacts WHERE org_id='{x['o']}'; DELETE FROM organizations WHERE id='{x['o']}'; DELETE FROM auth.users WHERE id='{x['c']}';{extra_owner}""")


def concurrency_case(n: int) -> tuple[str, str]:
    setup = concurrency_setup(n)
    if n in {9,10}: mutation = mutate_chain("inbox_reply_send.drain_message_projection_one", [(" FOR UPDATE", ""),(" FOR UPDATE", "")])
    elif n == 11:
        mutation = mutate_chain(
            "inbox_reply_send.drain_message_projection_one",
            [
                (
                    "RETURN jsonb_build_object('drained',true,'projected',true,'attempt_id',key_row.attempt_id);",
                    "PERFORM inbox_reply_send.drain_message_projection_one(); RETURN jsonb_build_object('drained',true,'projected',true,'attempt_id',key_row.attempt_id);",
                ),
            ],
        )
    else: mutation = mutate_chain("inbox_reply_send.drain_message_projection_one", [("WHERE b.next_try_at<=clock_timestamp()", "WHERE true"),("ORDER BY b.next_try_at,b.attempt_id", "ORDER BY b.attempt_id")])
    return setup, mutation


def run_concurrency(n: int, mutated: bool) -> tuple[bool, str]:
    setup, mutation = concurrency_case(n)
    original = fn_body("inbox_reply_send.drain_message_projection_one")
    sessions: list[subprocess.Popen[str]] = []
    try:
        if mutated: psql("BEGIN;" + mutation + "COMMIT;", check=True)
        psql(setup, check=True)
        x = ids(n)
        if n == 9:
            holder = session("r2-t9-holder", "BEGIN; SELECT pg_advisory_xact_lock(9009);")
            sessions.append(holder)
            wait_activity("r2-t9-holder"); wait_advisory("r2-t9-holder",9009)
            drain = session("r2-t9-drain", "BEGIN; SELECT inbox_reply_send.drain_message_projection_one();")
            sessions.append(drain)
            wait_activity("r2-t9-drain", wait_event="Lock/advisory")
            blocked = psql(f"BEGIN; SET LOCAL lock_timeout='1s'; DO $$ DECLARE c text; BEGIN PERFORM inbox_reply_send.reconcile_delivery('{x['o']}','sendillo','ext-9','delivered','{{}}'::jsonb); RAISE EXCEPTION 'T9 callback unexpectedly committed'; EXCEPTION WHEN lock_not_available THEN GET STACKED DIAGNOSTICS c=RETURNED_SQLSTATE; IF c<>'55P03' THEN RAISE EXCEPTION 'T9 SQLSTATE %',c; END IF; END $$; ROLLBACK;")
            if blocked.returncode != 0: raise AssertionError(output(blocked))
            finish_session(holder); finish_session(drain)
            psql(f"SELECT inbox_reply_send.reconcile_delivery('{x['o']}','sendillo','ext-9','delivered','{{}}'::jsonb);",check=True)
            final = psql(f"SELECT (SELECT state FROM inbox_reply_send.attempts WHERE id='{x['a']}') || ':' || (SELECT status FROM public.messages WHERE idempotency_key='{x['a']}') || ':' || (SELECT count(*) FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}');",check=True)
            if final.stdout.strip() != "delivered:delivered:0": raise AssertionError("T9 final parity mismatch")
            return True, output(blocked)
        if n == 10:
            holder = session("r2-t10-holder", "BEGIN; SELECT pg_advisory_xact_lock(9010);")
            sessions.append(holder)
            wait_activity("r2-t10-holder"); wait_advisory("r2-t10-holder",9010)
            drain = session("r2-t10-drain", "BEGIN; SELECT txid_current(); SELECT inbox_reply_send.drain_message_projection_one();")
            sessions.append(drain)
            drain_pid, drain_xid = wait_activity("r2-t10-drain", wait_event="Lock/advisory")
            reconcile = session("r2-t10-reconcile", f"BEGIN; SELECT inbox_reply_send.reconcile_delivery('{x['o']}','sendillo','ext-10','delivered','{{}}'::jsonb);")
            sessions.append(reconcile)
            rec_pid, _ = wait_activity("r2-t10-reconcile", wait_event="Lock/transactionid")
            major = int(psql("SELECT current_setting('server_version_num')::int/10000;", check=True).stdout.strip())
            if major != 17:
                finish_session(holder); finish_session(drain); finish_session(reconcile)
                return True, f"T10 SKIP: granted tuple-lock assertion is pinned to PostgreSQL major 17; observed major {major}"
            lock_sql = f"SELECT jsonb_build_object('blockers',pg_blocking_pids({rec_pid}),'locks',coalesce(jsonb_agg(jsonb_build_object('locktype',l.locktype,'granted',l.granted,'transactionid',l.transactionid::text,'relation',l.relation::regclass::text)),'[]'::jsonb)) FROM pg_locks l WHERE l.pid={rec_pid};"
            lock = json.loads(psql(lock_sql,check=True).stdout.strip())
            locks = lock["locks"]
            if lock["blockers"] != [drain_pid] or not any(v["locktype"]=="transactionid" and not v["granted"] and v["transactionid"]==drain_xid for v in locks) or not any(v["locktype"]=="tuple" and v["granted"] and v["relation"]=="inbox_reply_send.attempts" for v in locks): raise AssertionError(f"T10 lock evidence mismatch: {lock}")
            finish_session(holder); finish_session(drain); finish_session(reconcile)
            return True, json.dumps(lock,sort_keys=True)
        if n == 11:
            holder = session("r2-t11-holder", "BEGIN; SELECT pg_advisory_xact_lock(9011);")
            sessions.append(holder)
            wait_activity("r2-t11-holder"); wait_advisory("r2-t11-holder",9011)
            candidate = psql(f"SELECT attempt_id FROM inbox_reply_send.message_projection_backlog WHERE next_try_at<=clock_timestamp() ORDER BY next_try_at,attempt_id LIMIT 1;", check=True)
            if candidate.stdout.strip() != x['a']: raise AssertionError(f"T11 item one was not first due item: {candidate.stdout.strip()}")
            drain = session("r2-t11-drain", "SELECT inbox_reply_send.drain_message_projection_one(); BEGIN; SELECT inbox_reply_send.drain_message_projection_one();")
            sessions.append(drain)
            wait_activity("r2-t11-drain", wait_event="Lock/advisory")
            callback = psql(f"""
BEGIN;
SET LOCAL lock_timeout='1s';
DO $$ DECLARE result jsonb; code text;
BEGIN
 BEGIN
  SELECT inbox_reply_send.reconcile_delivery('{x['o']}','sendillo','ext-11-a','delivered','{{}}'::jsonb) INTO result;
  RAISE NOTICE 'T11_CALLBACK_RESULT=%',result;
 EXCEPTION WHEN lock_not_available THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;
  RAISE NOTICE 'T11_CALLBACK_SQLSTATE=%',code;
 END;
END $$;
ROLLBACK;
""")
            callback_text = output(callback)
            if 'T11_CALLBACK_SQLSTATE=55P03' in callback_text: raise AssertionError(f"T11_CALLBACK_SQLSTATE=55P03 (unexpected callback lock failure): {callback_text}")
            if 'T11_CALLBACK_RESULT=' not in callback_text or 'delivered' not in callback_text: raise AssertionError(f"T11 callback did not succeed: {callback_text}")
            finish_session(holder); finish_session(drain)
            first_backlog = psql(f"SELECT count(*) FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}';", check=True)
            if first_backlog.stdout.strip() != "0": raise AssertionError(f"T11 item one backlog remained after drain session: {first_backlog.stdout.strip()}")
            return True, output(callback)
        y = second_ids(n)
        drained = psql("SELECT inbox_reply_send.drain_message_projection_one();",check=True)
        state = psql(f"SELECT (SELECT tries FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{x['a']}') || ':' || (SELECT count(*) FROM inbox_reply_send.message_projection_backlog WHERE attempt_id='{y['a']}');",check=True)
        if not drained.stdout.strip().startswith('{"drained": true') or state.stdout.strip() != "1:0": raise AssertionError(f"T13 poison selection mismatch: {output(drained)} / {output(state)}")
        return True, output(drained)
    finally:
        for proc in sessions:
            if proc.poll() is None:
                try:
                    finish_session(proc)
                except Exception:
                    proc.kill()
                    proc.wait(timeout=5)
        if mutated: psql("BEGIN;" + original + "COMMIT;",check=True)
        cleanup(n)


def run_case(n: int, mutated: bool) -> tuple[bool, str]:
    if n == 17:
        return True, "T17 application status-events test is run by mutation-run.py"
    if n in {9,10,11,13}: return run_concurrency(n,mutated)
    sql, mutation = test_sql(n)
    if n in {24,25,26}:
        # This activation dependency is loaded from the merged commit, not
        # copied into this branch or rewritten as a stand-in.
        psql(merged_drips_migration(), check=True)
    if mutated:
        if "-- MUTATION_POINT" in sql:
            sql = sql.replace("-- MUTATION_POINT", mutation, 1)
        else:
            sql = sql.replace("SET LOCAL client_min_messages='warning';\n", "SET LOCAL client_min_messages='warning';\n" + mutation + "\n", 1)
    result = psql(sql)
    return result.returncode == 0, output(result) or "no output"


def main() -> int:
    mutated = "--mutated" in sys.argv[1:]
    requested = [int(arg[1:]) for arg in sys.argv[1:] if arg.startswith("T")]
    tests = requested or list(range(1,28))
    failures = 0
    for n in tests:
        try: ok,line = run_case(n,mutated)
        except Exception as error: ok,line = False,f"{type(error).__name__}: {error}"
        print(f"T{n} {'PASS' if ok else 'FAIL'} {'mutated' if mutated else 'unmutated'} {line.splitlines()[-1] if line else 'no output'}")
        if not ok and os.environ.get("PROJECTION_VERBOSE_FAILURES") == "1":
            print(f"T{n} raw failure output:")
            print(line)
        failures += not ok
    return 1 if failures else 0


if __name__ == "__main__": raise SystemExit(main())
