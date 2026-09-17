#!/usr/bin/env python3
"""Lane 1 capstone: SYNTHETIC end-to-end send-lane proof (Astra plan-finding
#8). Composes every merged reply-send piece — freeze/prepare
(inbox-reply-review), accept (PR-E, accept.sql), the durable worker SQL
surface (PR-F, worker.sql: worker_claim/worker_start_dispatch/worker_persist/
claim_dispatch_batch/ack_dispatch/operation_dispatch_complete/
operation_attempts) and the callback ingress (PR-G, callback.sql) — end to
end against the REAL merged synthetic reply-send double
(src/lib/inbox/reply-provider.synthetic.ts, via a tiny CLI shim run under
tsx: synthetic-cli.mjs) as the send seam. NEVER a real Sendillo call — the
synthetic double never calls fetch. No merged file is touched; this whole
proof lives in this one new directory.

This orchestrator plays the role runner.mjs/server.mjs play in production
(the Restate-driven per-attempt dispatch loop already proven for real by
inbox-reply-send-worker/runtime-proof.py's container-kill/redelivery test):
it calls the SAME SQL surface (worker_claim -> worker_start_dispatch ->
[provider call] -> worker_persist) directly, as postgres, so the ledger's own
crash-tolerance contract can be driven and asserted deterministically without
standing up a second Restate engine.

Structure:
  Section A: the composed happy-path lifecycle for a 3-item batch, one
    attempt scripted to each of the three dispatch-time provider outcomes
    (accepted / uncertain / not_attempted), through to ack + callback +
    operation_status.
  Section B: six crash-boundary proofs (b1-b6), each asserting the
    no-double-send / no-strand invariant, with a mutation-first watch-FAIL/
    restore/watch-PASS cycle on b1 (outbox double-pickup) and b2 (claim()
    re-entry racing a fresh token) — the two invariants specific to the
    WORKER layer that no existing merged proof exercises end-to-end.
Every organization/user created here is synthetic and swept by the shared
owned_cleanup module (imported, not copied, from
inbox-reply-send-worker/owned_cleanup.py) before this script exits.
"""
import json, os, re, subprocess, sys, uuid
from pathlib import Path

P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'inbox-projection' / 'fixture'))
from guards import validate_container, validate_cron
sys.path.insert(0, str(P.parent / 'inbox-reply-send-worker'))
import owned_cleanup

if sys.argv[1:] != ['--run-owned-fixture']:
    raise SystemExit('Explicit owned fixture required: proof.py --run-owned-fixture')

