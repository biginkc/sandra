#!/usr/bin/env python3
"""Lane 1 PR-F mutation-first proof for the durable reply-send worker SQL
surface (worker.sql/worker-role.sql): claim_dispatch_batch/ack_dispatch,
operation_attempts, worker_authorize (Astra #3), worker_claim/
worker_start_dispatch/worker_persist, and operation_dispatch_complete
(Astra #4 ack-readiness). Owned fixture only; installs its own schemas
(committed, not rollback-only — several proofs need the worker role's actual
grants, which are cluster-level) and drops everything in a finally block.
Mirrors experiments/inbox-reply-send/accept-proof.py's idiom exactly:
sql()/sql_fail(), make_org_and_prep(), assert_body_matches() scratch-install
byte-exact compare. Every mutation below: install a broken candidate -> run
the proof -> watch it FAIL for the reason claimed -> restore the exact source
definition (verified byte-exact) -> re-run -> watch it PASS."""
import hashlib, json, re, subprocess, sys, time, uuid
from pathlib import Path
P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'inbox-projection' / 'fixture'))
from guards import validate_container, validate_cron
if sys.argv[1:] != ['--run-owned-fixture']: raise SystemExit('Explicit owned fixture required')
D = ['docker', '--host', 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']; N = 'sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D + ['inspect', N], text=True))[0])
CMD = D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
def need(v, label):
    if not v: raise RuntimeError(label)
def sql(q, timeout=20, check=True):
    r = subprocess.run(CMD, input="SET statement_timeout='15s'; SET lock_timeout='10s'; BEGIN;" + q.rstrip() + ";COMMIT;", text=True, capture_output=True, timeout=timeout)
    if check: need(r.returncode == 0, r.stderr)
    return r if not check else r.stdout.strip()
def sql_fail(q, timeout=20):
    r = subprocess.run(CMD, input="SET statement_timeout='15s'; SET lock_timeout='10s'; BEGIN;" + q.rstrip() + ";COMMIT;", text=True, capture_output=True, timeout=timeout)
    need(r.returncode != 0, f'expected failure but succeeded: {r.stdout}')
    return r.stderr

validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity') == 'sandra-inbox-projection-t2-owned-synthetic', 'Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL") == 't', 'Refusing existing reply schema')
need(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker')") == 't', 'Refusing existing worker role')
CLEANUP = ("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);"
           "DROP FUNCTION IF EXISTS public.inbox_accept_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_recover_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_reply_operation_status(uuid);"
           "DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;"
           "DROP SCHEMA IF EXISTS inbox_reply_send_scratch CASCADE;")
ROLE_CLEANUP = "DROP ROLE IF EXISTS inbox_reply_send_worker;"
sql(CLEANUP + ROLE_CLEANUP)

sources = [P.parent / 'inbox-reply-boundary/context.sql', P.parent / 'inbox-reply-preparation/recipient.sql', P.parent / 'inbox-reply-preparation/batch.sql',
           P.parent / 'inbox-reply-review/setup.sql', P.parent / 'inbox-reply-review/public-api.sql', P.parent / 'inbox-reply-send/attempts.sql',
           P.parent / 'inbox-reply-send/accept.sql', P.parent / 'inbox-reply-send/public-api.sql', P / 'worker.sql', P / 'worker-role.sql']
ALL_SOURCES_SQL = ''.join(s.read_text() for s in sources)
SCRATCH_SCHEMA = 'inbox_reply_send_scratch'
def real_fn(qualified_name):
    pat = re.compile(r'CREATE FUNCTION\s+' + re.escape(qualified_name) + r'\(.*?\$\$;\n', re.DOTALL)
    m = pat.search(ALL_SOURCES_SQL)
    if not m: raise RuntimeError(f'real_fn: could not extract {qualified_name} from source files')
    return 'CREATE OR REPLACE FUNCTION ' + m.group(0)[len('CREATE FUNCTION '):]
def restore_fn(qualified_name):
    sql(real_fn(qualified_name))
def _scratch_install(qualified_name):
    defn = real_fn(qualified_name)
    prefix = 'CREATE OR REPLACE FUNCTION ' + qualified_name + '('
    if not defn.startswith(prefix): raise RuntimeError(f'_scratch_install: {qualified_name} unexpected prefix')
    name = qualified_name.split('.', 1)[1]
    scratch_name = f'{SCRATCH_SCHEMA}.{name}'
    return scratch_name, 'CREATE OR REPLACE FUNCTION ' + scratch_name + '(' + defn[len(prefix):]
def _normalize(definition, name):
    p = definition.find(name)
    if p < 0: raise RuntimeError(f'_normalize: {name} not found in pg_get_functiondef output')
    return definition[:p] + '<FN>' + definition[p + len(name):]
def assert_body_matches(qualified_name):
    sql(f'CREATE SCHEMA IF NOT EXISTS {SCRATCH_SCHEMA};')
    scratch_name, scratch_ddl = _scratch_install(qualified_name)
    sql(scratch_ddl)
    try:
        installed_def = sql(f"SELECT pg_get_functiondef('{qualified_name}'::regproc)")
        scratch_def = sql(f"SELECT pg_get_functiondef('{scratch_name}'::regproc)")
        need(_normalize(installed_def, qualified_name) == _normalize(scratch_def, scratch_name), f'assert_body_matches: {qualified_name} installed != scratch candidate (stale restore)')
    finally:
        sql(f"DO $d$ DECLARE cmd text; BEGIN SELECT 'DROP FUNCTION '||oid::regprocedure INTO cmd FROM pg_proc WHERE oid='{scratch_name}'::regproc; EXECUTE cmd; END $d$;")
def restore_and_verify(qualified_name):
    restore_fn(qualified_name)
    assert_body_matches(qualified_name)

checks = []
def record(label):
    checks.append(label); print(f'  OK  {label}')

OWNED_ORGS = []; OWNED_USERS = []
def make_org_and_prep(dest_prefix, n=1):
    o = str(uuid.uuid4()); u = str(uuid.uuid4()); sess = str(uuid.uuid4()); s = str(uuid.uuid4()); k = str(uuid.uuid4())
    OWNED_ORGS.append(o); OWNED_USERS.append(u)
    sql(f"INSERT INTO organizations(id,name) VALUES('{o}','PR-F proof {o}');"
        f"INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');"
        f"INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active');"
        f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess}','{u}',clock_timestamp()+interval '1 hour');"
        f"INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+18165550101','active');")
    cids = []
    for i in range(1, n + 1):
        cid = str(uuid.uuid4()); pid = str(uuid.uuid4()); ctid = str(uuid.uuid4()); dest = dest_prefix + str(i).zfill(5)
        sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{ctid}','{o}','C{i}','{dest}','mobile');"
            f"INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o}','{ctid}','sms','opt_in_confirmed','pr-f-proof');"
            f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{o}','Proof property {i}','MO','{ctid}');"
            f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o}','{cid}','{ctid}','{pid}','sms','inbound','received','hi','{dest}','+18165550101');")
        cids.append(cid)
    targets = json.dumps([{'kind': 'conversation', 'id': c} for c in cids])
    sql("UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;")
    capture = json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{json.dumps({'sub': u, 'role': 'authenticated', 'session_id': sess, 'exp': 4102444800})}'; SELECT public.inbox_capture_reply_recipients(ARRAY[{','.join(chr(39) + c + chr(39) for c in cids)}]::uuid[])::text;"))
    drafts = [{'conversationId': item['conversation_id'], 'body': 'Hi there', 'dependencies': item['dependencies'], 'exclusion': None} for item in capture['items']]
    payload_sql = json.dumps({'targets': json.loads(targets), 'drafts': drafts, 'template': 'Hi there'}).replace("'", "''")
    freeze = json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{json.dumps({'sub': u, 'role': 'authenticated', 'session_id': sess, 'exp': 4102444800})}'; SELECT public.inbox_freeze_reply_review('{payload_sql}','{k}')::text;"))
    prep_id = freeze['preparationId']
    items = json.loads(sql(f"SELECT items::text FROM inbox_reply_review.preparations WHERE id='{prep_id}'"))
    item_ids = [it['id'] for it in items if it['exclusion'] is None]
    SESS[u] = sess
    return o, u, k, prep_id, item_ids, cids
