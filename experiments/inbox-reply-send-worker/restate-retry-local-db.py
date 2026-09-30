#!/usr/bin/env python3
"""Ruling v4.1 LOCAL-DB probes T-R12, T-R12b and T-R13.

The probes use only the disposable projection fixture selected by
PROJECTION_PGHOST/PROJECTION_PGPORT. They commit only their uniquely keyed
synthetic rows, then clean them in finally blocks. A missing fixture is a
hard NOT RUN result, never a claim of coverage.
"""

from __future__ import annotations

import importlib.util
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("projection_proof", ROOT / "experiments/inbox-reply-send/projection-proof.py")
assert spec and spec.loader
projection = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = projection
spec.loader.exec_module(projection)


def q(sql: str, *, check: bool = True):
    return projection.psql(sql, check=check)


def scalar(sql: str) -> str:
    result = q(sql)
    return result.stdout.strip()


def prerequisite() -> bool:
    result = q("SELECT to_regprocedure('inbox_reply_send.worker_start_dispatch(uuid,uuid,bigint)') IS NOT NULL AND to_regprocedure('inbox_reply_send.claim_dispatch_batch(integer)') IS NOT NULL;", check=False)
    if result.returncode != 0 or result.stdout.strip() != "t":
        print("NOT RUN: disposable projection fixture with the reply worker functions is unavailable")
        return False
    return True


def common_seed(n: int, *, items: int = 1, body: str = "") -> str:
    x = projection.ids(n)
    return projection.fixture(n, f"""
INSERT INTO auth.users(id,email) VALUES('{x['c']}','restate-local-db-{n}@example.invalid');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{x['c']}','{x['o']}','owner','active');
INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key) VALUES('{x['o']}','{x['op']}','{x['c']}','{x['prep']}',gen_random_uuid());
CREATE SCHEMA IF NOT EXISTS inbox_reply_test;
UPDATE inbox_reply_review.admission SET enabled=true;
{body}
""", items=items, seed_attempt=False).replace("ROLLBACK;", "COMMIT;")


def add_attempt(n: int, *, second: bool = False) -> str:
    x = projection.ids(n)
    if not second:
        return f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{x['o']}','{x['a']}','{x['op']}','{x['prep']}','{x['i']}',1,'{x['c']}','+12025550001','+12025550101',inbox_reply_send.body_hash('hello-{n}','+12025550001','+12025550101'),'approved');"
    y = projection.second_ids(n)
    return f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) VALUES('{x['o']}','{y['a']}','{x['op']}','{x['prep']}','{y['i']}',1,'{x['c']}','+12025550001','+1202555{n+1:04d}',inbox_reply_send.body_hash('hello-{n}','+12025550001','+1202555{n+1:04d}'),'approved');"


def insert_outbox(n: int) -> str:
    x = projection.ids(n)
    return f"INSERT INTO inbox_reply_send.dispatch_outbox(org_id,operation_id) VALUES('{x['o']}','{x['op']}');"


def cleanup(n: int) -> None:
    try:
        projection.cleanup(n)
    except Exception as error:
        print(f"cleanup warning T-R{n}: {error}", file=sys.stderr)


