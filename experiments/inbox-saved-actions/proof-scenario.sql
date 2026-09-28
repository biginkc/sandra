DO $test$
DECLARE o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();other_u uuid:=gen_random_uuid();other_o uuid:=gen_random_uuid();sess uuid:=gen_random_uuid();other_sess uuid:=gen_random_uuid();other_o_sess uuid:=gen_random_uuid();
 assignee uuid:=gen_random_uuid();a jsonb;b jsonb;failed boolean;saved_id uuid;def1 jsonb;def2 jsonb;other_org_member uuid:=gen_random_uuid();
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned saved-actions proof'),(other_o,'Owned saved-actions proof other org');
 INSERT INTO auth.users(id,email) VALUES(other_org_member,other_org_member::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(other_o,other_org_member,'owner','active');
 INSERT INTO auth.users(id,email) VALUES(u,u::text||'@example.invalid'),(other_u,other_u::text||'@example.invalid'),(assignee,assignee::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(o,u,'owner','active'),(o,other_u,'member','active'),(o,assignee,'member','active');
 INSERT INTO auth.sessions(id,user_id,not_after) VALUES(sess,u,clock_timestamp()+interval '1 hour'),(other_sess,other_u,clock_timestamp()+interval '1 hour');

 def1:=jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','outcome','value','not_interested')));

 -- 1) CREATE -> version 1
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',sess,'exp',4102444800)::text,true);
 EXECUTE 'SET LOCAL ROLE authenticated';
 a:=public.inbox_saved_action_create('Not interested',def1);
 EXECUTE 'RESET ROLE';
 IF a->>'version'<>'1' OR a->'definition'<>def1 THEN RAISE EXCEPTION 'create mismatch: %',a; END IF;
 saved_id:=(a->>'id')::uuid;
 RAISE NOTICE 'PASS create v1 id=%',saved_id;

 -- 2) UPDATE -> version 2
 def2:=jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','outcome','value','nurture'),jsonb_build_object('type','assign','userId',assignee)));
 EXECUTE 'SET LOCAL ROLE authenticated';
 b:=public.inbox_saved_action_update(saved_id,'Nurture + assign',def2);
 EXECUTE 'RESET ROLE';
 IF b->>'version'<>'2' THEN RAISE EXCEPTION 'update did not bump version: %',b; END IF;
 RAISE NOTICE 'PASS update -> v2';

 -- 3) MUTATION: attempt to UPDATE v1's definition directly -> must be blocked by immutable_row trigger
 failed:=false;
 BEGIN
  UPDATE inbox_saved_actions.definitions SET definition=jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','outcome','value','dnc'))) WHERE org_id=o AND id=saved_id AND version=1;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='Immutable operation input or receipt' THEN failed:=true; ELSE RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'MUTATION FAILED TO CATCH: v1 definition was mutable'; END IF;
 RAISE NOTICE 'PASS mutation caught: v1 immutable';

 -- 3b) attempt to UPDATE v2 (the "already accepted"/current) row directly -> also blocked
 failed:=false;
 BEGIN
  UPDATE inbox_saved_actions.definitions SET is_active=false WHERE org_id=o AND id=saved_id AND version=2;
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='Immutable operation input or receipt' THEN failed:=true; ELSE RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'MUTATION FAILED TO CATCH: v2 row was mutable'; END IF;
 RAISE NOTICE 'PASS mutation caught: v2 row immutable (versions insert-only)';

 -- 4) requester scoping: other_u (same org) cannot read/write u's saved action
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',other_u,'role','authenticated','session_id',other_sess,'exp',4102444800)::text,true);
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_get(saved_id,2);
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_NOT_FOUND' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'CROSS-REQUESTER READ LEAKED'; END IF;
 RAISE NOTICE 'PASS cross-requester get rejected';

 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_update(saved_id,'hijacked',def1);
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_NOT_FOUND' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'CROSS-REQUESTER UPDATE LEAKED'; END IF;
 RAISE NOTICE 'PASS cross-requester update rejected';

 -- 5) cross-org rejected (other_u authenticated but scoped to other_o membership too; use org mismatch via authorize(o,u))
 failed:=false;
 BEGIN
  PERFORM inbox_saved_actions.get(other_o,u,saved_id,2);
 EXCEPTION WHEN insufficient_privilege THEN failed:=true;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'CROSS-ORG GET LEAKED'; END IF;
 RAISE NOTICE 'PASS cross-org rejected (42501)';

 -- 6) reference validation at SAVE: assignee not eligible (not a member) rejected
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',sess,'exp',4102444800)::text,true);
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_create('Bad assignee',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','assign','userId',gen_random_uuid()))));
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_ASSIGNEE_UNAVAILABLE' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'INELIGIBLE ASSIGNEE ADMITTED AT SAVE'; END IF;
 RAISE NOTICE 'PASS save-time reference validation (ineligible assignee rejected)';

 -- 7) reference validation at EXECUTE (re-validated by get()): assignee becomes ineligible after save
 UPDATE memberships SET access_status='suspended' WHERE org_id=o AND user_id=assignee;
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_get(saved_id,2);
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_ASSIGNEE_UNAVAILABLE' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'STALE INELIGIBLE ASSIGNEE ADMITTED AT EXECUTE-TIME GET'; END IF;
 RAISE NOTICE 'PASS execute-time re-validation (assignee revoked after save -> get() rejects)';
 UPDATE memberships SET access_status='active' WHERE org_id=o AND user_id=assignee;
 -- now get() should pass again (control: prove the check is a real gate, not a permanent break)
 EXECUTE 'SET LOCAL ROLE authenticated';
 a:=public.inbox_saved_action_get(saved_id,2);
 EXECUTE 'RESET ROLE';
 IF a->>'version'<>'2' THEN RAISE EXCEPTION 'get() did not recover after restoring eligibility: %',a; END IF;
 RAISE NOTICE 'PASS get() recovers once assignee restored (control)';

 -- 8) disabled gated step type (promote) rejected at SAVE
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_create('Promote',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','promote'))));
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_STEP_TYPE_DISABLED' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'DISABLED STEP TYPE (promote) ADMITTED AT SAVE'; END IF;
 RAISE NOTICE 'PASS disabled gated step type (promote) rejected at save';

 -- 9) dnc gated outcome rejected at SAVE
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_create('DNC',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','outcome','value','dnc'))));
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='permanent_dnc_not_enabled' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'GATED dnc OUTCOME ADMITTED AT SAVE'; END IF;
 RAISE NOTICE 'PASS gated dnc outcome rejected at save';

 -- 9b) review_reply whitespace-only text must match the TypeScript parser's
 -- trim-before-length contract and be rejected at save.
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_create('Blank reply',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','review_reply','text','   '))));
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_INVALID_DEFINITION' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'WHITESPACE-ONLY REVIEW REPLY ADMITTED AT SAVE'; END IF;
 RAISE NOTICE 'PASS whitespace-only review_reply rejected at save';

 -- 9c) SQL must match JavaScript UTF-16 length semantics: 1600 astral
 -- code points occupy 3200 JS code units and must be rejected.
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_create('Long emoji reply',jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','review_reply','text',repeat('😀',1600)))));
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_INVALID_DEFINITION' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'UTF-16-OVERSIZE REVIEW REPLY ADMITTED AT SAVE'; END IF;
 RAISE NOTICE 'PASS UTF-16-oversize review_reply rejected at save';

 -- 10) DEACTIVATE -> version 3, is_active=false; stale get() of v2 now rejected (stale version)
 EXECUTE 'SET LOCAL ROLE authenticated';
 b:=public.inbox_saved_action_deactivate(saved_id);
 EXECUTE 'RESET ROLE';
 IF b->>'version'<>'3' OR b->>'is_active'<>'false' THEN RAISE EXCEPTION 'deactivate mismatch: %',b; END IF;
 failed:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM public.inbox_saved_action_get(saved_id,2);
  EXECUTE 'RESET ROLE';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM='INBOX_SAVED_ACTION_STALE_VERSION' THEN failed:=true; ELSE EXECUTE 'RESET ROLE'; RAISE; END IF;
 END;
 IF NOT failed THEN RAISE EXCEPTION 'STALE (DEACTIVATED) VERSION EXECUTABLE VIA GET'; END IF;
 RAISE NOTICE 'PASS deactivate -> v3 tombstone; stale v2 get() rejected';

 -- 11) list() excludes deactivated id
 EXECUTE 'SET LOCAL ROLE authenticated';
 a:=public.inbox_saved_action_list();
 EXECUTE 'RESET ROLE';
 IF a->'items' @> jsonb_build_array(jsonb_build_object('id',saved_id)) THEN RAISE EXCEPTION 'DEACTIVATED SAVED ACTION STILL LISTED: %',a; END IF;
 RAISE NOTICE 'PASS list() excludes deactivated saved action';

 -- 12) private RPC / public wrapper least-privilege boundary
 IF has_function_privilege('anon','public.inbox_saved_action_get(uuid,integer)','EXECUTE') OR has_function_privilege('service_role','public.inbox_saved_action_get(uuid,integer)','EXECUTE') THEN RAISE EXCEPTION 'Public saved-action RPC role boundary leaked'; END IF;
 IF has_schema_privilege('authenticated','inbox_saved_actions','USAGE') THEN RAISE EXCEPTION 'Private saved-actions schema leaked to authenticated'; END IF;

 RAISE NOTICE 'ALL SAVED-ACTION SQL PROOFS PASSED';
 -- Cleanup: rollback via caller (this whole script runs inside an explicit transaction)