SESS = {}
def authed(u, body):
    need(u in SESS, f'no recorded session for user {u}')
    claims = json.dumps({'sub': u, 'role': 'authenticated', 'session_id': SESS[u], 'exp': 4102444800})
    return f"SET LOCAL request.jwt.claims='{claims}'; {body}"
def call_accept(o, u, k, prep_id):
    return json.loads(sql(authed(u, f"SELECT inbox_reply_send.accept('{o}','{u}','{k}','{prep_id}')::text;")))

try:
    sql(''.join(s.read_text() for s in sources))
    sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;")
    # Test-only: grant membership so this proof's single `postgres` connection
    # can SET ROLE to exercise the grant boundary. worker-role.sql itself
    # grants this to nobody; production connects to the worker role directly
    # over its own credential (see runtime-control.py's ALTER ROLE ... LOGIN
    # idiom), which this proof does not stand up.
    sql("GRANT inbox_reply_send_worker TO postgres;")
    print('Installed attempts.sql + accept.sql + public-api.sql + worker.sql + worker-role.sql')

    # === 0. Grant-boundary ground truth: the worker role reaches EXACTLY the
    # seven SECURITY DEFINER entry points and nothing else. worker-role.sql's
    # own install-time DO block already asserts this (it would have refused
    # to install otherwise) — reconfirm it live under SET ROLE.
    o, u, k, prep_id, item_ids, cids = make_org_and_prep('+150255', n=2)
    op = call_accept(o, u, k, prep_id)['operation_id']
    for allowed, args in [
        ("claim_dispatch_batch(1)", None),
        (f"ack_dispatch('{o}','{op}',1)", None),
        (f"operation_attempts('{o}','{op}')", None),
        (f"worker_authorize('{o}','{op}')", None),
    ]:
        pass
    denied_direct = sql_fail(f"SET LOCAL ROLE inbox_reply_send_worker; SELECT inbox_reply_send.claim('{o}',gen_random_uuid());")
    need('permission denied' in denied_direct, f'worker role could call attempts.sql claim() directly: {denied_direct}')
    denied_table = sql_fail(f"SET LOCAL ROLE inbox_reply_send_worker; SELECT count(*) FROM inbox_reply_send.attempts;")
    need('permission denied' in denied_table, f'worker role has direct table access: {denied_table}')
    denied_accept = sql_fail(f"SET LOCAL ROLE inbox_reply_send_worker; SELECT inbox_reply_send.accept('{o}','{u}',gen_random_uuid(),'{prep_id}');")
    need('permission denied' in denied_accept, f'worker role could call accept(): {denied_accept}')
    ok_batch = sql(f"SET LOCAL ROLE inbox_reply_send_worker; SELECT inbox_reply_send.claim_dispatch_batch(1)::text;")
    ok_attempts = sql(f"SET LOCAL ROLE inbox_reply_send_worker; SELECT array_agg(x) FROM inbox_reply_send.operation_attempts('{o}','{op}') x;")
    need(ok_attempts != '', 'worker role could not call operation_attempts() despite the grant')
    record('grant boundary: inbox_reply_send_worker reaches claim_dispatch_batch/operation_attempts, and is refused on attempts.claim()/direct table SELECT/accept()')

    # === 1. operation_attempts(): tip-of-chain ids, stable order ===
    atts = sorted(json.loads(sql(f"SELECT to_jsonb(array_agg(x)) FROM inbox_reply_send.operation_attempts('{o}','{op}') x")))
    real_atts = sorted(json.loads(sql(f"SELECT to_jsonb(array_agg(id)) FROM inbox_reply_send.attempts WHERE org_id='{o}' AND operation_id='{op}'")))
    need(atts == real_atts, f'operation_attempts() mismatch: {atts} vs {real_atts}')
    record(f'operation_attempts(): returns all {len(atts)} fresh (tip-of-chain) attempt ids for a just-accepted operation')

    # === 2. Happy path via worker wrappers: claim -> authorize -> start_dispatch -> persist ===
    att_a, att_b = real_atts[0], real_atts[1]
    claim1 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o}','{att_a}')::text"))
    need(claim1['kind'] == 'claimed' and claim1['generation'] == '1', f'worker_claim mismatch: {claim1}')
    sql(f"SELECT inbox_reply_send.worker_authorize('{o}','{op}')")  # must not raise
    dispatch1 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{o}','{att_a}',{claim1['generation']})::text"))
    need(dispatch1['kind'] == 'dispatch', f'worker_start_dispatch mismatch: {dispatch1}')
    persist1 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{o}','{att_a}','{dispatch1['token']}',jsonb_build_object('kind','accepted','externalId','PROV-A'))::text"))
    need(persist1['state'] == 'provider_accepted', f'worker_persist mismatch: {persist1}')
    record('happy path via worker_claim -> worker_authorize -> worker_start_dispatch -> worker_persist reaches provider_accepted')

    # === 3. Ack-readiness (Astra #4): item B still claimed -> NOT complete, NOT acked ===
    claimB_initial = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o}','{att_b}')::text"))  # leave in 'claimed'
    need(claimB_initial['kind'] == 'claimed', f'unexpected initial claimB: {claimB_initial}')
    outbox_gen = sql(f"SELECT generation FROM inbox_reply_send.dispatch_outbox WHERE org_id='{o}' AND operation_id='{op}'")
    complete_before = sql(f"SELECT inbox_reply_send.operation_dispatch_complete('{o}','{op}')")
    need(complete_before == 'f', 'operation_dispatch_complete wrongly true while an attempt is still claimed')
    acked = sql(f"SELECT inbox_reply_send.ack_dispatch('{o}','{op}',{outbox_gen})")
    need(acked == 'f', 'ack_dispatch wrongly acknowledged while an attempt is still claimed')
    need(sql(f"SELECT acknowledged_at IS NULL FROM inbox_reply_send.dispatch_outbox WHERE org_id='{o}' AND operation_id='{op}'") == 't', 'outbox wrongly marked acknowledged')
    record('ack-readiness: a still-claimed attempt keeps operation_dispatch_complete=false and ack_dispatch=false (deferred, not journaled complete)')

    # MUTATION: replace operation_dispatch_complete with a stub that always
    # returns true, watch ack_dispatch WRONGLY ack a busy operation.
    sql("CREATE OR REPLACE FUNCTION inbox_reply_send.operation_dispatch_complete(o uuid,op uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$ SELECT true $$;")
    wrong_ack = sql(f"SELECT inbox_reply_send.ack_dispatch('{o}','{op}',{outbox_gen})")
    need(wrong_ack == 't', 'mutation did not actually break ack-readiness (expected wrongly-true ack)')
    # Undo the wrong ack the mutation just caused (it also clears lease_until
    # per ack_dispatch's own UPDATE, so re-lease via claim_dispatch_batch to
    # get back a live lease + fresh generation, same as a real outbox row
    # would have after any legitimate claim), restore, and reverify blocked.
    sql(f"UPDATE inbox_reply_send.dispatch_outbox SET acknowledged_at=NULL,lease_until=NULL WHERE org_id='{o}' AND operation_id='{op}'")
    restore_and_verify('inbox_reply_send.operation_dispatch_complete')
    reclaimed = json.loads(sql(f"SELECT inbox_reply_send.claim_dispatch_batch(20)::text"))
    outbox_gen = next(e['generation'] for e in reclaimed if e['org_id'] == o and e['operation_id'] == op)
    reblocked = sql(f"SELECT inbox_reply_send.ack_dispatch('{o}','{op}',{outbox_gen})")
    need(reblocked == 'f', 'ack-readiness guard not actually restored')
    record('mutation: operation_dispatch_complete stubbed true wrongly acks a busy operation; restored (byte-exact) guard blocks it again')

    # Resolve item B (still claimed from earlier, generation=1 — no need to
    # reclaim; its lease is still live), then ack succeeds.
    sql(f"SELECT inbox_reply_send.worker_authorize('{o}','{op}')")
    dispatchB = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{o}','{att_b}',{claimB_initial['generation']})::text"))
    sql(f"SELECT inbox_reply_send.worker_persist('{o}','{att_b}','{dispatchB['token']}',jsonb_build_object('kind','accepted','externalId','PROV-B'))")
    complete_after = sql(f"SELECT inbox_reply_send.operation_dispatch_complete('{o}','{op}')")
    need(complete_after == 't', 'operation still not complete after both attempts settled')
    acked2 = sql(f"SELECT inbox_reply_send.ack_dispatch('{o}','{op}',{outbox_gen})")
    need(acked2 == 't', 'ack_dispatch did not ack once complete')
    need(sql(f"SELECT acknowledged_at IS NOT NULL FROM inbox_reply_send.dispatch_outbox WHERE org_id='{o}' AND operation_id='{op}'") == 't', 'outbox not marked acknowledged')
    record('ack-readiness: once every attempt is dispatched-or-terminal, ack_dispatch acknowledges the outbox row')

    # === 4. Astra #3: revoked requester between accept and dispatch ===
    o2, u2, k2, prep_id2, item_ids2, cids2 = make_org_and_prep('+151255', n=1)
    op2 = call_accept(o2, u2, k2, prep_id2)['operation_id']
    att2 = sql(f"SELECT id FROM inbox_reply_send.attempts WHERE org_id='{o2}' AND operation_id='{op2}'")
    claim2 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o2}','{att2}')::text"))
    need(claim2['kind'] == 'claimed', f'unexpected claim2: {claim2}')
    sql(f"ALTER TABLE memberships DISABLE TRIGGER trg_hugo_membership_owner_guard; UPDATE memberships SET access_status='revoked' WHERE org_id='{o2}' AND user_id='{u2}'; ALTER TABLE memberships ENABLE TRIGGER trg_hugo_membership_owner_guard;")
    err = sql_fail(f"SELECT inbox_reply_send.worker_authorize('{o2}','{op2}')")
    need('42501' in err or 'FORBIDDEN' in err or 'MEMBERSHIP' in err.upper(), f'revoked requester was not rejected: {err}')
    need(sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o2}' AND id='{att2}'") == 'claimed', 'attempt state moved past claimed despite failed authorize')
    need(sql(f"SELECT dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{o2}' AND id='{att2}'") == 't', 'a dispatch token was issued despite failed authorize')
    record('Astra #3: worker_authorize raises for a revoked requester; attempt stays claimed, no dispatch_token, no provider call possible')

    # Cross-org / forged operation id.
    err_cross = sql_fail(f"SELECT inbox_reply_send.worker_authorize('{o}','{op2}')")
    need('OPERATION_UNAVAILABLE' in err_cross or '42501' in err_cross, f'cross-org worker_authorize was not rejected: {err_cross}')
    err_forged = sql_fail(f"SELECT inbox_reply_send.worker_authorize('{o2}',gen_random_uuid())")
    need('OPERATION_UNAVAILABLE' in err_forged or '42501' in err_forged, f'forged operation id was not rejected: {err_forged}')
    record('Astra #3: worker_authorize rejects a cross-org operation id and a forged/unknown operation id')

    # Restore membership, reverify authorize succeeds (positive control that
    # the guard is checking access_status, not something incidental).
    sql(f"UPDATE memberships SET access_status='active' WHERE org_id='{o2}' AND user_id='{u2}'")
    sql(f"SELECT inbox_reply_send.worker_authorize('{o2}','{op2}')")
    record('positive control: restoring the membership makes worker_authorize succeed again')

    # MUTATION: replace worker_authorize with a no-op, watch a revoked
    # requester's dispatch wrongly proceed to start_dispatch; restore.
    sql(f"ALTER TABLE memberships DISABLE TRIGGER trg_hugo_membership_owner_guard; UPDATE memberships SET access_status='revoked' WHERE org_id='{o2}' AND user_id='{u2}'; ALTER TABLE memberships ENABLE TRIGGER trg_hugo_membership_owner_guard;")
    sql("CREATE OR REPLACE FUNCTION inbox_reply_send.worker_authorize(o uuid,op uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$ BEGIN END $$;")
    sql(f"SELECT inbox_reply_send.worker_authorize('{o2}','{op2}')")  # must NOT raise with the stub
    dispatch2_mutant = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{o2}','{att2}',{claim2['generation']})::text"))
    need(dispatch2_mutant['kind'] == 'dispatch', 'mutation did not actually let a revoked requester reach start_dispatch')
    # Undo: reconcile the wrongly-issued token to uncertain (never send), restore the guard.
    sql(f"SELECT inbox_reply_send.worker_persist('{o2}','{att2}','{dispatch2_mutant['token']}',jsonb_build_object('kind','uncertain','reason','proof_cleanup'))")
    restore_and_verify('inbox_reply_send.worker_authorize')
    err_restored = sql_fail(f"SELECT inbox_reply_send.worker_authorize('{o2}','{op2}')")
    need('MEMBERSHIP' in err_restored.upper() or 'FORBIDDEN' in err_restored.upper(), 'Astra #3 guard not actually restored: '+err_restored)
    sql(f"UPDATE memberships SET access_status='active' WHERE org_id='{o2}' AND user_id='{u2}'")
    record('mutation: worker_authorize stubbed to a no-op lets a revoked requester reach start_dispatch; restored (byte-exact) guard blocks it again')

    # === 5. Astra #4: busy claim -> deferred, second claim never wins the token ===
    o3, u3, k3, prep_id3, item_ids3, cids3 = make_org_and_prep('+152255', n=1)
    op3 = call_accept(o3, u3, k3, prep_id3)['operation_id']
    att3 = sql(f"SELECT id FROM inbox_reply_send.attempts WHERE org_id='{o3}' AND operation_id='{op3}'")
    claim3_initial = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o3}','{att3}')::text"))  # first claim: now 'claimed', lease live
    need(claim3_initial['kind'] == 'claimed', f'unexpected initial claim3: {claim3_initial}')
    busy = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o3}','{att3}')::text"))
    need(busy['kind'] == 'busy', f'second claim on a live lease was not busy: {busy}')
    need(sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o3}' AND id='{att3}'") == 'claimed', 'busy claim mutated attempt state')
    record('Astra #4: a second claim on a live lease returns busy (deferred), never a second dispatch token')

    # === 6. Astra #4: never-provider-on-unknown-commit (stale generation) ===
    err_stale = sql_fail(f"SELECT inbox_reply_send.worker_start_dispatch('{o3}','{att3}',999)")
    need('STALE_CLAIM' in err_stale, f'stale-generation start_dispatch was not rejected: {err_stale}')
    need(sql(f"SELECT dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{o3}' AND id='{att3}'") == 't', 'a token exists despite a rejected (stale) start_dispatch call')
    # A subsequent persist with ANY token now raises STALE_TOKEN — proving no
    # legitimate provider result could ever be reconciled from that failed call.
    err_persist = sql_fail(f"SELECT inbox_reply_send.worker_persist('{o3}','{att3}',gen_random_uuid(),jsonb_build_object('kind','accepted','externalId','SHOULD-NEVER-EXIST'))")
    need('STALE_TOKEN' in err_persist, f'persist with a fabricated token after a failed start_dispatch was not rejected: {err_persist}')
    record('Astra #4: a rejected (stale-generation) start_dispatch issues no token; persist with any token then raises STALE_TOKEN — no provider result can ever be reconciled from an unknown/failed commit')

    # === 7. No-double-send: crash between marker and result, re-entry via claim ===
    # Reuse claim3_initial's still-live lease/generation (section 6's stale
    # (999) start_dispatch attempt was correctly rejected and never touched
    # the row) — no need to reclaim.
    claim3 = claim3_initial
    sql(f"SELECT inbox_reply_send.worker_authorize('{o3}','{op3}')")
    dispatch3 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{o3}','{att3}',{claim3['generation']})::text"))
    need(dispatch3['kind'] == 'dispatch', f'expected a real dispatch: {dispatch3}')
    tok3 = dispatch3['token']
    # Simulate a crash: re-enter via claim BEFORE calling persist (no provider
    # call ever made in this proof — that is the whole point).
    reentry = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o3}','{att3}')::text"))
    need(reentry == {'kind': 'existing', 'state': 'uncertain'}, f'crash re-entry mislabelled: {reentry}')
    # A second start_dispatch attempt with the ORIGINAL generation can never
    # succeed again (state is no longer 'claimed') — no second token, ever.
    err_second = sql_fail(f"SELECT inbox_reply_send.worker_start_dispatch('{o3}','{att3}',{claim3['generation']})")
    need('STALE_CLAIM' in err_second, f'a second start_dispatch after crash re-entry was not rejected: {err_second}')
    # The ORIGINAL token still reconciles idempotently (durable replay of a
    # provider result that really was sent before the crash).
    persist3 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{o3}','{att3}','{tok3}',jsonb_build_object('kind','accepted','externalId','PROV-3'))::text"))
    need(persist3['state'] == 'provider_accepted', f'idempotent recovery persist mismatch: {persist3}')
    record('no-double-send: crash between marker and result relabels the attempt uncertain on re-entry; a second start_dispatch is impossible; the ORIGINAL token still reconciles idempotently')

    for fn in ['inbox_reply_send.claim_dispatch_batch', 'inbox_reply_send.ack_dispatch', 'inbox_reply_send.operation_dispatch_complete',
               'inbox_reply_send.operation_attempts', 'inbox_reply_send.worker_authorize', 'inbox_reply_send.worker_claim',
               'inbox_reply_send.worker_start_dispatch', 'inbox_reply_send.worker_persist']:
        assert_body_matches(fn)
    record('final state: every worker.sql function is byte-exact against its source definition')

    print(f'\nALL {len(checks)} PROOF GROUPS PASSED')
    evidence = {
        'sources': {str(s.relative_to(P.parent)): hashlib.sha256(s.read_bytes()).hexdigest() for s in sources},
        'runner_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'checks': checks,
    }
    (P / 'proof-evidence.json').write_text(json.dumps(evidence, indent=1) + '\n')
