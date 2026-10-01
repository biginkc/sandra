#!/usr/bin/env python3
"""Build and operate the disposable PostgreSQL fixture for reply persistence.

The fixture is deliberately local and socket-only.  It installs the vendor
prerequisites, every SQL migration in filename order, and a small migration
journal owned by this harness so ``check`` can prove that the complete replay
finished.  The state file is only a handoff between the separate ``up``,
``run``, and ``down`` invocations.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PG_BIN = Path("/opt/homebrew/opt/postgresql@17/bin")
PSQL = shutil.which("psql") or "/opt/homebrew/bin/psql"
POSTGREST = shutil.which("postgrest") or "/opt/homebrew/bin/postgrest"
STATE_PATH = Path("/tmp/sandra-reply-persist-local-env.json")
DATA_PREFIX = "sandra-reply-persist-local-env-"
LOCAL_POSTGREST_PORT = 55438
LOCAL_SUPABASE_PROXY_PORT = 55439
FROZEN_MIGRATIONS = {
    "supabase/migrations/20260930040000_inbox_control_foundation.sql": "a31799ba96e6f7264f062019cc8113a6401719a686cc31e569b10d21064bfbf6",
    "supabase/migrations/20260930040100_inbox_read_companion.sql": "7a2c5f49fc8fcf58c7f37585c3c347869816912e47e504ec47f9cdac198d3dd7",
    "supabase/migrations/20260930040200_inbox_backend_operation_reply.sql": "2a4b49d43e67963805d547221d04c84c3f7823f430fd9c0cc9b3f22b36844aad",
}
MIGRATION = ROOT / "supabase/migrations/20260930040250_inbox_reply_message_projection.sql"
QUIET_HOURS_MIGRATION = ROOT / "supabase/migrations/20260930040200_inbox_backend_operation_reply.sql"
VENDOR_DIR = ROOT / "experiments/inbox-projection/fixture/vendor"
VENDOR_MANIFEST = VENDOR_DIR / "manifest.json"


class LocalEnvError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise LocalEnvError(message)


def command(args: list[str], *, input_text: str | None = None, timeout: int = 240,
            check: bool = True, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    try:
        result = subprocess.run(
            args,
            cwd=ROOT,
            input=input_text,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=env,
        )
    except FileNotFoundError as error:
        fail(f"command not found: {args[0]} ({error})")
    except subprocess.TimeoutExpired as error:
        fail(f"command timed out after {timeout}s: {' '.join(args)} ({error})")
    if check and result.returncode:
        detail = (result.stderr + result.stdout).strip()
        if len(detail) > 4000:
            detail = detail[-4000:]
        fail(f"command failed ({result.returncode}): {' '.join(args)}\n{detail}")
    return result


def sql(state: dict[str, object], statement: str, *, timeout: int = 240,
        check: bool = True) -> subprocess.CompletedProcess[str]:
    return command(
        [
            PSQL, "-XqAt", "-v", "ON_ERROR_STOP=1",
            "-h", str(state["socket"]),
            "-p", str(state["port"]),
            "-U", "postgres", "-d", "postgres",
        ],
        input_text=statement,
        timeout=timeout,
        check=check,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


def sql_output(state: dict[str, object], statement: str) -> str:
    result = sql(state, statement)
    return result.stdout.strip()


def sql_literal(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


def load_state(*, required: bool = True) -> dict[str, object] | None:
    if not STATE_PATH.exists():
        if required:
            fail(f"local environment is down; run {Path(__file__).name} up first")
        return None
    try:
        state = json.loads(STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read local environment state {STATE_PATH}: {error}")
    if not isinstance(state, dict):
        fail(f"invalid local environment state {STATE_PATH}")
    for key in ("root", "data", "socket", "port"):
        if key not in state:
            fail(f"local environment state is missing {key}")
    return state


def save_state(state: dict[str, object]) -> None:
    STATE_PATH.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    STATE_PATH.chmod(0o600)


def validate_owned_root(state: dict[str, object]) -> Path:
    root = Path(str(state["root"])).resolve()
    if root.parent != Path("/tmp").resolve() or not root.name.startswith(DATA_PREFIX):
        fail(f"refusing to remove an unrecognized fixture root: {root}")
    return root


def fixture_alive(state: dict[str, object]) -> bool:
    data = Path(str(state["data"]))
    if not data.exists():
        return False
    result = command([str(PG_BIN / "pg_ctl"), "-D", str(data), "status"], check=False, timeout=20)
    return result.returncode == 0


def port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def pick_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def verify_frozen_hashes() -> None:
    for relative, expected in FROZEN_MIGRATIONS.items():
        path = ROOT / relative
        if not path.is_file():
            fail(f"frozen migration is missing: {relative}")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        print(f"FROZEN_HASH {path.name} {actual}", flush=True)
        if actual != expected:
            fail(f"frozen migration hash mismatch for {relative}: expected {expected}, got {actual}")


def quiet_hours_source() -> tuple[str, str]:
    source = QUIET_HOURS_MIGRATION.read_text(encoding="utf-8")
    match = re.search(
        r"CREATE FUNCTION inbox_reply_preparation\.quiet_hours\(.*?AS \$\$(.*?)\$\$;",
        source,
        re.DOTALL,
    )
    if not match:
        fail("040200 quiet_hours source body is missing")
    body = match.group(1)
    return body, hashlib.sha256(body.encode("utf-8")).hexdigest()


def check_quiet_hours(state: dict[str, object], label: str) -> None:
    body, digest = quiet_hours_source()
    expected_hex = body.encode("utf-8").hex()
    observed = sql_output(state, """
