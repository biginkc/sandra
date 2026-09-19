BEGIN;
SET LOCAL lock_timeout='2s';SET LOCAL statement_timeout='30s';
-- Private durable acceptance core. No application grants, canonical writes or provider calls.

CREATE SCHEMA inbox_operations;
REVOKE ALL ON SCHEMA inbox_operations FROM PUBLIC;
CREATE TABLE inbox_operations.preparations (
 id uuid PRIMARY KEY, org_id uuid NOT NULL, requester_id uuid NOT NULL,
 canonical_input text NOT NULL CHECK(octet_length(canonical_input)<=131072),
 input_hash text NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object' AND octet_length(snapshot::text)<=2097152),
 expires_at timestamptz NOT NULL,
 UNIQUE(org_id,requester_id,id),
 CHECK((canonical_input::jsonb->>'organizationId')::uuid IS NOT DISTINCT FROM org_id),
 CHECK((canonical_input::jsonb->>'requesterId')::uuid IS NOT DISTINCT FROM requester_id),
 CHECK(canonical_input::jsonb->>'purpose' IS NOT DISTINCT FROM 'prepare_action'),
 CHECK(canonical_input::jsonb->'definition' IS NOT DISTINCT FROM definition),
 CHECK(input_hash=encode(sha256(convert_to('sandra:inbox:action:v1','UTF8')||decode('00','hex')||convert_to(canonical_input,'UTF8')),'hex'))
);
CREATE TABLE inbox_operations.operations (
 org_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),requester_id uuid NOT NULL,
 idempotency_key uuid NOT NULL,input_hash text NOT NULL,preparation_id uuid NOT NULL,
 definition jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,id),UNIQUE(org_id,requester_id,idempotency_key),
 FOREIGN KEY(org_id,requester_id,preparation_id) REFERENCES inbox_operations.preparations(org_id,requester_id,id)
);
CREATE TABLE inbox_operations.items (
 org_id uuid NOT NULL,operation_id uuid NOT NULL,id uuid NOT NULL,
 target_kind text NOT NULL CHECK(target_kind IN ('conversation','unknown_sender_group')),target_id uuid NOT NULL,
 resolution jsonb NOT NULL,exclusion_code text,
 PRIMARY KEY(org_id,operation_id,id),UNIQUE(org_id,operation_id,target_kind,target_id),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_operations.operations(org_id,id)
);
CREATE TABLE inbox_operations.steps (
 org_id uuid NOT NULL,operation_id uuid NOT NULL,id uuid NOT NULL DEFAULT gen_random_uuid(),
 effect_key text NOT NULL CHECK(length(effect_key) BETWEEN 1 AND 256),ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 4),
 action text NOT NULL CHECK(action IN ('outcome','assign','promote','dismiss_unknown','restore_unknown')),
 payload jsonb NOT NULL,dependencies jsonb NOT NULL,
 predecessor_id uuid,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','running','succeeded')),
 generation bigint NOT NULL DEFAULT 0 CHECK(generation>=0),lease_until timestamptz,
 receipt_version bigint NOT NULL DEFAULT 0 CHECK(receipt_version>=0),
 PRIMARY KEY(org_id,operation_id,id),UNIQUE(org_id,operation_id,effect_key,ordinal),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_operations.operations(org_id,id),
 FOREIGN KEY(org_id,operation_id,predecessor_id) REFERENCES inbox_operations.steps(org_id,operation_id,id),
 CHECK((state='running')=(lease_until IS NOT NULL))
);
CREATE TABLE inbox_operations.item_steps (
 org_id uuid NOT NULL,operation_id uuid NOT NULL,item_id uuid NOT NULL,step_id uuid NOT NULL,
 PRIMARY KEY(org_id,operation_id,item_id,step_id),
 FOREIGN KEY(org_id,operation_id,item_id) REFERENCES inbox_operations.items(org_id,operation_id,id),
 FOREIGN KEY(org_id,operation_id,step_id) REFERENCES inbox_operations.steps(org_id,operation_id,id)
);
CREATE TABLE inbox_operations.receipts (
 org_id uuid NOT NULL,operation_id uuid NOT NULL,step_id uuid NOT NULL,
 version bigint NOT NULL CHECK(version>0),generation bigint NOT NULL,
 result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),completed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(org_id,operation_id,step_id),
 FOREIGN KEY(org_id,operation_id,step_id) REFERENCES inbox_operations.steps(org_id,operation_id,id)
);
CREATE TABLE inbox_operations.dispatch_outbox (
 org_id uuid NOT NULL,operation_id uuid NOT NULL,event_id uuid NOT NULL DEFAULT gen_random_uuid(),
 generation bigint NOT NULL DEFAULT 0,lease_until timestamptz,acknowledged_at timestamptz,
 PRIMARY KEY(org_id,operation_id),UNIQUE(event_id),
 FOREIGN KEY(org_id,operation_id) REFERENCES inbox_operations.operations(org_id,id)
);
CREATE FUNCTION inbox_operations.immutable_row() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Immutable operation input or receipt'; END $$;
CREATE TRIGGER immutable_preparation BEFORE UPDATE OR DELETE ON inbox_operations.preparations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON inbox_operations.operations FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE TRIGGER immutable_item BEFORE UPDATE OR DELETE ON inbox_operations.items FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE TRIGGER immutable_receipt BEFORE UPDATE OR DELETE ON inbox_operations.receipts FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
-- Required integration adapters: deliberately unavailable until actual locked
-- authorization/canonical eligibility checks exist. A boolean from HTTP is not an adapter.
CREATE FUNCTION inbox_operations.assert_request_access(o uuid,u uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Authoritative request access unavailable'; END $$;
CREATE FUNCTION inbox_operations.assert_current_preparation(p uuid) RETURNS void LANGUAGE plpgsql SET search_path='' AS $$
BEGIN RAISE EXCEPTION 'Authoritative preparation unavailable'; END $$;
CREATE FUNCTION inbox_operations.accept_prepared(o uuid,u uuid,k uuid,p uuid) RETURNS uuid LANGUAGE plpgsql SET search_path='' AS $$
DECLARE prep inbox_operations.preparations; op inbox_operations.operations; item jsonb; effect jsonb; sid uuid; prev uuid; mapped uuid; n integer;
BEGIN
 IF o IS NULL OR u IS NULL OR k IS NULL OR p IS NULL THEN RAISE EXCEPTION 'Invalid operation identity';END IF;
 PERFORM inbox_operations.assert_request_access(o,u);
 SELECT * INTO prep FROM inbox_operations.preparations WHERE id=p AND org_id=o AND requester_id=u;
 IF NOT FOUND THEN RAISE EXCEPTION 'Preparation unavailable';END IF;
 -- Replay returns durable identity even after preparation expiry. Current response
 -- access is checked above; a new request with a different hash still conflicts.
 SELECT * INTO op FROM inbox_operations.operations WHERE org_id=o AND requester_id=u AND idempotency_key=k;
 IF FOUND THEN
  IF op.input_hash<>prep.input_hash THEN RAISE EXCEPTION 'Idempotency conflict' USING ERRCODE='P0001';END IF;
  RETURN op.id;
 END IF;
 INSERT INTO inbox_operations.operations(org_id,requester_id,idempotency_key,input_hash,preparation_id,definition)
 VALUES(o,u,k,prep.input_hash,p,prep.definition) ON CONFLICT(org_id,requester_id,idempotency_key) DO NOTHING RETURNING * INTO op;
 IF NOT FOUND THEN
  SELECT * INTO op FROM inbox_operations.operations WHERE org_id=o AND requester_id=u AND idempotency_key=k;
  IF op.id IS NULL OR op.input_hash<>prep.input_hash THEN RAISE EXCEPTION 'Idempotency conflict';END IF;
  RETURN op.id;
 END IF;
 -- Reserve the unique key before fresh validation. A concurrent accepted replay
 -- must return the existing durable operation rather than fail on later expiry.
 IF prep.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Preparation expired';END IF;
 PERFORM inbox_operations.assert_current_preparation(p);
 IF prep.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'Preparation expired';END IF;
 IF jsonb_typeof(prep.snapshot->'items') IS DISTINCT FROM 'array' OR jsonb_array_length(prep.snapshot->'items') NOT BETWEEN 1 AND 500 OR jsonb_typeof(prep.snapshot->'effects') IS DISTINCT FROM 'array' OR jsonb_array_length(prep.snapshot->'effects')>2500 THEN RAISE EXCEPTION 'Invalid bounded preparation';END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(prep.snapshot->'items') LOOP
  IF jsonb_typeof(item->'resolution') IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid item resolution';END IF;
  INSERT INTO inbox_operations.items VALUES(o,op.id,(item->>'id')::uuid,item->>'kind',(item->>'target_id')::uuid,item->'resolution',item->>'exclusion_code');
 END LOOP;
 FOR effect IN SELECT value FROM jsonb_array_elements(prep.snapshot->'effects') ORDER BY value->>'effect_key',(value->>'ordinal')::integer LOOP
  IF jsonb_typeof(effect->'payload') IS DISTINCT FROM 'object' OR jsonb_typeof(effect->'dependencies') IS DISTINCT FROM 'object' OR jsonb_typeof(effect->'item_ids') IS DISTINCT FROM 'array' OR jsonb_array_length(effect->'item_ids') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid prepared effect';END IF;
  prev:=NULL;
  SELECT id INTO prev FROM inbox_operations.steps WHERE org_id=o AND operation_id=op.id AND effect_key=effect->>'effect_key' ORDER BY ordinal DESC LIMIT 1;
  INSERT INTO inbox_operations.steps(org_id,operation_id,effect_key,ordinal,action,payload,dependencies,predecessor_id)
  VALUES(o,op.id,effect->>'effect_key',(effect->>'ordinal')::integer,effect->>'action',effect->'payload',effect->'dependencies',prev) RETURNING id INTO sid;
  FOR mapped IN SELECT value::text::uuid FROM jsonb_array_elements_text(effect->'item_ids') LOOP
   IF NOT EXISTS(SELECT 1 FROM inbox_operations.items WHERE org_id=o AND operation_id=op.id AND id=mapped AND exclusion_code IS NULL) THEN RAISE EXCEPTION 'Invalid or excluded effect target';END IF;
   INSERT INTO inbox_operations.item_steps VALUES(o,op.id,mapped,sid);
  END LOOP;
 END LOOP;
 SELECT count(*) INTO n FROM inbox_operations.items i WHERE i.org_id=o AND i.operation_id=op.id AND i.exclusion_code IS NULL AND NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps s WHERE s.org_id=o AND s.operation_id=op.id AND s.item_id=i.id);
 IF n<>0 THEN RAISE EXCEPTION 'Eligible target lacks prepared effects';END IF;
 INSERT INTO inbox_operations.dispatch_outbox(org_id,operation_id) VALUES(o,op.id);
 RETURN op.id;
END $$;
CREATE FUNCTION inbox_operations.claim_step(o uuid,op uuid,s uuid,seconds integer DEFAULT 30) RETURNS bigint LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_operations.steps;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND OR row.state='succeeded' OR (row.state='running' AND row.lease_until>clock_timestamp()) THEN RETURN NULL;END IF;
 IF row.predecessor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=row.predecessor_id AND state='succeeded') THEN RETURN NULL;END IF;
 UPDATE inbox_operations.steps SET state='running',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND operation_id=op AND id=s RETURNING generation INTO row.generation;
 RETURN row.generation;
