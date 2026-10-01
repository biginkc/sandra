#!/usr/bin/env python3
"""Minimal disposable-Postgres proof for B2's function lock timeout.

It installs the candidate wrapper and a tiny synthetic attempts table only;
the full projection fixture proof remains separate and refuses missing DB
state. This never connects to the Homebrew service.
"""

from __future__ import annotations

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PG_BIN = Path("/opt/homebrew/opt/postgresql@17/bin")
MIGRATION = ROOT / "supabase/migrations/20260930040250_inbox_reply_message_projection.sql"


def candidate(mode: str) -> str:
    source = MIGRATION.read_text()
    match = re.search(r"CREATE FUNCTION inbox_reply_send\.worker_persist_result\(.*?END \$\$;", source, re.S)
    if not match:
        raise RuntimeError("B2 wrapper source not found")
    body = match.group(0)
    if mode == "mutated":
        body = body.replace(" SET lock_timeout='3s'", "", 1)
    return body.replace("CREATE FUNCTION", "CREATE OR REPLACE FUNCTION", 1)


def psql(socket: Path, port: int, sql: str, *, check: bool = False, application_name: str | None = None) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    if application_name:
        env["PGAPPNAME"] = application_name
    result = subprocess.run(
        ["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", str(socket), "-p", str(port), "-U", "postgres", "-d", "postgres"],
        input=sql,
        text=True,
        capture_output=True,
        env=env,
        timeout=10,
    )
    if check and result.returncode:
        raise RuntimeError((result.stderr + result.stdout).strip())
    return result


def main() -> int:
    if "--mutated" in sys.argv[1:] and "--noop-mutated" in sys.argv[1:]:
        raise AssertionError("B2 minimal accepts only one mutation mode")
    mode = "mutated" if "--mutated" in sys.argv[1:] else "noop" if "--noop-mutated" in sys.argv[1:] else "baseline"
    data = Path(tempfile.mkdtemp(prefix="replypersist-b2-pg-"))
    socket = data / "socket"
    socket.mkdir(mode=0o700)
    port = 55437 + (os.getpid() % 50)
    try:
        subprocess.run([str(PG_BIN / "initdb"), "-D", str(data / "data"), "-A", "trust", "-U", "postgres", "--no-locale"], check=True, capture_output=True, text=True)
        subprocess.run([str(PG_BIN / "pg_ctl"), "-D", str(data / "data"), "-o", f"-p {port} -k {socket}", "-l", str(data / "postgres.log"), "start"], check=True, capture_output=True, text=True)
        psql(socket, port, f"""
CREATE SCHEMA inbox_reply_send;
CREATE TABLE inbox_reply_send.attempts(org_id uuid NOT NULL,id uuid NOT NULL,dispatch_token uuid,state text,evidence text,receipt_version bigint NOT NULL DEFAULT 0);
CREATE FUNCTION inbox_reply_send.persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb LANGUAGE sql AS $$ SELECT jsonb_build_object('state','provider_accepted') $$;
{candidate(mode)}
INSERT INTO inbox_reply_send.attempts(org_id,id,dispatch_token,state) VALUES('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','dispatch_started');
""", check=True)
        holder = subprocess.Popen(["psql", "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", str(socket), "-p", str(port), "-U", "postgres", "-d", "postgres"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env={**os.environ, "PGAPPNAME": "b2-minimal-holder"})
        assert holder.stdin
        holder.stdin.write("BEGIN; SELECT 1 FROM inbox_reply_send.attempts WHERE id='22222222-2222-2222-2222-222222222222' FOR UPDATE; SELECT pg_sleep(5); COMMIT;\\q\n")
        holder.stdin.flush()
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if psql(socket, port, "SELECT 1 FROM pg_stat_activity WHERE application_name='b2-minimal-holder' AND wait_event='PgSleep';").stdout.strip() == "1":
                break
            time.sleep(0.05)
        else:
            raise RuntimeError("B2 minimal holder did not acquire the attempt lock")
        started = time.monotonic()
        result = psql(socket, port, """
SET statement_timeout='4s';
DO $$ DECLARE code text;
BEGIN
 BEGIN
  PERFORM inbox_reply_send.worker_persist_result('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333',jsonb_build_object('kind','accepted','externalId','b2-minimal','status','sent'));
  RAISE EXCEPTION 'B2 unexpectedly acquired held lock';
 EXCEPTION WHEN lock_not_available THEN
  GET STACKED DIAGNOSTICS code=RETURNED_SQLSTATE;
  RAISE NOTICE 'B2_SQLSTATE=%',code;
 END;
END $$;
""")
        elapsed = time.monotonic() - started
        holder.communicate(timeout=8)
        output = result.stderr + result.stdout
        if result.returncode != 0 or "B2_SQLSTATE=55P03" not in output or elapsed >= 4.5:
            raise AssertionError(f"B2 minimal expected bounded 55P03, elapsed={elapsed:.2f}s output={output}")
        if mode == "noop":
            print(f"B2 SELF-TEST/DEMO minimal no-op mutation SURVIVED shared assertion B2_SQLSTATE=55P03 elapsed={elapsed:.2f}s")
        else:
            print(f"B2 PASS minimal {mode} SQLSTATE=55P03 elapsed={elapsed:.2f}s")
        return 0
    finally:
        subprocess.run([str(PG_BIN / "pg_ctl"), "-D", str(data / "data"), "-m", "fast", "stop"], capture_output=True, text=True)
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
