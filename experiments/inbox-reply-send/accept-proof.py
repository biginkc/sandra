#!/usr/bin/env python3
"""Lane 1 PR-E mutation-first proof for accept()/recover()/operation_status()
+ the durable dispatch_outbox. Owned fixture only; installs its own schemas
(committed, not rollback-only, since some proofs use two real connections)
and drops them all in a finally block — mirrors inbox-reply-send/concurrency.py's
idiom (sql/start/wait_for/finish, assert_body_matches scratch-install compare).
Every mutation below: install a broken candidate -> run the proof -> watch it
FAIL for the reason claimed -> restore the exact source definition (verified
byte-exact via assert_body_matches) -> re-run -> watch it PASS."""
import hashlib,json,re,subprocess,sys,time,uuid
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
CMD=D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1']
def need(v,label):
 if not v:raise RuntimeError(label)
def sql(q,timeout=20,check=True):
 # Every call is one round-trip/one implicit transaction; wrapping in an
 # explicit BEGIN...COMMIT lets SET LOCAL (role/jwt claims) work the same
 # way it would inside a real request's single transaction.
 r=subprocess.run(CMD,input="SET statement_timeout='15s'; SET lock_timeout='10s'; BEGIN;"+q.rstrip()+";COMMIT;",text=True,capture_output=True,timeout=timeout)
 if check:need(r.returncode==0,r.stderr)
 return r if not check else r.stdout.strip()
def sql_fail(q,timeout=20):
 """Run q expecting a non-zero exit; returns stderr (the error text)."""
 r=subprocess.run(CMD,input="SET statement_timeout='15s'; SET lock_timeout='10s'; BEGIN;"+q.rstrip()+";COMMIT;",text=True,capture_output=True,timeout=timeout)
 need(r.returncode!=0,f'expected failure but succeeded: {r.stdout}')
 return r.stderr
def start(q):
 p=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 p.stdin.write("SET statement_timeout='15s'; SET lock_timeout='10s';"+q);p.stdin.close();p.stdin=None;return p
def wait_for(query,label,deadline_s=6):
 deadline=time.monotonic()+deadline_s
 while time.monotonic()<deadline:
  if sql(query)=='t':return
  time.sleep(.05)
 raise RuntimeError(label)
def finish(proc,label,timeout=12,expect_ok=True):
 out,err=proc.communicate(timeout=timeout)
 if expect_ok:need(proc.returncode==0,f'{label}: {err}')
 else:need(proc.returncode!=0,f'{label}: expected failure but succeeded: {out}')
 return out.strip() if expect_ok else err

validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")=='t','Refusing existing reply schema')
CLEANUP="DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP FUNCTION IF EXISTS public.inbox_accept_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_recover_reply(uuid,uuid);DROP FUNCTION IF EXISTS public.inbox_reply_operation_status(uuid);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;DROP SCHEMA IF EXISTS inbox_reply_send_scratch CASCADE;"
sql(CLEANUP)

sources=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P.parent/'inbox-reply-review/setup.sql',P.parent/'inbox-reply-review/public-api.sql',P/'attempts.sql',P/'accept.sql',P/'public-api.sql']
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

def assert_sanitized(err,*phones):
 """Every conflict raise in accept.sql carries no DETAIL/HINT. Assert the
 raised text contains none of the given E.164 numbers, no generic E.164-shaped
 digit run, no raw Postgres 'DETAIL:'/'duplicate key value' phrasing (which
 would mean the bare ELSE RAISE; re-raise was hit instead of a sanitized
 branch), and no raw index/constraint name leaking internal schema."""
 need('DETAIL' not in err and 'duplicate key value' not in err,f'raised error carries raw constraint DETAIL (bare ELSE hit): {err}')
 for p in phones:
  need(p not in err,f'raised error text leaked phone number {p}: {err}')
 need(not re.search(r'\+1[0-9]{10}',err),f'raised error text contains an E.164-shaped digit run: {err}')

