#!/usr/bin/env python3
"""Durable send-attempt ledger proof; rollback-only, no provider, no public grant."""
import hashlib,json,re,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=120)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")!='t':raise RuntimeError('Refusing existing reply schema')
sources=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P.parent/'inbox-reply-review/setup.sql',P.parent/'inbox-reply-review/public-api.sql',P/'attempts.sql']
parts=[]
for i,path in enumerate(sources):
 body=path.read_text()
 if not body.endswith('COMMIT;\n') or '\nBEGIN;\n' not in body:raise RuntimeError('Expected source transaction boundary')
 body=body.removesuffix('COMMIT;\n')
 if i:body=body.replace('\nBEGIN;\n','\n',1)
 parts.append(body)
# P2 (round 4): every restore-after-mutation below must reinstall the EXACT
# candidate definition from attempts.sql, never a hand-typed copy that can
# silently drift from a later round's edit (verify.py's file-hash binding
# cannot detect an installed-definition mismatch). ATTEMPTS_SQL is read once;
# every @@RESTORE_*@@ placeholder in `test` below is substituted with the
# current candidate body extracted straight out of it.
ATTEMPTS_SQL=(P/'attempts.sql').read_text()
def real_fn(qualified_name):
 pat=re.compile(r'CREATE FUNCTION\s+'+re.escape(qualified_name)+r'\(.*?\nEND \$\$;\n',re.DOTALL)
 m=pat.search(ATTEMPTS_SQL)
 if not m:raise RuntimeError(f'real_fn: could not extract {qualified_name} from attempts.sql — restore aborted')
 return 'CREATE OR REPLACE FUNCTION '+m.group(0)[len('CREATE FUNCTION '):]
def real_fn_minus_edge(qualified_name,edge_marker):
 """Same as real_fn, but with the single CASE line containing edge_marker
 removed — used ONLY for the deliberate single-edge-removed mutation (#4),
 so every OTHER line (including later rounds' additions, e.g. R3-2b) still
 matches the candidate exactly; only the one intended edge is missing."""
 lines=real_fn(qualified_name).split('\n')
 kept=[l for l in lines if edge_marker not in l]
 if len(kept)==len(lines):raise RuntimeError(f'real_fn_minus_edge: {edge_marker!r} not found in {qualified_name}')
 return '\n'.join(kept)