D = ['docker', '--host', 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N = 'sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D + ['inspect', N], text=True))[0])
CMD = D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']

# Node 22 pin (this repo's runtime target) for the tsx-driven synthetic
# double CLI. nvm is not present on this host; the homebrew node@22 keg is
# used directly, exactly as the top-of-thread instructions' Node 22 pin
# intends — only the resolution mechanism differs from `nvm use 22`.
NODE22_BIN = '/opt/homebrew/opt/node@22/bin'
NODE_ENV = {**os.environ, 'PATH': NODE22_BIN + ':' + os.environ.get('PATH', '')}
REPO_ROOT = P.parent.parent


def need(v, label):
    if not v: raise RuntimeError(label)


def sql(q, timeout=20, check=True):
    r = subprocess.run(CMD, input="SET statement_timeout='15s'; SET lock_timeout='10s'; SET extra_float_digits=3; BEGIN;" + q.rstrip() + ";COMMIT;", text=True, capture_output=True, timeout=timeout)
    if check: need(r.returncode == 0, r.stderr)
    return r.stdout.strip() if check else r


def sql_fail(q, timeout=20):
    r = subprocess.run(CMD, input="SET statement_timeout='15s'; SET lock_timeout='10s'; SET extra_float_digits=3; BEGIN;" + q.rstrip() + ";COMMIT;", text=True, capture_output=True, timeout=timeout)
    need(r.returncode != 0, f'expected failure but succeeded: {r.stdout}')
    return r.stderr


def synth(payload):
    """Invoke the REAL merged synthetic reply-send double (TS, via tsx) —
    never a Python reimplementation of its logic. One fresh Node process per
    call, so `override` (a one-shot registration consumed in the same call)
    never leaks state across calls."""
    r = subprocess.run(['npx', 'tsx', str(P / 'synthetic-cli.mjs'), json.dumps(payload)], cwd=str(REPO_ROOT), env=NODE_ENV, text=True, capture_output=True, timeout=30)
    need(r.returncode == 0, f'synthetic-cli.mjs failed for {payload}: {r.stderr}')
    return json.loads(r.stdout.strip())


checks = []


def record(label):
    checks.append(label)
    print(f'  OK  {label}')


validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity') == 'sandra-inbox-projection-t2-owned-synthetic', 'Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL") == 't', 'Refusing existing reply schema')
need(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker')") == 't', 'Refusing existing worker role (another proof left it behind)')

# [reused from owned_cleanup.py, not hand-rolled] MUST run before any write.
ORG_TABLES, USER_TABLES, ALL_TABLES = owned_cleanup.discover(sql)
BASELINE = owned_cleanup.snapshot_baseline(sql, ALL_TABLES)
print(f'Discovered {len(ALL_TABLES)} table(s) database-wide (uniform content-signature universe) — {len(ORG_TABLES)} org_id-scoped + {len(USER_TABLES)} user_id-scoped for the sweep')

CLEANUP = ("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);"
           "DROP FUNCTION IF EXISTS public.inbox_accept_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_recover_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_reply_operation_status(uuid);"
           "DROP FUNCTION IF EXISTS public.inbox_reply_reconcile_callback(text,text,text,jsonb);DROP FUNCTION IF EXISTS public.inbox_reply_sweep_unmatched_callbacks(integer);"
           "DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;"
           "DROP SCHEMA IF EXISTS inbox_reply_send_scratch CASCADE;")
sql(CLEANUP)

sources = [P.parent / 'inbox-reply-boundary/context.sql', P.parent / 'inbox-reply-preparation/recipient.sql', P.parent / 'inbox-reply-preparation/batch.sql',
           P.parent / 'inbox-reply-review/setup.sql', P.parent / 'inbox-reply-review/public-api.sql', P.parent / 'inbox-reply-send/attempts.sql',
           P.parent / 'inbox-reply-send/accept.sql', P.parent / 'inbox-reply-send/public-api.sql', P.parent / 'inbox-reply-send/callback.sql',
           P.parent / 'inbox-reply-send-worker/worker.sql']
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


OWNED_ORGS = []
OWNED_USERS = []
SESS = {}


def authed(u, body):
    need(u in SESS, f'no recorded session for user {u}')
    claims = json.dumps({'sub': u, 'role': 'authenticated', 'session_id': SESS[u], 'exp': 4102444800})
    return f"SET LOCAL request.jwt.claims='{claims}'; {body}"


def make_org_and_prep(dest_prefix, n=1):
    """Fresh org+user+session+n conversations -> frozen preparation covering
    all n. Mirrors accept-proof.py's own helper exactly (byte-for-byte
    reused shape, not reinvented)."""
    o = str(uuid.uuid4()); u = str(uuid.uuid4()); sess = str(uuid.uuid4()); s = str(uuid.uuid4()); k = str(uuid.uuid4())
    OWNED_ORGS.append(o); OWNED_USERS.append(u)
    sql(f"INSERT INTO organizations(id,name) VALUES('{o}','PR-H e2e proof {o}');"
        f"INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');"
        f"INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active');"
        f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess}','{u}',clock_timestamp()+interval '1 hour');"
        f"INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+18165550101','active');")
    cids = []
    for i in range(1, n + 1):
        cid = str(uuid.uuid4()); pid = str(uuid.uuid4()); ctid = str(uuid.uuid4()); dest = dest_prefix + str(i).zfill(5)
        sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{ctid}','{o}','C{i}','{dest}','mobile');"
            f"INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o}','{ctid}','sms','opt_in_confirmed','pr-h-e2e-proof');"
            f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{o}','Proof property {i}','MO','{ctid}');"
            f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o}','{cid}','{ctid}','{pid}','sms','inbound','received','hi','{dest}','+18165550101');")
        cids.append(cid)
    targets = json.dumps([{'kind': 'conversation', 'id': c} for c in cids])
    sql("UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;")
    SESS[u] = sess
    capture = json.loads(sql(authed(u, f"SELECT public.inbox_capture_reply_recipients(ARRAY[{','.join(chr(39) + c + chr(39) for c in cids)}]::uuid[])::text;")))
    drafts = [{'conversationId': item['conversation_id'], 'body': 'Hi there', 'dependencies': item['dependencies'], 'exclusion': None} for item in capture['items']]
    payload = json.dumps({'targets': json.loads(targets), 'drafts': drafts, 'template': 'Hi there'}).replace("'", "''")
    freeze = json.loads(sql(authed(u, f"SELECT public.inbox_freeze_reply_review('{payload}','{k}')::text;")))
    prep_id = freeze['preparationId']
    items = json.loads(sql(f"SELECT items::text FROM inbox_reply_review.preparations WHERE id='{prep_id}'"))
    item_ids = [it['id'] for it in items if it['exclusion'] is None]
    return o, u, k, prep_id, item_ids, cids


def call_accept(o, u, k, prep_id, expect_ok=True):
    q = authed(u, f"SELECT inbox_reply_send.accept('{o}','{u}','{k}','{prep_id}')::text;")
    return sql(q) if expect_ok else sql_fail(q)


def counts(o):
    ops = int(sql(f"SELECT count(*) FROM inbox_reply_send.operations WHERE org_id='{o}'"))
    atts = int(sql(f"SELECT count(*) FROM inbox_reply_send.attempts a JOIN inbox_reply_send.operations op ON op.org_id=a.org_id AND op.id=a.operation_id WHERE a.org_id='{o}'"))
    outbox = int(sql(f"SELECT count(*) FROM inbox_reply_send.dispatch_outbox WHERE org_id='{o}'"))
    return ops, atts, outbox


def attempts_of(o, op_id):
    """The operation's current tip-of-chain attempts, in stable order — via
    the worker's own operation_attempts() enumerator, never a raw SELECT, so
    this proof exercises the exact same enumeration surface the real
    dispatch loop uses."""
    ids = sql(f"SELECT id::text FROM inbox_reply_send.attempts WHERE id = ANY(ARRAY(SELECT inbox_reply_send.operation_attempts('{o}','{op_id}'))) ORDER BY attempt_ordinal,item_id").splitlines()
    return ids


def state_of(o, att):
    return sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{att}'")


def row_of(o, att):
    r = sql(f"SELECT to_e164,from_e164,dispatch_token,provider_reference,receipt_version,generation FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{att}'")
    to_e164, from_e164, token, ref, rv, gen = r.split('|')
    return {'to': to_e164, 'from': from_e164, 'token': token or None, 'ref': ref or None, 'receipt_version': int(rv), 'generation': int(gen)}


