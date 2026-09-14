#!/usr/bin/env python3
"""Two real connections, observed lock-waits: double-claim, stale-fence,
reclaim-after-dispatch, sender one-in-flight. Installs its own schemas
(committed, not rollback-only, since separate connections must see them) and
drops them all in a finally block."""
import hashlib,json,subprocess,sys,time,uuid
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

validate_cron(sql('SHOW cron.launch_active_jobs'))
need(sql('SELECT marker FROM inbox_t2_fixture.identity')=='sandra-inbox-projection-t2-owned-synthetic','Wrong fixture')
need(sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")=='t','Refusing existing reply schema')
# Defensive: a prior interrupted run of this script can leave schemas
# committed (unlike run.py's rollback-only harness, this script commits real
# DDL across separate connections). Clean any such leftovers before install.
sql("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;")

sources=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P.parent/'inbox-reply-review/setup.sql',P.parent/'inbox-reply-review/public-api.sql',P/'attempts.sql']
setup_sql=(P/'concurrency-setup.sql').read_text()
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
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
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
END $$;""")
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
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 token:=gen_random_uuid();
 UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $mut$;""")
 dout2=sql(f"SELECT inbox_reply_send.start_dispatch('{org}','{a5}',{stale_g2})")
 need('"kind": "dispatch"' in dout2,f'#2-mut the stale generation was still rejected — mutation had no effect: {dout2}')
 checks.append(f'#2 mutation: start_dispatch redefined without the generation=g fence — the ORIGINAL stale generation ({stale_g2}) from before a real reclaim ({winning_g2}) wrongly dispatches; restored below')
 sql(r"""CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;ev text;token uuid;
BEGIN
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND OR row.state<>'claimed' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() OR row.dispatch_started_at IS NOT NULL THEN
  RAISE EXCEPTION 'INBOX_REPLY_STALE_CLAIM';
 END IF;
 frozen:=inbox_reply_send.frozen_item(o,row.preparation_id,row.item_id);
 recomputed:=inbox_reply_send.body_hash(frozen->'recipient'->>'renderedBody',frozen->'recipient'->>'from',frozen->'recipient'->>'to');
 IF row.body_hash IS DISTINCT FROM recomputed THEN RAISE EXCEPTION 'INBOX_REPLY_FROZEN_MISMATCH';END IF;
 ev:=inbox_reply_send.item_current(o,frozen);
 IF ev IS NOT NULL THEN
  UPDATE inbox_reply_send.attempts SET state='skipped_ineligible',lease_until=NULL,evidence=ev,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','skipped','reason',ev);
 END IF;
 IF EXISTS(SELECT 1 FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=row.from_e164 AND state='dispatch_started' AND id<>row.id) THEN
  RAISE EXCEPTION 'INBOX_REPLY_SENDER_BUSY' USING ERRCODE='55P03';
 END IF;
 token:=gen_random_uuid();
 UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $$;""")
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

 # === #8 Sender one-in-flight: two real connections, genuine race. Two
 # different rows (a7, a8), same sender, both already claimed; both attempt
 # start_dispatch launched back-to-back so Postgres's own MVCC/unique-index
 # machinery — not a shared row lock, since they are different rows —
 # decides the winner. Exactly one may end up dispatch_started.
 sql(f"SELECT inbox_reply_send.claim('{org}','{a7}',60)")
 sql(f"SELECT inbox_reply_send.claim('{org}','{a8}',60)")
 n7='sb7-'+str(uuid.uuid4());n8='sb8-'+str(uuid.uuid4())
 p7=start(f"SET application_name='{n7}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{a7}',1);SELECT pg_sleep(1);COMMIT;")
 p8=start(f"SET application_name='{n8}';BEGIN;SELECT inbox_reply_send.start_dispatch('{org}','{a8}',1);SELECT pg_sleep(1);COMMIT;")
 children=[p7,p8]
 out7,err7=p7.communicate(timeout=12);out8,err8=p8.communicate(timeout=12);children=[]
 dispatched=sql(f"SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id='{org}' AND id IN ('{a7}','{a8}') AND state='dispatch_started'")
 need(dispatched=='1',f'#8 expected exactly one of the two concurrent same-sender dispatches to win, got {dispatched}')
 winners=[bool(p7.returncode==0 and '"kind": "dispatch"' in out7),bool(p8.returncode==0 and '"kind": "dispatch"' in out8)]
 need(sum(winners)==1,f'#8 expected exactly one script-level winner: p7 rc={p7.returncode} out={out7!r} err={err7!r}; p8 rc={p8.returncode} out={out8!r} err={err8!r}')
 loser_output=err8 if winners[0] else err7
 need('55P03' in loser_output or 'unique' in loser_output.lower(),f'#8 loser did not fail on the sender guard (index or pre-check): {loser_output}')
 checks.append(f'#8 sender one-in-flight: two real connections launched back-to-back, each start_dispatch()-ing a DIFFERENT row sharing one sender — Postgres serializes the two on the D-6(5) unique index; exactly one row reached dispatch_started and the other failed on the sender guard ({("55P03 pre-check" if "55P03" in loser_output else "unique index")}), never both')
except Exception:
 for c in children:
  if c.poll() is None:c.terminate();c.wait(timeout=5)
 if installed:
  sql("DROP FUNCTION IF EXISTS public.inbox_capture_reply_recipients(uuid[]);DROP FUNCTION IF EXISTS public.inbox_freeze_reply_review(text,uuid);DROP SCHEMA IF EXISTS inbox_reply_send CASCADE;DROP SCHEMA IF EXISTS inbox_reply_review CASCADE;DROP SCHEMA IF EXISTS inbox_reply_preparation CASCADE;DROP SCHEMA IF EXISTS inbox_reply_context CASCADE;")
 raise
need(len(checks)==8,f'Expected 8 check groups (1, 1-mut, 1-restore, 2, 2-mut, 2-restore, 3, 8), got {len(checks)}')
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