END $$;
-- Call in the SAME transaction, before any canonical mutation. Keep this row lock
-- through eligibility checks, the effect and finish_step. Never use across HTTP calls.
CREATE FUNCTION inbox_operations.lock_step_for_effect(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_operations.steps; prior jsonb;
BEGIN
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND OR row.state<>'running' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Stale step claim';END IF;
 IF row.predecessor_id IS NOT NULL THEN
  SELECT result INTO prior FROM inbox_operations.receipts WHERE org_id=o AND operation_id=op AND step_id=row.predecessor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Predecessor incomplete';END IF;
 END IF;
 RETURN jsonb_build_object('action',row.action,'payload',row.payload,'original_dependencies',row.dependencies,'predecessor_result',prior);
END $$;
CREATE FUNCTION inbox_operations.finish_step(o uuid,op uuid,s uuid,g bigint,result jsonb) RETURNS bigint LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v bigint;
BEGIN
 PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
 IF jsonb_typeof(result) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid receipt';END IF;
 UPDATE inbox_operations.steps SET state='succeeded',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=s RETURNING receipt_version INTO v;
 INSERT INTO inbox_operations.receipts VALUES(o,op,s,v,g,result,clock_timestamp());RETURN v;
END $$;
CREATE FUNCTION inbox_operations.claim_dispatch(o uuid,op uuid,seconds integer DEFAULT 30) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_operations.dispatch_outbox;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 UPDATE inbox_operations.dispatch_outbox SET generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds)
 WHERE org_id=o AND operation_id=op AND acknowledged_at IS NULL AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING * INTO row;
 IF NOT FOUND THEN RETURN NULL;END IF;
 RETURN jsonb_build_object('event_id',row.event_id,'operation_id',row.operation_id,'generation',row.generation::text);
END $$;
CREATE FUNCTION inbox_operations.ack_dispatch(o uuid,op uuid,g bigint) RETURNS boolean LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 UPDATE inbox_operations.dispatch_outbox SET acknowledged_at=clock_timestamp(),lease_until=NULL WHERE org_id=o AND operation_id=op AND generation=g AND acknowledged_at IS NULL AND lease_until>clock_timestamp();
 RETURN FOUND;
END $$;
DO $$ DECLARE t record;BEGIN FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='inbox_operations' LOOP EXECUTE format('ALTER TABLE inbox_operations.%I ENABLE ROW LEVEL SECURITY',t.tablename);END LOOP;END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_operations FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_operations FROM PUBLIC;
DO $$ DECLARE r record;BEGIN
 FOR r IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
  EXECUTE format('REVOKE ALL ON SCHEMA inbox_operations FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA inbox_operations FROM %I',r.rolname);
  EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_operations FROM %I',r.rolname);
 END LOOP;
END $$;


-- Private canonical property-effect adapter. Acceptance/preparation remain separate.

CREATE SCHEMA inbox_operation_domain;
REVOKE ALL ON SCHEMA inbox_operation_domain FROM PUBLIC,anon,authenticated,service_role;
-- Metadata target resolution depends on ordering/eligibility as well as message
-- identity. Reply-content revisions alone intentionally omit created_at.
CREATE TABLE inbox_operation_domain.target_versions(org_id uuid NOT NULL,conversation_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),PRIMARY KEY(org_id,conversation_id));
CREATE FUNCTION inbox_operation_domain.capture_target() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb:='[]';side jsonb;changed boolean:=true;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF TG_TABLE_NAME='messages' THEN changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.contact_id,OLD.property_id,OLD.channel,(OLD.status IN ('queued','paused')),OLD.created_at) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.contact_id,NEW.property_id,NEW.channel,(NEW.status IN ('queued','paused')),NEW.created_at);
  ELSE changed:=(OLD.id,OLD.org_id,OLD.conversation_id,OLD.property_id,OLD.status,OLD.created_at,OLD.source_inbound_message_id) IS DISTINCT FROM (NEW.id,NEW.org_id,NEW.conversation_id,NEW.property_id,NEW.status,NEW.created_at,NEW.source_inbound_message_id);END IF;
 END IF;
 IF NOT changed THEN RETURN NULL;END IF;
 IF TG_OP<>'INSERT' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'conversation',OLD.conversation_id));END IF;
 IF TG_OP<>'DELETE' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'conversation',NEW.conversation_id));END IF;
 FOR side IN SELECT DISTINCT value FROM jsonb_array_elements(sides) WHERE value->>'conversation' IS NOT NULL AND value->>'org' IS NOT NULL ORDER BY value LOOP
  INSERT INTO inbox_operation_domain.target_versions VALUES((side->>'org')::uuid,(side->>'conversation')::uuid,1) ON CONFLICT(org_id,conversation_id) DO UPDATE SET revision=inbox_operation_domain.target_versions.revision+1;
 END LOOP;RETURN NULL;
END $$;
CREATE TRIGGER zzzzzzzz_inbox_operation_target AFTER INSERT OR UPDATE OR DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION inbox_operation_domain.capture_target();
CREATE TRIGGER zzzzzzzz_inbox_operation_target AFTER INSERT OR UPDATE OR DELETE ON public.ai_disposition_reviews FOR EACH ROW EXECUTE FUNCTION inbox_operation_domain.capture_target();
ALTER TABLE inbox_operation_domain.target_versions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_operation_domain.target_versions FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION inbox_operation_domain.capture_target() FROM PUBLIC,anon,authenticated,service_role;
CREATE FUNCTION inbox_operation_domain.apply_property_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE step jsonb; payload jsonb; expected jsonb; actual jsonb; requirements jsonb; prior jsonb;
 requester uuid; assignee uuid; property_id uuid; p public.properties; member public.memberships;
 requirement jsonb; revised jsonb; result jsonb; changed boolean; disposition text; entry record; targets jsonb; target jsonb; target_revision bigint; resolved jsonb; target_results jsonb:='[]'; actor_count integer;