SELECT encode(convert_to(p.prosrc,'UTF8'),'hex') || '|' || p.provolatile::text || '|' || l.lanname::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid=p.pronamespace
JOIN pg_language l ON l.oid=p.prolang
WHERE n.nspname='inbox_reply_preparation'
  AND p.proname='quiet_hours'
  AND pg_get_function_identity_arguments(p.oid)='state text, at_time timestamp with time zone';
""")
    parts = observed.split("|")
    if parts != [expected_hex, "i", "sql"]:
        fail(f"quiet_hours {label} preflight failed: expected 040200 body/immutable/sql, observed {observed[:160]}")
    print(f"LOCAL_ENV_CHECK quiet_hours={label}:040200_body_match source_sha256={digest}", flush=True)


def bootstrap_sql() -> str:
    return """
CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN CREATE ROLE authenticator NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_storage_admin') THEN CREATE ROLE supabase_storage_admin NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN CREATE ROLE supabase_realtime_admin NOLOGIN; END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_auth_admin;
CREATE TABLE auth.users(
  id uuid PRIMARY KEY,
  email text,
  phone text,
  encrypted_password text,
  aud text DEFAULT 'authenticated',
  role text DEFAULT 'authenticated',
  raw_app_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_super_admin boolean DEFAULT false,
  is_sso_user boolean DEFAULT false,
  is_anonymous boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  last_sign_in_at timestamptz,
  email_confirmed_at timestamptz,
  phone_confirmed_at timestamptz,
  confirmed_at timestamptz,
  confirmation_sent_at timestamptz,
  recovery_sent_at timestamptz,
  email_change_sent_at timestamptz,
  email_change text,
  new_email text,
  confirmation_token text,
  recovery_token text,
  email_change_token_new text,
  email_change_token_current text,
  phone_change text,
  phone_change_token text,
  reauthentication_token text,
  banned_until timestamptz,
  deleted_at timestamptz,
  invited_at timestamptz
);
CREATE TABLE auth.sessions(
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  factor_id uuid,
  aal text,
  not_after timestamptz,
  refreshed_at timestamptz,
  user_agent text,
  ip inet,
  tag text
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.sub', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'sub'
  )::uuid
$$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'role'
  )::text
$$;
CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
CREATE OR REPLACE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claim.email', true), ''),
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb->>'email'
  )::text
$$;
GRANT USAGE ON SCHEMA auth TO postgres, anon, authenticated, service_role;
GRANT ALL ON auth.users, auth.sessions TO postgres;
GRANT SELECT ON auth.users, auth.sessions TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION supabase_storage_admin;
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION supabase_realtime_admin;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations(
  version text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  statements text[] NOT NULL DEFAULT ARRAY[]::text[]
);
"""


def seed_pre_request(state: dict[str, object]) -> None:
    sql(state, """
CREATE OR REPLACE FUNCTION public.r10_local_pre_request() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $r10$
DECLARE claims jsonb;
BEGIN
  claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
  PERFORM set_config('request.jwt.claim.role', COALESCE(claims->>'role', ''), true);
  PERFORM set_config('request.jwt.claim.sub', COALESCE(claims->>'sub', ''), true);