def jsonb_literal(obj):
    """A properly single-quoted, single-quote-escaped SQL jsonb literal
    (with the trailing ::jsonb cast) for an arbitrary JSON-able Python
    value — json.dumps alone produces a bare double-quoted JSON string,
    which is NOT a valid SQL literal on its own (psql parses it as an
    unquoted token, not a string)."""
    return "'" + json.dumps(obj).replace("'", "''") + "'::jsonb"


def call_wrapper(reference, terminal, payload='{}'):
    q = f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_reconcile_callback('sendillo','{reference}','{terminal}','{payload}'::jsonb)::text; RESET ROLE;"
    return json.loads(sql(q))


def call_wrapper_fail(reference, terminal, payload='{}'):
    q = f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_reconcile_callback('sendillo','{reference}','{terminal}','{payload}'::jsonb)::text; RESET ROLE;"
    return sql_fail(q)


def synthetic_callback(external_id, terminal):
    """Build the REAL synthetic callback envelope via buildSyntheticReplyCallback
    (TS, merged), then translate it the way the reply-status ingress route
    does: event -> terminal, data.messageId -> the provider reference."""
    envelope = synth({'mode': 'callback', 'externalId': external_id, 'terminal': terminal})
    need(envelope['event'] in ('message.delivered', 'message.failed'), f'unexpected synthetic callback event: {envelope}')
    resolved_terminal = 'delivered' if envelope['event'] == 'message.delivered' else 'delivery_failed'
    need(resolved_terminal == terminal, 'synthetic callback envelope terminal mismatch')
    return envelope['data']['messageId'], resolved_terminal


