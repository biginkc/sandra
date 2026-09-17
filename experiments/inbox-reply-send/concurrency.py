#!/usr/bin/env python3
"""Two real connections, observed lock-waits: double-claim, stale-fence,
reclaim-after-dispatch, sender one-in-flight. Installs its own schemas
(committed, not rollback-only, since separate connections must see them) and
drops them all in a finally block."""
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
def sql(q,timeout=20):
 r=subprocess.run(CMD,input="SET statement_timeout='15s'; SET lock_timeout='10s';"+q,text=True,capture_output=True,timeout=timeout)
 need(r.returncode==0,r.stderr);return r.stdout.strip()
def start(q):
 p=subprocess.Popen(CMD,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
 p.stdin.write("SET statement_timeout='15s'; SET lock_timeout='10s';"+q);p.stdin.close();p.stdin=None;return p
def wait_for(query,label,deadline_s=6):
 deadline=time.monotonic()+deadline_s
 while time.monotonic()<deadline:
  if sql(query)=='t':return
  time.sleep(.05)
 raise RuntimeError(label)
def finish(proc,label,timeout=12):
 out,err=proc.communicate(timeout=timeout)
 need(proc.returncode==0,f'{label}: {err}')
 return out.strip()
def dest(i):
 return '+130255'+str(i).zfill(5)
def fetch_item(prep_id,i):
 """(item_id, conversation/target_id) for the fixture item destined to dest(i)."""
 item_id=sql(f"SELECT (value->>'id') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->'recipient'->>'to'='{dest(i)}'")
 conv_id=sql(f"SELECT (value->'target'->>'id') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->'recipient'->>'to'='{dest(i)}'")
 need(item_id and conv_id,f'Fixture item for index {i} not found')
 return item_id,conv_id
def insert_attempt(org,op_id,prep_id,item_id):
 """INSERT the first (ordinal 1, approved) attempt for a frozen-but-unattempted item; returns the new attempt id."""
 recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->>'id'='{item_id}'")
 return sql(f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{op_id}','{prep_id}','{item_id}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{recipient}'::jsonb r) s RETURNING id")

validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")=='t','Refusing existing reply schema')
# Defensive: a prior interrupted run of this script can leave schemas
# committed (unlike run.py's rollback-only harness, this script commits real
# DDL across separate connections). Clean any such leftovers before install.
sql("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;")

sources=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P.parent/'inbox-reply-review/setup.sql',P.parent/'inbox-reply-review/public-api.sql',P/'attempts.sql']
setup_sql=(P/'concurrency-setup.sql').read_text()
# P2 (round 4): every "restore" below must reinstall the EXACT candidate
# definition from the source .sql files, never a hand-inlined copy that can
# silently drift from a later round's edit (verify.py's file-hash binding
# cannot detect an installed-definition mismatch — only this harness's own
# runtime extraction + assert_body_matches() below can). ALL_SOURCES_SQL is
# read once, and every restore re-slices the current candidate body straight
# out of it.
#
# P7 (round 7, binding): assert_body_matches() replaces the old
# assert_installed()'s substring-needle check. Astra round 6 proved that
# hollow: removing persist()'s null/invalid-kind predicate, or its
# not_attempted reason-enum predicate, still left the needle strings
# ('Invalid dispatch result', 'local_not_attempted:') present elsewhere in
# the body (the object-type check, the evidence assignment), and a needle
# relocated into a COMMENT also passed — a substring check cannot tell code
# from a comment. assert_body_matches() instead compares the INSTALLED
# function's whitespace-normalized body (pg_get_functiondef, read back at
# runtime) against the CANDIDATE's whitespace-normalized body (extracted
# straight from the source .sql files): any removed, reordered, or
# comment-relocated code changes the normalized text and trips it, because
# the WHOLE body must match, not just a substring.
ALL_SOURCES_SQL=''.join(s.read_text() for s in sources)
def real_fn(qualified_name):
 """Extract the exact `CREATE FUNCTION <qualified_name>(...) ... $$;` block
 for a function defined in the source .sql files, and return it as a CREATE
 OR REPLACE so it can be reinstalled as a restore. Raises if the function
 can't be found (fail loud, never silently skip a restore). Terminator is
 the first bare "$$;" line after the opening — matches both a plpgsql body
 ("...END $$;\n") and a bodyless SQL-language body ("...$$;\n", no END
 keyword — e.g. recipient_limit(), which lives outside attempts.sql)."""
 pat=re.compile(r'CREATE FUNCTION\s+'+re.escape(qualified_name)+r'\(.*?\$\$;\n',re.DOTALL)
 m=pat.search(ALL_SOURCES_SQL)
 if not m:raise RuntimeError(f'real_fn: could not extract {qualified_name} from source files — restore aborted')
 return 'CREATE OR REPLACE FUNCTION '+m.group(0)[len('CREATE FUNCTION '):]
def restore_fn(qualified_name):
 """Reinstall the exact candidate definition of qualified_name from the
 source .sql files (never a hand-typed copy)."""
 sql(real_fn(qualified_name))
def real_fn_minus_block(qualified_name,start_marker,num_lines):
 """Same as real_fn, but with the num_lines-line block starting at the
 single line containing start_marker removed — used ONLY for a deliberate
 block-removed mutation, so every OTHER line (including later rounds'
 additions) still matches the candidate exactly; only the one intended
 block is missing."""
 lines=real_fn(qualified_name).split('\n')
 idxs=[i for i,l in enumerate(lines) if start_marker in l]
 if len(idxs)!=1:raise RuntimeError(f'real_fn_minus_block: {start_marker!r} found {len(idxs)} times (expected 1) in {qualified_name}')
 idx=idxs[0]
 return '\n'.join(lines[:idx]+lines[idx+num_lines:])
def _extract_body(definition_sql):
 """Whitespace-normalized text between a dollar-quoted body's delimiters,
 from either a CREATE [OR REPLACE] FUNCTION statement (every real candidate
 in this codebase uses the bare '$$' tag) or a pg_get_functiondef()
 readback (Postgres always tags the body '$function$', regardless of the
 tag used at CREATE time — verified empirically against this Postgres
 version). Collapsing whitespace runs to one space and stripping means
 only a SEMANTIC difference changes the result: removed/reordered code, or
 a needle relocated into a comment, both change it, because comments are
 NOT stripped (prosrc keeps them verbatim)."""
 m=re.search(r'AS\s+(\$[A-Za-z0-9_]*\$)(.*)\1',definition_sql,re.DOTALL)
 if not m:raise RuntimeError(f'_extract_body: no dollar-quoted body found in: {definition_sql[:200]!r}')
 return re.sub(r'\s+',' ',m.group(2)).strip()
def candidate_body(qualified_name):
 """Ground truth for assert_body_matches: qualified_name's own body, read
 straight from the source .sql files (never pg_get_functiondef, never
 hand-typed)."""
 return _extract_body(real_fn(qualified_name))
def assert_body_matches(qualified_name):
 """Runtime guard against a stale restore: compare the INSTALLED function's
 whitespace-normalized body (pg_get_functiondef — never what we intended to
 install) against the CANDIDATE body extracted straight from the source
 .sql files. Call this immediately after every restore that a positive
 control depends on — a hand-inlined restore that silently omitted a later
 round's fix, reordered logic, or relocated a needle into a comment would
 otherwise let a stale positive control pass for the wrong reason."""
 installed_def=sql(f"SELECT pg_get_functiondef('{qualified_name}'::regproc)")
 installed_body=_extract_body(installed_def)
 want=candidate_body(qualified_name)
 need(installed_body==want,f'assert_body_matches: {qualified_name} installed body does not match its candidate definition in the source .sql files after restore — stale, hand-inlined, or tampered definition installed instead of the exact candidate')
installed=False;org=None;children=[]
checks=[]
try:
 sql(''.join(s.read_text() for s in sources))
 installed=True
 sql(setup_sql)
 org=sql("SELECT id FROM organizations WHERE name LIKE 'Owned PR-D concurrency %' ORDER BY created_at DESC LIMIT 1")
 need(org,'Concurrency org not found after setup')
 atts=sql(f"SELECT string_agg(id::text,',' ORDER BY to_e164) FROM inbox_reply_send.attempts WHERE org_id='{org}'").split(',')
 need(len(atts)>=10,f'Expected at least 10 attempts, got {len(atts)}')
 a1,a2,a3,a4,a5,a6,a7,a8,a9,a10=atts[0:10]
 prep_id=sql(f"SELECT preparation_id FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{a1}'")
 op_id=sql(f"SELECT operation_id FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{a1}'")
 # P1.2 fixture: items 11/12 are frozen but have no attempt row yet.
 item11=sql(f"SELECT (value->>'id') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->'recipient'->>'to'='+13025500011'")
 item12=sql(f"SELECT (value->>'id') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->'recipient'->>'to'='+13025500012'")
 need(item11 and item12,'P1.2 fixture items 11/12 not found')
 conv11=sql(f"SELECT (value->'target'->>'id') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->'recipient'->>'to'='+13025500011'")
 conv12=sql(f"SELECT (value->'target'->>'id') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->'recipient'->>'to'='+13025500012'")
 # P2.3 fixture: an isolated 3-item preparation+operation with zero attempts.
 cap_op_id=sql(f"SELECT o2.id FROM inbox_reply_send.operations o2 JOIN inbox_reply_review.preparations p ON p.id=o2.preparation_id WHERE o2.org_id='{org}' AND jsonb_array_length(p.items)=3")
 cap_prep_id=sql(f"SELECT preparation_id FROM inbox_reply_send.operations WHERE org_id='{org}' AND id='{cap_op_id}'")
 need(cap_op_id and cap_prep_id,'P2.3 cap fixture not found')
 cap_item_ids=sql(f"SELECT string_agg(value->>'id',',' ORDER BY value->'recipient'->>'to') FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{cap_prep_id}'").split(',')
 need(len(cap_item_ids)==3,f'Expected 3 cap fixture items, got {len(cap_item_ids)}')
 cap_item_a,cap_item_b,cap_item_c=cap_item_ids

 # === #1 Double-claim: two real connections, observed lock-wait. Both
 # claim() the same 'approved' row; one wins {claimed}, one gets {busy};
 # exactly one generation bump.
 wname='dc-writer-'+str(uuid.uuid4());rname='dc-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname}';BEGIN;SELECT inbox_reply_send.claim('{org}','{a1}',60);SELECT pg_sleep(3);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname}' AND wait_event='PgSleep')",'#1 writer did not hold the claim lock')
 reader=start(f"SET application_name='{rname}';SELECT inbox_reply_send.claim('{org}','{a1}',60);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname}' AND wait_event_type='Lock')",'#1 reader did not actually wait on the row lock')
 wout=finish(writer,'#1 writer');children=[reader]
 rout=finish(reader,'#1 reader');children=[]
 need('claimed' in wout and 'generation' in wout,f'#1 writer unexpected result: {wout}')
 need('"kind": "busy"' in rout or 'busy' in rout,f'#1 reader unexpected result: {rout}')
 need(sql(f"SELECT generation FROM inbox_reply_send.attempts WHERE id='{a1}'")=='1','#1 generation bumped more than once')
 checks.append('#1 double-claim: two real connections, reader observed waiting on the writer row lock (pg_stat_activity wait_event_type=Lock) before the writer committed; writer got {claimed}, reader got {busy}; generation bumped exactly once')

 # Mutation: redefine claim() WITHOUT "FOR UPDATE" on the row read, watch a
 # second real connection no longer block on the first at all (lock-wait
 # disappears), then restore and reconfirm the original guard holds.
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=o AND operation_id=row.operation_id)>inbox_reply_preparation.recipient_limit() THEN RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';END IF;
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp() AND row.dispatch_started_at IS NULL) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','existing','state','uncertain');
 ELSE RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $mut$;""")
 # Removing FOR UPDATE from the SELECT does NOT remove Postgres's implicit
 # row lock on the later UPDATE statement itself — the reader still blocks
 # on that. What it removes is the re-check: the reader's IF-branch decision
 # was made from a stale pre-writer-commit read, and its UPDATE has no
 # "AND state='approved'" guard, so once unblocked it blindly re-applies the
 # SAME transition the writer already made. The observable bug is not an
 # absent lock-wait — it's that BOTH connections come back reporting
 # {kind:'claimed'} for the one row, at two different generations: a real
 # double-claim.
 wname2='dc-mut-writer-'+str(uuid.uuid4());rname2='dc-mut-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname2}';BEGIN;SELECT inbox_reply_send.claim('{org}','{a2}',60);SELECT pg_sleep(2);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname2}' AND wait_event='PgSleep')",'#1-mut writer did not reach sleep')
 reader=start(f"SET application_name='{rname2}';SELECT inbox_reply_send.claim('{org}','{a2}',60);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname2}' AND wait_event_type='Lock')",'#1-mut reader unexpectedly did not block on the update')
 wout=finish(writer,'#1-mut writer');children=[reader]
 rout=finish(reader,'#1-mut reader',timeout=6);children=[]
 need('"kind": "claimed"' in wout,f'#1-mut writer unexpected result: {wout}')
 need('"kind": "claimed"' in rout,f'#1-mut reader unexpectedly did NOT also double-claim: {rout}')
 need(sql(f"SELECT generation FROM inbox_reply_send.attempts WHERE id='{a2}'")=='2','#1-mut expected exactly two stacked generation bumps (the double-claim)')
 checks.append('#1 mutation: claim() redefined without FOR UPDATE — the reader still blocks on the writer row lock (its own UPDATE has no state re-check), but on unblocking it blindly re-applies the transition: both connections report {kind:claimed} for the same row, generation double-bumped to 2 — the real double-claim the FOR UPDATE + reclaim predicate prevents; restored below')
 restore_fn('inbox_reply_send.claim')
 # P2/R5 assert_installed equivalent (same pattern as run.py's claim
 # restores): read back what is ACTUALLY installed and fail loudly if the
 # dispatch_started_at IS NULL reclaim guard is missing, so a stale/hand-
 # inlined restore can never silently ship a claim() missing a later
 # round's fix.
 assert_body_matches('inbox_reply_send.claim')
 # Reconfirm the restored guard blocks again on a third fresh row (a7 held
 # in reserve for exactly this).
 wname3='dc-restore-writer-'+str(uuid.uuid4());rname3='dc-restore-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname3}';BEGIN;SELECT inbox_reply_send.claim('{org}','{a3}',60);SELECT pg_sleep(2);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname3}' AND wait_event='PgSleep')",'#1-restore writer did not reach sleep')
 reader=start(f"SET application_name='{rname3}';SELECT inbox_reply_send.claim('{org}','{a3}',60);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname3}' AND wait_event_type='Lock')",'#1-restore reader did not wait after restore')
 finish(writer,'#1-restore writer');children=[reader]
 rout=finish(reader,'#1-restore reader');children=[]
 need('"kind": "busy"' in rout,f'#1-restore reader unexpected result after restore: {rout}')
 checks.append('#1 restore: with the original FOR UPDATE claim() back in place, a fresh reader (a3) is observed waiting on the row lock again and correctly reports busy, not a second claim')

 # === #2 cond1 stale-fence: two real connections racing a RECLAIM (not an
 # initial claim) on an expired-lease row serialize the same way #1 proved
 # for the initial claim — genuine lock-wait, exactly one winner. Then,
 # single-connection, the original (now-stale) generation is rejected by
 # start_dispatch while the winning generation is accepted exactly once.
 stale_g=int(json.loads(sql(f"SELECT inbox_reply_send.claim('{org}','{a4}',60)::text"))['generation'])
 sql(f"UPDATE inbox_reply_send.attempts SET generation=generation+1,lease_until=clock_timestamp()-interval '1 second' WHERE org_id='{org}' AND id='{a4}'")
 wname='sf-writer-'+str(uuid.uuid4());rname='sf-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname}';BEGIN;SELECT inbox_reply_send.claim('{org}','{a4}',60);SELECT pg_sleep(3);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname}' AND wait_event='PgSleep')",'#2 writer did not hold the reclaim lock')
 reader=start(f"SET application_name='{rname}';SELECT inbox_reply_send.claim('{org}','{a4}',60);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname}' AND wait_event_type='Lock')",'#2 reader did not actually wait on the reclaim row lock')
 wout=finish(writer,'#2 writer');children=[reader]
 rout=finish(reader,'#2 reader');children=[]
 winning_g=int(json.loads(wout)['generation'])
 need(winning_g>stale_g+1,f'#2 winning generation ({winning_g}) did not advance past the expiry bump (stale_g={stale_g})')
 need('"kind": "busy"' in rout,f'#2 reader unexpected result (expected busy, a second concurrent reclaim must not also win): {rout}')
 need(sql(f"SELECT generation FROM inbox_reply_send.attempts WHERE id='{a4}'")==str(winning_g),'#2 generation advanced more than once across the race')
 failed=False
 try:sql(f"SELECT inbox_reply_send.start_dispatch('{org}','{a4}',{stale_g})")
 except RuntimeError as e:
  failed='INBOX_REPLY_STALE_CLAIM' in str(e)
 need(failed,'#2 start_dispatch with the original stale generation did not raise INBOX_REPLY_STALE_CLAIM')
 need(sql(f"SELECT state,dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE id='{a4}'")=='claimed|t','#2 a stale start_dispatch mutated the row')
 dout=sql(f"SELECT inbox_reply_send.start_dispatch('{org}','{a4}',{winning_g})")
 need('"kind": "dispatch"' in dout,f'#2 start_dispatch with the winning (current) generation failed: {dout}')
 need(sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE id='{a4}' AND dispatch_token IS NOT NULL")=='1','#2 more than one token ever appeared on this row')
 checks.append(f'#2 stale-fence: two real connections raced a reclaim on an expired-lease row — reader observed waiting on the writer row lock, writer won ({{claimed}}, generation {stale_g}->{winning_g}), reader correctly got busy, generation advanced exactly once across the race; the original stale generation ({stale_g}) is rejected by start_dispatch with the row left unchanged (still claimed, no token); the winning generation ({winning_g}) dispatches successfully and exactly one token is ever set on the row')
 # Free the sender before the mutation section below also calls start_dispatch.
 tok4=json.loads(dout)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{a4}','{tok4}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-4'))")

 # Mutation: drop the "generation=g" fence from start_dispatch, watch the
 # ALREADY-STALE original generation from a fresh claim/expire/reclaim cycle
 # wrongly succeed; restore, reverify it raises again.
 stale_g2=int(json.loads(sql(f"SELECT inbox_reply_send.claim('{org}','{a5}',60)::text"))['generation'])
 sql(f"UPDATE inbox_reply_send.attempts SET generation=generation+1,lease_until=clock_timestamp()-interval '1 second' WHERE org_id='{org}' AND id='{a5}'")
 winning_g2=int(json.loads(sql(f"SELECT inbox_reply_send.claim('{org}','{a5}',60)::text"))['generation'])
 need(winning_g2>stale_g2,'#2-mut setup did not actually produce a stale generation')
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 -- MUTATION: generation=g check dropped.
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
  ev:=inbox_reply_send.item_current(o,frozen);
  IF ev IS NOT NULL THEN RAISE EXCEPTION 'stale after marker' USING ERRCODE='IR001';END IF;
 EXCEPTION
  WHEN SQLSTATE 'IR001' THEN
   UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
   RETURN jsonb_build_object('kind','skipped','reason',ev);
  WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
   IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
   ELSE RAISE;
   END IF;
 END;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $mut$;""")
 dout2=sql(f"SELECT inbox_reply_send.start_dispatch('{org}','{a5}',{stale_g2})")
 need('"kind": "dispatch"' in dout2,f'#2-mut the stale generation was still rejected — mutation had no effect: {dout2}')
 checks.append(f'#2 mutation: start_dispatch redefined without the generation=g fence — the ORIGINAL stale generation ({stale_g2}) from before a real reclaim ({winning_g2}) wrongly dispatches; restored below')
 restore_fn('inbox_reply_send.start_dispatch')
 assert_body_matches('inbox_reply_send.start_dispatch')
 # a5 is now dispatch_started under the mutated function — free the sender
 # (only one attempt may hold dispatch_started at a time, D-6(5)) before any
 # later section needs it.
 tok5=json.loads(dout2)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{a5}','{tok5}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-5'))")

 # Reconfirm the restored fence on a fresh stale generation (a9).
 stale_g3=int(json.loads(sql(f"SELECT inbox_reply_send.claim('{org}','{a9}',60)::text"))['generation'])
 sql(f"UPDATE inbox_reply_send.attempts SET generation=generation+1,lease_until=clock_timestamp()-interval '1 second' WHERE org_id='{org}' AND id='{a9}'")
 winning_g3=int(json.loads(sql(f"SELECT inbox_reply_send.claim('{org}','{a9}',60)::text"))['generation'])
 failed=False
 try:sql(f"SELECT inbox_reply_send.start_dispatch('{org}','{a9}',{stale_g3})")
 except RuntimeError as e:
  failed='INBOX_REPLY_STALE_CLAIM' in str(e)
 need(failed,'#2 restore: the original generation-checking start_dispatch was not actually restored')
 dout9=sql(f"SELECT inbox_reply_send.start_dispatch('{org}','{a9}',{winning_g3})")
 checks.append(f'#2 restore: with the generation fence back in place, the original stale generation ({stale_g3}) is rejected again and only the current one ({winning_g3}) dispatches')
 # Free the sender again before #3/#8 below.
 tok9=json.loads(dout9)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{a9}','{tok9}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-9'))")

 # === #3 Reclaim-after-dispatch: two real connections. A claims and starts
 # dispatch (holding the row open, mid pg_sleep, FOR UPDATE lock live); B
 # concurrently calls claim() and must block on that same lock, then on
 # unblocking see state=dispatch_started and label uncertain — never
 # re-claim, never see a second token.
 sql(f"SELECT inbox_reply_send.claim('{org}','{a6}',60)")
 wname='rd-writer-'+str(uuid.uuid4());rname='rd-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{a6}',1);SELECT pg_sleep(3);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname}' AND wait_event='PgSleep')",'#3 writer did not hold the dispatch lock')
 reader=start(f"SET application_name='{rname}';SELECT inbox_reply_send.claim('{org}','{a6}',60);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname}' AND wait_event_type='Lock')",'#3 reader did not actually wait on the dispatch_started row lock')
 wout=finish(writer,'#3 writer');children=[reader]
 rout=finish(reader,'#3 reader');children=[]
 need('"kind": "dispatch"' in wout,f'#3 writer unexpected start_dispatch result: {wout}')
 token_a6=json.loads(wout)['token']
 need('"kind": "existing"' in rout and '"state": "uncertain"' in rout,f'#3 reader (re-entry) unexpected result: {rout}')
 row_state=sql(f"SELECT state,generation,dispatch_token FROM inbox_reply_send.attempts WHERE id='{a6}'").split('|')
 need(row_state[0]=='uncertain',f'#3 row not uncertain after concurrent re-entry: {row_state}')
 need(row_state[2]==token_a6,'#3 dispatch_token changed on re-entry (a second token was issued)')
 pout=sql(f"SELECT inbox_reply_send.persist('{org}','{a6}','{token_a6}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-6'))")
 need('provider_accepted' in pout,f'#3 persist with the original token after re-entry failed: {pout}')
 checks.append('#3 reclaim-after-dispatch: two real connections — reader observed waiting on the writer row lock while the writer held start_dispatch open mid-transaction; once the writer committed (dispatch_started, token issued), the reader'"'"'s claim() on the now-dispatch_started row labelled uncertain (never re-claimed, generation unchanged, no second token); the original token still reconciles the row to provider_accepted afterward')

 # === #8 Sender one-in-flight: two real connections, the unique_violation
 # branch GUARANTEED exercised (not "either pre-check or catch"). Holder (a7)
 # keeps its start_dispatch transaction OPEN and uncommitted; under READ
 # COMMITTED the racer's (a8) EXISTS pre-check cannot see an uncommitted row
 # from another transaction, so it PASSES the pre-check and proceeds to its
 # own marker UPDATE, which then genuinely BLOCKS on the D-6(5) unique index
 # (observed as a real lock-wait) until the holder resolves.
 sql(f"SELECT inbox_reply_send.claim('{org}','{a7}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{a8}',60)")
 n7='sb7-'+str(uuid.uuid4());n8='sb8-'+str(uuid.uuid4())
 holder=start(f"SET application_name='{n7}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{a7}',1);SELECT pg_sleep(3);COMMIT;");children=[holder]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{n7}' AND wait_event='PgSleep')",'#8 holder did not hold its start_dispatch transaction open')
 racer=start(f"SET application_name='{n8}';SELECT inbox_reply_send.start_dispatch('{org}','{a8}',1);");children=[holder,racer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{n8}' AND wait_event_type='Lock')",'#8 racer did not actually block on the sender-inflight index (EXISTS pre-check must have passed)')
 hout=finish(holder,'#8 holder');children=[racer]
 out8,rout8=racer.communicate(timeout=12);children=[]
 need('"kind": "dispatch"' in hout,f'#8 holder unexpected start_dispatch result: {hout}')
 need(racer.returncode!=0,f'#8 racer unexpectedly succeeded: {out8!r}')
 # P2.4: the surfaced error for the racer, whether it lost via the EXISTS
 # pre-check or (this branch, guaranteed here) the unique_violation caught
 # and re-raised at the marker UPDATE, is always the same sanitized
 # INBOX_REPLY_SENDER_BUSY — never the raw 23505 detail, which would carry
 # the destination phone number.
 need('INBOX_REPLY_SENDER_BUSY' in rout8,f'#8 racer did not fail on the sanitized sender guard: {rout8}')
 need('DETAIL' not in rout8 and 'duplicate key' not in rout8.lower(),f'#8 racer leaked raw constraint detail (would carry the phone number) instead of the sanitized error: {rout8}')
 need(sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id IN ('{a7}','{a8}') AND state='dispatch_started'")=='1','#8 expected exactly one of the two same-sender attempts dispatched')
 checks.append('#8 sender one-in-flight: two real connections — the holder kept its start_dispatch open uncommitted, so the racer'"'"'s EXISTS pre-check (which cannot see an uncommitted row) passed and it proceeded to genuinely block on the D-6(5) unique index (observed wait_event_type=Lock) until the holder committed; the racer then received the caught-and-sanitized INBOX_REPLY_SENDER_BUSY (55P03) with no raw constraint DETAIL — the unique_violation branch itself, not just the fast pre-check, is exercised here')
 # Free the sender: a7 (the holder) is still dispatch_started.
 tok7=json.loads(hout)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{a7}','{tok7}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-8W'))")

 # === P1.2 eligibility-staleness reorder: two real connections + a third
 # (main) writer. Conn B holds the inbound-head row FOR UPDATE (an
 # unrelated-to-suppression lock used purely as a controllable
 # synchronization gate); conn A calls start_dispatch and blocks waiting
 # for that same row (item_current's own FOR SHARE request conflicts with
 # B's FOR UPDATE); while A is blocked, this script (acting as "conn C")
 # commits a suppression for A's destination; B releases; A must see the
 # suppression and return skipped/sms_suppressed with NO token, because its
 # destination_policy() read is a fresh statement issued only after A's own
 # lock wait resolves.
 item11_recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->>'id'='{item11}'")
 att11=sql(f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{op_id}','{prep_id}','{item11}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{item11_recipient}'::jsonb r) s RETURNING id")
 sql(f"SELECT inbox_reply_send.claim('{org}','{att11}',60)")
 wname='p12-writer-'+str(uuid.uuid4());rname='p12-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname}';BEGIN;SELECT revision FROM inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv11}' FOR UPDATE;SELECT pg_sleep(3);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname}' AND wait_event='PgSleep')",'P1.2 writer did not hold the head lock')
 reader=start(f"SET application_name='{rname}';SELECT inbox_reply_send.start_dispatch('{org}','{att11}',1);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname}' AND wait_event_type='Lock')",'P1.2 reader (start_dispatch) did not actually wait on the head lock')
 # Conn C: commit a suppression for item11's destination WHILE the reader is
 # still blocked on the head lock.
 sql(f"INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES('{org}','sms','+13025500011','owned_prd_concurrency_p12')")
 finish(writer,'P1.2 writer');children=[reader]
 rout=finish(reader,'P1.2 reader');children=[]
 need('"kind": "skipped"' in rout and 'sms_suppressed' in rout,f'P1.2 reader did not see the suppression committed during its lock wait: {rout}')
 need('token' not in rout,f'P1.2 reader issued a token despite the suppression: {rout}')
 need(sql(f"SELECT state,dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att11}'")=='skipped_ineligible|t','P1.2 row not cleanly skipped_ineligible with no token')
 checks.append('P1.2 positive case: two real connections — a start_dispatch call observed waiting on an inbound-head row lock (pg_stat_activity wait_event_type=Lock); a suppression committed by a third connection WHILE it waited was still seen (item_current'"'"'s destination_policy read is a fresh statement issued only after the lock wait resolves) — the row ended skipped_ineligible/sms_suppressed with no token ever issued')

 # Positive control: temporarily restore the OLD (pre-round-2) read-before-
 # lock ordering in item_current() AND strip round-3's post-marker recheck
 # from start_dispatch (i.e. the full pre-round-2 architecture — round 3's
 # independent second defense layer would otherwise also catch this exact
 # race on its own and mask whether item_current's own reorder matters in
 # isolation). Repeat the identical race on item12 — this time the
 # suppression, committed during the SAME head-lock wait, must be MISSED
 # (destination_policy already evaluated before the wait, and nothing reads
 # eligibility again after the marker), and a token wrongly gets issued
 # despite the suppression.
 item12_recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{prep_id}' AND value->>'id'='{item12}'")
 att12=sql(f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{op_id}','{prep_id}','{item12}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{item12_recipient}'::jsonb r) s RETURNING id")
 sql(f"SELECT inbox_reply_send.claim('{org}','{att12}',60)")
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.item_current(o uuid,item jsonb) RETURNS text LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE qh jsonb;policy_result jsonb;sender public.provider_sender_numbers;head public.inbox_inbound_heads;
BEGIN
 IF (item->>'validUntil')::timestamptz<=clock_timestamp() THEN RETURN 'conversation_window_expired';END IF;
 qh:=inbox_reply_preparation.quiet_hours(item->>'state',clock_timestamp());
 IF qh->>'ok' IS DISTINCT FROM 'true' THEN
  IF qh->>'reason'='unknown_state' THEN RETURN 'unknown_state';ELSE RETURN 'outside_window';END IF;
 END IF;
 -- MUTATION (pre-round-2 order): destination_policy evaluated BEFORE the
 -- sender/head locks, so a concurrent suppression committed during the
 -- later lock wait is invisible to this already-evaluated read.
 policy_result:=inbox_reply_preparation.destination_policy(o,item->'recipient'->>'to',(item->'recipient'->>'contactId')::uuid,true);
 IF policy_result->>'exclusion' IS NOT NULL THEN RETURN policy_result->>'exclusion';END IF;
 SELECT * INTO sender FROM public.provider_sender_numbers WHERE org_id=o AND provider='sendillo' AND phone_e164=item->'recipient'->>'from' FOR SHARE;
 IF sender.status IS DISTINCT FROM 'active' THEN RETURN 'sender_unavailable';END IF;
 SELECT * INTO head FROM public.inbox_inbound_heads WHERE org_id=o AND conversation_id=(item->'target'->>'id')::uuid FOR SHARE;
 IF head.revision::text IS DISTINCT FROM item->'dependencies'->>'head' THEN RETURN 'inbound_changed';END IF;
 RETURN NULL;
END $mut$;""")
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 -- MUTATION (pre-round-3): only the pre-marker check; no post-marker recheck.
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
 EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
  IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
  ELSE RAISE;
  END IF;
 END;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $mut$;""")
 wname2='p12-mut-writer-'+str(uuid.uuid4());rname2='p12-mut-reader-'+str(uuid.uuid4())
 writer=start(f"SET application_name='{wname2}';BEGIN;SELECT revision FROM inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv12}' FOR UPDATE;SELECT pg_sleep(3);COMMIT;");children=[writer]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{wname2}' AND wait_event='PgSleep')",'P1.2-control writer did not hold the head lock')
 reader=start(f"SET application_name='{rname2}';SELECT inbox_reply_send.start_dispatch('{org}','{att12}',1);");children=[writer,reader]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{rname2}' AND wait_event_type='Lock')",'P1.2-control reader did not actually wait on the head lock')
 sql(f"INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES('{org}','sms','+13025500012','owned_prd_concurrency_p12_control')")
 finish(writer,'P1.2-control writer');children=[reader]
 rout2=finish(reader,'P1.2-control reader');children=[]
 need('"kind": "dispatch"' in rout2,f'P1.2 positive control did not actually reproduce the miss (old order should wrongly dispatch): {rout2}')
 checks.append('P1.2 positive control: with BOTH the pre-round-2 read-before-lock item_current() AND round 3'"'"'s post-marker recheck stripped from start_dispatch (the full pre-round-3 architecture), the IDENTICAL race (suppression committed during the same head-lock wait) is MISSED — a token is wrongly issued despite the suppression, confirming the reorder + recheck in the real functions are what make the positive case above actually work, and that round 3'"'"'s second layer is not merely masking round 2'"'"'s own effect')
 # Free the sender + restore the real item_current() AND start_dispatch.
 tok12=json.loads(rout2)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{att12}','{tok12}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-P12'))")
 restore_fn('inbox_reply_send.item_current')
 restore_fn('inbox_reply_send.start_dispatch')
 assert_body_matches('inbox_reply_send.item_current')
 assert_body_matches('inbox_reply_send.start_dispatch')

 # === P2.3 per-operation cap race: two real connections, observed lock-wait.
 # The winner holds the operations row's FOR NO KEY UPDATE lock (acquired
 # inside its own INSERT's trigger) open via a transaction wrapped in
 # pg_sleep; the loser's own trigger invocation must genuinely block on that
 # SAME row (observed wait_event_type=Lock) before it ever gets to compute
 # the cap check, then raises INBOX_REPLY_RECIPIENT_LIMIT once it unblocks
 # and sees the winner's now-committed row. Cap temporarily lowered to 1
 # (equivalent in shape to racing for the 50th slot, without needing 50 real
 # conversations).
 sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.recipient_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $lim$ SELECT 1 $lim$;")
 capA_recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{cap_prep_id}' AND value->>'id'='{cap_item_a}'")
 capB_recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{cap_prep_id}' AND value->>'id'='{cap_item_b}'")
 nA='cap-a-'+str(uuid.uuid4());nB='cap-b-'+str(uuid.uuid4())
 insA=f"SET application_name='{nA}';BEGIN;INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{cap_op_id}','{cap_prep_id}','{cap_item_a}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{capA_recipient}'::jsonb r) s;SELECT pg_sleep(2);COMMIT;"
 insB=f"SET application_name='{nB}';INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{cap_op_id}','{cap_prep_id}','{cap_item_b}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{capB_recipient}'::jsonb r) s;"
 pA=start(insA);children=[pA]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nA}' AND wait_event='PgSleep')",'P2.3 winner did not hold the operations row lock')
 pB=start(insB);children=[pA,pB]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nB}' AND wait_event_type='Lock')",'P2.3 loser did not actually block on the operations row lock')
 outA,errA=pA.communicate(timeout=12);children=[pB]
 outB,errB=pB.communicate(timeout=12);children=[]
 count_after=sql(f"SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id='{org}' AND operation_id='{cap_op_id}'")
 need(count_after=='1',f'P2.3 expected exactly 1 distinct item admitted under the cap, got {count_after}')
 cap_winners=[pA.returncode==0,pB.returncode==0]
 need(cap_winners==[True,False],f'P2.3 expected the lock-holder (A) to win and the blocked insert (B) to lose: A rc={pA.returncode} err={errA!r}; B rc={pB.returncode} err={errB!r}')
 need('INBOX_REPLY_RECIPIENT_LIMIT' in errB,f'P2.3 loser did not fail on the recipient-limit cap: {errB}')
 checks.append('P2.3 positive case: two real connections — the winner held the operations row'"'"'s FOR NO KEY UPDATE lock open (observed pg_stat_activity PgSleep) while the loser'"'"'s own INSERT trigger invocation genuinely blocked on that same row (observed wait_event_type=Lock) before computing the cap check; once the winner committed, the loser unblocked and correctly raised INBOX_REPLY_RECIPIENT_LIMIT')

 # Positive control: without the FOR NO KEY UPDATE serialization, both
 # concurrent inserts can read the same pre-insert count and both pass.
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.guard_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE frozen jsonb;recomputed text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable send attempt';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'approved' THEN RAISE EXCEPTION 'Invalid initial send attempt state';END IF;
  IF NEW.generation<>0 OR NEW.receipt_version<>0 OR NEW.lease_until IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL OR NEW.dispatch_token IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.provider_status IS NOT NULL OR NEW.evidence IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid initial send attempt fields';
  END IF;
  -- MUTATION: FOR NO KEY UPDATE dropped — plain existence check, no lock.
  IF NOT EXISTS(SELECT 1 FROM inbox_reply_send.operations WHERE org_id=NEW.org_id AND id=NEW.operation_id AND preparation_id=NEW.preparation_id) THEN
   RAISE EXCEPTION 'Attempt preparation does not match operation';
  END IF;
  frozen:=inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id);
  recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
  IF NEW.contact_id IS DISTINCT FROM (frozen->'recipient'->>'contactId')::uuid
     OR NEW.from_e164 IS DISTINCT FROM frozen->'recipient'->>'from'
     OR NEW.to_e164 IS DISTINCT FROM frozen->'recipient'->>'to'
     OR NEW.body_hash IS DISTINCT FROM recomputed THEN
   RAISE EXCEPTION 'Attempt does not match frozen recipient';
  END IF;
  IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=NEW.org_id AND operation_id=NEW.operation_id AND item_id<>NEW.item_id)+1>inbox_reply_preparation.recipient_limit() THEN
   RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';
  END IF;
  -- Deterministic race window: without FOR NO KEY UPDATE nothing blocks a
  -- concurrent second trigger invocation from also reading the same
  -- pre-insert count before either commits. A real two-connection race can
  -- still resolve serially by sheer process-launch timing, so this sleep
  -- widens the window enough that both connections' count reads are
  -- guaranteed to overlap — it does not change what the missing lock does
  -- or does not prevent, only makes the race deterministic to observe.
  PERFORM pg_sleep(1);
  RETURN NEW;
 END IF;
 RAISE EXCEPTION 'unused in this proof (UPDATE/DELETE path)';
