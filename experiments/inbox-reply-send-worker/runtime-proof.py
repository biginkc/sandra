#!/usr/bin/env python3
"""[Astra RULING 1] Real container crash + Restate redelivery proof for the
reply-send worker. Mirrors experiments/inbox-operation-worker/runtime-proof.py
+ runtime-control.py's idiom (real Restate engine + real worker container,
signed deployment registration, docker kill/start), targeting
inbox_reply_send + a reply fixture instead of inbox_operations. Unlike the
metadata worker, this does not stand up a second dedicated runtime database —
it installs the reply schemas directly on the SAME shared owned projection-t2
fixture database ('reply-runtime' fixture profile, core.mjs) and drops them
again at the end.

Scenario: accept a real reply operation -> the REAL worker container (polling
its own outbox, invoking a REAL Restate engine, running the REAL run handler)
claims and start_dispatches the attempt (ledger marker commits) -> the
fault-injectable test transport (vendor/test-transport.mjs) records that it
was called and then blocks -> the worker container is `docker kill`ed WHILE
the transport call is still blocked (after the marker, before any provider
result) -> the worker is restarted -> Restate redelivers the SAME durable
invocation -> the worker MUST NOT call the transport a second time (claim()
re-enters as existing/uncertain) -> the attempt settles to 'uncertain', the
transport call count stays at exactly 1, and no double dispatch occurred.
"""
if not __debug__: raise SystemExit('Optimized Python refused')
import json, os, secrets, subprocess, sys, time, uuid
from pathlib import Path
P = Path(__file__).resolve().parent
sys.path.insert(0, str(P.parent / 'inbox-projection' / 'fixture'))
from guards import validate_container, validate_cron
import owned_cleanup
if sys.argv[1:] != ['--run-owned']: raise SystemExit('Explicit --run-owned required')
D = ['docker', '--host', 'unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock']
N = 'sandra-inbox-projection-t2-db'
RESTATE = 'docker.restate.dev/restatedev/restate@sha256:675b85e7bf674f9dfda04a391fa33e850650d57e464b694ca8df5866acad95cc'
IMAGE_TAG = 'sandra-inbox-reply-send-worker:pr-f-runtime-proof'
LABEL = 'sandra-inbox-reply-send-worker-owned'


def run(args, input=None, timeout=60):
    r = subprocess.run(args, input=input, text=True, capture_output=True, timeout=timeout)
    if r.returncode: raise RuntimeError('Owned command failed: ' + r.stderr[:2000])
    return r.stdout.strip()


def docker(*args, timeout=60): return run(D + list(args), timeout=timeout)
def sql(q, timeout=20, check=True):
    cmd = D + ['exec', '-i', N, 'psql', '-XqAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']
    r = subprocess.run(cmd, input="SET statement_timeout='15s'; SET lock_timeout='10s'; BEGIN;" + q.rstrip() + ";COMMIT;", text=True, capture_output=True, timeout=timeout)
    if check and r.returncode: raise RuntimeError(r.stderr)
    return r.stdout.strip()


def need(v, label):
    if not v: raise RuntimeError(label)


def wait(predicate, label, seconds=40, interval=.25):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        try:
            if predicate(): return
        except RuntimeError:
            pass
        time.sleep(interval)
    raise RuntimeError(label)


