#!/usr/bin/env python3
"""Read-only identity and admission probe for the owned release database."""

from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[2]
SOCKET = os.environ.get(
    "INBOX_T2_DOCKER_SOCKET",
    "unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock",
)
CONTAINER = "sandra-inbox-projection-t2-db"
DATABASE = os.environ.get("INBOX_RELEASE_DATABASE", "")
MARKER = os.environ.get("INBOX_RELEASE_FIXTURE_MARKER", "")
EXPECTED_DATABASE = "sandra_inbox_release_20260917"
EXPECTED_MARKER = "sandra-inbox-release-owned-synthetic"

RECEIPT_EXPECTED_ERRORS: dict[str, tuple[str, ...]] = {
    "public.inbox_operation_status(uuid)": ("INBOX_ACTION_OPERATION_UNAVAILABLE",),
    "public.inbox_recover_operation(uuid,uuid)": ("INBOX_ACTION_PREPARATION_UNAVAILABLE",),
    "public.inbox_reply_operation_status(uuid)": ("INBOX_REPLY_OPERATION_UNAVAILABLE",),
    "public.inbox_recover_reply(uuid,uuid)": ("INBOX_REPLY_PREPARATION_UNAVAILABLE",),
}


class ReceiptProbeError(RuntimeError):
    """The wrapper probe did not produce the expected authenticated outcome."""


def receipt_probe_sql(actor: str, session: str, org: str, invocation: str) -> str:
    """Build one rollback-scoped wrapper probe.

    Fixture setup runs as the privileged probe role.  Only after serving state
    is disabled do we switch to ``authenticated`` and invoke the public
    wrapper, so a private-table permission error cannot masquerade as proof.
    """
    claims = json.dumps(
        {"sub": actor, "session_id": session, "role": "authenticated", "exp": 4102444800},
        separators=(",", ":"),
    )
    escaped_claims = claims.replace("'", "''")
    return (
        "BEGIN;"
        f"INSERT INTO auth.users(id,email,role) VALUES('{actor}','{actor}@example.invalid','authenticated');"
        f"INSERT INTO organizations(id,name) VALUES('{org}','release receipt probe {org}');"
        f"INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{actor}','{org}','owner','active');"
        f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{session}','{actor}',clock_timestamp()+interval '1 hour');"
        "UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;"
        "SET LOCAL ROLE authenticated;"
        f"SET LOCAL request.jwt.claims='{escaped_claims}';"
        + invocation
        + "ROLLBACK;"
    )


def classify_receipt_probe(signature: str, code: int, output: str, stderr: str) -> str:
    """Accept only the wrapper's known missing-reference outcome.

    A nonzero status alone proves nothing: the SQL may have aborted before the
    wrapper (for example, while updating the private rollout table).  The
    wrapper-specific error marker is the reachability evidence.
    """
    combined = "\n".join(part for part in (stderr, output) if part)
    if code == 0:
        raise ReceiptProbeError(f"receipt/status wrapper unexpectedly succeeded: {signature}")
    if "INBOX_NOT_READY" in combined:
        raise ReceiptProbeError(f"receipt/status wrapper remains coupled to serving gate: {signature}")
    if "permission denied" in combined.lower():
        raise ReceiptProbeError(f"receipt/status probe failed before wrapper invocation: {signature}: {stderr}")
    expected = RECEIPT_EXPECTED_ERRORS.get(signature, ())
    marker = next((candidate for candidate in expected if candidate in combined), None)
    if marker is None:
        raise ReceiptProbeError(
            f"receipt/status wrapper did not produce an expected authenticated outcome: {signature}: {stderr or output}"
        )
    return f"PASS (authenticated wrapper reached expected outcome: {marker})"


def fail(message: str) -> int:
    print(json.dumps({"status": "FAIL", "detail": message}, indent=2))
    return 1


def sql(statement: str) -> tuple[int, str, str]:
    result = subprocess.run(
        [
            "docker",
            "--host",
            SOCKET,
            "exec",
            "-i",
            CONTAINER,
            "psql",
            "-XqAt",
            "-U",
            "supabase_admin",
            "-d",
            DATABASE,
            "-v",
            "ON_ERROR_STOP=1",
        ],
        input=statement,
        text=True,
        capture_output=True,
        timeout=30,
        cwd=ROOT,
    )
    return result.returncode, result.stdout.strip(), result.stderr.strip()