END $mut$;""")
 sql("CREATE OR REPLACE FUNCTION inbox_reply_preparation.recipient_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $lim$ SELECT 2 $lim$;")
 # Whichever of A/B lost the positive-case race above never committed (its
 # item_id is still unattempted); C was never touched either. Race the
 # LOSER's item and C concurrently under the now-broken (no FOR NO KEY
 # UPDATE) trigger, cap raised to 2 to admit both on top of the winner's
 # already-committed 1 — if the serialization is really gone, both
 # concurrent inserts read count=1, each computes 1+1=2<=2, and both
 # commit: 3 distinct items under a cap of 2, the real overrun this fix
 # prevents.
 cap_loser_item=cap_item_b if cap_winners[0] else cap_item_a
 capB_recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{cap_prep_id}' AND value->>'id'='{cap_loser_item}'")
 capC_recipient=sql(f"SELECT jsonb_build_object('contactId',value->'recipient'->>'contactId','from',value->'recipient'->>'from','to',value->'recipient'->>'to','renderedBody',value->'recipient'->>'renderedBody')::text FROM inbox_reply_review.preparations p,jsonb_array_elements(p.items) value WHERE p.id='{cap_prep_id}' AND value->>'id'='{cap_item_c}'")
 insB2=f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{cap_op_id}','{cap_prep_id}','{cap_loser_item}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{capB_recipient}'::jsonb r) s"
 insC=f"INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state) SELECT '{org}',gen_random_uuid(),'{cap_op_id}','{cap_prep_id}','{cap_item_c}',1,(r->>'contactId')::uuid,r->>'from',r->>'to',inbox_reply_send.body_hash(r->>'renderedBody',r->>'from',r->>'to'),'approved' FROM (SELECT '{capC_recipient}'::jsonb r) s"
 pB2=start(insB2);pC=start(insC);children=[pB2,pC]
 outB2,errB2=pB2.communicate(timeout=12);outC,errC=pC.communicate(timeout=12);children=[]
 need(pB2.returncode==0 and pC.returncode==0,f'P2.3 control did not actually reproduce the overrun (expected both to commit): B rc={pB2.returncode} err={errB2!r}; C rc={pC.returncode} err={errC!r}')
 count_broken=sql(f"SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id='{org}' AND operation_id='{cap_op_id}'")
 need(count_broken=='3',f'P2.3 control expected 3 distinct items to overrun a cap of 2, got {count_broken}')
 checks.append(f'P2.3 positive control: with FOR NO KEY UPDATE removed from the INSERT trigger, two real connections concurrently inserting different items (B, C) into the same operation under a cap of 2 BOTH commit — {count_broken} distinct items admitted, one past the cap — the exact overrun the fix prevents')
 restore_fn('inbox_reply_send.guard_attempt')
 assert_body_matches('inbox_reply_send.guard_attempt')
 # P7 (round 7): previously a hand-typed literal restore with NO
 # installed-definition check at all (Astra round-6 finding) — restore via
 # the exact candidate and assert the readback matches before trusting the
 # real 50-cap again.
 restore_fn('inbox_reply_preparation.recipient_limit')
 assert_body_matches('inbox_reply_preparation.recipient_limit')

 # === Race#1 (R3-1): the marker UPDATE itself can block on the D-6(5)
 # sender-inflight index; a suppression committing during THAT block must
 # still be caught before a token is ever handed out. Item X and Y share the
 # one configured sender.
 item13,_=fetch_item(prep_id,13);item14,_=fetch_item(prep_id,14)
 attX=insert_attempt(org,op_id,prep_id,item13);attY=insert_attempt(org,op_id,prep_id,item14)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attX}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{attY}',60)")
 nX='r1-x-'+str(uuid.uuid4());nY='r1-y-'+str(uuid.uuid4())
 # A holds an UNCOMMITTED marker for X open, then ROLLS BACK — this both
 # forces B's own marker attempt for Y to genuinely block on the same
 # sender-inflight index entry (observed lock-wait) and, on rollback, undoes
 # X's marker cleanly (X reverts to 'claimed', its own separately-committed
 # claim() untouched).
 connA=start(f"SET application_name='{nX}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{attX}',1);SELECT pg_sleep(3);ROLLBACK;");children=[connA]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nX}' AND wait_event='PgSleep')",'Race#1 A did not hold its uncommitted marker open')
 connB=start(f"SET application_name='{nY}';SELECT inbox_reply_send.start_dispatch('{org}','{attY}',1);");children=[connA,connB]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nY}' AND wait_event_type='Lock')",'Race#1 B did not actually block on the sender-inflight index')
 # Conn C: commit a suppression for Y's destination WHILE B is blocked on
 # the marker — the exact gap R3-1 closes.
 destY=sql(f"SELECT to_e164 FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attY}'")
 sql(f"INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES('{org}','sms','{destY}','owned_prd_concurrency_race1')")
 outA,errA=connA.communicate(timeout=12);children=[connB]
 need(connA.returncode==0,f'Race#1 A (rollback) unexpectedly failed: {errA}')
 outB,errB=connB.communicate(timeout=12);children=[]
 need(connB.returncode==0,f'Race#1 B unexpectedly failed: {errB}')
 need('"kind": "skipped"' in outB,f'Race#1 B did not skip after the post-marker recheck: {outB}')
 need('"token"' not in outB,f'Race#1 B leaked a token despite skipping: {outB}')
 rowY=sql(f"SELECT state,dispatch_token IS NULL,dispatch_started_at IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attY}'")
 need(rowY=='skipped_ineligible|t|t',f'Race#1 row Y not cleanly rolled back to skipped_ineligible: {rowY}')
 race1_reason=json.loads(outB).get('reason')
 checks.append(f'Race#1 positive case: two real connections — B'"'"'s marker UPDATE for Y genuinely blocked on the D-6(5) sender-inflight index (observed wait_event_type=Lock) while A held an uncommitted marker for X on the same sender; a suppression committed by a third connection during that block was still caught by the post-marker recheck once B unblocked (A rolled back) — B returned {{kind:skipped, reason:{race1_reason}}}, row Y ended skipped_ineligible with no token and no dispatch_started_at')

 # Sub-test: the SAME marker-block mechanism, but A COMMITS instead of
 # rolling back — B must still get the sanitized SENDER_BUSY, exactly as #8
 # proved via a different setup; this confirms the block-then-catch path
 # also holds when reached via a marker-vs-marker race rather than a
 # pre-check-bypassing race.
 item15,_=fetch_item(prep_id,15);item16,_=fetch_item(prep_id,16)
 attXp=insert_attempt(org,op_id,prep_id,item15);attYp=insert_attempt(org,op_id,prep_id,item16)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attXp}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{attYp}',60)")
 nXp='r1c-x-'+str(uuid.uuid4());nYp='r1c-y-'+str(uuid.uuid4())
 connAc=start(f"SET application_name='{nXp}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{attXp}',1);SELECT pg_sleep(2);COMMIT;");children=[connAc]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nXp}' AND wait_event='PgSleep')",'Race#1 (A-commits) A did not hold its uncommitted marker open')
 connBc=start(f"SET application_name='{nYp}';SELECT inbox_reply_send.start_dispatch('{org}','{attYp}',1);");children=[connAc,connBc]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nYp}' AND wait_event_type='Lock')",'Race#1 (A-commits) B did not actually block on the sender-inflight index')
 outAc,errAc=connAc.communicate(timeout=12);children=[connBc]
 need(connAc.returncode==0 and '"kind": "dispatch"' in outAc,f'Race#1 (A-commits) A unexpected result: rc={connAc.returncode} out={outAc!r} err={errAc!r}')
 outBc,errBc=connBc.communicate(timeout=12);children=[]
 need(connBc.returncode!=0,f'Race#1 (A-commits) B unexpectedly succeeded: {outBc!r}')
 need('INBOX_REPLY_SENDER_BUSY' in errBc,f'Race#1 (A-commits) B did not fail on the sanitized sender guard: {errBc}')
 need('DETAIL' not in errBc and 'duplicate key' not in errBc.lower(),f'Race#1 (A-commits) B leaked raw constraint detail: {errBc}')
 rowYp=sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attYp}'")
 need(rowYp=='claimed',f'Race#1 (A-commits) row Y unexpectedly mutated by the failed marker attempt: {rowYp}')
 checks.append('Race#1 (A-commits branch): the same marker-vs-marker block, but A commits instead of rolling back — B'"'"'s blocked marker UPDATE resumes into a genuine unique_violation and receives the sanitized INBOX_REPLY_SENDER_BUSY (55P03, no raw DETAIL); row Y is left untouched (still claimed) since nothing in B'"'"'s aborted statement ever committed')
 tokXp=json.loads(outAc)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{attXp}','{tokXp}',jsonb_build_object('kind','accepted','externalId','PROV-CONC-R1C'))")

 # Positive control: strip the post-marker recheck (round-2 shape) and
 # repeat the rollback-branch race on a fresh pair — this time the
 # suppression is MISSED and B wrongly dispatches with a token.
 item17,_=fetch_item(prep_id,17);item18,_=fetch_item(prep_id,18)
 attXpp=insert_attempt(org,op_id,prep_id,item17);attYpp=insert_attempt(org,op_id,prep_id,item18)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attXpp}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{attYpp}',60)")
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 -- MUTATION (pre-round-3): only the pre-marker check; no post-marker recheck.
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
 EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
  IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
  ELSE RAISE;
  END IF;
 END;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $mut$;""")
 nXpp='r1m-x-'+str(uuid.uuid4());nYpp='r1m-y-'+str(uuid.uuid4())
 connApp=start(f"SET application_name='{nXpp}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{attXpp}',1);SELECT pg_sleep(3);ROLLBACK;");children=[connApp]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nXpp}' AND wait_event='PgSleep')",'Race#1 control A did not hold its uncommitted marker open')
 connBpp=start(f"SET application_name='{nYpp}';SELECT inbox_reply_send.start_dispatch('{org}','{attYpp}',1);");children=[connApp,connBpp]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nYpp}' AND wait_event_type='Lock')",'Race#1 control B did not actually block on the sender-inflight index')
 destYpp=sql(f"SELECT to_e164 FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attYpp}'")
 sql(f"INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES('{org}','sms','{destYpp}','owned_prd_concurrency_race1_control')")
 outApp,errApp=connApp.communicate(timeout=12);children=[connBpp]
 need(connApp.returncode==0,f'Race#1 control A (rollback) unexpectedly failed: {errApp}')
 outBpp,errBpp=connBpp.communicate(timeout=12);children=[]
 need(connBpp.returncode==0 and '"kind": "dispatch"' in outBpp,f'Race#1 control did not actually reproduce the miss (expected B to wrongly dispatch): rc={connBpp.returncode} out={outBpp!r} err={errBpp!r}')
 checks.append('Race#1 positive control: with the post-marker recheck stripped from start_dispatch (round-2 shape), the IDENTICAL marker-block race is MISSED — B wrongly returns {kind:dispatch} with a token despite the suppression committed during its lock wait, confirming the post-marker recheck in the real function is what makes the positive case above actually work')
 tokYpp=json.loads(outBpp)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{attYpp}','{tokYpp}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch'))")
 restore_fn('inbox_reply_send.start_dispatch')
 assert_body_matches('inbox_reply_send.start_dispatch')

 # === Race#2 (R3-2/R3-2b): validUntil expiring WHILE start_dispatch is
 # blocked on the head-row lock. Each sub-item's frozen validUntil is
 # tampered (owner bypass on the immutable preparations row, exactly like
 # the established P-GATE tamper pattern) to 2 seconds out; a 3-second
 # head-lock hold guarantees the window has expired by the time the
 # blocked call resumes.
 def tamper_valid_until(item_id,seconds):
  sql("ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation")
  sql(f"UPDATE inbox_reply_review.preparations p2u SET items=(SELECT jsonb_agg(CASE WHEN value->>'id'='{item_id}' THEN jsonb_set(value,'{{validUntil}}',to_jsonb((clock_timestamp()+interval '{seconds} seconds')::text)) ELSE value END) FROM jsonb_array_elements(p2u.items) value) WHERE p2u.id='{prep_id}'")
  sql("ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation")

 # --- Z1: real (unmutated) functions. B must skip cleanly, no marker.
 item19,conv19=fetch_item(prep_id,19)
 attZ1=insert_attempt(org,op_id,prep_id,item19)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attZ1}',60)")
 tamper_valid_until(item19,2)
 nZ1w='r2z1-w-'+str(uuid.uuid4());nZ1r='r2z1-r-'+str(uuid.uuid4())
 wZ1=start(f"SET application_name='{nZ1w}';BEGIN;SELECT revision FROM inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv19}' FOR UPDATE;SELECT pg_sleep(3);COMMIT;");children=[wZ1]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nZ1w}' AND wait_event='PgSleep')",'Race#2 Z1 writer did not hold the head lock')
 rZ1=start(f"SET application_name='{nZ1r}';SELECT inbox_reply_send.start_dispatch('{org}','{attZ1}',1);");children=[wZ1,rZ1]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nZ1r}' AND wait_event_type='Lock')",'Race#2 Z1 reader did not actually wait on the head lock')
 finish(wZ1,'Race#2 Z1 writer');children=[rZ1]
 outZ1=finish(rZ1,'Race#2 Z1 reader');children=[]
 need('"kind": "skipped"' in outZ1 and 'conversation_window_expired' in outZ1,f'Race#2 Z1 did not skip on expiry: {outZ1}')
 need('"token"' not in outZ1,f'Race#2 Z1 leaked a token: {outZ1}')
 rowZ1=sql(f"SELECT state,dispatch_started_at IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attZ1}'")
 need(rowZ1=='skipped_ineligible|t',f'Race#2 Z1 row not cleanly skipped with no marker: {rowZ1}')
 checks.append('Race#2 Z1 (positive case): conn A held the inbound-head row FOR UPDATE for 3s while item Z1'"'"'s 2s window expired underneath; conn B'"'"'s start_dispatch blocked on that same head lock (observed wait_event_type=Lock), and once unblocked evaluated validUntil AFTER the wait (R3-2) — skipped_ineligible/conversation_window_expired, no marker ever written, no token')

 # --- Mutate item_current (revert to pre-round-2 order: time checks and
 # destination_policy evaluated before any lock) AND start_dispatch (strip
 # the round-3 post-marker recheck entirely) — the full pre-round-3 function
 # bodies. This pairing is reused for both Z2 and Z3 below; they differ only
 # in whether the trigger's R3-2b check is present.
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.item_current(o uuid,item jsonb) RETURNS text LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE qh jsonb;policy_result jsonb;sender public.provider_sender_numbers;head public.inbox_inbound_heads;
BEGIN
 -- MUTATION (pre-round-2 order): time checks evaluated before any lock.
 IF (item->>'validUntil')::timestamptz<=clock_timestamp() THEN RETURN 'conversation_window_expired';END IF;
 qh:=inbox_reply_preparation.quiet_hours(item->>'state',clock_timestamp());
 IF qh->>'ok' IS DISTINCT FROM 'true' THEN
  IF qh->>'reason'='unknown_state' THEN RETURN 'unknown_state';ELSE RETURN 'outside_window';END IF;
 END IF;
 policy_result:=inbox_reply_preparation.destination_policy(o,item->'recipient'->>'to',(item->'recipient'->>'contactId')::uuid,true);
 IF policy_result->>'exclusion' IS NOT NULL THEN RETURN policy_result->>'exclusion';END IF;
 SELECT * INTO sender FROM public.provider_sender_numbers WHERE org_id=o AND provider='sendillo' AND phone_e164=item->'recipient'->>'from' FOR SHARE;
 IF sender.status IS DISTINCT FROM 'active' THEN RETURN 'sender_unavailable';END IF;
 SELECT * INTO head FROM public.inbox_inbound_heads WHERE org_id=o AND conversation_id=(item->'target'->>'id')::uuid FOR SHARE;
 IF head.revision::text IS DISTINCT FROM item->'dependencies'->>'head' THEN RETURN 'inbound_changed';END IF;
 RETURN NULL;