validate_container(json.loads(docker('inspect', N))[0])
validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity') == 'sandra-inbox-projection-t2-owned-synthetic', 'Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_send') IS NULL") == 't', 'Refusing existing reply_send schema — run cleanup or another proof left state behind')
need(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker')") == 't', 'Refusing existing worker role')

# [Astra round-3] Dynamic, exhaustive-by-construction residual discovery —
# see owned_cleanup.py's module docstring. MUST run before anything else
# writes a row, so COUNTER_BASELINE reflects the true pre-run state.
ORG_TABLES, USER_TABLES, COUNTER_TABLES = owned_cleanup.discover(sql)
COUNTER_BASELINE = owned_cleanup.snapshot_counters(sql, COUNTER_TABLES)
print(f'Discovered {len(ORG_TABLES)} org_id-scoped + {len(USER_TABLES)} user_id-scoped + {len(COUNTER_TABLES)} counter table(s) to verify residual-free at cleanup')

sources = [P.parent / 'inbox-reply-boundary/context.sql', P.parent / 'inbox-reply-preparation/recipient.sql', P.parent / 'inbox-reply-preparation/batch.sql',
           P.parent / 'inbox-reply-review/setup.sql', P.parent / 'inbox-reply-review/public-api.sql', P.parent / 'inbox-reply-send/attempts.sql',
           P.parent / 'inbox-reply-send/accept.sql', P.parent / 'inbox-reply-send/public-api.sql', P / 'worker.sql', P / 'worker-role.sql']
CLEANUP = ("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);"
           "DROP FUNCTION IF EXISTS public.inbox_accept_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_recover_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_reply_operation_status(uuid);"
           "DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;")
ROLE_CLEANUP = "DROP ROLE IF EXISTS inbox_reply_send_worker;"

owned_org = None
owned_user = None
worker_id = None
engine_id = None
volume = None
local = P / '.runtime-local'
password = secrets.token_urlsafe(40)

try:
    sql(''.join(s.read_text() for s in sources))
    sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;")
    print('Installed reply-lane schemas + worker.sql + worker-role.sql (persistent for this runtime proof)')

    # --- Build the real worker image ---
    docker('build', '-t', IMAGE_TAG, '-f', str(P / 'Dockerfile'), str(P), timeout=180)
    image = json.loads(docker('image', 'inspect', IMAGE_TAG))[0]
    need(image['Config']['User'] == 'node', 'Worker image must run as node')
    print(f'Built {IMAGE_TAG} ({image["Id"][:19]})')

    # --- Signed Restate identity keypair (mirrors runtime-control.py) ---
    local.mkdir(mode=0o700, exist_ok=True); os.chmod(local, 0o700)
    key = local / 'private.pem'
    run(['openssl', 'genpkey', '-algorithm', 'ed25519', '-out', str(key)]); os.chmod(key, 0o600)
    raw = subprocess.check_output(['openssl', 'pkey', '-in', str(key), '-pubout', '-outform', 'DER'], stderr=subprocess.DEVNULL)[-32:]
    alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; number = int.from_bytes(raw, 'big'); encoded = ''
    while number: number, remainder = divmod(number, 58); encoded = alphabet[remainder] + encoded
    encoded = '1' * (len(raw) - len(raw.lstrip(b'\0'))) + encoded
    public_key = 'publickeyv1_' + encoded

    hosts = local / 'hosts'
    hosts.write_text('127.0.0.1 localhost sandra-inbox-actions-db-owned sandra-inbox-restate-owned\n::1 localhost\n'); os.chmod(hosts, 0o644)
    count_dir = local / 'transport-count'; count_dir.mkdir(exist_ok=True); os.chmod(count_dir, 0o777)
    count_file_host = count_dir / 'calls.log'
    if count_file_host.exists(): count_file_host.unlink()
    count_file_host.write_text(''); os.chmod(count_file_host, 0o666)

    # --- Owned worker DB role: LOGIN for this run only ---
    sql(f"ALTER ROLE inbox_reply_send_worker LOGIN PASSWORD '{password}'")

    db_state = json.loads(docker('inspect', N))[0]
    suffix = uuid.uuid4().hex[:12]
    worker_name = 'sandra-inbox-reply-send-worker-' + suffix
    engine_name = 'sandra-inbox-reply-send-restate-' + suffix
    volume = 'sandra-inbox-reply-send-restate-data-' + suffix

    docker('volume', 'create', '--label', 'com.bmh.inbox-fixture=' + LABEL, volume)
    engine_id = docker('run', '-d', '--name', engine_name, '--label', 'com.bmh.inbox-fixture=' + LABEL,
                        '--network', 'container:' + db_state['Id'], '--memory', '512m', '--cpus', '1',
                        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                        '--mount', 'type=volume,source=' + volume + ',target=/restate-data',
                        '--mount', 'type=bind,source=' + str(key) + ',target=/restate-key.pem,readonly',
                        '-e', 'RESTATE_CLUSTER_NAME=' + engine_name, '-e', 'RESTATE_AUTO_PROVISION=true',
                        '-e', 'RESTATE_REQUEST_IDENTITY_PRIVATE_KEY_PEM_FILE=/restate-key.pem', RESTATE)

    env_config = {
        'NODE_ENV': 'test', 'INBOX_REPLY_SEND_WORKER_ENABLED': '1', 'INBOX_ACTION_LOCAL_FIXTURE': '1',
        'INBOX_ACTION_FIXTURE_PROFILE': 'reply-runtime',
        'INBOX_REPLY_SEND_DATABASE_URL': f'postgres://inbox_reply_send_worker:{password}@sandra-inbox-actions-db-owned:5432/postgres',
        'INBOX_RESTATE_INGRESS_URL': 'http://sandra-inbox-restate-owned:8080/',
        'INBOX_RESTATE_IDENTITY_KEYS': json.dumps([public_key]),
        'INBOX_REPLY_SEND_CONNECTIONS': '2',
        'INBOX_REPLY_SEND_TEST_TRANSPORT_MODULE': '/vendor/test-transport.mjs',
        'INBOX_REPLY_SEND_TEST_TRANSPORT_COUNT_FILE': '/transport-count/calls.log',
        'INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS': '6000',
        'PORT': '9081',
    }
    env_file = local / 'worker.env'
    env_file.write_text(''.join(f'{k}={v}\n' for k, v in env_config.items())); os.chmod(env_file, 0o600)

    worker_id = docker('run', '-d', '--name', worker_name, '--label', 'com.bmh.inbox-fixture=' + LABEL,
                        '--network', 'container:' + db_state['Id'], '--memory', '512m', '--cpus', '1',
                        '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                        '--mount', 'type=bind,source=' + str(hosts) + ',target=/etc/hosts,readonly',
                        '--mount', 'type=bind,source=' + str(P / 'vendor/test-transport.mjs') + ',target=/vendor/test-transport.mjs,readonly',
                        '--mount', 'type=bind,source=' + str(count_dir) + ',target=/transport-count',
                        '--env-file', str(env_file), IMAGE_TAG)
    for identifier in (worker_id, engine_id):
        observed = json.loads(docker('inspect', identifier))[0]
        need(observed['HostConfig']['NetworkMode'] == 'container:' + db_state['Id'] and not observed['HostConfig'].get('PortBindings'), 'Unexpected runtime port exposure')
    print(f'Started engine {engine_name} and worker {worker_name}')

    def http_in(container, path, port, method='GET', body=None):
        js = ("const r=await fetch(" + json.dumps(f'http://127.0.0.1:{port}{path}') + ",{method:" + json.dumps(method) + ",headers:{'content-type':'application/json'}," +
              ("body:" + json.dumps(json.dumps(body)) + "," if body is not None else '') + "signal:AbortSignal.timeout(4000)});" +
              "console.log(JSON.stringify({status:r.status,body:(await r.text()).slice(0,4096)}));")
        return json.loads(docker('exec', container, 'node', '--input-type=module', '-e', js))

    wait(lambda: http_in(worker_id, '/health', 9070)['status'] == 200, 'Owned Restate admin did not become ready', 30)
    registration = http_in(worker_id, '/deployments', 9070, method='POST', body={'uri': 'http://127.0.0.1:9081', 'use_http_11': True})
    need(registration['status'] in (200, 201), f'Signed reply-send worker registration failed: {registration}')
    print('Registered signed InboxReplySend deployment with the owned Restate engine')

    # --- Create a real accepted operation (owned synthetic org/user/etc) ---
    o, u, sess, s, k = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4())
    owned_org, owned_user = o, u
    sql(f"INSERT INTO organizations(id,name) VALUES('{o}','Reply-send runtime proof {o}');"
        f"INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');"
        f"INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active');"
        f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess}','{u}',clock_timestamp()+interval '1 hour');"
        f"INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+18165550101','active');")
    cid, pid, ctid, conversation, dest = str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()), '+14025500001'
    sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{ctid}','{o}','Runtime','{dest}','mobile');"
        f"INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o}','{ctid}','sms','opt_in_confirmed','pr-f-runtime-proof');"
        f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{o}','Runtime proof property','MO','{ctid}');"
        f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o}','{conversation}','{ctid}','{pid}','sms','inbound','received','hi','{dest}','+18165550101');"
        f"UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;")
    claims = json.dumps({'sub': u, 'role': 'authenticated', 'session_id': sess, 'exp': 4102444800})
    capture = json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{claims}'; SELECT public.inbox_capture_reply_recipients(ARRAY['{conversation}']::uuid[])::text;"))
    item = capture['items'][0]
    drafts = json.dumps([{'conversationId': item['conversation_id'], 'body': 'Hi there', 'dependencies': item['dependencies'], 'exclusion': None}])
    payload = json.dumps({'targets': [{'kind': 'conversation', 'id': conversation}], 'drafts': json.loads(drafts), 'template': 'Hi there'}).replace("'", "''")
    freeze = json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{claims}'; SELECT public.inbox_freeze_reply_review('{payload}','{k}')::text;"))
    prep_id = freeze['preparationId']
    accept = json.loads(sql(f"SET LOCAL request.jwt.claims='{claims}'; SELECT inbox_reply_send.accept('{o}','{u}','{k}','{prep_id}')::text;"))
    op_id = accept['operation_id']
    attempt_id = sql(f"SELECT id FROM inbox_reply_send.attempts WHERE org_id='{o}' AND operation_id='{op_id}'")
    need(attempt_id, 'No attempt row created for the runtime-proof operation')
    print(f'Accepted a real operation {op_id} with attempt {attempt_id}; the RUNNING worker container must pick it up on its own')

    # --- Wait for the REAL worker's own poll loop to claim, dispatch through
    # the REAL Restate engine, and reach the transport (marker committed) ---
    wait(lambda: count_file_host.read_text().strip() != '', 'The running worker never invoked the transport (dispatch pipeline did not reach the ledger marker)', 30)
    calls_before_kill = len([l for l in count_file_host.read_text().splitlines() if l.strip()])
    need(calls_before_kill == 1, f'Expected exactly one transport call before the kill, got {calls_before_kill}')
    need(sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{attempt_id}'") == 'dispatch_started', 'Ledger marker was not committed before the transport call')
    print('Real dispatch reached the transport call; ledger marker (dispatch_started) is committed. Killing the worker container now (mid-flight, before any provider RESULT).')

    # --- Kill the worker mid-flight, while the transport call is still
    # sleeping (INBOX_REPLY_SEND_TEST_TRANSPORT_SLEEP_MS=6000) ---
    docker('kill', worker_id)
    wait(lambda: json.loads(docker('inspect', worker_id))[0]['State']['Running'] is False, 'Worker container did not actually stop', 10)
    need(sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{attempt_id}'") == 'dispatch_started', 'Attempt state changed by the kill itself (should be untouched — no persist ever ran)')
    print('Worker container killed mid-flight (real process death, not a graceful shutdown).')

    # --- Restart the worker; Restate must redeliver the SAME durable
    # invocation once the deployment is reachable again ---
    docker('start', worker_id)
    wait(lambda: http_in(worker_id, '/readyz', 9081)['status'] == 200, 'Restarted worker did not become ready', 30)
    print('Worker restarted and ready. Waiting for Restate to redeliver / the worker\'s own outbox poll to redrive the same operation...')

    wait(lambda: sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{attempt_id}'") == 'uncertain', 'Attempt did not settle to uncertain after restart (redelivery did not reach re-entry)', 60)
    calls_after_restart = len([l for l in count_file_host.read_text().splitlines() if l.strip()])
    need(calls_after_restart == 1, f'THE CORE PROOF: transport was called {calls_after_restart} times (expected exactly 1) — a redelivery after the crash called the provider AGAIN, i.e. a double send')
    need(sql(f"SELECT dispatch_token IS NOT NULL AND evidence='reentered_without_result' FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{attempt_id}'") == 't', 'Attempt did not carry the expected crash re-entry evidence')

    checks = [
        'a REAL worker container, driven by a REAL Restate engine over signed HTTP, claimed and start_dispatched a real accepted operation on its own (no test code called claim/start_dispatch directly)',
        'the ledger marker (dispatch_started) committed and was durably observed BEFORE the transport call returned',
        'killing the worker container mid-flight (docker kill, real process death) left the attempt at dispatch_started with no persist ever having run',
        'restarting the worker let Restate redeliver the SAME durable invocation; the attempt re-entered via claim() and settled to uncertain WITHOUT a second transport call',
        f'transport call count stayed at exactly 1 across the crash/redelivery cycle (no double dispatch)',
    ]
    for c in checks: print('  OK  ' + c)
    print(f'\nALL {len(checks)} RUNTIME PROOF GROUPS PASSED')
finally:
    print('\nCleaning up owned runtime containers/volume/role/schemas...')
    for name in (worker_id, engine_id):
        if name:
            try: docker('rm', '-f', name)
            except RuntimeError: pass
    if volume:
        try: docker('volume', 'rm', volume)
        except RuntimeError: pass
    try: docker('image', 'rm', IMAGE_TAG)
    except RuntimeError: pass
    sql("ALTER ROLE inbox_reply_send_worker NOLOGIN PASSWORD NULL", check=False)
    sql(CLEANUP, check=False)
    sql(ROLE_CLEANUP, check=False)
    if owned_org:
        # PRIMARY tables: deleted explicitly, in the correct FK/trigger order.
        sql(f"DELETE FROM messages WHERE org_id='{owned_org}';"
            f"DELETE FROM consent_events WHERE org_id='{owned_org}';"
            f"DELETE FROM properties WHERE org_id='{owned_org}';"
            f"DELETE FROM contacts WHERE org_id='{owned_org}';"
            f"DELETE FROM provider_sender_numbers WHERE org_id='{owned_org}';"
            f"DELETE FROM auth.sessions WHERE user_id='{owned_user}';"
            f"ALTER TABLE memberships DISABLE TRIGGER trg_hugo_membership_owner_guard;"
            f"DELETE FROM memberships WHERE org_id='{owned_org}';"
            f"DELETE FROM auth.users WHERE id='{owned_user}';"
            f"ALTER TABLE memberships ENABLE TRIGGER trg_hugo_membership_owner_guard;"
            f"DELETE FROM organizations WHERE id='{owned_org}';", check=False)
        # [Astra round-3] EVERYTHING ELSE: the same generic, dynamically-
        # discovered sweep as proof.py — see owned_cleanup.py.
        owned_cleanup.sweep_delete(sql, ORG_TABLES, USER_TABLES, [owned_org], [owned_user])
        residual = {}
        for label, query in [
            ('organizations', f"SELECT count(*) FROM organizations WHERE id='{owned_org}'"),
            ('auth.users', f"SELECT count(*) FROM auth.users WHERE id='{owned_user}'"),
        ]:
            n = sql(query, check=False)
            if n and n != '0': residual[label] = n
        if residual: raise RuntimeError(f'Owned-fixture cleanup left residual rows in explicitly-managed PRIMARY tables: {residual}')
        # [Astra round-3] Exhaustive-by-construction check — every
        # dynamically-discovered org_id/user_id-scoped table anywhere in the
        # database, plus the counter/cursor tables against their baseline.
        owned_cleanup.assert_zero_residual(sql, ORG_TABLES, USER_TABLES, COUNTER_TABLES, COUNTER_BASELINE, [owned_org], [owned_user])
        print(f'Exhaustive dynamic residual check passed: {len(ORG_TABLES)} org-scoped + {len(USER_TABLES)} user-scoped + {len(COUNTER_TABLES)} counter table(s), zero net residual across all of them')
    need(sql("SELECT to_regnamespace('inbox_reply_send') IS NULL", check=False) == 't', 'inbox_reply_send schema not dropped')
    need(sql("SELECT NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_reply_send_worker')", check=False) == 't', 'inbox_reply_send_worker role not dropped')
    print('Cleanup verified: containers/volume/image removed, schemas and worker role dropped, zero residual owned rows')
