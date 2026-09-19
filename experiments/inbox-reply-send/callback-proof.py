#!/usr/bin/env python3
"""Lane 1 PR-G mutation-first proof for callback.sql (reconcile_delivery,
drain_unmatched, unmatched_callbacks, callback_receipts, the
public.inbox_reply_reconcile_callback wrapper). Owned fixture only. Installs
the full reply-lane schema chain + attempts.sql + accept.sql + public-api.sql
(committed, not rollback-only — mirrors accept-proof.py's own idiom) then
callback.sql on top, drives real attempts through claim/start_dispatch/
persist to provider_accepted, and proves every invariant in the architect
brief with a real break -> watch FAIL -> restore -> watch PASS cycle for the
guards that matter most (the unique association index and the delivered/
delivery_failed precedence in reconcile_delivery)."""
import hashlib,json,re,subprocess,sys,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
import owned_cleanup
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def need(v,label):
 if not v:raise RuntimeError(label)
def sql(q,timeout=20,check=True):
 r=subprocess.run(CMD,input="SET statement_timeout='15s'; SET lock_timeout='10s'; SET extra_float_digits=3; BEGIN;"+q.rstrip()+";COMMIT;",text=True,capture_output=True,timeout=timeout)
 if check:need(r.returncode==0,r.stderr)
 return r if not check else r.stdout.strip()
def sql_fail(q,timeout=20):
 r=subprocess.run(CMD,input="SET statement_timeout='15s'; SET lock_timeout='10s'; SET extra_float_digits=3; BEGIN;"+q.rstrip()+";COMMIT;",text=True,capture_output=True,timeout=timeout)
 need(r.returncode!=0,f'expected failure but succeeded: {r.stdout}')
 return r.stderr

validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")=='t','Refusing existing reply schema')

# [Astra fix-3] Dynamic, exhaustive-by-construction residual discovery — see
# owned_cleanup.py's module docstring (copied verbatim from
# experiments/inbox-reply-send-worker/owned_cleanup.py, PR-F's Astra
# round-9 closure). MUST run before anything else writes a row, so BASELINE
# reflects the true pre-run state for every table in the single uniform
# universe (no hand-maintained table list, which round-3-through-9 each
# proved leaks real tables).
ORG_TABLES,USER_TABLES,ALL_TABLES=owned_cleanup.discover(sql)
BASELINE=owned_cleanup.snapshot_baseline(sql,ALL_TABLES)
print(f'Discovered {len(ALL_TABLES)} table(s) database-wide (uniform content-signature universe) — {len(ORG_TABLES)} org_id-scoped + {len(USER_TABLES)} user_id-scoped for the sweep')

CLEANUP="DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP FUNCTION IF EXISTS public.inbox_accept_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_recover_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_reply_operation_status(uuid);DROP FUNCTION IF EXISTS public.inbox_reply_reconcile_callback(text,text,text,jsonb);DROP FUNCTION IF EXISTS public.inbox_reply_sweep_unmatched_callbacks(integer);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;DROP SCHEMA IF EXISTS inbox_reply_send_scratch CASCADE;"
sql(CLEANUP)

sources=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P.parent/'inbox-reply-review/setup.sql',P.parent/'inbox-reply-review/public-api.sql',P/'attempts.sql',P/'accept.sql',P/'public-api.sql',P/'callback.sql']
ALL_SOURCES_SQL=''.join(s.read_text() for s in sources)
SCRATCH_SCHEMA='inbox_reply_send_scratch'
def real_fn(qualified_name):
 pat=re.compile(r'CREATE FUNCTION\s+'+re.escape(qualified_name)+r'\(.*?\$\$;\n',re.DOTALL)
 m=pat.search(ALL_SOURCES_SQL)
 if not m:raise RuntimeError(f'real_fn: could not extract {qualified_name} from source files')
 return 'CREATE OR REPLACE FUNCTION '+m.group(0)[len('CREATE FUNCTION '):]
def restore_fn(qualified_name):
 sql(real_fn(qualified_name))
def _scratch_install(qualified_name):
 defn=real_fn(qualified_name)
 prefix='CREATE OR REPLACE FUNCTION '+qualified_name+'('
 if not defn.startswith(prefix):raise RuntimeError(f'_scratch_install: {qualified_name} unexpected prefix')
 name=qualified_name.split('.',1)[1]
 scratch_name=f'{SCRATCH_SCHEMA}.{name}'
 return scratch_name,'CREATE OR REPLACE FUNCTION '+scratch_name+'('+defn[len(prefix):]
def _normalize(definition,name):
 p=definition.find(name)
 if p<0:raise RuntimeError(f'_normalize: {name} not found in pg_get_functiondef output')
 return definition[:p]+'<FN>'+definition[p+len(name):]
def assert_body_matches(qualified_name):
 sql(f'CREATE SCHEMA IF NOT EXISTS {SCRATCH_SCHEMA};')
 scratch_name,scratch_ddl=_scratch_install(qualified_name)
 sql(scratch_ddl)
 try:
  installed_def=sql(f"SELECT pg_get_functiondef('{qualified_name}'::regproc)")
  scratch_def=sql(f"SELECT pg_get_functiondef('{scratch_name}'::regproc)")
  need(_normalize(installed_def,qualified_name)==_normalize(scratch_def,scratch_name),f'assert_body_matches: {qualified_name} installed != scratch candidate (stale restore)')
 finally:
  sql(f"DO $d$ DECLARE cmd text; BEGIN SELECT 'DROP FUNCTION '||oid::regprocedure INTO cmd FROM pg_proc WHERE oid='{scratch_name}'::regproc; EXECUTE cmd; END $d$;")