BEGIN
 -- Completed replay never re-applies the effect; callers read the retained receipt.
 -- The fence lock is held through canonical writes and the final receipt.
 step:=inbox_operations.lock_step_for_effect(o,op,s,g);
 SELECT requester_id INTO STRICT requester FROM inbox_operations.operations WHERE org_id=o AND id=op;
 payload:=step->'payload'; property_id:=(payload->>'property_id')::uuid;
 IF property_id IS NULL OR step->>'action' NOT IN ('outcome','assign') THEN RAISE EXCEPTION 'Unsupported property effect';END IF;
 IF step->>'action'='assign' THEN assignee:=(payload->>'user_id')::uuid;END IF;
 -- Source locks precede version locks. Legacy transactions can still deadlock;
 -- whole-transaction retries, never an effect-only retry, are required externally.
 -- Global access epochs serialize membership insertion/removal across all orgs.
 -- The epoch is locked but not compared to the initial browser session: accepted
 -- jobs survive session closure, while current membership must remain unambiguous.
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id IN(requester,assignee) ORDER BY user_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM inbox_bridge.access_epochs WHERE user_id=requester) OR (assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_bridge.access_epochs WHERE user_id=assignee)) THEN RAISE EXCEPTION 'Access baseline missing';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 PERFORM 1 FROM public.memberships WHERE org_id=o AND user_id IN (requester,assignee) ORDER BY user_id FOR SHARE;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 IF assignee IS NOT NULL THEN
  SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=assignee;
  IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 END IF;
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=property_id FOR UPDATE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL OR p.is_training OR p.is_dnc_locked THEN RAISE EXCEPTION 'Property ineligible';END IF;
 IF NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps WHERE org_id=o AND operation_id=op AND step_id=s) THEN RAISE EXCEPTION 'Property effect has no mappings';END IF;
 IF EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i USING(org_id,operation_id) WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.id=m.item_id AND (i.exclusion_code IS NOT NULL OR (i.resolution->>'property_id')::uuid IS DISTINCT FROM property_id)) THEN RAISE EXCEPTION 'Invalid property mapping';END IF;
 expected:=step->'original_dependencies'->'policy';
 IF expected->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing policy vector';END IF;
 prior:=step->'predecessor_result';
 targets:=CASE WHEN prior IS NOT NULL AND prior<>'null'::jsonb THEN prior->'target_revisions' ELSE step->'original_dependencies'->'targets' END;
 IF jsonb_typeof(targets) IS DISTINCT FROM 'array' OR jsonb_array_length(targets) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Missing bounded target vector';END IF;
 IF jsonb_array_length(targets)<>(SELECT count(*) FROM inbox_operations.item_steps WHERE org_id=o AND operation_id=op AND step_id=s) THEN RAISE EXCEPTION 'Incomplete target vector';END IF;
 IF (SELECT count(DISTINCT value->>'conversation_id') FROM jsonb_array_elements(targets))<>jsonb_array_length(targets) THEN RAISE EXCEPTION 'Duplicate target vector';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(targets) ORDER BY value->>'conversation_id' LOOP
  IF NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i ON i.org_id=m.org_id AND i.operation_id=m.operation_id AND i.id=m.item_id WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.target_kind='conversation' AND i.target_id=(target->>'conversation_id')::uuid AND i.exclusion_code IS NULL) THEN RAISE EXCEPTION 'Target mapping mismatch';END IF;
  SELECT revision INTO target_revision FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=(target->>'conversation_id')::uuid FOR UPDATE;
  IF NOT FOUND OR target_revision::text IS DISTINCT FROM target->>'revision' THEN RAISE EXCEPTION 'Target resolution changed';END IF;
  IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
   IF NOT(target ? 'valid_until') THEN RAISE EXCEPTION 'Target validity missing';END IF;
   IF target->>'valid_until' IS NOT NULL AND (target->>'valid_until')::timestamptz<clock_timestamp() THEN RAISE EXCEPTION 'Target resolution expired';END IF;
  END IF;
  IF prior IS NULL OR prior='null'::jsonb THEN
   resolved:=inbox_summary_contract.compute(o,(target->>'conversation_id')::uuid,clock_timestamp());
   IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM property_id::text THEN RAISE EXCEPTION 'Canonical target property changed';END IF;
   target:=target||jsonb_build_object('valid_until',resolved->'next_window_expiry');
  END IF;
  target_results:=target_results||jsonb_build_array(target);
 END LOOP;
 targets:=target_results;

 -- Only revisions expressly returned by this adapter may replace earlier values.
 IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
  IF prior->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(prior->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(prior->'revised_dependencies') LOOP
   IF revised->>'namespace' NOT IN ('property_outcome','property_assignment','property_reviews') OR revised->'key' IS DISTINCT FROM jsonb_build_array(property_id) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END IF;
 -- These mandatory dependencies cover property eligibility, own outcome/followup
 -- mutations, review supersession, requester and selected-assignee access.
 FOR requirement IN SELECT jsonb_build_object('namespace',n,'key',jsonb_build_array(property_id)) FROM unnest(ARRAY['property_identity','property_policy','property_outcome','property_assignment','property_reviews']) n
 UNION ALL SELECT jsonb_build_object('namespace','membership_access','key',jsonb_build_array(requester))
 UNION SELECT jsonb_build_object('namespace','membership_access','key',jsonb_build_array(assignee)) WHERE assignee IS NOT NULL LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=requirement->>'namespace' AND d->'key'=requirement->'key') THEN RAISE EXCEPTION 'Incomplete policy vector';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key') ORDER BY d->>'namespace',(d->'key')::text) INTO requirements FROM jsonb_array_elements(expected->'dependencies') d;
 -- Validate key shapes/counts and seeded baselines before taking private locks.
 actual:=inbox_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 actual:=inbox_policy.snapshot(o,requirements);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dependency conflict';END IF;
 IF step->>'action'='outcome' THEN
  disposition:=payload->>'value';
  IF disposition IS NULL OR disposition NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture') THEN RAISE EXCEPTION 'Restrictive outcome adapter required';END IF;
  changed:=p.outreach_dispo IS DISTINCT FROM disposition;
  UPDATE public.properties SET outreach_dispo=disposition,follow_up_at=NULL,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
  IF changed THEN INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'dispo_set',jsonb_build_object('from',p.outreach_dispo,'to',disposition),'inbox_operation_step',s);END IF;
 ELSE
  changed:=p.assigned_user_id IS DISTINCT FROM assignee;
  IF changed THEN
   UPDATE public.properties SET assigned_user_id=assignee,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
   INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'assigned',jsonb_build_object('from',p.assigned_user_id,'to',assignee),'inbox_operation_step',s);
  END IF;
 END IF;
 actual:=inbox_policy.snapshot(o,requirements);
 SELECT coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb) INTO revised FROM jsonb_array_elements(actual->'dependencies') d WHERE d->>'namespace' IN ('property_outcome','property_assignment','property_reviews') AND d->'key'=jsonb_build_array(property_id);
 SELECT jsonb_agg(jsonb_build_object('conversation_id',v.conversation_id,'revision',v.revision::text,'valid_until',t->'valid_until') ORDER BY v.conversation_id) INTO target_results FROM inbox_operation_domain.target_versions v JOIN jsonb_array_elements(targets) t ON v.conversation_id=(t->>'conversation_id')::uuid WHERE v.org_id=o;
 result:=jsonb_build_object('property_id',property_id,'action',step->>'action','changed',changed,'before',jsonb_build_object('outcome',p.outreach_dispo,'assignee',p.assigned_user_id,'follow_up_at',p.follow_up_at),'after',(SELECT jsonb_build_object('outcome',outreach_dispo,'assignee',assigned_user_id,'follow_up_at',follow_up_at) FROM public.properties WHERE id=property_id AND org_id=o),'revised_dependencies',revised,'target_revisions',target_results);
 -- Recheck wall-clock authorization after source work; locks alone do not freeze time.
 IF EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id IN(requester,assignee) AND access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Access expired during effect';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(target_results) t WHERE t->>'valid_until' IS NOT NULL AND (t->>'valid_until')::timestamptz<clock_timestamp()) THEN RAISE EXCEPTION 'Target resolution expired';END IF;
 PERFORM inbox_operations.finish_step(o,op,s,g,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION inbox_operation_domain.apply_property_step(uuid,uuid,uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;


-- Private fixture candidate; installed only by the explicit guarded harness.
-- Per-contact revision of the canonical property/enrollment set used by manual
-- SMS opt-out. Historical absence must fail closed; no baseline guessed here.

CREATE TABLE inbox_operation_domain.sms_scopes(
 org_id uuid NOT NULL,contact_id uuid NOT NULL,revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(org_id,contact_id)
);
ALTER TABLE inbox_operation_domain.sms_scopes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_operation_domain.sms_scopes FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_operation_domain.shared_sms_receipts(
 org_id uuid NOT NULL,operation_id uuid NOT NULL,contact_id uuid NOT NULL,source_step_id uuid NOT NULL,
 original_scope jsonb NOT NULL,original_policy jsonb NOT NULL,result jsonb NOT NULL,
 PRIMARY KEY(org_id,operation_id,contact_id),
 FOREIGN KEY(org_id,operation_id,source_step_id) REFERENCES inbox_operations.steps(org_id,operation_id,id)
);
ALTER TABLE inbox_operation_domain.shared_sms_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_operation_domain.shared_sms_receipts FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_shared_sms_receipt BEFORE UPDATE OR DELETE ON inbox_operation_domain.shared_sms_receipts
 FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE FUNCTION inbox_operation_domain.capture_sms_scope() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE sides jsonb:='[]';side jsonb;candidate record;
BEGIN
 IF TG_TABLE_NAME='properties' THEN
  IF TG_OP='UPDATE' AND (OLD.id,OLD.org_id,OLD.homeowner_contact_id) IS NOT DISTINCT FROM (NEW.id,NEW.org_id,NEW.homeowner_contact_id) THEN RETURN NULL;END IF;
  IF TG_OP<>'INSERT' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',OLD.org_id,'contact',OLD.homeowner_contact_id));END IF;
  IF TG_OP<>'DELETE' THEN sides:=sides||jsonb_build_array(jsonb_build_object('org',NEW.org_id,'contact',NEW.homeowner_contact_id));END IF;
 ELSE
  -- The canonical enrollment guard locks both old/new property rows before
  -- mutation. Its exact installed body and coverage must be verified before
  -- enabling this capture; no unprotected property lookup is sufficient.
  FOR candidate IN SELECT DISTINCT k.org,k.property FROM (VALUES
   (CASE WHEN TG_OP<>'INSERT' THEN OLD.org_id END,CASE WHEN TG_OP<>'INSERT' THEN OLD.property_id END),
   (CASE WHEN TG_OP<>'DELETE' THEN NEW.org_id END,CASE WHEN TG_OP<>'DELETE' THEN NEW.property_id END)
  ) k(org,property) WHERE k.org IS NOT NULL AND k.property IS NOT NULL ORDER BY 1,2 LOOP
   SELECT jsonb_build_object('org',p.org_id,'contact',p.homeowner_contact_id) INTO side
    FROM public.properties p WHERE p.id=candidate.property AND p.org_id=candidate.org;
   IF FOUND THEN sides:=sides||jsonb_build_array(side);END IF;
  END LOOP;
 END IF;
 FOR side IN SELECT DISTINCT value FROM jsonb_array_elements(sides)
  WHERE value->>'org' IS NOT NULL AND value->>'contact' IS NOT NULL ORDER BY value LOOP
  INSERT INTO inbox_operation_domain.sms_scopes VALUES((side->>'org')::uuid,(side->>'contact')::uuid,1)
   ON CONFLICT(org_id,contact_id) DO UPDATE SET revision=inbox_operation_domain.sms_scopes.revision+1;
 END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER zzzzzzzzz_inbox_sms_scope AFTER INSERT OR UPDATE OR DELETE ON public.properties
 FOR EACH ROW EXECUTE FUNCTION inbox_operation_domain.capture_sms_scope();
CREATE TRIGGER zzzzzzzzz_inbox_sms_scope AFTER INSERT OR UPDATE OR DELETE ON public.sequence_enrollments
 FOR EACH ROW EXECUTE FUNCTION inbox_operation_domain.capture_sms_scope();
REVOKE ALL ON FUNCTION inbox_operation_domain.capture_sms_scope() FROM PUBLIC,anon,authenticated,service_role;


-- Private fixture candidate; called only by the guarded restrictive adapter.
-- Caller must hold/verify the accepted durable step and current requester access,
-- property policy/identity, and exact typed target mappings in the SAME transaction.

CREATE FUNCTION inbox_operation_domain.apply_sms_opt_out(o uuid,p uuid,actor uuid,s uuid,operation_id uuid,expected_scope jsonb,expected_policy jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE homeowner uuid;scope_revision bigint;contact public.contacts;property_ids uuid[];enrollment_ids uuid[];
 shared inbox_operation_domain.shared_sms_receipts;original_scope jsonb:=expected_scope;original_policy jsonb:=expected_policy;result jsonb;requirements jsonb;actual jsonb;requirement jsonb;consent_id uuid;paused jsonb:='[]';item record;contact_changed boolean:=false;
BEGIN
 SELECT homeowner_contact_id INTO homeowner FROM public.properties WHERE org_id=o AND id=p FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Property missing';END IF;
 IF homeowner IS NULL THEN RETURN jsonb_build_object('contact_id',NULL,'paused',paused,'reused',false);END IF;
 IF expected_scope->>'contact_id' IS DISTINCT FROM homeowner::text THEN RAISE EXCEPTION 'SMS scope contact changed';END IF;
 SELECT revision INTO scope_revision FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
 SELECT r.* INTO shared FROM inbox_operation_domain.shared_sms_receipts r JOIN inbox_operations.receipts completed
  ON completed.org_id=r.org_id AND completed.operation_id=r.operation_id AND completed.step_id=r.source_step_id
  WHERE r.org_id=o AND r.operation_id=apply_sms_opt_out.operation_id AND r.contact_id=homeowner;
 IF FOUND THEN
  IF shared.original_scope IS DISTINCT FROM expected_scope OR shared.original_policy IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'Shared SMS preparation mismatch';END IF;
  expected_scope:=shared.result->'current_scope';expected_policy:=shared.result->'policy';
 END IF;
 IF scope_revision::text IS DISTINCT FROM expected_scope->>'revision' THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
 SELECT * INTO contact FROM public.contacts WHERE org_id=o AND id=homeowner FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'SMS contact missing';END IF;
 SELECT array_agg(id ORDER BY id) INTO property_ids FROM (SELECT id FROM public.properties WHERE org_id=o AND homeowner_contact_id=homeowner ORDER BY id LIMIT 501 FOR UPDATE) q;
 IF cardinality(property_ids)>500 OR NOT(p=ANY(property_ids)) THEN RAISE EXCEPTION 'SMS property scope exceeds bound or changed';END IF;
 SELECT array_agg(id ORDER BY id) INTO enrollment_ids FROM (SELECT id FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active' ORDER BY id LIMIT 501 FOR UPDATE) q;
 IF cardinality(enrollment_ids)>500 THEN RAISE EXCEPTION 'SMS enrollment scope exceeds bound';END IF;
 -- Scope metadata is trusted preparation output, never client-supplied input.
 -- The bounded source set must match preparation, including currently active rows.
 IF to_jsonb(property_ids) IS DISTINCT FROM expected_scope->'property_ids' OR to_jsonb(coalesce(enrollment_ids,ARRAY[]::uuid[])) IS DISTINCT FROM expected_scope->'enrollment_ids' THEN RAISE EXCEPTION 'SMS scope membership changed';END IF;
 IF expected_policy->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected_policy->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'SMS policy vector missing';END IF;
 FOR requirement IN SELECT jsonb_build_object('namespace',n,'key',jsonb_build_array(homeowner)) FROM unnest(ARRAY['contact_identity','contact_policy']) n
 UNION ALL SELECT jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(homeowner,'sms')) LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected_policy->'dependencies') d WHERE d->>'namespace'=requirement->>'namespace' AND d->'key'=requirement->'key') THEN RAISE EXCEPTION 'SMS policy dependency missing';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key')) INTO requirements FROM jsonb_array_elements(expected_policy->'dependencies') d;
 actual:=inbox_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 IF inbox_policy.snapshot(o,requirements) IS DISTINCT FROM expected_policy THEN RAISE EXCEPTION 'SMS policy conflict';END IF;
 IF shared.source_step_id IS NOT NULL THEN RETURN shared.result||jsonb_build_object('reused',true);END IF;
 -- A permanent DNC row stays immutable. Consent is append-only and compliance
 -- enrollment stops use the canonical permitted transition, never a guard bypass.
 IF NOT contact.sms_opted_out THEN
  INSERT INTO public.consent_events(org_id,contact_id,channel,event_type,source,source_detail,occurred_at)
   VALUES(o,homeowner,'sms','opt_out','manual_dispo',jsonb_build_object('propertyId',p,'operationStepId',s),clock_timestamp()) RETURNING id INTO consent_id;
  IF NOT contact.do_not_contact AND NOT EXISTS(SELECT 1 FROM public.properties WHERE org_id=o AND id=ANY(property_ids) AND is_dnc_locked) THEN
   UPDATE public.contacts SET sms_opted_out=true,sms_opted_out_at=clock_timestamp() WHERE org_id=o AND id=homeowner;
   contact_changed:=true;
  END IF;
  INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id)
   VALUES(o,p,'user',actor,'opted_out','{"channel":"sms","trigger":"manual_disposition"}','consent_events.opt_out',consent_id);
 END IF;
 WITH changed AS(UPDATE public.sequence_enrollments SET status='opted_out',pause_reason='consent_revoked',next_run_at=NULL,updated_at=clock_timestamp()
  WHERE org_id=o AND id=ANY(coalesce(enrollment_ids,ARRAY[]::uuid[])) AND status='active' RETURNING id,property_id,sequence_id)
 SELECT coalesce(jsonb_agg(to_jsonb(changed) ORDER BY id),'[]') INTO paused FROM changed;
 FOR item IN SELECT (value->>'property_id')::uuid property_id,count(*) count,jsonb_agg(DISTINCT value->>'sequence_id') sequence_ids FROM jsonb_array_elements(paused) GROUP BY 1 ORDER BY 1 LOOP
  INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id)
   VALUES(o,item.property_id,'user',actor,'sequence_paused',jsonb_build_object('count',item.count,'sequence_ids',item.sequence_ids,'reason','consent_revoked','permanent',true),'inbox_operation_step.sequence_paused',md5(s::text||':'||item.property_id::text)::uuid);
 END LOOP;
 result:=jsonb_build_object('contact_id',homeowner,'contact_changed',contact_changed,'consent_id',consent_id,'paused',paused,
  'scope_revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner),'policy',inbox_policy.snapshot(o,requirements),
  'reused',false,'source_step_id',s,'current_scope',jsonb_build_object('contact_id',homeowner,'revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=homeowner),'property_ids',to_jsonb(property_ids),'enrollment_ids',coalesce((SELECT jsonb_agg(id ORDER BY id) FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active'),'[]'::jsonb)));
 INSERT INTO inbox_operation_domain.shared_sms_receipts VALUES(o,operation_id,homeowner,s,original_scope,original_policy,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION inbox_operation_domain.apply_sms_opt_out(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated,service_role;


-- Source-only candidate. Replace the private adapter only after reviewed scope/helper installation.
CREATE OR REPLACE FUNCTION inbox_operation_domain.apply_property_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE shared_sms inbox_operation_domain.shared_sms_receipts; sms_original_policy jsonb; sms jsonb; sms_expected jsonb; sms_contact uuid; step jsonb; payload jsonb; expected jsonb; actual jsonb; requirements jsonb; prior jsonb;
 requester uuid; assignee uuid; property_id uuid; p public.properties; member public.memberships;
 requirement jsonb; revised jsonb; result jsonb; changed boolean; disposition text; entry record; targets jsonb; target jsonb; target_revision bigint; resolved jsonb; target_results jsonb:='[]'; actor_count integer;
BEGIN
 -- Completed replay never re-applies the effect; callers read the retained receipt.
 -- The fence lock is held through canonical writes and the final receipt.
 step:=inbox_operations.lock_step_for_effect(o,op,s,g);
 SELECT requester_id INTO STRICT requester FROM inbox_operations.operations WHERE org_id=o AND id=op;
 payload:=step->'payload'; property_id:=(payload->>'property_id')::uuid;
 IF property_id IS NULL OR step->>'action' NOT IN ('outcome','assign') THEN RAISE EXCEPTION 'Unsupported property effect';END IF;
 IF step->>'action'='assign' THEN assignee:=(payload->>'user_id')::uuid;END IF;
 -- Source locks precede version locks. Legacy transactions can still deadlock;
 -- whole-transaction retries, never an effect-only retry, are required externally.
 -- Global access epochs serialize membership insertion/removal across all orgs.
 -- The epoch is locked but not compared to the initial browser session: accepted
 -- jobs survive session closure, while current membership must remain unambiguous.
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id IN(requester,assignee) ORDER BY user_id FOR SHARE;
 IF NOT EXISTS(SELECT 1 FROM inbox_bridge.access_epochs WHERE user_id=requester) OR (assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_bridge.access_epochs WHERE user_id=assignee)) THEN RAISE EXCEPTION 'Access baseline missing';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 PERFORM 1 FROM public.memberships WHERE org_id=o AND user_id IN (requester,assignee) ORDER BY user_id FOR SHARE;
 SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=requester;
 IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Requester access revoked';END IF;
 IF assignee IS NOT NULL THEN
  SELECT * INTO member FROM public.memberships WHERE org_id=o AND user_id=assignee;
  IF NOT FOUND OR member.access_status<>'active' OR member.deletion_prepared_at IS NOT NULL OR (member.access_expires_at IS NOT NULL AND member.access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Assignee unavailable';END IF;
 END IF;
 -- Serialize same-operation/contact safety BEFORE locking individual properties
 -- or reading the committed shared receipt. A waiting sibling then sees the
 -- previous effect's post-state instead of validating stale shared revisions.
 IF (step->>'action'='outcome' AND payload->>'value'='opted_out') OR step->'predecessor_result'->'sms'->>'contact_id' IS NOT NULL THEN
  IF step->'original_dependencies'->'sms_scope'->>'contact_id' IS NOT NULL THEN
   PERFORM 1 FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=(step->'original_dependencies'->'sms_scope'->>'contact_id')::uuid FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION 'SMS scope changed or unseeded';END IF;
  END IF;
 END IF;
 SELECT * INTO p FROM public.properties WHERE org_id=o AND id=property_id FOR UPDATE;
 IF NOT FOUND OR p.deleted_at IS NOT NULL OR p.is_training OR p.is_dnc_locked THEN RAISE EXCEPTION 'Property ineligible';END IF;
 IF NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps WHERE org_id=o AND operation_id=op AND step_id=s) THEN RAISE EXCEPTION 'Property effect has no mappings';END IF;
 IF EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i USING(org_id,operation_id) WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.id=m.item_id AND (i.exclusion_code IS NOT NULL OR (i.resolution->>'property_id')::uuid IS DISTINCT FROM property_id)) THEN RAISE EXCEPTION 'Invalid property mapping';END IF;
 expected:=step->'original_dependencies'->'policy';
 IF expected->>'org_id' IS DISTINCT FROM o::text OR jsonb_typeof(expected->'dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Missing policy vector';END IF;
 prior:=step->'predecessor_result';
 sms:=prior->'sms';sms_contact:=(sms->>'contact_id')::uuid;
 IF sms_contact IS NOT NULL AND step->'original_dependencies'->'sms_scope'->>'contact_id' IS DISTINCT FROM sms_contact::text THEN RAISE EXCEPTION 'SMS predecessor contact mismatch';END IF;
 targets:=CASE WHEN prior IS NOT NULL AND prior<>'null'::jsonb THEN prior->'target_revisions' ELSE step->'original_dependencies'->'targets' END;
 IF jsonb_typeof(targets) IS DISTINCT FROM 'array' OR jsonb_array_length(targets) NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Missing bounded target vector';END IF;
 IF jsonb_array_length(targets)<>(SELECT count(*) FROM inbox_operations.item_steps WHERE org_id=o AND operation_id=op AND step_id=s) THEN RAISE EXCEPTION 'Incomplete target vector';END IF;
 IF (SELECT count(DISTINCT value->>'conversation_id') FROM jsonb_array_elements(targets))<>jsonb_array_length(targets) THEN RAISE EXCEPTION 'Duplicate target vector';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(targets) ORDER BY value->>'conversation_id' LOOP
  IF NOT EXISTS(SELECT 1 FROM inbox_operations.item_steps m JOIN inbox_operations.items i ON i.org_id=m.org_id AND i.operation_id=m.operation_id AND i.id=m.item_id WHERE m.org_id=o AND m.operation_id=op AND m.step_id=s AND i.target_kind='conversation' AND i.target_id=(target->>'conversation_id')::uuid AND i.exclusion_code IS NULL) THEN RAISE EXCEPTION 'Target mapping mismatch';END IF;
  SELECT revision INTO target_revision FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=(target->>'conversation_id')::uuid FOR UPDATE;
  IF NOT FOUND OR target_revision::text IS DISTINCT FROM target->>'revision' THEN RAISE EXCEPTION 'Target resolution changed';END IF;
  IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
   IF NOT(target ? 'valid_until') THEN RAISE EXCEPTION 'Target validity missing';END IF;
   IF target->>'valid_until' IS NOT NULL AND (target->>'valid_until')::timestamptz<clock_timestamp() THEN RAISE EXCEPTION 'Target resolution expired';END IF;
  END IF;
  IF prior IS NULL OR prior='null'::jsonb THEN
   resolved:=inbox_summary_contract.compute(o,(target->>'conversation_id')::uuid,clock_timestamp());
   IF resolved->>'exists' IS DISTINCT FROM 'true' OR resolved->>'property_id' IS DISTINCT FROM property_id::text THEN RAISE EXCEPTION 'Canonical target property changed';END IF;
   target:=target||jsonb_build_object('valid_until',resolved->'next_window_expiry');
  END IF;
  target_results:=target_results||jsonb_build_array(target);
 END LOOP;
 targets:=target_results;

 -- Only revisions expressly returned by this adapter may replace earlier values.
 IF prior IS NOT NULL AND prior<>'null'::jsonb THEN
  IF prior->>'property_id' IS DISTINCT FROM property_id::text OR jsonb_typeof(prior->'revised_dependencies') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invalid predecessor receipt';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(prior->'revised_dependencies') LOOP
   IF NOT ((revised->>'namespace' IN ('property_outcome','property_assignment','property_reviews') AND revised->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((revised->>'namespace' IN ('contact_policy','contact_identity') AND revised->'key'=jsonb_build_array(sms_contact)) OR (revised->>'namespace'='contact_channel_consent' AND revised->'key'=jsonb_build_array(sms_contact,'sms'))))) OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Invalid revised dependency';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END IF;
 -- Reuse only this accepted operation's committed contact safety transition.
 -- Exact original preparation equality is required before rebasing shared keys.
 SELECT jsonb_build_object('org_id',o,'dependencies',coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]')) INTO sms_original_policy FROM jsonb_array_elements(step->'original_dependencies'->'policy'->'dependencies') d WHERE d->>'namespace' IN ('contact_identity','contact_policy','contact_channel_consent');
 IF (step->>'action'='outcome' AND payload->>'value'='opted_out') OR sms_contact IS NOT NULL THEN
 SELECT r.* INTO shared_sms FROM inbox_operation_domain.shared_sms_receipts r JOIN inbox_operations.receipts completed ON completed.org_id=r.org_id AND completed.operation_id=r.operation_id AND completed.step_id=r.source_step_id
  WHERE r.org_id=o AND r.operation_id=op AND r.contact_id=(step->'original_dependencies'->'sms_scope'->>'contact_id')::uuid;
 IF FOUND THEN
  IF shared_sms.original_scope IS DISTINCT FROM step->'original_dependencies'->'sms_scope' OR shared_sms.original_policy IS DISTINCT FROM sms_original_policy THEN RAISE EXCEPTION 'Shared SMS preparation mismatch';END IF;
  FOR revised IN SELECT value FROM jsonb_array_elements(shared_sms.result->'policy'->'dependencies') LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key') THEN RAISE EXCEPTION 'Shared SMS dependency missing';END IF;
   SELECT jsonb_set(expected,'{dependencies}',jsonb_agg(CASE WHEN d->>'namespace'=revised->>'namespace' AND d->'key'=revised->'key' THEN revised ELSE d END ORDER BY d->>'namespace',(d->'key')::text)) INTO expected FROM jsonb_array_elements(expected->'dependencies') d;
  END LOOP;
 END IF;
 END IF;
 -- These mandatory dependencies cover property eligibility, own outcome/followup
 -- mutations, review supersession, requester and selected-assignee access.
 FOR requirement IN SELECT jsonb_build_object('namespace',n,'key',jsonb_build_array(property_id)) FROM unnest(ARRAY['property_identity','property_policy','property_outcome','property_assignment','property_reviews']) n
 UNION ALL SELECT jsonb_build_object('namespace','membership_access','key',jsonb_build_array(requester))
 UNION SELECT jsonb_build_object('namespace','membership_access','key',jsonb_build_array(assignee)) WHERE assignee IS NOT NULL LOOP
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace'=requirement->>'namespace' AND d->'key'=requirement->'key') THEN RAISE EXCEPTION 'Incomplete policy vector';END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key') ORDER BY d->>'namespace',(d->'key')::text) INTO requirements FROM jsonb_array_elements(expected->'dependencies') d;
 -- Validate key shapes/counts and seeded baselines before taking private locks.
 actual:=inbox_policy.snapshot(o,requirements);
 PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 actual:=inbox_policy.snapshot(o,requirements);
 IF actual IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Dependency conflict';END IF;
 IF step->>'action'='outcome' THEN
  disposition:=payload->>'value';
  IF disposition='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
  IF disposition IS NULL OR disposition NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'Unsupported outcome';END IF;
  IF disposition='opted_out' THEN
   SELECT jsonb_build_object('org_id',o,'dependencies',coalesce(jsonb_agg(d),'[]')) INTO sms_expected FROM jsonb_array_elements(expected->'dependencies') d WHERE d->>'namespace' IN ('contact_identity','contact_policy','contact_channel_consent');
   sms:=inbox_operation_domain.apply_sms_opt_out(o,property_id,requester,s,op,step->'original_dependencies'->'sms_scope',sms_original_policy);
   sms_contact:=(sms->>'contact_id')::uuid;
  END IF;
  changed:=p.outreach_dispo IS DISTINCT FROM disposition;
  UPDATE public.properties SET outreach_dispo=disposition,follow_up_at=NULL,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
  IF changed THEN INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'dispo_set',jsonb_build_object('from',p.outreach_dispo,'to',disposition),'inbox_operation_step',s);END IF;
 ELSE
  changed:=p.assigned_user_id IS DISTINCT FROM assignee;
  IF changed THEN
   UPDATE public.properties SET assigned_user_id=assignee,updated_at=clock_timestamp() WHERE org_id=o AND id=property_id;
   INSERT INTO public.lead_events(org_id,property_id,actor_type,actor_id,event_type,payload,source_type,source_id) VALUES(o,property_id,'user',requester,'assigned',jsonb_build_object('from',p.assigned_user_id,'to',assignee),'inbox_operation_step',s);
  END IF;
 END IF;
 actual:=inbox_policy.snapshot(o,requirements);
 SELECT coalesce(jsonb_agg(d ORDER BY d->>'namespace',(d->'key')::text),'[]'::jsonb) INTO revised FROM jsonb_array_elements(actual->'dependencies') d WHERE (d->>'namespace' IN ('property_outcome','property_assignment','property_reviews') AND d->'key'=jsonb_build_array(property_id)) OR (sms_contact IS NOT NULL AND ((d->>'namespace' IN ('contact_identity','contact_policy') AND d->'key'=jsonb_build_array(sms_contact)) OR (d->>'namespace'='contact_channel_consent' AND d->'key'=jsonb_build_array(sms_contact,'sms'))));
 SELECT jsonb_agg(jsonb_build_object('conversation_id',v.conversation_id,'revision',v.revision::text,'valid_until',t->'valid_until') ORDER BY v.conversation_id) INTO target_results FROM inbox_operation_domain.target_versions v JOIN jsonb_array_elements(targets) t ON v.conversation_id=(t->>'conversation_id')::uuid WHERE v.org_id=o;
 result:=jsonb_build_object('property_id',property_id,'action',step->>'action','changed',changed,'before',jsonb_build_object('outcome',p.outreach_dispo,'assignee',p.assigned_user_id,'follow_up_at',p.follow_up_at),'after',(SELECT jsonb_build_object('outcome',outreach_dispo,'assignee',assigned_user_id,'follow_up_at',follow_up_at) FROM public.properties WHERE id=property_id AND org_id=o),'revised_dependencies',revised,'target_revisions',target_results,'sms',sms);
 -- Recheck wall-clock authorization after source work; locks alone do not freeze time.
 IF EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id IN(requester,assignee) AND access_expires_at<=clock_timestamp()) THEN RAISE EXCEPTION 'Access expired during effect';END IF;
 SELECT count(*) INTO actor_count FROM public.memberships WHERE user_id=requester AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp());
 IF actor_count<>1 THEN RAISE EXCEPTION 'Requester membership ambiguous or missing';END IF;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(target_results) t WHERE t->>'valid_until' IS NOT NULL AND (t->>'valid_until')::timestamptz<clock_timestamp()) THEN RAISE EXCEPTION 'Target resolution expired';END IF;
 PERFORM inbox_operations.finish_step(o,op,s,g,result);
 RETURN result;