def t_r12(mutated: bool) -> tuple[bool, str]:
    n = 12
    x = projection.ids(n)
    fault = f"""
CREATE SEQUENCE inbox_reply_test.restate_r12_fault;
CREATE OR REPLACE FUNCTION inbox_reply_test.restate_r12_marker_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.state='claimed' AND NEW.state='dispatch_started' AND nextval('inbox_reply_test.restate_r12_fault')=1 THEN
  RAISE EXCEPTION 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzz_restate_r12_marker_fault BEFORE UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.restate_r12_marker_fault();
ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
UPDATE inbox_reply_review.preparations SET items=(SELECT jsonb_agg(jsonb_set(value,'{{validUntil}}',to_jsonb((clock_timestamp()+interval '30 seconds')::text))) FROM jsonb_array_elements(items) value) WHERE id='{x['prep']}';
ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
{add_attempt(n)}
{insert_outbox(n)}
"""
    q(common_seed(n, body=fault), check=True)
    try:
        claim = projection.psql(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}');", check=True).stdout.strip()
        if '"generation": "1"' not in claim:
            return False, f"T-R12 g1 claim mismatch: {claim}"
        first = projection.psql(f"SELECT inbox_reply_send.worker_start_dispatch('{x['o']}','{x['a']}',1);", check=False)
        first_text = projection.output(first)
        if first.returncode == 0 or 'INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER' not in first_text:
            return False, f"T-R12 marker fault mismatch: {first_text}"
        state = scalar(f"SELECT state||':'||generation||':'||(dispatch_started_at IS NULL)::text||(dispatch_token IS NULL)::text FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}';")
        if state != 'claimed:1:truetrue':
            return False, f"T-R12 rollback mismatch: {state}"
        time.sleep(10)
        busy = scalar(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}')->>'kind';")
        if busy != 'busy':
            return False, f"T-R12 H2 expected deferred/busy inside L1, got {busy}"
        time.sleep(51)
        reclaimed = scalar(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}')->>'generation';")
        if reclaimed != '2':
            return False, f"T-R12 reclaim generation mismatch: {reclaimed}"
        skipped = scalar(f"SELECT inbox_reply_send.worker_start_dispatch('{x['o']}','{x['a']}',2)->>'kind';")
        evidence = scalar(f"SELECT state||':'||evidence FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}';")
        if skipped != 'skipped' or evidence != 'skipped_ineligible:conversation_window_expired':
            return False, f"T-R12 expiry result mismatch: {skipped}/{evidence}"
        generation = scalar(f"SELECT (inbox_reply_send.claim_dispatch_batch(20)->0->>'generation');")
        ack = scalar(f"SELECT inbox_reply_send.ack_dispatch('{x['o']}','{x['op']}',{generation});")
        if ack != 't':
            return False, f"T-R12 H3 ack mismatch: {ack}"
        if mutated:
            raise AssertionError("T-R12 mutation must fail: journaling the first not_sent as settled would leave the claimed attempt and false ack")
        return True, "T-R12 PASS marker fault rolled back; H2 deferred; post-lease reclaim skipped expired item; H3 ack true"
    finally:
        cleanup(n)


def t_r12b(mutated: bool) -> tuple[bool, str]:
    n = 120
    x = projection.ids(n)
    sleep_trigger = f"""
CREATE OR REPLACE FUNCTION inbox_reply_test.restate_r12b_marker_sleep() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expires timestamptz;
BEGIN
 IF OLD.state='claimed' AND NEW.state='dispatch_started' THEN
  SELECT (value->>'validUntil')::timestamptz INTO expires FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id=NEW.preparation_id AND (value->>'id')::uuid=NEW.item_id;
  WHILE clock_timestamp() <= expires + interval '1 second' LOOP PERFORM pg_sleep(0.25); END LOOP;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zzz_restate_r12b_marker_sleep BEFORE UPDATE OF state ON inbox_reply_send.attempts FOR EACH ROW EXECUTE FUNCTION inbox_reply_test.restate_r12b_marker_sleep();
ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
UPDATE inbox_reply_review.preparations SET items=(SELECT jsonb_agg(jsonb_set(value,'{{validUntil}}',to_jsonb((clock_timestamp()+interval '5 seconds')::text))) FROM jsonb_array_elements(items) value) WHERE id='{x['prep']}';
ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
{add_attempt(n)}
{insert_outbox(n)}
"""
    q(common_seed(n, body=sleep_trigger), check=True)
    source = (ROOT / "supabase/migrations/20260930040200_inbox_backend_operation_reply.sql").read_text()
    marker = re.search(r"CREATE FUNCTION inbox_reply_send\.start_dispatch\(.*?END \$\$;", source, re.S)
    assert marker
    original = marker.group(0)
    removed = original.replace("  ev:=inbox_reply_send.item_current(o,frozen);\n  IF ev IS NOT NULL THEN RAISE EXCEPTION 'stale after marker' USING ERRCODE='IR001';END IF;\n", "", 1)
    try:
        if mutated:
            q(removed.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1), check=True)
        scalar(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}')->>'generation';")
        result = q(f"SELECT inbox_reply_send.worker_start_dispatch('{x['o']}','{x['a']}',1)->>'kind';", check=False)
        text = projection.output(result)
        state = scalar(f"SELECT state||':'||(dispatch_started_at IS NULL)::text FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}';")
        if not mutated and (result.returncode != 0 or result.stdout.strip() != 'skipped' or state != 'skipped_ineligible:true'):
            raise AssertionError(f"T-R12b post-marker expiry mismatch: {text}/{state}")
        if mutated:
            raise AssertionError(f"T-R12b mutation captured: dropped post-marker recheck allowed marker/transport path: {text}/{state}")
        generation = scalar(f"SELECT (inbox_reply_send.claim_dispatch_batch(20)->0->>'generation');")
        if scalar(f"SELECT inbox_reply_send.ack_dispatch('{x['o']}','{x['op']}',{generation});") != 't':
            raise AssertionError("T-R12b H3 ack was not true")
        return True, "T-R12b PASS marker sleep crossed validUntil; post-marker recheck skipped with no transport; H3 ack true"
    finally:
        q(original.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1), check=True)
        cleanup(n)