def make_org_and_prep(dest_prefix,n=1,extra_shared_dest=None):
 """Fresh org+user+session+n conversations (distinct destinations
 dest_prefix+00001.. ) -> frozen preparation covering all n, returns
 (org,user,key,prep_id,item_ids[],cids[])."""
 o=str(uuid.uuid4());u=str(uuid.uuid4());sess=str(uuid.uuid4());s=str(uuid.uuid4());k=str(uuid.uuid4())
 sql(f"INSERT INTO organizations(id,name) VALUES('{o}','PR-E proof {o}');"
     f"INSERT INTO auth.users(id,email) VALUES('{u}','{u}@example.invalid');"
     f"INSERT INTO memberships(org_id,user_id,role,access_status) VALUES('{o}','{u}','owner','active');"
     f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess}','{u}',clock_timestamp()+interval '1 hour');"
     f"INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES('{s}','{o}','sendillo','+18165550101','active');")
 cids=[]
 for i in range(1,n+1):
  cid=str(uuid.uuid4());pid=str(uuid.uuid4());ctid=str(uuid.uuid4());dest=dest_prefix+str(i).zfill(5)
  sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{ctid}','{o}','C{i}','{dest}','mobile');"
      f"INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o}','{ctid}','sms','opt_in_confirmed','pr-e-proof');"
      f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{o}','Proof property {i}','MO','{ctid}');"
      f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o}','{cid}','{ctid}','{pid}','sms','inbound','received','hi','{dest}','+18165550101');")
  cids.append(cid)
 if extra_shared_dest is not None:
  # An extra conversation sharing cids[extra_shared_dest]'s contact/phone,
  # to exercise duplicateDestination.
  cid=str(uuid.uuid4())
  shared_ctid=sql(f"SELECT contact_id FROM messages WHERE conversation_id='{cids[extra_shared_dest]}'")
  shared_pid=sql(f"SELECT property_id FROM messages WHERE conversation_id='{cids[extra_shared_dest]}'")
  shared_dest=sql(f"SELECT to_address FROM messages WHERE conversation_id='{cids[extra_shared_dest]}'")
  sql(f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o}','{cid}','{shared_ctid}','{shared_pid}','sms','inbound','received','hi','{shared_dest}','+18165550101');")
  cids.append(cid)
 targets=json.dumps([{'kind':'conversation','id':c} for c in cids])
 sql("UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;")
 capture=json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{json.dumps({'sub':u,'role':'authenticated','session_id':sess,'exp':4102444800})}'; SELECT public.inbox_capture_reply_recipients(ARRAY[{','.join(chr(39)+c+chr(39) for c in cids)}]::uuid[])::text;"))
 drafts=[]
 for item in capture['items']:
  drafts.append({'conversationId':item['conversation_id'],'body':'Hi there','dependencies':item['dependencies'],'exclusion':None})
 payload=json.dumps({'targets':json.loads(targets),'drafts':drafts,'template':'Hi there'})
 payload_sql=payload.replace("'","''")
 freeze=json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{json.dumps({'sub':u,'role':'authenticated','session_id':sess,'exp':4102444800})}'; SELECT public.inbox_freeze_reply_review('{payload_sql}','{k}')::text;"))
 prep_id=freeze['preparationId']
 items=json.loads(sql(f"SELECT items::text FROM inbox_reply_review.preparations WHERE id='{prep_id}'"))
 item_ids=[it['id'] for it in items if it['exclusion'] is None]
 SESS[u]=sess
 return o,u,k,prep_id,item_ids,cids

SESS={}
def authed(u,body):
 """Set request.jwt.claims for u's session (recorded by make_org_and_prep,
 or registered directly via SESS[u]=sess) WITHOUT switching role — these
 calls target inbox_reply_send.* private functions directly (as PR-D's own
 run.py/concurrency.py call claim()/start_dispatch() directly), which are
 REVOKEd from authenticated/PUBLIC and only reachable as the postgres owner
 or through the public.* SECURITY DEFINER wrappers. inbox_action_api.authorize()
 reads request.jwt.claims regardless of role."""
 need(u in SESS,f'no recorded session for user {u}')
 claims=json.dumps({'sub':u,'role':'authenticated','session_id':SESS[u],'exp':4102444800})
 return f"SET LOCAL request.jwt.claims='{claims}'; {body}"

def call_accept(o,u,k,prep_id,expect_ok=True):
 q=authed(u,f"SELECT inbox_reply_send.accept('{o}','{u}','{k}','{prep_id}')::text;")
 return sql(q) if expect_ok else sql_fail(q)

def counts(o):
 ops=int(sql(f"SELECT count(*) FROM inbox_reply_send.operations WHERE org_id='{o}'"))
 atts=int(sql(f"SELECT count(*) FROM inbox_reply_send.attempts a JOIN inbox_reply_send.operations op ON op.org_id=a.org_id AND op.id=a.operation_id WHERE a.org_id='{o}'"))
 outbox=int(sql(f"SELECT count(*) FROM inbox_reply_send.dispatch_outbox WHERE org_id='{o}'"))
 return ops,atts,outbox