END $$;

-- Authoritative metadata preparation candidate. Private fixture installation only.

CREATE SCHEMA inbox_action_api;
REVOKE ALL ON SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;
CREATE TABLE inbox_action_api.preparation_requests(
 preparation_id uuid PRIMARY KEY REFERENCES inbox_operations.preparations(id),
 org_id uuid NOT NULL,requester_id uuid NOT NULL,idempotency_key uuid NOT NULL,input_hash text NOT NULL
);
ALTER TABLE inbox_action_api.preparation_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE inbox_action_api.preparation_requests FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER immutable_preparation_request BEFORE UPDATE OR DELETE ON inbox_action_api.preparation_requests
 FOR EACH ROW EXECUTE FUNCTION inbox_operations.immutable_row();
CREATE FUNCTION inbox_action_api.authorize(o uuid,u uuid DEFAULT NULL) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;
BEGIN
 a:=inbox_bridge.authorize(o);
 PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=(a->>'user_id')::uuid FOR SHARE;
 a:=inbox_bridge.authorize(o);
 IF u IS NOT NULL AND a->>'user_id' IS DISTINCT FROM u::text THEN RAISE EXCEPTION 'INBOX_ACTION_FORBIDDEN' USING ERRCODE='42501';END IF;
 RETURN a;