END
$r10$;
""")


def apply_vendor(state: dict[str, object]) -> None:
    try:
        entries = json.loads(VENDOR_MANIFEST.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read vendor manifest: {error}")
    if not isinstance(entries, list) or len(entries) != 13:
        fail(f"vendor manifest must contain 13 files, found {len(entries) if isinstance(entries, list) else 'invalid'}")
    for index, entry in enumerate(entries, 1):
        relative = entry.get("file") if isinstance(entry, dict) else None
        expected = entry.get("sha256") if isinstance(entry, dict) else None
        if not isinstance(relative, str) or not isinstance(expected, str):
            fail(f"invalid vendor manifest entry {index}")
        path = VENDOR_DIR / relative
        if not path.is_file():
            fail(f"vendor file is missing: {relative}")
        actual = hashlib.sha256(path.read_bytes()).hexdigest()
        if actual != expected:
            fail(f"vendor hash mismatch for {relative}: expected {expected}, got {actual}")
        source = path.read_text(encoding="utf-8").replace('{{ index .Options "Namespace" }}', "auth")
        result = sql(state, "SET storage.install_roles='false';\n" + source, timeout=240, check=False)
        if result.returncode:
            detail = (result.stderr + result.stdout).strip()
            fail(f"VENDOR_FAIL {relative}: {detail[-4000:]}")
        print(f"VENDOR_OK {index}/13 {relative}", flush=True)


def migrations() -> list[Path]:
    paths = sorted((ROOT / "supabase/migrations").glob("*.sql"), key=lambda path: path.name)
    if not paths:
        fail("no SQL migrations found")
    return paths


def apply_migrations(state: dict[str, object]) -> None:
    paths = migrations()
    print(f"APPLYING_SQL_MIGRATIONS count={len(paths)} through={paths[-1].name}", flush=True)
    fixture_dir = ROOT / "experiments/inbox-projection/fixture"
    sys.path.insert(0, str(fixture_dir))
    try:
        from transaction_envelope import normalize
    except ImportError as error:
        fail(f"cannot import transaction_envelope.normalize: {error}")
    for index, path in enumerate(paths, 1):
        try:
            source, removed = normalize(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as error:
            fail(f"MIGRATION_NORMALIZE_FAIL {path.name}: {error}")
        statement = (
            "BEGIN; SET LOCAL statement_timeout='120s'; SET LOCAL lock_timeout='5s'; "
            "SET LOCAL storage.install_roles='false';\n" + source + "\nCOMMIT;"
        )
        result = sql(state, statement, timeout=300, check=False)
        if result.returncode:
            detail = (result.stderr + result.stdout).strip()
            fail(f"MIGRATION_FAIL {path.name}: {detail[-5000:]}")
        journal = (
            "INSERT INTO supabase_migrations.schema_migrations(version,name,statements) "
            f"VALUES ({sql_literal(path.stem)}, {sql_literal(path.name)}, ARRAY['local-env']);"
        )
        sql(state, journal)
        if index % 25 == 0 or index > len(paths) - 8:
            print(f"MIGRATION_OK {index}/{len(paths)} {path.name} normalized_envelopes={removed}", flush=True)


def split_parameters(value: str) -> list[str]:
    result: list[str] = []
    start = 0
    depth = 0
    for index, char in enumerate(value):
        if char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
        elif char == "," and depth == 0:
            result.append(value[start:index])
            start = index + 1
    result.append(value[start:])
    return result if value.strip() else []


def projection_function_signatures() -> list[str]:
    source = MIGRATION.read_text(encoding="utf-8")
    signatures: list[str] = []
    pattern = re.compile(
        r"CREATE(?: OR REPLACE)? FUNCTION\s+([a-z_][a-z_0-9]*\.[a-z_][a-z_0-9]*)\s*\((.*?)\)\s+RETURNS",
        re.IGNORECASE | re.DOTALL,
    )
    for match in pattern.finditer(source):
        params: list[str] = []
        for raw in split_parameters(match.group(2)):
            parameter = re.sub(r"\s+DEFAULT\s+.*$", "", raw.strip(), flags=re.IGNORECASE | re.DOTALL)
            words = parameter.split()
            if not words:
                continue
            params.append(" ".join(words[1:]) if len(words) > 1 else words[0])
        signatures.append(f"{match.group(1)}({','.join(params)})")
    if len(signatures) != 7:
        fail(f"040250 function signature scan found {len(signatures)} functions, expected 7")
    return signatures


def check_state(state: dict[str, object], *, require_pre_request: bool = True) -> None:
    verify_frozen_hashes()
    data = Path(str(state["data"]))
    if not data.is_dir():
        fail(f"fixture data directory is missing: {data}")
    ready = command(
        [str(PG_BIN / "pg_isready"), "-h", str(state["socket"]), "-p", str(state["port"]), "-U", "postgres"],
        check=False,
        timeout=20,
    )
    if ready.returncode:
        fail(f"PostgreSQL is not ready at {state['socket']}:{state['port']}: {(ready.stderr + ready.stdout).strip()}")
    check_quiet_hours(state, "preflight")
    if not shutil.which("postgrest"):
        fail("postgrest is not on PATH")
    version = command([POSTGREST, "--version"], check=False, timeout=20)
    if version.returncode:
        fail(f"postgrest --version failed: {(version.stderr + version.stdout).strip()}")
    for port in (LOCAL_POSTGREST_PORT, LOCAL_SUPABASE_PROXY_PORT):
        if not port_free(port):
            fail(f"local integration port {port} is not free")

    values = sql_output(state, """
