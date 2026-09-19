#!/usr/bin/env python3
"""G1 (#588) proof: exercise the real supabase-sync-repository snapshot->finalize
sequence (src/lib/inbox/supabase-sync-repository.ts) against the installed
public.inbox_sync_snapshot_v1 / public.inbox_sync_finalize_v1 companion RPCs,
plus a one-shot resolution check for the other six read-path RPCs named in
PLAN.md G1 (authorize_sync, get_sync_scope, bind_sync_handle, create_workset_v2,
counts_v2, inbox_acknowledge_read). Never leaves serving_enabled=true.
"""
import argparse, json, subprocess, sys, uuid
from pathlib import Path
P = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--owned-fixture", action="store_true")
a = ap.parse_args()
if not a.owned_fixture:
    raise SystemExit("Explicit owned fixture required")
from fixture_db import guard, sql, literal
guard()

RESOLVED_RPC_NAMES = [
    "inbox_authorize_sync",
    "inbox_get_sync_scope",
    "inbox_bind_sync_handle",
    "inbox_create_workset_v2",
    "inbox_counts_v2",
    "inbox_sync_snapshot_v1",
    "inbox_sync_finalize_v1",
    "inbox_acknowledge_read",
]
present = json.loads(sql(
    "SELECT coalesce(jsonb_agg(p.proname),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace "
    "WHERE n.nspname='public' AND p.proname = ANY(ARRAY['" + "','".join(RESOLVED_RPC_NAMES) + "'])"
))
missing = sorted(set(RESOLVED_RPC_NAMES) - set(present))
if missing:
    raise RuntimeError("G1 read-path RPCs missing from installed catalog: " + ",".join(missing))

o, u, sid = [str(uuid.uuid4()) for _ in range(3)]
sql(f"""BEGIN;
INSERT INTO organizations(id,name) VALUES('{o}','G1 smoke {o}');
INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.test');
INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sid}','{u}',clock_timestamp()+interval '1 hour');
INSERT INTO memberships(user_id,org_id,role,access_status) VALUES('{u}','{o}','owner','active');
COMMIT;""")
claims = json.dumps({"sub": u, "session_id": sid, "role": "authenticated", "exp": 4102444800})
def call(q): return sql("SET request.jwt.claims=" + literal(claims) + ";SET ROLE authenticated;" + q)

checks = []
sql("UPDATE inbox_control.rollout SET serving_enabled=true WHERE singleton")
try:
    # 1. inbox_create_workset_v2 (also proves inbox_authorize_sync transitively).
    workset = json.loads(call(
        f"SELECT public.inbox_create_workset_v2('{o}',{literal(json.dumps({'view':'all','hide_noise':True}))}::jsonb,50,NULL,NULL)"
    ))
    scope_id = workset["id"]
    checks.append("inbox_create_workset_v2 created a workset")

    # 2. inbox_get_sync_scope resolves the same scope.
    fetched = json.loads(call(f"SELECT public.inbox_get_sync_scope('{scope_id}')"))
    if fetched.get("id") != scope_id:
        raise RuntimeError("inbox_get_sync_scope did not return the created scope")
    checks.append("inbox_get_sync_scope round-trips the created scope")

    # 3. inbox_counts_v2 resolves for the same org (empty inbox is fine; only proves the RPC executes end to end).
    counts = json.loads(call(f"SELECT public.inbox_counts_v2('{o}',{literal(json.dumps({'view':'all','hide_noise':True}))}::jsonb)"))
    if "counts" not in counts:
        raise RuntimeError("inbox_counts_v2 did not return a counts object")
    checks.append("inbox_counts_v2 resolves")

    # 4. The real repository sequence: loadAuthorizedScope -> finalizeAuthorizedScope
    #    (supabase-sync-repository.ts:75,80), driven through inbox_sync_snapshot_v1 /
    #    inbox_sync_finalize_v1 exactly as the Next.js route calls them.
    snapshot = json.loads(call(f"SELECT public.inbox_sync_snapshot_v1('{scope_id}')"))
    if snapshot is None:
        raise RuntimeError("inbox_sync_snapshot_v1 returned null for a freshly created, owned scope")
    proof = snapshot["scope"]
    checks.append("inbox_sync_snapshot_v1 returns an authorized snapshot for the owned scope")

    finalized = json.loads(call(
        f"SELECT public.inbox_sync_finalize_v1('{scope_id}',{literal(json.dumps(proof))}::jsonb,0,NULL,'sync-handle-1')"
    ))
    if finalized.get("conflict") is True or finalized is None:
        raise RuntimeError("inbox_sync_finalize_v1 rejected the first, uncontested CAS write")
    checks.append("inbox_sync_finalize_v1 accepts the first CAS write (expected_handle=NULL)")

    # 5. inbox_bind_sync_handle: same CAS semantics via the sibling public wrapper
    #    (parity-v2.sql). A stale expected_handle must be rejected.
    stale = call(f"SELECT public.inbox_bind_sync_handle('{scope_id}',0,NULL,'other-handle')")
    if stale != "f":
        raise RuntimeError("inbox_bind_sync_handle accepted a stale expected_handle (CAS bypass)")
    checks.append("inbox_bind_sync_handle rejects a stale expected_handle (CAS holds)")

    # 6. inbox_sync_finalize_v1 CAS conflict: retrying with the now-stale expected_handle=NULL
    #    must report conflict=true, never silently overwrite.
    conflict = json.loads(call(
        f"SELECT public.inbox_sync_finalize_v1('{scope_id}',{literal(json.dumps(proof))}::jsonb,0,NULL,'sync-handle-2')"
    ))
    if conflict.get("conflict") is not True:
        raise RuntimeError("inbox_sync_finalize_v1 did not report a CAS conflict for a stale expected_handle")
    checks.append("inbox_sync_finalize_v1 reports conflict=true for a stale expected_handle (no silent overwrite)")
finally:
    sql("UPDATE inbox_control.rollout SET serving_enabled=false WHERE singleton")
if sql("SELECT serving_enabled FROM inbox_control.rollout WHERE singleton") != "f":
    raise RuntimeError("Smoke left serving enabled")
if len(checks) != 7:
    raise RuntimeError("Smoke did not complete all checks: " + json.dumps(checks))

(P / "read-companion-smoke-evidence.json").write_text(json.dumps({
    "passed": True,
    "org": o,
    "resolved_rpcs": RESOLVED_RPC_NAMES,
    "checks": checks,
    "scope": "Owned synthetic DB only; proves the real supabase-sync-repository snapshot->finalize sequence "
             "resolves and enforces CAS against the installed companion. Does not prove production throughput.",
}, indent=2) + "\n")
print("G1 read-companion smoke passed: " + "; ".join(checks))