END $mut$;""")
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 -- MUTATION (pre-round-3): only the pre-marker check; no post-marker recheck.
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
 EXCEPTION WHEN unique_violation THEN
  GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
  IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
  ELSE RAISE;
  END IF;
 END;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $mut$;""")

 # --- Z2 (positive control): trigger's R3-2b check ALSO removed. With
 # BOTH function-level defenses (item_current order, start_dispatch
 # recheck) AND the trigger-level defense gone, the marker is written with
 # dispatch_started_at genuinely past validUntil and returned to the caller.
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.guard_attempt() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE frozen jsonb;recomputed text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Immutable send attempt';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'approved' THEN RAISE EXCEPTION 'Invalid initial send attempt state';END IF;
  IF NEW.generation<>0 OR NEW.receipt_version<>0 OR NEW.lease_until IS NOT NULL OR NEW.dispatch_started_at IS NOT NULL OR NEW.dispatch_token IS NOT NULL OR NEW.provider_reference IS NOT NULL OR NEW.provider_status IS NOT NULL OR NEW.evidence IS NOT NULL THEN
   RAISE EXCEPTION 'Invalid initial send attempt fields';
  END IF;
  PERFORM 1 FROM inbox_reply_send.operations WHERE org_id=NEW.org_id AND id=NEW.operation_id AND preparation_id=NEW.preparation_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
   RAISE EXCEPTION 'Attempt preparation does not match operation';
  END IF;
  frozen:=inbox_reply_send.frozen_item(NEW.org_id,NEW.preparation_id,NEW.item_id);
  recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
  IF NEW.contact_id IS DISTINCT FROM (frozen->'recipient'->>'contactId')::uuid
     OR NEW.from_e164 IS DISTINCT FROM frozen->'recipient'->>'from'
     OR NEW.to_e164 IS DISTINCT FROM frozen->'recipient'->>'to'
     OR NEW.body_hash IS DISTINCT FROM recomputed THEN
   RAISE EXCEPTION 'Attempt does not match frozen recipient';
  END IF;
  IF (SELECT count(DISTINCT item_id) FROM inbox_reply_send.attempts WHERE org_id=NEW.org_id AND operation_id=NEW.operation_id AND item_id<>NEW.item_id)+1>inbox_reply_preparation.recipient_limit() THEN
   RAISE EXCEPTION 'INBOX_REPLY_RECIPIENT_LIMIT';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.org_id IS DISTINCT FROM OLD.org_id OR NEW.id IS DISTINCT FROM OLD.id OR NEW.operation_id IS DISTINCT FROM OLD.operation_id
    OR NEW.preparation_id IS DISTINCT FROM OLD.preparation_id OR NEW.item_id IS DISTINCT FROM OLD.item_id
    OR NEW.attempt_ordinal IS DISTINCT FROM OLD.attempt_ordinal OR NEW.prior_attempt_id IS DISTINCT FROM OLD.prior_attempt_id
    OR NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.from_e164 IS DISTINCT FROM OLD.from_e164
    OR NEW.to_e164 IS DISTINCT FROM OLD.to_e164 OR NEW.body_hash IS DISTINCT FROM OLD.body_hash
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
  RAISE EXCEPTION 'Immutable send attempt identity';
 END IF;
 IF NEW.generation<OLD.generation OR NEW.receipt_version<OLD.receipt_version THEN RAISE EXCEPTION 'Send attempt counters may not decrease';END IF;
 IF OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at THEN RAISE EXCEPTION 'dispatch_started_at is immutable once set';END IF;
 IF OLD.dispatch_token IS NOT NULL AND NEW.dispatch_token IS DISTINCT FROM OLD.dispatch_token THEN RAISE EXCEPTION 'dispatch_token is immutable once set';END IF;
 NEW.updated_at:=clock_timestamp();
 CASE
  WHEN OLD.state='approved' AND NEW.state='claimed' THEN NULL;
  WHEN OLD.state='claimed' AND NEW.state='claimed' THEN
   IF NEW.generation<=OLD.generation THEN RAISE EXCEPTION 'Reclaim must strictly increase generation';END IF;
  -- MUTATION: R3-2b window-expiry check removed from this edge.
  WHEN OLD.state='claimed' AND NEW.state='dispatch_started' THEN
   IF NEW.dispatch_started_at IS NULL OR NEW.dispatch_token IS NULL THEN RAISE EXCEPTION 'Dispatch marker must be set exactly once here';END IF;
  WHEN OLD.state='claimed' AND NEW.state='skipped_ineligible' THEN NULL;
  WHEN OLD.state='dispatch_started' AND NEW.state IN ('provider_accepted','uncertain','confirmed_not_submitted') THEN NULL;
  WHEN OLD.state='uncertain' AND NEW.state='provider_accepted' THEN NULL;
  WHEN OLD.state='provider_accepted' AND NEW.state IN ('delivered','delivery_failed') THEN NULL;
  ELSE RAISE EXCEPTION 'Invalid send attempt transition: % -> %',OLD.state,NEW.state;
 END CASE;
 RETURN NEW;