def t_r13(mutated: bool) -> tuple[bool, str]:
    n = 13
    x = projection.ids(n)
    body = f"{add_attempt(n)}{add_attempt(n, second=True)}{insert_outbox(n)}UPDATE memberships SET access_status='inactive' WHERE user_id='{x['c']}' AND org_id='{x['o']}';"
    q(common_seed(n, items=2, body=body), check=True)
    try:
        scalar(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}')->>'generation';")
        denied = q(f"SELECT inbox_reply_send.worker_start_dispatch('{x['o']}','{x['a']}',1);", check=False)
        if denied.returncode == 0 or 'INBOX_REPLY_REQUESTER_UNAUTHORIZED' not in projection.output(denied):
            raise AssertionError(f"T-R13 pass A did not raise unauthorized: {projection.output(denied)}")
        if scalar(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}')->>'kind';") != 'busy':
            raise AssertionError("T-R13 H2 inside-lease pass was not deferred/busy")
        time.sleep(61)
        if scalar(f"SELECT inbox_reply_send.worker_claim('{x['o']}','{x['a']}')->>'generation';") != '2':
            raise AssertionError("T-R13 post-lease reclaim did not reach generation 2")
        denied_again = q(f"SELECT inbox_reply_send.worker_start_dispatch('{x['o']}','{x['a']}',2);", check=False)
        if denied_again.returncode == 0 or 'INBOX_REPLY_REQUESTER_UNAUTHORIZED' not in projection.output(denied_again):
            raise AssertionError("T-R13 pass C did not repeat unauthorized")
        if scalar(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}';") != 'claimed':
            raise AssertionError("T-R13 attempt 1 escaped claimed")
        if scalar(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{projection.second_ids(n)['a']}';") != 'approved':
            raise AssertionError("T-R13 attempt 2 was claimed")
        if scalar(f"SELECT inbox_reply_send.operation_dispatch_complete('{x['o']}','{x['op']}');") != 'f':
            raise AssertionError("T-R13 operation unexpectedly completed")
        generation = scalar(f"SELECT (inbox_reply_send.claim_dispatch_batch(20)->0->>'generation');")
        if scalar(f"SELECT inbox_reply_send.ack_dispatch('{x['o']}','{x['op']}',{generation});") != 'f':
            raise AssertionError("T-R13 H3 ack unexpectedly true")
        if mutated:
            raise AssertionError("T-R13 mutation must fail: mapping unauthorized to settled would reach attempt 2")
        return True, "T-R13 PASS pre-marker unauthorized; H2 deferred; post-lease unauthorized repeated; attempt 2 approved; H3 ack false"
    finally:
        cleanup(n)


def main() -> int:
    if not prerequisite():
        return 2
    requested = [arg for arg in sys.argv[1:] if arg in {"T-R12", "T-R12b", "T-R13"}]
    mutated = "--mutated" in sys.argv[1:]
    tests = requested or ["T-R12", "T-R12b", "T-R13"]
    for name in tests:
        ok, line = {"T-R12": t_r12, "T-R12b": t_r12b, "T-R13": t_r13}[name](mutated)
        print(f"{name} {'PASS' if ok else 'FAIL'} {'mutated' if mutated else 'unmutated'} {line}")
        if not ok:
            return 1
    return 1 if mutated else 0


if __name__ == "__main__":
    raise SystemExit(main())
