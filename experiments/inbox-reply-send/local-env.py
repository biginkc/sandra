#!/usr/bin/env python3
"""Build a socket-only PostgreSQL 17 fixture from the repository migrations.

This helper is intentionally disposable.  It never accepts a remote DSN and
its state/root guards only permit cleanup of the private /tmp prefix it owns.
The callback fixture test uses it to prove against the actual migrated reply
schema instead of a hand-written imitation.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parents[2]
PG_BIN = Path(os.environ.get("PG17_BIN", "/opt/homebrew/opt/postgresql@17/bin"))
STATE_PATH = Path("/tmp/sandra-reply-runtime-r1-local-env.json")
DATA_PREFIX = "sandra-reply-runtime-r1-local-env-"
FROZEN_MIGRATIONS = {
    "20260930040000_inbox_control_foundation.sql": "a31799ba96e6f7264f062019cc8113a6401719a686cc31e569b10d21064bfbf6",
    "20260930040100_inbox_read_companion.sql": "7a2c5f49fc8fcf58c7f37585c3c347869816912e47e504ec47f9cdac198d3dd7",
    "20260930040200_inbox_backend_operation_reply.sql": "2a4b49d43e67963805d547221d04c84c3f7823f430fd9c0cc9b3f22b36844aad",
}
VENDOR_DIR = ROOT / "experiments/inbox-projection/fixture/vendor"
VENDOR_MANIFEST = VENDOR_DIR / "manifest.json"


class LocalEnvError(RuntimeError):
    pass


def command(args: list[str], *, input_text: str | None = None, timeout: int = 240,
            check: bool = True) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(args, cwd=ROOT, input=input_text, text=True,
                                capture_output=True, timeout=timeout,
                                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        raise LocalEnvError(f"local-env command failed: {args[0]}: {exc}") from exc
    if check and result.returncode:
        detail = (result.stderr + result.stdout).strip()
        raise LocalEnvError(f"command failed ({result.returncode}): {' '.join(args)}\n{detail[-5000:]}")
    return result


def load_state(required: bool = True) -> dict[str, object] | None:
    if not STATE_PATH.exists():
        if required:
            raise LocalEnvError(f"state is absent; run {Path(__file__).name} up first")
        return None
    try:
        value = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise LocalEnvError(f"invalid local-env state: {exc}") from exc
    if not isinstance(value, dict) or not all(key in value for key in ("root", "data", "socket", "port")):
        raise LocalEnvError("local-env state is incomplete")
    return value


def save_state(state: dict[str, object]) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    STATE_PATH.chmod(0o600)


def owned_root(state: dict[str, object]) -> Path:
    root = Path(str(state["root"])).resolve()
    if root.parent != Path("/tmp").resolve() or not root.name.startswith(DATA_PREFIX):
        raise LocalEnvError(f"refusing to remove unrecognized local-env root: {root}")
    return root


def sql(state: dict[str, object], statement: str, *, check: bool = True,
        timeout: int = 300) -> subprocess.CompletedProcess[str]:
    return command(
        [str(PG_BIN / "psql"), "-XqAt", "-v", "ON_ERROR_STOP=1", "-h", str(state["socket"]),
         "-p", str(state["port"]), "-U", "postgres", "-d", "postgres"],
        input_text=statement, check=check, timeout=timeout)


def sql_output(state: dict[str, object], statement: str) -> str:
    return sql(state, statement).stdout.strip()


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def migrations() -> list[Path]:
    paths = sorted((ROOT / "supabase/migrations").glob("*.sql"), key=lambda path: path.name)
    if not paths:
        raise LocalEnvError("repository migrations are absent")
    return paths


def bootstrap_sql() -> str:
    return r"""
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='supabase_realtime_admin') THEN CREATE ROLE supabase_realtime_admin NOLOGIN; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
CREATE TABLE auth.users(
  id uuid PRIMARY KEY, email text, phone text, encrypted_password text,
  aud text DEFAULT 'authenticated', role text DEFAULT 'authenticated',
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_super_admin boolean DEFAULT false, is_sso_user boolean DEFAULT false,
  is_anonymous boolean DEFAULT false, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), last_sign_in_at timestamptz,
  email_confirmed_at timestamptz, phone_confirmed_at timestamptz,
  confirmed_at timestamptz, confirmation_sent_at timestamptz,
  recovery_sent_at timestamptz, email_change_sent_at timestamptz,
  email_change text, new_email text, confirmation_token text,
  recovery_token text, email_change_token_new text,
  email_change_token_current text, phone_change text,
  phone_change_token text, reauthentication_token text,
  banned_until timestamptz, deleted_at timestamptz, invited_at timestamptz
);
CREATE TABLE auth.sessions(
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  factor_id uuid, aal text, not_after timestamptz, refreshed_at timestamptz,
  user_agent text, ip inet, tag text
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.sub',true),''),
NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role',true),''),
NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'role')::text $$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
SELECT COALESCE(NULLIF(current_setting('request.jwt.claims',true),''),'{}')::jsonb $$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.email',true),''),
NULLIF(current_setting('request.jwt.claims',true),'')::jsonb->>'email')::text $$;
GRANT USAGE ON SCHEMA auth TO postgres,anon,authenticated,service_role;
GRANT ALL ON auth.users,auth.sessions TO postgres;
GRANT SELECT ON auth.users,auth.sessions TO anon,authenticated,service_role;
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION supabase_realtime_admin;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime') THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations(
  version text PRIMARY KEY, name text NOT NULL UNIQUE, statements text[] NOT NULL DEFAULT ARRAY[]::text[]
);
"""


def verify_frozen_hashes() -> None:
    for name, expected in FROZEN_MIGRATIONS.items():
        path = ROOT / "supabase/migrations" / name
        actual = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "missing"
        if actual != expected:
            raise LocalEnvError(f"frozen migration hash mismatch for {name}: {actual}")


def apply_vendor(state: dict[str, object]) -> None:
    entries = json.loads(VENDOR_MANIFEST.read_text(encoding="utf-8"))
    if not isinstance(entries, list):
        raise LocalEnvError("vendor manifest is invalid")
    for entry in entries:
        relative = entry["file"]
        path = VENDOR_DIR / relative
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != entry["sha256"]:
            raise LocalEnvError(f"vendor hash mismatch for {relative}")
        source = path.read_text(encoding="utf-8").replace('{{ index .Options "Namespace" }}', "auth")
        sql(state, "SET storage.install_roles='false';\n" + source, timeout=300)


def apply_migrations(state: dict[str, object]) -> None:
    fixture_dir = ROOT / "experiments/inbox-projection/fixture"
    sys.path.insert(0, str(fixture_dir))
    from transaction_envelope import normalize
    for path in migrations():
        source, _removed = normalize(path.read_text(encoding="utf-8"))
        sql(state, "BEGIN; SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'; SET LOCAL storage.install_roles='false';\n" + source + "\nCOMMIT;", timeout=360)
        sql(state, "INSERT INTO supabase_migrations.schema_migrations(version,name,statements) VALUES (" + sql_literal(path.stem) + "," + sql_literal(path.name) + ",ARRAY['local-env']);")


def check_state(state: dict[str, object]) -> None:
    verify_frozen_hashes()
    ready = command([str(PG_BIN / "pg_isready"), "-h", str(state["socket"]), "-p", str(state["port"]), "-U", "postgres"], check=False, timeout=20)
    if ready.returncode:
        raise LocalEnvError("PostgreSQL 17 is not ready")
    observed = sql_output(state, "SELECT current_setting('server_version_num')::int/10000, count(*) FROM supabase_migrations.schema_migrations;")
    major, count = observed.split("|")
    expected = len(migrations())
    if major != "17" or count != str(expected):
        raise LocalEnvError(f"local migration preflight failed: PG={major} journal={count}/{expected}")
    required = sql_output(state, "SELECT to_regprocedure('public.inbox_reply_reconcile_callback(text,text,text,jsonb)') IS NOT NULL AND to_regprocedure('public.inbox_reply_sweep_unmatched_callbacks(integer)') IS NOT NULL;")
    if required != "t":
        raise LocalEnvError("real callback functions are missing after migration replay")
    print(f"LOCAL_ENV_READY PG_MAJOR={major} migrations={count} host={state['socket']} port={state['port']}", flush=True)


def up() -> None:
    verify_frozen_hashes()
    existing = load_state(False)
    if existing is not None:
        check_state(existing)
        return
    for name in ("initdb", "pg_ctl", "pg_isready", "psql"):
        if not (PG_BIN / name).is_file():
            raise LocalEnvError(f"PostgreSQL 17 binary is missing: {PG_BIN / name}")
    root = Path(tempfile.mkdtemp(prefix=DATA_PREFIX, dir="/tmp"))
    data = root / "data"
    socket_dir = root / "socket"
    socket_dir.mkdir(mode=0o700)
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    state = {"root": str(root), "data": str(data), "socket": str(socket_dir), "port": port}
    running = False
    try:
        command([str(PG_BIN / "initdb"), "-D", str(data), "-A", "trust", "-U", "postgres", "--locale=C.UTF-8", "--encoding=UTF8"], timeout=180)
        with (data / "postgresql.conf").open("a", encoding="utf-8") as config:
            config.write("\nlisten_addresses = ''\n")
        command([str(PG_BIN / "pg_ctl"), "-D", str(data), "-o", f"-p {port} -k {socket_dir}", "-l", str(root / "postgres.log"), "start"], timeout=60)
        running = True
        for _ in range(120):
            if command([str(PG_BIN / "pg_isready"), "-h", str(socket_dir), "-p", str(port), "-U", "postgres"], check=False, timeout=10).returncode == 0:
                break
            time.sleep(0.1)
        else:
            raise LocalEnvError("PostgreSQL 17 did not become ready")
        sql(state, bootstrap_sql(), timeout=120)
        apply_vendor(state)
        apply_migrations(state)
        save_state(state)
        check_state(state)
    except Exception:
        if running:
            command([str(PG_BIN / "pg_ctl"), "-D", str(data), "-m", "fast", "stop"], check=False, timeout=60)
        shutil.rmtree(root, ignore_errors=True)
        STATE_PATH.unlink(missing_ok=True)
        raise


def down() -> None:
    state = load_state(False)
    if state is None:
        print("LOCAL_ENV_ALREADY_DOWN", flush=True)
        return
    root = owned_root(state)
    data = Path(str(state["data"]))
    command([str(PG_BIN / "pg_ctl"), "-D", str(data), "-m", "fast", "stop"], check=False, timeout=60)
    shutil.rmtree(root, ignore_errors=False)
    STATE_PATH.unlink(missing_ok=True)
    print(f"LOCAL_ENV_DOWN root={root}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("up", "check", "down"))
    action = parser.parse_args().command
    try:
        if action == "up":
            up()
        elif action == "check":
            state = load_state()
            assert state is not None
            check_state(state)
        else:
            down()
        return 0
    except (LocalEnvError, OSError, subprocess.SubprocessError) as exc:
        print(f"LOCAL_ENV_FAIL: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