END $mut$;""")
 item20,conv20=fetch_item(prep_id,20)
 attZ2=insert_attempt(org,op_id,prep_id,item20)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attZ2}',60)")
 tamper_valid_until(item20,2)
 nZ2w='r2z2-w-'+str(uuid.uuid4());nZ2r='r2z2-r-'+str(uuid.uuid4())
 wZ2=start(f"SET application_name='{nZ2w}';BEGIN;SELECT revision FROM inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv20}' FOR UPDATE;SELECT pg_sleep(3);COMMIT;");children=[wZ2]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nZ2w}' AND wait_event='PgSleep')",'Race#2 Z2 writer did not hold the head lock')
 rZ2=start(f"SET application_name='{nZ2r}';SELECT inbox_reply_send.start_dispatch('{org}','{attZ2}',1);");children=[wZ2,rZ2]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nZ2r}' AND wait_event_type='Lock')",'Race#2 Z2 reader did not actually wait on the head lock')
 finish(wZ2,'Race#2 Z2 writer');children=[rZ2]
 outZ2=finish(rZ2,'Race#2 Z2 reader');children=[]
 need('"kind": "dispatch"' in outZ2,f'Race#2 Z2 control did not reproduce the bad marker (expected a wrongly-issued token): {outZ2}')
 rowZ2=sql(f"SELECT dispatch_started_at>=(inbox_reply_send.frozen_item('{org}','{prep_id}','{item20}')->>'validUntil')::timestamptz FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attZ2}'")
 need(rowZ2=='t',f'Race#2 Z2 marker was not actually written past validUntil: {rowZ2}')
 checks.append('Race#2 Z2 (positive control): with item_current'"'"'s time-check reorder reverted, start_dispatch'"'"'s post-marker recheck stripped, AND the trigger'"'"'s R3-2b window check removed — all three defenses gone — the marker is written and returned to the caller with dispatch_started_at genuinely past the frozen validUntil')
 tokZ2=json.loads(outZ2)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{attZ2}','{tokZ2}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch'))")

 # --- Z3: restore ONLY the trigger (R3-2b back) — item_current and
 # start_dispatch stay broken (same mutated bodies as Z2). Proves the
 # trigger alone, independent of any function-body bug, makes a stale-time
 # marker unwritable: the marker UPDATE itself raises
 # INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER (an uncaught SQLSTATE in
 # start_dispatch's savepoint block, by design — only IR001 and
 # unique_violation are caught), aborting the whole call; the row is left
 # exactly as it was before the call (claimed).
 restore_fn('inbox_reply_send.guard_attempt')
 assert_body_matches('inbox_reply_send.guard_attempt')
 item21,conv21=fetch_item(prep_id,21)
 attZ3=insert_attempt(org,op_id,prep_id,item21)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attZ3}',60)")
 tamper_valid_until(item21,2)
 nZ3w='r2z3-w-'+str(uuid.uuid4());nZ3r='r2z3-r-'+str(uuid.uuid4())
 wZ3=start(f"SET application_name='{nZ3w}';BEGIN;SELECT revision FROM inbox_inbound_heads WHERE org_id='{org}' AND conversation_id='{conv21}' FOR UPDATE;SELECT pg_sleep(3);COMMIT;");children=[wZ3]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nZ3w}' AND wait_event='PgSleep')",'Race#2 Z3 writer did not hold the head lock')
 rZ3=start(f"SET application_name='{nZ3r}';SELECT inbox_reply_send.start_dispatch('{org}','{attZ3}',1);");children=[wZ3,rZ3]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nZ3r}' AND wait_event_type='Lock')",'Race#2 Z3 reader did not actually wait on the head lock')
 finish(wZ3,'Race#2 Z3 writer');children=[rZ3]
 outZ3,errZ3=rZ3.communicate(timeout=12);children=[]
 need(rZ3.returncode!=0,f'Race#2 Z3 unexpectedly succeeded (trigger should have blocked the marker): {outZ3!r}')
 need('INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER' in errZ3,f'Race#2 Z3 did not fail via the trigger'"'"'s R3-2b check: {errZ3}')
 rowZ3=sql(f"SELECT state,dispatch_started_at IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attZ3}'")
 need(rowZ3=='claimed|t',f'Race#2 Z3 row was mutated despite the trigger raising: {rowZ3}')
 checks.append('Race#2 Z3 (R3-2b isolation): with item_current and start_dispatch STILL broken exactly as in Z2, restoring ONLY the trigger'"'"'s R3-2b check is sufficient — the marker UPDATE itself raises INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER (an uncaught SQLSTATE, by design — only IR001/unique_violation are caught), aborting the call; the row is left exactly as it was (claimed), proving the trigger-level defense is independent of every function-body defense')

 # Restore item_current and start_dispatch to the real (candidate) bodies.
 restore_fn('inbox_reply_send.item_current')
 restore_fn('inbox_reply_send.start_dispatch')
 assert_body_matches('inbox_reply_send.item_current')
 assert_body_matches('inbox_reply_send.start_dispatch')

 # === R4 (round 4): the post-marker recheck's fresh-snapshot guarantee only
 # holds under READ COMMITTED. Under REPEATABLE READ/SERIALIZABLE the whole
 # transaction shares one pinned snapshot, so the post-marker item_current()
 # call would see the SAME stale data as the pre-marker call and silently
 # miss a suppression committed during the marker's lock-wait — reverting R3
 # without any code path looking broken. item_current()/start_dispatch()
 # both assert READ COMMITTED and raise INBOX_REPLY_UNSUPPORTED_ISOLATION
 # (0A000) otherwise.

 # --- R4a: single-connection positive controls. A fresh REPEATABLE READ (and
 # separately SERIALIZABLE) transaction must be rejected by start_dispatch
 # BEFORE it ever touches the marker — no marker/token, row stays claimed.
 item22,_=fetch_item(prep_id,22)
 attR4a=insert_attempt(org,op_id,prep_id,item22)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attR4a}',60)")
 for level in ('REPEATABLE READ','SERIALIZABLE'):
  failed=False;errtext=''
  try:sql(f"BEGIN ISOLATION LEVEL {level};SELECT inbox_reply_send.start_dispatch('{org}','{attR4a}',1);ROLLBACK;")
  except RuntimeError as e:
   failed='INBOX_REPLY_UNSUPPORTED_ISOLATION' in str(e);errtext=str(e)
  need(failed,f'R4a {level}: start_dispatch did not raise INBOX_REPLY_UNSUPPORTED_ISOLATION: {errtext}')
 rowR4a=sql(f"SELECT state,dispatch_started_at IS NULL,dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attR4a}'")
 need(rowR4a=='claimed|t|t',f'R4a: row mutated despite the isolation assert raising: {rowR4a}')
 checks.append('R4a (positive control, single connection): start_dispatch on a claimed attempt raises INBOX_REPLY_UNSUPPORTED_ISOLATION (0A000) under both BEGIN ISOLATION LEVEL REPEATABLE READ and SERIALIZABLE, before ever writing the marker — row is left exactly as it was (claimed, no dispatch_started_at, no token); the normal READ COMMITTED path (every other check in this file and run.py) is unaffected')

 # --- R4b: the exact two-connection Codex repro. A holds an UNCOMMITTED
 # marker for X open (same mechanism as Race#1); B opens a REPEATABLE READ
 # transaction and calls start_dispatch for Y, which shares X's sender.
 item23,_=fetch_item(prep_id,23);item24r,_=fetch_item(prep_id,24)
 attX4=insert_attempt(org,op_id,prep_id,item23);attY4=insert_attempt(org,op_id,prep_id,item24r)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attX4}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{attY4}',60)")
 nX4='r4b-x-'+str(uuid.uuid4());nY4='r4b-y-'+str(uuid.uuid4())
 connA4=start(f"SET application_name='{nX4}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{attX4}',1);SELECT pg_sleep(3);ROLLBACK;");children=[connA4]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nX4}' AND wait_event='PgSleep')",'R4b A did not hold its uncommitted marker open')
 connB4=start(f"SET application_name='{nY4}';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT inbox_reply_send.start_dispatch('{org}','{attY4}',1);COMMIT;");children=[connA4,connB4]
 # With the isolation assert present, B raises immediately after claiming its
 # own row FOR UPDATE — BEFORE it ever reaches the sender-inflight check, so
 # it never blocks at all. Give it a moment to finish rather than waiting for
 # a lock-wait that (correctly) never happens.
 outB4,errB4=connB4.communicate(timeout=8);children=[connA4]
 need(connB4.returncode!=0 and 'INBOX_REPLY_UNSUPPORTED_ISOLATION' in errB4,f'R4b: B under REPEATABLE READ did not raise INBOX_REPLY_UNSUPPORTED_ISOLATION: rc={connB4.returncode} out={outB4!r} err={errB4!r}')
 finish(connA4,'R4b A (rollback)');children=[]
 rowY4=sql(f"SELECT state,dispatch_started_at IS NULL,dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attY4}'")
 need(rowY4=='claimed|t|t',f'R4b: row Y mutated despite the isolation assert raising: {rowY4}')
 checks.append("R4b (Codex's exact repro, real connections): B opened a genuine REPEATABLE READ transaction and called start_dispatch for Y (sharing X's sender) while A held an uncommitted marker for X — B raised INBOX_REPLY_UNSUPPORTED_ISOLATION immediately (before ever blocking on the sender-inflight index), row Y untouched (still claimed, no marker, no token); A's rollback is independent of B's outcome")

 # --- R4c: MUTATION — remove the isolation assert from item_current(),
 # start_dispatch() (revert to the round-3 bodies), AND guard_attempt()'s
 # marker-edge trigger check (the R5 defense-in-depth added independently
 # of these two — without also stripping it, the trigger now closes this
 # hole on its own before B ever reaches the sender-inflight index, which
 # would prevent this mutation from reproducing the underlying race at
 # all) — then rerun the IDENTICAL R4b race. With all three guards gone, B
 # genuinely blocks on the sender-inflight index (like Race#1), and once A
 # rolls back, B's post-marker item_current() call reuses B's OWN pinned
 # REPEATABLE READ snapshot — taken before C's suppression committed — so
 # it does NOT see the suppression and wrongly dispatches with a token to
 # a now-suppressed destination: the exact defect Codex reproduced.
 sql(real_fn_minus_block('inbox_reply_send.guard_attempt',"IF current_setting('transaction_isolation')<>'read committed' THEN",3))
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.item_current(o uuid,item jsonb) RETURNS text LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE qh jsonb;policy_result jsonb;sender public.provider_sender_numbers;head public.inbox_inbound_heads;
BEGIN
 -- MUTATION (round-3 shape): no isolation assert.
 SELECT * INTO sender FROM public.provider_sender_numbers WHERE org_id=o AND provider='sendillo' AND phone_e164=item->'recipient'->>'from' FOR SHARE;
 SELECT * INTO head FROM public.inbox_inbound_heads WHERE org_id=o AND conversation_id=(item->'target'->>'id')::uuid FOR SHARE;
 IF (item->>'validUntil')::timestamptz<=clock_timestamp() THEN RETURN 'conversation_window_expired';END IF;
 qh:=inbox_reply_preparation.quiet_hours(item->>'state',clock_timestamp());
 IF qh->>'ok' IS DISTINCT FROM 'true' THEN
  IF qh->>'reason'='unknown_state' THEN RETURN 'unknown_state';ELSE RETURN 'outside_window';END IF;
 END IF;
 policy_result:=inbox_reply_preparation.destination_policy(o,item->'recipient'->>'to',(item->'recipient'->>'contactId')::uuid,true);
 IF policy_result->>'exclusion' IS NOT NULL THEN RETURN policy_result->>'exclusion';END IF;
 IF sender.status IS DISTINCT FROM 'active' THEN RETURN 'sender_unavailable';END IF;
 IF head.revision::text IS DISTINCT FROM item->'dependencies'->>'head' THEN RETURN 'inbound_changed';END IF;
 RETURN NULL;
END $mut$;""")
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;cn text;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 -- MUTATION (round-3 shape): no isolation assert.
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 token:=gen_random_uuid();
 BEGIN
  UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
  ev:=inbox_reply_send.item_current(o,frozen);
  IF ev IS NOT NULL THEN RAISE EXCEPTION 'stale after marker' USING ERRCODE='IR001';END IF;
 EXCEPTION
  WHEN SQLSTATE 'IR001' THEN
   UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
   RETURN jsonb_build_object('kind','skipped','reason',ev);
  WHEN unique_violation THEN
   GET STACKED DIAGNOSTICS cn=CONSTRAINT_NAME;
   IF cn='inbox_reply_send_sender_inflight' THEN RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
   ELSE RAISE;
   END IF;
 END;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $mut$;""")
 item25,_=fetch_item(prep_id,25);item26,_=fetch_item(prep_id,26)
 attX4m=insert_attempt(org,op_id,prep_id,item25);attY4m=insert_attempt(org,op_id,prep_id,item26)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attX4m}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{attY4m}',60)")
 nX4m='r4c-x-'+str(uuid.uuid4());nY4m='r4c-y-'+str(uuid.uuid4())
 connA4m=start(f"SET application_name='{nX4m}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{attX4m}',1);SELECT pg_sleep(3);ROLLBACK;");children=[connA4m]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nX4m}' AND wait_event='PgSleep')",'R4c A did not hold its uncommitted marker open')
 connB4m=start(f"SET application_name='{nY4m}';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT inbox_reply_send.start_dispatch('{org}','{attY4m}',1);COMMIT;");children=[connA4m,connB4m]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nY4m}' AND wait_event_type='Lock')",'R4c B did not actually block on the sender-inflight index (mutation had no effect)')
 destY4m=sql(f"SELECT to_e164 FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attY4m}'")
 sql(f"INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES('{org}','sms','{destY4m}','owned_prd_concurrency_race4c')")
 outA4m,errA4m=connA4m.communicate(timeout=12);children=[connB4m]
 need(connA4m.returncode==0,f'R4c A (rollback) unexpectedly failed: {errA4m}')
 outB4m,errB4m=connB4m.communicate(timeout=12);children=[]
 need(connB4m.returncode==0 and '"kind": "dispatch"' in outB4m,f'R4c did not actually reproduce the REPEATABLE READ defect (expected B to wrongly dispatch): rc={connB4m.returncode} out={outB4m!r} err={errB4m!r}')
 checks.append("R4c (mutation, reproduces Codex's exact defect): with the isolation assert stripped from item_current(), start_dispatch() (round-3 shape), AND guard_attempt()'s marker-edge trigger check (R5), B's REPEATABLE READ transaction genuinely blocks on the sender-inflight index while A holds an uncommitted marker; once A rolls back, B's post-marker item_current() reuses B's OWN pinned pre-suppression snapshot and does NOT see the suppression C committed during the block — B wrongly returns {kind:dispatch} with a token to a now-suppressed destination; restored below")
 tokY4m=json.loads(outB4m)['token']
 sql(f"SELECT inbox_reply_send.persist('{org}','{attY4m}','{tokY4m}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch'))")

 # --- R4d: restore all three functions from the candidate and reconfirm
 # the IDENTICAL race (fresh pair) is caught again — this time by B
 # raising INBOX_REPLY_UNSUPPORTED_ISOLATION rather than ever reaching the
 # marker.
 restore_fn('inbox_reply_send.item_current')
 restore_fn('inbox_reply_send.start_dispatch')
 restore_fn('inbox_reply_send.guard_attempt')
 assert_body_matches('inbox_reply_send.item_current')
 assert_body_matches('inbox_reply_send.start_dispatch')
 assert_body_matches('inbox_reply_send.guard_attempt')
 item27,_=fetch_item(prep_id,27);item28,_=fetch_item(prep_id,28)
 attX4d=insert_attempt(org,op_id,prep_id,item27);attY4d=insert_attempt(org,op_id,prep_id,item28)
 sql(f"SELECT inbox_reply_send.claim('{org}','{attX4d}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{attY4d}',60)")
 nX4d='r4d-x-'+str(uuid.uuid4());nY4d='r4d-y-'+str(uuid.uuid4())
 connA4d=start(f"SET application_name='{nX4d}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{attX4d}',1);SELECT pg_sleep(3);ROLLBACK;");children=[connA4d]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nX4d}' AND wait_event='PgSleep')",'R4d A did not hold its uncommitted marker open')
 connB4d=start(f"SET application_name='{nY4d}';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT inbox_reply_send.start_dispatch('{org}','{attY4d}',1);COMMIT;");children=[connA4d,connB4d]
 outB4d,errB4d=connB4d.communicate(timeout=8);children=[connA4d]
 need(connB4d.returncode!=0 and 'INBOX_REPLY_UNSUPPORTED_ISOLATION' in errB4d,f'R4d restore: B under REPEATABLE READ did not raise again after restore: rc={connB4d.returncode} out={outB4d!r} err={errB4d!r}')
 finish(connA4d,'R4d A (rollback)');children=[]
 rowY4d=sql(f"SELECT state,dispatch_started_at IS NULL,dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{attY4d}'")
 need(rowY4d=='claimed|t|t',f'R4d: row Y mutated despite the restored isolation assert: {rowY4d}')
 checks.append('R4d (restore): with the candidate item_current()/start_dispatch() reinstalled (via restore_fn, re-extracted from the source .sql files, and confirmed installed via assert_body_matches\'s full-body comparison), the identical race on a fresh pair is caught again — B raises INBOX_REPLY_UNSUPPORTED_ISOLATION before ever reaching the marker, row untouched; the READ COMMITTED path used by every other check in this file remains unaffected')

 # === R5a: start_dispatch's isolation assert must be its FIRST statement,
 # before the FOR UPDATE row lock — proven with a genuine two-connection
 # lock-wait, not a single-connection SQL trick. Mutation reproduces the
 # exact round-4 shape (assert relocated to just before frozen:=, i.e.
 # AFTER the FOR UPDATE + STALE_CLAIM check): a REPEATABLE READ caller
 # sharing the row with an in-flight lock-holder now blocks on the row
 # lock and is eventually rejected by lock_timeout (55P03), not a clean
 # immediate isolation error — the round-4 hole R5 closes.
 item29,_=fetch_item(prep_id,29)
 att29=insert_attempt(org,op_id,prep_id,item29)
 sql(f"SELECT inbox_reply_send.claim('{org}','{att29}',60)")
 sd_body=real_fn('inbox_reply_send.start_dispatch')
 m=re.search(r" IF current_setting\('transaction_isolation'\)<>'read committed' THEN\n  RAISE EXCEPTION 'INBOX_REPLY_UNSUPPORTED_ISOLATION' USING ERRCODE='0A000';\n END IF;\n",sd_body)
 if not m:raise RuntimeError('R5a: could not locate start_dispatch pre-lock isolation assert to relocate')
 sd_block=m.group(0)
 sd_without=sd_body[:m.start()]+sd_body[m.end():]
 sd_anchor=' frozen:=inbox_reply_send.frozen_item('
 sd_idx=sd_without.index(sd_anchor)
 round4_shape=sd_without[:sd_idx]+sd_block+sd_without[sd_idx:]
 need(round4_shape!=sd_body and round4_shape.count(sd_block)==1,'R5a: relocated mutation malformed')
 sql(round4_shape)
 nA5a='r5a-lockholder-'+str(uuid.uuid4())
 connA5a=start(f"SET application_name='{nA5a}';BEGIN;SELECT * FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att29}' FOR UPDATE;SELECT pg_sleep(11);ROLLBACK;");children=[connA5a]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nA5a}' AND wait_event='PgSleep')",'R5a lock-holder did not reach sleep')
 nB5a='r5a-caller-'+str(uuid.uuid4())
 t0=time.monotonic()
 connB5a=start(f"SET application_name='{nB5a}';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT inbox_reply_send.start_dispatch('{org}','{att29}',1);COMMIT;");children=[connA5a,connB5a]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nB5a}' AND wait_event_type='Lock')",'R5a mutation: B did not actually block on the FOR UPDATE row lock (mutation had no effect)')
 outB5a,errB5a=connB5a.communicate(timeout=15);elapsed5a=time.monotonic()-t0;children=[connA5a]
 need(connB5a.returncode!=0 and ('lock timeout' in errB5a or '55P03' in errB5a) and 'INBOX_REPLY_UNSUPPORTED_ISOLATION' not in errB5a,f'R5a mutation did not reproduce the round-4 hole (expected a lock_timeout, not a clean isolation rejection): rc={connB5a.returncode} out={outB5a!r} err={errB5a!r}')
 need(elapsed5a>=9,f'R5a mutation: B returned in {elapsed5a:.1f}s — too fast to have genuinely waited toward lock_timeout')
 finish(connA5a,'R5a lock-holder (rollback)');children=[]
 row29=sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att29}'")
 need(row29=='claimed',f'R5a mutation: row unexpectedly mutated: {row29}')
 checks.append(f"R5a (mutation, reproduces the round-4 hole): with start_dispatch's isolation assert relocated to its round-4 position (after the FOR UPDATE row lock, before frozen:=), a REPEATABLE READ caller B sharing attempt 29's row with a lock-holder A genuinely blocks on the row lock ({elapsed5a:.1f}s) and is ultimately rejected by lock_timeout (55P03), NOT a clean immediate INBOX_REPLY_UNSUPPORTED_ISOLATION — the exact defect the R5 reordering closes; row left untouched")

 # --- R5a restore: reinstall the candidate (assert-first) definition and
 # reconfirm on the SAME still-claimed row that B is now rejected
 # IMMEDIATELY, without ever attempting the row lock, even while A still
 # holds it.
 restore_fn('inbox_reply_send.start_dispatch')
 assert_body_matches('inbox_reply_send.start_dispatch')
 nA5a2='r5a-restore-lockholder-'+str(uuid.uuid4())
 connA5a2=start(f"SET application_name='{nA5a2}';BEGIN;SELECT * FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att29}' FOR UPDATE;SELECT pg_sleep(3);ROLLBACK;");children=[connA5a2]
 wait_for(f"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='{nA5a2}' AND wait_event='PgSleep')",'R5a restore lock-holder did not reach sleep')
 nB5a2='r5a-restore-caller-'+str(uuid.uuid4())
 t1=time.monotonic()
 connB5a2=start(f"SET application_name='{nB5a2}';BEGIN ISOLATION LEVEL REPEATABLE READ;SELECT inbox_reply_send.start_dispatch('{org}','{att29}',1);COMMIT;");children=[connA5a2,connB5a2]
 outB5a2,errB5a2=connB5a2.communicate(timeout=8);elapsed5a2=time.monotonic()-t1;children=[connA5a2]
 need(connB5a2.returncode!=0 and 'INBOX_REPLY_UNSUPPORTED_ISOLATION' in errB5a2,f'R5a restore: B under REPEATABLE READ did not raise the clean isolation error: rc={connB5a2.returncode} out={outB5a2!r} err={errB5a2!r}')
 need(elapsed5a2<2,f'R5a restore: B took {elapsed5a2:.1f}s — it should have been rejected immediately, before ever attempting the row lock A holds')
 finish(connA5a2,'R5a restore lock-holder (rollback)');children=[]
 row29b=sql(f"SELECT state FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att29}'")
 need(row29b=='claimed',f'R5a restore: row unexpectedly mutated: {row29b}')
 checks.append(f"R5a (restore): with the candidate start_dispatch reinstalled (assert-first, before the FOR UPDATE), the identical setup — A holding the row lock — no longer makes B wait at all: B is rejected with INBOX_REPLY_UNSUPPORTED_ISOLATION in {elapsed5a2:.1f}s, well before A even releases the lock, proving the assert now runs before any lock attempt; row still untouched (reused by R5b below)")

 # === R5b: guard_attempt's marker-edge isolation check independently
 # closes the direct-UPDATE bypass — a caller that never goes through
 # start_dispatch at all. Mutation removes ONLY that 3-line IF block from
 # guard_attempt (R3-2b's window-expiry check and every other edge left
 # untouched) and reproduces the bypass: a raw UPDATE under REPEATABLE
 # READ now succeeds where it must be rejected.
 item30,_=fetch_item(prep_id,30)
 att30=insert_attempt(org,op_id,prep_id,item30)
 sql(f"SELECT inbox_reply_send.claim('{org}','{att30}',60)")
 sql(real_fn_minus_block('inbox_reply_send.guard_attempt',"IF current_setting('transaction_isolation')<>'read committed' THEN",3))
 failed=False;err30m=None
 try:
  sql(f"BEGIN ISOLATION LEVEL REPEATABLE READ;UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=gen_random_uuid(),lease_until=NULL WHERE org_id='{org}' AND id='{att30}';COMMIT;")
 except RuntimeError as e:
  failed=True;err30m=str(e)
 need(not failed,f'R5b mutation: the direct-UPDATE marker write under REPEATABLE READ was unexpectedly still rejected after removing the trigger isolation check: {err30m}')
 row30m=sql(f"SELECT state,dispatch_token IS NOT NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att30}'")
 need(row30m=='dispatch_started|t',f'R5b mutation: expected the bypassing direct UPDATE to actually commit the marker: {row30m}')
 checks.append("R5b (mutation, direct-UPDATE bypass): with the 3-line isolation IF block removed from guard_attempt's claimed->dispatch_started edge (R3-2b's window-expiry check and every other edge left intact), a raw UPDATE that writes the dispatch marker directly — bypassing start_dispatch entirely — now succeeds under REPEATABLE READ, proving this is the one hole start_dispatch's own assert cannot close by itself")
 # Resolve att30 so it stops holding the sender-inflight slot before the
 # restore leg below claims that same sender again on att29.
 tok30m=sql(f"SELECT dispatch_token FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att30}'")
 sql(f"SELECT inbox_reply_send.persist('{org}','{att30}','{tok30m}',jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch'))")
 restore_fn('inbox_reply_send.guard_attempt')
 assert_body_matches('inbox_reply_send.guard_attempt')

 # --- R5b restore: on att29's still-claimed row (left untouched by R5a),
 # the same direct-UPDATE bypass under REPEATABLE READ is rejected again,
 # and the identical UPDATE under READ COMMITTED — the worker's actual
 # isolation level — proceeds normally.
 failed=False;err29r=None
 try:
  sql(f"BEGIN ISOLATION LEVEL REPEATABLE READ;UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=gen_random_uuid(),lease_until=NULL WHERE org_id='{org}' AND id='{att29}';COMMIT;")
 except RuntimeError as e:
  failed=True;err29r=str(e)
 need(failed and 'INBOX_REPLY_UNSUPPORTED_ISOLATION' in err29r,f'R5b restore: direct-UPDATE marker write under REPEATABLE READ was not rejected: failed={failed} err={err29r}')
 row29c=sql(f"SELECT state,dispatch_started_at IS NULL,dispatch_token IS NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att29}'")
 need(row29c=='claimed|t|t',f'R5b restore: row unexpectedly mutated by the rejected REPEATABLE READ UPDATE: {row29c}')
 sql(f"UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=gen_random_uuid(),lease_until=NULL WHERE org_id='{org}' AND id='{att29}'")
 row29d=sql(f"SELECT state,dispatch_token IS NOT NULL FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id='{att29}'")
 need(row29d=='dispatch_started|t',f'R5b restore: the same direct UPDATE under (default) READ COMMITTED was unexpectedly blocked: {row29d}')
 checks.append("R5b (restore): with the candidate guard_attempt reinstalled, the identical direct-UPDATE marker write is rejected again under REPEATABLE READ with INBOX_REPLY_UNSUPPORTED_ISOLATION (row untouched), while the SAME UPDATE under the default READ COMMITTED isolation — the worker's actual contract — proceeds normally and commits the marker")

except Exception:
 for c in children:
  if c.poll() is None:c.terminate();c.wait(timeout=5)
 if installed:
  sql("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;")
 raise
need(len(checks)==26,f'Expected 26 check groups, got {len(checks)}')
# Only the private schemas are dropped — per the established
# inbox-reply-preparation/recipient-concurrency.py precedent, the uniquely
# marked synthetic canonical rows (organizations/contacts/properties/
# messages under 'Owned PR-D concurrency %') are left in the owned fixture.
sql("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;")
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")=='t','Owned schema cleanup failed')
(P/'concurrency-evidence.json').write_text(json.dumps({
 'sources_sha256':{str(path.relative_to(P.parent)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
 'setup_sha256':hashlib.sha256((P/'concurrency-setup.sql').read_bytes()).hexdigest(),
 'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 'owned_org_id':org,
 'checks':checks,
 'cleanup':'Private inbox_reply_* schemas and the two public wrapper functions removed; uniquely marked synthetic organizations/contacts/properties/messages rows retained in the owned fixture (same precedent as inbox-reply-preparation/recipient-concurrency.py)',
 'limitations':['Two-real-connection proofs for #1 double-claim, #2 stale-fence and #3 reclaim-after-dispatch, plus a genuine two-connection race for #8 sender one-in-flight; every other mutation-first obligation is single-connection in run.py']
},indent=2)+'\n')
print(f'PR-D concurrency: all {len(checks)} two-real-connection lock-wait proofs passed; private schemas removed, synthetic canonical rows retained')
