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
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL")!='t':raise RuntimeError('Refusing existing reply schema')
context=(P.parent/'inbox-reply-boundary'/'context.sql').read_text();recipient=(P/'recipient.sql').read_text();batch=(P/'batch.sql').read_text()
if not all(s.endswith('COMMIT;\n') and '\nBEGIN;\n' in s for s in [context,recipient,batch]):raise RuntimeError('Expected source transaction boundary')
test=r"""
DO $test$
DECLARE o uuid:=gen_random_uuid();foreign_org uuid:=gen_random_uuid();p uuid:=gen_random_uuid();c uuid:=gen_random_uuid();contact uuid:=gen_random_uuid();m uuid:=gen_random_uuid();sender uuid:=gen_random_uuid();missing uuid:=gen_random_uuid();c2 uuid:=gen_random_uuid();a jsonb;b jsonb;before_count bigint;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned reply preparation'),(foreign_org,'Foreign reply preparation');
 INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(contact,o,'Ada','(816) 555-0100','mobile');
 INSERT INTO properties(id,org_id,address,state,market,homeowner_contact_id) VALUES(p,o,'Owned reply property','MO','KC',contact);
 INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES(sender,o,'sendillo','+18165550101','active');
 INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(m,o,c,contact,p,'sms','inbound','received','Owned inbound','+18165550100','+18165550101');
 a:=inbox_reply_preparation.recipient(o,c);
 IF a->>'exclusion' IS NOT NULL OR a->>'from'<>'+18165550101' OR a->>'to'<>'+18165550100' OR a->'variables'->>'first_name'<>'Ada' OR a->'variables'->>'market'<>'KC' THEN RAISE EXCEPTION 'Canonical route/personalization mismatch: %',a;END IF;

 INSERT INTO messages(org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(o,c2,contact,p,'sms','inbound','received','Second owned inbound','+18165550100','+18165550101');
 b:=inbox_reply_preparation.batch(o,ARRAY[c,c2,missing]);
 IF b->>'has_duplicate_destinations'<>'true' OR b->>'distinct_recipient_count'<>'1' OR (SELECT count(*) FROM jsonb_array_elements(b->'items') WHERE value->>'duplicate_destination'='true')<>2 THEN RAISE EXCEPTION 'Duplicate destination conflict missing: %',b;END IF;
 BEGIN PERFORM inbox_reply_preparation.batch(o,ARRAY[c,c]);RAISE EXCEPTION 'Duplicate target admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
 BEGIN PERFORM inbox_reply_preparation.batch(o,ARRAY[c,NULL]);RAISE EXCEPTION 'Null target admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
 BEGIN PERFORM inbox_reply_preparation.batch(o,ARRAY[]::uuid[]);RAISE EXCEPTION 'Empty targets admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
 IF inbox_reply_preparation.quiet_hours('MO','2026-01-15T14:00:00Z')->>'ok'<>'true' OR inbox_reply_preparation.quiet_hours('MO','2026-01-15T13:59:59Z')->>'ok'<>'false' OR inbox_reply_preparation.quiet_hours('MO','2026-01-16T03:00:00Z')->>'ok'<>'false' THEN RAISE EXCEPTION 'Winter window boundary wrong';END IF;
 IF inbox_reply_preparation.quiet_hours(' mo ','2026-07-15T13:00:00Z')->>'ok'<>'true' OR inbox_reply_preparation.quiet_hours('MO','2026-07-16T02:00:00Z')->>'ok'<>'false' OR inbox_reply_preparation.quiet_hours('ZZ',clock_timestamp())->>'ok'<>'false' OR inbox_reply_preparation.quiet_hours('GU','2026-07-14T22:00:00Z')->>'ok'<>'true' THEN RAISE EXCEPTION 'Summer/territory/state window wrong';END IF;
 UPDATE messages SET read_at=clock_timestamp() WHERE id=m;
 b:=inbox_reply_preparation.recipient(o,c);
 IF b->>'exclusion' IS NOT NULL OR a->'dependencies'->>'known_reply' IS DISTINCT FROM b->'dependencies'->>'known_reply' THEN RAISE EXCEPTION 'Read status invalidated reply content';END IF;
 UPDATE messages SET body='Edited inbound' WHERE id=m;
 b:=inbox_reply_preparation.recipient(o,c);
 IF a->'dependencies'->>'known_reply'=b->'dependencies'->>'known_reply' THEN RAISE EXCEPTION 'Inbound edit missing revision';END IF;
 SELECT count(*) INTO before_count FROM public.inbox_inbound_heads;
 IF inbox_reply_preparation.recipient(foreign_org,c)->>'exclusion'<>'conversation_unavailable' OR inbox_reply_preparation.recipient(o,missing)->>'exclusion'<>'conversation_unavailable' THEN RAISE EXCEPTION 'Foreign/missing target admitted';END IF;
 IF (SELECT count(*) FROM public.inbox_inbound_heads)<>before_count THEN RAISE EXCEPTION 'Missing target allocated head';END IF;
 UPDATE contacts SET phone_1_type='landline' WHERE id=contact;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion'<>'landline' THEN RAISE EXCEPTION 'Landline admitted';END IF;
 UPDATE contacts SET phone_1_type='mobile',phone_1='+18165550999' WHERE id=contact;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion'<>'phone_not_saved' THEN RAISE EXCEPTION 'Unsaved route admitted';END IF;
 UPDATE contacts SET phone_1='+18165550100' WHERE id=contact;
 UPDATE provider_sender_numbers SET status='inactive' WHERE id=sender;
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion'<>'sender_unavailable' THEN RAISE EXCEPTION 'Inactive sender admitted';END IF;
 UPDATE provider_sender_numbers SET status='active' WHERE id=sender;
 INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,contact,'sms','opt_out','owned_reply_test');
 IF inbox_reply_preparation.recipient(o,c)->>'exclusion'<>'sms_suppressed' THEN RAISE EXCEPTION 'Opt-out admitted';END IF;
 IF has_schema_privilege('authenticated','inbox_reply_preparation','USAGE') OR has_function_privilege('authenticated','inbox_reply_preparation.recipient(uuid,uuid)','EXECUTE') THEN RAISE EXCEPTION 'Private recipient exposed';END IF;
END $test$;
DO $cap$
DECLARE o uuid:=gen_random_uuid();p uuid;contact uuid;c uuid;ids uuid[]:='{}';first_contact uuid;a jsonb;i integer;destination text;
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned 51-recipient cap');
 INSERT INTO provider_sender_numbers(org_id,provider,phone_e164,status) VALUES(o,'sendillo','+18165550101','active');
 FOR i IN 1..51 LOOP
  p:=gen_random_uuid();contact:=gen_random_uuid();c:=gen_random_uuid();ids:=array_append(ids,c);destination:='+120255501'||lpad(i::text,2,'0');
  IF i=1 THEN first_contact:=contact;END IF;
  INSERT INTO contacts(id,org_id,phone_1,phone_1_type) VALUES(contact,o,destination,'mobile');
  INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(p,o,'Owned cap property','MO',contact);
  INSERT INTO messages(org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(o,c,contact,p,'sms','inbound','received','Owned cap inbound',destination,'+18165550101');
 END LOOP;
 a:=inbox_reply_preparation.batch(o,ids);
 IF a->>'distinct_recipient_count'<>'51' OR a->>'over_recipient_limit'<>'true' THEN RAISE EXCEPTION '51 recipients not blocked: %',a->>'distinct_recipient_count';END IF;
 UPDATE contacts SET sms_opted_out=true WHERE id=first_contact;
 a:=inbox_reply_preparation.batch(o,ids);
 IF a->>'distinct_recipient_count'<>'50' OR a->>'over_recipient_limit'<>'false' OR jsonb_array_length(a->'items')<>51 THEN RAISE EXCEPTION 'Cap evaluated before canonical exclusions';END IF;
 BEGIN PERFORM inbox_reply_preparation.batch(o,array_fill(gen_random_uuid(),ARRAY[501]));RAISE EXCEPTION '501 target envelope admitted' USING ERRCODE='ZX001';EXCEPTION WHEN raise_exception THEN NULL;END;
END $cap$;
ROLLBACK;
"""
sql(context.removesuffix('COMMIT;\n')+recipient.removesuffix('COMMIT;\n').replace('\nBEGIN;\n','\n',1)+batch.removesuffix('COMMIT;\n').replace('\nBEGIN;\n','\n',1)+test)
if sql("SELECT to_regnamespace('inbox_reply_context') IS NULL AND to_regnamespace('inbox_reply_preparation') IS NULL")!='t':raise RuntimeError('Rollback failed')
(P/'recipient-evidence.json').write_text(json.dumps({'source_sha256':hashlib.sha256(recipient.encode()).hexdigest(),'batch_sha256':hashlib.sha256(batch.encode()).hexdigest(),'context_sha256':hashlib.sha256(context.encode()).hexdigest(),'runner_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'checks':['canonical contact, normalized saved destination, sender inventory and variables','read status leaves known-reply content revision unchanged','edited inbound advances reply revision','foreign and missing target denied without head allocation','landline and unsaved destination excluded','inactive inventory sender excluded','canonical consent opt-out excluded','private API grants denied; whole proof rolled back','same destination flags every affected conversation; no silent deduplication','duplicate/null/empty target rejection','winter opening and closing boundaries','summer DST, territory and unknown state policy','51 canonical destinations blocked, 50 after one opt-out exclusion retained in review','501 target envelope rejected'],'limits':['Private recipient capture only; not public preparation or dispatch authorization','Batch limit signal is not acceptance enforcement; immutable approval and actual dispatch still required','No provider call or production change']},indent=2)+'\n')
print('Fourteen actual canonical recipient/batch groups passed; all new schema/data rolled back')