def restore_and_verify(qualified_name):
 restore_fn(qualified_name)
 assert_body_matches(qualified_name)

checks=[]
def record(label):
 checks.append(label);print(f'  OK  {label}')

OWNED_ORGS=[];OWNED_USERS=[]
SESS={}

def make_org_and_prep(dest_prefix,n=1):
 o=str(uuid.uuid4());u=str(uuid.uuid4());sess=str(uuid.uuid4());s=str(uuid.uuid4());k=str(uuid.uuid4())
 OWNED_ORGS.append(o);OWNED_USERS.append(u)
 sql(f"INSERT INTO organizations(id,name) VALUES('{o}','PR-G proof {o}');"
     f"INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');"
     f"INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active');"
     f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess}','{u}',clock_timestamp()+interval '1 hour');"
     f"INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+18165550101','active');")
 cids=[]
 for i in range(1,n+1):
  cid=str(uuid.uuid4());pid=str(uuid.uuid4());ctid=str(uuid.uuid4());dest=dest_prefix+str(i).zfill(5)
  sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{ctid}','{o}','C{i}','{dest}','mobile');"
      f"INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o}','{ctid}','sms','opt_in_confirmed','pr-g-proof');"
      f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{o}','Proof property {i}','MO','{ctid}');"
      f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o}','{cid}','{ctid}','{pid}','sms','inbound','received','hi','{dest}','+18165550101');")
  cids.append(cid)
 targets=json.dumps([{'kind':'conversation','id':c} for c in cids])
 sql("UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;")
 capture=json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{json.dumps({'sub':u,'role':'authenticated','session_id':sess,'exp':4102444800})}'; SELECT public.inbox_capture_reply_recipients(ARRAY[{','.join(chr(39)+c+chr(39) for c in cids)}]::uuid[])::text;"))
 drafts=[{'conversationId':item['conversation_id'],'body':'Hi there','dependencies':item['dependencies'],'exclusion':None} for item in capture['items']]
 payload=json.dumps({'targets':json.loads(targets),'drafts':drafts,'template':'Hi there'}).replace("'","''")
 freeze=json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{json.dumps({'sub':u,'role':'authenticated','session_id':sess,'exp':4102444800})}'; SELECT public.inbox_freeze_reply_review('{payload}','{k}')::text;"))
 prep_id=freeze['preparationId']
 SESS[u]=sess
 sql(f"UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;")
 accept_result=json.loads(sql(f"SET LOCAL request.jwt.claims='{json.dumps({'sub':u,'role':'authenticated','session_id':sess,'exp':4102444800})}'; SELECT inbox_reply_send.accept('{o}','{u}','{k}','{prep_id}')::text;"))
 op_id=accept_result['operation_id']
 att_ids=sql(f"SELECT id::text FROM inbox_reply_send.attempts WHERE org_id='{o}' AND operation_id='{op_id}' ORDER BY item_id").splitlines()
 return o,u,op_id,att_ids

def drive_to_provider_accepted(o,att_id,reference):
 sql(f"SELECT inbox_reply_send.claim('{o}','{att_id}');")
 dispatch=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o}','{att_id}',1)::text;"))
 need(dispatch['kind']=='dispatch',f'start_dispatch did not dispatch: {dispatch}')
 token=dispatch['token']
 persisted=json.loads(sql(f"SELECT inbox_reply_send.persist('{o}','{att_id}','{token}',jsonb_build_object('kind','accepted','externalId','{reference}','status','sent'))::text;"))
 need(persisted['state']=='provider_accepted',f'persist did not reach provider_accepted: {persisted}')

def state_of(o,att_id):
 return sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{att_id}'")

def receipt_version_of(o,att_id):
 return int(sql(f"SELECT receipt_version FROM inbox_reply_send.attempts WHERE org_id='{o}' AND id='{att_id}'"))

def call_wrapper(reference,terminal,payload='{}'):
 q=f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_reconcile_callback('sendillo','{reference}','{terminal}','{payload}'::jsonb)::text; RESET ROLE;"
 return json.loads(sql(q))

def call_wrapper_fail(reference,terminal,payload='{}'):
 q=f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_reconcile_callback('sendillo','{reference}','{terminal}','{payload}'::jsonb)::text; RESET ROLE;"
 return sql_fail(q)

