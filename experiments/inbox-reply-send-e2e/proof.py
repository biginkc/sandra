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

# [Astra e2e gate, finding B1 — THE crux] A durable, proof-owned send log
# (a plain file, NOT the merged double's own process-local state — see
# synthetic-cli.mjs's own header) that survives every CLI process boundary
# for the whole run. Every real transport invocation appends exactly one
# line here, keyed by whatever identity the caller passes (normally the
# ledger attempt_id). send_count(key) below is the actual no-double-send
# evidence this proof asserts against — never inferred from SQL state,
# externalId equality (which can collide across processes — see the CLI
# shim's header), or receipt counts alone.
SEND_LOG = P / '.send-log.jsonl'
if SEND_LOG.exists(): SEND_LOG.unlink()


def send_count(key):
    if not SEND_LOG.exists(): return 0
    return sum(1 for line in SEND_LOG.read_text().splitlines() if line.strip() and json.loads(line)['key'] == key)


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


def send(from_, to, body, key, override=None):
    """The ONE call site that invokes the REAL synthetic transport for an
    actual send. Always logs to SEND_LOG under `key` (see send_count) —
    every boundary's "was this actually sent more than once" question is
    answered by counting THIS log, never by inspecting SQL state alone."""
    payload = {'mode': 'send', 'from': from_, 'to': to, 'body': body, 'key': key, 'logPath': str(SEND_LOG)}
    if override: payload['override'] = override
    return synth(payload)


