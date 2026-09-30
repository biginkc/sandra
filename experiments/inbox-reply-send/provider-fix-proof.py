#!/usr/bin/env python3
"""Local proof for provider-matrix changes that need PostgreSQL.

This is deliberately fixture-only. It refuses to run unless the caller points
it at the disposable projection fixture through PROJECTION_PGHOST/PORT.
"""

from __future__ import annotations

import importlib.util
import sys
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("projection_proof", ROOT / "experiments/inbox-reply-send/projection-proof.py")
assert spec and spec.loader
projection = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = projection
spec.loader.exec_module(projection)


def main() -> int:
    if "--b4" in sys.argv[1:]:
        source = (ROOT / "supabase/migrations/20260930040250_inbox_reply_message_projection.sql").read_text()
        expected = "Deliberately omit query_canceled"
        if expected not in source or "a cancelled drain must not count as a retry" not in source:
            raise AssertionError("B4 drain-cancellation comment/record is missing")
        print("B4 PASS source record explicitly preserves WHEN others without query_canceled")
        return 0
    mutated = "--mutated" in sys.argv[1:]
    x = projection.ids(28)
    sessions = []
    original = projection.fn_body("inbox_reply_send.worker_persist_result")
    try:
        if projection.psql("SELECT to_regprocedure('inbox_reply_send.worker_persist_result(uuid,uuid,uuid,jsonb)') IS NOT NULL;").stdout.strip() != "t":
            print("B2 NOT RUN: disposable fixture does not contain inbox_reply_send.worker_persist_result")
            return 2
        if mutated:
            body = original.replace(" SET lock_timeout='3s'", "", 1)
            if body == original:
                raise AssertionError("B2 mutation target SET lock_timeout='3s' not found")
            projection.psql(body, check=True)
        projection.psql(projection.fixture(28, projection.started(28)).replace("ROLLBACK;", "COMMIT;"), check=True)
        holder = projection.session("b2-attempt-holder", f"BEGIN; SELECT 1 FROM inbox_reply_send.attempts WHERE org_id='{x['o']}' AND id='{x['a']}' FOR UPDATE; SELECT pg_sleep(5); COMMIT;")
        sessions.append(holder)
        projection.wait_activity("b2-attempt-holder", wait_event="PgSleep")
        started = time.monotonic()
        result = projection.psql(f"""
SET statement_timeout='4s';
DO $$ DECLARE code text;
BEGIN
 BEGIN
  PERFORM inbox_reply_send.worker_persist_result('{x['o']}','{x['a']}','{x['token']}',jsonb_build_object('kind','accepted','externalId','b2-ext','status','sent'));
  RAISE EXCEPTION 'B2 persist unexpectedly acquired held attempt lock';
 EXCEPTION WHEN lock_not_available THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;
  RAISE NOTICE 'B2_SQLSTATE=%',code;
 END;
END $$;
""")
        elapsed = time.monotonic() - started
        for proc in sessions:
            projection.finish_session(proc)
        sessions.clear()
        text = projection.output(result)
        if not mutated:
            if result.returncode != 0 or "B2_SQLSTATE=55P03" not in text or elapsed >= 4.5:
                raise AssertionError(f"B2 expected bounded 55P03, elapsed={elapsed:.2f}s output={text}")
            print(f"B2 PASS unmutated B2_SQLSTATE=55P03 elapsed={elapsed:.2f}s")
            return 0
        if "B2_SQLSTATE=55P03" in text:
            raise AssertionError(f"B2 mutation unexpectedly preserved lock timeout: {text}")
        raise AssertionError(f"B2 mutated failure captured without 55P03 (expected): elapsed={elapsed:.2f}s output={text}")
    finally:
        for proc in sessions:
            if proc.poll() is None:
                try:
                    projection.finish_session(proc)
                except Exception:
                    proc.kill()
                    proc.wait(timeout=5)
        try:
            projection.psql("BEGIN;" + original + "COMMIT;", check=True)
        finally:
            projection.cleanup(28)


if __name__ == "__main__":
    raise SystemExit(main())