SELECT current_setting('server_version_num')::int / 10000,
       to_regclass('public.messages') IS NOT NULL,
       EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='messages' AND column_name='idempotency_key'
       ),
       EXISTS (
         SELECT 1
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
         WHERE i.indrelid=to_regclass('public.messages')
           AND i.indisunique
           AND a.attname='idempotency_key'
       );
""")
    parts = values.split("|")
    if len(parts) != 4:
        fail(f"unexpected schema preflight output: {values}")
    if parts[0] != "17":
        fail(f"PostgreSQL major must be 17, observed {parts[0]}")
    if parts[1:] != ["t", "t", "t"]:
        fail(f"messages schema preflight failed: messages={parts[1]} idempotency_key={parts[2]} unique_index={parts[3]}")
    print("LOCAL_ENV_CHECK PG_MAJOR=17", flush=True)
    print("LOCAL_ENV_CHECK messages.idempotency_key=present unique_index=present", flush=True)

    expected_names = [path.name for path in migrations()]
    journal = sql_output(state, """
SELECT count(*)::text || '|' || count(DISTINCT name)::text || '|' || COALESCE(string_agg(name, E'\n' ORDER BY name), '')
FROM supabase_migrations.schema_migrations;
""")
    first, distinct, *journal_lines = journal.split("|")
    observed_names = "|".join(journal_lines)
    expected_joined = "\n".join(expected_names)
    if first != str(len(expected_names)) or distinct != str(len(expected_names)) or observed_names != expected_joined:
        fail(f"migration journal mismatch: observed {first}/{distinct}, expected {len(expected_names)}")
    print(f"LOCAL_ENV_CHECK migration_journal={first}/{len(expected_names)}", flush=True)

    signatures = projection_function_signatures()
    values_sql = ",".join(f"({sql_literal(signature)})" for signature in signatures)
    present = sql_output(state, f"""