END $$;
-- Hash collisions only serialize unrelated keys; exact relational predicates
-- remain authoritative. Acceptance and recovery share this transaction lock.
CREATE FUNCTION inbox_action_api.lock_request_key(o uuid,u uuid,k uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
 IF o IS NULL OR u IS NULL OR k IS NULL THEN RAISE EXCEPTION 'Invalid request key';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('sandra:inbox:accept:v1:'||o::text||':'||u::text||':'||k::text,0));
END $$;
-- A baseline is established only while the metadata row is locked and canonical
-- capture is installed on every relevant writer. Existing counters are never
-- reset. A concurrent source writer must advance the same counter before commit,
-- so a later source state cannot silently share the prepared baseline revision.
CREATE FUNCTION inbox_action_api.policy(o uuid,requirements jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE r jsonb;
BEGIN
 IF jsonb_typeof(requirements) IS DISTINCT FROM 'array' OR jsonb_array_length(requirements) NOT BETWEEN 1 AND 16 THEN RAISE EXCEPTION 'Invalid policy baseline requirements';END IF;
 FOR r IN SELECT value FROM jsonb_array_elements(requirements) ORDER BY value->>'namespace',(value->'key')::text LOOP
  PERFORM inbox_policy.validate_key(r->>'namespace',r->'key');
  INSERT INTO inbox_policy.versions VALUES(o,r->>'namespace',(r->'key')::text,1) ON CONFLICT DO NOTHING;
 END LOOP;
 PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) requirement_row ON v.namespace=requirement_row->>'namespace' AND v.entity_key=(requirement_row->'key')::text WHERE v.org_id=o ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
 RETURN inbox_policy.snapshot(o,requirements);
END $$;
-- Preserve raw JSON long enough to reject duplicate names at every level.
CREATE FUNCTION inbox_action_api.assert_json_shape(value json,depth integer DEFAULT 0) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE child json;
BEGIN
 IF depth>8 THEN RAISE EXCEPTION 'Invalid action nesting';END IF;
 IF json_typeof(value)='object' THEN
  IF (SELECT count(*)<>count(DISTINCT key) FROM json_each(value)) THEN RAISE EXCEPTION 'Duplicate action member';END IF;
  FOR child IN SELECT e.value FROM json_each(value) e LOOP PERFORM inbox_action_api.assert_json_shape(child,depth+1);END LOOP;
 ELSIF json_typeof(value)='array' THEN
  FOR child IN SELECT e.value FROM json_array_elements(value) e LOOP PERFORM inbox_action_api.assert_json_shape(child,depth+1);END LOOP;
 END IF;
