#!/usr/bin/env python3
"""Local, rollback-only proof harness for RULING REPLY-PERSISTENCE v5.

This file intentionally talks only to the disposable PostgreSQL cluster named
by PROJECTION_PGHOST/PROJECTION_PGPORT. It never contacts Supabase, a pooler,
Sendillo, or any provider. Each case runs in one transaction and rolls back.
The mutations are installed in that transaction only, so no mutation can be
left in the database or committed to the repository.
"""

import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "supabase/migrations/20260930040250_inbox_reply_message_projection.sql"
PGHOST = os.environ.get("PROJECTION_PGHOST", "/tmp/sandra-reply-persist-pg.pPmk5e/socket")
PGPORT = os.environ.get("PROJECTION_PGPORT", "55436")


def psql(sql: str, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", PGHOST, "-p", PGPORT, "-U", "postgres", "-d", "postgres"],
        input=sql,
        text=True,
        capture_output=True,
        timeout=timeout,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def fn_body(name: str) -> str:
    source = MIGRATION.read_text()
    match = re.search(rf"CREATE(?: OR REPLACE)? FUNCTION {re.escape(name)}\(.*?END \$\$;", source, re.S)
    if not match:
        raise RuntimeError(f"could not extract {name}")
    return re.sub(r"^CREATE(?: OR REPLACE)? ", "CREATE OR REPLACE ", match.group(0))


def install_mutated_function(name: str, old: str, new: str) -> str:
    body = fn_body(name)
    if old not in body:
        raise RuntimeError(f"mutation text not found in {name}: {old!r}")
    return body.replace(old, new, 1)


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


def fixture(n: int, body: str, *, mutation: str = "", items: int = 1) -> str:
    x = ids(n)
    item_values = []
    for offset in range(items):
        item = f"{int(n) + offset:02x}"
        item_phone = "101" if offset == 0 else f"{int(n) + offset:03d}"
        item_values.append(
            f"jsonb_build_object('id','44444444-0000-4000-8000-0000000000{item}'::uuid,"
            f"'target',jsonb_build_object('kind','conversation','id','88888888-0000-4000-8000-0000000000{item}'::uuid),"
            f"'recipient',jsonb_build_object('contactId','{x['c']}'::uuid,'from','+12025550001','to','+1202555{item_phone.zfill(4)}', 'propertyId','{x['p']}'::uuid,'renderedBody','hello-{n}'),"
            "'validUntil','2999-01-01T00:00:00Z','state','MO','dependencies',jsonb_build_object('head',1))",
        )
    items_sql = "jsonb_build_array(" + ",".join(item_values) + ")"
    marker = f"""
UPDATE inbox_reply_send.attempts
SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute'
WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts
SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL
WHERE org_id='{x['o']}' AND id='{x['a']}';
"""
    return f"""
BEGIN;
SET LOCAL client_min_messages='warning';
INSERT INTO organizations(id,name) VALUES('{x['o']}','projection-test-{n}');
INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{x['c']}','{x['o']}','Projection','+12025550101','mobile');
INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{x['p']}','{x['o']}','Projection Test {n}','MO','{x['c']}');
INSERT INTO inbox_reply_review.preparations(id,org_id,requester_id,request_key,input_hash,canonical_input,items,expires_at)
VALUES('{x['prep']}','{x['o']}','{x['c']}',gen_random_uuid(),'x','{{}}',{items_sql},clock_timestamp()+interval '1 hour');
INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key)
VALUES('{x['o']}','{x['op']}','{x['c']}','{x['prep']}',gen_random_uuid());
INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
VALUES('{x['o']}','{x['a']}','{x['op']}','{x['prep']}','{x['i']}',1,'{x['c']}','+12025550001','+12025550101',inbox_reply_send.body_hash('hello-{n}','+12025550001','+12025550101'),'approved');
{mutation}
{body}
ROLLBACK;
"""


def case(n: int, body: str, mutation: str = "", items: int = 1) -> tuple[str, str]:
    return fixture(n, body, items=items), mutation


def common_project_state(n: int, state: str, *, evidence: str = "", reference: str = "") -> str:
    x = ids(n)
    if state == "uncertain":
        fields = "state='uncertain',evidence='transport_timeout'"
    elif state == "provider_accepted":
        fields = f"state='provider_accepted',provider_reference='{reference or 'ext-1'}',provider_status='sent'"
    elif state == "delivered":
        fields = f"state='delivered',provider_reference='{reference or 'ext-1'}',provider_status='delivered'"
    elif state == "delivery_failed":
        fields = f"state='delivery_failed',provider_reference='{reference or 'ext-1'}',provider_status='failed',evidence='{evidence or 'provider_rejected'}'"
    else:
        raise ValueError(state)
    followup = ""
    if state in {"delivered", "delivery_failed"}:
        followup = f"UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='{reference or 'ext-1'}',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';\n"
    return f"""
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL WHERE org_id='{x['o']}' AND id='{x['a']}';
{followup}
UPDATE inbox_reply_send.attempts SET {fields},receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';
"""


def mutation_drop_trigger(n: int) -> str:
    return "DROP TRIGGER inbox_reply_message_projection ON inbox_reply_send.attempts;"


def test_sql(n: int) -> tuple[str, str]:
    x = ids(n)
    if n == 1:
        return case(n, f"""{common_project_state(n, 'provider_accepted', reference='ext-1')}
DO $$BEGIN IF (SELECT count(*) FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}')<>1 OR (SELECT status FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}')<>'sent' THEN RAISE EXCEPTION 'T1 marker/projection shape mismatch'; END IF; END$$;""", mutation_drop_trigger(n))
    if n == 2:
        return case(n, f"""{common_project_state(n, 'uncertain')}
DO $$DECLARE m jsonb;BEGIN SELECT to_jsonb(messages) INTO m FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}'; IF m->>'status'<>'failed' OR m->'metadata'->>'providerOutcome'<>'provider_unknown' THEN RAISE EXCEPTION 'T2 expected failed/provider_unknown, got %',m; END IF; END$$;""", install_mutated_function("inbox_reply_send.project_message", "WHEN 'uncertain' THEN 'failed'", "WHEN 'uncertain' THEN 'sent'"))
    if n == 5:
        return case(n, f"""{common_project_state(n, 'uncertain')}
DO $$DECLARE r jsonb;BEGIN SELECT inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch')) INTO r; IF r->>'state' IS DISTINCT FROM 'uncertain' THEN RAISE EXCEPTION 'T5 uncertain replay mismatch: %',r; END IF; END$$;""", install_mutated_function("inbox_reply_send.worker_persist_result", "ELSIF row.state='uncertain' AND kind='not_attempted' THEN", "ELSIF false THEN"))
    if n == 6:
        fault = """CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.cancel_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture cancel' USING ERRCODE='57014'; END$$; CREATE TRIGGER projection_cancel BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId' IS NOT NULL) EXECUTE FUNCTION inbox_reply_test.cancel_projection();"""
        body = f"""{fault}
{common_project_state(n, 'provider_accepted', reference='ext-6')}
DO $$DECLARE s text;BEGIN SELECT state INTO s FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}'; IF s<>'provider_accepted' OR (SELECT count(*) FROM inbox_reply_send.message_projection_backlog WHERE org_id='{x['o']}' AND attempt_id='{x['a']}')<>1 THEN RAISE EXCEPTION 'T6 cancellation swallowed wrong boundary'; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "WHEN query_canceled OR others THEN", "WHEN others THEN"))
    if n == 7:
        fault = """CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_backlog() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture backlog failure'; END$$; CREATE TRIGGER backlog_fail BEFORE INSERT ON inbox_reply_send.message_projection_backlog FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.fail_backlog();"""
        x = ids(n)
        body = f"""{fault}
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$BEGIN BEGIN UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='ext-7',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}'; EXCEPTION WHEN OTHERS THEN NULL; END; END$$;
DROP TRIGGER backlog_fail ON inbox_reply_send.message_projection_backlog;
UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='ext-7',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$BEGIN IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}')<>'provider_accepted' OR (SELECT status FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}')<>'sent' THEN RAISE EXCEPTION 'T7 retry did not commit ledger plus projection'; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version)\n VALUES(NEW.org_id,NEW.id,NEW.receipt_version)\n ON CONFLICT(org_id,attempt_id) DO UPDATE SET wanted_version=EXCLUDED.wanted_version;", "BEGIN INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version) VALUES(NEW.org_id,NEW.id,NEW.receipt_version) ON CONFLICT(org_id,attempt_id) DO UPDATE SET wanted_version=EXCLUDED.wanted_version; EXCEPTION WHEN others THEN NULL; END;"))
    if n == 8:
        fault = """CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_once() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture projection failure'; END$$; CREATE TRIGGER projection_fail BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.status='sent') EXECUTE FUNCTION inbox_reply_test.fail_once();"""
        body = f"""{fault}
UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$BEGIN BEGIN UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='ext-8',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}'; EXCEPTION WHEN OTHERS THEN NULL; END; END$$;
DROP TRIGGER projection_fail ON public.messages;
UPDATE inbox_reply_send.attempts SET state='delivered',provider_reference='ext-8',provider_status='delivered',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$DECLARE m jsonb;BEGIN SELECT to_jsonb(messages) INTO m FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}'; IF m->>'status' IS DISTINCT FROM 'delivered' OR m->>'external_id' IS DISTINCT FROM 'ext-8' OR m->'metadata' ? 'providerOutcome' OR m->>'delivered_at' IS NULL THEN RAISE EXCEPTION 'T8 full snapshot mismatch: %',m; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message", "projected_external_id:=CASE WHEN row.state IN ('provider_accepted','delivered','delivery_failed') THEN row.provider_reference ELSE NULL END;", "projected_external_id:=NULL;"))
    if n == 9:
        return case(n, f"""{common_project_state(n, 'provider_accepted', reference='ext-9')}
DO $$DECLARE d text:=pg_get_functiondef('inbox_reply_send.drain_message_projection_one()'::regprocedure);BEGIN IF length(d)-length(replace(d,'FOR UPDATE',''))<>20 THEN RAISE EXCEPTION 'T9 both step-2 locks absent'; END IF; END$$;""", install_mutated_function("inbox_reply_send.drain_message_projection_one", " FOR UPDATE", ""))
    if n == 10:
        return case(n, """DO $$DECLARE d text:=pg_get_functiondef('inbox_reply_send.drain_message_projection_one()'::regprocedure);BEGIN IF length(d)-length(replace(d,'FOR UPDATE',''))<>20 THEN RAISE EXCEPTION 'T10 attempt and backlog locks absent'; END IF; END$$;""", install_mutated_function("inbox_reply_send.drain_message_projection_one", " FOR UPDATE", ""))
    if n == 11:
        return case(n, """DO $$DECLARE d text:=pg_get_functiondef('inbox_reply_send.drain_message_projection_one()'::regprocedure);BEGIN IF position('LIMIT 1' IN d)=0 THEN RAISE EXCEPTION 'T11 drain is not one item'; END IF; END$$;""", install_mutated_function("inbox_reply_send.drain_message_projection_one", 'LIMIT 1', ''))
    if n == 12:
        body = f"""UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL WHERE org_id='{x['o']}' AND id='{x['a']}';
DELETE FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference='ext-12',provider_status='sent',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$DECLARE r jsonb;BEGIN SELECT inbox_reply_send.drain_message_projection_one() INTO r; IF r->>'projected' IS DISTINCT FROM 'false' OR (SELECT tries FROM inbox_reply_send.message_projection_backlog WHERE org_id='{x['o']}' AND attempt_id='{x['a']}') IS DISTINCT FROM 1 OR (SELECT last_code FROM inbox_reply_send.message_projection_backlog WHERE org_id='{x['o']}' AND attempt_id='{x['a']}') IS DISTINCT FROM 'P0001' THEN RAISE EXCEPTION 'T12 poison retry mismatch: %',r; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message", "IF changed<>1 THEN", "IF false THEN"))
    if n == 13:
        body = f"""INSERT INTO inbox_reply_send.message_projection_backlog(org_id,attempt_id,wanted_version,tries,next_try_at) SELECT '{x['o']}',id,0,1,clock_timestamp()+interval '1 hour' FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$DECLARE r jsonb;d text:=pg_get_functiondef('inbox_reply_send.drain_message_projection_one()'::regprocedure);BEGIN IF d NOT LIKE '%next_try_at<=clock_timestamp()%' OR d NOT LIKE '%ORDER BY b.next_try_at,b.attempt_id%' THEN RAISE EXCEPTION 'T13 due ordering contract absent'; END IF; SELECT inbox_reply_send.drain_message_projection_one() INTO r; IF r->>'reason' NOT IN ('empty','not_due') THEN RAISE EXCEPTION 'T13 picked poison row: %',r; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.drain_message_projection_one", "WHERE b.next_try_at<=clock_timestamp()", "WHERE true"))
    if n == 14:
        body = f"""INSERT INTO public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,idempotency_key,metadata,from_address,to_address) VALUES('{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','outbound','pending','sendillo','existing','{x['a']}',jsonb_build_object('fixture',true),'+12025550001','+12025550101');
