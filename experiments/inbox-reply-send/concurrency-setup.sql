DO $setup$
DECLARE
 o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();sess uuid:=gen_random_uuid();s uuid:=gen_random_uuid();
 n integer:=12;i integer;cids uuid[];pids uuid[];ctids uuid[];targets jsonb:='[]';drafts jsonb:='[]';
 capture jsonb;freeze_result jsonb;prep_id uuid;items jsonb;op_id uuid:=gen_random_uuid();k uuid:=gen_random_uuid();
 chosen_state text;itemv jsonb;
 -- Second, isolated small preparation+operation (P2.3): a clean 0-attempts
 -- slate makes the per-operation cap race arithmetic trivial (no need to
 -- track how many attempts earlier proofs already inserted).
 cap_cids uuid[];cap_targets jsonb:='[]';cap_capture jsonb;cap_drafts jsonb;cap_freeze jsonb;cap_prep_id uuid;cap_items jsonb;cap_op_id uuid:=gen_random_uuid();cap_k uuid:=gen_random_uuid();
BEGIN
 -- quiet_hours() gates on wall-clock local time; no single US zone in its
 -- table keeps 08:00-21:00 local safely inside every possible UTC hour this
 -- harness might run in. None of the concurrency proofs here concern
 -- quiet_hours transitions, so pin it to always-open (dropped along with the
 -- rest of inbox_reply_preparation in this script's own cleanup) rather than
 -- chase a magic state/time combination.
 CREATE OR REPLACE FUNCTION inbox_reply_preparation.quiet_hours(state text,at_time timestamptz) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path='' AS $qh$ SELECT jsonb_build_object('ok',true,'zone','Etc/UTC','local_time','12:00:00') $qh$;
 chosen_state:='MO';
 -- Matching the established precedent (inbox-reply-preparation/recipient-
 -- concurrency.py): this owned-fixture concurrency proof commits real rows
 -- across separate connections and, per that convention, leaves the
 -- uniquely marked synthetic canonical rows in place afterward rather than
 -- deleting them — only the private schemas this file installs are dropped.
 -- The org name carries a fresh random suffix so repeated runs never collide
 -- on the organizations.name UNIQUE constraint.
 INSERT INTO organizations(id,name) VALUES(o,'Owned PR-D concurrency '||o);
 INSERT INTO auth.users(id,email) VALUES(u,u::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(o,u,'owner','active');
 INSERT INTO auth.sessions(id,user_id,not_after) VALUES(sess,u,clock_timestamp()+interval '1 hour');
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',sess,'exp',4102444800)::text,true);
 INSERT INTO provider_sender_numbers(id,org_id,provider,phone_e164,status) VALUES(s,o,'sendillo','+18165550101','active');
 FOR i IN 1..n LOOP
  DECLARE cid uuid:=gen_random_uuid();pid uuid:=gen_random_uuid();ctid uuid:=gen_random_uuid();dest text:='+130255'||lpad(i::text,5,'0');
  BEGIN
   INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(ctid,o,'CConc'||i,dest,'mobile');
   INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,ctid,'sms','opt_in_confirmed','owned_prd_concurrency');
   INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(pid,o,'Owned PR-D concurrency property '||i,chosen_state,ctid);
   INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),o,cid,ctid,pid,'sms','inbound','received','Owned PR-D concurrency inbound '||i,dest,'+18165550101');
   cids:=cids||cid;pids:=pids||pid;ctids:=ctids||ctid;
   targets:=targets||jsonb_build_array(jsonb_build_object('kind','conversation','id',cid));
  END;
 END LOOP;
 UPDATE inbox_reply_review.admission SET enabled=true WHERE singleton;
 EXECUTE 'SET LOCAL ROLE authenticated';
 capture:=public.inbox_capture_reply_recipients(cids);
 EXECUTE 'RESET ROLE';
 SELECT jsonb_agg(jsonb_build_object('conversationId',item->>'conversation_id','body','Hi there','dependencies',item->'dependencies','exclusion',NULL) ORDER BY item->>'conversation_id') INTO drafts FROM jsonb_array_elements(capture->'items') item;
 EXECUTE 'SET LOCAL ROLE authenticated';
 freeze_result:=public.inbox_freeze_reply_review(jsonb_build_object('targets',targets,'drafts',drafts,'template','Hi there')::text,gen_random_uuid());
 EXECUTE 'RESET ROLE';
 IF freeze_result->>'recipientCount'<>n::text OR freeze_result->'blockers'<>'[]'::jsonb THEN RAISE EXCEPTION 'Unexpected concurrency freeze result: %',freeze_result;END IF;
 prep_id:=(freeze_result->>'preparationId')::uuid;
 SELECT p.items INTO items FROM inbox_reply_review.preparations p WHERE p.id=prep_id;
 INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key) VALUES(o,op_id,u,prep_id,k);
 -- Only items 1..10 get a real attempt row inserted here; items 11 and 12
 -- are left as frozen-but-unattempted so concurrency.py can insert their
 -- first attempt itself, mid-race, for the P1.2 proof.
 FOR i IN 1..10 LOOP
  itemv:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[i]::text);
  INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(itemv->>'id')::uuid,1,(itemv->'recipient'->>'contactId')::uuid,itemv->'recipient'->>'from',itemv->'recipient'->>'to',inbox_reply_send.body_hash(itemv->'recipient'->>'renderedBody',itemv->'recipient'->>'from',itemv->'recipient'->>'to'),'approved');
 END LOOP;

 -- P2.3 cap-race fixture: three fresh conversations under their own
 -- preparation+operation, zero attempts inserted yet.
 FOR i IN 1..3 LOOP
  DECLARE cid uuid:=gen_random_uuid();pid uuid:=gen_random_uuid();ctid uuid:=gen_random_uuid();dest text:='+130256'||lpad(i::text,5,'0');
  BEGIN
   INSERT INTO contacts(id,org_id,first_name,phone_1,phone_1_type) VALUES(ctid,o,'CCap'||i,dest,'mobile');
   INSERT INTO consent_events(org_id,contact_id,channel,event_type,source) VALUES(o,ctid,'sms','opt_in_confirmed','owned_prd_concurrency');
   INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(pid,o,'Owned PR-D cap property '||i,chosen_state,ctid);
   INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body,from_address,to_address) VALUES(gen_random_uuid(),o,cid,ctid,pid,'sms','inbound','received','Owned PR-D cap inbound '||i,dest,'+18165550101');
   cap_cids:=cap_cids||cid;
   cap_targets:=cap_targets||jsonb_build_array(jsonb_build_object('kind','conversation','id',cid));
  END;
 END LOOP;
 EXECUTE 'SET LOCAL ROLE authenticated';
 cap_capture:=public.inbox_capture_reply_recipients(cap_cids);
 EXECUTE 'RESET ROLE';
 SELECT jsonb_agg(jsonb_build_object('conversationId',item->>'conversation_id','body','Hi there','dependencies',item->'dependencies','exclusion',NULL) ORDER BY item->>'conversation_id') INTO cap_drafts FROM jsonb_array_elements(cap_capture->'items') item;
 EXECUTE 'SET LOCAL ROLE authenticated';
 cap_freeze:=public.inbox_freeze_reply_review(jsonb_build_object('targets',cap_targets,'drafts',cap_drafts,'template','Hi there')::text,gen_random_uuid());
 EXECUTE 'RESET ROLE';
 IF cap_freeze->>'recipientCount'<>'3' OR cap_freeze->'blockers'<>'[]'::jsonb THEN RAISE EXCEPTION 'Unexpected cap-fixture freeze result: %',cap_freeze;END IF;
 cap_prep_id:=(cap_freeze->>'preparationId')::uuid;
 SELECT p.items INTO cap_items FROM inbox_reply_review.preparations p WHERE p.id=cap_prep_id;
 INSERT INTO inbox_reply_send.operations(org_id,id,requester_id,preparation_id,idempotency_key) VALUES(o,cap_op_id,u,cap_prep_id,cap_k);
 -- Zero attempts inserted for the cap operation — concurrency.py races the
 -- first two inserts itself.
 RAISE NOTICE 'CONCURRENCY-SETUP org=%, cap_op=%, cap_prep=%',o,cap_op_id,cap_prep_id;
END $setup$;