END $$;
CREATE FUNCTION inbox_action_api.prepare(canonical_input text,k uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE intent jsonb; a jsonb;o uuid;u uuid;definition jsonb;step jsonb;target jsonb;resolved jsonb;
 p public.properties;assignee uuid;item jsonb;items jsonb:='[]';effects jsonb:='[]';plans jsonb:='{}';plan jsonb;requirements jsonb;sms_scope jsonb;
 property_ids uuid[];enrollment_ids uuid[];row record;prep_id uuid:=gen_random_uuid();hash text;expires timestamptz:=clock_timestamp()+interval '5 minutes';exclusion text;has_sms boolean:=false;has_outcome boolean:=false;has_assignment boolean:=false;
BEGIN
 IF k IS NULL OR canonical_input IS NULL OR octet_length(canonical_input)>131072 THEN RAISE EXCEPTION 'Invalid action input';END IF;
 PERFORM inbox_action_api.assert_json_shape(canonical_input::json);
 intent:=canonical_input::jsonb;
 IF jsonb_typeof(intent) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(intent))<>6 OR NOT(intent ?& ARRAY['purpose','organizationId','requesterId','targets','definition','savedAction']) OR intent->>'purpose' IS DISTINCT FROM 'prepare_action' OR intent->'savedAction' IS DISTINCT FROM 'null'::jsonb OR (SELECT count(*) FROM json_each(canonical_input::json))<>6 THEN RAISE EXCEPTION 'Invalid action envelope';END IF;
 o:=(intent->>'organizationId')::uuid;u:=(intent->>'requesterId')::uuid;
 IF o IS NULL OR u IS NULL THEN RAISE EXCEPTION 'Invalid action actor';END IF;
 a:=inbox_action_api.authorize(o,u);
 definition:=intent->'definition';
 IF jsonb_typeof(definition) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(definition))<>2 OR definition->'version' IS DISTINCT FROM '1'::jsonb OR jsonb_typeof(definition->'steps') IS DISTINCT FROM 'array' OR jsonb_array_length(definition->'steps') NOT BETWEEN 1 AND 2 THEN RAISE EXCEPTION 'Unsupported action definition';END IF;
 FOR step IN SELECT value FROM jsonb_array_elements(definition->'steps') LOOP
  IF jsonb_typeof(step) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(step))<>2 THEN RAISE EXCEPTION 'Unsupported action step';END IF;
  IF step->>'type'='outcome' THEN
   IF has_outcome OR has_assignment OR NOT(step ? 'value') THEN RAISE EXCEPTION 'Invalid action order';END IF;has_outcome:=true;
   IF step->>'value'='dnc' THEN RAISE EXCEPTION 'permanent_dnc_not_enabled';END IF;
   IF step->>'value' IS NULL OR step->>'value' NOT IN ('wrong_number','bad_number','not_interested','needs_sequence','nurture','opted_out') THEN RAISE EXCEPTION 'Unsupported outcome';END IF;
   has_sms:=step->>'value'='opted_out';
  ELSIF step->>'type'='assign' THEN
   IF has_assignment OR NOT(step ? 'userId') THEN RAISE EXCEPTION 'Invalid assignment';END IF;has_assignment:=true;assignee:=(step->>'userId')::uuid;
   IF assignee IS NOT NULL THEN
    PERFORM 1 FROM inbox_bridge.access_epochs WHERE user_id=assignee FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
   END IF;
   IF assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
  ELSE RAISE EXCEPTION 'Unsupported action step';END IF;
 END LOOP;
 IF jsonb_typeof(intent->'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(intent->'targets') NOT BETWEEN 1 AND 500 THEN RAISE EXCEPTION 'Invalid bounded targets';END IF;
 IF (SELECT count(DISTINCT (value->>'kind')||':'||(value->>'id')) FROM jsonb_array_elements(intent->'targets'))<>jsonb_array_length(intent->'targets') THEN RAISE EXCEPTION 'Duplicate targets';END IF;
 FOR target IN SELECT value FROM jsonb_array_elements(intent->'targets') ORDER BY value->>'kind',value->>'id' LOOP
  IF jsonb_typeof(target) IS DISTINCT FROM 'object' OR (SELECT count(*) FROM jsonb_object_keys(target))<>2 OR NOT(target ?& ARRAY['kind','id']) OR target->>'kind' IS NULL OR target->>'kind' NOT IN ('conversation','unknown_sender_group') OR target->>'id' IS NULL THEN RAISE EXCEPTION 'Invalid typed target';END IF;
  PERFORM (target->>'id')::uuid;exclusion:=NULL;resolved:='{}';
  IF target->>'kind'<>'conversation' THEN exclusion:='unsupported_target';
  ELSE
   -- Avoid persistent counters for arbitrary nonexistent client UUIDs. This
   -- first read is only a negative fast path, never the prepared mapping.
   resolved:=inbox_summary_contract.compute(o,(target->>'id')::uuid,clock_timestamp());
   IF resolved->>'exists'='true' THEN
    INSERT INTO inbox_operation_domain.target_versions VALUES(o,(target->>'id')::uuid,1) ON CONFLICT DO NOTHING;
    PERFORM 1 FROM inbox_operation_domain.target_versions WHERE org_id=o AND conversation_id=(target->>'id')::uuid FOR UPDATE;
    resolved:=inbox_summary_contract.compute(o,(target->>'id')::uuid,clock_timestamp());
   END IF;
   IF resolved->>'exists' IS DISTINCT FROM 'true' THEN exclusion:='conversation_unavailable';
   ELSIF resolved->>'property_id' IS NULL THEN exclusion:='property_unavailable';
   ELSE
    SELECT jsonb_agg(jsonb_build_object('namespace',n,'key',jsonb_build_array((resolved->>'property_id')::uuid))) INTO requirements FROM unnest(ARRAY['property_identity','property_policy','property_outcome','property_assignment','property_reviews']) n;
    PERFORM inbox_action_api.policy(o,requirements);
    SELECT * INTO p FROM public.properties WHERE org_id=o AND id=(resolved->>'property_id')::uuid;
    IF NOT FOUND OR p.deleted_at IS NOT NULL THEN exclusion:='property_unavailable';
    ELSIF p.is_dnc_locked THEN exclusion:='property_locked';
    ELSIF p.is_training THEN exclusion:='training_target';
    ELSE
     IF NOT(plans ? p.id::text) THEN
      sms_scope:='null';
      IF has_sms AND p.homeowner_contact_id IS NOT NULL THEN
       INSERT INTO inbox_operation_domain.sms_scopes VALUES(o,p.homeowner_contact_id,1) ON CONFLICT DO NOTHING;
       PERFORM 1 FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=p.homeowner_contact_id FOR UPDATE;
       SELECT array_agg(id ORDER BY id) INTO property_ids FROM (SELECT id FROM public.properties WHERE org_id=o AND homeowner_contact_id=p.homeowner_contact_id ORDER BY id LIMIT 501) q;
       SELECT array_agg(e.id ORDER BY e.id) INTO enrollment_ids FROM (SELECT id FROM public.sequence_enrollments WHERE org_id=o AND property_id=ANY(property_ids) AND status='active' ORDER BY id LIMIT 501) e;
       IF cardinality(property_ids)>500 OR cardinality(enrollment_ids)>500 THEN exclusion:='scope_too_large';
       ELSE sms_scope:=jsonb_build_object('contact_id',p.homeowner_contact_id,'revision',(SELECT revision::text FROM inbox_operation_domain.sms_scopes WHERE org_id=o AND contact_id=p.homeowner_contact_id),'property_ids',to_jsonb(property_ids),'enrollment_ids',to_jsonb(coalesce(enrollment_ids,ARRAY[]::uuid[])));END IF;
      END IF;
      IF exclusion IS NULL THEN
       SELECT jsonb_agg(jsonb_build_object('namespace',n,'key',jsonb_build_array(p.id))) INTO requirements FROM unnest(ARRAY['property_identity','property_policy','property_outcome','property_assignment','property_reviews']) n;
       requirements:=requirements||jsonb_build_array(jsonb_build_object('namespace','membership_access','key',jsonb_build_array(u)));
       IF assignee IS NOT NULL AND assignee<>u THEN requirements:=requirements||jsonb_build_array(jsonb_build_object('namespace','membership_access','key',jsonb_build_array(assignee)));END IF;
       IF has_sms AND p.homeowner_contact_id IS NOT NULL THEN
        requirements:=requirements||jsonb_build_array(jsonb_build_object('namespace','contact_identity','key',jsonb_build_array(p.homeowner_contact_id)),jsonb_build_object('namespace','contact_policy','key',jsonb_build_array(p.homeowner_contact_id)),jsonb_build_object('namespace','contact_channel_consent','key',jsonb_build_array(p.homeowner_contact_id,'sms')));
       END IF;
       plan:=jsonb_build_object('policy',inbox_action_api.policy(o,requirements),'sms_scope',sms_scope);
       plans:=plans||jsonb_build_object(p.id::text,plan);
      END IF;
     END IF;
    END IF;
   END IF;
  END IF;
  item:=jsonb_build_object('id',gen_random_uuid(),'kind',target->>'kind','target_id',(target->>'id')::uuid,'resolution',jsonb_build_object('property_id',CASE WHEN exclusion IS NULL THEN resolved->>'property_id' END,'valid_until',resolved->'next_window_expiry'),'exclusion_code',exclusion);
  items:=items||jsonb_build_array(item);
 END LOOP;
 FOR row IN SELECT key,value FROM jsonb_each(plans) ORDER BY key LOOP
  FOR step IN SELECT value||jsonb_build_object('ordinal',ordinality-1) FROM jsonb_array_elements(definition->'steps') WITH ORDINALITY LOOP
   SELECT row.value||jsonb_build_object('targets',jsonb_agg(jsonb_build_object('conversation_id',i->>'target_id','revision',v.revision::text,'valid_until',i->'resolution'->'valid_until') ORDER BY i->>'target_id')) INTO plan
    FROM jsonb_array_elements(items) i JOIN inbox_operation_domain.target_versions v ON v.org_id=o AND v.conversation_id=(i->>'target_id')::uuid WHERE i->>'exclusion_code' IS NULL AND i->'resolution'->>'property_id'=row.key;
   effects:=effects||jsonb_build_array(jsonb_build_object('effect_key','property:'||row.key,'ordinal',(step->>'ordinal')::integer,'action',step->>'type','payload',CASE WHEN step->>'type'='outcome' THEN jsonb_build_object('property_id',row.key,'value',step->>'value') ELSE jsonb_build_object('property_id',row.key,'user_id',step->'userId') END,'dependencies',plan,'item_ids',(SELECT jsonb_agg(i->>'id' ORDER BY i->>'id') FROM jsonb_array_elements(items) i WHERE i->>'exclusion_code' IS NULL AND i->'resolution'->>'property_id'=row.key)));
  END LOOP;
 END LOOP;
 IF assignee IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=o AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'assignee_unavailable';END IF;
 PERFORM inbox_action_api.authorize(o,u);
 hash:=encode(sha256(convert_to('sandra:inbox:action:v1','utf8')||decode('00','hex')||convert_to(canonical_input,'utf8')),'hex');
 INSERT INTO inbox_operations.preparations VALUES(prep_id,o,u,canonical_input,hash,definition,jsonb_build_object('items',items,'effects',effects),expires);
 INSERT INTO inbox_action_api.preparation_requests VALUES(prep_id,o,u,k,hash);
 RETURN jsonb_build_object('preparation_id',prep_id,'idempotency_key',k,'input_hash',hash,'expires_at',expires,'definition',definition,'items',items,'effect_count',jsonb_array_length(effects),'affected_property_count',(SELECT count(*) FROM jsonb_object_keys(plans)));
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;


-- Private worker boundary. No browser grants and no provider calls.

ALTER TABLE inbox_operations.dispatch_outbox ADD COLUMN created_at timestamptz NOT NULL DEFAULT clock_timestamp();
CREATE INDEX inbox_operations_pending_dispatch ON inbox_operations.dispatch_outbox(created_at,event_id) WHERE acknowledged_at IS NULL;
ALTER TABLE inbox_operations.steps DROP CONSTRAINT steps_state_check;
ALTER TABLE inbox_operations.steps ADD CONSTRAINT steps_state_check CHECK(state IN('pending','running','succeeded','failed','conflicted','cancelled','blocked'));
CREATE OR REPLACE FUNCTION inbox_operations.claim_step(o uuid,op uuid,s uuid,seconds integer DEFAULT 30) RETURNS bigint LANGUAGE plpgsql SET search_path='' AS $$
DECLARE row inbox_operations.steps;
BEGIN
 IF seconds IS NULL OR seconds NOT BETWEEN 1 AND 300 THEN RAISE EXCEPTION 'Invalid lease';END IF;
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND OR row.state NOT IN('pending','running') OR (row.state='running' AND row.lease_until>clock_timestamp()) THEN RETURN NULL;END IF;
 IF row.predecessor_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=row.predecessor_id AND state='succeeded') THEN RETURN NULL;END IF;
 UPDATE inbox_operations.steps SET state='running',generation=generation+1,lease_until=clock_timestamp()+make_interval(secs=>seconds) WHERE org_id=o AND operation_id=op AND id=s RETURNING generation INTO row.generation;
 RETURN row.generation;
END $$;
CREATE FUNCTION inbox_action_api.fail_step(o uuid,op uuid,s uuid,g bigint,terminal_state text,code text) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v bigint;result jsonb;child inbox_operations.steps;
BEGIN
 IF terminal_state NOT IN('failed','conflicted','blocked') OR code IS NULL OR code !~ '^[a-z][a-z0-9_]{0,95}$' THEN RAISE EXCEPTION 'Invalid terminal failure';END IF;
 PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
 result:=jsonb_build_object('status',terminal_state,'code',code,'changed',false);
 UPDATE inbox_operations.steps SET state=terminal_state,lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=s RETURNING receipt_version INTO v;
 INSERT INTO inbox_operations.receipts VALUES(o,op,s,v,g,result,clock_timestamp());
 -- A failed prerequisite permanently blocks its remaining same-effect steps.
 -- They cannot be running: claim_step requires the prerequisite's success.
 FOR child IN SELECT st.* FROM inbox_operations.steps st JOIN inbox_operations.steps failed ON failed.org_id=st.org_id AND failed.operation_id=st.operation_id AND failed.effect_key=st.effect_key WHERE failed.org_id=o AND failed.operation_id=op AND failed.id=s AND st.ordinal>failed.ordinal ORDER BY st.ordinal FOR UPDATE OF st LOOP
  IF child.state<>'pending' THEN RAISE EXCEPTION 'Invalid successor state';END IF;
  UPDATE inbox_operations.steps SET state='blocked',lease_until=NULL,receipt_version=receipt_version+1 WHERE org_id=o AND operation_id=op AND id=child.id RETURNING receipt_version INTO v;
  INSERT INTO inbox_operations.receipts VALUES(o,op,child.id,v,child.generation,jsonb_build_object('status','blocked','code','predecessor_failed','predecessor_id',s,'changed',false),clock_timestamp());
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION inbox_action_api.execute_step(o uuid,op uuid,s uuid,g bigint) RETURNS jsonb LANGUAGE plpgsql SET search_path='' AS $$
DECLARE result jsonb;message text;terminal_state text;code text;
BEGIN
 -- Keep the claim lock outside the rollback scope. A caught business failure
 -- rolls back every canonical write, then commits a durable failure receipt.
 PERFORM inbox_operations.lock_step_for_effect(o,op,s,g);
 BEGIN
  result:=inbox_operation_domain.apply_property_step(o,op,s,g);
  RETURN result;
 EXCEPTION WHEN SQLSTATE 'P0001' THEN
  GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
  CASE message
   WHEN 'Requester membership ambiguous or missing' THEN terminal_state:='blocked';code:='requester_access_unavailable';
   WHEN 'Requester access revoked' THEN terminal_state:='blocked';code:='requester_access_revoked';
   WHEN 'Access expired during effect' THEN terminal_state:='blocked';code:='access_expired';
   WHEN 'Assignee unavailable' THEN terminal_state:='conflicted';code:='assignee_unavailable';
   WHEN 'Property ineligible' THEN terminal_state:='conflicted';code:='property_ineligible';
   WHEN 'Target resolution changed' THEN terminal_state:='conflicted';code:='target_changed';
   WHEN 'Target resolution expired' THEN terminal_state:='conflicted';code:='target_expired';
   WHEN 'Canonical target property changed' THEN terminal_state:='conflicted';code:='target_changed';
   WHEN 'Dependency conflict' THEN terminal_state:='conflicted';code:='record_changed';
   WHEN 'SMS policy conflict' THEN terminal_state:='conflicted';code:='sms_policy_changed';
   WHEN 'SMS scope changed or unseeded' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS scope contact changed' THEN terminal_state:='conflicted';code:='sms_contact_changed';
   WHEN 'SMS scope membership changed' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS contact missing' THEN terminal_state:='conflicted';code:='sms_contact_unavailable';
   WHEN 'SMS property scope exceeds bound or changed' THEN terminal_state:='conflicted';code:='sms_scope_changed';
   WHEN 'SMS enrollment scope exceeds bound' THEN terminal_state:='blocked';code:='sms_scope_too_large';
   WHEN 'permanent_dnc_not_enabled' THEN terminal_state:='blocked';code:='permanent_dnc_not_enabled';
   ELSE RAISE; -- Invariant/software faults are not disguised as business denials.
  END CASE;
 END;
 RETURN inbox_action_api.fail_step(o,op,s,g,terminal_state,code);
 -- 40P01/40001 and other infrastructure failures escape the whole RPC. The
 -- durable runner retries/reconciles the same claim; no ambiguous failure receipt.