DO $$DECLARE failed boolean:=false;BEGIN BEGIN {common_project_state(n, 'provider_accepted', reference='ext-14')} EXCEPTION WHEN unique_violation THEN failed:=true; END; IF NOT failed OR (SELECT state FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}')<>'approved' THEN RAISE EXCEPTION 'T14 marker conflict did not abort'; END IF; END$$;"""
        return case(n, body, "DROP INDEX public.messages_outbound_sms_idempotency_idx;")
    if n == 15:
        body = f"""INSERT INTO organizations(id,name) VALUES('aaaaaaaa-0000-4000-8000-0000000000{n:02x}','projection-decoy-org');
INSERT INTO public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,idempotency_key,metadata,from_address,to_address) VALUES
('{x['o']}','{x['c']}','{x['p']}','{x['conv']}','email','outbound','pending','sendillo','email-decoy','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550001','+12025550101'),
('{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','inbound','received','sendillo','inbound-decoy','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550101','+12025550001'),
('aaaaaaaa-0000-4000-8000-0000000000{n:02x}','{x['c']}','{x['p']}','{x['conv']}','sms','outbound','pending','sendillo','org-decoy','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550001','+12025550101');
{common_project_state(n, 'provider_accepted', reference='ext-15')}
DO $$BEGIN IF (SELECT status FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}' AND channel='sms' AND direction='outbound')<>'sent' THEN RAISE EXCEPTION 'T15 reply row was not projected'; END IF; IF (SELECT count(*) FROM public.messages WHERE metadata->'inboxReply'->>'attemptId'='{x['a']}' AND status='sent')<>1 THEN RAISE EXCEPTION 'T15 decoy matched'; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message", "AND m.channel='sms'", ""))
    if n == 18:
        body = f"""UPDATE inbox_reply_send.attempts SET state='claimed',generation=1,lease_until=clock_timestamp()+interval '1 minute' WHERE org_id='{x['o']}' AND id='{x['a']}';
UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token='{x['token']}',generation=1,lease_until=NULL WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$DECLARE m jsonb;BEGIN SELECT metadata INTO m FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}'; IF m ? 'providerAttempt' OR m->'inboxReply'->>'attemptId' IS DISTINCT FROM '{x['a']}' THEN RAISE EXCEPTION 'T18 marker metadata is not reply-only: %',m; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "jsonb_build_object('inboxReply',jsonb_build_object('attemptId',NEW.id,'operationId',NEW.operation_id))", "jsonb_build_object('inboxReply',jsonb_build_object('attemptId',NEW.id,'operationId',NEW.operation_id),'providerAttempt',jsonb_build_object('pendingAt',clock_timestamp()::text))"))
    if n == 19:
        fault = """CREATE SCHEMA inbox_reply_test; CREATE FUNCTION inbox_reply_test.fail_projection() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture projection failure'; END$$; CREATE TRIGGER projection_fail BEFORE UPDATE OF status ON public.messages FOR EACH ROW WHEN (NEW.metadata->'inboxReply'->>'attemptId' IS NOT NULL) EXECUTE FUNCTION inbox_reply_test.fail_projection();"""
        body = f"""{fault}
{common_project_state(n, 'provider_accepted', reference='ext-19')}
DO $$BEGIN IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}')<>'provider_accepted' OR (SELECT count(*) FROM inbox_reply_send.message_projection_backlog WHERE org_id='{x['o']}' AND attempt_id='{x['a']}')<>1 THEN RAISE EXCEPTION 'T19 ledger edge did not commit'; END IF; END$$;"""
        return case(n, body, install_mutated_function("inbox_reply_send.project_message_trigger", "EXCEPTION WHEN query_canceled OR others THEN\n  -- The savepoint is projection-only.", "EXCEPTION WHEN query_canceled OR others THEN\n  RAISE;\n  -- The savepoint is projection-only."))
    if n == 20:
        body = """DO $$DECLARE f boolean;BEGIN SELECT NOT has_function_privilege('service_role','inbox_reply_send.project_message(uuid,uuid)','EXECUTE') AND NOT has_function_privilege('anon','inbox_reply_send.project_message(uuid,uuid)','EXECUTE') AND NOT has_function_privilege('authenticated','inbox_reply_send.project_message(uuid,uuid)','EXECUTE') AND NOT has_function_privilege('inbox_reply_send_worker','inbox_reply_send.project_message(uuid,uuid)','EXECUTE') INTO f; IF NOT f THEN RAISE EXCEPTION 'T20 private projection grant'; END IF; IF NOT has_function_privilege('service_role','public.inbox_reply_drain_message_projection_one()','EXECUTE') THEN RAISE EXCEPTION 'T20 wrapper not granted'; END IF; IF has_function_privilege('service_role','inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'T20 worker wrapper leaked'; END IF; IF NOT has_function_privilege('inbox_reply_send_worker','inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'T20 worker wrapper not granted'; END IF; END$$;"""
        return case(n, body, "GRANT EXECUTE ON FUNCTION inbox_reply_send.project_message(uuid,uuid) TO service_role;")
    if n == 21:
        body = f"""DO $$BEGIN IF (SELECT count(*) FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}')<>0 THEN RAISE EXCEPTION 'T21 blocked attempt fabricated a row'; END IF; END$$;"""
        return case(n, body, f"INSERT INTO public.messages(org_id,contact_id,property_id,conversation_id,channel,direction,status,provider,body,idempotency_key,metadata,from_address,to_address) VALUES('{x['o']}','{x['c']}','{x['p']}','{x['conv']}','sms','outbound','pending','sendillo','blocked','{x['a']}',jsonb_build_object('inboxReply',jsonb_build_object('attemptId','{x['a']}','operationId','{x['op']}')),'+12025550001','+12025550101');")
    if n == 22:
        return case(n, f"""{common_project_state(n, 'uncertain')}
DO $$DECLARE d jsonb;fn text:=pg_get_functiondef('inbox_authenticated_detail.detail(uuid,uuid,timestamptz,uuid)'::regprocedure);BEGIN SELECT jsonb_build_object('status',m.status,'delivery',CASE WHEN m.status='failed' AND m.metadata->>'providerOutcome'='provider_unknown' THEN 'not_confirmed' END) INTO d FROM public.messages m WHERE m.org_id='{x['o']}' AND m.idempotency_key='{x['a']}'; IF d->>'status'<>'failed' OR d->>'delivery'<>'not_confirmed' OR position('delivery' IN fn)=0 THEN RAISE EXCEPTION 'T22 history mapping mismatch: %',d; END IF; END$$;""", install_mutated_function("inbox_authenticated_detail.detail", "'status',b.status,'delivery',", "'status',b.status,"))
    if n == 23:
        return case(n, f"""{common_project_state(n, 'provider_accepted', reference='ext-23')}
DO $$DECLARE m jsonb;BEGIN SELECT metadata INTO m FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}'; IF m ? 'generated_by' OR (SELECT count(*) FROM jsonb_object_keys(m))<>2 THEN RAISE EXCEPTION 'T23 reply metadata parity mismatch: %',m; END IF; END$$;""", install_mutated_function("inbox_reply_send.project_message", "jsonb_build_object('inboxReply',marker)", "jsonb_build_object('inboxReply',marker,'generated_by','reply')"))
    if n == 24:
        stand_in = """-- TEST-ONLY Drips stand-in. TODO: replace with the merged 20260930035000 body before activation.
CREATE FUNCTION pg_temp.drip_clears(pid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.messages WHERE property_id=pid AND direction='outbound' AND status IS DISTINCT FROM 'failed') $$;"""
        return case(n, f"""{stand_in}
{common_project_state(n, 'delivery_failed', reference='ext-24', evidence='provider_rejected')}
DO $$BEGIN IF pg_temp.drip_clears('{x['p']}') THEN RAISE EXCEPTION 'T24 failed reply cleared stand-in drip flag'; END IF; END$$;""", install_mutated_function("inbox_reply_send.project_message", "WHEN 'delivery_failed' THEN 'failed'", "WHEN 'delivery_failed' THEN 'sent'"))
    if n == 25:
        stand_in = """-- TEST-ONLY Drips stand-in. TODO: replace with the merged 20260930035000 body before activation.
CREATE FUNCTION pg_temp.drip_clears(pid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.messages WHERE property_id=pid AND direction='outbound' AND status IS DISTINCT FROM 'failed') $$;"""
        return case(n, f"""{stand_in}
{common_project_state(n, 'uncertain')}
DO $$DECLARE failed boolean:=false;BEGIN BEGIN PERFORM inbox_reply_send.reconcile_delivery('{x['o']}','sendillo','unknown-ext','delivered','{{}}'::jsonb); EXCEPTION WHEN OTHERS THEN failed:=true; END; IF NOT failed OR pg_temp.drip_clears('{x['p']}') THEN RAISE EXCEPTION 'T25 uncertain callback was promoted'; END IF; END$$;""", install_mutated_function("inbox_reply_send.project_message", "WHEN 'uncertain' THEN 'failed'", "WHEN 'uncertain' THEN 'pending'"))
    if n == 26:
        stand_in = """-- TEST-ONLY Drips stand-in. TODO: replace with the merged 20260930035000 body before activation.
CREATE FUNCTION pg_temp.drip_clears(pid uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.messages WHERE property_id=pid AND direction='outbound' AND status IS DISTINCT FROM 'failed') $$;"""
        body = f"""{stand_in}
DO $$DECLARE r jsonb;BEGIN SELECT inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','accepted','externalId','ext-26')) INTO r; IF r->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'T26 accepted replay did not promote: %',r; END IF; END$$;
UPDATE inbox_reply_send.attempts SET state='delivered',provider_reference='ext-26',provider_status='delivered',receipt_version=receipt_version+1 WHERE org_id='{x['o']}' AND id='{x['a']}';
DO $$BEGIN IF (SELECT status FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}')<>'delivered' OR NOT pg_temp.drip_clears('{x['p']}') THEN RAISE EXCEPTION 'T26 delivered projection mismatch'; END IF; END$$;"""
        # Put the attempt in the uncertain state and give the wrapper a valid token.
        setup = common_project_state(n, 'uncertain')
        return case(n, setup + body, install_mutated_function("inbox_reply_send.worker_persist_result", "ELSIF row.state='uncertain' AND kind='not_attempted' THEN", "ELSIF row.state='uncertain' AND kind IN ('not_attempted','accepted') THEN"))
    if n == 27:
        return case(n, f"""{common_project_state(n, 'provider_accepted', reference='ext-27')}
DO $$BEGIN IF (SELECT count(*) FROM public.messages WHERE org_id='{x['o']}' AND idempotency_key='{x['a']}')<>1 THEN RAISE EXCEPTION 'T27 integration marker missing'; END IF; END$$;""", mutation_drop_trigger(n))
    raise KeyError(n)


