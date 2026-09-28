-- Private durable acceptance core. No application grants, canonical writes or provider calls.
BEGIN;
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
DECLARE row inbox_operations.steps; prior jsonb; predecessor_results jsonb:='[]'::jsonb; cursor uuid;
BEGIN
 SELECT * INTO row FROM inbox_operations.steps WHERE org_id=o AND operation_id=op AND id=s FOR UPDATE;
 IF NOT FOUND OR row.state<>'running' OR g IS NULL OR row.generation<>g OR row.lease_until<=clock_timestamp() THEN RAISE EXCEPTION 'Stale step claim';END IF;
 cursor:=row.predecessor_id;
 WHILE cursor IS NOT NULL LOOP
  SELECT r.result,st.predecessor_id INTO prior,cursor
  FROM inbox_operations.steps st JOIN inbox_operations.receipts r ON r.org_id=st.org_id AND r.operation_id=st.operation_id AND r.step_id=st.id
  WHERE st.org_id=o AND st.operation_id=op AND st.id=cursor;
  IF NOT FOUND THEN RAISE EXCEPTION 'Predecessor incomplete';END IF;
  -- Prepend each older receipt so adapters receive the complete immutable
  -- dependency history in execution order, while predecessor_result remains
  -- the immediate receipt for target/SMS rebasing.
  predecessor_results:=jsonb_build_array(prior)||predecessor_results;
 END LOOP;
 RETURN jsonb_build_object('action',row.action,'payload',row.payload,'original_dependencies',row.dependencies,'predecessor_result',CASE WHEN jsonb_array_length(predecessor_results)>0 THEN predecessor_results->-1 ELSE NULL END,'predecessor_results',predecessor_results);
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
COMMIT;