END $$;
-- Internal durable runner primitive. Repeated delivery reads the committed
-- receipt; claiming and applying are one transaction, with no browser lifetime.
CREATE FUNCTION inbox_action_api.run_step(o uuid,op uuid,s uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE row inbox_operations.steps;g bigint;result jsonb;
BEGIN
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_WORKER_STEP_UNAVAILABLE';END IF;
 IF row.state NOT IN('pending','running') THEN
  SELECT r.result INTO STRICT result FROM inbox_operations.receipts r WHERE r.org_id=o AND r.operation_id=op AND r.step_id=s;
  RETURN jsonb_build_object('step_id',s,'state',row.state,'receipt',result);
 END IF;
 g:=inbox_operations.claim_step(o,op,s,60);
 IF g IS NULL THEN RAISE EXCEPTION 'INBOX_WORKER_STEP_BUSY' USING ERRCODE='55P03';END IF;
 result:=inbox_action_api.execute_step(o,op,s,g);
 SELECT state INTO STRICT row.state FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s;
 RETURN jsonb_build_object('step_id',s,'state',row.state,'receipt',result);
END $$;
CREATE FUNCTION inbox_action_api.load_operation(o uuid,op uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
 SELECT jsonb_build_object('org_id',p.org_id,'operation_id',p.id,'steps',(SELECT jsonb_agg(s.id ORDER BY s.effect_key,s.ordinal) FROM inbox_operations.steps s WHERE s.org_id=p.org_id AND s.operation_id=p.id)) FROM inbox_operations.operations p WHERE p.org_id=o AND p.id=op
$$;
-- The outbox event ID is the durable-engine idempotency key. A dispatcher only
-- acknowledges after the engine accepts the invocation durably. Lost responses
-- leave the lease to expire and redeliver the same immutable event identity.
CREATE FUNCTION inbox_action_api.claim_dispatch_batch(batch_size integer DEFAULT 20) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE result jsonb;
BEGIN
 IF batch_size IS NULL OR batch_size NOT BETWEEN 1 AND 20 THEN RAISE EXCEPTION 'Invalid dispatch bound';END IF;
 WITH candidates AS(SELECT d.org_id,d.operation_id FROM inbox_operations.dispatch_outbox d WHERE d.acknowledged_at IS NULL AND (d.lease_until IS NULL OR d.lease_until<=clock_timestamp()) ORDER BY d.created_at,d.event_id LIMIT batch_size FOR UPDATE SKIP LOCKED), claimed AS(
  UPDATE inbox_operations.dispatch_outbox d SET generation=d.generation+1,lease_until=clock_timestamp()+interval '30 seconds' FROM candidates c WHERE d.org_id=c.org_id AND d.operation_id=c.operation_id RETURNING d.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('org_id',org_id,'operation_id',operation_id,'event_id',event_id,'generation',generation::text) ORDER BY event_id),'[]') INTO result FROM claimed;
 RETURN result;
END $$;
CREATE FUNCTION inbox_action_api.ack_dispatch(o uuid,op uuid,g bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_operations.ack_dispatch(o,op,g) $$;
CREATE FUNCTION inbox_action_api.worker_readiness() RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE ready boolean;
BEGIN
 IF to_regclass('inbox_control.baseline_progress') IS NULL THEN RETURN false;END IF;
 EXECUTE 'SELECT coalesce(bool_and(stage=''done''),false) FROM inbox_control.baseline_progress' INTO ready;
 RETURN ready;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;


-- Completes the private acceptance assertions using current canonical authority.

CREATE OR REPLACE FUNCTION inbox_operations.assert_request_access(o uuid,u uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN PERFORM inbox_action_api.authorize(o,u);END $$;
CREATE OR REPLACE FUNCTION inbox_operations.assert_current_preparation(p uuid) RETURNS void
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE prep inbox_operations.preparations;binding inbox_action_api.preparation_requests;item jsonb;effect jsonb;target jsonb;expected jsonb;requirements jsonb;revision bigint;assignee uuid;
BEGIN
 SELECT * INTO prep FROM inbox_operations.preparations WHERE id=p;
 SELECT * INTO binding FROM inbox_action_api.preparation_requests WHERE preparation_id=p;
 IF prep.id IS NULL OR binding.preparation_id IS NULL OR (binding.org_id,binding.requester_id,binding.input_hash) IS DISTINCT FROM (prep.org_id,prep.requester_id,prep.input_hash) THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_UNAVAILABLE';END IF;
 PERFORM inbox_action_api.authorize(prep.org_id,prep.requester_id);
 IF prep.expires_at<=clock_timestamp() OR jsonb_array_length(prep.snapshot->'effects')=0 THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_EXPIRED_OR_EMPTY';END IF;
 FOR effect IN SELECT value FROM jsonb_array_elements(prep.snapshot->'effects') ORDER BY value->>'effect_key',(value->>'ordinal')::integer LOOP
  IF effect->'dependencies'->'sms_scope'->>'contact_id' IS NOT NULL THEN
   SELECT s.revision INTO revision FROM inbox_operation_domain.sms_scopes s WHERE s.org_id=prep.org_id AND s.contact_id=(effect->'dependencies'->'sms_scope'->>'contact_id')::uuid FOR UPDATE;
   IF NOT FOUND OR revision::text IS DISTINCT FROM effect->'dependencies'->'sms_scope'->>'revision' THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_CHANGED';END IF;
  END IF;
  FOR target IN SELECT value FROM jsonb_array_elements(effect->'dependencies'->'targets') ORDER BY value->>'conversation_id' LOOP
   SELECT t.revision INTO revision FROM inbox_operation_domain.target_versions t WHERE t.org_id=prep.org_id AND t.conversation_id=(target->>'conversation_id')::uuid FOR UPDATE;
   IF NOT FOUND OR revision::text IS DISTINCT FROM target->>'revision' OR ((target->>'valid_until')::timestamptz<clock_timestamp()) THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_CHANGED';END IF;
  END LOOP;
  expected:=effect->'dependencies'->'policy';
  SELECT jsonb_agg(jsonb_build_object('namespace',d->>'namespace','key',d->'key')) INTO requirements FROM jsonb_array_elements(expected->'dependencies') d;
  PERFORM 1 FROM inbox_policy.versions v JOIN jsonb_array_elements(requirements) r ON v.namespace=r->>'namespace' AND v.entity_key=(r->'key')::text WHERE v.org_id=prep.org_id ORDER BY v.namespace,v.entity_key FOR UPDATE OF v;
  IF inbox_policy.snapshot(prep.org_id,requirements) IS DISTINCT FROM expected THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_CHANGED';END IF;
  IF effect->>'action'='assign' AND effect->'payload'->>'user_id' IS NOT NULL THEN
   assignee:=(effect->'payload'->>'user_id')::uuid;
   IF NOT EXISTS(SELECT 1 FROM public.memberships WHERE org_id=prep.org_id AND user_id=assignee AND access_status='active' AND deletion_prepared_at IS NULL AND (access_expires_at IS NULL OR access_expires_at>clock_timestamp())) THEN RAISE EXCEPTION 'INBOX_ACTION_ASSIGNEE_UNAVAILABLE';END IF;
  END IF;
 END LOOP;
 PERFORM inbox_action_api.authorize(prep.org_id,prep.requester_id);
END $$;
CREATE FUNCTION inbox_action_api.accept(preparation_id uuid,k uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;binding inbox_action_api.preparation_requests;operation_id uuid;accepted_at timestamptz;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 SELECT * INTO binding FROM inbox_action_api.preparation_requests r WHERE r.preparation_id=accept.preparation_id AND r.org_id=(a->>'org_id')::uuid AND r.requester_id=(a->>'user_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 IF binding.idempotency_key IS DISTINCT FROM k THEN RAISE EXCEPTION 'INBOX_ACTION_IDEMPOTENCY_MISMATCH';END IF;
 PERFORM inbox_action_api.lock_request_key(binding.org_id,binding.requester_id,k);
 operation_id:=inbox_operations.accept_prepared(binding.org_id,binding.requester_id,k,preparation_id);
 SELECT created_at INTO STRICT accepted_at FROM inbox_operations.operations WHERE org_id=binding.org_id AND id=operation_id;
 RETURN jsonb_build_object('operation_id',operation_id,'accepted_at',accepted_at);
END $$;
CREATE FUNCTION inbox_action_api.status(operation_id uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;operation inbox_operations.operations;items jsonb;steps jsonb;completed boolean;outcome text;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 SELECT * INTO operation FROM inbox_operations.operations p WHERE p.id=status.operation_id AND p.org_id=(a->>'org_id')::uuid AND p.requester_id=(a->>'user_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACTION_OPERATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 -- One SQL snapshot for item/step states avoids a receipt committing between
 -- separate reads and making a completed operation contain stale pending items.
 WITH actual AS MATERIALIZED (
  SELECT s.*,r.result FROM inbox_operations.steps s LEFT JOIN inbox_operations.receipts r ON r.org_id=s.org_id AND r.operation_id=s.operation_id AND r.step_id=s.id WHERE s.org_id=operation.org_id AND s.operation_id=operation.id
 ), item_states AS (
  SELECT i.*,coalesce(mapped.step_ids,'[]') step_ids,
   CASE WHEN i.exclusion_code IS NOT NULL THEN 'excluded'
    WHEN mapped.has_running THEN 'running' WHEN mapped.has_pending THEN 'pending'
    ELSE coalesce(mapped.failure_state,'succeeded') END item_state,
   coalesce(i.exclusion_code,mapped.code) item_code
  FROM inbox_operations.items i LEFT JOIN LATERAL (
   SELECT jsonb_agg(s.id ORDER BY s.ordinal,s.id) step_ids,
    bool_or(s.state='running') has_running,bool_or(s.state='pending') has_pending,
    (array_agg(s.state ORDER BY CASE s.state WHEN 'failed' THEN 0 WHEN 'conflicted' THEN 1 WHEN 'cancelled' THEN 2 ELSE 3 END,s.ordinal) FILTER(WHERE s.state IN('failed','conflicted','cancelled','blocked')))[1] failure_state,
    (array_agg(s.result->>'code' ORDER BY CASE s.state WHEN 'failed' THEN 0 WHEN 'conflicted' THEN 1 WHEN 'cancelled' THEN 2 ELSE 3 END,s.ordinal) FILTER(WHERE s.state IN('failed','conflicted','cancelled','blocked')))[1] code
   FROM inbox_operations.item_steps m JOIN actual s ON s.id=m.step_id WHERE m.org_id=i.org_id AND m.operation_id=i.operation_id AND m.item_id=i.id
  ) mapped ON true WHERE i.org_id=operation.org_id AND i.operation_id=operation.id
 ) SELECT
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',i.id,'kind',i.target_kind,'target_id',i.target_id,'property_id',i.resolution->>'property_id','exclusion_code',i.exclusion_code,'step_ids',i.step_ids,'state',i.item_state,'code',i.item_code) ORDER BY i.id),'[]') FROM item_states i),
  (SELECT coalesce(jsonb_agg(jsonb_build_object('id',s.id,'action',s.action,'state',s.state,'code',s.result->>'code','receipt_version',s.receipt_version::text,'changed',s.result->'changed') ORDER BY s.effect_key,s.ordinal),'[]') FROM actual s),
  NOT EXISTS(SELECT 1 FROM actual WHERE state IN('pending','running')),
  CASE WHEN EXISTS(SELECT 1 FROM actual WHERE state IN('pending','running')) THEN NULL
   WHEN NOT EXISTS(SELECT 1 FROM actual WHERE state<>'succeeded') THEN 'succeeded'
   WHEN EXISTS(SELECT 1 FROM actual WHERE state='succeeded') THEN 'partial'
   WHEN NOT EXISTS(SELECT 1 FROM actual WHERE state<>'cancelled') THEN 'cancelled'
   ELSE 'failed' END INTO items,steps,completed,outcome;
 PERFORM inbox_action_api.authorize(operation.org_id,operation.requester_id);
 RETURN jsonb_build_object('operation_id',operation.id,'accepted_at',operation.created_at,'completed',completed,'result',outcome,'items',items,'steps',steps);
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;


-- Authenticated wrappers carry identity through verified JWT/session authority;
-- callers never supply requester, eligibility or captured version claims.

CREATE FUNCTION public.inbox_prepare_action(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_action_api.prepare(canonical_input,idempotency_key)
$$;
CREATE FUNCTION public.inbox_accept_action(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_action_api.accept(preparation_id,idempotency_key)
$$;
CREATE FUNCTION public.inbox_operation_status(operation_id uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
 SELECT inbox_action_api.status(operation_id)
$$;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_operation_status(uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_accept_action(uuid,uuid),public.inbox_operation_status(uuid) TO authenticated;


-- Additive review/recovery endpoints; no caller-supplied policy or identity.

CREATE FUNCTION inbox_action_api.prepare_review(canonical_input text,k uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE result jsonb;snapshot jsonb;summary jsonb;
BEGIN
 result:=inbox_action_api.prepare(canonical_input,k);
 SELECT p.snapshot INTO STRICT snapshot FROM inbox_operations.preparations p WHERE p.id=(result->>'preparation_id')::uuid;
 IF EXISTS(SELECT 1 FROM jsonb_array_elements(result->'definition'->'steps') s WHERE s->>'type'='outcome' AND s->>'value'='opted_out') THEN
  WITH scopes AS MATERIALIZED(SELECT e->'dependencies'->'sms_scope' AS scope FROM jsonb_array_elements(snapshot->'effects') e WHERE e->'dependencies'->'sms_scope'->>'contact_id' IS NOT NULL)
  SELECT jsonb_build_object('contacts',(SELECT count(DISTINCT scope->>'contact_id') FROM scopes),
   'linked_properties',(SELECT count(DISTINCT p.value) FROM scopes s CROSS JOIN LATERAL jsonb_array_elements_text(s.scope->'property_ids') p),
   'active_enrollments',(SELECT count(DISTINCT e.value) FROM scopes s CROSS JOIN LATERAL jsonb_array_elements_text(s.scope->'enrollment_ids') e)) INTO summary;
 END IF;
 RETURN result||jsonb_build_object('sms_safety_summary',summary);
END $$;
CREATE OR REPLACE FUNCTION public.inbox_prepare_action(canonical_input text,idempotency_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_action_api.prepare_review(canonical_input,idempotency_key) $$;
CREATE FUNCTION inbox_action_api.assignees() RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;members jsonb;
BEGIN
 a:=inbox_action_api.authorize(NULL);
 SELECT coalesce(jsonb_agg(jsonb_build_object('user_id',m.user_id,'label',m.email) ORDER BY m.email,m.user_id),'[]') INTO members FROM (
  SELECT m.user_id,u.email FROM public.memberships m JOIN auth.users u ON u.id=m.user_id
  WHERE m.org_id=(a->>'org_id')::uuid AND m.access_status='active' AND m.deletion_prepared_at IS NULL AND (m.access_expires_at IS NULL OR m.access_expires_at>clock_timestamp())
   AND u.email IS NOT NULL AND length(btrim(u.email)) BETWEEN 1 AND 320
   AND EXISTS(SELECT 1 FROM inbox_bridge.access_epochs e WHERE e.user_id=m.user_id)
  ORDER BY m.user_id LIMIT 401
 ) m;
 IF jsonb_array_length(members)>400 THEN RAISE EXCEPTION 'INBOX_ACTION_ROSTER_TOO_LARGE';END IF;
 PERFORM inbox_action_api.authorize((a->>'org_id')::uuid,(a->>'user_id')::uuid);
 RETURN jsonb_build_object('members',members);
END $$;
CREATE FUNCTION public.inbox_action_assignees() RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_action_api.assignees() $$;
CREATE FUNCTION inbox_action_api.recover(p uuid,k uuid) RETURNS jsonb
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE a jsonb;result jsonb;binding inbox_action_api.preparation_requests;operation inbox_operations.operations;expires timestamptz;
BEGIN
 IF p IS NULL OR k IS NULL THEN RAISE EXCEPTION 'Invalid recovery reference';END IF;
 a:=inbox_action_api.authorize(NULL);
 SELECT * INTO binding FROM inbox_action_api.preparation_requests r WHERE r.preparation_id=p AND r.org_id=(a->>'org_id')::uuid AND r.requester_id=(a->>'user_id')::uuid;
 IF NOT FOUND THEN RAISE EXCEPTION 'INBOX_ACTION_PREPARATION_UNAVAILABLE' USING ERRCODE='42501';END IF;
 IF binding.idempotency_key IS DISTINCT FROM k THEN RAISE EXCEPTION 'INBOX_ACTION_IDEMPOTENCY_MISMATCH';END IF;
 PERFORM inbox_action_api.lock_request_key(binding.org_id,binding.requester_id,k);
 SELECT * INTO operation FROM inbox_operations.operations o WHERE o.org_id=binding.org_id AND o.requester_id=binding.requester_id AND o.idempotency_key=k;
 IF FOUND THEN
  IF operation.input_hash IS DISTINCT FROM binding.input_hash THEN RAISE EXCEPTION 'INBOX_ACTION_IDEMPOTENCY_MISMATCH';END IF;
  result:=jsonb_build_object('state','accepted','operation',jsonb_build_object('operation_id',operation.id,'accepted_at',operation.created_at));
 ELSE
  SELECT expires_at INTO STRICT expires FROM inbox_operations.preparations WHERE id=p;
  result:=jsonb_build_object('state',CASE WHEN expires<=clock_timestamp() THEN 'expired_not_accepted' ELSE 'pending' END,'operation',NULL);
 END IF;
 PERFORM inbox_action_api.authorize(binding.org_id,binding.requester_id);
 RETURN result;
END $$;
CREATE FUNCTION public.inbox_recover_operation(preparation_id uuid,idempotency_key uuid) RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$ SELECT inbox_action_api.recover(preparation_id,idempotency_key) $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_action_api FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_action_assignees(),public.inbox_recover_operation(uuid,uuid) FROM PUBLIC,anon,service_role;
GRANT EXECUTE ON FUNCTION public.inbox_prepare_action(text,uuid),public.inbox_action_assignees(),public.inbox_recover_operation(uuid,uuid) TO authenticated;


-- Dedicated role candidate. Credential/login provisioning is a separate approved
-- hosting operation; this file deliberately creates no password or LOGIN role.

DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_action_worker') THEN
  CREATE ROLE inbox_action_worker NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='inbox_action_worker' AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls))
  OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member='inbox_action_worker'::regrole) THEN
  RAISE EXCEPTION 'Unexpected privileged action worker role';
 END IF;
END $$;
REVOKE ALL ON SCHEMA inbox_operations,inbox_policy,inbox_operation_domain FROM inbox_action_worker;
REVOKE ALL ON ALL TABLES IN SCHEMA inbox_operations,inbox_policy,inbox_operation_domain,inbox_action_api FROM inbox_action_worker;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA inbox_operations,inbox_policy,inbox_operation_domain,inbox_action_api FROM inbox_action_worker;
GRANT USAGE ON SCHEMA inbox_action_api TO inbox_action_worker;
GRANT EXECUTE ON FUNCTION inbox_action_api.load_operation(uuid,uuid),inbox_action_api.run_step(uuid,uuid,uuid),inbox_action_api.claim_dispatch_batch(integer),inbox_action_api.ack_dispatch(uuid,uuid,bigint),inbox_action_api.worker_readiness() TO inbox_action_worker;
-- Explicit REVOKE cannot subtract an inherited PUBLIC privilege. Refuse the
-- installation if canonical schema ACLs grant this principal broader authority.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND c.relkind IN ('r','p','v','m','f')
   AND has_schema_privilege('inbox_action_worker',n.oid,'USAGE')
   AND has_table_privilege('inbox_action_worker',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) THEN
  RAISE EXCEPTION 'Action worker unexpectedly has direct data privileges';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema'
   AND p.prosecdef AND p.prorettype<>'trigger'::regtype
   AND has_schema_privilege('inbox_action_worker',n.oid,'USAGE')
   AND has_function_privilege('inbox_action_worker',p.oid,'EXECUTE')
   AND p.oid<>ALL(ARRAY['inbox_action_api.load_operation(uuid,uuid)'::regprocedure,
    'inbox_action_api.run_step(uuid,uuid,uuid)'::regprocedure,
    'inbox_action_api.claim_dispatch_batch(integer)'::regprocedure,
    'inbox_action_api.ack_dispatch(uuid,uuid,bigint)'::regprocedure,
    'inbox_action_api.worker_readiness()'::regprocedure]::oid[])) THEN
  RAISE EXCEPTION 'Action worker unexpectedly reaches another privileged function';
 END IF;
END $$;


CREATE TABLE inbox_action_api.install_sources(path text PRIMARY KEY,source_sha256 text NOT NULL,transformed_sha256 text NOT NULL);ALTER TABLE inbox_action_api.install_sources ENABLE ROW LEVEL SECURITY;REVOKE ALL ON inbox_action_api.install_sources FROM PUBLIC,anon,authenticated,service_role,inbox_action_worker;INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-acceptance/setup.sql','04d34d74ef76dd11585ee45728e2a0a1f6e635cb2fd0376a4ef9b014ea12dae3','53e8c8256092c68a743ecb21a10c5ae1d22b0b1ceab4cf46ca60bea9d1effd99');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-domain/setup.sql','b7ca70de5cfe321ad3996b98de2f6097ba9b0545e7e2eb7bb0c955e9cc2a35ff','b990e5f19bff89988f6e58a3bc12ef1a2c751c96942b8c9fc80a692ac636b587');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-domain/restrictive-scope.sql','8b21a491160fedfb84ef85d1156fcede5ffdb8f56855786d430faed1784776d9','8d3bedfdd5775ffdec0cd94a7d8e26870396922988050ff03168254afb2f0576');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-domain/restrictive-effect.sql','3e643d1cd5b370f7cea3588a4caf9146a29e25da6eec808b0c4621ca424124df','f2c5013d756882fbf2298b3af47644d23ffbb14808c34017e1097c4ab1885022');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-domain/restrictive-apply.sql','c92977a209ead8e9c25e468887ecdc5d4e00a5688ae65128f7980996ed2ccdfa','1d13f368d3ea58717aab5173b654fe14202b580a34c5ebef44bd894b8244ce1e');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-preparation/setup.sql','cf3e5c61c81643b8386b3d5e361966f31200c08a3698c513ca08c36f4b75b377','c363f43f67f3c23587f070f1629a65a394f80419e9a5555c462b921505b172ec');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-preparation/worker.sql','5ddff6ea035d79a59d2396b825eb87bd9d4a75669588a5edd32fe7d4254a6a12','749bae98dce5639490800d72d78679c45d02af27cec281300a01ecc2fdac8f1d');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-preparation/accept.sql','fdd19c945b24f40057ed1fe63e90833ef27217462e977bb8d14945163cae24a9','c9c8e37cdffffbf2ce089fd0994615115b85de82ec894ccc9664214b93769e94');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-preparation/public-api.sql','45bafaf0f48c30c9cb98e1bd808b9d2112b7c191c692ee6de4302f1f624bc768','76c07a94df3c133b2a2ea6029495d55ea59ce73ff06ab6ca1291308967d6ba27');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-preparation/review.sql','faae82983465db8dd5624cd8fcc8bf5f44916fb2994afa30460f1e6832695eab','d2e01801eed3294adca1ad1969ed36f33420a4b7ae8012d45a2484e540608555');INSERT INTO inbox_action_api.install_sources VALUES('inbox-operation-preparation/worker-role.sql','a686aec664667bf60e2a7507e5fad03508de5bc9d3d49265a3480797d3039948','ce652a4d4d61241f2a3c7353e1f878ecfafffd0a6713e19b3ca5410f46a024eb');
COMMIT;