def dispatch_attempt(o, att, override=None, key=None):
    """The full composed per-attempt dispatch step, reused by Section A and
    every crash-boundary: worker_claim -> worker_start_dispatch (marker) ->
    REAL synthetic transport call (send, logged) -> worker_persist. Returns
    (provider_result, persist_result, token)."""
    claim = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{o}','{att}',60)::text;"))
    need(claim['kind'] == 'claimed', f'dispatch_attempt: worker_claim should claim an approved attempt, got {claim}')
    dispatch_result = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{o}','{att}',{claim['generation']})::text;"))
    need(dispatch_result['kind'] == 'dispatch', f'dispatch_attempt: worker_start_dispatch should dispatch, got {dispatch_result}')
    token = dispatch_result['token']
    need(state_of(o, att) == 'dispatch_started', 'dispatch_attempt: ledger marker not committed before the provider call')
    provider_result = send(dispatch_result['from'], dispatch_result['to'], dispatch_result['body'], key or att, override)
    persist_result = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{o}','{att}','{token}',{jsonb_literal(provider_result)})::text;"))
    return provider_result, persist_result, token


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

    # --- A.2 worker dispatch loop, one attempt per scripted outcome, via
    # dispatch_attempt() (the ONE shared composed-dispatch helper every
    # boundary in Section B reuses) ---
    provider_a, persist_a, token_a = dispatch_attempt(oA, att_accept)  # default override -> accepted
    need(provider_a['kind'] == 'accepted', f'A.2a synthetic double should default to accepted, got {provider_a}')
    need(persist_a['state'] == 'provider_accepted', f'A.2a expected provider_accepted, got {persist_a}')
    need(send_count(att_accept) == 1, f'A.2a exactly one real transport call expected, got {send_count(att_accept)}')
    record('A.2a attempt 1: claim -> worker_start_dispatch (marker) -> REAL synthetic double (accepted) -> persist -> provider_accepted; send-log confirms exactly 1 real transport call')

    provider_u, persist_u, token_u = dispatch_attempt(oA, att_uncertain, override={'kind': 'uncertain', 'reason': 'transport_or_timeout'})
    need(provider_u['kind'] == 'uncertain', f'A.2b synthetic double override did not take effect: {provider_u}')
    need(persist_u['state'] == 'uncertain', f'A.2b expected uncertain, got {persist_u}')
    need(send_count(att_uncertain) == 1, f'A.2b exactly one real transport call expected, got {send_count(att_uncertain)}')
    record('A.2b attempt 2: scripted synthetic uncertain (transport_or_timeout) -> persist -> uncertain (awaits callback, no retry); send-log confirms exactly 1 real transport call')

    provider_n, persist_n, token_n = dispatch_attempt(oA, att_not_attempted, override={'kind': 'not_attempted', 'reason': 'cancelled_before_dispatch'})
    need(provider_n['kind'] == 'not_attempted', f'A.2c synthetic double override did not take effect: {provider_n}')
    need(persist_n['state'] == 'confirmed_not_submitted', f'A.2c expected confirmed_not_submitted, got {persist_n}')
    need(send_count(att_not_attempted) == 1, f'A.2c exactly one real transport call expected, got {send_count(att_not_attempted)}')
    record('A.2c attempt 3: scripted synthetic not_attempted (cancelled_before_dispatch) -> persist -> confirmed_not_submitted; send-log confirms exactly 1 real transport call')

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
    # starts from a clean dispatch-complete state — and, since the outbox
    # layer was JUST proven double-pickable under mutation, confirm the
    # SEPARATE attempt-level ledger guard (claim()'s busy/existing branches)
    # still holds the line: even with two outbox pickups in flight, the
    # actual send-log count per attempt stays at exactly 1.
    for o_, op_, att_list in [(oB1, opB1, attempts_of(oB1, opB1)), (oB1b, opB1b, attempts_of(oB1b, opB1b))]:
        for att_ in att_list:
            dispatch_attempt(o_, att_)
            need(send_count(att_) == 1, f'B1 drain: exactly one real transport call expected per attempt, got {send_count(att_)}')
        batch_ = json.loads(sql("SELECT inbox_reply_send.claim_dispatch_batch(20)::text;"))
        entry_ = next((e for e in batch_ if e['operation_id'] == op_), None)
        if entry_: sql(f"SELECT inbox_reply_send.ack_dispatch('{o_}','{op_}',{entry_['generation']})")
    record('b1.5: even after the outbox-level mutation proved a double pickup, driving BOTH resulting operations to completion shows the attempt-level ledger guard (claim()) still limits each attempt to exactly 1 real transport call (send-log evidence, not inference)')

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

    # MUTATION [Astra e2e gate, finding B3 — B2 must show a REAL failure of
    # the no-double-send invariant, not merely a surviving trigger backstop].
    # A fresh attempt: marker committed, the REAL provider call is made
    # (send #1, logged) — modeling "the send genuinely happened, then the
    # process crashed before persist() ever ran". The transition-guard
    # trigger (guard_reply_send_attempt) is the ONE thing standing between
    # this and a second dispatch: its CASE has no dispatch_started->claimed
    # edge, so nothing in this codebase can normally rewind a marker.
    # Disable that trigger for one direct UPDATE — simulating a caller that
    # bypasses the guard entirely — and rewind the row back to 'claimed'
    # (dispatch_started_at/dispatch_token cleared, generation bumped, exactly
    # the shape a legitimate claim() would have produced). Re-enable the
    # trigger, then call the REAL, unmutated worker_start_dispatch again: it
    # now legitimately sees a 'claimed' row and issues a SECOND token — the
    # worker then makes a SECOND real provider call (send #2, logged, same
    # attempt-id key). This is the invariant genuinely failing: send_count
    # goes from 1 to 2.
    oB2b, uB2b, kB2b, prepB2b, _, _ = make_org_and_prep('+162256', n=1)
    resultB2b = json.loads(call_accept(oB2b, uB2b, kB2b, prepB2b))
    opB2b = resultB2b['operation_id']
    attB2b = attempts_of(oB2b, opB2b)[0]
    claimB2b = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB2b}','{attB2b}',60)::text;"))
    dispatchB2b = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB2b}','{attB2b}',{claimB2b['generation']})::text;"))
    need(dispatchB2b['kind'] == 'dispatch', 'B2 mutant setup: expected dispatch')
    providerB2b_1 = send(dispatchB2b['from'], dispatchB2b['to'], dispatchB2b['body'], attB2b)
    need(send_count(attB2b) == 1, f'B2 mutant setup: expected exactly 1 send before the bypass, got {send_count(attB2b)}')

    def rewind_marker(o, att, disable_trigger):
        stmt = f"UPDATE inbox_reply_send.attempts SET state='claimed',dispatch_started_at=NULL,dispatch_token=NULL,generation=generation+1,lease_until=clock_timestamp()+interval '60 seconds' WHERE org_id='{o}' AND id='{att}';"
        if disable_trigger:
            sql(f"ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt; {stmt} ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;")
        else:
            return sql_fail(stmt)

    rewind_marker(oB2b, attB2b, disable_trigger=True)
    need(state_of(oB2b, attB2b) == 'claimed', 'B2 bypass: row did not actually rewind to claimed')
    rewound_gen = row_of(oB2b, attB2b)['generation']
    dispatchB2b_2 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB2b}','{attB2b}',{rewound_gen})::text;"))
    need(dispatchB2b_2['kind'] == 'dispatch', f'B2 bypass: the REAL (unmutated) worker_start_dispatch should now issue a second token, got {dispatchB2b_2}')
    need(dispatchB2b_2['token'] != dispatchB2b['token'], 'B2 bypass: expected a genuinely NEW dispatch token on the second dispatch')
    providerB2b_2 = send(dispatchB2b_2['from'], dispatchB2b_2['to'], dispatchB2b_2['body'], attB2b)
    need(send_count(attB2b) == 2, f'B2 MUTATION watched fail: expected send_count to reach 2 (a genuine double send) after bypassing the transition-guard trigger, got {send_count(attB2b)}')
    record('b2.2 MUTATION watched fail (a REAL failure of the invariant, not just a backstop): with the transition-guard trigger disabled for one direct UPDATE, a dispatch_started marker was rewound to claimed, the REAL (unmutated) worker_start_dispatch issued a genuinely NEW second token, and the REAL synthetic transport was invoked a SECOND time — send_count for this attempt reached 2, the exact no-double-send failure this whole boundary exists to prevent')
    sql(f"SELECT inbox_reply_send.worker_persist('{oB2b}','{attB2b}','{dispatchB2b_2['token']}',{jsonb_literal(providerB2b_2)})::text;")

    # RESTORE: the trigger function itself was never modified — only its
    # enforcement was defeated for one statement by disabling it. "Restore"
    # here means: attempt the IDENTICAL rewind UPDATE again, this time WITH
    # the trigger enabled (its normal, always-on state) — it must reject the
    # write outright, and no third send can ever happen for this attempt.
    oB2c, uB2c, kB2c, prepB2c, _, _ = make_org_and_prep('+162257', n=1)
    resultB2c = json.loads(call_accept(oB2c, uB2c, kB2c, prepB2c))
    opB2c = resultB2c['operation_id']
    attB2c = attempts_of(oB2c, opB2c)[0]
    provider_c, persist_c, token_c = dispatch_attempt(oB2c, attB2c)
    need(send_count(attB2c) == 1, 'B2 restore setup: expected exactly 1 send')
    blocked = rewind_marker(oB2c, attB2c, disable_trigger=False)
    # The SAME trigger function (guard_attempt) rejects this — its
    # immutability check on dispatch_started_at fires before its CASE
    # statement would even be reached, so either message proves the guard.
    need('Invalid send attempt transition' in blocked or 'dispatch_started_at is immutable' in blocked, f'B2 RESTORED: the same rewind attempt must be rejected by the (never-modified, always-on) transition-guard trigger, got: {blocked}')
    need(state_of(oB2c, attB2c) in ('dispatch_started', 'provider_accepted', 'delivered'), 'B2 restore: the rejected rewind must not have changed the attempt state')
    need(send_count(attB2c) == 1, f'B2 RESTORED and re-verified: send_count stays at 1 — the guard, back in force, blocks the exact bypass that produced a double send above')
    record('b2.3 RESTORED and re-verified: with the transition-guard trigger enabled (its normal state — never itself modified), the identical rewind UPDATE that succeeded under the bypass is rejected outright (INBOX_REPLY invalid-transition), and send_count for a fresh attempt stays at exactly 1')

    # b2b's over-dispatched attempt (send_count=2) and b2c's normal attempt
    # are left as-is for cleanup, which sweeps rows by ownership, not state.

    # --- B3: crash between provider-accepted and persist. Re-delivering the
    # SAME (token, result) to persist() must be idempotent. ---
    oB3, uB3, kB3, prepB3, _, _ = make_org_and_prep('+163255', n=1)
    resultB3 = json.loads(call_accept(oB3, uB3, kB3, prepB3))
    opB3 = resultB3['operation_id']
    attB3 = attempts_of(oB3, opB3)[0]
    claimB3 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB3}','{attB3}',60)::text;"))
    dispatchB3 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB3}','{attB3}',{claimB3['generation']})::text;"))
    providerB3 = send(dispatchB3['from'], dispatchB3['to'], dispatchB3['body'], attB3)
    need(providerB3['kind'] == 'accepted', f'B3 setup: expected accepted, got {providerB3}')
    need(send_count(attB3) == 1, f'B3 setup: exactly one real transport call expected, got {send_count(attB3)}')
    result_json = jsonb_literal(providerB3)
    persist1 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB3}','{attB3}','{dispatchB3['token']}',{result_json})::text;"))
    need(persist1['state'] == 'provider_accepted', f'B3 first persist unexpected: {persist1}')
    rv1 = row_of(oB3, attB3)['receipt_version']
    # "Crash between provider-accepted and persist" — the client that got the
    # provider's accepted result never learned its own persist() call
    # committed (response lost) and retries the EXACT SAME call. The
    # transport is NEVER called again (this is a persist-layer retry, not a
    # new send) — send_count must stay at 1 throughout.
    persist2 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB3}','{attB3}','{dispatchB3['token']}',{result_json})::text;"))
    rv2 = row_of(oB3, attB3)['receipt_version']
    need(persist2['state'] == 'provider_accepted' and rv1 == rv2, f'B3 a retried persist() with the identical token+result must be a no-op: rv {rv1} -> {rv2}, result {persist2}')
    need(send_count(attB3) == 1, f'B3 a retried persist() must never call the transport again, send_count still expected 1, got {send_count(attB3)}')
    record('b3.1: a persist() call retried with the identical (token, result) after a "lost response" crash is idempotent — same state, receipt_version unchanged, no second write, send-log confirms zero additional transport calls')

    # MUTATION [Astra e2e gate, finding B3]: persist()'s own idempotent
    # no-op (an identical repeated 'accepted' result on an already
    # provider_accepted/terminal row) is the SOLE thing preventing a retried
    # persist() from re-applying its write every time. Replace that no-op
    # with a real (trigger-bypassing — a same-state UPDATE has no listed
    # transition-guard edge, so a naive re-apply would otherwise be blocked
    # by that SEPARATE guard too, masking this specific bug) re-write that
    # bumps receipt_version on every retry, and watch a second persist()
    # call with the SAME (token, result) double-bump it — a real loss of
    # idempotency, not a hypothetical.
    restore_fn('inbox_reply_send.persist')
    real_persist_fn = real_fn('inbox_reply_send.persist')
    needle3 = ("   IF reference IS NOT DISTINCT FROM row.provider_reference THEN\n"
               "    RETURN jsonb_build_object('state',row.state,'receipt_version',row.receipt_version::text);\n"
               "   ELSE\n"
               "    RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';\n"
               "   END IF;")
    need(needle3 in real_persist_fn, 'B3 mutation anchor not found (source drifted)')
    mutant_persist_fn = real_persist_fn.replace(needle3,
        "   IF reference IS NOT DISTINCT FROM row.provider_reference THEN\n"
        "    -- MUTATED for proof: lose idempotency, re-apply the write on every retry\n"
        "    -- (bypassing the SEPARATE transition-guard trigger, which has no\n"
        "    -- same-state edge and would otherwise itself block this).\n"
        "    ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;\n"
        "    UPDATE inbox_reply_send.attempts SET receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;\n"
        "    ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;\n"
        "    RETURN jsonb_build_object('state',row.state,'receipt_version',v::text);\n"
        "   ELSE\n"
        "    RAISE EXCEPTION 'INBOX_REPLY_CONTRADICTORY_RECEIPT';\n"
        "   END IF;")
    need(mutant_persist_fn != real_persist_fn, 'B3 mutation produced no change')
    sql(mutant_persist_fn)
    persist3 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB3}','{attB3}','{dispatchB3['token']}',{result_json})::text;"))
    rv3 = row_of(oB3, attB3)['receipt_version']
    need(rv3 == rv1 + 1, f'B3 MUTATION watched fail: expected receipt_version to double-bump ({rv1} -> {rv1 + 1}) under the mutant, got {rv1} -> {rv3}')
    record(f'b3.2 MUTATION watched fail: with idempotency removed from persist(), an identical retried call re-applies its write — receipt_version bumped again ({rv1} -> {rv3}) on a call that should have been a pure no-op')
    restore_and_verify('inbox_reply_send.persist')
    persist4 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB3}','{attB3}','{dispatchB3['token']}',{result_json})::text;"))
    rv4 = row_of(oB3, attB3)['receipt_version']
    need(rv4 == rv3, f'B3 RESTORED: a retried persist() must be a no-op again, got rv {rv3} -> {rv4}')
    record('b3.3 RESTORED and re-verified byte-exact against source; the retried persist() is idempotent again')

    reference_b3, terminal_b3 = synthetic_callback(providerB3['externalId'], 'delivered')
    cbB3 = call_wrapper(reference_b3, terminal_b3)
    need(cbB3['kind'] == 'reconciled' and state_of(oB3, attB3) == 'delivered', 'B3 cleanup callback failed')

    # --- B4: callback arrives BEFORE persist (persist not yet run — the
    # attempt has no provider_reference to match against). Held in
    # unmatched_callbacks; drained exactly once persist binds the reference.
    # [Astra e2e gate, finding B2] The send step drives the REAL synthetic
    # transport (send(), same seam as Section A/B1-B3) — the provider's own
    # externalId is what the callback references, exactly as it would be in
    # the real ingress route; nothing here is hand-injected. ---
    oB4, uB4, kB4, prepB4, _, _ = make_org_and_prep('+164255', n=1)
    resultB4 = json.loads(call_accept(oB4, uB4, kB4, prepB4))
    opB4 = resultB4['operation_id']
    attB4 = attempts_of(oB4, opB4)[0]
    claimB4 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB4}','{attB4}',60)::text;"))
    dispatchB4 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB4}','{attB4}',{claimB4['generation']})::text;"))
    # The REAL provider call happens now — the send genuinely occurred — but
    # persist() has not run yet (the "crash"): the provider's callback can
    # reach us before our own DB write recording its reference does.
    providerB4 = send(dispatchB4['from'], dispatchB4['to'], dispatchB4['body'], attB4)
    need(providerB4['kind'] == 'accepted', f'B4 setup: expected accepted, got {providerB4}')
    need(send_count(attB4) == 1, f'B4 setup: exactly one real transport call expected, got {send_count(attB4)}')
    ref_b4, terminal_b4 = synthetic_callback(providerB4['externalId'], 'delivered')
    early = call_wrapper(ref_b4, terminal_b4)
    need(early['kind'] == 'stored_unmatched', f'B4 a callback arriving before persist must be held, got {early}')
    need(sql(f"SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='{ref_b4}'") == '1', 'B4 held callback row missing')
    record('b4.1: a callback arriving BEFORE persist (no provider_reference to match yet, for the SAME real send that just happened) is durably stored in unmatched_callbacks, never discarded')
    persist_b4 = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB4}','{attB4}','{dispatchB4['token']}',{jsonb_literal(providerB4)})::text;"))
    need(persist_b4['state'] == 'provider_accepted', f'B4 persist did not bind the pre-arrived reference: {persist_b4}')
    drain1 = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b4}')::text;"))
    need(drain1['drained'] is True and drain1['result']['state'] == 'delivered', f'B4 drain did not reconcile the held callback: {drain1}')
    need(state_of(oB4, attB4) == 'delivered', 'B4 attempt not delivered after drain')
    rv_after_drain = row_of(oB4, attB4)['receipt_version']
    drain2 = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b4}')::text;"))
    need(drain2['drained'] is False, f'B4 a second drain of an already-consumed reference must be a no-op: {drain2}')
    need(row_of(oB4, attB4)['receipt_version'] == rv_after_drain, 'B4 second drain double-applied')
    need(send_count(attB4) == 1, f'B4 resolving the held callback must never call the transport again, got {send_count(attB4)}')
    record('b4.2: once persist() binds the reference, the held callback drains and applies EXACTLY ONCE — a second drain is a clean no-op; send-log confirms zero additional transport calls')

    # MUTATION [Astra e2e gate, finding B3]: the wrapper's "store the
    # unmatched callback durably" step (the INSERT into unmatched_callbacks)
    # is the SOLE thing standing between an early callback and it being lost
    # forever. Replace it with a silent discard (no INSERT), then replay the
    # exact same scenario on a fresh attempt: the callback for the real send
    # now vanishes — persist() still binds the reference, but drain finds
    # nothing to drain, and the attempt is durably STRANDED at
    # provider_accepted, never reaching delivered. This is the real,
    # observable "stranded/lost callback" failure this boundary exists to
    # prevent.
    restore_fn('public.inbox_reply_reconcile_callback')
    real_wrapper_fn = real_fn('public.inbox_reply_reconcile_callback')
    needle4 = ("  INSERT INTO inbox_reply_send.unmatched_callbacks AS u(provider,provider_reference,terminal_status,payload)\n"
               "   VALUES(in_provider,in_external_id,in_terminal,in_payload) ON CONFLICT (provider,provider_reference) DO NOTHING;\n"
               "  RETURN jsonb_build_object('kind','stored_unmatched');")
    need(needle4 in real_wrapper_fn, 'B4 mutation anchor not found (source drifted)')
    mutant_wrapper_fn = real_wrapper_fn.replace(needle4, "  -- MUTATED for proof: silently discard instead of storing durably.\n  RETURN jsonb_build_object('kind','discarded');")
    need(mutant_wrapper_fn != real_wrapper_fn, 'B4 mutation produced no change')
    sql(mutant_wrapper_fn)
    oB4b, uB4b, kB4b, prepB4b, _, _ = make_org_and_prep('+164256', n=1)
    resultB4b = json.loads(call_accept(oB4b, uB4b, kB4b, prepB4b))
    opB4b = resultB4b['operation_id']
    attB4b = attempts_of(oB4b, opB4b)[0]
    claimB4b = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB4b}','{attB4b}',60)::text;"))
    dispatchB4b = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB4b}','{attB4b}',{claimB4b['generation']})::text;"))
    providerB4b = send(dispatchB4b['from'], dispatchB4b['to'], dispatchB4b['body'], attB4b)
    ref_b4b, terminal_b4b = synthetic_callback(providerB4b['externalId'], 'delivered')
    mutant_early = call_wrapper(ref_b4b, terminal_b4b)
    need(mutant_early == {'kind': 'discarded'}, f'B4 MUTATION did not actually discard the early callback: {mutant_early}')
    sql(f"SELECT inbox_reply_send.worker_persist('{oB4b}','{attB4b}','{dispatchB4b['token']}',{jsonb_literal(providerB4b)})::text;")
    mutant_drain = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b4b}')::text;"))
    need(mutant_drain == {'drained': False, 'reason': 'no_holding_row'}, f'B4 MUTATION: drain should find nothing (the callback was discarded, never stored), got {mutant_drain}')
    need(state_of(oB4b, attB4b) == 'provider_accepted', f'B4 MUTATION watched fail: the attempt is STRANDED at provider_accepted — its delivery callback was lost, never delivered')
    record('b4.3 MUTATION watched fail: with the durable-store step removed from the wrapper, an early callback for a REAL send is silently discarded — persist() still binds the reference, but nothing is left to drain, and the attempt is durably STRANDED at provider_accepted, never reaching delivered')
    restore_and_verify('public.inbox_reply_reconcile_callback')
    restored_early = call_wrapper(ref_b4b, terminal_b4b)
    need(restored_early['kind'] == 'reconciled' and restored_early['result']['state'] == 'delivered', f'B4 RESTORED: a redelivered callback against the (now-persisted) attempt should reconcile directly, got {restored_early}')
    need(state_of(oB4b, attB4b) == 'delivered', 'B4 RESTORED: the previously-stranded attempt should now be recoverable via a callback redelivery')
    record('b4.4 RESTORED and re-verified byte-exact against source; a fresh replay of the exact scenario (early callback -> stored -> persist -> drain) reaches delivered, not stranded')

    # --- B5: duplicate callback + out-of-order terminal (delivery_failed
    # after delivered). First-terminal-wins; a contradiction is rejected as
    # a normal (non-aborting) result, never silently applied. ---
    oB5, uB5, kB5, prepB5, _, _ = make_org_and_prep('+165255', n=1)
    resultB5 = json.loads(call_accept(oB5, uB5, kB5, prepB5))
    opB5 = resultB5['operation_id']
    attB5 = attempts_of(oB5, opB5)[0]
    claimB5 = json.loads(sql(f"SELECT inbox_reply_send.worker_claim('{oB5}','{attB5}',60)::text;"))
    dispatchB5 = json.loads(sql(f"SELECT inbox_reply_send.worker_start_dispatch('{oB5}','{attB5}',{claimB5['generation']})::text;"))
    providerB5 = send(dispatchB5['from'], dispatchB5['to'], dispatchB5['body'], attB5)
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
    need(send_count(attB5) == 1, f'B5 no callback traffic should ever trigger a second real send, got {send_count(attB5)}')
    record('b5.2: an out-of-order contradictory terminal (delivery_failed arriving after delivered) is rejected as a normal RPC result (never a thrown exception that could abort an unrelated write sharing the transaction) — first-terminal-wins, idempotent; send-log confirms zero additional transport calls')

    # MUTATION [Astra e2e gate, finding B3]: reconcile_delivery's own
    # first-terminal-wins precedence guard is the ONE thing distinguishing
    # "reject the contradiction" from "silently flip the terminal state".
    # Remove it (the ledger's own guard_reply_send_attempt trigger is a
    # SEPARATE defense against delivered->delivery_failed, so it is disabled
    # for the duration of this single mutated call, to isolate and prove
    # reconcile_delivery's OWN guard specifically — the same isolation
    # technique the merged callback-proof.py itself uses for this exact
    # function), then watch a genuinely contradictory second terminal
    # silently overwrite the row.
    restore_fn('inbox_reply_send.reconcile_delivery')
    oB5b, uB5b, kB5b, prepB5b, _, _ = make_org_and_prep('+165256', n=1)
    resultB5b = json.loads(call_accept(oB5b, uB5b, kB5b, prepB5b))
    opB5b = resultB5b['operation_id']
    attB5b = attempts_of(oB5b, opB5b)[0]
    provider_b5b, persist_b5b, token_b5b = dispatch_attempt(oB5b, attB5b)
    ref_b5b, term_b5b_delivered = synthetic_callback(provider_b5b['externalId'], 'delivered')
    call_wrapper(ref_b5b, term_b5b_delivered)
    need(state_of(oB5b, attB5b) == 'delivered', 'B5 mutant setup: expected delivered before the mutation')
    sql('ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;')
    mutant_reconcile_fn = r"""
CREATE OR REPLACE FUNCTION inbox_reply_send.reconcile_delivery(o uuid,provider text,provider_reference text,terminal text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;v bigint;
BEGIN
 IF o IS NULL OR provider IS DISTINCT FROM 'sendillo' OR provider_reference IS NULL OR btrim(provider_reference)='' OR terminal NOT IN ('delivered','delivery_failed') OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_CALLBACK';
 END IF;
 SELECT * INTO row FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.provider_reference=reconcile_delivery.provider_reference FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_CALLBACK_UNMATCHED';END IF;
 -- MUTATED for proof: precedence guard removed — any provider_accepted-or-
 -- terminal row is blindly overwritten to whatever terminal just arrived.
 UPDATE inbox_reply_send.attempts SET state=terminal,receipt_version=receipt_version+1 WHERE org_id=o AND id=row.id RETURNING receipt_version INTO v;
 RETURN jsonb_build_object('state',terminal,'receipt_version',v::text,'applied',true);
END $$;
"""
    sql(mutant_reconcile_fn)
    flipped = call_wrapper(ref_b5b, 'delivery_failed')
    need(state_of(oB5b, attB5b) == 'delivery_failed', f'B5 MUTATION watched fail: expected the contradictory callback to silently flip the row, but it stayed {state_of(oB5b, attB5b)}')
    record('b5.3 MUTATION watched fail: with the first-terminal-wins precedence guard removed from reconcile_delivery, a contradictory out-of-order callback silently FLIPS an already-delivered attempt to delivery_failed — the exact terminal-state corruption this boundary exists to prevent')
    sql('ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;')
    restore_and_verify('inbox_reply_send.reconcile_delivery')
    # A fresh attempt/reference for the re-verify: ref_b5b's own
    # (provider,event_type,external_id) pair is now already 'processed' for
    # BOTH terminals (the happy path + the mutation each drove one) in
    # callback_receipts, so replaying either terminal on it would short-
    # circuit at the wrapper's OWN idempotency layer (kind:'already_processed')
    # before ever reaching reconcile_delivery — a different, unrelated
    # invariant. A new reference isolates the ONE thing being re-verified.
    oB5c, uB5c, kB5c, prepB5c, _, _ = make_org_and_prep('+165257', n=1)
    resultB5c = json.loads(call_accept(oB5c, uB5c, kB5c, prepB5c))
    opB5c = resultB5c['operation_id']
    attB5c = attempts_of(oB5c, opB5c)[0]
    provider_b5c, _, _ = dispatch_attempt(oB5c, attB5c)
    ref_b5c, term_b5c = synthetic_callback(provider_b5c['externalId'], 'delivered')
    call_wrapper(ref_b5c, term_b5c)
    need(state_of(oB5c, attB5c) == 'delivered', 'B5 reverify setup: expected delivered')
    reverified = call_wrapper(ref_b5c, 'delivery_failed')
    need(reverified == {'kind': 'rejected', 'code': 'INBOX_REPLY_CONTRADICTORY_RECEIPT'}, f'B5 RESTORED: the restored guard should reject this contradiction again, got {reverified}')
    need(state_of(oB5c, attB5c) == 'delivered', 'B5 RESTORED: the contradiction must not have flipped the row')
    record('b5.4 RESTORED and re-verified byte-exact against source; the precedence guard is back in force on a fresh reference')

    # --- B6: an uncertain attempt stays uncertain, is never auto-retried
    # (structurally — the live-attempt unique index forbids a successor while
    # non-terminal), and a callback that later resolves it (a delayed
    # provider result eventually reporting accepted) is durably held/drained
    # exactly like B4 — the documented limitation is "no auto-retry", not
    # "the callback is lost".
    # [Astra e2e gate, finding B2] The initial dispatch drives the REAL
    # synthetic transport (dispatch_attempt(), same seam as Section
    # A/B1-B5) scripted to uncertain — never a hand-injected result. Keyed
    # by item_id (not attempt_id) here specifically: the concern this
    # boundary guards against is "the same logical recipient sent twice",
    # which spans a successor attempt with a DIFFERENT attempt_id — an
    # attempt-id-keyed count would miss that. ---
    oB6, uB6, kB6, prepB6, _, _ = make_org_and_prep('+166255', n=1)
    resultB6 = json.loads(call_accept(oB6, uB6, kB6, prepB6))
    opB6 = resultB6['operation_id']
    attB6 = attempts_of(oB6, opB6)[0]
    itemB6 = sql(f"SELECT item_id FROM inbox_reply_send.attempts WHERE org_id='{oB6}' AND id='{attB6}'")
    provider_b6, persist_uncertain, token_b6 = dispatch_attempt(oB6, attB6, override={'kind': 'uncertain', 'reason': 'transport_or_timeout'}, key=itemB6)
    need(provider_b6['kind'] == 'uncertain', f'B6 setup: synthetic double override did not take effect: {provider_b6}')
    need(persist_uncertain['state'] == 'uncertain', f'B6 setup: expected uncertain, got {persist_uncertain}')
    need(send_count(itemB6) == 1, f'B6 setup: exactly one real transport call expected for this item, got {send_count(itemB6)}')
    # No automatic retry: a fresh successor attempt for the SAME
    # (preparation,item) is structurally blocked while the live row is
    # 'uncertain' (D-6(1) live-attempt partial unique — only
    # rejected_unsent/confirmed_not_submitted permit a successor). A
    # well-formed successor row (attempt_ordinal+1, prior_attempt_id set —
    # the real shape a retry-after-confirmed_not_submitted/rejected_unsent
    # would take) still hits this index.
    dup_attempt_err = sql_fail(f"INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state) "
                                f"SELECT org_id,operation_id,preparation_id,item_id,attempt_ordinal+1,id,contact_id,from_e164,to_e164,body_hash,'approved' FROM inbox_reply_send.attempts WHERE org_id='{oB6}' AND id='{attB6}';")
    need('duplicate key' in dup_attempt_err.lower() or '23505' in dup_attempt_err, f'B6 a successor attempt while the live row is uncertain should be structurally blocked, got: {dup_attempt_err}')
    record('b6.1: while an attempt is uncertain, no successor attempt for the same item can even be inserted (live-attempt unique index) — structurally no auto-retry, matching the documented limitation')
    # A delayed callback resolving it later is durably held, exactly like B4.
    external_id_b6 = f"synthetic_{token_b6}_delayed"
    ref_b6, term_b6 = synthetic_callback(external_id_b6, 'delivered')
    early_b6 = call_wrapper(ref_b6, term_b6)
    need(early_b6['kind'] == 'stored_unmatched', f'B6 expected the delayed callback to be held unmatched, got {early_b6}')
    persist_late = json.loads(sql(f"SELECT inbox_reply_send.worker_persist('{oB6}','{attB6}','{token_b6}',{jsonb_literal({'kind': 'accepted', 'externalId': ref_b6, 'status': 'sent'})})::text;"))
    need(persist_late['state'] == 'provider_accepted', f'B6 a delayed accepted result from uncertain must still bind, got {persist_late}')
    drain_b6 = json.loads(sql(f"SELECT inbox_reply_send.drain_unmatched('sendillo','{ref_b6}')::text;"))
    need(drain_b6['drained'] is True and drain_b6['result']['state'] == 'delivered', f'B6 delayed drain failed: {drain_b6}')
    need(state_of(oB6, attB6) == 'delivered', 'B6 attempt not delivered after the delayed resolve')
    need(send_count(itemB6) == 1, f'B6 resolving the delayed result/callback must never call the transport again, got {send_count(itemB6)}')
    record("b6.2: the documented limitation is precisely scoped — an uncertain attempt's LATER delayed provider result (accepted) still binds, and its already-held callback still drains and delivers exactly once; nothing about being uncertain loses the callback, only auto-retry is withheld; send-log confirms exactly 1 real transport call for the whole lifecycle")

    # MUTATION [Astra e2e gate, finding B3]: the D-6(1) live-attempt unique
    # index (inbox_reply_send_live_attempt) is the SOLE structural guard
    # proven in b6.1. Drop it on a fresh item stuck in 'uncertain', insert a
    # well-formed successor attempt (now legal), and drive THAT successor
    # through a REAL second dispatch — watch send_count for the SAME item_id
    # reach 2, a genuine double send to the same logical recipient. Restore
    # the index and reverify a successor is blocked again.
    oB6b, uB6b, kB6b, prepB6b, _, _ = make_org_and_prep('+166256', n=1)
    resultB6b = json.loads(call_accept(oB6b, uB6b, kB6b, prepB6b))
    opB6b = resultB6b['operation_id']
    attB6b = attempts_of(oB6b, opB6b)[0]
    itemB6b = sql(f"SELECT item_id FROM inbox_reply_send.attempts WHERE org_id='{oB6b}' AND id='{attB6b}'")
    dispatch_attempt(oB6b, attB6b, override={'kind': 'uncertain', 'reason': 'transport_or_timeout'}, key=itemB6b)
    need(send_count(itemB6b) == 1, 'B6 mutant setup: expected exactly 1 send before the index drop')
    sql('DROP INDEX inbox_reply_send.inbox_reply_send_live_attempt;')
    successor_id = sql(f"INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state) "
                        f"SELECT org_id,operation_id,preparation_id,item_id,attempt_ordinal+1,id,contact_id,from_e164,to_e164,body_hash,'approved' FROM inbox_reply_send.attempts WHERE org_id='{oB6b}' AND id='{attB6b}' RETURNING id::text;")
    need(successor_id, 'B6 MUTATION did not actually let a successor attempt through — index drop had no effect')
    dispatch_attempt(oB6b, successor_id, key=itemB6b)  # default override -> accepted; the second real send
    need(send_count(itemB6b) == 2, f'B6 MUTATION watched fail: expected a genuine SECOND real transport call to the same item (send_count -> 2) once the live-attempt guard was dropped, got {send_count(itemB6b)}')
    record('b6.3 MUTATION watched fail: with the live-attempt unique index dropped, a successor attempt for an item still uncertain was insertable and was driven through a REAL second dispatch — send_count for that item reached 2, a genuine double send to the same logical recipient (the exact failure the "no auto-retry while uncertain" invariant exists to prevent)')
    # Both attB6b (uncertain) and successor_id (provider_accepted) now
    # "live" for the SAME (org,preparation,item) — exactly the duplicate
    # the index exists to forbid, and exactly why it must be recreated. To
    # recreate it, the duplicate has to be resolved first; there is no
    # legal ledger transition from 'uncertain' to one of the two states the
    # real index predicate excludes, so — purely to clean up this proof-
    # induced duplicate before restoring the guard, not as part of any
    # assertion — the original attempt is force-settled out of the live set
    # via a direct, trigger-bypassed UPDATE (the row is synthetic proof data
    # that gets swept regardless of state either way).
    sql(f"ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt; "
        f"UPDATE inbox_reply_send.attempts SET state='confirmed_not_submitted' WHERE org_id='{oB6b}' AND id='{attB6b}'; "
        f"ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;")
    sql('CREATE UNIQUE INDEX inbox_reply_send_live_attempt ON inbox_reply_send.attempts(org_id,preparation_id,item_id) WHERE state NOT IN (\'rejected_unsent\',\'confirmed_not_submitted\');')
    reblocked = sql_fail(f"INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state) "
                          f"SELECT org_id,operation_id,preparation_id,item_id,attempt_ordinal+2,id,contact_id,from_e164,to_e164,body_hash,'approved' FROM inbox_reply_send.attempts WHERE org_id='{oB6b}' AND id='{successor_id}';")
    need('duplicate key' in reblocked.lower() or '23505' in reblocked, f'B6 RESTORED: a third successor attempt should be blocked again, got: {reblocked}')
    need(send_count(itemB6b) == 2, 'B6 RESTORED: send_count for this item must stay at 2 (no third send became possible)')
    record('b6.4 RESTORED and re-verified: with the live-attempt unique index recreated (byte-identical to the merged DDL), a further successor attempt is blocked again — send_count for this item stays at exactly 2, no third send')

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
    # The proof-owned send-log fixture (a plain file, never a merged
    # artifact) is deleted too — nothing about this proof's own bookkeeping
    # should survive the run either.
    if SEND_LOG.exists(): SEND_LOG.unlink()
    print('Cleanup verified: zero residual rows, ephemeral schemas dropped, send-log fixture removed')