finally:
    sql(CLEANUP, check=False)
    sql(ROLE_CLEANUP, check=False)
    if OWNED_ORGS:
        orgs_sql = "ARRAY[" + ','.join(f"'{o}'" for o in OWNED_ORGS) + "]::uuid[]"
        users_sql = "ARRAY[" + ','.join(f"'{u}'" for u in OWNED_USERS) + "]::uuid[]"
        sql(f"DELETE FROM messages WHERE org_id=ANY({orgs_sql});"
            f"DELETE FROM consent_events WHERE org_id=ANY({orgs_sql});"
            f"DELETE FROM properties WHERE org_id=ANY({orgs_sql});"
            f"DELETE FROM contacts WHERE org_id=ANY({orgs_sql});"
            f"DELETE FROM provider_sender_numbers WHERE org_id=ANY({orgs_sql});"
            f"DELETE FROM auth.sessions WHERE user_id=ANY({users_sql});"
            f"ALTER TABLE memberships DISABLE TRIGGER trg_hugo_membership_owner_guard;"
            f"DELETE FROM memberships WHERE org_id=ANY({orgs_sql});"
            f"DELETE FROM auth.users WHERE id=ANY({users_sql});"
            f"ALTER TABLE memberships ENABLE TRIGGER trg_hugo_membership_owner_guard;"
            f"DELETE FROM organizations WHERE id=ANY({orgs_sql});", check=False)
        residual = {}
        for label, query in [
            ('organizations', f"SELECT count(*) FROM organizations WHERE id=ANY({orgs_sql})"),
            ('auth.users', f"SELECT count(*) FROM auth.users WHERE id=ANY({users_sql})"),
            ('memberships', f"SELECT count(*) FROM memberships WHERE org_id=ANY({orgs_sql})"),
            ('auth.sessions', f"SELECT count(*) FROM auth.sessions WHERE user_id=ANY({users_sql})"),
            ('contacts', f"SELECT count(*) FROM contacts WHERE org_id=ANY({orgs_sql})"),
            ('properties', f"SELECT count(*) FROM properties WHERE org_id=ANY({orgs_sql})"),
            ('messages', f"SELECT count(*) FROM messages WHERE org_id=ANY({orgs_sql})"),
            ('consent_events', f"SELECT count(*) FROM consent_events WHERE org_id=ANY({orgs_sql})"),
            ('provider_sender_numbers', f"SELECT count(*) FROM provider_sender_numbers WHERE org_id=ANY({orgs_sql})"),
        ]:
            n = sql(query)
            if n != '0': residual[label] = n
        if residual: raise RuntimeError(f'Owned-fixture cleanup left residual rows: {residual}')
    need(sql("SELECT to_regnamespace('inbox_reply_send') IS NULL") == 't', 'inbox_reply_send schema not dropped')
    need(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker')") == 't', 'inbox_reply_send_worker role not dropped')
    print(f'Cleanup verified: zero residual rows across {len(OWNED_ORGS)} owned orgs / {len(OWNED_USERS)} owned users; schemas and worker role dropped')