test=r"""
DO $test$
DECLARE
 o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();sess uuid:=gen_random_uuid();
 s uuid:=gen_random_uuid();
 n integer:=24;i integer;
 cids uuid[];pids uuid[];ctids uuid[];
 targets jsonb:='[]';drafts jsonb:='[]';
 capture jsonb;freeze_result jsonb;prep_id uuid;items jsonb;
 op_id uuid:=gen_random_uuid();k uuid:=gen_random_uuid();
 item1 jsonb;item2 jsonb;item3 jsonb;item4 jsonb;item5 jsonb;item6 jsonb;item7 jsonb;item8 jsonb;item9 jsonb;item10 jsonb;item11 jsonb;item12 jsonb;item13 jsonb;item14a jsonb;item14b jsonb;item15 jsonb;item16 jsonb;item17 jsonb;item18 jsonb;item19 jsonb;item20 jsonb;item21 jsonb;item22 jsonb;item23 jsonb;item24 jsonb;
 att1 uuid;att2 uuid;att3 uuid;att4 uuid;att5 uuid;att6 uuid;att7 uuid;att8 uuid;att9 uuid;att10 uuid;att11 uuid;att12 uuid;att13 uuid;att14a uuid;att14b uuid;att15 uuid;att16 uuid;att17 uuid;att18 uuid;att19 uuid;att20 uuid;att21 uuid;att22 uuid;att23 uuid;att24 uuid;
 a jsonb;b jsonb;failed boolean;chosen_state text;dest14 text;tok1 uuid;tok5 uuid;tok15 uuid;att_item7_ord2 uuid;
BEGIN
 -- quiet_hours() gates on wall-clock local time; no single US zone in its
 -- table keeps 08:00-21:00 local safely inside the UTC hour this harness
 -- might run in (no offset in that table falls in [-3,+9]). None of the
 -- 15 proof obligations here concern quiet_hours transitions, so pin it
 -- to always-open for the duration of this rolled-back transaction only
 -- (ROLLBACK below restores the real function) rather than chase a magic
 -- state/time combination.
 CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;
 chosen_state:='MO';
 INSERT INTO organizations(id,name) VALUES(o,'Owned PR-D send-attempt ledger');
 INSERT INTO auth.users(id,email) VALUES(u,u::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(o,u,'owner','active');
 INSERT INTO auth.sessions(id,user_id,not_after) VALUES(sess,u,clock_timestamp()+interval '1 hour');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',sess,'exp',4102444800)::text,true);
 INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES(s,o,'sendillo','+18165550101','active');
 -- n conversations, each its own contact/property, distinct destination.
 FOR i IN 1..n LOOP
  DECLARE cid uuid:=gen_random_uuid();pid uuid:=gen_random_uuid();ctid uuid:=gen_random_uuid();dest text:='+120255'||lpad(i::text,5,'0');
  BEGIN
   INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(ctid,o,'Contact'||i,dest,'mobile');
   INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,ctid,'sms','opt_in_confirmed','owned_prd_test');
   INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(pid,o,'Owned PR-D property '||i,chosen_state,ctid);
   INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),o,cid,ctid,pid,'sms','inbound','received','Owned PR-D inbound '||i,dest,'+18165550101');
   cids:=cids||cid;pids:=pids||pid;ctids:=ctids||ctid;
   targets:=targets||jsonb_build_array(jsonb_build_object('kind','conversation','id',cid));
  END;
 END LOOP;
 -- item 14b shares item14a's contact/phone (destination collision for D2).
 DECLARE cid uuid:=gen_random_uuid();
 BEGIN
  INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),o,cid,ctids[14],pids[14],'sms','inbound','received','Owned PR-D inbound 14b','+120255'||lpad('14','5','0'),'+18165550101');
  cids:=cids||cid;
  targets:=targets||jsonb_build_array(jsonb_build_object('kind','conversation','id',cid));
 END;
 UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;
 EXECUTE 'SET LOCAL ROLE authenticated';
 capture:=public.inbox_capture_reply_recipients(cids);
 EXECUTE 'RESET ROLE';
 SELECT jsonb_agg(jsonb_build_object('conversationId',item->>'conversation_id','body','Hi there','dependencies',item->'dependencies','exclusion',NULL) ORDER BY item->>'conversation_id') INTO drafts FROM jsonb_array_elements(capture->'items') item;
 EXECUTE 'SET LOCAL ROLE authenticated';
 freeze_result:=public.inbox_freeze_reply_review(jsonb_build_object('targets',targets,'drafts',drafts,'template','Hi there')::text,gen_random_uuid());
 EXECUTE 'RESET ROLE';
 IF freeze_result->>'recipientCount' IS NULL OR NOT(freeze_result->'blockers' <@ '["duplicate_destination"]'::jsonb) THEN RAISE EXCEPTION 'Unexpected freeze blockers: %',freeze_result;END IF;
 prep_id:=(freeze_result->>'preparationId')::uuid;
 SELECT p.items INTO items FROM inbox_reply_review.preparations p WHERE p.id=prep_id;
 item1:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[1]::text);
 item2:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[2]::text);
 item3:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[3]::text);
 item4:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[4]::text);
 item5:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[5]::text);
 item6:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[6]::text);
 item7:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[7]::text);
 item8:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[8]::text);
 item9:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[9]::text);
 item10:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[10]::text);
 item11:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[11]::text);
 item12:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[12]::text);
 item13:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[13]::text);
 item14a:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[14]::text);
 item14b:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[25]::text);
 item15:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[15]::text);
 item16:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[16]::text);
 item17:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[17]::text);
 item18:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[18]::text);
 item19:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[19]::text);
 item20:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[20]::text);
 item21:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[21]::text);
 item22:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[22]::text);
 item23:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[23]::text);
 item24:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[24]::text);
 IF item1 IS NULL OR item14b IS NULL THEN RAISE EXCEPTION 'Item lookup failed';END IF;
 IF item14a->'recipient'->>'to' IS DISTINCT FROM item14b->'recipient'->>'to' THEN RAISE EXCEPTION 'Expected shared destination for item14a/b: % vs %',item14a->'recipient'->>'to',item14b->'recipient'->>'to';END IF;

 INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key) VALUES(o,op_id,u,prep_id,k);

 -- === Happy path: item1 through the full lifecycle to a terminal 'delivered' row ===
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item1->>'id')::uuid,1,(item1->'recipient'->>'contactId')::uuid,item1->'recipient'->>'from',item1->'recipient'->>'to',inbox_reply_send.body_hash(item1->'recipient'->>'renderedBody',item1->'recipient'->>'from',item1->'recipient'->>'to'),'approved')
  RETURNING id INTO att1;

 a:=inbox_reply_send.claim(o,att1);
 IF a->>'kind'<>'claimed' OR a->>'generation'<>'1' THEN RAISE EXCEPTION 'claim() 1 mismatch: %',a;END IF;

 -- Expire the lease via a legitimate generation-bumping owner write (models
 -- real time passing, not a guard bypass) then reclaim.
 UPDATE inbox_reply_send.attempts SET generation=generation+1,lease_until=clock_timestamp()-interval '1 second' WHERE org_id=o AND id=att1;
 a:=inbox_reply_send.claim(o,att1);
 IF a->>'kind'<>'claimed' OR a->>'generation'<>'3' THEN RAISE EXCEPTION 'reclaim mismatch: %',a;END IF;

 a:=inbox_reply_send.start_dispatch(o,att1,3);
 IF a->>'kind'<>'dispatch' OR a->>'from' IS DISTINCT FROM item1->'recipient'->>'from' OR a->>'to' IS DISTINCT FROM item1->'recipient'->>'to' OR a->>'body' IS DISTINCT FROM item1->'recipient'->>'renderedBody' THEN
  RAISE EXCEPTION 'start_dispatch mismatch: %',a;
 END IF;
 tok1:=(a->>'token')::uuid;

 -- Reclaim-after-dispatch (#3, single-conn functional half): claim() on a
 -- dispatch_started row must label uncertain, never re-claim.
 b:=inbox_reply_send.claim(o,att1);
 IF b->>'kind'<>'existing' OR b->>'state'<>'uncertain' THEN RAISE EXCEPTION 'Re-entry mislabelled: %',b;END IF;
 IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1)<>'uncertain' THEN RAISE EXCEPTION 'Row not uncertain after re-entry';END IF;
 IF (SELECT evidence FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1)<>'reentered_without_result' THEN RAISE EXCEPTION 'Wrong re-entry evidence';END IF;

 -- Wrong token never applies (#9).
 failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att1,gen_random_uuid(),jsonb_build_object('kind','accepted','externalId','WRONG'));EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_STALE_TOKEN' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Wrong token accepted';END IF;

 -- Correct (original) token still reconciles from uncertain (#9, #10 tail).
 a:=inbox_reply_send.persist(o,att1,tok1,jsonb_build_object('kind','accepted','externalId','PROV-1','status','sent'));
 IF a->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'persist accepted mismatch: %',a;END IF;

 -- Idempotent re-ack with the SAME reference is a no-op (#9).
 DECLARE rv0 bigint;BEGIN
  SELECT receipt_version INTO rv0 FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1;
  b:=inbox_reply_send.persist(o,att1,tok1,jsonb_build_object('kind','accepted','externalId','PROV-1'));
  IF b->>'state'<>'provider_accepted' OR (b->>'receipt_version')::bigint<>rv0 THEN RAISE EXCEPTION 'Idempotent re-ack mutated: %',b;END IF;
  b:=inbox_reply_send.persist(o,att1,tok1,jsonb_build_object('kind','uncertain','reason','provider_timeout'));
  IF b->>'state'<>'provider_accepted' OR (b->>'receipt_version')::bigint<>rv0 THEN RAISE EXCEPTION 'uncertain-after-accepted mutated: %',b;END IF;
 END;

 -- Contradictory receipt (#9): different externalId after provider_accepted raises.
 failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att1,tok1,jsonb_build_object('kind','accepted','externalId','PROV-DIFFERENT'));EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_CONTRADICTORY_RECEIPT' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Contradictory receipt accepted';END IF;

 -- provider_accepted -> delivered is a real trigger edge (PR-G territory);
 -- exercised directly here since no PR-D function performs it yet.
 UPDATE inbox_reply_send.attempts SET state='delivered' WHERE org_id=o AND id=att1;
 RAISE NOTICE 'Happy path through item1 OK';

 -- === #4 Terminal resurrection + #5 rejected_unsent unreachable ===
 -- With the trigger enabled, every out-of-matrix UPDATE raises.
 failed:=false;BEGIN UPDATE inbox_reply_send.attempts SET state='approved' WHERE org_id=o AND id=att1;EXCEPTION WHEN raise_exception THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Terminal delivered row resurrected to approved';END IF;
 failed:=false;BEGIN UPDATE inbox_reply_send.attempts SET state='claimed',lease_until=clock_timestamp()+interval '1 minute' WHERE org_id=o AND id=att1;EXCEPTION WHEN raise_exception THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Terminal delivered row resurrected to claimed';END IF;
 failed:=false;BEGIN UPDATE inbox_reply_send.attempts SET state='rejected_unsent' WHERE org_id=o AND id=att1;EXCEPTION WHEN raise_exception THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Terminal delivered row moved to rejected_unsent';END IF;

 -- claim()/persist() on a terminal row return stored data without mutating.
 DECLARE rv1 bigint;BEGIN
  SELECT receipt_version INTO rv1 FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1;
  b:=inbox_reply_send.claim(o,att1);
  IF b->>'kind'<>'existing' OR b->>'state'<>'delivered' THEN RAISE EXCEPTION 'claim() on terminal row mutated: %',b;END IF;
  -- D-11: from a genuinely terminal state (delivered), persist(uncertain) is
  -- a documented no-op-stored reply, not a raise; persist(not_attempted) IS
  -- an invalid transition from here and must raise.
  b:=inbox_reply_send.persist(o,att1,tok1,jsonb_build_object('kind','uncertain','reason','late'));
  IF b->>'state'<>'delivered' OR (b->>'receipt_version')::bigint<>rv1 THEN RAISE EXCEPTION 'persist(uncertain) on terminal row mutated: %',b;END IF;
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att1,tok1,jsonb_build_object('kind','not_attempted','reason','late'));EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'persist(not_attempted) moved a terminal row';END IF;
  IF (SELECT receipt_version FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1)<>rv1 THEN RAISE EXCEPTION 'Terminal row receipt_version changed without a valid transition';END IF;
 END;

 -- Mutation: disable the trigger entirely (the guard), watch resurrection and
 -- the rejected_unsent edge both succeed — proving the trigger, not
 -- incidental application behavior, was blocking them. Restore, reverify.
 ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
 UPDATE inbox_reply_send.attempts SET state='approved',lease_until=NULL,dispatch_started_at=NULL,dispatch_token=NULL,provider_reference=NULL,provider_status=NULL,evidence=NULL WHERE org_id=o AND id=att1;
 IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1)<>'approved' THEN RAISE EXCEPTION 'Mutation did not actually break resurrection guard';END IF;
 -- CHECK((dispatch_started_at IS NULL)=(state IN ('approved','claimed',
 -- 'skipped_ineligible'))) still applies even with the trigger disabled — it
 -- is a column-level CHECK, not this trigger — so rejected_unsent needs a
 -- non-NULL dispatch marker to be a well-formed row at all.
 UPDATE inbox_reply_send.attempts SET state='rejected_unsent',dispatch_started_at=clock_timestamp(),dispatch_token=gen_random_uuid() WHERE org_id=o AND id=att1;
 IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att1)<>'rejected_unsent' THEN RAISE EXCEPTION 'Mutation did not actually break rejected_unsent guard';END IF;
 -- Restore: put the row back to its legitimate terminal 'delivered' state
 -- while the trigger is still disabled (bypass is intentional here only to
 -- undo the deliberate corruption above), then re-enable the guard.
 UPDATE inbox_reply_send.attempts SET state='delivered',provider_reference='PROV-1',lease_until=NULL,evidence=NULL WHERE org_id=o AND id=att1;
 ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;
 failed:=false;BEGIN UPDATE inbox_reply_send.attempts SET state='approved' WHERE org_id=o AND id=att1;EXCEPTION WHEN raise_exception THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Guard not actually restored (resurrection)';END IF;
 failed:=false;BEGIN UPDATE inbox_reply_send.attempts SET state='rejected_unsent' WHERE org_id=o AND id=att1;EXCEPTION WHEN raise_exception THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Guard not actually restored (rejected_unsent)';END IF;
 RAISE NOTICE '#4/#5 terminal resurrection + rejected_unsent unreachable OK';

 -- === #6 Partial-unique bypass ===
 -- item2: dispatch_started -> confirmed_not_submitted, then an ordinal-2
 -- successor for the SAME item succeeds (the one state that permits it).
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item2->>'id')::uuid,1,(item2->'recipient'->>'contactId')::uuid,item2->'recipient'->>'from',item2->'recipient'->>'to',inbox_reply_send.body_hash(item2->'recipient'->>'renderedBody',item2->'recipient'->>'from',item2->'recipient'->>'to'),'approved')
  RETURNING id INTO att2;
 PERFORM inbox_reply_send.claim(o,att2);
 a:=inbox_reply_send.start_dispatch(o,att2,1);
 IF a->>'kind'<>'dispatch' THEN RAISE EXCEPTION 'item2 start_dispatch mismatch: %',a;END IF;
 a:=inbox_reply_send.persist(o,att2,(a->>'token')::uuid,jsonb_build_object('kind','not_attempted','reason','invalid_input'));
 IF a->>'state'<>'confirmed_not_submitted' THEN RAISE EXCEPTION 'item2 persist mismatch: %',a;END IF;
 -- persist() from confirmed_not_submitted always raises, regardless of kind.
 failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att2,gen_random_uuid(),jsonb_build_object('kind','uncertain','reason','x'));EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_STALE_TOKEN' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'persist() from confirmed_not_submitted with wrong token should still raise stale token first';END IF;

 -- Allowed successor: prior confirmed_not_submitted.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item2->>'id')::uuid,2,att2,(item2->'recipient'->>'contactId')::uuid,item2->'recipient'->>'from',item2->'recipient'->>'to',inbox_reply_send.body_hash(item2->'recipient'->>'renderedBody',item2->'recipient'->>'from',item2->'recipient'->>'to'),'approved');

 -- Blocked successors: prior in each of the 8 protected states. Helper items
 -- 3..10, each driven into exactly one of those states, then an ordinal-2
 -- insert must unique_violate on the live-attempt index.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item3->>'id')::uuid,1,(item3->'recipient'->>'contactId')::uuid,item3->'recipient'->>'from',item3->'recipient'->>'to',inbox_reply_send.body_hash(item3->'recipient'->>'renderedBody',item3->'recipient'->>'from',item3->'recipient'->>'to'),'approved')
  RETURNING id INTO att3; -- state: approved

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item4->>'id')::uuid,1,(item4->'recipient'->>'contactId')::uuid,item4->'recipient'->>'from',item4->'recipient'->>'to',inbox_reply_send.body_hash(item4->'recipient'->>'renderedBody',item4->'recipient'->>'from',item4->'recipient'->>'to'),'approved')
  RETURNING id INTO att4;
 PERFORM inbox_reply_send.claim(o,att4); -- state: claimed

 -- item5 is left in 'claimed' for now (not yet dispatch_started) — only ONE
 -- attempt may be dispatch_started per sender at a time (D-6(5)), so item5's
 -- own dispatch_started is deferred to the very end of this block, after
 -- every other item below has already resolved out of dispatch_started.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item5->>'id')::uuid,1,(item5->'recipient'->>'contactId')::uuid,item5->'recipient'->>'from',item5->'recipient'->>'to',inbox_reply_send.body_hash(item5->'recipient'->>'renderedBody',item5->'recipient'->>'from',item5->'recipient'->>'to'),'approved')
  RETURNING id INTO att5;
 PERFORM inbox_reply_send.claim(o,att5); -- state: claimed (not yet dispatch_started)

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item6->>'id')::uuid,1,(item6->'recipient'->>'contactId')::uuid,item6->'recipient'->>'from',item6->'recipient'->>'to',inbox_reply_send.body_hash(item6->'recipient'->>'renderedBody',item6->'recipient'->>'from',item6->'recipient'->>'to'),'approved')
  RETURNING id INTO att6;
 PERFORM inbox_reply_send.claim(o,att6);
 a:=inbox_reply_send.start_dispatch(o,att6,1);
 PERFORM inbox_reply_send.persist(o,att6,(a->>'token')::uuid,jsonb_build_object('kind','accepted','externalId','PROV-6')); -- state: provider_accepted

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item7->>'id')::uuid,1,(item7->'recipient'->>'contactId')::uuid,item7->'recipient'->>'from',item7->'recipient'->>'to',inbox_reply_send.body_hash(item7->'recipient'->>'renderedBody',item7->'recipient'->>'from',item7->'recipient'->>'to'),'approved')
  RETURNING id INTO att7;
 PERFORM inbox_reply_send.claim(o,att7);
 PERFORM inbox_reply_send.start_dispatch(o,att7,1);
 PERFORM inbox_reply_send.claim(o,att7); -- re-entry: state uncertain

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item8->>'id')::uuid,1,(item8->'recipient'->>'contactId')::uuid,item8->'recipient'->>'from',item8->'recipient'->>'to',inbox_reply_send.body_hash(item8->'recipient'->>'renderedBody',item8->'recipient'->>'from',item8->'recipient'->>'to'),'approved')
  RETURNING id INTO att8;
 PERFORM inbox_reply_send.claim(o,att8);
 a:=inbox_reply_send.start_dispatch(o,att8,1);
 PERFORM inbox_reply_send.persist(o,att8,(a->>'token')::uuid,jsonb_build_object('kind','accepted','externalId','PROV-8'));
 UPDATE inbox_reply_send.attempts SET state='delivered' WHERE org_id=o AND id=att8; -- state: delivered

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item9->>'id')::uuid,1,(item9->'recipient'->>'contactId')::uuid,item9->'recipient'->>'from',item9->'recipient'->>'to',inbox_reply_send.body_hash(item9->'recipient'->>'renderedBody',item9->'recipient'->>'from',item9->'recipient'->>'to'),'approved')
  RETURNING id INTO att9;
 PERFORM inbox_reply_send.claim(o,att9);
 a:=inbox_reply_send.start_dispatch(o,att9,1);
 PERFORM inbox_reply_send.persist(o,att9,(a->>'token')::uuid,jsonb_build_object('kind','accepted','externalId','PROV-9'));
 UPDATE inbox_reply_send.attempts SET state='delivery_failed' WHERE org_id=o AND id=att9; -- state: delivery_failed

 -- item10: made ineligible after freeze (contact suppressed) so start_dispatch
 -- lands it in skipped_ineligible. Doubles as proof #12's suppression case.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item10->>'id')::uuid,1,(item10->'recipient'->>'contactId')::uuid,item10->'recipient'->>'from',item10->'recipient'->>'to',inbox_reply_send.body_hash(item10->'recipient'->>'renderedBody',item10->'recipient'->>'from',item10->'recipient'->>'to'),'approved')
  RETURNING id INTO att10;
 PERFORM inbox_reply_send.claim(o,att10);
 INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES(o,'sms',item10->'recipient'->>'to','owned_prd_test');
 a:=inbox_reply_send.start_dispatch(o,att10,1);
 IF a->>'kind'<>'skipped' OR a->>'reason'<>'sms_suppressed' THEN RAISE EXCEPTION 'item10 expected skip on suppression: %',a;END IF;
 IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att10)<>'skipped_ineligible' THEN RAISE EXCEPTION 'item10 not skipped_ineligible';END IF;

 -- Now that no other attempt is dispatch_started, item5 can take the marker.
 a:=inbox_reply_send.start_dispatch(o,att5,1); -- state: dispatch_started
 tok5:=(a->>'token')::uuid;

 DECLARE blocked_items uuid[]:=ARRAY[att3,att4,att5,att6,att7,att8,att9,att10];blocked_item_ids uuid[]:=ARRAY[(item3->>'id')::uuid,(item4->>'id')::uuid,(item5->>'id')::uuid,(item6->>'id')::uuid,(item7->>'id')::uuid,(item8->>'id')::uuid,(item9->>'id')::uuid,(item10->>'id')::uuid];items_src jsonb[]:=ARRAY[item3,item4,item5,item6,item7,item8,item9,item10];idx integer;
 BEGIN
  FOR idx IN 1..8 LOOP
   failed:=false;
   BEGIN
    INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state)
     VALUES(o,gen_random_uuid(),op_id,prep_id,blocked_item_ids[idx],2,blocked_items[idx],(items_src[idx]->'recipient'->>'contactId')::uuid,items_src[idx]->'recipient'->>'from',items_src[idx]->'recipient'->>'to',inbox_reply_send.body_hash(items_src[idx]->'recipient'->>'renderedBody',items_src[idx]->'recipient'->>'from',items_src[idx]->'recipient'->>'to'),'approved');
   EXCEPTION WHEN unique_violation THEN failed:=true;
   END;
   IF NOT failed THEN RAISE EXCEPTION 'Ordinal-2 successor wrongly admitted for blocked item %',idx;END IF;
  END LOOP;
 END;
 RAISE NOTICE '#6 partial-unique bypass (8 blocked states + 1 allowed) OK';

 -- Mutation: widen the live-attempt index to ALSO exempt 'uncertain', watch
 -- an ordinal-2 successor for item7 (whose ordinal-1 sits in 'uncertain')
 -- now wrongly succeed; restore the correct index, reverify a further
 -- successor (ordinal-3, chained off the now-'approved' ordinal-2 row) is
 -- blocked again exactly as cond7 requires.
 DROP INDEX inbox_reply_send.inbox_reply_send_live_attempt;
 CREATE UNIQUE INDEX inbox_reply_send_live_attempt ON inbox_reply_send.attempts(org_id,preparation_id,item_id) WHERE state NOT IN ('rejected_unsent','confirmed_not_submitted','uncertain');
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item7->>'id')::uuid,2,att7,(item7->'recipient'->>'contactId')::uuid,item7->'recipient'->>'from',item7->'recipient'->>'to',inbox_reply_send.body_hash(item7->'recipient'->>'renderedBody',item7->'recipient'->>'from',item7->'recipient'->>'to'),'approved')
  RETURNING id INTO att_item7_ord2;
 -- Clean up the wrongly-admitted row before restoring the correct index (it
 -- would otherwise make the correct index un-creatable, which is itself
 -- exactly the point — two simultaneously live rows for one item). Deleting
 -- is only possible with the transition-guard trigger off; this bypass is
 -- purely to undo the deliberate corruption, not part of the guard being
 -- proven.
 ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
 DELETE FROM inbox_reply_send.attempts WHERE org_id=o AND id=att_item7_ord2;
 ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;
 DROP INDEX inbox_reply_send.inbox_reply_send_live_attempt;
 CREATE UNIQUE INDEX inbox_reply_send_live_attempt ON inbox_reply_send.attempts(org_id,preparation_id,item_id) WHERE state NOT IN ('rejected_unsent','confirmed_not_submitted');
 failed:=false;
 BEGIN
  -- att_item7_ord2 was deleted above (bypass cleanup); att7 (ordinal 1,
  -- still 'uncertain') is free again as a prior reference and ordinal 2 is
  -- free again as a slot.
  INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,prior_attempt_id,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(item7->>'id')::uuid,2,att7,(item7->'recipient'->>'contactId')::uuid,item7->'recipient'->>'from',item7->'recipient'->>'to',inbox_reply_send.body_hash(item7->'recipient'->>'renderedBody',item7->'recipient'->>'from',item7->'recipient'->>'to'),'approved');
 EXCEPTION WHEN unique_violation THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'Restored index failed to block a live successor';END IF;
 RAISE NOTICE '#6 mutation (uncertain wrongly exempted, then restored) OK';

 -- Free the sender: only one attempt may hold dispatch_started at a time
 -- (D-6(5)) and att5 has held it since #6; resolve it before any later
 -- section needs the marker again.
 a:=inbox_reply_send.persist(o,att5,tok5,jsonb_build_object('kind','accepted','externalId','PROV-5'));
 IF a->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'item5 cleanup persist mismatch: %',a;END IF;

 -- === #7 D2 destination guard ===
 -- item14a/item14b share a destination (same contact, two conversations).
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item14a->>'id')::uuid,1,(item14a->'recipient'->>'contactId')::uuid,item14a->'recipient'->>'from',item14a->'recipient'->>'to',inbox_reply_send.body_hash(item14a->'recipient'->>'renderedBody',item14a->'recipient'->>'from',item14a->'recipient'->>'to'),'approved')
  RETURNING id INTO att14a;
 failed:=false;
 BEGIN
  INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(item14b->>'id')::uuid,1,(item14b->'recipient'->>'contactId')::uuid,item14b->'recipient'->>'from',item14b->'recipient'->>'to',inbox_reply_send.body_hash(item14b->'recipient'->>'renderedBody',item14b->'recipient'->>'from',item14b->'recipient'->>'to'),'approved');
 EXCEPTION WHEN unique_violation THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'D2 destination guard did not block a second live attempt to the same destination';END IF;

 -- Move item14a's attempt to 'uncertain' (out of the guarded set), then the
 -- same insert for item14b succeeds.
 PERFORM inbox_reply_send.claim(o,att14a);
 PERFORM inbox_reply_send.start_dispatch(o,att14a,1);
 PERFORM inbox_reply_send.claim(o,att14a); -- re-entry -> uncertain
 IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att14a)<>'uncertain' THEN RAISE EXCEPTION 'item14a not uncertain';END IF;
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item14b->>'id')::uuid,1,(item14b->'recipient'->>'contactId')::uuid,item14b->'recipient'->>'from',item14b->'recipient'->>'to',inbox_reply_send.body_hash(item14b->'recipient'->>'renderedBody',item14b->'recipient'->>'from',item14b->'recipient'->>'to'),'approved')
  RETURNING id INTO att14b;
 RAISE NOTICE '#7 D2 destination guard (positive case) OK';

 -- Mutation: widen the destination guard to ALSO cover 'uncertain', watch a
 -- (previously succeeding) insert now wrongly fail; restore, reverify success.
 ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt; DELETE FROM inbox_reply_send.attempts WHERE org_id=o AND id=att14b; ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;
 DROP INDEX inbox_reply_send.inbox_reply_send_destination_guard;
 CREATE UNIQUE INDEX inbox_reply_send_destination_guard ON inbox_reply_send.attempts(org_id,to_e164) WHERE state IN ('approved','claimed','dispatch_started','uncertain');
 failed:=false;
 BEGIN
  INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(item14b->>'id')::uuid,1,(item14b->'recipient'->>'contactId')::uuid,item14b->'recipient'->>'from',item14b->'recipient'->>'to',inbox_reply_send.body_hash(item14b->'recipient'->>'renderedBody',item14b->'recipient'->>'from',item14b->'recipient'->>'to'),'approved');
 EXCEPTION WHEN unique_violation THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'Mutation did not actually widen the D2 predicate';END IF;
 DROP INDEX inbox_reply_send.inbox_reply_send_destination_guard;
 CREATE UNIQUE INDEX inbox_reply_send_destination_guard ON inbox_reply_send.attempts(org_id,to_e164) WHERE state IN ('approved','claimed','dispatch_started');
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item14b->>'id')::uuid,1,(item14b->'recipient'->>'contactId')::uuid,item14b->'recipient'->>'from',item14b->'recipient'->>'to',inbox_reply_send.body_hash(item14b->'recipient'->>'renderedBody',item14b->'recipient'->>'from',item14b->'recipient'->>'to'),'approved')
  RETURNING id INTO att14b;
 RAISE NOTICE '#7 D2 destination guard mutation (widened, then restored) OK';

 -- === #8 Sender one-in-flight (single-connection mutation half; the real
 -- two-real-connection race proof lives in concurrency.py) ===
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item15->>'id')::uuid,1,(item15->'recipient'->>'contactId')::uuid,item15->'recipient'->>'from',item15->'recipient'->>'to',inbox_reply_send.body_hash(item15->'recipient'->>'renderedBody',item15->'recipient'->>'from',item15->'recipient'->>'to'),'approved')
  RETURNING id INTO att15;
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item16->>'id')::uuid,1,(item16->'recipient'->>'contactId')::uuid,item16->'recipient'->>'from',item16->'recipient'->>'to',inbox_reply_send.body_hash(item16->'recipient'->>'renderedBody',item16->'recipient'->>'from',item16->'recipient'->>'to'),'approved')
  RETURNING id INTO att16;
 PERFORM inbox_reply_send.claim(o,att15);
 PERFORM inbox_reply_send.claim(o,att16);
 a:=inbox_reply_send.start_dispatch(o,att15,1);
 IF a->>'kind'<>'dispatch' THEN RAISE EXCEPTION 'item15 start_dispatch mismatch: %',a;END IF;
 tok15:=(a->>'token')::uuid;
 -- Correct behavior: a second item sharing the same sender cannot dispatch
 -- while item15 is still dispatch_started; the claim's lease stays intact.
 failed:=false;BEGIN PERFORM inbox_reply_send.start_dispatch(o,att16,1);EXCEPTION WHEN OTHERS THEN IF SQLSTATE='55P03' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Sender one-in-flight guard did not block a second dispatch';END IF;
 IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att16)<>'claimed' THEN RAISE EXCEPTION 'item16 lease not left intact after SENDER_BUSY';END IF;

 -- Mutation: with the pre-check bypassed (simulated by disabling the trigger
 -- so the pre-check's own start_dispatch write can proceed) AND the
 -- supporting unique index dropped, a second item can wrongly reach
 -- dispatch_started for the same sender while the first is still there.
 DROP INDEX inbox_reply_send.inbox_reply_send_sender_inflight;
 ALTER TABLE inbox_reply_send.attempts DISABLE TRIGGER guard_reply_send_attempt;
 UPDATE inbox_reply_send.attempts SET state='dispatch_started',lease_until=NULL,dispatch_started_at=clock_timestamp(),dispatch_token=gen_random_uuid() WHERE org_id=o AND id=att16;
 ALTER TABLE inbox_reply_send.attempts ENABLE TRIGGER guard_reply_send_attempt;
 IF (SELECT count(*) FROM inbox_reply_send.attempts WHERE org_id=o AND from_e164=(item15->'recipient'->>'from') AND state='dispatch_started')<>2 THEN
  RAISE EXCEPTION 'Mutation did not actually allow two simultaneous in-flight sends';
 END IF;
 -- Restore: resolve att16 back out of dispatch_started and recreate the index.
 a:=inbox_reply_send.persist(o,att16,(SELECT dispatch_token FROM inbox_reply_send.attempts WHERE org_id=o AND id=att16),jsonb_build_object('kind','accepted','externalId','PROV-16'));
 CREATE UNIQUE INDEX inbox_reply_send_sender_inflight ON inbox_reply_send.attempts(org_id,from_e164) WHERE state='dispatch_started';
 RAISE NOTICE '#8 sender one-in-flight (single-conn mutation half) OK';

 -- Free the sender again: att15 has held dispatch_started since #8.
 a:=inbox_reply_send.persist(o,att15,tok15,jsonb_build_object('kind','accepted','externalId','PROV-15'));
 IF a->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'item15 cleanup persist mismatch: %',a;END IF;

 -- === #11 P-GATE binding ===
 -- (a) frozen mismatch: tamper the FROZEN row's renderedBody after a matching
 -- attempt was already inserted; start_dispatch must recompute and refuse.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item11->>'id')::uuid,1,(item11->'recipient'->>'contactId')::uuid,item11->'recipient'->>'from',item11->'recipient'->>'to',inbox_reply_send.body_hash(item11->'recipient'->>'renderedBody',item11->'recipient'->>'from',item11->'recipient'->>'to'),'approved')
  RETURNING id INTO att11;
 PERFORM inbox_reply_send.claim(o,att11);
 ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
 UPDATE inbox_reply_review.preparations p2u SET items=(SELECT jsonb_agg(CASE WHEN value->>'id'=item11->>'id' THEN jsonb_set(value,'{recipient,renderedBody}','"Tampered body"') ELSE value END) FROM jsonb_array_elements(p2u.items) value) WHERE p2u.id=prep_id;
 ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
 failed:=false;BEGIN PERFORM inbox_reply_send.start_dispatch(o,att11,1);EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_FROZEN_MISMATCH' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Tampered frozen body was not caught at dispatch';END IF;
 -- Restore the frozen row so it no longer poisons anything read later.
 ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
 UPDATE inbox_reply_review.preparations p2u SET items=(SELECT jsonb_agg(CASE WHEN value->>'id'=item11->>'id' THEN jsonb_set(value,'{recipient,renderedBody}',to_jsonb(item11->'recipient'->>'renderedBody')) ELSE value END) FROM jsonb_array_elements(p2u.items) value) WHERE p2u.id=prep_id;
 ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;

 -- (b) a frozen item with exclusion IS NOT NULL is uninsertable. Tamper
 -- item13's frozen exclusion, attempt an insert, watch the INSERT trigger
 -- raise via frozen_item, then restore.
 ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
 UPDATE inbox_reply_review.preparations p2u SET items=(SELECT jsonb_agg(CASE WHEN value->>'id'=item13->>'id' THEN value||jsonb_build_object('exclusion','sms_suppressed') ELSE value END) FROM jsonb_array_elements(p2u.items) value) WHERE p2u.id=prep_id;
 ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
 failed:=false;BEGIN INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item13->>'id')::uuid,1,(item13->'recipient'->>'contactId')::uuid,item13->'recipient'->>'from',item13->'recipient'->>'to',inbox_reply_send.body_hash(item13->'recipient'->>'renderedBody',item13->'recipient'->>'from',item13->'recipient'->>'to'),'approved');
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_ITEM_UNAVAILABLE' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Excluded frozen item was insertable';END IF;
 ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
 UPDATE inbox_reply_review.preparations p2u SET items=(SELECT jsonb_agg(CASE WHEN value->>'id'=item13->>'id' THEN value||jsonb_build_object('exclusion',NULL) ELSE value END) FROM jsonb_array_elements(p2u.items) value) WHERE p2u.id=prep_id;
 ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;

 -- (c) wrong to_e164 raises at insert.
 failed:=false;BEGIN INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item18->>'id')::uuid,1,(item18->'recipient'->>'contactId')::uuid,item18->'recipient'->>'from','+19995550000',inbox_reply_send.body_hash(item18->'recipient'->>'renderedBody',item18->'recipient'->>'from','+19995550000'),'approved');
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='Attempt does not match frozen recipient' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Wrong to_e164 was insertable';END IF;

 -- (d) recipient_limit at insert: temporarily lower the shared cap to exactly
 -- the operation's current distinct item_id count, then a brand-new distinct
 -- item is refused (mirrors the '51st item' scenario without needing 50 real
 -- conversations). Restore the real function afterward.
 DECLARE current_distinct integer;
 BEGIN
  SELECT count(DISTINCT item_id) INTO current_distinct FROM inbox_reply_send.attempts WHERE org_id=o AND operation_id=op_id;
  EXECUTE format('CREATE OR REPLACE FUNCTION inbox_reply_preparation.recipient_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path=%L AS $lim$ SELECT %s $lim$','',current_distinct);
  failed:=false;BEGIN INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(item18->>'id')::uuid,1,(item18->'recipient'->>'contactId')::uuid,item18->'recipient'->>'from',item18->'recipient'->>'to',inbox_reply_send.body_hash(item18->'recipient'->>'renderedBody',item18->'recipient'->>'from',item18->'recipient'->>'to'),'approved');
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_RECIPIENT_LIMIT' THEN failed:=true;ELSE RAISE;END IF;END;
  IF NOT failed THEN RAISE EXCEPTION 'Recipient limit not enforced at insert (%+1 distinct items admitted)',current_distinct;END IF;
  CREATE OR REPLACE FUNCTION inbox_reply_preparation.recipient_limit() RETURNS integer LANGUAGE sql IMMUTABLE SET search_path='' AS $$ SELECT 50 $$;
  -- Now that the real 50-cap is restored, the same insert succeeds.
  INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(item18->>'id')::uuid,1,(item18->'recipient'->>'contactId')::uuid,item18->'recipient'->>'from',item18->'recipient'->>'to',inbox_reply_send.body_hash(item18->'recipient'->>'renderedBody',item18->'recipient'->>'from',item18->'recipient'->>'to'),'approved')
   RETURNING id INTO att18;
 END;
 RAISE NOTICE '#11 P-GATE binding OK';

 -- === #12 E4 live re-derivation at dispatch ===
 -- (a) sms_phone_suppressions was already exercised on item10 in #6 setup
 -- (claim -> suppress -> start_dispatch -> skipped_ineligible, asserted
 -- there). (b) sender inactive: (c) validUntil already past: (d) new inbound
 -- bumping the head revision.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item12->>'id')::uuid,1,(item12->'recipient'->>'contactId')::uuid,item12->'recipient'->>'from',item12->'recipient'->>'to',inbox_reply_send.body_hash(item12->'recipient'->>'renderedBody',item12->'recipient'->>'from',item12->'recipient'->>'to'),'approved')
  RETURNING id INTO att12;
 PERFORM inbox_reply_send.claim(o,att12);
 UPDATE provider_sender_numbers SET status='inactive' WHERE id=s;
 a:=inbox_reply_send.start_dispatch(o,att12,1);
 IF a->>'kind'<>'skipped' OR a->>'reason'<>'sender_unavailable' THEN RAISE EXCEPTION 'item12 expected sender_unavailable skip: %',a;END IF;
 UPDATE provider_sender_numbers SET status='active' WHERE id=s;

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item13->>'id')::uuid,1,(item13->'recipient'->>'contactId')::uuid,item13->'recipient'->>'from',item13->'recipient'->>'to',inbox_reply_send.body_hash(item13->'recipient'->>'renderedBody',item13->'recipient'->>'from',item13->'recipient'->>'to'),'approved')
  RETURNING id INTO att13;
 PERFORM inbox_reply_send.claim(o,att13);
 ALTER TABLE inbox_reply_review.preparations DISABLE TRIGGER immutable_reply_preparation;
 UPDATE inbox_reply_review.preparations p2u SET items=(SELECT jsonb_agg(CASE WHEN value->>'id'=item13->>'id' THEN jsonb_set(value,'{validUntil}',to_jsonb((clock_timestamp()-interval '1 second')::text)) ELSE value END) FROM jsonb_array_elements(p2u.items) value) WHERE p2u.id=prep_id;
 ALTER TABLE inbox_reply_review.preparations ENABLE TRIGGER immutable_reply_preparation;
 a:=inbox_reply_send.start_dispatch(o,att13,1);
 IF a->>'kind'<>'skipped' OR a->>'reason'<>'conversation_window_expired' THEN RAISE EXCEPTION 'item13 expected conversation_window_expired skip: %',a;END IF;

 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item17->>'id')::uuid,1,(item17->'recipient'->>'contactId')::uuid,item17->'recipient'->>'from',item17->'recipient'->>'to',inbox_reply_send.body_hash(item17->'recipient'->>'renderedBody',item17->'recipient'->>'from',item17->'recipient'->>'to'),'approved')
  RETURNING id INTO att17;
 PERFORM inbox_reply_send.claim(o,att17);
 UPDATE inbox_inbound_heads SET revision=revision+1 WHERE org_id=o AND conversation_id=(item17->'target'->>'id')::uuid;
 a:=inbox_reply_send.start_dispatch(o,att17,1);
 IF a->>'kind'<>'skipped' OR a->>'reason'<>'inbound_changed' THEN RAISE EXCEPTION 'item17 expected inbound_changed skip: %',a;END IF;
 RAISE NOTICE '#12 E4 live re-derivation (suppression/sender/expiry/inbound) OK';

 -- Mutation: replace start_dispatch with a variant that skips item_current()
 -- entirely; a fresh suppressed item (item19) now wrongly reaches
 -- dispatch_started. Restore; a further fresh item (item20) is correctly
 -- skipped again.
 INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES(o,'sms',item19->'recipient'->>'to','owned_prd_test');
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item19->>'id')::uuid,1,(item19->'recipient'->>'contactId')::uuid,item19->'recipient'->>'from',item19->'recipient'->>'to',inbox_reply_send.body_hash(item19->'recipient'->>'renderedBody',item19->'recipient'->>'from',item19->'recipient'->>'to'),'approved')
  RETURNING id INTO att19;
 PERFORM inbox_reply_send.claim(o,att19);
 CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;token uuid;cn text;
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
 -- MUTATION: item_current() intentionally not called here.
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
END $mut$;
 a:=inbox_reply_send.start_dispatch(o,att19,1);
 IF a->>'kind'<>'dispatch' THEN RAISE EXCEPTION 'Mutation did not actually let a suppressed item wrongly dispatch: %',a;END IF;
 -- Resolve item19's wrongly-dispatched attempt so it stops holding the
 -- sender lock, then restore the real start_dispatch.
 PERFORM inbox_reply_send.persist(o,att19,(a->>'token')::uuid,jsonb_build_object('kind','not_attempted','reason','cancelled_before_dispatch'));
 -- R5 meta-test: prove the assert_installed-equivalent guard immediately
 -- below actually catches a stale restore, not merely that a correct
 -- restore passes it. Stage a literal round-3-shape start_dispatch (no
 -- IR001 savepoint recheck, no isolation assert at all — this guard did
 -- not exist before round 5, and a stale restore here previously shipped
 -- silently) and confirm the SAME guard text raises.
 CREATE OR REPLACE FUNCTION inbox_reply_send.start_dispatch(o uuid,attempt_id uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $stale$
DECLARE row inbox_reply_send.attempts;frozen jsonb;recomputed text;token uuid;
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
 token:=gen_random_uuid();
 UPDATE inbox_reply_send.attempts SET state='dispatch_started',dispatch_started_at=clock_timestamp(),dispatch_token=token,lease_until=NULL WHERE org_id=o AND id=attempt_id;
 RETURN jsonb_build_object('kind','dispatch','token',token,'from',row.from_e164,'to',row.to_e164,'body',frozen->'recipient'->>'renderedBody');
END $stale$;
 failed:=false;
 BEGIN
  IF pg_get_functiondef('inbox_reply_send.start_dispatch'::regproc) NOT LIKE '%IR001%' OR pg_get_functiondef('inbox_reply_send.start_dispatch'::regproc) NOT LIKE '%INBOX_REPLY_UNSUPPORTED_ISOLATION%' THEN
   RAISE EXCEPTION 'assert_installed: start_dispatch is missing IR001 or INBOX_REPLY_UNSUPPORTED_ISOLATION after restore — stale/hand-inlined definition installed instead of the candidate';
  END IF;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'assert_installed:%' THEN failed:=true;ELSE RAISE;END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'R5 meta-test: assert_installed did not trip on a staged stale (round-3-shape) start_dispatch restore — the guard is a no-op';END IF;
 @@RESTORE_START_DISPATCH@@
 -- P2/R5 assert_installed equivalent: read back what is ACTUALLY installed
 -- (not what we intended to install) and fail loudly if either the R3-1
 -- post-marker savepoint recheck (IR001) or the R4/R5 isolation assert is
 -- missing — a stale round-3-shape restore here previously let the whole
 -- suite pass silently (Codex round-5 finding).
 IF pg_get_functiondef('inbox_reply_send.start_dispatch'::regproc) NOT LIKE '%IR001%' OR pg_get_functiondef('inbox_reply_send.start_dispatch'::regproc) NOT LIKE '%INBOX_REPLY_UNSUPPORTED_ISOLATION%' THEN
  RAISE EXCEPTION 'assert_installed: start_dispatch is missing IR001 or INBOX_REPLY_UNSUPPORTED_ISOLATION after restore — stale/hand-inlined definition installed instead of the candidate';
 END IF;
 INSERT INTO sms_phone_suppressions(org_id,channel,phone_e164,source) VALUES(o,'sms',item20->'recipient'->>'to','owned_prd_test');
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item20->>'id')::uuid,1,(item20->'recipient'->>'contactId')::uuid,item20->'recipient'->>'from',item20->'recipient'->>'to',inbox_reply_send.body_hash(item20->'recipient'->>'renderedBody',item20->'recipient'->>'from',item20->'recipient'->>'to'),'approved')
  RETURNING id INTO att20;
 PERFORM inbox_reply_send.claim(o,att20);
 a:=inbox_reply_send.start_dispatch(o,att20,1);
 IF a->>'kind'<>'skipped' OR a->>'reason'<>'sms_suppressed' THEN RAISE EXCEPTION 'Restored start_dispatch failed to re-skip a suppressed item: %',a;END IF;
 RAISE NOTICE '#12 mutation (item_current call removed, then restored) OK';

 -- === #13 Admission ===
 UPDATE inbox_reply_review.admission SET enabled=false WHERE singleton;
 failed:=false;BEGIN PERFORM inbox_reply_send.claim(o,att20);EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM='INBOX_REPLIES_NOT_ENABLED' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'claim() served with admission disabled';END IF;
 -- persist() is deliberately NOT admission-gated: a result already in flight
 -- must always be recordable. att20 is skipped_ineligible (terminal) so
 -- persist on it correctly raises INVALID_PERSIST_TRANSITION rather than
 -- the admission error — proving admission was never even consulted.
 failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att20,gen_random_uuid(),jsonb_build_object('kind','uncertain','reason','x'));EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_STALE_TOKEN' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'persist() with a wrong token did not even reach the token check';END IF;
 UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;

 -- Mutation: make require_admission() a no-op, watch claim() proceed anyway
 -- while admission is disabled; restore, reverify it raises again.
 UPDATE inbox_reply_review.admission SET enabled=false WHERE singleton;
 CREATE OR REPLACE FUNCTION inbox_reply_review.require_admission() RETURNS void LANGUAGE plpgsql SET search_path='' AS $mut$ BEGIN END $mut$;
 b:=inbox_reply_send.claim(o,att3);
 IF b->>'kind' IS NULL THEN RAISE EXCEPTION 'Mutation did not actually bypass admission: %',b;END IF;
 CREATE OR REPLACE FUNCTION inbox_reply_review.require_admission() RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
DECLARE admitted boolean;
BEGIN
 SELECT enabled INTO admitted FROM inbox_reply_review.admission WHERE singleton FOR SHARE;
 IF admitted IS DISTINCT FROM true THEN RAISE EXCEPTION 'INBOX_REPLIES_NOT_ENABLED' USING ERRCODE='55000';END IF;
END $$;
 failed:=false;BEGIN PERFORM inbox_reply_send.claim(o,att3);EXCEPTION WHEN object_not_in_prerequisite_state THEN IF SQLERRM='INBOX_REPLIES_NOT_ENABLED' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Guard not actually restored (admission)';END IF;
 UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;
 RAISE NOTICE '#13 admission OK';

 -- === #14 Grants ===
 IF has_schema_privilege('anon','inbox_reply_send','USAGE') OR has_schema_privilege('authenticated','inbox_reply_send','USAGE') OR has_schema_privilege('service_role','inbox_reply_send','USAGE')
    OR has_table_privilege('authenticated','inbox_reply_send.attempts','SELECT') OR has_table_privilege('authenticated','inbox_reply_send.operations','SELECT')
    OR has_function_privilege('authenticated','inbox_reply_send.claim(uuid,uuid,integer)','EXECUTE')
    OR has_function_privilege('service_role','inbox_reply_send.persist(uuid,uuid,uuid,jsonb)','EXECUTE') THEN
  RAISE EXCEPTION 'inbox_reply_send is reachable from an external role';
 END IF;
 -- Mutation: grant USAGE to authenticated, confirm the check above would have
 -- caught it, then revoke again.
 GRANT USAGE ON SCHEMA inbox_reply_send TO authenticated;
 IF NOT has_schema_privilege('authenticated','inbox_reply_send','USAGE') THEN RAISE EXCEPTION 'Grant mutation did not take effect';END IF;
 REVOKE USAGE ON SCHEMA inbox_reply_send FROM authenticated;
 IF has_schema_privilege('authenticated','inbox_reply_send','USAGE') THEN RAISE EXCEPTION 'Revoke did not restore the closed boundary';END IF;
 RAISE NOTICE '#14 grants OK';


 -- === Round 2 additional single-edge mutation-first proofs ===
 -- B1/#5/B2: persist() vocabulary + not_attempted-reason validation, on a
 -- real dispatch_started row so the token check passes and these checks are
 -- actually exercised (not short-circuited by INBOX_REPLY_STALE_TOKEN).
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item21->>'id')::uuid,1,(item21->'recipient'->>'contactId')::uuid,item21->'recipient'->>'from',item21->'recipient'->>'to',inbox_reply_send.body_hash(item21->'recipient'->>'renderedBody',item21->'recipient'->>'from',item21->'recipient'->>'to'),'approved')
  RETURNING id INTO att21;
 PERFORM inbox_reply_send.claim(o,att21);
 a:=inbox_reply_send.start_dispatch(o,att21,1);
 IF a->>'kind'<>'dispatch' THEN RAISE EXCEPTION 'item21 start_dispatch mismatch: %',a;END IF;
 DECLARE tok21 uuid:=(a->>'token')::uuid;rv21 bigint;
 BEGIN
  SELECT receipt_version INTO rv21 FROM inbox_reply_send.attempts WHERE org_id=o AND id=att21;
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att21,tok21,'{}'::jsonb);EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'persist(empty object) was accepted (B1 regression)';END IF;
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att21,tok21,jsonb_build_object('kind',NULL));EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'persist(kind=null) was accepted (B1 regression)';END IF;
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att21,tok21,jsonb_build_object('kind','rejected'));EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'persist(kind=rejected) was accepted (#5)';END IF;
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att21,tok21,jsonb_build_object('kind','not_attempted','reason','provider_timeout'));EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'persist(not_attempted, reason=provider_timeout) was accepted (B2 regression)';END IF;
  IF (SELECT receipt_version FROM inbox_reply_send.attempts WHERE org_id=o AND id=att21)<>rv21 THEN RAISE EXCEPTION 'A rejected persist() call mutated the row';END IF;
  RAISE NOTICE 'B1/#5/B2 persist vocabulary + not_attempted-reason proofs OK';

  -- #9: drop token equality from persist(), watch a WRONG token wrongly
  -- reconcile the row; restore, reverify a wrong token is rejected again.
  CREATE OR REPLACE FUNCTION inbox_reply_send.persist(o uuid,attempt_id uuid,token uuid,result jsonb) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;kind text;reference text;v bigint;
BEGIN
 -- MUTATION: token equality dropped — any token (or none) matches.
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_STALE_TOKEN';END IF;
 kind:=result->>'kind';
 IF row.state='dispatch_started' AND kind='accepted' THEN
  reference:=result->>'externalId';
  UPDATE inbox_reply_send.attempts SET state='provider_accepted',provider_reference=reference,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id RETURNING receipt_version INTO v;
  RETURN jsonb_build_object('state','provider_accepted','receipt_version',v::text);
 END IF;
 RAISE EXCEPTION 'unused in this proof';
END $mut$;
  b:=inbox_reply_send.persist(o,att21,gen_random_uuid(),jsonb_build_object('kind','accepted','externalId','PROV-WRONG-TOKEN'));
  IF b->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'Mutation did not actually drop token equality: %',b;END IF;
@@RESTORE_PERSIST@@
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att21,gen_random_uuid(),jsonb_build_object('kind','accepted','externalId','PROV-SHOULD-FAIL'));EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_STALE_TOKEN' THEN failed:=true;ELSE RAISE;END IF;END;
  IF NOT failed THEN RAISE EXCEPTION 'Restored persist() still accepts a wrong token';END IF;
  RAISE NOTICE '#9 token-equality mutation (dropped, then restored) OK';
 END;

 -- #10: make dispatch_started re-entry LIE that it re-claimed (return
 -- {claimed} without touching the row) instead of labelling uncertain.
 -- Even under that lie, start_dispatch independently re-verifies the row's
 -- REAL state before issuing anything — proving a second token is
 -- impossible via this specific lie, in addition to the trigger-level
 -- guarantee.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item22->>'id')::uuid,1,(item22->'recipient'->>'contactId')::uuid,item22->'recipient'->>'from',item22->'recipient'->>'to',inbox_reply_send.body_hash(item22->'recipient'->>'renderedBody',item22->'recipient'->>'from',item22->'recipient'->>'to'),'approved')
  RETURNING id INTO att22;
 PERFORM inbox_reply_send.claim(o,att22);
 a:=inbox_reply_send.start_dispatch(o,att22,1);
 IF a->>'kind'<>'dispatch' THEN RAISE EXCEPTION 'item22 start_dispatch mismatch: %',a;END IF;
 DECLARE tok22 uuid:=(a->>'token')::uuid;
 BEGIN
  CREATE OR REPLACE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp() AND row.dispatch_started_at IS NULL) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN
  RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  -- MUTATION: lies that it reclaimed, without touching the row.
  RETURN jsonb_build_object('kind','claimed','generation',row.generation::text);
 ELSE
  RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $mut$;
  b:=inbox_reply_send.claim(o,att22);
  IF b->>'kind'<>'claimed' THEN RAISE EXCEPTION 'Mutation did not actually make re-entry lie: %',b;END IF;
  failed:=false;BEGIN PERFORM inbox_reply_send.start_dispatch(o,att22,(b->>'generation')::bigint);EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_STALE_CLAIM' THEN failed:=true;ELSE RAISE;END IF;END;
  IF NOT failed THEN RAISE EXCEPTION 'A lying re-entry produced a second token';END IF;
  IF (SELECT dispatch_token FROM inbox_reply_send.attempts WHERE org_id=o AND id=att22)<>tok22 THEN RAISE EXCEPTION 'dispatch_token changed under the lying mutation';END IF;
  -- R5 meta-test: prove the assert_installed-equivalent guard immediately
  -- below actually catches a stale restore. Stage a literal round-3-shape
  -- claim() (missing the dispatch_started_at IS NULL reclaim guard) and
  -- confirm the SAME guard text raises before the real restore runs.
  CREATE OR REPLACE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $stale$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp()) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN
  RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','existing','state','uncertain');
 ELSE
  RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $stale$;
  failed:=false;
  BEGIN
   IF pg_get_functiondef('inbox_reply_send.claim'::regproc) NOT LIKE '%dispatch_started_at IS NULL%' THEN
    RAISE EXCEPTION 'assert_installed: claim is missing the dispatch_started_at IS NULL reclaim guard after restore — stale/hand-inlined definition installed instead of the candidate';
   END IF;
  EXCEPTION WHEN raise_exception THEN
   IF SQLERRM LIKE 'assert_installed:%' THEN failed:=true;ELSE RAISE;END IF;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'R5 meta-test: assert_installed did not trip on a staged stale claim restore at CLAIM_1 — the guard is a no-op';END IF;
@@RESTORE_CLAIM_1@@
  -- P2/R5 assert_installed equivalent (Codex round-5 finding: this restore
  -- previously had no installed-definition check at all).
  IF pg_get_functiondef('inbox_reply_send.claim'::regproc) NOT LIKE '%dispatch_started_at IS NULL%' THEN
   RAISE EXCEPTION 'assert_installed: claim is missing the dispatch_started_at IS NULL reclaim guard after restore — stale/hand-inlined definition installed instead of the candidate';
  END IF;
  b:=inbox_reply_send.claim(o,att22);
  IF b->>'kind'<>'existing' OR b->>'state'<>'uncertain' THEN RAISE EXCEPTION 'Restored claim() re-entry mismatch: %',b;END IF;
  a:=inbox_reply_send.persist(o,att22,tok22,jsonb_build_object('kind','accepted','externalId','PROV-22'));
  IF a->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'item22 final persist mismatch: %',a;END IF;
  RAISE NOTICE '#10 re-entry-lie mutation (second token impossible; restored) OK';
 END;

 -- #3: drop "AND row.dispatch_started_at IS NULL" from claim()'s reclaim
 -- predicate. Documented no-op: CHECK((dispatch_started_at IS NULL)=(state
 -- IN ('approved','claimed','skipped_ineligible'))) already guarantees
 -- dispatch_started_at IS NULL whenever state='claimed', so this clause is
 -- structurally redundant — the reclaim behaves identically with or without
 -- it, because a 'claimed' row can never have dispatch_started_at set in
 -- the first place.
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item23->>'id')::uuid,1,(item23->'recipient'->>'contactId')::uuid,item23->'recipient'->>'from',item23->'recipient'->>'to',inbox_reply_send.body_hash(item23->'recipient'->>'renderedBody',item23->'recipient'->>'from',item23->'recipient'->>'to'),'approved')
  RETURNING id INTO att23;
 PERFORM inbox_reply_send.claim(o,att23);
 UPDATE inbox_reply_send.attempts SET generation=generation+1,lease_until=clock_timestamp()-interval '1 second' WHERE org_id=o AND id=att23;
 CREATE OR REPLACE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $mut$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 -- MUTATION: dispatch_started_at IS NULL clause dropped from the reclaim predicate.
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp()) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN
  RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','existing','state','uncertain');
 ELSE
  RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $mut$;
 b:=inbox_reply_send.claim(o,att23);
 IF b->>'kind'<>'claimed' OR b->>'generation'<>'3' THEN RAISE EXCEPTION 'item23 reclaim under mutated predicate mismatch: %',b;END IF;
 -- R5 meta-test: prove the assert_installed-equivalent guard immediately
 -- below actually catches a stale restore. The claim() installed above
 -- (the #3 mutation) still contains the needle text in its own MUTATION
 -- comment, so it does NOT trip the guard — stage a clean round-3-shape
 -- claim() (guard code actually absent, no comment either) and confirm
 -- the SAME guard text raises against it before the real restore runs.
 CREATE OR REPLACE FUNCTION inbox_reply_send.claim(o uuid,attempt_id uuid,seconds integer DEFAULT 60) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $stale2$
DECLARE row inbox_reply_send.attempts;new_generation bigint;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 PERFORM inbox_reply_review.require_admission();
 SELECT * INTO row FROM inbox_reply_send.attempts WHERE org_id=o AND id=attempt_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_REPLY_ATTEMPT_UNAVAILABLE';END IF;
 IF row.state='approved' OR (row.state='claimed' AND row.lease_until<=clock_timestamp()) THEN
  UPDATE inbox_reply_send.attempts SET state='claimed',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND id=attempt_id RETURNING generation INTO new_generation;
  RETURN jsonb_build_object('kind','claimed','generation',new_generation::text);
 ELSIF row.state='claimed' THEN
  RETURN jsonb_build_object('kind','busy');
 ELSIF row.state='dispatch_started' THEN
  UPDATE inbox_reply_send.attempts SET state='uncertain',evidence='reentered_without_result',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND id=attempt_id;
  RETURN jsonb_build_object('kind','existing','state','uncertain');
 ELSE
  RETURN jsonb_build_object('kind','existing','state',row.state);
 END IF;
END $stale2$;
 failed:=false;
 BEGIN
  IF pg_get_functiondef('inbox_reply_send.claim'::regproc) NOT LIKE '%dispatch_started_at IS NULL%' THEN
   RAISE EXCEPTION 'assert_installed: claim is missing the dispatch_started_at IS NULL reclaim guard after restore — stale/hand-inlined definition installed instead of the candidate';
  END IF;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM LIKE 'assert_installed:%' THEN failed:=true;ELSE RAISE;END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'R5 meta-test: assert_installed did not trip on the still-staged stale claim restore at CLAIM_2 — the guard is a no-op';END IF;
@@RESTORE_CLAIM_2@@
 -- P2/R5 assert_installed equivalent (Codex round-5 finding: this was a
 -- hand-typed literal restore with no installed-definition check at all).
 IF pg_get_functiondef('inbox_reply_send.claim'::regproc) NOT LIKE '%dispatch_started_at IS NULL%' THEN
  RAISE EXCEPTION 'assert_installed: claim is missing the dispatch_started_at IS NULL reclaim guard after restore — stale/hand-inlined definition installed instead of the candidate';
 END IF;
 RAISE NOTICE '#3 dispatch_started_at-clause mutation (confirmed no-op under the D-5 CHECK; restored) OK';

 -- #4: remove ONE trigger edge (uncertain->provider_accepted), not the
 -- whole trigger. persist(accepted) from uncertain must then raise from the
 -- trigger itself (independent of persist()'s own logic, which still tries
 -- the UPDATE).
 INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
  VALUES(o,gen_random_uuid(),op_id,prep_id,(item24->>'id')::uuid,1,(item24->'recipient'->>'contactId')::uuid,item24->'recipient'->>'from',item24->'recipient'->>'to',inbox_reply_send.body_hash(item24->'recipient'->>'renderedBody',item24->'recipient'->>'from',item24->'recipient'->>'to'),'approved')
  RETURNING id INTO att24;
 PERFORM inbox_reply_send.claim(o,att24);
 a:=inbox_reply_send.start_dispatch(o,att24,1);
 IF a->>'kind'<>'dispatch' THEN RAISE EXCEPTION 'item24 start_dispatch mismatch: %',a;END IF;
 DECLARE tok24 uuid:=(a->>'token')::uuid;
 BEGIN
  PERFORM inbox_reply_send.claim(o,att24); -- re-entry -> uncertain
  IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att24)<>'uncertain' THEN RAISE EXCEPTION 'item24 not uncertain before trigger mutation';END IF;
@@MUTATE_GUARD_ATTEMPT_MINUS_EDGE@@
  failed:=false;BEGIN PERFORM inbox_reply_send.persist(o,att24,tok24,jsonb_build_object('kind','accepted','externalId','PROV-24'));EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'Removing the uncertain->provider_accepted edge did not block persist()';END IF;
  IF (SELECT state FROM inbox_reply_send.attempts WHERE org_id=o AND id=att24)<>'uncertain' THEN RAISE EXCEPTION 'item24 row mutated despite the blocked trigger edge';END IF;
@@RESTORE_GUARD_ATTEMPT@@
  -- P2 (round 4/5): assert_installed equivalent — read back what is
  -- ACTUALLY installed after the restore (not what we intended to install)
  -- and fail loudly if the R3-2b window-expiry edge or the R5 marker-edge
  -- isolation assert is missing, so a stale/hand-inlined restore can never
  -- silently ship a guard_attempt() that is missing a later round's fix.
  IF pg_get_functiondef('inbox_reply_send.guard_attempt'::regproc) NOT LIKE '%INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER%' OR pg_get_functiondef('inbox_reply_send.guard_attempt'::regproc) NOT LIKE '%INBOX_REPLY_UNSUPPORTED_ISOLATION%' THEN
   RAISE EXCEPTION 'assert_installed: guard_attempt is missing INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER or INBOX_REPLY_UNSUPPORTED_ISOLATION after restore — stale/hand-inlined definition installed instead of the candidate';
  END IF;
  a:=inbox_reply_send.persist(o,att24,tok24,jsonb_build_object('kind','accepted','externalId','PROV-24'));
  IF a->>'state'<>'provider_accepted' THEN RAISE EXCEPTION 'item24 final persist mismatch after trigger restore: %',a;END IF;
  RAISE NOTICE '#4 single-edge trigger mutation (uncertain->provider_accepted removed, then restored) OK';
 END;

 RAISE NOTICE 'ALL PR-D SINGLE-CONNECTION CHECKS PASSED';
END $test$;

ROLLBACK;
"""
# P2 (round 4): substitute every @@...@@ restore/mutate placeholder with the
# EXACT candidate definition re-extracted from attempts.sql at run time —
# never a hand-typed copy baked into the `test` string above, which could
# silently drift from a later round's edit without this script ever
# noticing (see the module docstring comment above ATTEMPTS_SQL).
test=test.replace('@@RESTORE_START_DISPATCH@@',real_fn('inbox_reply_send.start_dispatch'))
test=test.replace('@@RESTORE_PERSIST@@',real_fn('inbox_reply_send.persist'))
test=test.replace('@@RESTORE_CLAIM_1@@',real_fn('inbox_reply_send.claim'))
test=test.replace('@@RESTORE_CLAIM_2@@',real_fn('inbox_reply_send.claim'))
test=test.replace('@@MUTATE_GUARD_ATTEMPT_MINUS_EDGE@@',real_fn_minus_edge('inbox_reply_send.guard_attempt',"uncertain' AND NEW.state='provider_accepted'"))
test=test.replace('@@RESTORE_GUARD_ATTEMPT@@',real_fn('inbox_reply_send.guard_attempt'))
if '@@' in test:raise RuntimeError('Unsubstituted @@...@@ placeholder remains in test SQL')
sql(''.join(parts)+test)
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL AND to_regnamespace('inbox_reply_send') IS NULL")!='t':raise RuntimeError('Rollback failed')
(P/'evidence.json').write_text(json.dumps({
 'sources':{str(path.relative_to(P.parent)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},
 'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
 'checks':[
  'Happy path: insert (frozen-matching) -> claim -> expired-lease reclaim (generation strictly increases) -> start_dispatch (body/from/to byte-identical to frozen row) -> re-entry claim labels uncertain (never re-claims, never re-issues a token) -> persist wrong token raises, correct token reconciles to provider_accepted -> idempotent re-ack and post-accept uncertain are no-ops -> contradictory externalId raises -> provider_accepted->delivered (trigger edge, PR-G territory)',
  '#4 terminal resurrection: every out-of-matrix UPDATE on a terminal (delivered) row raises (approved/claimed/rejected_unsent); claim()/persist(uncertain) on a terminal row return stored data without mutating receipt_version; persist(not_attempted) on a terminal row raises. Mutation: trigger disabled -> both resurrection and rejected_unsent forcing succeed; trigger re-enabled -> both blocked again',
  '#5 rejected_unsent has no inbound edge under the live trigger in any of the above; covered by the same disable/re-enable mutation as #4',
  '#6 partial-unique bypass: ordinal-2 successor blocked (unique_violation) while prior sits in each of {approved,claimed,dispatch_started,provider_accepted,uncertain,delivered,delivery_failed,skipped_ineligible}; succeeds only when prior is confirmed_not_submitted. Mutation: live-attempt index widened to also exempt uncertain -> a successor wrongly admitted while prior is uncertain; index restored -> a further successor is blocked again',
  '#7 D2 destination guard: two live attempts to the same to_e164 (shared contact, two conversations) conflict; once the first becomes uncertain the second succeeds. Mutation: destination-guard index widened to also cover uncertain -> the same insert wrongly fails; index restored -> succeeds again',
  '#8 sender one-in-flight (single-connection mutation half; the real two-real-connection race is concurrency.py): a second claimed attempt cannot start_dispatch while another shares its sender and is already dispatch_started (INBOX_REPLY_SENDER_BUSY, 55P03, lease left intact). Mutation: sender-inflight index dropped and the guard trigger bypassed for one write -> two simultaneous dispatch_started rows for one sender; index restored',
  '#9 token fence + reconcile: wrong token never mutates; correct token from uncertain reconciles to provider_accepted; idempotent re-ack with the same externalId and a stray uncertain-after-accepted are both no-ops; a different externalId after provider_accepted raises INBOX_REPLY_CONTRADICTORY_RECEIPT',
  '#10 re-entry labelling: claim() on a dispatch_started row labels uncertain with evidence reentered_without_result and never re-claims; a subsequent persist(accepted) with the original token still reconciles to provider_accepted',
  '#11 P-GATE binding: start_dispatch returns from/to/body byte-identical to the frozen recipient; an owner tamper of the frozen renderedBody is caught at dispatch as INBOX_REPLY_FROZEN_MISMATCH; a frozen item with exclusion forced non-NULL is uninsertable (frozen_item raises at the INSERT trigger); an attempt with a to_e164 that does not match the frozen recipient is uninsertable; the operation-wide recipient_limit is enforced at INSERT (temporarily lowered to the operation'"'"'s current distinct-item count, a new distinct item is refused, then admitted again once the real 50-cap is restored)',
  '#12 E4 live re-derivation at dispatch: sms_phone_suppressions added after claim, sender marked inactive, validUntil forced into the past, and a bumped inbound head revision each independently produce the matching skipped_ineligible/exclusion code with no token ever issued. Mutation: start_dispatch redefined to skip item_current() entirely -> a suppressed item wrongly reaches dispatch_started; start_dispatch restored -> a further suppressed item is correctly skipped again',
  '#13 admission: claim() raises INBOX_REPLIES_NOT_ENABLED (55000) while admission is disabled; persist() is never admission-gated (a wrong-token call still fails on the token check, not on admission, even with admission off). Mutation: require_admission() replaced with a no-op -> claim() wrongly proceeds while disabled; restored -> raises again',
  '#14 grants: no table, function or schema in inbox_reply_send is reachable by anon/authenticated/service_role. Mutation: USAGE granted to authenticated and observed via has_schema_privilege, then revoked and re-verified closed',
  'Round 2 B1/#5/B2: persist() computes kind before checking it (a {} or {"kind":null} result raises, not falls through to a silent confirmed_not_submitted); kind=rejected raises; not_attempted is bound to reason IN (invalid_input, cancelled_before_dispatch) — a provider timeout or any other reason raises rather than freeing a successor attempt via a false non-submit',
  'Round 2 #9: persist() redefined without token equality lets a wrong token wrongly reconcile the row; restored, a wrong token is rejected (INBOX_REPLY_STALE_TOKEN) again',
  'Round 2 #10: claim() redefined so dispatch_started re-entry LIES that it re-claimed ({claimed} without touching the row) instead of labelling uncertain — start_dispatch still independently re-verifies the row'"'"'s real state and raises INBOX_REPLY_STALE_CLAIM, so no second token is ever produced by this lie; restored, re-entry correctly labels uncertain and the original token still reconciles',
  'Round 2 #3: claim()'"'"'s reclaim predicate redefined without "AND dispatch_started_at IS NULL" — confirmed a documented no-op (identical reclaim outcome) because CHECK((dispatch_started_at IS NULL)=(state IN (approved,claimed,skipped_ineligible))) already guarantees it structurally; restored',
  'Round 2 #4: the trigger'"'"'s uncertain->provider_accepted edge removed (not the whole trigger) — persist(accepted) from uncertain now raises from the trigger itself with the row left unchanged; edge restored, the same persist() call succeeds',
  'Round 2 P1.2: item_current() now acquires its sender and inbound-head FOR SHARE locks BEFORE evaluating destination_policy() (round 3 additionally moves validUntil/quiet_hours after the same locks — see below) — each eligibility read is a fresh READ COMMITTED snapshot, so a change committed while item_current was blocked on either lock is guaranteed visible (proven with a genuine two-connection lock-wait + concurrent suppression commit in concurrency.py); start_dispatch'"'"'s sender-busy pre-check moved before item_current so no statement sits between the eligibility reads and the marker UPDATE; item_current and destination_policy() remain VOLATILE',
  'Round 2 P2.3: the INSERT trigger'"'"'s operation-admission check now does SELECT ... FOR NO KEY UPDATE on the operations row before the distinct-item-count cap, serializing concurrent inserts against one operation (proven with a genuine two-connection race in concurrency.py — the second insert at the cap correctly raises INBOX_REPLY_RECIPIENT_LIMIT instead of both committing past 50)',
  'Round 2 P2.4: start_dispatch'"'"'s marker UPDATE is wrapped to catch unique_violation, and only re-raises as the sanitized INBOX_REPLY_SENDER_BUSY (55P03, no DETAIL/HINT) when the violated constraint is inbox_reply_send_sender_inflight — every other constraint violation re-raises unchanged, and no phone number ever appears in the error',
  'Round 2 REVOKE reconcile: the unconditional PUBLIC,anon,authenticated,service_role REVOKEs at schema/table/function level were narrowed to PUBLIC only; the guarded absence-checking loop is now the sole role-conditional revocation path',
  'Round 2 frozen_item(): returns ONLY {recipient, validUntil, state, target, dependencies:{head}} — never the whole frozen item (id/exclusion/duplicateDestination/full dependencies excluded)',
  'Round 2 harness: quiet_hours() is pinned to always-open for the duration of this rolled-back transaction only (no proof here concerns quiet_hours transitions), removing a wall-clock-dependent setup failure when every state in its table falls outside its local 08:00-21:00 window during the same UTC hour the harness happens to run in',
  'Round 3 invariant: the last eligibility read happens after the last statement that can WAIT in the transaction; the marker UPDATE is the last statement that can wait, so item_current runs once MORE after it returns. item_current() now evaluates validUntil and quiet_hours AFTER acquiring both FOR SHARE locks (not just destination_policy, as round 2 left it) — time eligibility is sampled after the last possible wait, never before it',
  'Round 3 R3-2b: the trigger'"'"'s claimed->dispatch_started edge now rejects any marker whose own dispatch_started_at is already at or past the frozen validUntil (INBOX_REPLY_WINDOW_EXPIRED_AT_MARKER), independent of any function-body bug — same one-row frozen_item() read pattern already paid on the INSERT path',
  'Round 3 R3-1: start_dispatch re-runs the full eligibility check (item_current) a second time immediately after the marker UPDATE, inside a plpgsql EXCEPTION block that acts as a savepoint — a stale-after-marker result (SQLSTATE IR001) rolls the marker/token back in-tx and records skipped_ineligible from a fresh, post-marker reason; only IR001 and unique_violation are caught, never WHEN OTHERS, so any other error still aborts the whole transaction. The two-real-connection proofs for this (marker blocked on the sender-inflight index during a suppression commit, and validUntil expiring during a head-lock wait, each with failing-then-passing controls) live in concurrency.py',
 ],
 'limits':[
  'Trusted SQL calls (no HTTP/JWT signature proof; this PR ships no public RPC)',
  'No accept/status/recover, worker, callback or UI — SQL ledger only (PR-E..H)',
  'Proofs 1 (double-claim), 2 (stale-fence), 3 (reclaim-after-dispatch, two-connection half) and 8 (sender one-in-flight, two-connection half) use two real connections and observed lock-waits in concurrency.py, not this rollback-only single-connection harness'
 ]
},indent=2)+'\n')
print('PR-D send-attempt ledger: all single-connection mutation-first checks passed; all new schemas rolled back')
