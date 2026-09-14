DO $setup$
DECLARE
 o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();sess uuid:=gen_random_uuid();s uuid:=gen_random_uuid();
 n integer:=10;i integer;cids uuid[];pids uuid[];ctids uuid[];targets jsonb:='[]';drafts jsonb:='[]';
 capture jsonb;freeze_result jsonb;prep_id uuid;items jsonb;op_id uuid:=gen_random_uuid();k uuid:=gen_random_uuid();
 chosen_state text;itemv jsonb;
BEGIN
 SELECT state INTO STRICT chosen_state FROM (VALUES('MO'),('HI'),('GU'),('PR')) states(state) WHERE inbox_reply_preparation.quiet_hours(state,clock_timestamp())->>'ok'='true' LIMIT 1;
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
 FOR i IN 1..n LOOP
  itemv:=(SELECT value FROM jsonb_array_elements(items) value WHERE value->'target'->>'id'=cids[i]::text);
  INSERT INTO inbox_reply_send.attempts(org_id,id,operation_id,preparation_id,item_id,attempt_ordinal,contact_id,from_e164,to_e164,body_hash,state)
   VALUES(o,gen_random_uuid(),op_id,prep_id,(itemv->>'id')::uuid,1,(itemv->'recipient'->>'contactId')::uuid,itemv->'recipient'->>'from',itemv->'recipient'->>'to',inbox_reply_send.body_hash(itemv->'recipient'->>'renderedBody',itemv->'recipient'->>'from',itemv->'recipient'->>'to'),'approved');
 END LOOP;
 RAISE NOTICE 'CONCURRENCY-SETUP org=%',o;
END $setup$;
