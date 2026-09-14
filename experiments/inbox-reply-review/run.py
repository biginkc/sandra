#!/usr/bin/env python3
"""Canonical recipient capture proof; no provider, public grant or durable job."""
import hashlib,json,subprocess,sys
from pathlib import Path
P=Path(__file__).resolve().parent
sys.path.insert(0,str(P.parent/'inbox-projection'/'fixture'))
from guards import validate_container,validate_cron
if sys.argv[1:]!=['--run-owned-fixture']:raise SystemExit('Explicit owned fixture required')
D=['docker','--host','unix:///Users/jarradhenry/.colima/inbox-redesign-20260913/docker.sock'];N='sandra-inbox-projection-t2-db'
validate_container(json.loads(subprocess.check_output(D+['inspect',N],text=True))[0])
def sql(q):
 r=subprocess.run(D+['exec','-i',N,'psql','-XqAt','-U','postgres','-d','postgres','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr)
 return r.stdout.strip()
validate_cron(sql('SHOW cron.launch_active_jobs'))
if sql('SELECT marker FROM inbox_t2_fixture.identity')!='sandra-inbox-projection-t2-owned-synthetic':raise RuntimeError('Wrong fixture')
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL")!='t':raise RuntimeError('Refusing existing reply schema')
sources=[P.parent/'inbox-reply-boundary/context.sql',P.parent/'inbox-reply-preparation/recipient.sql',P.parent/'inbox-reply-preparation/batch.sql',P/'setup.sql',P/'public-api.sql']
parts=[]
for i,path in enumerate(sources):
 body=path.read_text()
 if not body.endswith('COMMIT;\n') or '\nBEGIN;\n' not in body:raise RuntimeError('Expected source transaction boundary')
 body=body.removesuffix('COMMIT;\n')
 if i:body=body.replace('\nBEGIN;\n','\n',1)
 parts.append(body)
test=r"""
DO $test$
DECLARE o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();other_owner uuid:=gen_random_uuid();sess uuid:=gen_random_uuid();p uuid:=gen_random_uuid();c uuid:=gen_random_uuid();contact uuid:=gen_random_uuid();m uuid:=gen_random_uuid();k uuid:=gen_random_uuid();a jsonb;b jsonb;capture jsonb;intent jsonb;chosen_state text;body text;failed boolean;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned immutable reply review');
 INSERT INTO auth.users(id,email) VALUES(u,u::text||'@example.invalid'),(other_owner,other_owner::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(o,u,'owner','active'),(o,other_owner,'owner','active');
 INSERT INTO auth.sessions(id,user_id,not_after) VALUES(sess,u,clock_timestamp()+interval '1 hour');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',sess,'exp',4102444800)::text,true);
 SELECT state INTO STRICT chosen_state FROM (VALUES('MO'),('HI'),('GU'),('PR')) states(state) WHERE inbox_reply_preparation.quiet_hours(state,clock_timestamp())->>'ok'='true' LIMIT 1;
 INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(contact,o,'Ada','+12025550101','mobile');
 INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(p,o,'Owned immutable reply property',chosen_state,contact);
 INSERT INTO provider_sender_numbers(org_id,provider,phone_e164,status) VALUES(o,'sendillo','+18165550101','active');
 INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(m,o,c,contact,p,'sms','inbound','received','Owned inbound','+12025550101','+18165550101');
 failed:=false;BEGIN PERFORM public.inbox_capture_reply_recipients(ARRAY[c]);EXCEPTION WHEN object_not_in_prerequisite_state THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Default closed reply admission served';END IF;
 UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;
 EXECUTE 'SET LOCAL ROLE authenticated';
 capture:=public.inbox_capture_reply_recipients(ARRAY[c])->'items'->0;
 EXECUTE 'RESET ROLE';
 intent:=jsonb_build_object('targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'drafts',jsonb_build_array(jsonb_build_object('conversationId',c,'body','Hi Ada','dependencies',capture->'dependencies','exclusion',NULL)));
 EXECUTE 'SET LOCAL ROLE authenticated';
 a:=public.inbox_freeze_reply_review(intent::text,k);
 EXECUTE 'RESET ROLE';
 IF a->>'recipientCount'<>'1' OR a->'blockers'<>'[]'::jsonb OR a->'items'->0->'recipient'->>'renderedBody'<>'Hi Ada' OR a->'items'->0->'recipient'->>'from'<>'+18165550101' OR a->'items'->0 ? 'dependencies' THEN RAISE EXCEPTION 'Frozen review mismatch: %',a;END IF;
 UPDATE messages SET read_at=clock_timestamp() WHERE id=m;
 b:=inbox_reply_review.freeze(intent::text,k);
 IF a IS DISTINCT FROM b THEN RAISE EXCEPTION 'Same-key replay changed immutable review';END IF;
 failed:=false;BEGIN PERFORM inbox_reply_review.freeze(jsonb_set(intent,'{drafts,0,body}','"Changed"')::text,k);EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_IDEMPOTENCY_MISMATCH' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Same key accepted changed text';END IF;
 failed:=false;BEGIN UPDATE inbox_reply_review.preparations SET items='[]' WHERE id=(a->>'preparationId')::uuid;EXCEPTION WHEN raise_exception THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Frozen body mutable';END IF;
 UPDATE messages SET body='Changed inbound' WHERE id=m;
 failed:=false;BEGIN PERFORM inbox_reply_review.freeze(intent::text,gen_random_uuid());EXCEPTION WHEN raise_exception THEN IF SQLERRM='INBOX_REPLY_PREPARATION_CHANGED' THEN failed:=true;ELSE RAISE;END IF;END;
 IF NOT failed THEN RAISE EXCEPTION 'Stale rendering admitted';END IF;
 capture:=inbox_reply_review.capture(ARRAY[c])->'items'->0;intent:=jsonb_set(intent,'{drafts,0,dependencies}',capture->'dependencies');
 FOREACH body IN ARRAY ARRAY[E'\n\t',chr(160),repeat('😀',801)] LOOP
  failed:=false;BEGIN PERFORM inbox_reply_review.freeze(jsonb_set(intent,'{drafts,0,body}',to_jsonb(body))::text,gen_random_uuid());EXCEPTION WHEN raise_exception THEN failed:=true;END;
  IF NOT failed THEN RAISE EXCEPTION 'Invalid literal body admitted';END IF;
 END LOOP;
 b:=inbox_reply_review.freeze(jsonb_set(intent,'{drafts,0,body}',to_jsonb(repeat('😀',800)))::text,gen_random_uuid());
 IF b->>'recipientCount'<>'1' THEN RAISE EXCEPTION '1600 UTF16 units wrongly excluded';END IF;
 UPDATE contacts SET sms_opted_out=true WHERE id=contact;
 b:=inbox_reply_review.freeze(intent::text,gen_random_uuid());
 IF b->>'recipientCount'<>'0' OR b->'blockers'<>'["empty"]'::jsonb OR b->'items'->0->>'exclusion'<>'contact_suppressed' THEN RAISE EXCEPTION 'Opt-out not reflected in current frozen review';END IF;
 UPDATE memberships SET access_status='suspended' WHERE org_id=o AND user_id=u;
 failed:=false;BEGIN PERFORM inbox_reply_review.freeze(intent::text,k);EXCEPTION WHEN insufficient_privilege THEN failed:=true;END;
 IF NOT failed THEN RAISE EXCEPTION 'Revoked actor recovered private body';END IF;
 IF has_function_privilege('anon','public.inbox_freeze_reply_review(text,uuid)','EXECUTE') OR has_function_privilege('service_role','public.inbox_capture_reply_recipients(uuid[])','EXECUTE') THEN RAISE EXCEPTION 'Public RPC role boundary leaked';END IF;
 IF has_schema_privilege('authenticated','inbox_reply_review','USAGE') OR has_function_privilege('service_role','inbox_reply_review.freeze(text,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private review leaked';END IF;
END $test$;
ROLLBACK;
"""
sql(''.join(parts)+test)
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL AND to_regnamespace('inbox_reply_review') IS NULL")!='t':raise RuntimeError('Rollback failed')
(P/'review-evidence.json').write_text(json.dumps({'sources':{str(path.relative_to(P.parent)):hashlib.sha256(path.read_bytes()).hexdigest() for path in sources},'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':['authenticated public capture/freeze derives canonical personalized literal body and route; default admission closed','same pair returns exact immutable snapshot after read update','same key changed body rejected','stored review cannot be updated','changed inbound blocks stale rendered content','whitespace and UTF16 1601+ bodies rejected; 1600 accepted','current canonical opt-out retained as review exclusion','suspended actor cannot retrieve old review','private functions/schema unavailable to external roles; public RPC denied to anon/service_role; whole test rolled back'],'limits':['Trusted SQL JWT claims; HTTP signature proof separate','No acceptance, worker dispatch or provider call']},indent=2)+'\n')
print('Nine actual immutable reply review groups passed; all new schemas/data rolled back')