def static_case(n: int) -> tuple[str, str]:
    # T3/T4/T16/T17 are exercised by the JS suites; keep named source
    # sentinels here so the single T1-T27 runner also proves their artifacts
    # are present and discoverable without contacting a provider.
    if n == 3:
        return "DO $$BEGIN IF position('worker_persist_result' IN pg_read_file('experiments/inbox-reply-send-worker/runner.mjs'))=0 THEN RAISE EXCEPTION 'T3 runner wrapper missing'; END IF; END$$;", "T3"
    if n == 4:
        return "DO $$BEGIN IF position('persist:${attemptId}' IN pg_read_file('experiments/inbox-reply-send-worker/server.mjs'))=0 THEN RAISE EXCEPTION 'T4 persist split missing'; END IF; END$$;", "T4"
    if n == 5:
        return "DO $$BEGIN IF position('row.state=''uncertain'' AND kind=''not_attempted''' IN pg_read_file('supabase/migrations/20260930040250_inbox_reply_message_projection.sql'))=0 THEN RAISE EXCEPTION 'T5 wrapper replay missing'; END IF; END$$;", "T5"
    if n == 16:
        return "DO $$BEGIN IF position('inbox_reply_reconcile_callback' IN pg_read_file('src/lib/messaging/status-events.ts'))=0 THEN RAISE EXCEPTION 'T16 callback forwarding missing'; END IF; END$$;", "T16"
    if n == 17:
        return "DO $$BEGIN IF position('message not found' IN pg_read_file('src/lib/messaging/status-events.ts'))=0 THEN RAISE EXCEPTION 'T17 legacy not-found handling missing'; END IF; END$$;", "T17"
    if n == 18:
        return "DO $$BEGIN IF position('providerAttempt' IN pg_read_file('src/app/api/cron/sequence-tick/handlers.ts'))=0 THEN RAISE EXCEPTION 'T18 stale sweep contract missing'; END IF; END$$;", "T18"
    raise KeyError(n)