END $test$;
-- Astra round-1 blocker #1: prove the widened inbox_action_api.prepare
-- envelope guard (action-prepare-saved-reference.sql) actually lets a saved
-- action flow through prepare() END TO END against the real RPC (not just
-- a TS-side mock), and that a tampered/malformed savedAction reference is
-- still rejected, and that savedAction:null (inline/non-saved requests)
-- keeps working exactly as before.
DO $e2e_prepare$
DECLARE o uuid:=gen_random_uuid();u uuid:=gen_random_uuid();sess uuid:=gen_random_uuid();c uuid:=gen_random_uuid();contact uuid:=gen_random_uuid();p uuid:=gen_random_uuid();m uuid:=gen_random_uuid();
 saved_a jsonb;saved_id uuid;def jsonb;canonical jsonb;prep jsonb;failed boolean;k uuid:=gen_random_uuid();
BEGIN
 INSERT INTO organizations(id,name) VALUES(o,'Owned saved-action end-to-end prepare');
 INSERT INTO auth.users(id,email) VALUES(u,u::text||'@example.invalid');
 INSERT INTO memberships(org_id,user_id,role,access_status) VALUES(o,u,'owner','active');
 INSERT INTO auth.sessions(id,user_id,not_after) VALUES(sess,u,clock_timestamp()+interval '1 hour');
 INSERT INTO contacts(id,org_id,first_name) VALUES(contact,o,'Synthetic');
 INSERT INTO properties(id,org_id,address,state,homeowner_contact_id) VALUES(p,o,'Saved-action e2e property','MO',contact);
 INSERT INTO messages(id,org_id,conversation_id,contact_id,property_id,channel,direction,status,body) VALUES(m,o,c,contact,p,'sms','inbound','received','Owned saved-action e2e fixture');

 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated','session_id',sess,'exp',4102444800)::text,true);
 def:=jsonb_build_object('version',1,'steps',jsonb_build_array(jsonb_build_object('type','outcome','value','not_interested')));
 EXECUTE 'SET LOCAL ROLE authenticated';
 saved_a:=public.inbox_saved_action_create('E2E not interested',def);
 EXECUTE 'RESET ROLE';
 saved_id:=(saved_a->>'id')::uuid;

 -- 1) A well-formed non-null savedAction reference in the envelope is now
 -- ACCEPTED by inbox_action_api.prepare (previously unconditionally
 -- rejected as 'Invalid action envelope').
 canonical:=jsonb_build_object('purpose','prepare_action','organizationId',o,'requesterId',u,'targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'definition',def,'savedAction',jsonb_build_object('id',saved_id,'version',1));
 prep:=inbox_action_api.prepare(canonical::text,k);
 IF prep->>'preparation_id' IS NULL OR (prep->'definition')<>def THEN RAISE EXCEPTION 'Saved-action prepare did not succeed end-to-end: %',prep; END IF;
 RAISE NOTICE 'PASS saved-action reference accepted by inbox_action_api.prepare end-to-end (preparation_id=%)',prep->>'preparation_id';

 -- 2) Tampered/malformed savedAction shapes are still rejected (envelope
 -- guard, not just a downstream ownership check).
 FOREACH canonical IN ARRAY ARRAY[
  jsonb_build_object('purpose','prepare_action','organizationId',o,'requesterId',u,'targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'definition',def,'savedAction',jsonb_build_object('id',saved_id,'version',-1)),
  jsonb_build_object('purpose','prepare_action','organizationId',o,'requesterId',u,'targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'definition',def,'savedAction',jsonb_build_object('id','not-a-uuid','version',1)),
  jsonb_build_object('purpose','prepare_action','organizationId',o,'requesterId',u,'targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'definition',def,'savedAction',jsonb_build_object('id',saved_id,'version',1,'extra','x')),
  jsonb_build_object('purpose','prepare_action','organizationId',o,'requesterId',u,'targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'definition',def,'savedAction','"not-an-object"')
 ] LOOP
  failed:=false;
  BEGIN PERFORM inbox_action_api.prepare(canonical::text,gen_random_uuid());
  EXCEPTION WHEN raise_exception THEN IF SQLERRM='Invalid action envelope' THEN failed:=true; ELSE RAISE; END IF;
  END;
  IF NOT failed THEN RAISE EXCEPTION 'TAMPERED SAVEDACTION REFERENCE ADMITTED: %',canonical; END IF;
 END LOOP;
 RAISE NOTICE 'PASS tampered/malformed savedAction shapes still rejected (envelope guard)';

 -- 3) Backward compatibility: savedAction:null (inline/non-saved requests,
 -- the pre-existing behavior) still accepted exactly as before.
 canonical:=jsonb_build_object('purpose','prepare_action','organizationId',o,'requesterId',u,'targets',jsonb_build_array(jsonb_build_object('kind','conversation','id',c)),'definition',def,'savedAction','null'::jsonb);
 prep:=inbox_action_api.prepare(canonical::text,gen_random_uuid());
 IF prep->>'preparation_id' IS NULL THEN RAISE EXCEPTION 'Backward-compatible null savedAction broke: %',prep; END IF;
 RAISE NOTICE 'PASS savedAction:null (inline/non-saved requests) still accepted (backward compatible)';

 RAISE NOTICE 'ALL SAVED-ACTION END-TO-END PREPARE PROOFS PASSED';
END $e2e_prepare$;