try:
    sql(''.join(s.read_text() for s in sources))
    sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;")
    print('Installed the full reply-lane chain (review + send + worker + callback) on the owned fixture')

    # =========================================================================
    # SECTION A: the composed happy-path lifecycle, driven end to end through
    # the REAL synthetic double as the send seam.
    # =========================================================================
    oA, uA, kA, prepA, item_idsA, cidsA = make_org_and_prep('+160255', n=3)
    resultA = json.loads(call_accept(oA, uA, kA, prepA))
    opA = resultA['operation_id']
    ops, atts, outbox = counts(oA)
    need((ops, atts, outbox) == (1, 3, 1), f'A.1 accept: expected 1 op/3 attempts/1 outbox row, got {(ops, atts, outbox)}')
    need(sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id='{oA}' AND operation_id='{opA}' AND state='approved'") == '3', 'A.1 not all attempts approved')
    record('A.1 accept: 1 operation, 3 approved attempts, 1 durable dispatch_outbox row (one commit)')

    att_ids = attempts_of(oA, opA)
    need(len(att_ids) == 3, f'A.1 operation_attempts() should enumerate all 3 tip attempts, got {len(att_ids)}')
    att_accept, att_uncertain, att_not_attempted = att_ids

    # --- A.2 worker dispatch loop, one attempt per scripted outcome ---
    def dispatch(att, override):
        r = row_of(oA, att)
        claim = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oA}','{att}',60)::text;"))
        need(claim['kind'] == 'claimed', f'A.2 worker_claim should claim an approved attempt, got {claim}')
        gen = claim['generation']
        dispatch_result = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oA}','{att}',{gen})::text;"))
        need(dispatch_result['kind'] == 'dispatch', f'A.2 worker_start_dispatch should dispatch, got {dispatch_result}')
        token = dispatch_result['token']
        need(state_of(oA, att) == 'dispatch_started', 'A.2 ledger marker not committed before the provider call')
        provider_result = synth({'mode': 'send', 'from': dispatch_result['from'], 'to': dispatch_result['to'], 'body': dispatch_result['body'], **({'override': override} if override else {})})
        persist_result = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oA}','{att}','{token}',{jsonb_literal(provider_result)})::text;"))
        return provider_result, persist_result, token

    provider_a, persist_a, token_a = dispatch(att_accept, None)  # default override -> accepted
    need(provider_a['kind'] == 'accepted', f'A.2a synthetic double should default to accepted, got {provider_a}')
    need(persist_a['state'] == 'provider_accepted', f'A.2a expected provider_accepted, got {persist_a}')
    record('A.2a attempt 1: claim -> worker_start_dispatch (marker) -> REAL synthetic double (accepted) -> persist -> provider_accepted')

    provider_u, persist_u, token_u = dispatch(att_uncertain, {'kind': 'uncertain', 'reason': 'transport_or_timeout'})
    need(provider_u['kind'] == 'uncertain', f'A.2b synthetic double override did not take effect: {provider_u}')
    need(persist_u['state'] == 'uncertain', f'A.2b expected uncertain, got {persist_u}')
    record('A.2b attempt 2: scripted synthetic uncertain (transport_or_timeout) -> persist -> uncertain (awaits callback, no retry)')

    provider_n, persist_n, token_n = dispatch(att_not_attempted, {'kind': 'not_attempted', 'reason': 'cancelled_before_dispatch'})
    need(provider_n['kind'] == 'not_attempted', f'A.2c synthetic double override did not take effect: {provider_n}')
    need(persist_n['state'] == 'confirmed_not_submitted', f'A.2c expected confirmed_not_submitted, got {persist_n}')
    record('A.2c attempt 3: scripted synthetic not_attempted (cancelled_before_dispatch) -> persist -> confirmed_not_submitted')

    need(sql(f"SELECT inbox_reply_send.operation_dispatch_complete('{oA}','{opA}')") == 't', 'A.3 operation should be dispatch-complete: no attempt left in approved/claimed/dispatch_started')
    record('A.3 operation_dispatch_complete: true once every attempt reached a post-dispatch state')

    # --- A.4 ack the outbox, only once dispatch-complete ---
    batch = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    entry = next((e for e in batch if e['operation_id'] == opA), None)
    need(entry is not None, 'A.4 claim_dispatch_batch should surface our outbox row')
    acked = sql(f"SELECT inbox_reply_send.ack_dispatch('{oA}','{opA}',{entry['generation']})") == 't'
    need(acked, 'A.4 ack_dispatch should succeed once operation_dispatch_complete is true')
    need(sql(f"SELECT acknowledged_at IS NOT NULL FROM inbox_reply_send.dispatch_outbox WHERE org_id='{oA}' AND operation_id='{opA}'") == 't', 'A.4 outbox row not marked acknowledged')
    record('A.4 claim_dispatch_batch -> ack_dispatch: outbox row acknowledged exactly once, only after dispatch-complete')

    # --- A.5 callback for the provider_accepted attempt, via the REAL
    # synthetic callback envelope builder, translated the way the ingress
    # route does, then reconciled via the public wrapper ---
    reference_a = provider_a['externalId']
    external_id_a, terminal_a = synthetic_callback(reference_a, 'delivered')
    cb_result = call_wrapper(external_id_a, terminal_a)
    need(cb_result['kind'] == 'reconciled' and cb_result['result']['state'] == 'delivered', f'A.5 callback reconcile mismatch: {cb_result}')
    need(state_of(oA, att_accept) == 'delivered', 'A.5 attempt not delivered after callback')
    record('A.5 synthetic callback (buildSyntheticReplyCallback, TS) -> reconciled via public.inbox_reply_reconcile_callback -> delivered')

    # --- A.6 the full composed receipt lifecycle assertion ---
    # operation_status's own `dispatchComplete` is a NARROWER, wire-facing
    # notion than the worker's operation_dispatch_complete() (asserted in
    # A.3): it means every receipt reached a DEFINITIVELY final state
    # (provider_accepted/delivered/delivery_failed/rejected_unsent/
    # confirmed_not_submitted) — 'uncertain' deliberately does NOT count
    # (accept.sql:259-273), because an uncertain attempt is still awaiting a
    # callback that may yet resolve it (worker-dispatch-complete only means
    # "nothing left for the DISPATCH loop to do", not "fully resolved").
    # With attempt 2 left genuinely uncertain, operation_status must report
    # dispatchComplete=false even though operation_dispatch_complete() (A.3)
    # is true — these are two different, both-correct invariants, and this
    # assertion proves the distinction rather than eliding it.
    status = json.loads(sql(f"SELECT inbox_reply_send.operation_status('{oA}','{opA}')::text;"))
    need(status['dispatchComplete'] is False, f"A.6 dispatchComplete should be FALSE while attempt 2 is still uncertain (operation_status's narrower, fully-resolved notion): {status}")
    states = sorted(r['state'] for r in status['receipts'])
    need(states == sorted(['delivered', 'uncertain', 'confirmed_not_submitted']), f'A.6 unexpected receipt states: {states}')
    record("A.6 composed lifecycle assertion: pending -> dispatch_started -> provider_accepted -> delivered traced end to end for attempt 1; operation_status receipts show {delivered, uncertain, confirmed_not_submitted}; dispatchComplete correctly FALSE (uncertain is dispatch-complete per A.3's worker-facing gate but not resolution-complete per operation_status's wire-facing gate — the two invariants are distinct and both hold)")

    print(f'\nSECTION A (composed happy-path lifecycle) PASSED — {len(checks)} checks so far')

    # =========================================================================
    # SECTION B: crash-at-every-boundary. Each boundary gets its own org so
    # failures never cross-contaminate. b1/b2 include a real mutation-first
    # watch-FAIL/restore/watch-PASS cycle on the worker-layer guard.
    # =========================================================================

    # --- B1: crash between accept and worker pickup. The outbox row must
    # survive (durable), be picked exactly once per poll (leased), and never
    # be handed out twice while its lease is live. ---
    oB1, uB1, kB1, prepB1, _, _ = make_org_and_prep('+161255', n=1)
    resultB1 = json.loads(call_accept(oB1, uB1, kB1, prepB1))
    opB1 = resultB1['operation_id']
    need(sql(f"SELECT acknowledged_at IS NULL FROM inbox_reply_send.dispatch_outbox WHERE org_id='{oB1}' AND operation_id='{opB1}'") == 't', 'B1 outbox row missing right after accept')
    record('b1.1: outbox row survives the "crash" between accept and worker pickup (durable — same commit as accept, never lost)')

    batch1 = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    entry1 = next((e for e in batch1 if e['operation_id'] == opB1), None)
    need(entry1 is not None, 'B1 first poll did not pick up the outbox row')
    batch2 = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    need(all(e['operation_id'] != opB1 for e in batch2), f'B1 a SECOND immediate poll re-picked the still-leased outbox row: {batch2}')
    record('b1.2: real invariant — a second immediate poll does NOT re-pick the same outbox row while its lease is live (single pickup per lease window)')

    # MUTATION: drop the lease_until assignment from claim_dispatch_batch's
    # own claiming UPDATE — watch a second immediate poll pick the SAME
    # outbox row again (the double-dispatch this lease exists to prevent),
    # then restore and reverify the real guard blocks it.
    restore_fn('inbox_reply_send.claim_dispatch_batch')
    real_batch_fn = real_fn('inbox_reply_send.claim_dispatch_batch')
    needle = "UPDATE inbox_reply_send.dispatch_outbox d SET generation=d.generation+1,lease_until=clock_timestamp()+interval '30 seconds' FROM candidates c"
    need(needle in real_batch_fn, 'B1 mutation anchor not found (source drifted)')
    mutant_batch_fn = real_batch_fn.replace(needle, "/* MUTATED for proof: lease_until never advanced */ UPDATE inbox_reply_send.dispatch_outbox d SET generation=d.generation+1 FROM candidates c")
    need(mutant_batch_fn != real_batch_fn, 'B1 mutation produced no change')
    sql(mutant_batch_fn)
    oB1b, uB1b, kB1b, prepB1b, _, _ = make_org_and_prep('+161256', n=1)
    resultB1b = json.loads(call_accept(oB1b, uB1b, kB1b, prepB1b))
    opB1b = resultB1b['operation_id']
    mbatch1 = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    need(any(e['operation_id'] == opB1b for e in mbatch1), 'B1 mutant should still pick up the row on the first poll')
    mbatch2 = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    need(any(e['operation_id'] == opB1b for e in mbatch2), f'B1 MUTATION did not actually reproduce a double pickup — mutation had no effect: {mbatch2}')
    record('b1.3 MUTATION watched fail: with lease_until never advanced, a second immediate poll re-picks the SAME outbox row (the exact double-dispatch the lease exists to prevent)')
    restore_and_verify('inbox_reply_send.claim_dispatch_batch')
    # The row's OWN lease_until is still NULL from the mutant's last (buggy)
    # claim above — restoring the function does not retroactively fix
    # already-written data. Let the RESTORED function claim it once (which
    # sets a real future lease_until), THEN poll again to prove the guard,
    # not merely a coincidentally-NULL lease.
    mbatch3a = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    need(any(e['operation_id'] == opB1b for e in mbatch3a), 'B1 restored function should still pick up the row on this poll')
    mbatch3b = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
    need(all(e['operation_id'] != opB1b for e in mbatch3b), 'B1 restored function should NOT re-pick a freshly-leased row')
    record('b1.4 RESTORED and re-verified byte-exact against source; the lease guard blocks the double pickup again')

    # Drain b1's two operations to completion so cleanup's residual check
    # starts from a clean dispatch-complete state.
    for o_, op_, att_list in [(oB1, opB1, attempts_of(oB1, opB1)), (oB1b, opB1b, attempts_of(oB1b, opB1b))]:
        for att_ in att_list:
            claim_ = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o_}','{att_}',60)::text;"))
            need(claim_['kind'] == 'claimed', f'B1 drain: worker_claim unexpected {claim_}')
            d_ = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{o_}','{att_}',{claim_['generation']})::text;"))
            need(d_['kind'] == 'dispatch', f'B1 drain: worker_start_dispatch unexpected {d_}')
            pr_ = synth({'mode': 'send', 'from': d_['from'], 'to': d_['to'], 'body': d_['body']})
            sql(f"SELECT inbox_reply_send.worker_persist('{o_}','{att_}','{d_['token']}',{jsonb_literal(pr_)})::text;")
        batch_ = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
        entry_ = next((e for e in batch_ if e['operation_id'] == op_), None)
        if entry_: sql(f"SELECT inbox_reply_send.ack_dispatch('{o_}','{op_}',{entry_['generation']})")

    # --- B2: crash between the dispatch marker (dispatch_started committed)
    # and the provider call. Re-entry must NEVER issue a second token or make
    # a second provider call. ---
    oB2, uB2, kB2, prepB2, _, _ = make_org_and_prep('+162255', n=1)
    resultB2 = json.loads(call_accept(oB2, uB2, kB2, prepB2))
    opB2 = resultB2['operation_id']
    attB2 = attempts_of(oB2, opB2)[0]
    claimB2 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB2}','{attB2}',60)::text;"))
    dispatchB2 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB2}','{attB2}',{claimB2['generation']})::text;"))
    need(dispatchB2['kind'] == 'dispatch', f'B2 setup: expected dispatch, got {dispatchB2}')
    token_before = row_of(oB2, attB2)['token']
    need(token_before == dispatchB2['token'], 'B2 setup: marker token mismatch')
    need(state_of(oB2, attB2) == 'dispatch_started', 'B2 setup: marker not committed')
    # "Crash" here = the provider call/response never happens. A redeploy
    # restarts the worker, which re-enters via worker_claim on the same
    # attempt (exactly runner.mjs's own claim-before-dispatch step, replayed
    # by Restate against the SAME durable invocation).
    reentry = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB2}','{attB2}',60)::text;"))
    need(reentry == {'kind': 'existing', 'state': 'uncertain'}, f'B2 re-entry after the marker must land on uncertain with no new claim, got {reentry}')
    need(state_of(oB2, attB2) == 'uncertain', 'B2 attempt did not settle to uncertain on re-entry')
    row_after = row_of(oB2, attB2)
    need(row_after['token'] == token_before, 'B2 dispatch_token changed on re-entry (a second token was issued)')
    stale = sql_fail(f"SELECT inbox_reply_send.worker_start_dispatch('{oB2}','{attB2}',{claimB2['generation']})::text;")
    need('INBOX_REPLY_STALE_CLAIM' in stale, f'B2 a second worker_start_dispatch on the re-entered attempt must be rejected, got: {stale}')
    record('b2.1: real invariant — worker_claim re-entry on a dispatch_started attempt settles it to uncertain, keeps the SAME dispatch_token (no second token), and a further worker_start_dispatch is rejected (no second marker, no second provider call possible)')

    # MUTATION: make claim()'s dispatch_started branch re-claim instead of
    # settling to uncertain — watch the SEPARATE transition-guard trigger
    # (attempts.sql, independent of claim()'s own body) still block the
    # resulting dispatch_started->claimed UPDATE outright (defense in depth:
    # even a buggy claim() cannot resurrect a second dispatch), then restore.
    restore_fn('inbox_reply_send.claim')
    real_claim_fn = real_fn('inbox_reply_send.claim')
    needle2 = ("ELSIF row.state='dispatch_started' THEN\n"
               "  -- Re-entry after a crash/redeploy between the dispatch marker and any\n"
               "  -- result: label uncertain, never re-claim (never a second token).\n"
               "  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;\n"
               "  RETURN jsonb_build_object('kind','existing','state','uncertain');")
    need(needle2 in real_claim_fn, 'B2 mutation anchor not found (source drifted)')
    mutant_claim_fn = real_claim_fn.replace(needle2,
        "ELSIF row.state='dispatch_started' THEN\n"
        "  -- MUTATED for proof: wrongly re-claim a dispatch_started row instead of settling to uncertain.\n"
        "  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;\n"
        "  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);")
    need(mutant_claim_fn != real_claim_fn, 'B2 mutation produced no change')
    sql(mutant_claim_fn)
    oB2b, uB2b, kB2b, prepB2b, _, _ = make_org_and_prep('+162256', n=1)
    resultB2b = json.loads(call_accept(oB2b, uB2b, kB2b, prepB2b))
    opB2b = resultB2b['operation_id']
    attB2b = attempts_of(oB2b, opB2b)[0]
    claimB2b = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB2b}','{attB2b}',60)::text;"))
    dispatchB2b = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB2b}','{attB2b}',{claimB2b['generation']})::text;"))
    need(dispatchB2b['kind'] == 'dispatch', 'B2 mutant setup: expected dispatch')
    mutant_reentry_err = sql_fail(f"SELECT inbox_reply_send.worker_claim('{oB2b}','{attB2b}',60)::text;")
    need('Invalid send attempt transition' in mutant_reentry_err, f'B2 MUTATION did not actually reach the trigger backstop: {mutant_reentry_err}')
    record("b2.2 MUTATION watched fail (at the trigger, defense-in-depth): claim()'s own body was made to wrongly re-claim a dispatch_started row, but the SEPARATE transition-guard trigger (independent of claim()'s body) rejects the resulting dispatch_started->claimed write outright — a second dispatch/second token is structurally impossible even with a buggy claim() body")
    need(state_of(oB2b, attB2b) == 'dispatch_started', 'B2 mutant: the rejected re-claim must not have changed the attempt state')
    restore_and_verify('inbox_reply_send.claim')
    reentry_restored = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB2b}','{attB2b}',60)::text;"))
    need(reentry_restored == {'kind': 'existing', 'state': 'uncertain'}, f'B2 restored claim() re-entry mismatch: {reentry_restored}')
    record('b2.3 RESTORED and re-verified byte-exact against source; re-entry settles to uncertain again')

    # Finish b2's two uncertain attempts so cleanup starts clean (accepted,
    # no callback needed — leaving them uncertain is itself the real, correct
    # terminal-ish end state and is fine to leave as-is for cleanup, which
    # sweeps rows by ownership, not by state).

    # --- B3: crash between provider-accepted and persist. Re-delivering the
    # SAME (token, result) to persist() must be idempotent. ---
    oB3, uB3, kB3, prepB3, _, _ = make_org_and_prep('+163255', n=1)
    resultB3 = json.loads(call_accept(oB3, uB3, kB3, prepB3))
    opB3 = resultB3['operation_id']
    attB3 = attempts_of(oB3, opB3)[0]
    claimB3 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB3}','{attB3}',60)::text;"))
    dispatchB3 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB3}','{attB3}',{claimB3['generation']})::text;"))
    providerB3 = synth({'mode': 'send', 'from': dispatchB3['from'], 'to': dispatchB3['to'], 'body': dispatchB3['body']})
    need(providerB3['kind'] == 'accepted', f'B3 setup: expected accepted, got {providerB3}')
    result_json = jsonb_literal(providerB3)
    persist1 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB3}','{attB3}','{dispatchB3['token']}',{result_json})::text;"))
    need(persist1['state'] == 'provider_accepted', f'B3 first persist unexpected: {persist1}')
    rv1 = row_of(oB3, attB3)['receipt_version']
    # "Crash between provider-accepted and persist" — the client that got the
    # provider's accepted result never learned its own persist() call
    # committed (response lost) and retries the EXACT SAME call.
    persist2 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB3}','{attB3}','{dispatchB3['token']}',{result_json})::text;"))
    rv2 = row_of(oB3, attB3)['receipt_version']
    need(persist2['state'] == 'provider_accepted' and rv1 == rv2, f'B3 a retried persist() with the identical token+result must be a no-op: rv {rv1} -> {rv2}, result {persist2}')
    record('b3: a persist() call retried with the identical (token, result) after a "lost response" crash is idempotent — same state, receipt_version unchanged, no second write')
    reference_b3, terminal_b3 = synthetic_callback(providerB3['externalId'], 'delivered')
    cbB3 = call_wrapper(reference_b3, terminal_b3)
    need(cbB3['kind'] == 'reconciled' and state_of(oB3, attB3) == 'delivered', 'B3 cleanup callback failed')

    # --- B4: callback arrives BEFORE persist (persist not yet run — the
    # attempt has no provider_reference to match against). Held in
    # unmatched_callbacks; drained exactly once persist binds the reference. ---
    oB4, uB4, kB4, prepB4, _, _ = make_org_and_prep('+164255', n=1)
    resultB4 = json.loads(call_accept(oB4, uB4, kB4, prepB4))
    opB4 = resultB4['operation_id']
    attB4 = attempts_of(oB4, opB4)[0]
    claimB4 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB4}','{attB4}',60)::text;"))
    dispatchB4 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB4}','{attB4}',{claimB4['generation']})::text;"))
    external_id_b4 = f"synthetic_{dispatchB4['to']}_prescripted"
    ref_b4, terminal_b4 = synthetic_callback(external_id_b4, 'delivered')
    early = call_wrapper(ref_b4, terminal_b4)
    need(early['kind'] == 'stored_unmatched', f'B4 a callback arriving before persist must be held, got {early}')
    need(sql(f"SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='{ref_b4}'") == '1', 'B4 held callback row missing')
    record('b4.1: a callback arriving BEFORE persist (no provider_reference to match yet) is durably stored in unmatched_callbacks, never discarded')
    persist_b4 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB4}','{attB4}','{dispatchB4['token']}',{jsonb_literal({'kind': 'accepted', 'externalId': ref_b4, 'status': 'sent'})})::text;"))
    need(persist_b4['state'] == 'provider_accepted', f'B4 persist did not bind the pre-arrived reference: {persist_b4}')
    drain1 = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b4}')::text;"))
    need(drain1['drained'] is True and drain1['result']['state'] == 'delivered', f'B4 drain did not reconcile the held callback: {drain1}')
    need(state_of(oB4, attB4) == 'delivered', 'B4 attempt not delivered after drain')
    rv_after_drain = row_of(oB4, attB4)['receipt_version']
    drain2 = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b4}')::text;"))
    need(drain2['drained'] is False, f'B4 a second drain of an already-consumed reference must be a no-op: {drain2}')
    need(row_of(oB4, attB4)['receipt_version'] == rv_after_drain, 'B4 second drain double-applied')
    record('b4.2: once persist() binds the reference, the held callback drains and applies EXACTLY ONCE — a second drain is a clean no-op')

    # --- B5: duplicate callback + out-of-order terminal (delivery_failed
    # after delivered). First-terminal-wins; a contradiction is rejected as
    # a normal (non-aborting) result, never silently applied. ---
    oB5, uB5, kB5, prepB5, _, _ = make_org_and_prep('+165255', n=1)
    resultB5 = json.loads(call_accept(oB5, uB5, kB5, prepB5))
    opB5 = resultB5['operation_id']
    attB5 = attempts_of(oB5, opB5)[0]
    claimB5 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB5}','{attB5}',60)::text;"))
    dispatchB5 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB5}','{attB5}',{claimB5['generation']})::text;"))
    providerB5 = synth({'mode': 'send', 'from': dispatchB5['from'], 'to': dispatchB5['to'], 'body': dispatchB5['body']})
    sql(f"SELECT inbox_reply_send.worker_persist('{oB5}','{attB5}','{dispatchB5['token']}',{jsonb_literal(providerB5)})::text;")
    ref_b5, term_b5_delivered = synthetic_callback(providerB5['externalId'], 'delivered')
    first = call_wrapper(ref_b5, term_b5_delivered)
    need(first['kind'] == 'reconciled' and first['result']['state'] == 'delivered', f'B5 happy delivered mismatch: {first}')
    rv_b5 = row_of(oB5, attB5)['receipt_version']
    # duplicate (same terminal twice) -> idempotent no-op
    dup = call_wrapper(ref_b5, term_b5_delivered)
    need(state_of(oB5, attB5) == 'delivered' and row_of(oB5, attB5)['receipt_version'] == rv_b5, 'B5 duplicate identical callback mutated the row')
    record('b5.1: a literal duplicate callback (same terminal, replayed) is idempotent — no state change, no receipt_version bump')
    # out-of-order contradiction (delivery_failed AFTER delivered)
    _, term_b5_failed = synthetic_callback(ref_b5, 'delivery_failed')
    contradiction = call_wrapper(ref_b5, term_b5_failed)
    need(contradiction == {'kind': 'rejected', 'code': 'INBOX_REPLY_CONTRADICTORY_RECEIPT'}, f'B5 out-of-order contradiction should be rejected as a normal result, got {contradiction}')
    need(state_of(oB5, attB5) == 'delivered' and row_of(oB5, attB5)['receipt_version'] == rv_b5, 'B5 contradictory out-of-order callback flipped the terminal row')
    record('b5.2: an out-of-order contradictory terminal (delivery_failed arriving after delivered) is rejected as a normal RPC result (never a thrown exception that could abort an unrelated write sharing the transaction) — first-terminal-wins, idempotent')

    # --- B6: an uncertain attempt stays uncertain, is never auto-retried
    # (structurally — the live-attempt unique index forbids a successor while
    # non-terminal), and a callback that later resolves it (a delayed
    # provider result eventually reporting accepted) is durably held/drained
    # exactly like B4 — the documented limitation is "no auto-retry", not
    # "the callback is lost". ---
    oB6, uB6, kB6, prepB6, _, _ = make_org_and_prep('+166255', n=1)
    resultB6 = json.loads(call_accept(oB6, uB6, kB6, prepB6))
    opB6 = resultB6['operation_id']
    attB6 = attempts_of(oB6, opB6)[0]
    claimB6 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB6}','{attB6}',60)::text;"))
    dispatchB6 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB6}','{attB6}',{claimB6['generation']})::text;"))
    persist_uncertain = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB6}','{attB6}','{dispatchB6['token']}',{jsonb_literal({'kind': 'uncertain', 'reason': 'transport_or_timeout'})})::text;"))
    need(persist_uncertain['state'] == 'uncertain', f'B6 setup: expected uncertain, got {persist_uncertain}')
    # No automatic retry: a fresh successor attempt for the SAME
    # (preparation,item) is structurally blocked while the live row is
    # 'uncertain' (D-6(1) live-attempt partial unique — only
    # rejected_unsent/confirmed_not_submitted permit a successor).
    itemB6 = sql(f"SELECT item_id FROM inbox_reply_send.attempts WHERE org_id='{oB6}' AND id='{attB6}'")
    # A well-formed successor row (attempt_ordinal+1, prior_attempt_id set —
    # the real shape a retry-after-confirmed_not_submitted/rejected_unsent
    # would take) still hits the D-6(1) live-attempt partial unique index,
    # because the live row (attB6) is 'uncertain', which is NOT one of the
    # two states (rejected_unsent/confirmed_not_submitted) that free it.
    dup_attempt_err = sql_fail(f"INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state) "
                                f"SELECT org_id,operation_id,preparation_id,item_id,attempt_ordinal+1,id,contact_id,from_e164,to_e164,body_hash,'approved' FROM inbox_reply_send.attempts WHERE org_id='{oB6}' AND id='{attB6}';")
    need('duplicate key' in dup_attempt_err.lower() or '23505' in dup_attempt_err, f'B6 a successor attempt while the live row is uncertain should be structurally blocked, got: {dup_attempt_err}')
    record('b6.1: while an attempt is uncertain, no successor attempt for the same item can even be inserted (live-attempt unique index) — structurally no auto-retry, matching the documented limitation')
    # A delayed callback resolving it later is durably held, exactly like B4.
    external_id_b6 = f"synthetic_{dispatchB6['to']}_delayed"
    ref_b6, term_b6 = synthetic_callback(external_id_b6, 'delivered')
    early_b6 = call_wrapper(ref_b6, term_b6)
    need(early_b6['kind'] == 'stored_unmatched', f'B6 expected the delayed callback to be held unmatched, got {early_b6}')
    persist_late = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB6}','{attB6}','{dispatchB6['token']}',{jsonb_literal({'kind': 'accepted', 'externalId': ref_b6, 'status': 'sent'})})::text;"))
    need(persist_late['state'] == 'provider_accepted', f'B6 a delayed accepted result from uncertain must still bind, got {persist_late}')
    drain_b6 = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b6}')::text;"))
    need(drain_b6['drained'] is True and drain_b6['result']['state'] == 'delivered', f'B6 delayed drain failed: {drain_b6}')
    need(state_of(oB6, attB6) == 'delivered', 'B6 attempt not delivered after the delayed resolve')
    record("b6.2: the documented limitation is precisely scoped — an uncertain attempt's LATER delayed provider result (accepted) still binds, and its already-held callback still drains and delivers exactly once; nothing about being uncertain loses the callback, only auto-retry is withheld")

    print(f'\nALL {len(checks)} CHECKS PASSED (Section A composed lifecycle + Section B six crash boundaries)')
    evidence = {
        'sources': {str(s.relative_to(P.parent)): __import__('hashlib').sha256(s.read_bytes()).hexdigest() for s in sources},
        'runner_sha256': __import__('hashlib').sha256(Path(__file__).read_bytes()).hexdigest(),
        'checks': checks,
    }
    (P / 'e2e-evidence.json').write_text(json.dumps(evidence, indent=1) + '\n')

finally:
    sql(CLEANUP, check=False)
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
        ]:
            n = sql(query)
            if n and n != '0': residual[label] = n
        if residual:
            raise RuntimeError(f'Owned-fixture cleanup left residual rows in explicitly-managed PRIMARY tables: {residual}')
        owned_cleanup.sweep_delete(sql, ORG_TABLES, USER_TABLES, OWNED_ORGS, OWNED_USERS)
        advanced = owned_cleanup.assert_clean(sql, ALL_TABLES, BASELINE, OWNED_ORGS, OWNED_USERS)
        print(f'Exhaustive dynamic residual check passed: zero synthetic rows AND byte-identical baseline content across all {len(ALL_TABLES)} discovered table(s) database-wide' + (f'; whitelisted counters advanced monotonically: {"; ".join(advanced)}' if advanced else '; no counter column changed'))
    need(sql("SELECT to_regnamespace('inbox_reply_send') IS NULL") == 't', 'inbox_reply_send schema not dropped')
    print('Cleanup verified: zero residual rows, ephemeral schemas dropped')