SELECT signature
FROM (VALUES {values_sql}) AS wanted(signature)
WHERE to_regprocedure(signature) IS NOT NULL
ORDER BY signature;
""").splitlines()
    if sorted(present) != sorted(signatures):
        missing = sorted(set(signatures) - set(present))
        fail(f"040250 function preflight failed; missing: {', '.join(missing)}")
    print(f"LOCAL_ENV_CHECK 040250_functions={len(present)}/{len(signatures)}", flush=True)

    pre_request_present = sql_output(state, "SELECT to_regprocedure('public.r10_local_pre_request()') IS NOT NULL;").lower() == "t"
    if require_pre_request and not pre_request_present:
        fail("public.r10_local_pre_request is missing")
    print(f"LOCAL_ENV_CHECK r10_local_pre_request={'present' if pre_request_present else 'absent_allowed'}", flush=True)
    print("LOCAL_ENV_CHECK frozen_hashes=3/3", flush=True)
    print(f"LOCAL_ENV_READY host={state['socket']} port={state['port']}", flush=True)


def up() -> None:
    verify_frozen_hashes()
    existing = load_state(required=False)
    if existing is not None:
        if fixture_alive(existing):
            print(f"LOCAL_ENV already up host={existing['socket']} port={existing['port']}", flush=True)
            check_state(existing)
            return
        down()

    for name in ("initdb", "pg_ctl", "pg_isready"):
        if not (PG_BIN / name).is_file():
            fail(f"PostgreSQL 17 binary is missing: {PG_BIN / name}")
    root = Path(tempfile.mkdtemp(prefix=DATA_PREFIX, dir="/tmp"))
    data = root / "data"
    socket_dir = root / "socket"
    socket_dir.mkdir(mode=0o700)
    port = pick_port()
    state = {"root": str(root), "data": str(data), "socket": str(socket_dir), "port": port}
    running = False
    try:
        command([
            str(PG_BIN / "initdb"), "-D", str(data), "-A", "trust", "-U", "postgres",
            "--locale=C.UTF-8", "--encoding=UTF8",
        ], timeout=180)
        with (data / "postgresql.conf").open("a", encoding="utf-8") as config:
            config.write("\n# local-env: socket-only fixture\nlisten_addresses = ''\n")
        command([
            str(PG_BIN / "pg_ctl"), "-D", str(data),
            "-o", f"-p {port} -k {socket_dir}",
            "-l", str(root / "postgres.log"), "start",
        ], timeout=60)
        running = True
        for _ in range(120):
            ready = command([
                str(PG_BIN / "pg_isready"), "-h", str(socket_dir), "-p", str(port), "-U", "postgres",
            ], check=False, timeout=10)
            if ready.returncode == 0:
                break
            time.sleep(0.1)
        else:
            fail("PostgreSQL 17 did not become ready")
        sql(state, bootstrap_sql(), timeout=120)
        apply_vendor(state)
        apply_migrations(state)
        seed_pre_request(state)
        save_state(state)
        check_state(state)
        print(f"LOCAL_ENV_UP state={STATE_PATH}", flush=True)
    except Exception:
        if running:
            command([str(PG_BIN / "pg_ctl"), "-D", str(data), "-m", "fast", "stop"], check=False, timeout=60)
        shutil.rmtree(root, ignore_errors=True)
        STATE_PATH.unlink(missing_ok=True)
        raise


def run_runner() -> int:
    state = load_state()
    check_state(state)
    environment = {
        **os.environ,
        "PROJECTION_PGHOST": str(state["socket"]),
        "PROJECTION_PGPORT": str(state["port"]),
        "PROJECTION_PGUSER": "postgres",
        "PROJECTION_PGDATABASE": "postgres",
        "LOCAL_POSTGREST_PORT": str(LOCAL_POSTGREST_PORT),
        "LOCAL_SUPABASE_PROXY_PORT": str(LOCAL_SUPABASE_PROXY_PORT),
        "PYTHONDONTWRITEBYTECODE": "1",
    }
    environment.pop("REPLY_PERSIST_" + "NO" + "_DOCKER", None)
    result = subprocess.run(
        [sys.executable, str(ROOT / "experiments/inbox-reply-send/mutation-run.py")],
        cwd=ROOT,
        env=environment,
    )
    try:
        check_state(state, require_pre_request=False)
    except LocalEnvError as error:
        print(f"LOCAL_ENV_FAIL: post-run preflight: {error}", file=sys.stderr)
        return 2
    print(f"LOCAL_ENV_RUN exit={result.returncode}", flush=True)
    return result.returncode


def down() -> None:
    state = load_state(required=False)
    if state is None:
        print("LOCAL_ENV already down", flush=True)
        return
    root = validate_owned_root(state)
    data = Path(str(state["data"]))
    if data.exists() and fixture_alive(state):
        result = command([str(PG_BIN / "pg_ctl"), "-D", str(data), "-m", "fast", "stop"], check=False, timeout=60)
        if result.returncode:
            fail(f"PostgreSQL teardown failed: {(result.stderr + result.stdout).strip()}")
    shutil.rmtree(root, ignore_errors=False)
    STATE_PATH.unlink(missing_ok=True)
    print(f"LOCAL_ENV_DOWN root={root}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("up", "check", "run", "down"))
    args = parser.parse_args()
    try:
        if args.command == "up":
            up()
            return 0
        if args.command == "check":
            check_state(load_state())
            return 0
        if args.command == "run":
            return run_runner()
        down()
        return 0
    except LocalEnvError as error:
        print(f"LOCAL_ENV_FAIL: {error}", file=sys.stderr)
        return 2
    except (OSError, subprocess.SubprocessError) as error:
        print(f"LOCAL_ENV_FAIL: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