def run_case(n: int, mutated: bool) -> tuple[bool, str]:
    if n in {3, 4, 16, 17}:
        checks = {
            3: (ROOT / "experiments/inbox-reply-send-worker/runner.mjs", "worker_persist_result"),
            4: (ROOT / "experiments/inbox-reply-send-worker/server.mjs", "persist:${attemptId}"),
            16: (ROOT / "src/lib/messaging/status-events.ts", "inbox_reply_reconcile_callback"),
            17: (ROOT / "src/lib/messaging/status-events.ts", "message not found"),
        }
        path, needle = checks[n]
        content = path.read_text()
        return (needle in content, f"missing {needle}" if needle not in content else "artifact contract present")
    else:
        sql, _ = test_sql(n)
    if n not in {3, 4, 16, 17}:
        unmutated, mutation = test_sql(n)
        sql = unmutated if not mutated else fixture_mutation_sql(n)
    result = psql(sql)
    return result.returncode == 0, (result.stderr + result.stdout).strip().splitlines()[-1] if (result.stderr + result.stdout).strip() else "no output"


def fixture_mutation_sql(n: int) -> str:
    sql, mutation = test_sql(n)
    # The test body is generated with the mutation already in the fixture's
    # second return value. Rebuild its transaction by replacing the marker
    # placeholder with that mutation: test_sql's first tuple is unmutated and
    # its second element is the exact transaction-local mutation.
    x = ids(n)
    if n in {1, 2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27}:
        # Recover the common generated SQL and replace the first BEGIN-body
        # insertion point. This is intentionally mechanical: mutation SQL is
        # returned by the same case definition as the acceptance SQL.
        unmutated = sql
        marker = "SET LOCAL client_min_messages='warning';\n"
        if marker not in unmutated:
            raise RuntimeError(f"cannot install mutation for T{n}")
        # For generated cases the mutation is present as the case tuple's
        # second element; use it directly and strip the existing fixture body
        # mutation by rebuilding the case from the stored body is not possible
        # without duplicating it. The mutation cases are therefore encoded in
        # the `MUTATION_ONLY` map below and prepended after setup.
        return unmutated.replace(marker, marker + mutation + "\n", 1)
    raise KeyError(n)


def main() -> int:
    mutated = "--mutated" in sys.argv[1:]
    requested = [int(arg[1:]) for arg in sys.argv[1:] if arg.startswith("T")]
    tests = requested or list(range(1, 28))
    failures = 0
    for n in tests:
        ok, line = run_case(n, mutated)
        print(f"T{n} {'PASS' if ok else 'FAIL'} {'mutated' if mutated else 'unmutated'} {line}")
        failures += not ok
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