try:
 sql(''.join(s.read_text() for s in sources))
 # Pin quiet_hours to always-open for this proof run only (same idiom as
 # run.py/concurrency.py): the whole inbox_reply_preparation schema is
 # dropped in the finally block below, so this override never persists.
 sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;")
 print('Installed accept.sql + public-api.sql on top of attempts.sql')

 # === 0. Verify the two AUTO-GENERATED constraint names accept.sql's
 # exception-mapping block branches on. These are the ONLY two names in that
 # block not taken verbatim from a CREATE UNIQUE INDEX in attempts.sql (which
 # already fixes the index name explicitly) — if Postgres ever generated a
 # different default name for operations' two UNIQUE(...) clauses, that
 # 23505 would fall to the bare ELSE RAISE; and leak the raw constraint
 # detail (including the phone number, for a destination-adjacent index).
 # Query pg_constraint directly rather than trust the hardcoded literals.
 real_prep_key_constraint=sql("SELECT conname FROM pg_constraint WHERE conrelid='inbox_reply_send.operations'::regclass AND pg_get_constraintdef(oid)='UNIQUE (org_id, preparation_id)'")
 real_idem_key_constraint=sql("SELECT conname FROM pg_constraint WHERE conrelid='inbox_reply_send.operations'::regclass AND pg_get_constraintdef(oid)='UNIQUE (org_id, requester_id, idempotency_key)'")
 need(real_prep_key_constraint=='operations_org_id_preparation_id_key',f"accept.sql's exception block assumes constraint name 'operations_org_id_preparation_id_key' but pg_constraint reports '{real_prep_key_constraint}' — the ELSE RAISE; bare re-raise would leak the raw 23505 detail for this conflict")
 need(real_idem_key_constraint=='operations_org_id_requester_id_idempotency_key_key',f"accept.sql's exception block assumes constraint name 'operations_org_id_requester_id_idempotency_key_key' but pg_constraint reports '{real_idem_key_constraint}' — the ELSE RAISE; bare re-raise would leak the raw 23505 detail for this conflict")
 record(f'constraint-name ground truth: pg_constraint confirms operations UNIQUE(org_id,preparation_id)={real_prep_key_constraint!r} and UNIQUE(org_id,requester_id,idempotency_key)={real_idem_key_constraint!r} match accept.sql\'s exception-mapping literals exactly')

 # === 1. Happy path: eligible set -> operations + N attempts + 1 outbox row ===
 o,u,k,prep_id,item_ids,cids=make_org_and_prep('+140255',n=3)
 result=json.loads(call_accept(o,u,k,prep_id))
 op_id=result['operation_id']
 need(result['preparation_id']==prep_id,'accept returned wrong preparation_id')
 ops,atts,outbox=counts(o)
 need(ops==1 and atts==3 and outbox==1,f'happy path counts wrong: ops={ops} atts={atts} outbox={outbox}')
 need(sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id='{o}' AND operation_id='{op_id}' AND state='approved'")=='3','attempts not all approved')
 record('accept happy path: 1 operation, 3 attempts (approved), 1 outbox row')

 # === 2. Idempotent replay: same (requester,key,preparation) twice -> same op, no new rows ===
 result2=json.loads(call_accept(o,u,k,prep_id))
 need(result2['operation_id']==op_id,'replay returned a different operation_id')
 ops2,atts2,outbox2=counts(o)
 need((ops2,atts2,outbox2)==(1,3,1),f'replay inserted new rows: {(ops2,atts2,outbox2)}')
 record('idempotent replay: same operationId, zero new rows')
 # MUTATION: skip the step-3 pre-check entirely (force straight to insert).
 restore_fn('inbox_reply_send.accept')
 mutant=real_fn('inbox_reply_send.accept').replace(
  "-- 3. Idempotent-replay resolution, before any insert.\n SELECT * INTO existing_op FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;\n IF FOUND THEN",
  "-- 3. MUTATED OUT for proof.\n SELECT * INTO existing_op FROM inbox_reply_send.operations WHERE org_id=o AND requester_id=requester AND idempotency_key=k;\n IF FALSE THEN")
 need(mutant!=real_fn('inbox_reply_send.accept'),'mutation string not found (source drifted)')
 sql(mutant)
 err=sql_fail(authed(u,f"SELECT inbox_reply_send.accept('{o}','{u}','{k}','{prep_id}')::text;"))
 need('INBOX_REPLY_PREPARATION_ACCEPTED' in err or '23505' in err or 'duplicate key' in err.lower(),f'mutant should have raised a constraint conflict on the second accept, got: {err}')
 record('MUTATION watched fail: skipping step-3 pre-check makes replay hit the operations unique-key race path instead of returning cleanly')
 restore_and_verify('inbox_reply_send.accept')
 result3=json.loads(call_accept(o,u,k,prep_id))
 need(result3['operation_id']==op_id,'restored accept() replay broken')
 record('RESTORED and re-verified byte-exact against source; replay passes again')

 # === 3. Key reuse: same key, different preparation -> INBOX_REPLY_KEY_REUSED ===
 # Step 3's "different preparation" branch fires when an operation ALREADY
 # exists for (org,requester,key) and a caller now names a DIFFERENT
 # preparation under that same key — reachable only after a real prior
 # accept, never via freeze() alone (freeze() itself won't produce two
 # preparation rows sharing one request_key for one requester).
 o2,u2,k2,prep_id2,_,_=make_org_and_prep('+141255',n=1)
 call_accept(o2,u2,k2,prep_id2)
 cid=str(uuid.uuid4());pid=str(uuid.uuid4());ctid=str(uuid.uuid4());dest='+141255' + '00002'
 sql(f"INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES('{ctid}','{o2}','C2','{dest}','mobile');"
     f"INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES('{o2}','{ctid}','sms','opt_in_confirmed','pr-e-proof');"
     f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pid}','{o2}','Proof property 2','MO','{ctid}');"
     f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{o2}','{cid}','{ctid}','{pid}','sms','inbound','received','hi','{dest}','+18165550101');")
 capture2=json.loads(sql(authed(u2,f"SELECT public.inbox_capture_reply_recipients(ARRAY['{cid}']::uuid[])::text;")))
 draft2=[{'conversationId':capture2['items'][0]['conversation_id'],'body':'Hi there 2','dependencies':capture2['items'][0]['dependencies'],'exclusion':None}]
 payload2=json.dumps({'targets':[{'kind':'conversation','id':cid}],'drafts':draft2,'template':'Hi there 2'}).replace("'","''")
 freeze2=json.loads(sql(authed(u2,f"SELECT public.inbox_freeze_reply_review('{payload2}',gen_random_uuid())::text;")))
 err=sql_fail(authed(u2,f"SELECT inbox_reply_send.accept('{o2}','{u2}','{k2}','{freeze2['preparationId']}')::text;"))
 need('INBOX_REPLY_KEY_REUSED' in err,f'expected INBOX_REPLY_KEY_REUSED, got: {err}')
 assert_sanitized(err,dest)
 record('key reuse (same key, different preparation, an operation already exists under it) -> INBOX_REPLY_KEY_REUSED, distinct from idempotent replay, sanitized')

 # === 4. operations UNIQUE(org_id,preparation_id) exception-mapping ===
 # Step 4's binding check (request_key must equal the caller's key) makes a
 # legitimate "same preparation, different caller-supplied key" call
 # unreachable through accept() itself — a preparation's key is fixed at
 # freeze time, so there is exactly one key that ever passes step 4 for it.
 # This constraint is therefore a defense-in-depth backstop (the only way to
 # hit it for real is the SAME (requester,key) racing itself, already
 # covered by the concurrency same-key-replay-after-commit proof below).
 # Prove the exception-mapping branch itself directly: pre-insert a second
 # operations row against the SAME preparation under a DIFFERENT key
 # (modeling that backstop scenario) and confirm accept()'s own insert,
 # called with the preparation's REAL (matching) key so it clears step 4,
 # still detects and rejects the conflict via INBOX_REPLY_PREPARATION_ACCEPTED
 # rather than creating a duplicate operation.
 o3,u3,k3,prep_id3,_,_=make_org_and_prep('+142255',n=1)
 rogue_key=str(uuid.uuid4())
 sql(f"INSERT INTO inbox_reply_send.operations(org_id,requester_id,preparation_id,idempotency_key) VALUES('{o3}','{u3}','{prep_id3}','{rogue_key}');")
 err=sql_fail(authed(u3,f"SELECT inbox_reply_send.accept('{o3}','{u3}','{k3}','{prep_id3}')::text;"))
 need('INBOX_REPLY_PREPARATION_ACCEPTED' in err,f'expected INBOX_REPLY_PREPARATION_ACCEPTED, got: {err}')
 dest3=sql(f"SELECT from_address FROM messages WHERE org_id='{o3}' LIMIT 1")
 assert_sanitized(err,dest3)
 ops3,atts3,outbox3=counts(o3)
 need((ops3,atts3,outbox3)==(1,0,0),'accept should not have created any rows on top of the pre-existing rogue operation')
 record('operations UNIQUE(org_id,preparation_id) conflict -> INBOX_REPLY_PREPARATION_ACCEPTED, zero extra rows, sanitized (proves the real constraint name, not the bare ELSE)')

 # === 5. Expiry ===
 o4,u4,k4,prep_id4,_,_=make_org_and_prep('+143255',n=1)
 sql(f"UPDATE inbox_reply_review.preparations SET expires_at=clock_timestamp()-interval '1 minute' WHERE id='{prep_id4}';",check=False)
 # preparations is immutable via trigger for non-owner roles; as postgres
 # (table owner) the trigger's RAISE still fires unconditionally (it has no
 # owner exemption), so directly UPDATE via disabling the trigger for this
 # one proof statement instead — the safe, standard "force test data past an
 # immutability trigger" idiom, not a change to accept()'s own logic.
 sql(f"ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;"
     f"UPDATE inbox_reply_review.preparations SET expires_at=clock_timestamp()-interval '1 minute' WHERE id='{prep_id4}';"
     f"ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;")
 err=sql_fail(authed(u4,f"SELECT inbox_reply_send.accept('{o4}','{u4}','{k4}','{prep_id4}')::text;"))
 need('INBOX_REPLY_PREPARATION_EXPIRED' in err,f'expected INBOX_REPLY_PREPARATION_EXPIRED, got: {err}')
 dest4=sql(f"SELECT from_address FROM messages WHERE org_id='{o4}' LIMIT 1")
 assert_sanitized(err,dest4)
 ops4,atts4,outbox4=counts(o4)
 need((ops4,atts4,outbox4)==(0,0,0),'expired accept created rows')
 record('expired preparation -> INBOX_REPLY_PREPARATION_EXPIRED, zero rows, sanitized')

 # === 6. Subtractive E4: a frozen-eligible item now suppressed is DROPPED; a
 # frozen-EXCLUDED item is NEVER revived ===
 o5,u5,k5,prep_id5,item_ids5,cids5=make_org_and_prep('+144255',n=2)
 # Suppress item 2's sender status post-freeze so item_current() now returns
 # 'sender_unavailable' for it (a real, canonical suppression source — not a
 # frozen-field edit).
 sql(f"UPDATE provider_sender_numbers SET status='inactive' WHERE org_id='{o5}';")
 result5=json.loads(call_accept(o5,u5,k5,prep_id5))
 ops5,atts5,outbox5=counts(o5)
 need(atts5==0,f'expected 0 attempts (both items share the now-suspended sender), got {atts5}')
 need(ops5==1 and outbox5==1,'operation/outbox should still be created for a batch that drops to zero eligible items')
 record('subtractive E4: a now-ineligible item is dropped from the attempt set (fresh item_current recheck), operation still created with zero attempts')
 sql(f"UPDATE provider_sender_numbers SET status='active' WHERE org_id='{o5}';")
 # MUTATION: make the E4 recheck a no-op (always eligible) -> watch the
 # now-suppressed item get an attempt anyway.
 restore_fn('inbox_reply_send.accept')
 mutant=real_fn('inbox_reply_send.accept').replace(
  "  ev:=inbox_reply_send.item_current(o,raw_item);\n  IF ev IS NOT NULL THEN CONTINUE;END IF;\n",
  "  ev:=NULL; -- MUTATED for proof: E4 recheck disabled\n")
 need(mutant!=real_fn('inbox_reply_send.accept'),'E4 mutation string not found (source drifted)')
 sql(mutant)
 o5b,u5b,k5b,prep_id5b,item_ids5b,cids5b=make_org_and_prep('+145255',n=2)
 sql(f"UPDATE provider_sender_numbers SET status='inactive' WHERE org_id='{o5b}';")
 result5b=json.loads(call_accept(o5b,u5b,k5b,prep_id5b))
 ops5b,atts5b,outbox5b=counts(o5b)
 need(atts5b==2,f'mutant should have let both now-ineligible items through, got {atts5b} attempts')
 record('MUTATION watched fail: disabling the E4 recheck lets a now-ineligible (sender-suspended) item get an attempt')
 restore_and_verify('inbox_reply_send.accept')
 sql(f"UPDATE provider_sender_numbers SET status='active' WHERE org_id='{o5b}';")
 record('RESTORED and re-verified byte-exact against source')

 # === 7. 50-cap ===
 o6,u6,k6,prep_id6,item_ids6,cids6=make_org_and_prep('+146255',n=51)
 err=sql_fail(authed(u6,f"SELECT inbox_reply_send.accept('{o6}','{u6}','{k6}','{prep_id6}')::text;"))
 need('INBOX_REPLY_RECIPIENT_LIMIT' in err,f'expected INBOX_REPLY_RECIPIENT_LIMIT, got: {err}')
 assert_sanitized(err)
 ops6,atts6,outbox6=counts(o6)
 need((ops6,atts6,outbox6)==(0,0,0),'over-cap accept created rows')
 record('51 eligible recipients -> INBOX_REPLY_RECIPIENT_LIMIT, zero rows created')

 # === 8. Atomic rollback of a partial batch + sanitized 23505s (Astra #1/#2) ===
 # Use the real mechanism to create a blocker: accept a FIRST single-item
 # preparation for one of the batch's own destinations under a fresh key,
 # THEN attempt the full 3-item batch — the live attempt from the first
 # accept collides with the destination guard for exactly one item.
 o7,u7,k7,prep_id7,item_ids7,cids7=make_org_and_prep('+147255',n=3)
 dest7_1=sql(f"SELECT from_address FROM messages WHERE conversation_id='{cids7[1]}'")
 cid_solo=cids7[1]
 draft_dest=dest7_1
 capture7=json.loads(sql(authed(u7,f"SELECT public.inbox_capture_reply_recipients(ARRAY['{cid_solo}']::uuid[])::text;")))
 draft7=[{'conversationId':cid_solo,'body':'Solo blocker','dependencies':capture7['items'][0]['dependencies'],'exclusion':None}]
 payload7=json.dumps({'targets':[{'kind':'conversation','id':cid_solo}],'drafts':draft7,'template':'Solo blocker'}).replace("'","''")
 k7_solo=str(uuid.uuid4())
 freeze7=json.loads(sql(authed(u7,f"SELECT public.inbox_freeze_reply_review('{payload7}','{k7_solo}')::text;")))
 call_accept(o7,u7,k7_solo,freeze7['preparationId'])
 need(sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id='{o7}' AND to_e164='{draft_dest}' AND state='approved'")=='1','blocker attempt not live')
 # Now accept the ORIGINAL 3-item batch (freeze predates the blocker accept,
 # still valid): item cids7[1]'s destination collides -> the WHOLE batch
 # must roll back to zero NEW rows (the 1 pre-existing blocker row/op is
 # untouched, but nothing from THIS accept call persists).
 ops_before,atts_before,outbox_before=counts(o7)
 err=sql_fail(authed(u7,f"SELECT inbox_reply_send.accept('{o7}','{u7}','{k7}','{prep_id7}')::text;"))
 need('INBOX_REPLY_DESTINATION_IN_PROGRESS' in err,f'expected INBOX_REPLY_DESTINATION_IN_PROGRESS, got: {err}')
 assert_sanitized(err,draft_dest,*[sql(f"SELECT from_address FROM messages WHERE conversation_id='{c}'") for c in cids7])
 ops_after,atts_after,outbox_after=counts(o7)
 need((ops_after,atts_after,outbox_after)==(ops_before,atts_before,outbox_before),f'a colliding batch left extra rows: before={(ops_before,atts_before,outbox_before)} after={(ops_after,atts_after,outbox_after)}')
 record('concurrent-destination collision -> INBOX_REPLY_DESTINATION_IN_PROGRESS, ZERO new rows from the colliding batch (atomic), no phone number in the error text')

 # MUTATION: break atomicity — insert attempts one row at a time, swallowing
 # a destination-guard 23505 per row instead of letting it abort the whole
 # batch — to prove the non-atomic shape WOULD leave a partial batch behind.
 restore_fn('inbox_reply_send.accept')
 real_body=real_fn('inbox_reply_send.accept')
 needle="  IF eligible_count>0 THEN\n   INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)\n    SELECT o,op_id,preparation_id,(x->>'item_id')::uuid,1,(x->>'contact_id')::uuid,x->>'from_e164',x->>'to_e164',\n     inbox_reply_send.body_hash(x->>'rendered_body',x->>'from_e164',x->>'to_e164'),'approved'\n    FROM jsonb_array_elements(eligible) x;\n  END IF;\n"
 need(needle in real_body,'atomicity mutation anchor not found (source drifted)')
 mutant_insert="  IF eligible_count>0 THEN\n   FOR raw_item IN SELECT value FROM jsonb_array_elements(eligible) LOOP\n    BEGIN\n     INSERT INTO inbox_reply_send.attempts(org_id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)\n      VALUES(o,op_id,preparation_id,(raw_item->>'item_id')::uuid,1,(raw_item->>'contact_id')::uuid,raw_item->>'from_e164',raw_item->>'to_e164',inbox_reply_send.body_hash(raw_item->>'rendered_body',raw_item->>'from_e164',raw_item->>'to_e164'),'approved');\n    EXCEPTION WHEN unique_violation THEN NULL; -- MUTATED for proof: swallow per-row, breaking atomicity\n    END;\n   END LOOP;\n  END IF;\n"
 mutant=real_body.replace(needle,mutant_insert)
 need(mutant!=real_body,'atomicity mutation produced no change')
 sql(mutant)
 o8,u8,k8,prep_id8,item_ids8,cids8=make_org_and_prep('+148255',n=3)
 dest8_1=sql(f"SELECT from_address FROM messages WHERE conversation_id='{cids8[1]}'")
 sess8=str(uuid.uuid4())
 sql(f"INSERT INTO auth.sessions(id,user_id,not_after) VALUES('{sess8}','{u8}',clock_timestamp()+interval '1 hour');")
 claims8=json.dumps({'sub':u8,'role':'authenticated','session_id':sess8,'exp':4102444800})
 capture8=json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{claims8}'; SELECT public.inbox_capture_reply_recipients(ARRAY['{cids8[1]}']::uuid[])::text;"))
 draft8=[{'conversationId':cids8[1],'body':'Solo blocker 2','dependencies':capture8['items'][0]['dependencies'],'exclusion':None}]
 payload8=json.dumps({'targets':[{'kind':'conversation','id':cids8[1]}],'drafts':draft8,'template':'Solo blocker 2'}).replace("'","''")
 k8_solo=str(uuid.uuid4())
 freeze8=json.loads(sql(f"SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claims='{claims8}'; SELECT public.inbox_freeze_reply_review('{payload8}','{k8_solo}')::text;"))
 call_accept(o8,u8,k8_solo,freeze8['preparationId'])
 ops8_before,atts8_before,outbox8_before=counts(o8)
 # the mutant swallows the conflict per-row instead of raising, so the whole
 # call now SUCCEEDS with a partial attempt set (2 of 3 items) persisted.
 result8=json.loads(call_accept(o8,u8,k8,prep_id8))
 ops8_after,atts8_after,outbox8_after=counts(o8)
 need(atts8_after>atts8_before,f'mutant should have left a PARTIAL batch behind; before={atts8_before} after={atts8_after}')
 need(atts8_after-atts8_before==2,f'expected exactly 2 of 3 items to persist under the mutant, got {atts8_after-atts8_before}')
 record('MUTATION watched fail: per-row exception-swallowing insert lets a PARTIAL (2-of-3) batch persist instead of rolling back the whole accept')
 restore_and_verify('inbox_reply_send.accept')
 record('RESTORED and re-verified byte-exact against source')

 # === 9. recover() + operation_status() smoke (already integration-tested
 # via TS; this proves the SQL-level state machine and byte-exact source) ===
 o9,u9,k9,prep_id9,item_ids9,cids9=make_org_and_prep('+149255',n=1)
 pending=json.loads(sql(authed(u9,f"SELECT inbox_reply_send.recover('{o9}','{u9}','{k9}','{prep_id9}')::text;")))
 need(pending['state']=='prepared','recover() before accept should be prepared')
 call_accept(o9,u9,k9,prep_id9)
 accepted=json.loads(sql(authed(u9,f"SELECT inbox_reply_send.recover('{o9}','{u9}','{k9}','{prep_id9}')::text;")))
 need(accepted['state']=='accepted','recover() after accept should be accepted')
 op9=accepted['operation']['operationId']
 status9=json.loads(sql(f"SELECT inbox_reply_send.operation_status('{o9}','{op9}')::text;"))
 need(status9['dispatchComplete'] is False and len(status9['receipts'])==1 and status9['receipts'][0]['state']=='pending','operation_status shape wrong')
 record('recover(): prepared -> accepted transition; operation_status(): dispatchComplete=false with one pending receipt')

 # === 10. Concurrency (two real connections, observed lock-waits) ===
 # #10a: concurrent overlapping accepts for the SAME destination. Connection
 # A's accept() holds its inserted attempt row uncommitted while sleeping;
 # connection B's accept() for the same destination must block on the
 # destination-guard unique index, then lose once A commits.
 oA,uA,kA,prepA,_,_=make_org_and_prep('+150255',n=1)
 claimsA=json.dumps({'sub':uA,'role':'authenticated','session_id':SESS[uA],'exp':4102444800})
 wnameA='pr-e-writer-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wnameA}';BEGIN;SET LOCAL request.jwt.claims='{claimsA}';SELECT inbox_reply_send.accept('{oA}','{uA}','{kA}','{prepA}');SELECT pg_sleep(3);COMMIT;")
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wnameA}' AND wait_event='PgSleep')",'#10a writer did not reach pg_sleep (attempt not yet held uncommitted)')
 destA=sql(f"SELECT from_address FROM messages m JOIN inbox_reply_review.preparations p ON p.org_id=m.org_id WHERE p.id='{prepA}' LIMIT 1")
 # A second preparation for the SAME org/user targeting the SAME destination
 # (a fresh conversation whose contact shares oA's contact's phone) — built
 # while A is mid-flight, so its freeze() sees the canonical state before
 # A's still-uncommitted accept.
 cidB=str(uuid.uuid4());pidB=str(uuid.uuid4())
 ctidA=sql(f"SELECT contact_id FROM messages m JOIN inbox_reply_review.preparations p ON p.org_id=m.org_id WHERE p.id='{prepA}' LIMIT 1")
 sql(f"INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES('{pidB}','{oA}','Proof property B','MO','{ctidA}');"
     f"INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),'{oA}','{cidB}','{ctidA}','{pidB}','sms','inbound','received','hi','{destA}','+18165550101');")
 captureB=json.loads(sql(authed(uA,f"SELECT public.inbox_capture_reply_recipients(ARRAY['{cidB}']::uuid[])::text;")))
 draftB=[{'conversationId':cidB,'body':'Race B','dependencies':captureB['items'][0]['dependencies'],'exclusion':None}]
 payloadB=json.dumps({'targets':[{'kind':'conversation','id':cidB}],'drafts':draftB,'template':'Race B'}).replace("'","''")
 kB=str(uuid.uuid4())
 freezeB=json.loads(sql(authed(uA,f"SELECT public.inbox_freeze_reply_review('{payloadB}','{kB}')::text;")))
 rnameB='pr-e-reader-'+str(uuid.uuid4())
 reader=start(f"SET application_name='{rnameB}';BEGIN;SET LOCAL request.jwt.claims='{claimsA}';SELECT inbox_reply_send.accept('{oA}','{uA}','{kB}','{freezeB['preparationId']}');COMMIT;")
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rnameB}' AND wait_event_type='Lock')",'#10a reader did not block on the destination-guard lock-wait')
 finish(writer,'#10a writer (A) should commit cleanly')
 err10a=finish(reader,'#10a reader (B)',expect_ok=False)
 need('INBOX_REPLY_DESTINATION_IN_PROGRESS' in err10a,f'#10a expected INBOX_REPLY_DESTINATION_IN_PROGRESS after A committed, got: {err10a}')
 assert_sanitized(err10a,destA)
 opsA,attsA,outboxA=counts(oA)
 need((opsA,attsA,outboxA)==(1,1,1),f'#10a loser B should have created ZERO rows: {(opsA,attsA,outboxA)}')
 record('concurrency #10a: two real connections race the SAME destination — B genuinely blocks on the lock (observed via pg_stat_activity), then loses with INBOX_REPLY_DESTINATION_IN_PROGRESS once A commits; B creates zero rows')

 # #10b: same-key replay AFTER a real commit on another connection (models a
 # client retry after a dropped response) -> same operationId, no second op.
 oC,uC,kC,prepC,_,_=make_org_and_prep('+151255',n=1)
 result10b_1=json.loads(call_accept(oC,uC,kC,prepC))
 result10b_2=json.loads(call_accept(oC,uC,kC,prepC))
 need(result10b_1['operation_id']==result10b_2['operation_id'],'#10b replay after commit on a fresh connection returned a different operationId')
 opsC,attsC,outboxC=counts(oC)
 need((opsC,attsC,outboxC)==(1,1,1),'#10b replay created extra rows')
 record('concurrency #10b: same-key replay on a FRESH connection after the first accept already committed -> identical operationId, zero new rows')

 # #10c: disjoint accepts, two real connections, DIFFERENT destinations in
 # the SAME org -> both must commit; the destination guard must never
 # false-positive across unrelated destinations (Astra #1).
 oD,uD,_,_,_,cidsD=make_org_and_prep('+152255',n=2)
 claimsD=json.dumps({'sub':uD,'role':'authenticated','session_id':SESS[uD],'exp':4102444800})
 solo_prep_ids=[]
 for idx,cid in enumerate(cidsD):
  captureX=json.loads(sql(authed(uD,f"SELECT public.inbox_capture_reply_recipients(ARRAY['{cid}']::uuid[])::text;")))
  draftX=[{'conversationId':cid,'body':f'Disjoint {idx}','dependencies':captureX['items'][0]['dependencies'],'exclusion':None}]
  payloadX=json.dumps({'targets':[{'kind':'conversation','id':cid}],'drafts':draftX,'template':f'Disjoint {idx}'}).replace("'","''")
  kX=str(uuid.uuid4())
  freezeX=json.loads(sql(authed(uD,f"SELECT public.inbox_freeze_reply_review('{payloadX}','{kX}')::text;")))
  solo_prep_ids.append((kX,freezeX['preparationId']))
 (kD1,prepD1),(kD2,prepD2)=solo_prep_ids
 wnameD1='pr-e-disjoint1-'+str(uuid.uuid4());wnameD2='pr-e-disjoint2-'+str(uuid.uuid4())
 connD1=start(f"SET application_name='{wnameD1}';BEGIN;SET LOCAL request.jwt.claims='{claimsD}';SELECT inbox_reply_send.accept('{oD}','{uD}','{kD1}','{prepD1}');SELECT pg_sleep(1);COMMIT;")
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wnameD1}' AND wait_event='PgSleep')",'#10c connection 1 did not reach pg_sleep')
 connD2=start(f"SET application_name='{wnameD2}';BEGIN;SET LOCAL request.jwt.claims='{claimsD}';SELECT inbox_reply_send.accept('{oD}','{uD}','{kD2}','{prepD2}');SELECT pg_sleep(1);COMMIT;")
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wnameD2}' AND wait_event='PgSleep')",'#10c connection 2 did not reach pg_sleep (should never block on connection 1 — disjoint destinations)')
 finish(connD1,'#10c connection 1 should commit cleanly')
 finish(connD2,'#10c connection 2 should commit cleanly (no false destination_guard collision)')
 opsD,attsD,outboxD=counts(oD)
 need((opsD,attsD,outboxD)==(2,2,2),f'#10c both disjoint accepts should have committed independently: {(opsD,attsD,outboxD)}')
 record('concurrency #10c: two real connections accept DIFFERENT destinations in the same org concurrently (both observed reaching pg_sleep simultaneously, i.e. neither blocked on the other) -> BOTH commit, 2 operations/2 attempts/2 outbox rows, no false destination_guard collision')

 # #10d: expiry after a REAL lock wait. Connection A holds provider_sender_numbers'
 # row FOR UPDATE (the same row item_current()'s canonical FOR SHARE reads);
 # while A holds it, the preparation's expires_at is set to just past "now";
 # connection B's accept() genuinely blocks on that row (observed via
 # pg_stat_activity), and only unblocks once A commits — by which point
 # expires_at has already lapsed. accept() must still reject with
 # INBOX_REPLY_PREPARATION_EXPIRED and create ZERO rows (R3-2/time-after-locks).
 oE,uE,kE,prepE,_,cidsE=make_org_and_prep('+153255',n=1)
 claimsE=json.dumps({'sub':uE,'role':'authenticated','session_id':SESS[uE],'exp':4102444800})
 wnameE='pr-e-expiry-lock-'+str(uuid.uuid4())
 connE=start(f"SET application_name='{wnameE}';BEGIN;SELECT * FROM public.provider_sender_numbers WHERE org_id='{oE}' AND provider='sendillo' FOR UPDATE;SELECT pg_sleep(3);COMMIT;")
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wnameE}' AND wait_event='PgSleep')",'#10d writer did not hold the sender row FOR UPDATE')
 sql(f"ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;"
     f"UPDATE inbox_reply_review.preparations SET expires_at=clock_timestamp()+interval '1.5 seconds' WHERE id='{prepE}';"
     f"ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;")
 rnameE='pr-e-expiry-reader-'+str(uuid.uuid4())
 readerE=start(f"SET application_name='{rnameE}';BEGIN;SET LOCAL request.jwt.claims='{claimsE}';SELECT inbox_reply_send.accept('{oE}','{uE}','{kE}','{prepE}');COMMIT;")
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rnameE}' AND wait_event_type='Lock')",'#10d reader did not genuinely block on the sender row lock')
 finish(connE,'#10d writer (A) should commit cleanly, releasing the sender row lock')
 errE=finish(readerE,'#10d reader (B)',expect_ok=False)
 need('INBOX_REPLY_PREPARATION_EXPIRED' in errE,f'#10d expected INBOX_REPLY_PREPARATION_EXPIRED after the lock-wait pushed past expires_at, got: {errE}')
 destE=sql(f"SELECT from_address FROM messages WHERE org_id='{oE}' LIMIT 1")
 assert_sanitized(errE,destE)
 opsE,attsE,outboxE=counts(oE)
 need((opsE,attsE,outboxE)==(0,0,0),f'#10d a lock-delayed accept past expiry must create ZERO rows: {(opsE,attsE,outboxE)}')
 record('concurrency #10d: a REAL lock wait (observed) on the sender row delays accept() past its preparation\'s expires_at -> still rejects with INBOX_REPLY_PREPARATION_EXPIRED (time-after-locks), zero rows, sanitized')

 for fn in ['inbox_reply_send.accept','inbox_reply_send.recover','inbox_reply_send.operation_status']:
  assert_body_matches(fn)
 record('final state: accept/recover/operation_status all byte-exact against accept.sql source')

 print(f'\nALL {len(checks)} PROOF GROUPS PASSED')
 evidence={
  'sources':{str(s.relative_to(P.parent)):hashlib.sha256(s.read_bytes()).hexdigest() for s in sources},
  'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
  'checks':checks,
 }
 (P/'accept-evidence.json').write_text(json.dumps(evidence,indent=1)+'\n')
finally:
 sql(CLEANUP,check=False)