def main() -> int:
    if DATABASE != EXPECTED_DATABASE:
        return fail("INBOX_RELEASE_DATABASE is not the dedicated release database")
    if MARKER != EXPECTED_MARKER:
        return fail("release fixture marker was not explicitly confirmed")
    if not SOCKET.startswith("unix://"):
        return fail("release probe refuses a non-local Docker endpoint")
    inspect = subprocess.run(
        ["docker", "--host", SOCKET, "inspect", CONTAINER],
        text=True,
        capture_output=True,
        check=False,
        timeout=30,
        cwd=ROOT,
    )
    if inspect.returncode:
        return fail(f"guarded release container is unavailable: {inspect.stderr.strip()}")
    try:
        details = json.loads(inspect.stdout)[0]
    except (ValueError, IndexError) as exc:
        return fail(f"guarded release container metadata is invalid: {exc}")
    if details.get("Config", {}).get("Labels", {}).get("purpose") != "sandra-inbox-projection-t2":
        return fail("release probe found the wrong container ownership label")

    code, identity, stderr = sql(
        "SELECT current_database() || '|' || "
        "coalesce((SELECT marker FROM install_fixture.identity LIMIT 1),'') || '|' || "
        "coalesce((SELECT serving_enabled::text FROM inbox_control.rollout WHERE singleton),'missing');"
    )
    if code:
        return fail(f"release database identity query failed: {stderr}")
    expected_identity = f"{EXPECTED_DATABASE}|{EXPECTED_MARKER}|false"
    if identity != expected_identity:
        return fail(f"wrong release database identity or serving state: {identity!r}")

    # With serving disabled, this direct authenticated-domain RPC must fail
    # before it attempts any session or membership lookup. This is the
    # rollback admission proof; the private operation receipt probe below is
    # deliberately blocked until the operation wrappers are installed.
    code, _, stderr = sql("SELECT public.inbox_authorize_sync(NULL);")
    if code == 0 or "INBOX_NOT_READY" not in stderr:
        return fail(
            "serving-disabled direct RPC did not fail closed with INBOX_NOT_READY: "
            + (stderr or "unexpected success")
        )

    code, wrappers, stderr = sql(
        "SELECT coalesce(jsonb_agg(p.oid::regprocedure::text ORDER BY 1),'[]') "
        "FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
        "WHERE n.nspname='public' AND p.proname IN "
        "('inbox_operation_status','inbox_recover_operation','inbox_accept_action','inbox_prepare_action',"
        "'inbox_accept_reply','inbox_recover_reply','inbox_reply_operation_status');"
    )
    if code:
        return fail(f"operation wrapper inventory query failed: {stderr}")
    wrapper_names = json.loads(wrappers or "[]")
    wrapper_names_compact = {name.replace(" ", "") for name in wrapper_names}
    # Receipt status/recovery must stay authenticated and callable while
    # serving and new-command admission are disabled.  Exercise every
    # available reviewed public status/recovery wrapper with a real temporary
    # Auth session/membership.  A missing operation is an acceptable result;
    # INBOX_NOT_READY proves the wrapper is still incorrectly coupled to the
    # serving gate.  Each probe is rolled back at the connection boundary.
    receipt_specs = {
        "public.inbox_operation_status(uuid)": "SELECT public.inbox_operation_status(gen_random_uuid());",
        "public.inbox_recover_operation(uuid,uuid)": "SELECT public.inbox_recover_operation(gen_random_uuid(),gen_random_uuid());",
        "public.inbox_reply_operation_status(uuid)": "SELECT public.inbox_reply_operation_status(gen_random_uuid());",
        "public.inbox_recover_reply(uuid,uuid)": "SELECT public.inbox_recover_reply(gen_random_uuid(),gen_random_uuid());",
    }
    receipt_checks: dict[str, str] = {}
    for signature, invocation in receipt_specs.items():
        if signature not in wrapper_names_compact:
            continue
        actor = str(uuid.uuid4())
        session = str(uuid.uuid4())
        org = str(uuid.uuid4())
        setup = receipt_probe_sql(actor, session, org, invocation)
        call_code, call_output, call_stderr = sql(setup)
        try:
            receipt_checks[signature] = classify_receipt_probe(signature, call_code, call_output, call_stderr)
        except ReceiptProbeError as error:
            return fail(str(error))
    # If the reviewed operation adapter is present, exercise the actual public
    # prepare RPC inside a rolled-back transaction.  The rollback packet must
    # disable admission even when an operator had previously enabled a family
    # and enrolled a cohort; receipt/status/recovery are deliberately omitted
    # from this command-admission check.  Missing adapters remain an honest
    # blocker rather than being replaced by a helper-only assertion.
    direct_prepare = "BLOCKED"
    direct_prepare_detail = "operation prepare wrapper is not installed"
    if "public.inbox_prepare_action(text,uuid)" in wrapper_names_compact:
        code, output, stderr = sql(
            "BEGIN;"
            "UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton;"
            "UPDATE inbox_control.command_admission SET enabled=false,updated_at=clock_timestamp();"
            "DO $$ DECLARE passed boolean:=false; BEGIN "
            "BEGIN PERFORM public.inbox_prepare_action('{}',gen_random_uuid()); "
            "EXCEPTION WHEN OTHERS THEN "
            "IF SQLERRM='INBOX_COMMAND_DISABLED' THEN passed:=true; "
            "ELSIF SQLERRM='INBOX_NOT_READY' THEN RAISE EXCEPTION 'prepare RPC still coupled to serving gate'; "
            "ELSE RAISE; END IF; END; "
            "IF NOT passed THEN RAISE EXCEPTION 'direct prepare RPC unexpectedly succeeded'; END IF; END $$;"
            "ROLLBACK;"
            "SELECT 'rollback_prepare_denied';"
        )
        if code:
            return fail("rollback direct prepare admission proof failed: " + (stderr or output))
        direct_prepare = "PASS"
        direct_prepare_detail = output or "rollback_prepare_denied"
    result = {
        "status": "PASS" if wrapper_names and direct_prepare == "PASS" else "BLOCKED",
        "database": EXPECTED_DATABASE,
        "marker": EXPECTED_MARKER,
        "serving_enabled": False,
        "direct_read_rpc": "INBOX_NOT_READY",
        "operation_wrappers": wrapper_names,
        "direct_prepare_after_rollback": direct_prepare,
        "receipt_status_recovery": receipt_checks or "BLOCKED: no reviewed status/recovery wrappers installed",
        "detail": (
            "rollback serving gate denied read RPC; command admission denied direct prepare after rollback; receipt/status/recovery wrappers remained callable"
            if direct_prepare == "PASS"
            else "rollback direct read proof passed; " + direct_prepare_detail + "; receipt/status/recovery=" + ("verified" if receipt_checks else "not installed")
        ),
    }
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 3


if __name__ == "__main__":
    raise SystemExit(main())
