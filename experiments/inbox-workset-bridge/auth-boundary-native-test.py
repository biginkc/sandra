#!/usr/bin/env python3
"""Run the canonical Inbox authorization source against a disposable native PostgreSQL.

This proof deliberately loads auth.sql itself, then adds only the generated
serving wrapper and public RPC needed to exercise the authenticated boundary.
It never connects to the shared fixture, a VM, or a provider.
"""

from __future__ import annotations

import os
import shutil
import socket
import subprocess
import tempfile
from pathlib import Path


HERE = Path(__file__).resolve().parent
AUTH_SQL = Path(os.environ.get("INBOX_AUTH_SQL", str(HERE / "auth.sql")))


def run(command: list[str], *, input_text: str | None = None) -> str:
    try:
        result = subprocess.run(
            command,
            check=True,
            input=input_text,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
    except subprocess.CalledProcessError as error:
        raise RuntimeError(f"command failed ({error.returncode}): {' '.join(command)}\n{error.output}") from error
    return result.stdout


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def psql_args(socket_dir: Path, port: int) -> list[str]:
    return ["psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-h", str(socket_dir), "-p", str(port), "-d", "postgres"]


def main() -> None:
    required = ["initdb", "pg_ctl", "psql"]
    missing = [name for name in required if shutil.which(name) is None]
    if missing:
        raise SystemExit(f"native PostgreSQL tools unavailable: {', '.join(missing)}")

    with tempfile.TemporaryDirectory(prefix="sandra-inbox-auth-boundary-") as temp:
        root = Path(temp)
        data = root / "data"
        # PostgreSQL's Unix-socket path is short on macOS; the temporary
        # directory root above intentionally lives under the long system temp
        # prefix, so keep only the socket itself under /tmp.
        socket_dir = Path(tempfile.mkdtemp(prefix="sia-", dir="/tmp"))
        port = free_port()
        run(["initdb", "-D", str(data), "--username=postgres", "--no-locale", "--encoding=UTF8"])
        run(["pg_ctl", "-D", str(data), "-o", f"-p {port} -k {socket_dir}", "-l", str(root / "postgres.log"), "start"])
        try:
            psql = psql_args(socket_dir, port)
            run(
                psql,
                input_text="""
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE anon NOLOGIN;
CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE SCHEMA inbox_t2_fixture;
CREATE SCHEMA inbox_t2_bridge;
CREATE TABLE inbox_t2_fixture.identity(marker text NOT NULL);
INSERT INTO inbox_t2_fixture.identity(marker) VALUES ('sandra-inbox-projection-t2-owned-synthetic');
CREATE TABLE public.memberships (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  role text NOT NULL,
  access_status text NOT NULL,
  access_expires_at timestamptz,
  deletion_prepared_at timestamptz,
  deletion_operation_id uuid,
  hugo_config jsonb,
  acquisitions_enabled boolean NOT NULL DEFAULT false
);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY, user_id uuid NOT NULL, not_after timestamptz NOT NULL);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT current_setting('request.jwt.claim.role', true)
$$;
""",
            )
            run(psql + ["-f", str(AUTH_SQL)])
            run(
                psql,
                input_text="""
CREATE SCHEMA inbox_control;
CREATE TABLE inbox_control.rollout(singleton boolean PRIMARY KEY, serving_enabled boolean NOT NULL);
INSERT INTO inbox_control.rollout VALUES (true, true);
CREATE FUNCTION inbox_t2_bridge.assert_serving() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='2s' AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM inbox_control.rollout WHERE singleton AND serving_enabled) THEN
    RAISE EXCEPTION 'INBOX_NOT_READY' USING ERRCODE='55000';
  END IF;
END $$;
CREATE FUNCTION inbox_t2_bridge.authorize_serving(o uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' SET statement_timeout='5s' AS $$
DECLARE a jsonb;
BEGIN
  PERFORM inbox_t2_bridge.assert_serving();
  a := inbox_t2_bridge.authorize(o);
  RETURN a;
END $$;
CREATE FUNCTION public.inbox_authorize_sync(org_id uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT inbox_t2_bridge.authorize_serving(org_id)
$$;
REVOKE ALL ON FUNCTION public.inbox_authorize_sync(uuid) FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.inbox_authorize_sync(uuid) TO authenticated;
""",
            )
            run(
                psql,
                input_text="""
INSERT INTO public.memberships(id, org_id, user_id, role, access_status, acquisitions_enabled)
VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'member', 'active', true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002', 'member', 'active', false),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000003', 'owner', 'active', true),
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', 'member', 'active', false),
  ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'member', 'active', false);
INSERT INTO auth.sessions(id, user_id, not_after)
VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', clock_timestamp() + interval '1 hour'),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002', clock_timestamp() + interval '1 hour'),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000003', clock_timestamp() + interval '1 hour'),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', clock_timestamp() - interval '1 second'),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005', clock_timestamp() + interval '1 hour');
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.role', 'authenticated', false);
SELECT set_config('request.jwt.claims', jsonb_build_object('session_id', '30000000-0000-0000-0000-000000000001', 'exp', extract(epoch FROM clock_timestamp() + interval '1 day')::bigint)::text, false);
DO $$
DECLARE result jsonb; message text;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000001', false);
  BEGIN
    SELECT public.inbox_authorize_sync('10000000-0000-0000-0000-000000000001') INTO result;
    RAISE EXCEPTION 'acquisitions-only member was admitted: %', result;
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    IF message <> 'INBOX_SHARED_SURFACE_DENIED' THEN
      RAISE EXCEPTION 'acquisitions-only denial had message %', message;
    END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000002', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('session_id', '30000000-0000-0000-0000-000000000002', 'exp', extract(epoch FROM clock_timestamp() + interval '1 day')::bigint)::text, false);
  SELECT public.inbox_authorize_sync('10000000-0000-0000-0000-000000000001') INTO result;
  IF result->>'org_id' <> '10000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'non-Acquisitions member result lost org binding: %', result;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('session_id', '30000000-0000-0000-0000-000000000003', 'exp', extract(epoch FROM clock_timestamp() + interval '1 day')::bigint)::text, false);
  SELECT public.inbox_authorize_sync('10000000-0000-0000-0000-000000000001') INTO result;
  IF result->>'org_id' <> '10000000-0000-0000-0000-000000000001' THEN
    RAISE EXCEPTION 'owner result lost org binding: %', result;
  END IF;

  PERFORM set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000004', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('session_id', '30000000-0000-0000-0000-000000000004', 'exp', extract(epoch FROM clock_timestamp() + interval '1 day')::bigint)::text, false);
  BEGIN
    PERFORM public.inbox_authorize_sync('10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'expired session was admitted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    IF message <> 'INBOX_SESSION_REVOKED' THEN
      RAISE EXCEPTION 'expired session denial had message %', message;
    END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000005', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('session_id', '30000000-0000-0000-0000-000000000005', 'exp', extract(epoch FROM clock_timestamp() + interval '1 day')::bigint)::text, false);
  RESET ROLE;
  DELETE FROM auth.sessions WHERE id = '30000000-0000-0000-0000-000000000005';
  SET ROLE authenticated;
  BEGIN
    PERFORM public.inbox_authorize_sync('10000000-0000-0000-0000-000000000001');
    RAISE EXCEPTION 'revoked session was admitted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    IF message <> 'INBOX_SESSION_REVOKED' THEN
      RAISE EXCEPTION 'revoked session denial had message %', message;
    END IF;
  END;

  PERFORM set_config('request.jwt.claim.sub', '20000000-0000-0000-0000-000000000003', false);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('session_id', '30000000-0000-0000-0000-000000000003', 'exp', extract(epoch FROM clock_timestamp() + interval '1 day')::bigint)::text, false);
  BEGIN
    PERFORM public.inbox_authorize_sync('10000000-0000-0000-0000-000000000099');
    RAISE EXCEPTION 'org-mismatched owner was admitted';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    GET STACKED DIAGNOSTICS message = MESSAGE_TEXT;
    IF message <> 'INBOX_ORG_DENIED' THEN
      RAISE EXCEPTION 'org mismatch denial had message %', message;
    END IF;
  END;
END $$;
SELECT 'PASS: direct public RPC boundary and existing auth gates' AS proof;
""",
            )
            print("PASS: auth.sql loaded and direct public RPC boundary cases passed")
        finally:
            run(["pg_ctl", "-D", str(data), "stop", "-m", "fast"])
            shutil.rmtree(socket_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