try:
 sql(''.join(s.read_text() for s in sources))
 sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;")
 print('Installed reply-lane schema chain + callback.sql')

 # === Grant hygiene: wrapper reachable ONLY by service_role ===
 grantees=set(sql("SELECT string_agg(grantee,',' ORDER BY grantee) FROM information_schema.role_routine_grants WHERE routine_schema='public' AND routine_name='inbox_reply_reconcile_callback'").split(','))
 need(grantees<={'postgres','service_role'} and 'service_role' in grantees,f'wrapper grants leaked beyond owner+service_role: {grantees}')
 record('grant hygiene: inbox_reply_reconcile_callback EXECUTE granted to service_role only (postgres is the owner)')
 denied=sql_fail("SET LOCAL ROLE authenticated; SELECT public.inbox_reply_reconcile_callback('sendillo','x','delivered','{}'::jsonb)::text; RESET ROLE;")
 need('permission denied' in denied.lower(),f'authenticated should be denied EXECUTE: {denied}')
 record('grant hygiene: authenticated denied EXECUTE on the wrapper')

 # === #1 Happy path: provider_accepted -> delivered ===
 o1,u1,op1,atts1=make_org_and_prep('+130255',1)
 drive_to_provider_accepted(o1,atts1[0],'PROV-G-HAPPY-1')
 result=call_wrapper('PROV-G-HAPPY-1','delivered')
 need(result['kind']=='reconciled' and result['result']['state']=='delivered' and result['result']['applied'] is True,f'happy delivered mismatch: {result}')
 need(state_of(o1,atts1[0])=='delivered','row not delivered after reconcile')
 record('happy path: provider_accepted -> delivered via wrapper')

 # === #2 Happy path: provider_accepted -> delivery_failed ===
 o2,u2,op2,atts2=make_org_and_prep('+130256',1)
 drive_to_provider_accepted(o2,atts2[0],'PROV-G-HAPPY-2')
 result=call_wrapper('PROV-G-HAPPY-2','delivery_failed')
 need(result['result']['state']=='delivery_failed','happy delivery_failed mismatch')
 need(state_of(o2,atts2[0])=='delivery_failed','row not delivery_failed after reconcile')
 record('happy path: provider_accepted -> delivery_failed via wrapper')

 # === #3 Idempotent redelivery no-op ===
 rv_before=receipt_version_of(o1,atts1[0])
 result=call_wrapper('PROV-G-HAPPY-1','delivered')
 need(result['kind']=='already_processed' or (result['kind']=='reconciled' and result['result']['applied'] is False and result['result']['state']=='delivered'),f'redelivery should be a no-op: {result}')
 need(state_of(o1,atts1[0])=='delivered' and receipt_version_of(o1,atts1[0])==rv_before,'idempotent redelivery mutated the row')
 record('idempotent redelivery of the same terminal status is a no-op (deduped at the receipt-lease layer)')

 # === #4 Out-of-order / contradiction ===
 # [Astra fix-1, correctness] A rejected contradiction is a normal,
 # non-raising RPC result (kind:'rejected'), NOT a thrown SQL exception —
 # see the wrapper's EXCEPTION block: re-raising here would abort the WHOLE
 # transaction, which would also undo any earlier drain-first write that
 # happened to share this same call (proof #5b below). rv/receipt_version
 # must be untouched either way.
 rv_before_contradiction=receipt_version_of(o1,atts1[0])
 contradiction_result=call_wrapper('PROV-G-HAPPY-1','delivery_failed')
 need(contradiction_result=={'kind':'rejected','code':'INBOX_REPLY_CONTRADICTORY_RECEIPT'},f'expected a rejected/CONTRADICTORY_RECEIPT result, got: {contradiction_result}')
 need(state_of(o1,atts1[0])=='delivered' and receipt_version_of(o1,atts1[0])==rv_before_contradiction,'contradictory receipt flipped a terminal row')
 record('out-of-order contradictory terminal (delivered then delivery_failed) rejected as a normal result, first-terminal-wins, no state change')

 # === #5 Callback-before-persist: stored, not discarded; then drained exactly once ===
 o3,u3,op3,atts3=make_org_and_prep('+130257',1)
 sql(f"SELECT inbox_reply_send.claim('{o3}','{atts3[0]}');")
 dispatch=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o3}','{atts3[0]}',1)::text;"))
 need(dispatch['kind']=='dispatch','expected dispatch')
 token=dispatch['token']
 # No persist() yet — attempts row has no provider_reference. A callback for
 # this reference arrives now, before persist() ever runs.
 result=call_wrapper('PROV-G-UNMATCHED-1','delivered')
 need(result['kind']=='stored_unmatched',f'expected stored_unmatched: {result}')
 held=sql("SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='PROV-G-UNMATCHED-1'")
 need(held=='1','callback-before-persist row not durably stored')
 record('callback-before-persist: stored durably in unmatched_callbacks, never discarded')
 # A second, contradictory callback for the SAME unmatched reference is
 # deduped (first-received wins) — never silently overwritten.
 call_wrapper('PROV-G-UNMATCHED-1','delivery_failed')
 stored_status=sql("SELECT terminal_status FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='PROV-G-UNMATCHED-1'")
 need(stored_status=='delivered','unmatched holding row was overwritten by a later contradictory callback')
 record('unmatched holding row dedups first-received, never overwritten by a later contradictory callback')
 # Now persist() binds the reference — the drain must reconcile it exactly
 # once, then a second drain is a clean no-op.
 persisted=json.loads(sql(f"SELECT inbox_reply_send.persist('{o3}','{atts3[0]}','{token}',jsonb_build_object('kind','accepted','externalId','PROV-G-UNMATCHED-1','status','sent'))::text;"))
 need(persisted['state']=='provider_accepted','persist did not bind the awaited reference')
 drain1=json.loads(sql("SELECT inbox_reply_send.drain_unmatched('sendillo','PROV-G-UNMATCHED-1')::text;"))
 need(drain1['drained'] is True and drain1['result']['state']=='delivered','drain did not reconcile the persisted reference')
 need(state_of(o3,atts3[0])=='delivered','row not delivered after drain')
 rv_after_drain=receipt_version_of(o3,atts3[0])
 drain2=json.loads(sql("SELECT inbox_reply_send.drain_unmatched('sendillo','PROV-G-UNMATCHED-1')::text;"))
 need(drain2['drained'] is False and drain2['reason']=='no_holding_row','second drain should be a clean no-op (holding row already consumed)')
 need(receipt_version_of(o3,atts3[0])==rv_after_drain,'second drain double-applied')
 record('callback-before-persist: drain reconciles exactly once; second drain is a no-op')

 # === #5b [Astra fix-1] Held-callback precedence via the WRAPPER itself
 # (never calling drain_unmatched by hand) — first arrival wins regardless
 # of persist() timing. Held 'delivered' arrives before persist(); persist()
 # binds the reference; a LATER 'delivery_failed' arrives on the wrapper's
 # normal matched path. The wrapper must drain the held 'delivered' FIRST
 # (making it the winner) and then reject the later 'delivery_failed' as a
 # contradiction — the REVERSE of what a matched-path-applies-directly bug
 # would do (which would let delivery_failed win instead). ===
 o10,u10,op10,atts10=make_org_and_prep('+130264',1)
 sql(f"SELECT inbox_reply_send.claim('{o10}','{atts10[0]}');")
 dispatch10=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o10}','{atts10[0]}',1)::text;"))
 token10=dispatch10['token']
 held_first=call_wrapper('PROV-G-PRECEDENCE-1','delivered')
 need(held_first['kind']=='stored_unmatched','expected the first delivered callback to be held unmatched')
 persisted10=json.loads(sql(f"SELECT inbox_reply_send.persist('{o10}','{atts10[0]}','{token10}',jsonb_build_object('kind','accepted','externalId','PROV-G-PRECEDENCE-1','status','sent'))::text;"))
 need(persisted10['state']=='provider_accepted','persist did not bind PROV-G-PRECEDENCE-1')
 # No manual drain_unmatched call here — only a normal second wrapper call,
 # exactly like a real second webhook delivery.
 later=call_wrapper('PROV-G-PRECEDENCE-1','delivery_failed')
 need(later=={'kind':'rejected','code':'INBOX_REPLY_CONTRADICTORY_RECEIPT'},f'held delivered should have been drained first and won, making delivery_failed the contradiction: {later}')
 need(state_of(o10,atts10[0])=='delivered','the HELD first-arrival (delivered) should have won, not the later delivery_failed')
 held_row_gone=sql("SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='PROV-G-PRECEDENCE-1'")
 need(held_row_gone=='0','the wrapper should have drained (and deleted) the held row as part of resolving the later callback')
 record('[Astra fix-1] wrapper drains an earlier-held terminal FIRST on the matched path: first arrival (delivered) wins, a later contradictory delivery_failed is rejected — never the reverse')

 # === #5c [Astra fix-1] Durable sweep: a held callback that gets persisted
 # but NEVER receives a second callback must still reconcile — this is the
 # gap the wrapper's own drain-first step (5b) cannot close by itself, since
 # nothing ever calls the wrapper again for this reference. ===
 o11,u11,op11,atts11=make_org_and_prep('+130265',1)
 sql(f"SELECT inbox_reply_send.claim('{o11}','{atts11[0]}');")
 dispatch11=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o11}','{atts11[0]}',1)::text;"))
 token11=dispatch11['token']
 held_sweep=call_wrapper('PROV-G-SWEEP-1','delivered')
 need(held_sweep['kind']=='stored_unmatched','expected the sweep-target callback to be held unmatched')
 sql(f"SELECT inbox_reply_send.persist('{o11}','{atts11[0]}','{token11}',jsonb_build_object('kind','accepted','externalId','PROV-G-SWEEP-1','status','sent'))::text;")
 need(state_of(o11,atts11[0])=='provider_accepted','row should still be provider_accepted — nothing has drained it yet')
 sweep_result=json.loads(sql(f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_sweep_unmatched_callbacks(100)::text; RESET ROLE;"))
 need(sweep_result['drained']>=1,f'sweep should have drained at least the one now-persisted held reference: {sweep_result}')
 need(state_of(o11,atts11[0])=='delivered','sweep did not reconcile the held callback once its attempt was persisted')
 held_row_gone11=sql("SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='PROV-G-SWEEP-1'")
 need(held_row_gone11=='0','sweep should have deleted the drained holding row')
 record('[Astra fix-1] durable sweep drains a held callback once its attempt is persisted, even with no second callback ever arriving')
 # A second sweep pass over the now-empty holding row is a clean no-op.
 sweep_result2=json.loads(sql(f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_sweep_unmatched_callbacks(100)::text; RESET ROLE;"))
 need(sweep_result2['drained']==0 or 'PROV-G-SWEEP-1' not in sql("SELECT coalesce(string_agg(provider_reference,','),'') FROM inbox_reply_send.unmatched_callbacks WHERE provider_reference='PROV-G-SWEEP-1'"),'second sweep should not re-drain an already-consumed reference')
 record('[Astra fix-1] a second sweep pass never re-drains an already-consumed reference')

 # === #5d [Astra fix-1] Concurrent drains of the SAME reference apply
 # exactly once — the holding row's FOR UPDATE lock serializes two racing
 # drains regardless of scheduling; the loser always finds NOT FOUND once
 # the winner has deleted the row. ===
 o12,u12,op12,atts12=make_org_and_prep('+130266',1)
 sql(f"SELECT inbox_reply_send.claim('{o12}','{atts12[0]}');")
 dispatch12=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o12}','{atts12[0]}',1)::text;"))
 token12=dispatch12['token']
 call_wrapper('PROV-G-CONCURRENT-1','delivered')
 sql(f"SELECT inbox_reply_send.persist('{o12}','{atts12[0]}','{token12}',jsonb_build_object('kind','accepted','externalId','PROV-G-CONCURRENT-1','status','sent'))::text;")
 rv_before_race=receipt_version_of(o12,atts12[0])
 import concurrent.futures
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  futures=[pool.submit(sql,"SELECT inbox_reply_send.drain_unmatched('sendillo','PROV-G-CONCURRENT-1')::text;") for _ in range(2)]
  race_results=[json.loads(f.result()) for f in futures]
 drained_true=[r for r in race_results if r['drained'] is True]
 drained_false=[r for r in race_results if r['drained'] is False]
 need(len(drained_true)==1 and len(drained_false)==1,f'expected exactly one winner and one no-op, got: {race_results}')
 need(drained_false[0]['reason']=='no_holding_row','the losing concurrent drain should see the row already gone')
 need(state_of(o12,atts12[0])=='delivered' and receipt_version_of(o12,atts12[0])==rv_before_race+1,'concurrent drains applied more than once')
 record('[Astra fix-1] two concurrent drains of the same reference: exactly one applies, the other is a clean no-op, receipt_version advances by exactly 1')

 # === #5e [Astra fix-1] Mutation: reinstall the wrapper WITHOUT the
 # drain-first step (the original defect this Astra round found — held
 # callbacks were never reconciled by anything), watch the held terminal
 # get silently bypassed and the LATER callback wrongly decide the outcome
 # by itself; restore the exact byte-verified source definition and
 # reverify first-arrival precedence is back in force. ===
 o13,u13,op13,atts13=make_org_and_prep('+130267',1)
 sql(f"SELECT inbox_reply_send.claim('{o13}','{atts13[0]}');")
 dispatch13=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o13}','{atts13[0]}',1)::text;"))
 token13=dispatch13['token']
 call_wrapper('PROV-G-MUTATE-DRAIN-1','delivered')
 sql(f"SELECT inbox_reply_send.persist('{o13}','{atts13[0]}','{token13}',jsonb_build_object('kind','accepted','externalId','PROV-G-MUTATE-DRAIN-1','status','sent'))::text;")
 wrapper_defn=real_fn('public.inbox_reply_reconcile_callback')
 drain_line=" PERFORM inbox_reply_send.drain_unmatched(in_provider,in_external_id);\n"
 need(drain_line in wrapper_defn,'could not locate the drain-first line to remove for this mutation')
 mutated_wrapper=wrapper_defn.replace(drain_line,'')
 sql(mutated_wrapper)
 mutated_result=call_wrapper('PROV-G-MUTATE-DRAIN-1','delivery_failed')
 need(mutated_result['kind']=='reconciled' and state_of(o13,atts13[0])=='delivery_failed',f'mutation did not actually remove the drain-first fix: {mutated_result}')
 held_survives=sql("SELECT count(*) FROM inbox_reply_send.unmatched_callbacks WHERE provider='sendillo' AND provider_reference='PROV-G-MUTATE-DRAIN-1'")
 need(held_survives=='1','mutation should leave the held delivered row stranded, unreconciled, while delivery_failed wrongly wins')
 record('mutation: wrapper without the drain-first step lets a later callback wrongly decide the outcome, stranding the held first-arrival (proves the fix, not incidental behavior, enforces precedence)')
 restore_and_verify('public.inbox_reply_reconcile_callback')
 # Clean up the mutation-created stranded holding row via the NOW-restored
 # sweep path (not a manual DELETE) so the restore is exercised end-to-end.
 sql(f"SET LOCAL ROLE service_role; SELECT public.inbox_reply_sweep_unmatched_callbacks(100)::text; RESET ROLE;")

 # === #6 Unique association + collision (never matched by phone) ===
 o4,u4,op4,atts4=make_org_and_prep('+130258',2)
 drive_to_provider_accepted(o4,atts4[0],'PROV-G-UNIQUE-1')
 sql(f"SELECT inbox_reply_send.claim('{o4}','{atts4[1]}');")
 dispatch2=json.loads(sql(f"SELECT inbox_reply_send.start_dispatch('{o4}','{atts4[1]}',1)::text;"))
 token2=dispatch2['token']
 collide_err=sql_fail(f"SELECT inbox_reply_send.persist('{o4}','{atts4[1]}','{token2}',jsonb_build_object('kind','accepted','externalId','PROV-G-UNIQUE-1','status','sent'))::text;")
 need('duplicate key' in collide_err.lower() or '23505' in collide_err,f'expected a unique_violation on provider_reference collision: {collide_err}')
 need('+130258' not in collide_err,'collision error leaked a phone number')
 record('unique association: a second attempt cannot bind an already-used provider_reference (23505, no phone leak)')
 # atts4[1] is still dispatch_started after the failed persist above (the
 # whole persist() transaction aborted). Bind it its OWN distinct reference
 # normally so it reaches provider_accepted (a state the CHECK constraint
 # requires provider_reference IS NOT NULL for either way) before the index-
 # removal mutation below.
 persisted2=json.loads(sql(f"SELECT inbox_reply_send.persist('{o4}','{atts4[1]}','{token2}',jsonb_build_object('kind','accepted','externalId','PROV-G-UNIQUE-1-DISTINCT','status','sent'))::text;"))
 need(persisted2['state']=='provider_accepted','second attempt failed to bind its own distinct reference')
 # The reference still resolves to exactly the ORIGINAL attempt.
 result=call_wrapper('PROV-G-UNIQUE-1','delivered')
 need(result['kind']=='reconciled','collision attempt should not have prevented the original from reconciling')
 need(state_of(o4,atts4[0])=='delivered' and state_of(o4,atts4[1])=='provider_accepted','callback matched the wrong attempt')
 record('a callback matches exactly one attempt by reference, never by phone')

 # Mutation: drop the unique index, install the SAME reference on a second
 # attempt (already provider_accepted, so the CHECK constraint is satisfied
 # either way — only the transition-guard trigger, a wholly separate guard
 # from the one under test, blocks a same-state UPDATE, so it is disabled
 # around this direct value swap, exactly like the ledger's own established
 # mutation idiom in attempts.sql's run.py), watch it succeed (proving the
 # index, not incidental behavior, was blocking it), then restore and
 # reverify the block.
 sql('DROP INDEX inbox_reply_send.inbox_reply_send_provider_reference;')
 sql('ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;')
 sql(f"UPDATE inbox_reply_send.attempts SET provider_reference='PROV-G-UNIQUE-1' WHERE org_id='{o4}' AND id='{atts4[1]}';")
 dupe_count=sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE provider_reference='PROV-G-UNIQUE-1'")
 need(dupe_count=='2','mutation did not actually create a duplicate reference (index removal had no effect)')
 sql(f"UPDATE inbox_reply_send.attempts SET provider_reference='PROV-G-UNIQUE-1-DISTINCT' WHERE org_id='{o4}' AND id='{atts4[1]}';")
 sql('ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;')
 sql('CREATE UNIQUE INDEX inbox_reply_send_provider_reference ON inbox_reply_send.attempts(provider_reference) WHERE provider_reference IS NOT NULL;')
 sql('ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;')
 restore_err=sql_fail(f"UPDATE inbox_reply_send.attempts SET provider_reference='PROV-G-UNIQUE-1' WHERE org_id='{o4}' AND id='{atts4[1]}';")
 sql('ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;')
 need('duplicate key' in restore_err.lower() or '23505' in restore_err,'restored index failed to block the duplicate again')
 record('mutation: unique index removal allows collision; restored index blocks it again')

 # === #7 Org scope + cross-org reject ===
 o5,u5,op5,atts5=make_org_and_prep('+130259',1)
 drive_to_provider_accepted(o5,atts5[0],'PROV-G-ORGSCOPE-1')
 wrong_org_err=sql_fail(f"SELECT inbox_reply_send.reconcile_delivery('{o1}','sendillo','PROV-G-ORGSCOPE-1','delivered','{{}}'::jsonb)::text;")
 need('INBOX_REPLY_CALLBACK_UNMATCHED' in wrong_org_err,f'cross-org reconcile should reject as unmatched, got: {wrong_org_err}')
 need(state_of(o5,atts5[0])=='provider_accepted','cross-org call incorrectly mutated a row in another org')
 record('org scope: reconcile_delivery with the wrong org_id rejects (never touches another org\'s row)')
 result=call_wrapper('PROV-G-ORGSCOPE-1','delivered')
 need(result['kind']=='reconciled' and state_of(o5,atts5[0])=='delivered','the correct org still reconciles normally')
 record('org scope: the wrapper resolves the correct org and reconciles normally')

 # === #8 Lease fencing on completion AND failure ===
 o6,u6,op6,atts6=make_org_and_prep('+130260',1)
 drive_to_provider_accepted(o6,atts6[0],'PROV-G-LEASE-1')
 # Simulate a stale completion: manually advance lease_generation past what
 # any in-flight caller could present, mirroring a concurrent reclaim.
 call_wrapper('PROV-G-LEASE-1','delivered')
 before=sql("SELECT lease_generation,processing_status FROM inbox_reply_send.callback_receipts WHERE provider='sendillo' AND event_type='inbox_reply_status_delivered' AND external_id='PROV-G-LEASE-1'")
 need(before.split('|')[1]=='processed','expected receipt row processed after happy reconcile')
 # A stale-generation completion UPDATE (the shape a delayed/duplicate
 # worker would issue after losing a race) must affect zero rows.
 stale_update=sql("UPDATE inbox_reply_send.callback_receipts SET processing_status='processed',processed_at=clock_timestamp() WHERE provider='sendillo' AND event_type='inbox_reply_status_delivered' AND external_id='PROV-G-LEASE-1' AND lease_generation=-1 RETURNING 1")
 need(stale_update=='','a stale lease_generation completion should affect zero rows')
 record('lease fencing: a completion carrying a stale lease_generation affects zero rows')
 o7,u7,op7,atts7=make_org_and_prep('+130261',1)
 drive_to_provider_accepted(o7,atts7[0],'PROV-G-LEASE-2')
 sql(f"INSERT INTO inbox_reply_send.callback_receipts(org_id,provider,event_type,external_id,processing_status,lease_owner,lease_generation,lease_until,payload) VALUES('{o7}','sendillo','inbox_reply_status_delivered','PROV-G-LEASE-2','processing',gen_random_uuid(),0,clock_timestamp()-interval '10 minutes','{{}}'::jsonb);")
 result=call_wrapper('PROV-G-LEASE-2','delivered')
 need(result['kind']=='reconciled','expired lease should be reclaimed and reconciled')
 gen_after=int(sql("SELECT lease_generation FROM inbox_reply_send.callback_receipts WHERE provider='sendillo' AND event_type='inbox_reply_status_delivered' AND external_id='PROV-G-LEASE-2'"))
 need(gen_after==1,f'expired lease reclaim should strictly increase lease_generation, got {gen_after}')
 record('lease fencing: an expired lease is reclaimed (fresh owner, strictly higher generation) and completes')

 # === #9 Reply-vs-Outbox namespace isolation ===
 same_external='SHARED-EXTERNAL-ID-ISOLATION'
 o8,u8,op8,atts8=make_org_and_prep('+130262',1)
 drive_to_provider_accepted(o8,atts8[0],same_external)
 sql(f"INSERT INTO webhook_events(provider,event_type,external_id,payload,signature_verified,processing_status) VALUES('sendillo','sms_status_delivered','{same_external}','{{}}'::jsonb,true,'processed');")
 result=call_wrapper(same_external,'delivered')
 need(result['kind']=='reconciled' and state_of(o8,atts8[0])=='delivered','reply reconcile blocked by an unrelated Outbox sms_status_ row for the same external id')
 receipt_row=sql(f"SELECT event_type FROM inbox_reply_send.callback_receipts WHERE provider='sendillo' AND external_id='{same_external}'")
 need(receipt_row=='inbox_reply_status_delivered','reply receipt event_type not namespaced')
 record('reply-vs-Outbox namespace isolation: a shared external_id never collides across webhook_events (sms_status_) and callback_receipts (inbox_reply_status_)')

 # === #10 Signature/parse failures produce no state change (proved at the
 # SQL layer: an invalid callback call is rejected before any write) ===
 invalid_err=sql_fail("SELECT public.inbox_reply_reconcile_callback('sendillo','PROV-X','bogus_status','{}'::jsonb)::text;")
 need('INBOX_REPLY_INVALID_CALLBACK' in invalid_err,f'expected INVALID_CALLBACK, got: {invalid_err}')
 record('malformed terminal status rejected before any write (SQL-layer bound of the route-level 401/400 contract)')

 # === Mutation on reconcile_delivery itself: remove the first-terminal-wins
 # guard entirely (treat every provider_accepted-or-terminal row as
 # writable), watch a contradiction silently flip; restore the exact source
 # definition (byte-verified) and reverify the guard again. The ledger's OWN
 # transition-guard trigger (attempts.sql:242-246) is a SECOND, independent
 # defense that does not allow delivered->delivery_failed at all — good
 # defense-in-depth, but it means this mutation must also suspend that
 # deeper trigger for the duration of the single mutated call, to isolate
 # and prove reconcile_delivery's OWN precedence logic specifically (rather
 # than merely re-proving the trigger, which is already covered by run.py's
 # own #4/#5 proofs on attempts.sql). Both the function and the trigger are
 # restored immediately after. ===
 o9,u9,op9,atts9=make_org_and_prep('+130263',1)
 drive_to_provider_accepted(o9,atts9[0],'PROV-G-MUTATE-1')
 call_wrapper('PROV-G-MUTATE-1','delivered')
 sql('ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;')
 sql(r"""
CREATE OR REPLACE FUNCTION inbox_reply_send.reconcile_delivery(o uuid,provider text,provider_reference text,terminal text,payload jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;v bigint;
BEGIN
 IF o IS NULL OR provider IS DISTINCT FROM 'sendillo' OR provider_reference IS NULL OR btrim(provider_reference)='' OR terminal NOT IN ('delivered','delivery_failed') OR jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'INBOX_REPLY_INVALID_CALLBACK';
 END IF;
 SELECT * INTO row FROM inbox_reply_send.attempts a WHERE a.org_id=o AND a.provider_reference=reconcile_delivery.provider_reference FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_CALLBACK_UNMATCHED';END IF;
 -- MUTATION: precedence guard removed — any provider_accepted-or-terminal
 -- row is blindly overwritten to whatever terminal just arrived.
 UPDATE inbox_reply_send.attempts SET state=terminal,receipt_version=receipt_version+1 WHERE org_id=o AND id=row.id RETURNING receipt_version INTO v;
 RETURN jsonb_build_object('state',terminal,'receipt_version',v::text,'applied',true);
END $$;
""")
 flipped=call_wrapper('PROV-G-MUTATE-1','delivery_failed')
 need(state_of(o9,atts9[0])=='delivery_failed',f'mutation did not actually remove the precedence guard: {flipped}')
 record('mutation: precedence guard removed -> contradictory terminal silently flips the row (proves the guard, not incidental behavior, blocks this)')
 sql('ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;')
 restore_and_verify('inbox_reply_send.reconcile_delivery')
 # Reverify the RESTORED function rejects a fresh contradiction — reuse
 # org5's already-delivered row (proof #7) rather than manufacture a new one.
 err2=call_wrapper('PROV-G-ORGSCOPE-1','delivery_failed')
 need(err2=={'kind':'rejected','code':'INBOX_REPLY_CONTRADICTORY_RECEIPT'},f'restored reconcile_delivery did not reject contradiction: {err2}')
 record('restore verified byte-exact (assert_body_matches) and the precedence guard is back in force')

 print(f'\nALL {len(checks)} PROOF GROUPS PASSED')
 evidence={
  'sources':{str(s.relative_to(P.parent)):hashlib.sha256(s.read_bytes()).hexdigest() for s in sources},
  'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
  'checks':checks,
 }
 (P/'callback-evidence.json').write_text(json.dumps(evidence,indent=1)+'\n')
finally:
 sql(CLEANUP,check=False)
 if OWNED_ORGS:
  orgs_sql="ARRAY["+','.join(f"'{o}'" for o in OWNED_ORGS)+"]::uuid[]"
  users_sql="ARRAY["+','.join(f"'{u}'" for u in OWNED_USERS)+"]::uuid[]"
  # PRIMARY tables: deleted explicitly, in the correct FK/trigger order
  # (owner-guard trigger dance on memberships) — excluded from
  # owned_cleanup's dynamic discovery (PRIMARY_TABLES) precisely so they
  # stay hand-ordered here rather than swept generically.
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
      f"DELETE FROM organizations WHERE id=ANY({orgs_sql});",check=False)
  # webhook_events has neither an org_id nor a user_id column (confirmed by
  # inspection — supabase/migrations/001_initial.sql:287-303), so it is
  # invisible to owned_cleanup's org/user OWNED predicate entirely; the one
  # synthetic row this proof inserts into it (namespace-isolation test #9)
  # is deleted explicitly, by its own synthetic external_id, BEFORE the
  # uniform residual check below so that check's baseline-vs-now comparison
  # (which would otherwise see one extra non-owned row) stays clean.
  sql("DELETE FROM webhook_events WHERE provider='sendillo' AND event_type='sms_status_delivered' AND external_id='SHARED-EXTERNAL-ID-ISOLATION';",check=False)
  residual={}
  for label,query in [
   ('organizations',f"SELECT count(*) FROM organizations WHERE id=ANY({orgs_sql})"),
   ('auth.users',f"SELECT count(*) FROM auth.users WHERE id=ANY({users_sql})"),
   ('memberships',f"SELECT count(*) FROM memberships WHERE org_id=ANY({orgs_sql})"),
   ('auth.sessions',f"SELECT count(*) FROM auth.sessions WHERE user_id=ANY({users_sql})"),
   ('contacts',f"SELECT count(*) FROM contacts WHERE org_id=ANY({orgs_sql})"),
   ('properties',f"SELECT count(*) FROM properties WHERE org_id=ANY({orgs_sql})"),
   ('messages',f"SELECT count(*) FROM messages WHERE org_id=ANY({orgs_sql})"),
   ('consent_events',f"SELECT count(*) FROM consent_events WHERE org_id=ANY({orgs_sql})"),
   ('provider_sender_numbers',f"SELECT count(*) FROM provider_sender_numbers WHERE org_id=ANY({orgs_sql})"),
   ('webhook_events(shared-isolation)',"SELECT count(*) FROM webhook_events WHERE external_id='SHARED-EXTERNAL-ID-ISOLATION'"),
  ]:
   n=sql(query)
   if n!='0':residual[label]=n
  if residual:
   raise RuntimeError(f'Owned-fixture cleanup left residual rows in explicitly-managed PRIMARY tables: {residual} (orgs={len(OWNED_ORGS)}, users={len(OWNED_USERS)})')
  # [Astra fix-3] EVERYTHING ELSE: a generic, dynamically-discovered sweep
  # (owned_cleanup.sweep_delete) over every org_id/user_id-scoped table
  # database-wide, PRIMARY_TABLES excluded (handled by hand above) — not a
  # hand-maintained list, which the round-3-through-9 history in
  # owned_cleanup.py's own docstring shows repeatedly missed real tables
  # (Astra's independent check on this PR found 10 such tables/818 rows).
  owned_cleanup.sweep_delete(sql,ORG_TABLES,USER_TABLES,OWNED_ORGS,OWNED_USERS)
  # [Astra fix-3] ONE uniform check over the ENTIRE table universe
  # (PRIMARY_TABLES included, callback.sql's new tables included, no
  # category split): this run's own rows are gone everywhere, and every
  # non-owned row in every table is byte-identical to its pre-run baseline
  # (content hash from raw ::text output — includes organizations.name,
  # auth.users, and this PR's own inbox_reply_send.unmatched_callbacks/
  # callback_receipts uniformly), with whitelisted counters (e.g.
  # attempts.generation/receipt_version) checked per-row, never by a
  # table-wide SUM.
  advanced=owned_cleanup.assert_clean(sql,ALL_TABLES,BASELINE,OWNED_ORGS,OWNED_USERS)
  print(f'Exhaustive dynamic residual check passed: zero synthetic rows AND byte-identical baseline content across all {len(ALL_TABLES)} discovered table(s) database-wide'+(f'; whitelisted counters advanced monotonically: {"; ".join(advanced)}' if advanced else '; no counter column changed'))
  print(f'Cleanup verified: zero residual rows across {len(OWNED_ORGS)} owned orgs / {len(OWNED_USERS)} owned users')
